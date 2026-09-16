package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

// errAbsenceOutOfScope is raised inside the write transaction when the target
// student is not in a section the caller may see, so the handler can turn it
// into a 403 rather than a 500.
var errAbsenceOutOfScope = errors.New("student out of caller scope")

/*
Absentee follow-up: the morning list the office rings round.

	Marking a register already tells each absent child's household (see
	announceAbsences). This is the other half of the job: somebody in the office
	works down the day's absentees by phone to find out why, and needs to record
	that they got through and what the parent said — without touching the
	register itself. The log lives in student_absence_followup, one row per child
	per day, LEFT JOINed here so an un-worked list reads back as 'not_called'/''.

	Scope mirrors attendance read exactly: a caller with
	academics.attendance.read.all sees every section, otherwise only the sections
	they teach or are class teacher of (plus their own children). The predicate
	is Resolved.AttendancePredicate, the same one listAttendance uses, so the two
	screens can never disagree about who a teacher may see.
*/

type absenteeStudent struct {
	StudentID      string  `json:"student_id"`
	Name           string  `json:"name"`
	AdmissionNo    string  `json:"admission_no"`
	FatherName     *string `json:"father_name"`
	FatherPhone    *string `json:"father_phone"`
	MotherName     *string `json:"mother_name"`
	MotherPhone    *string `json:"mother_phone"`
	CallStatus     string  `json:"call_status"`
	ParentResponse string  `json:"parent_response"`
}

type absenteeSection struct {
	SectionID   string            `json:"section_id"`
	SectionName string            `json:"section_name"`
	ClassName   string            `json:"class_name"`
	Students    []absenteeStudent `json:"students"`
}

// listAbsentees returns the day's absentees grouped by section, with each
// child's guardians and the follow-up call log so far.
func (s *Server) listAbsentees(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	on := q.Get("on_date")
	if on == "" {
		on = time.Now().Format(time.DateOnly)
	}
	if _, err := time.Parse(time.DateOnly, on); err != nil {
		httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
		return
	}

	// Restrict to the sections this caller may read — without it RLS would admit
	// every section in the school, because they all share one institution.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	args := []any{on, nullString(q.Get("section_id"))}
	scopePred, scopeArgs := res.AttendancePredicate("sa", len(args)+1)
	args = append(args, scopeArgs...)

	type row struct {
		sectionID, sectionName, className string
		student                           absenteeStudent
	}
	items, err := collect(s, r, `
		SELECT sa.section_id::text, sec.name, c.name,
		       sa.student_id::text,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.admission_no,
		       (SELECT g.full_name FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1),
		       (SELECT g.phone FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1),
		       (SELECT g.full_name FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1),
		       (SELECT g.phone FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1),
		       COALESCE(f.call_status, 'not_called'),
		       COALESCE(f.parent_response, '')
		  FROM student_attendance sa
		  JOIN students st  ON st.id = sa.student_id
		  JOIN sections sec ON sec.id = sa.section_id
		  JOIN classes  c   ON c.id = sec.class_id
		  LEFT JOIN student_absence_followup f
		         ON f.student_id = sa.student_id AND f.on_date = sa.on_date
		 WHERE sa.on_date = $1::date
		   AND ($2::uuid IS NULL OR sa.section_id = $2)
		   AND sa.status IS NOT NULL
		   AND sa.status <> 'present'
		   AND sa.status <> 'holiday'
		   AND `+scopePred+`
		 ORDER BY sec.name, st.admission_no`, args,
		func(rows pgx.Rows) (row, error) {
			var v row
			return v, rows.Scan(&v.sectionID, &v.sectionName, &v.className,
				&v.student.StudentID, &v.student.Name, &v.student.AdmissionNo,
				&v.student.FatherName, &v.student.FatherPhone,
				&v.student.MotherName, &v.student.MotherPhone,
				&v.student.CallStatus, &v.student.ParentResponse)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Group by section, preserving the section order the query returned.
	sections := []absenteeSection{}
	idx := map[string]int{}
	for _, it := range items {
		i, ok := idx[it.sectionID]
		if !ok {
			i = len(sections)
			idx[it.sectionID] = i
			sections = append(sections, absenteeSection{
				SectionID:   it.sectionID,
				SectionName: it.sectionName,
				ClassName:   it.className,
				Students:    []absenteeStudent{},
			})
		}
		sections[i].Students = append(sections[i].Students, it.student)
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"date":     on,
		"sections": sections,
	})
}

type absenceFollowupRequest struct {
	StudentID      string `json:"student_id"`
	OnDate         string `json:"on_date"`
	CallStatus     string `json:"call_status"`
	ParentResponse string `json:"parent_response"`
}

// recordAbsenceFollowup logs the outcome of a follow-up call for one child on
// one day. Viewing the absentee list implies the right to log the call, so this
// gates on the same permission (AttendanceRead) and the same section scope.
func (s *Server) recordAbsenceFollowup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req absenceFollowupRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	studentID, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.OnDate == "" {
		req.OnDate = time.Now().Format(time.DateOnly)
	}
	if _, err := time.Parse(time.DateOnly, req.OnDate); err != nil {
		httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
		return
	}
	valid := map[string]bool{"not_called": true, "called": true,
		"no_answer": true, "reached": true}
	if !valid[req.CallStatus] {
		httpx.BadRequest(w, r, "invalid call_status: "+req.CallStatus)
		return
	}

	// Same boundary as the list: only a student in a section the caller may see.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Confirm the student is inside the caller's read boundary before writing,
		// mirroring listAbsentees exactly: academics.attendance.read.all reaches
		// every student, otherwise only a child enrolled in a section the caller
		// teaches / is class teacher of, or the caller's own record / children.
		if !res.AllAttendance {
			var visible bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS (
				    SELECT 1 FROM enrollments e
				     WHERE e.student_id = $1 AND e.section_id = ANY($2))
				    OR $1 = ANY($3)`,
				studentID, res.SectionIDs, res.StudentIDs).Scan(&visible); err != nil {
				return err
			}
			if !visible {
				return errAbsenceOutOfScope
			}
		}

		// Derive the tenant from the student: a platform operator has no
		// institution_id of their own, and the column is NOT NULL.
		var instID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id FROM students WHERE id = $1`, studentID).Scan(&instID); err != nil {
			return err
		}

		_, err := tx.Exec(r.Context(), `
			INSERT INTO student_absence_followup
			    (institution_id, student_id, on_date, call_status, parent_response,
			     updated_by, updated_at)
			VALUES ($1, $2, $3::date, $4, $5, $6, now())
			ON CONFLICT (student_id, on_date) DO UPDATE
			   SET call_status     = EXCLUDED.call_status,
			       parent_response = EXCLUDED.parent_response,
			       updated_by      = EXCLUDED.updated_by,
			       updated_at      = now()`,
			instID, studentID, req.OnDate, req.CallStatus, req.ParentResponse, id.UserID)
		return err
	})
	if err == errAbsenceOutOfScope {
		httpx.Forbidden(w, r, "academics.attendance.read for this student")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
