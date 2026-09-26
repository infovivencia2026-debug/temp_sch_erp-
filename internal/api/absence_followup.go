package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/scope"
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

// absenteeContact is one guardian the office can ring. Relation is the raw
// stored value ('father', 'mother', 'guardian', …); the screen title-cases it.
type absenteeContact struct {
	Name     string `json:"name"`
	Phone    string `json:"phone"`
	Relation string `json:"relation"`
}

type absenteeStudent struct {
	StudentID   string `json:"student_id"`
	Name        string `json:"name"`
	AdmissionNo string `json:"admission_no"`
	// Mark is what the register says: absent, late or half_day. The office
	// rings an absentee; a child who came in late is a different call, and
	// the row has to say which before anybody dials.
	Mark string `json:"mark"`
	// Contacts is every guardian who has a number on file, father first, then
	// mother, then whoever is marked primary. Only guardians with a number
	// appear, so the office never sees a dead "no number" row — and a number
	// stored under any relation, not just father/mother, is still shown.
	Contacts       []absenteeContact `json:"contacts"`
	CallStatus     string            `json:"call_status"`
	ParentResponse string            `json:"parent_response"`
	// CalledBy is the staff member who last recorded this child's follow-up
	// (student_absence_followup.updated_by), '' when nobody has acted yet.
	// CalledAt is when they recorded it, null until then. These feed the
	// read-only monitoring screen; the action screen ignores them.
	CalledBy string     `json:"called_by"`
	CalledAt *time.Time `json:"called_at"`
}

// presentStudent is one active child marked present for the day, for the
// read-only Present tab of the monitoring screen. It carries no follow-up
// fields — there is nothing to chase for a child who came in.
type presentStudent struct {
	StudentID   string `json:"student_id"`
	Name        string `json:"name"`
	AdmissionNo string `json:"admission_no"`
	SectionID   string `json:"section_id"`
	SectionName string `json:"section_name"`
	ClassName   string `json:"class_name"`
}

type absenteeSection struct {
	SectionID   string            `json:"section_id"`
	SectionName string            `json:"section_name"`
	ClassName   string            `json:"class_name"`
	Students    []absenteeStudent `json:"students"`
	// Done is set once the office has closed this section for the day (see
	// finishAbsenceSection); DoneBy/DoneAt say who and when.
	Done   bool       `json:"done"`
	DoneBy *string    `json:"done_by"`
	DoneAt *time.Time `json:"done_at"`
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
		doneBy                            *string
		doneAt                            *time.Time
		contactsJSON                      []byte
		student                           absenteeStudent
	}
	items, err := collect(s, r, `
		SELECT sa.section_id::text, sec.name, c.name,
		       du.full_name, d.done_at,
		       sa.student_id::text,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.admission_no, sa.status,
		       COALESCE((
		         SELECT json_agg(json_build_object(
		                  'name', g.full_name, 'phone', g.phone, 'relation', g.relation)
		                ORDER BY (g.relation = 'father') DESC,
		                         (g.relation = 'mother') DESC,
		                         sg.is_primary DESC, g.full_name)
		           FROM student_guardians sg
		           JOIN guardians g ON g.id = sg.guardian_id
		          WHERE sg.student_id = st.id
		            AND g.phone IS NOT NULL AND btrim(g.phone) <> ''
		       ), '[]'),
		       COALESCE(f.call_status, 'not_called'),
		       COALESCE(f.parent_response, ''),
		       COALESCE(fu.full_name, ''),
		       f.updated_at
		  FROM student_attendance sa
		  JOIN students st  ON st.id = sa.student_id
		  JOIN sections sec ON sec.id = sa.section_id
		  JOIN classes  c   ON c.id = sec.class_id
		  LEFT JOIN student_absence_followup f
		         ON f.student_id = sa.student_id AND f.on_date = sa.on_date
		  LEFT JOIN users fu ON fu.id = f.updated_by
		  LEFT JOIN absence_followup_section_done d
		         ON d.section_id = sa.section_id AND d.on_date = sa.on_date
		  LEFT JOIN users du ON du.id = d.done_by
		 WHERE sa.on_date = $1::date
		   AND ($2::uuid IS NULL OR sa.section_id = $2)
		   AND sa.status IS NOT NULL
		   AND sa.status <> 'present'
		   AND sa.status <> 'holiday'
		   /* On leave is not an absence to chase: the family told the school
		      first, or applied and was approved. Ringing them again asks a
		      question they have already answered. */
		   AND sa.status <> 'leave'
		   AND `+scopePred+`
		 ORDER BY sec.name, st.admission_no`, args,
		func(rows pgx.Rows) (row, error) {
			var v row
			return v, rows.Scan(&v.sectionID, &v.sectionName, &v.className,
				&v.doneBy, &v.doneAt,
				&v.student.StudentID, &v.student.Name, &v.student.AdmissionNo, &v.student.Mark,
				&v.contactsJSON,
				&v.student.CallStatus, &v.student.ParentResponse,
				&v.student.CalledBy, &v.student.CalledAt)
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
				Done:        it.doneAt != nil,
				DoneBy:      it.doneBy,
				DoneAt:      it.doneAt,
			})
		}
		st := it.student
		st.Contacts = []absenteeContact{}
		if len(it.contactsJSON) > 0 {
			// A malformed aggregate is not worth failing the whole list over — the
			// office still needs the names and admission numbers — so a bad decode
			// leaves the child with no numbers rather than no row.
			_ = json.Unmarshal(it.contactsJSON, &st.Contacts)
		}
		sections[i].Students = append(sections[i].Students, st)
	}

	// The Present tab of the same screen: every ACTIVE child marked present for
	// the day, flat across the sections the caller may see. Same on_date /
	// section filter and the same scope predicate as the absentee query, so the
	// two tabs can never disagree about who a teacher may see. Strictly
	// status='present' — 'late' and 'half_day' are deliberately left out for now.
	pArgs := []any{on, nullString(q.Get("section_id"))}
	pPred, pScopeArgs := res.AttendancePredicate("sa", len(pArgs)+1)
	pArgs = append(pArgs, pScopeArgs...)
	present, err := collect(s, r, `
		SELECT sa.student_id::text,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.admission_no,
		       sa.section_id::text, sec.name, c.name
		  FROM student_attendance sa
		  JOIN students st  ON st.id = sa.student_id
		  JOIN sections sec ON sec.id = sa.section_id
		  JOIN classes  c   ON c.id = sec.class_id
		 WHERE sa.on_date = $1::date
		   AND ($2::uuid IS NULL OR sa.section_id = $2)
		   AND sa.status = 'present'
		   AND st.status = 'active'
		   AND `+pPred+`
		 ORDER BY sec.name, st.admission_no`, pArgs,
		func(rows pgx.Rows) (presentStudent, error) {
			var v presentStudent
			return v, rows.Scan(&v.StudentID, &v.Name, &v.AdmissionNo,
				&v.SectionID, &v.SectionName, &v.ClassName)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if present == nil {
		present = []presentStudent{}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"date":     on,
		"sections": sections,
		"present":  present,
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
	if !validCallStatus[req.CallStatus] {
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
		return s.upsertAbsenceFollowup(r, tx, res, id.UserID, studentID, req.OnDate,
			req.CallStatus, req.ParentResponse)
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

var validCallStatus = map[string]bool{"not_called": true, "called": true,
	"no_answer": true, "reached": true}

// upsertAbsenceFollowup writes one child's call log for one day, after
// confirming the child is inside the caller's read boundary. Shared by the
// single-row save and the section-level Done so the two can never disagree
// about who may write what.
func (s *Server) upsertAbsenceFollowup(r *http.Request, tx pgx.Tx, res *scope.Resolved,
	userID uuid.UUID, studentID uuid.UUID, onDate, callStatus, parentResponse string) error {
	// Mirror listAbsentees exactly: academics.attendance.read.all reaches every
	// student, otherwise only a child enrolled in a section the caller teaches /
	// is class teacher of, or the caller's own record / children.
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
		instID, studentID, onDate, callStatus, parentResponse, userID)
	return err
}

type absenceSectionDoneRequest struct {
	SectionID string `json:"section_id"`
	OnDate    string `json:"on_date"`
	Entries   []struct {
		StudentID      string `json:"student_id"`
		CallStatus     string `json:"call_status"`
		ParentResponse string `json:"parent_response"`
	} `json:"entries"`
}

// finishAbsenceSection is the "Done" at the bottom of a section's list: it
// saves every row the office edited in one go and records that the section is
// closed for the day, so the reviewed day can show who finished it and when.
// Pressing Done again on a section already closed simply re-saves the rows and
// refreshes the stamp.
func (s *Server) finishAbsenceSection(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req absenceSectionDoneRequest
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
	type entry struct {
		studentID              uuid.UUID
		callStatus, parentResp string
	}
	entries := make([]entry, 0, len(req.Entries))
	for _, e := range req.Entries {
		sid, err := uuid.Parse(e.StudentID)
		if err != nil {
			httpx.BadRequest(w, r, "student_id must be a uuid")
			return
		}
		if !validCallStatus[e.CallStatus] {
			httpx.BadRequest(w, r, "invalid call_status: "+e.CallStatus)
			return
		}
		entries = append(entries, entry{sid, e.CallStatus, e.ParentResponse})
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The section itself must be within reach, even when no row is sent —
		// a Done with nothing to save still stamps the section.
		if !res.AllAttendance {
			ok := false
			for _, sid := range res.SectionIDs {
				if sid == sectionID {
					ok = true
					break
				}
			}
			if !ok {
				return errAbsenceOutOfScope
			}
		}
		for _, e := range entries {
			if err := s.upsertAbsenceFollowup(r, tx, res, id.UserID, e.studentID,
				req.OnDate, e.callStatus, e.parentResp); err != nil {
				return err
			}
		}
		var instID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id FROM sections WHERE id = $1`, sectionID).Scan(&instID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			INSERT INTO absence_followup_section_done
			    (institution_id, section_id, on_date, done_by, done_at)
			VALUES ($1, $2, $3::date, $4, now())
			ON CONFLICT (section_id, on_date) DO UPDATE
			   SET done_by = EXCLUDED.done_by, done_at = now()`,
			instID, sectionID, req.OnDate, id.UserID)
		return err
	})
	if err == errAbsenceOutOfScope {
		httpx.Forbidden(w, r, "academics.attendance.read for this section")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
