package api

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

type attendanceRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	SectionID   string  `json:"section_id"`
	OnDate      string  `json:"on_date"`
	Status      string  `json:"status"`
	MinutesLate *int32  `json:"minutes_late,omitempty"`
	Remarks     *string `json:"remarks,omitempty"`
}

func (s *Server) listAttendance(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	on := q.Get("on_date")
	if on == "" {
		on = time.Now().Format(time.DateOnly)
	}

	// Without this a teacher reads the register for every section in the
	// school: RLS admits the rows because they all belong to one institution.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	args := []any{on, nullString(q.Get("section_id")), nullString(q.Get("student_id"))}
	scopePred, scopeArgs := res.AttendancePredicate("sa", len(args)+1)
	args = append(args, scopeArgs...)

	items, err := collect(s, r, `
		SELECT sa.id::text, sa.student_id::text,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.admission_no, sa.section_id::text,
		       to_char(sa.on_date,'YYYY-MM-DD'), sa.status, sa.minutes_late, sa.remarks
		  FROM student_attendance sa
		  JOIN students st ON st.id = sa.student_id
		 WHERE sa.on_date = $1::date
		   AND ($2::uuid IS NULL OR sa.section_id = $2)
		   AND ($3::uuid IS NULL OR sa.student_id = $3)
		   AND `+scopePred+`
		 ORDER BY st.admission_no`, args,
		func(rows pgx.Rows) (attendanceRow, error) {
			var v attendanceRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.SectionID, &v.OnDate, &v.Status, &v.MinutesLate, &v.Remarks)
		})
	respond(w, r, items, err)
}

type markAttendanceRequest struct {
	SectionID string `json:"section_id"`
	OnDate    string `json:"on_date"`
	PeriodID  string `json:"period_id,omitempty"`
	Entries   []struct {
		StudentID   string  `json:"student_id"`
		Status      string  `json:"status"`
		MinutesLate *int32  `json:"minutes_late,omitempty"`
		Remarks     *string `json:"remarks,omitempty"`
	} `json:"entries"`
}

// markAttendance upserts a whole section in one transaction.
//
// A class teacher marks 40 students as one action, so this must be atomic: a
// partial write would leave the register half-marked with no indication of
// where it stopped. The unique index on (student_id, on_date, period_id) makes
// the re-mark case an update rather than a duplicate row.
func (s *Server) markAttendance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req markAttendanceRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	sectionID, err := uuid.Parse(req.SectionID)
	if err != nil {
		httpx.BadRequest(w, r, "section_id must be a uuid")
		return
	}
	if req.OnDate == "" {
		req.OnDate = time.Now().Format(time.DateOnly)
	}
	if _, err := time.Parse(time.DateOnly, req.OnDate); err != nil {
		httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
		return
	}
	if len(req.Entries) == 0 {
		httpx.BadRequest(w, r, "entries must not be empty")
		return
	}
	// Exactly the set student_attendance_status_check allows. Anything else
	// would fail at COMMIT with a constraint violation the user cannot act on.
	valid := map[string]bool{"present": true, "absent": true, "late": true,
		"half_day": true, "leave": true, "holiday": true}
	for _, e := range req.Entries {
		if !valid[e.Status] {
			httpx.BadRequest(w, r, "invalid status: "+e.Status)
			return
		}
	}

	// Marking is limited to sections the caller teaches or is class teacher of,
	// unless they hold academics.attendance.write.any. Checking only the
	// permission let any teacher post a register for any class in the school.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !res.CanMarkSection(sectionID) {
		httpx.Forbidden(w, r, "academics.attendance.write for this section")
		return
	}

	var periodID *uuid.UUID
	if req.PeriodID != "" {
		p, err := uuid.Parse(req.PeriodID)
		if err != nil {
			httpx.BadRequest(w, r, "period_id must be a uuid")
			return
		}
		periodID = &p
	}

	// Uniqueness is enforced by two *partial* indexes, not one plain index:
	//
	//   student_attendance_daily  (student_id, on_date)             WHERE period_id IS NULL
	//   student_attendance_period (student_id, on_date, period_id)  WHERE period_id IS NOT NULL
	//
	// A conflict target must reproduce the index predicate to match, so
	// day-level and period-level marking need different ON CONFLICT clauses.
	// Omitting the WHERE gives "no unique or exclusion constraint matching the
	// ON CONFLICT specification" at runtime.
	const upsertTail = ` DO UPDATE
		   SET status         = EXCLUDED.status,
		       minutes_late   = EXCLUDED.minutes_late,
		       remarks        = EXCLUDED.remarks,
		       corrected_from = student_attendance.status,
		       corrected_by   = EXCLUDED.marked_by,
		       corrected_at   = now()
		 WHERE student_attendance.status IS DISTINCT FROM EXCLUDED.status`

	conflict := `ON CONFLICT (student_id, on_date) WHERE period_id IS NULL`
	if periodID != nil {
		conflict = `ON CONFLICT (student_id, on_date, period_id) WHERE period_id IS NOT NULL`
	}
	sql := `
		INSERT INTO student_attendance
		    (institution_id, student_id, section_id, on_date, period_id,
		     status, minutes_late, remarks, marked_by, marked_at)
		VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9, now())
		` + conflict + upsertTail

	written := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Derive the tenant from the section rather than the caller: a platform
		// operator has no institution_id of their own, and the column is NOT NULL.
		var instID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id FROM sections WHERE id = $1`, sectionID).Scan(&instID); err != nil {
			return err
		}

		batch := &pgx.Batch{}
		for _, e := range req.Entries {
			studentID, err := uuid.Parse(e.StudentID)
			if err != nil {
				return err
			}
			batch.Queue(sql,
				instID, studentID, sectionID, req.OnDate, periodID,
				e.Status, e.MinutesLate, e.Remarks, id.UserID)
		}
		res := tx.SendBatch(r.Context(), batch)
		defer res.Close()
		for range req.Entries {
			tag, err := res.Exec()
			if err != nil {
				return err
			}
			written += int(tag.RowsAffected())
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"section_id": req.SectionID,
		"on_date":    req.OnDate,
		"submitted":  len(req.Entries),
		"written":    written,
	})
}

// getMyStudent is the student/parent portal entry point: resolve the signed-in
// user to their own record without needing students.read.
func (s *Server) getMyStudent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	out := map[string]any{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			sid, admission, name string
			className, section   *string
		)
		err := tx.QueryRow(r.Context(), `
			SELECT st.id::text, st.admission_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       c.name, sec.name
			  FROM students st
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id FROM enrollments e
			       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
			  ) en ON true
			  LEFT JOIN classes c    ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE st.user_id = $1`, id.UserID).
			Scan(&sid, &admission, &name, &className, &section)
		if err != nil {
			return err
		}
		out["id"] = sid
		out["admission_no"] = admission
		out["full_name"] = name
		out["class_name"] = className
		out["section_name"] = section

		var present, total int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FILTER (WHERE status IN ('present','late')), count(*)
			  FROM student_attendance
			 WHERE student_id = $1 AND on_date >= date_trunc('month', CURRENT_DATE)`,
			sid).Scan(&present, &total); err != nil {
			return err
		}
		out["attendance_this_month"] = map[string]int{"present": present, "total": total}
		return nil
	})
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
