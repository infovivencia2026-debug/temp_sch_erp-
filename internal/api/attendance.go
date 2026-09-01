package api

import (
	"net/http"
	"strings"
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
	/* Which channels to tell the family on, beyond the app.

	   The in-app alert always goes and is not a choice: it costs nothing, it
	   is the record the parent can go back to, and a school that has bought no
	   gateway at all must still be able to tell a family their child is not in
	   the building. SMS, WhatsApp and email cost money per message, so they
	   are the teacher's to tick — some schools send them for every absence,
	   some only when they have rung and got no answer. */
	NotifyChannels []string `json:"notify_channels,omitempty"`
	// The one case a school does want it silent: back-filling a register from
	// a fortnight ago, where texting every parent about an absence they
	// already know about is worse than useless.
	Silent bool `json:"silent,omitempty"`
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

	channels := cleanChannels(req.NotifyChannels)
	written := 0
	told, queued := 0, 0
	var nowAbsent []uuid.UUID
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
		/* WHICH CHILDREN ACTUALLY CHANGED, not which were submitted.

		   The upsert ends `WHERE status IS DISTINCT FROM EXCLUDED.status`, so
		   re-saving a register writes nothing — which is right, and it is also
		   the only thing standing between a teacher who presses Save twice and
		   a family that gets told twice. Notifying from req.Entries would text
		   every absent parent again on every save; notifying from the rows the
		   batch reports as written tells them once. */
		for i := range req.Entries {
			tag, err := res.Exec()
			if err != nil {
				return err
			}
			n := int(tag.RowsAffected())
			written += n
			if n > 0 && req.Entries[i].Status == "absent" {
				if sid, err := uuid.Parse(req.Entries[i].StudentID); err == nil {
					nowAbsent = append(nowAbsent, sid)
				}
			}
		}
		if err := res.Close(); err != nil {
			return err
		}
		/* Inside the same transaction as the register.

		   A notification about an absence the school then failed to record is
		   the worse of the two failures: the parent rings, and nobody at the
		   school can see what they are ringing about. */
		if !req.Silent && len(nowAbsent) > 0 {
			var qerr error
			told, queued, qerr = s.announceAbsences(
				r, tx, instID, nowAbsent, req.OnDate, channels)
			if qerr != nil {
				return qerr
			}
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
		// So the screen can say what actually happened rather than "Saved":
		// "31 marked, 3 absent, 5 parents told, 6 messages sent".
		"newly_absent":    len(nowAbsent),
		"parents_told":    told,
		"messages_queued": queued,
		"channels":        channels,
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

/*
Telling a family their child is not in the building.

	THE WHOLE HOUSEHOLD, not the primary guardian. The manual absence run this
	replaces joined `sg.is_primary` and sent one SMS — so a mother who was not
	ticked as the primary contact was never told her child had not arrived, and
	the primary contact is a billing and consent flag that somebody in the
	office set years ago for reasons that had nothing to do with this.

	The child is told too, where they have an account. A teenager who is marked
	absent by mistake because the register was taken before they walked in is
	the person best placed to say so, and fastest.

	THE APP ALERT IS NOT OPTIONAL. It is free, it is the record the parent can
	go back to a week later, and it is the only channel that works for a school
	that has bought no gateway. The paid channels are the teacher's tick boxes.
*/
func (s *Server) announceAbsences(
	r *http.Request, tx pgx.Tx, inst uuid.UUID,
	students []uuid.UUID, onDate string, channels []string,
) (told, queued int, err error) {

	rows, err := tx.Query(r.Context(), `
		SELECT st.id,
		       concat_ws(' ', st.first_name, st.last_name),
		       to_char($2::date, 'DD Mon'),
		       p.user_id, p.phone, p.email::text
		  FROM students st
		  JOIN LATERAL (
		      SELECT g.user_id, g.phone, g.email::text AS email
		        FROM student_guardians sg
		        JOIN guardians g ON g.id = sg.guardian_id
		       WHERE sg.student_id = st.id
		      UNION ALL
		      -- The child's own account, where they have one.
		      SELECT u.id, u.phone, u.email::text FROM users u WHERE u.id = st.user_id
		  ) p ON true
		 WHERE st.id = ANY($1)`, students, onDate)
	if err != nil {
		return 0, 0, err
	}
	type msg struct {
		student      uuid.UUID
		name, date   string
		user         *uuid.UUID
		phone, email *string
	}
	var all []msg
	for rows.Next() {
		var m msg
		if err := rows.Scan(&m.student, &m.name, &m.date, &m.user, &m.phone, &m.email); err != nil {
			rows.Close()
			return 0, 0, err
		}
		all = append(all, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}

	for _, m := range all {
		title := m.name + " was marked absent"
		body := m.name + " was marked absent on " + m.date +
			". If this is wrong, please tell the class teacher."

		if m.user != nil {
			sid := m.student
			if err := notify(r, tx, inst, *m.user, &sid, "attendance",
				title, body, "/portal/attendance", "student", &sid); err != nil {
				return told, queued, err
			}
			told++
		}
		for _, ch := range channels {
			to := ""
			if ch == "email" && m.email != nil {
				to = strings.TrimSpace(*m.email)
			} else if ch != "email" && m.phone != nil {
				to = strings.TrimSpace(*m.phone)
			}
			if to == "" {
				// No number, no address. Skipped rather than failed: the app
				// alert has already gone, and a register must not refuse to
				// save because one family has no mobile.
				continue
			}
			if _, err := s.QueueMessage(r.Context(), tx, inst, SendRequest{
				Channel:      ch,
				TemplateCode: "messaging.direct",
				Vars:         map[string]any{"text": body, "subject": title},
				Recipient:    to,
			}); err != nil {
				/* A gateway the school has not configured is theirs to fix and
				   is NOT a reason to fail the register. The teacher's actual
				   job here is recording who was in the room; losing that
				   because WhatsApp is misconfigured would be the product
				   choosing the wrong one of the two to protect. */
				continue
			}
			queued++
		}
	}
	return told, queued, nil
}
