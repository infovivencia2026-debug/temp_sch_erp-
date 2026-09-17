package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/* THE ASSISTANT CAN CHANGE DATA -- BUT ONLY BY PROPOSING, NEVER BY ITSELF.

   The chat model has no database and runs no SQL. When a question asks to change
   something ("mark Arjun absent today"), the model does NOT do it: it emits a
   small, fixed ACTION describing what it intends, chosen from the catalogue
   below. The server validates that proposal, computes a real before/after
   preview under the ASKER'S OWN identity, and hands it back to the browser as a
   confirmation card. Nothing is written until the person presses Confirm, which
   calls executeAction -- and that re-checks the permission and runs the write
   under InTenant(tenantScope(id)), so RLS and the person's own role decide what
   is allowed, exactly as if they had used the screen by hand.

   Three guards, always:
     1. Every action names a permission; a person without it is refused, both at
        preview and at execute.
     2. Every write runs under the person's tenant scope -- no other school's
        rows can be touched.
     3. A `sensitive` action is flagged so the card can demand a second, typed
        confirmation. Payroll bank details, bulk deletes, logins/roles and
        security are deliberately NOT in the catalogue at all. */

// The sentinel the model wraps a proposed action in. Chosen to be unlikely in
// prose and easy to strip from the shown answer.
const (
	actionOpen  = "<<<ACTION>>>"
	actionClose = "<<<END>>>"
)

// proposedAction is what the browser is handed to draw a confirmation card. It
// is never executed by the chat call; the card's Confirm button executes it.
type proposedAction struct {
	Kind      string         `json:"kind"`
	Title     string         `json:"title"`
	Summary   string         `json:"summary"`
	Before    string         `json:"before,omitempty"`
	After     string         `json:"after,omitempty"`
	Sensitive bool           `json:"sensitive"`
	Params    map[string]any `json:"params"`
}

// actionSpec is one thing the assistant may propose.
type actionSpec struct {
	perm      string
	sensitive bool
	// preview reads current state and returns the card's wording; it writes
	// nothing. An error here (student not found, no permission) becomes a plain
	// message and no card is shown.
	preview func(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (proposedAction, error)
	// execute performs the write under the person's tenant scope and returns a
	// short result sentence.
	execute func(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (string, error)
}

// assistantActions is the whole catalogue of what the bot may change. Add an
// entry to widen it; nothing outside this map can ever be proposed or executed.
var assistantActions = map[string]actionSpec{
	"attendance.mark": {
		perm:    rbac.AttendanceWrite,
		preview: previewAttendanceMark,
		execute: executeAttendanceMark,
	},
	"marks.enter": {
		perm:    rbac.MarksWrite,
		preview: previewMarksEnter,
		execute: executeMarksEnter,
	},
	"student.create": {
		perm:      rbac.StudentsWrite,
		sensitive: true,
		preview:   previewStudentCreate,
		execute:   executeStudentCreate,
	},
	"guardian.set_phone": {
		perm:    rbac.StudentsWrite,
		preview: previewGuardianSetPhone,
		execute: executeGuardianSetPhone,
	},
	"fee.payment": {
		perm:      rbac.PaymentsWrite,
		sensitive: true,
		preview:   previewFeePayment,
		execute:   executeFeePayment,
	},
	"enquiry.create": {
		perm:    rbac.AdmissionsWrite,
		preview: previewEnquiryCreate,
		execute: executeEnquiryCreate,
	},
}

// assistantActionCatalogue is the prompt fragment that tells the model which
// actions exist and how to shape them. Kept beside the map so the two cannot
// drift far apart.
const assistantActionCatalogue = `
CHANGING DATA. You may propose a change ONLY from this exact list, and only when
the person clearly asks to make that change. You never state that a change is
done -- you PROPOSE it, and the person confirms it on a card. To propose one,
end your reply with a single line of the form:
` + actionOpen + `{"kind":"<kind>","params":{...}}` + actionClose + `
Put one short sentence before it saying what you are about to do. Emit the line
ONLY for a real change request, never for a "how do I" question, and never
invent a kind or a parameter that is not listed here.

Available actions:
- attendance.mark — mark one student present or absent for a day.
  params: {"student": "<name or admission number>", "date": "YYYY-MM-DD (optional, defaults to today)", "status": "present|absent|late|half_day|leave|holiday"}
- marks.enter — set or update one student's mark for a subject in an exam.
  params: {"student": "<name or admission number>", "exam": "<exam name, e.g. Term 1>", "subject": "<subject name, e.g. Maths>", "marks": <number>, "is_absent": <true if the child sat no paper, optional>}
- student.create — admit a new student and place them in a section.
  params: {"name": "<full name>", "class": "<class, e.g. 6>", "section": "<section, e.g. A>", "guardian_name": "<parent name, optional>", "guardian_phone": "<parent phone, optional>"}
- guardian.set_phone — add or correct a guardian's phone for a student.
  params: {"student": "<name or admission number>", "phone": "<new phone>", "guardian_name": "<which parent, optional — defaults to the primary guardian>", "relation": "father|mother|guardian|other (optional)"}
- fee.payment — record an ordinary counter fee payment for a student.
  params: {"student": "<name or admission number>", "amount": <rupees>, "mode": "cash|upi|card|neft|cheque|dd|netbanking (defaults to cash)", "head": "<what the payment is for, e.g. tuition, optional>", "reference_no": "<instrument/UPI reference, required for cheque or DD>"}
- enquiry.create — log an admissions enquiry for a prospective student.
  params: {"student_name": "<child name>", "class_sought": "<class, e.g. 3>", "parent_name": "<parent name, optional>", "phone": "<parent phone>", "source": "walk_in|phone|website|referral|campaign|other (optional)"}

fee.payment records an ORDINARY counter payment only. You can never touch bank
accounts, refunds, payroll, deletions, logins or passwords: if a change like
that is asked for, say you cannot make it and who can.`

/*
parseProposedAction pulls an action out of a model reply, if there is one.

	Returns the cleaned answer (the sentinel line removed) and the raw action, or
	ok=false when the reply is plain prose. Tolerant of the model wrapping the
	line in code fences or whitespace.
*/
func parseProposedAction(answer string) (clean string, kind string, params map[string]any, ok bool) {
	i := strings.Index(answer, actionOpen)
	if i < 0 {
		return answer, "", nil, false
	}
	j := strings.Index(answer[i:], actionClose)
	if j < 0 {
		return answer, "", nil, false
	}
	raw := answer[i+len(actionOpen) : i+j]
	var parsed struct {
		Kind   string         `json:"kind"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &parsed); err != nil || parsed.Kind == "" {
		// A malformed action is dropped and the surrounding prose is shown as is,
		// minus the broken sentinel, so nothing half-parsed reaches the card.
		clean = strings.TrimSpace(answer[:i] + answer[i+j+len(actionClose):])
		return clean, "", nil, false
	}
	clean = strings.TrimSpace(answer[:i] + answer[i+j+len(actionClose):])
	return clean, parsed.Kind, parsed.Params, true
}

// pstr reads a string param, trimmed.
func pstr(p map[string]any, k string) string {
	if v, ok := p[k].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

/*
resolveOneStudent finds the single active student a name or admission number

	names, under the asker's tenant scope. Returns a friendly error when it is
	ambiguous or missing, which the card turns into a plain sentence.
*/
func resolveOneStudent(ctx context.Context, tx pgx.Tx, q string) (id uuid.UUID, name, admission string, sectionID *uuid.UUID, err error) {
	ql := strings.ToLower(strings.TrimSpace(q))
	if ql == "" {
		return id, "", "", nil, fmt.Errorf("no student named")
	}
	/* Match on every word of the query, in any order, anywhere in the name --
	   not on the query as one contiguous run.

	   The old form was LIKE '%anitha patel%', which is exact-order AND requires
	   the two words to be adjacent, so "Anitha Patel" found nobody the moment the
	   child was recorded as "Anitha Kumari Patel": the middle name sat between
	   the two words the office typed. Splitting the query into words and asking
	   that each appear somewhere in the full name matches a first-plus-surname
	   against a first-middle-surname, and "Patel Anitha" against "Anitha Patel"
	   too. Everything is lower-cased on both sides, so case never mattered and
	   still does not. Ambiguity (two children share the words) is caught below
	   and answered by asking for the admission number. */
	args := []any{ql}
	tokenClause := "FALSE"
	if toks := strings.Fields(ql); len(toks) > 0 {
		preds := make([]string, 0, len(toks))
		for _, t := range toks {
			args = append(args, "%"+t+"%")
			preds = append(preds, fmt.Sprintf(
				"lower(concat_ws(' ', st.first_name, st.middle_name, st.last_name)) LIKE $%d",
				len(args)))
		}
		tokenClause = "(" + strings.Join(preds, " AND ") + ")"
	}
	rows, e := tx.Query(ctx, `
		SELECT st.id, btrim(concat_ws(' ', st.first_name, st.middle_name, st.last_name)),
		       st.admission_no,
		       (SELECT e.section_id FROM enrollments e
		         WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1)
		  FROM students st
		 WHERE st.status='active'
		   AND ( lower(st.admission_no) = $1
		      OR lower(btrim(concat_ws(' ', st.first_name, st.middle_name, st.last_name))) = $1
		      OR (length($1) >= 3 AND `+tokenClause+`) )
		 ORDER BY (lower(st.admission_no)=$1) DESC,
		          (lower(btrim(concat_ws(' ', st.first_name, st.middle_name, st.last_name)))=$1) DESC
		 LIMIT 3`, args...)
	if e != nil {
		return id, "", "", nil, e
	}
	defer rows.Close()
	type m struct {
		id      uuid.UUID
		name    string
		adm     string
		section *uuid.UUID
	}
	var found []m
	for rows.Next() {
		var x m
		if e := rows.Scan(&x.id, &x.name, &x.adm, &x.section); e != nil {
			return id, "", "", nil, e
		}
		found = append(found, x)
	}
	if len(found) == 0 {
		return id, "", "", nil, fmt.Errorf("no active student matches %q", q)
	}
	if len(found) > 1 && !strings.EqualFold(found[0].adm, q) && !strings.EqualFold(found[0].name, q) {
		return id, "", "", nil, fmt.Errorf("more than one student matches %q — use their admission number", q)
	}
	f := found[0]
	return f.id, f.name, f.adm, f.section, nil
}

var attendanceStatuses = map[string]bool{
	"present": true, "absent": true, "late": true,
	"half_day": true, "leave": true, "holiday": true,
}

func previewAttendanceMark(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (proposedAction, error) {
	student := pstr(p, "student")
	status := strings.ToLower(pstr(p, "status"))
	date := pstr(p, "date")
	if date == "" {
		date = time.Now().Format(time.DateOnly)
	}
	if _, err := time.Parse(time.DateOnly, date); err != nil {
		return proposedAction{}, fmt.Errorf("the date must be YYYY-MM-DD")
	}
	if !attendanceStatuses[status] {
		return proposedAction{}, fmt.Errorf("the status must be present, absent, late, half_day, leave or holiday")
	}
	var pa proposedAction
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		sid, name, adm, section, e := resolveOneStudent(r.Context(), tx, student)
		if e != nil {
			return e
		}
		if section == nil {
			return fmt.Errorf("%s is not placed in a section yet", name)
		}
		// The section must be one this person may mark.
		res, e := s.resolveScope(r)
		if e != nil {
			return e
		}
		if !res.CanMarkSection(*section) {
			return fmt.Errorf("you can only mark attendance for your own sections")
		}
		var before string
		e = tx.QueryRow(r.Context(),
			`SELECT status FROM student_attendance WHERE student_id=$1 AND on_date=$2::date AND period_id IS NULL`,
			sid, date).Scan(&before)
		if e != nil {
			before = "not marked"
		}
		pa = proposedAction{
			Kind:    "attendance.mark",
			Title:   "Mark attendance",
			Summary: fmt.Sprintf("Set %s (%s) to “%s” for %s.", name, adm, status, date),
			Before:  before,
			After:   status,
			Params:  map[string]any{"student_id": sid.String(), "date": date, "status": status, "name": name},
		}
		return nil
	})
	return pa, err
}

func executeAttendanceMark(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (string, error) {
	// Re-resolve from the confirmed params. student_id was pinned by preview; a
	// name is re-resolved so a stale card cannot be replayed against a different
	// child.
	sidStr := pstr(p, "student_id")
	status := strings.ToLower(pstr(p, "status"))
	date := pstr(p, "date")
	if date == "" {
		date = time.Now().Format(time.DateOnly)
	}
	if !attendanceStatuses[status] {
		return "", fmt.Errorf("invalid status")
	}
	if _, err := time.Parse(time.DateOnly, date); err != nil {
		return "", fmt.Errorf("invalid date")
	}
	var msg string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var sid uuid.UUID
		var name, adm string
		var section *uuid.UUID
		if u, e := uuid.Parse(sidStr); e == nil {
			sid = u
			e2 := tx.QueryRow(r.Context(), `
				SELECT btrim(concat_ws(' ', st.first_name, st.middle_name, st.last_name)), st.admission_no,
				       (SELECT e.section_id FROM enrollments e WHERE e.student_id=st.id ORDER BY e.enrolled_on DESC LIMIT 1)
				  FROM students st WHERE st.id=$1 AND st.status='active'`, sid).Scan(&name, &adm, &section)
			if e2 != nil {
				return fmt.Errorf("that student could not be found")
			}
		} else {
			var e error
			sid, name, adm, section, e = resolveOneStudent(r.Context(), tx, pstr(p, "student"))
			if e != nil {
				return e
			}
		}
		if section == nil {
			return fmt.Errorf("%s is not placed in a section", name)
		}
		res, e := s.resolveScope(r)
		if e != nil {
			return e
		}
		if !res.CanMarkSection(*section) {
			return fmt.Errorf("you can only mark attendance for your own sections")
		}
		_, e = tx.Exec(r.Context(), `
			INSERT INTO student_attendance
			    (institution_id, student_id, section_id, on_date, period_id,
			     status, minutes_late, remarks, marked_by, marked_at)
			VALUES ($1,$2,$3,$4::date,NULL,$5,0,'',$6, now())
			ON CONFLICT (student_id, on_date) WHERE period_id IS NULL DO UPDATE
			   SET status = EXCLUDED.status,
			       corrected_from = student_attendance.status,
			       corrected_by = EXCLUDED.marked_by,
			       corrected_at = now()
			 WHERE student_attendance.status IS DISTINCT FROM EXCLUDED.status`,
			id.InstitutionID, sid, *section, date, status, id.UserID)
		if e != nil {
			return e
		}
		msg = fmt.Sprintf("Marked %s (%s) “%s” for %s.", name, adm, status, date)
		return nil
	})
	return msg, err
}

// pfloat reads a numeric param, tolerating a string like "78" or "5000".
func pfloat(p map[string]any, k string) (float64, bool) {
	switch v := p[k].(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// pbool reads a boolean param, tolerating "true"/"yes".
func pbool(p map[string]any, k string) bool {
	switch v := p[k].(type) {
	case bool:
		return v
	case string:
		s := strings.ToLower(strings.TrimSpace(v))
		return s == "true" || s == "yes" || s == "1"
	}
	return false
}

/*
resolveOneStudentByID re-loads a student pinned by id in execute, so a stale

	confirm card cannot be replayed onto a different child. Falls back to the
	name the card carried when no id was pinned.
*/
func resolveOneStudentByID(ctx context.Context, tx pgx.Tx, idStr, nameFallback string) (uuid.UUID, string, string, *uuid.UUID, error) {
	if u, e := uuid.Parse(strings.TrimSpace(idStr)); e == nil {
		var name, adm string
		var section *uuid.UUID
		e2 := tx.QueryRow(ctx, `
			SELECT btrim(concat_ws(' ', st.first_name, st.middle_name, st.last_name)), st.admission_no,
			       (SELECT e.section_id FROM enrollments e WHERE e.student_id=st.id ORDER BY e.enrolled_on DESC LIMIT 1)
			  FROM students st WHERE st.id=$1 AND st.status='active'`, u).Scan(&name, &adm, &section)
		if e2 != nil {
			return uuid.Nil, "", "", nil, fmt.Errorf("that student could not be found")
		}
		return u, name, adm, section, nil
	}
	return resolveOneStudent(ctx, tx, nameFallback)
}

// --- marks.enter -------------------------------------------------------------

/*
resolveExamSubjectForStudent finds the one paper a (student, exam name,

	subject name) triple identifies, under the student's active class, and reads
	the mark already on it. Read-only.
*/
func resolveExamSubjectForStudent(ctx context.Context, tx pgx.Tx, studentID uuid.UUID, exam, subject string) (esID uuid.UUID, maxMarks float64, subjectName, examName string, oldMark *float64, oldAbsent bool, err error) {
	rows, e := tx.Query(ctx, `
		SELECT es.id, es.max_marks, COALESCE(sub.name,''), e.name,
		       (SELECT m.marks_obtained FROM marks m WHERE m.exam_subject_id=es.id AND m.student_id=$1),
		       COALESCE((SELECT m.is_absent FROM marks m WHERE m.exam_subject_id=es.id AND m.student_id=$1), false)
		  FROM exam_subjects es
		  JOIN exams e            ON e.id = es.exam_id
		  JOIN class_subjects cs  ON cs.id = es.class_subject_id
		  JOIN subjects sub       ON sub.id = cs.subject_id
		  JOIN enrollments en     ON en.class_id = cs.class_id
		                         AND en.student_id = $1 AND en.status='active'
		 WHERE lower(e.name)   LIKE '%'||lower($2)||'%'
		   AND lower(sub.name) LIKE '%'||lower($3)||'%'
		 ORDER BY e.created_at DESC
		 LIMIT 2`, studentID, exam, subject)
	if e != nil {
		return uuid.Nil, 0, "", "", nil, false, e
	}
	defer rows.Close()
	type hit struct {
		id      uuid.UUID
		max     float64
		subject string
		exam    string
		mark    *float64
		absent  bool
	}
	var found []hit
	for rows.Next() {
		var h hit
		if e := rows.Scan(&h.id, &h.max, &h.subject, &h.exam, &h.mark, &h.absent); e != nil {
			return uuid.Nil, 0, "", "", nil, false, e
		}
		found = append(found, h)
	}
	if len(found) == 0 {
		return uuid.Nil, 0, "", "", nil, false,
			fmt.Errorf("no %q paper for %q in this student's class", subject, exam)
	}
	if len(found) > 1 {
		return uuid.Nil, 0, "", "", nil, false,
			fmt.Errorf("more than one paper matches %q / %q — name the exam and subject exactly", exam, subject)
	}
	h := found[0]
	return h.id, h.max, h.subject, h.exam, h.mark, h.absent, nil
}

// canWriteMarks mirrors the authorisation applyMarksEntry enforces, so a preview
// refuses early rather than drawing a card the caller cannot confirm. Read-only.
func (s *Server) canWriteMarks(ctx context.Context, tx pgx.Tx, res *scope.Resolved, userID, esID, studentID uuid.UUID) (bool, error) {
	if res.AnySection || res.PlatformAdmin {
		return true, nil
	}
	var ok bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM exam_subjects es
		    JOIN section_subject_teachers t
		      ON t.class_subject_id = es.class_subject_id AND t.teacher_user_id = $2
		    JOIN enrollments en
		      ON en.section_id = t.section_id AND en.status='active' AND en.student_id = $3
		   WHERE es.id = $1
		) OR EXISTS (
		  SELECT 1 FROM enrollments en
		    JOIN sections sec ON sec.id = en.section_id
		   WHERE en.status='active' AND en.student_id = $3 AND sec.class_teacher_id = $2
		)`, esID, userID, studentID).Scan(&ok)
	return ok, err
}

func previewMarksEnter(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (proposedAction, error) {
	student := pstr(p, "student")
	exam := pstr(p, "exam")
	subject := pstr(p, "subject")
	if exam == "" || subject == "" {
		return proposedAction{}, fmt.Errorf("name both the exam and the subject")
	}
	isAbsent := pbool(p, "is_absent")
	var marks float64
	haveMarks := false
	if !isAbsent {
		m, ok := pfloat(p, "marks")
		if !ok {
			return proposedAction{}, fmt.Errorf("the mark must be a number")
		}
		marks = m
		haveMarks = true
	}
	res, err := s.resolveScope(r)
	if err != nil {
		return proposedAction{}, err
	}
	var pa proposedAction
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		sid, name, adm, _, e := resolveOneStudent(r.Context(), tx, student)
		if e != nil {
			return e
		}
		esID, maxMarks, subjName, examName, oldMark, oldAbsent, e := resolveExamSubjectForStudent(r.Context(), tx, sid, exam, subject)
		if e != nil {
			return e
		}
		if haveMarks && (marks < 0 || marks > maxMarks) {
			return fmt.Errorf("%g is outside 0–%g for %s", marks, maxMarks, subjName)
		}
		mayWrite, e := s.canWriteMarks(r.Context(), tx, res, id.UserID, esID, sid)
		if e != nil {
			return e
		}
		if !mayWrite {
			return fmt.Errorf("you are neither the subject teacher of this paper nor the class teacher of this student")
		}
		before := "not entered"
		if oldAbsent {
			before = "absent"
		} else if oldMark != nil {
			before = fmt.Sprintf("%g", *oldMark)
		}
		after := "absent"
		if !isAbsent {
			after = fmt.Sprintf("%g / %g", marks, maxMarks)
		}
		pa = proposedAction{
			Kind:    "marks.enter",
			Title:   "Enter a mark",
			Summary: fmt.Sprintf("Set %s (%s) in %s for %s to %s.", name, adm, subjName, examName, after),
			Before:  before,
			After:   after,
			Params: map[string]any{
				"exam_subject_id": esID.String(), "student_id": sid.String(),
				"marks": marks, "is_absent": isAbsent, "name": name,
			},
		}
		return nil
	})
	return pa, err
}

func executeMarksEnter(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (string, error) {
	esID := pstr(p, "exam_subject_id")
	sid := pstr(p, "student_id")
	if _, err := uuid.Parse(esID); err != nil {
		return "", fmt.Errorf("the exam paper could not be identified")
	}
	if _, err := uuid.Parse(sid); err != nil {
		return "", fmt.Errorf("the student could not be identified")
	}
	isAbsent := pbool(p, "is_absent")
	var marksPtr *float64
	if !isAbsent {
		m, _ := pfloat(p, "marks")
		marksPtr = &m
	}
	// Re-resolve is implicit: applyMarksEntry writes to exactly the pinned
	// exam_subject_id and student_id and re-runs the full scope check, so a
	// stale card cannot land on another paper or child.
	req := marksEntryRequest{ExamSubjectID: esID}
	req.Entries = append(req.Entries, struct {
		StudentID string   `json:"student_id"`
		Marks     *float64 `json:"marks_obtained"`
		IsAbsent  bool     `json:"is_absent"`
		Remarks   string   `json:"remarks,omitempty"`
	}{StudentID: sid, Marks: marksPtr, IsAbsent: isAbsent})

	written, err := s.applyMarksEntry(r, id, req)
	if errors.Is(err, errMarksForbidden) {
		return "", fmt.Errorf("you may not write marks on this paper")
	}
	var ceiling *markCeilingError
	if errors.As(err, &ceiling) {
		return "", ceiling
	}
	if err != nil {
		return "", err
	}
	if written == 0 {
		return "", fmt.Errorf("nothing was written")
	}
	return fmt.Sprintf("Recorded the mark for %s.", pstr(p, "name")), nil
}

// --- student.create ----------------------------------------------------------

// resolveSectionLabel turns a "6-A" (or "6" + "A") label into its section id.
// Read-only.
func resolveSectionLabel(ctx context.Context, tx pgx.Tx, label string) (string, string, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "", "", nil
	}
	var sid, display string
	err := tx.QueryRow(ctx, `
		SELECT s.id::text, c.name || '-' || s.name
		  FROM sections s JOIN classes c ON c.id = s.class_id
		 WHERE lower(c.name || '-' || s.name) = lower($1)
		    OR lower(c.name || s.name) = lower($1)
		 ORDER BY c.name, s.name
		 LIMIT 1`, label).Scan(&sid, &display)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", fmt.Errorf("no class and section called %q — create it first, and write it as the school does (e.g. 6 and A)", label)
	}
	if err != nil {
		return "", "", err
	}
	return sid, display, nil
}

func classSectionLabel(p map[string]any) string {
	class := pstr(p, "class")
	section := pstr(p, "section")
	switch {
	case class != "" && section != "":
		return class + "-" + section
	case class != "":
		return class
	default:
		return section
	}
}

func previewStudentCreate(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (proposedAction, error) {
	name := pstr(p, "name")
	if name == "" {
		name = strings.TrimSpace(pstr(p, "first_name") + " " + pstr(p, "last_name"))
	}
	if strings.TrimSpace(name) == "" {
		return proposedAction{}, fmt.Errorf("the child needs a name")
	}
	first, middle, last := splitName(name)
	label := classSectionLabel(p)
	guardianName := pstr(p, "guardian_name")
	guardianPhone := pstr(p, "guardian_phone")

	var pa proposedAction
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		sectionID, display := "", ""
		if label != "" {
			var e error
			sectionID, display, e = resolveSectionLabel(r.Context(), tx, label)
			if e != nil {
				return e
			}
		}
		summary := fmt.Sprintf("Admit %s", name)
		if display != "" {
			summary += " into " + display
		}
		summary += "."
		after := name
		if display != "" {
			after += " · " + display
		}
		if guardianName != "" {
			after += " · guardian " + guardianName
			if guardianPhone != "" {
				after += " (" + guardianPhone + ")"
			}
		}
		pa = proposedAction{
			Kind:      "student.create",
			Title:     "Admit a new student",
			Sensitive: true,
			Summary:   summary,
			Before:    "no such student yet",
			After:     after,
			Params: map[string]any{
				"first_name": first, "middle_name": middle, "last_name": last,
				"section_id": sectionID, "guardian_name": guardianName,
				"guardian_phone": guardianPhone, "name": name, "section_label": display,
			},
		}
		return nil
	})
	return pa, err
}

func executeStudentCreate(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (string, error) {
	req := studentWriteRequest{
		FirstName:     pstr(p, "first_name"),
		MiddleName:    pstr(p, "middle_name"),
		LastName:      pstr(p, "last_name"),
		SectionID:     pstr(p, "section_id"),
		GuardianName:  pstr(p, "guardian_name"),
		GuardianPhone: pstr(p, "guardian_phone"),
	}
	if err := req.validate(); err != nil {
		return "", err
	}
	if err := s.checkVocabulary(r, &req); err != nil {
		return "", err
	}
	var admissionNo string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, adm, e := upsertStudent(r, tx, id.InstitutionID, req)
		admissionNo = adm
		return e
	})
	if err != nil {
		return "", err
	}
	msg := fmt.Sprintf("Admitted %s", pstr(p, "name"))
	if lbl := pstr(p, "section_label"); lbl != "" {
		msg += " into " + lbl
	}
	return msg + " (admission no " + admissionNo + ").", nil
}

// --- guardian.set_phone ------------------------------------------------------

func previewGuardianSetPhone(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (proposedAction, error) {
	student := pstr(p, "student")
	phone := pstr(p, "phone")
	who := pstr(p, "guardian_name")
	relation := strings.ToLower(pstr(p, "relation"))
	if phone == "" {
		return proposedAction{}, fmt.Errorf("give the new phone number")
	}
	res, err := s.resolveScope(r)
	if err != nil {
		return proposedAction{}, err
	}
	pred, args := res.StudentPredicate("st", 2)
	var pa proposedAction
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		sid, name, adm, _, e := resolveOneStudent(r.Context(), tx, student)
		if e != nil {
			return e
		}
		// Confined to a family this caller may edit.
		var allowed bool
		if e := tx.QueryRow(r.Context(),
			`SELECT true FROM students st WHERE st.id = $1 AND `+pred,
			append([]any{sid}, args...)...).Scan(&allowed); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return fmt.Errorf("%s is not a child you can edit", name)
			}
			return e
		}
		// Find the guardian to correct: the named one, else the primary.
		var gid, gname, grel, gemail, oldPhone string
		q := `
			SELECT g.id::text, g.full_name, g.relation,
			       COALESCE(g.email::text,''), COALESCE(g.phone,'')
			  FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
			 WHERE sg.student_id = $1`
		qargs := []any{sid}
		if who != "" {
			q += ` AND lower(g.full_name) LIKE '%'||lower($2)||'%' ORDER BY sg.is_primary DESC LIMIT 1`
			qargs = append(qargs, who)
		} else {
			q += ` ORDER BY sg.is_primary DESC, g.created_at LIMIT 1`
		}
		e = tx.QueryRow(r.Context(), q, qargs...).Scan(&gid, &gname, &grel, &gemail, &oldPhone)
		before := "no phone"
		params := map[string]any{"student_id": sid.String(), "phone": phone, "name": name}
		if errors.Is(e, pgx.ErrNoRows) {
			// Adding a new guardian rather than correcting one.
			if who == "" {
				return fmt.Errorf("%s has no guardian on record — give the guardian's name to add one", name)
			}
			if relation == "" {
				relation = "guardian"
			}
			params["full_name"] = who
			params["relation"] = relation
			before = "no guardian named " + who
			pa = proposedAction{
				Kind:    "guardian.set_phone",
				Title:   "Add a guardian phone",
				Summary: fmt.Sprintf("Add %s (%s) as a guardian of %s (%s).", who, phone, name, adm),
				Before:  before,
				After:   phone,
				Params:  params,
			}
			return nil
		}
		if e != nil {
			return e
		}
		if oldPhone != "" {
			before = oldPhone
		}
		params["guardian_id"] = gid
		params["full_name"] = gname
		params["relation"] = grel
		params["email"] = gemail
		pa = proposedAction{
			Kind:    "guardian.set_phone",
			Title:   "Correct a guardian phone",
			Summary: fmt.Sprintf("Change %s's phone (guardian of %s, %s).", gname, name, adm),
			Before:  before,
			After:   phone,
			Params:  params,
		}
		return nil
	})
	return pa, err
}

func executeGuardianSetPhone(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (string, error) {
	sidStr := pstr(p, "student_id")
	phone := pstr(p, "phone")
	if phone == "" {
		return "", fmt.Errorf("give the new phone number")
	}
	res, err := s.resolveScope(r)
	if err != nil {
		return "", err
	}
	pred, args := res.StudentPredicate("st", 2)
	req := guardianWriteRequest{
		ID:       pstr(p, "guardian_id"),
		FullName: pstr(p, "full_name"),
		Relation: pstr(p, "relation"),
		Phone:    phone,
		Email:    pstr(p, "email"),
	}
	var name string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Re-resolve the child by the pinned id so a stale card cannot move a
		// number onto another family.
		sid, n, _, _, e := resolveOneStudentByID(r.Context(), tx, sidStr, pstr(p, "student"))
		if e != nil {
			return e
		}
		name = n
		_, _, e = s.upsertGuardianForStudent(r, id, tx, sid, pred, args, req)
		return e
	})
	if gie := (guardianInputError{}); errors.As(err, &gie) {
		return "", fmt.Errorf("%s", gie.msg)
	}
	if errors.Is(err, errGuardianPhoneTaken) {
		return "", fmt.Errorf("that number is already the sign-in of another account here")
	}
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Saved the guardian phone for %s.", name), nil
}

// --- fee.payment -------------------------------------------------------------

func amountToPaise(p map[string]any) (int64, bool) {
	if v, ok := pfloat(p, "amount_paise"); ok {
		return int64(v), true
	}
	if v, ok := pfloat(p, "amount"); ok {
		return int64(math.Round(v * 100)), true
	}
	return 0, false
}

func previewFeePayment(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (proposedAction, error) {
	student := pstr(p, "student")
	paise, ok := amountToPaise(p)
	if !ok || paise <= 0 {
		return proposedAction{}, fmt.Errorf("give the amount as a positive number of rupees")
	}
	mode := strings.ToLower(pstr(p, "mode"))
	if mode == "" {
		mode = "cash"
	}
	if !validModes[mode] {
		return proposedAction{}, fmt.Errorf("the mode must be one of cash, upi, card, neft, cheque, dd or netbanking")
	}
	head := pstr(p, "head")
	if head == "" {
		head = pstr(p, "purpose")
	}
	var pa proposedAction
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		sid, name, adm, _, e := resolveOneStudent(r.Context(), tx, student)
		if e != nil {
			return e
		}
		rupees := "₹" + strconv.FormatFloat(float64(paise)/100, 'f', 2, 64)
		summary := fmt.Sprintf("Record %s from %s (%s) by %s.", rupees, name, adm, mode)
		after := rupees + " · " + mode
		if head != "" {
			after += " · " + head
		}
		pa = proposedAction{
			Kind:      "fee.payment",
			Title:     "Record a fee payment",
			Sensitive: true,
			Summary:   summary,
			Before:    "no payment yet",
			After:     after,
			Params: map[string]any{
				"student_id": sid.String(), "amount_paise": paise, "mode": mode,
				"head": head, "reference_no": pstr(p, "reference_no"), "name": name,
			},
		}
		return nil
	})
	return pa, err
}

func executeFeePayment(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (string, error) {
	sidStr := pstr(p, "student_id")
	paise, ok := amountToPaise(p)
	if !ok || paise <= 0 {
		return "", fmt.Errorf("invalid amount")
	}
	mode := strings.ToLower(pstr(p, "mode"))
	if mode == "" {
		mode = "cash"
	}
	var studentID uuid.UUID
	// Re-resolve the pinned student id so a stale card cannot pay onto another
	// child. The write itself goes through applyFeePayment → fees.Collect, the
	// ordinary counter path — no bank account, refund or payroll is reachable.
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		sid, _, _, _, e := resolveOneStudentByID(r.Context(), tx, sidStr, pstr(p, "student"))
		studentID = sid
		return e
	})
	if err != nil {
		return "", err
	}
	req := collectRequest{
		StudentID:   studentID.String(),
		AmountPaise: paise,
		Mode:        mode,
		Remarks:     pstr(p, "head"),
		ReferenceNo: pstr(p, "reference_no"),
	}
	receipt, err := s.applyFeePayment(r, id, req)
	var fe feeInputError
	if errors.As(err, &fe) {
		return "", fmt.Errorf("%s", fe.msg)
	}
	if err != nil {
		return "", err
	}
	rupees := "₹" + strconv.FormatFloat(float64(receipt.AmountPaise)/100, 'f', 2, 64)
	if !receipt.Cleared {
		return fmt.Sprintf("Recorded %s from %s by %s, receipt %s — counts once it clears.",
			rupees, pstr(p, "name"), mode, receipt.ReceiptNo), nil
	}
	return fmt.Sprintf("Recorded %s from %s, receipt %s.", rupees, pstr(p, "name"), receipt.ReceiptNo), nil
}

// --- enquiry.create ----------------------------------------------------------

func previewEnquiryCreate(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (proposedAction, error) {
	childName := pstr(p, "student_name")
	if childName == "" {
		childName = pstr(p, "child_name")
	}
	phone := pstr(p, "phone")
	if strings.TrimSpace(childName) == "" || strings.TrimSpace(phone) == "" {
		return proposedAction{}, fmt.Errorf("give the child's name and a phone number")
	}
	source := strings.ToLower(pstr(p, "source"))
	if source == "" {
		source = "walk_in"
	}
	if err := oneOf("source", source, enquirySources); err != nil {
		return proposedAction{}, err
	}
	classSought := pstr(p, "class_sought")
	if classSought == "" {
		classSought = pstr(p, "class")
	}
	parent := pstr(p, "parent_name")
	after := childName
	if classSought != "" {
		after += " · class " + classSought
	}
	if parent != "" {
		after += " · " + parent
	}
	after += " · " + phone
	summary := fmt.Sprintf("Log an enquiry for %s", childName)
	if classSought != "" {
		summary += " (class " + classSought + ")"
	}
	summary += "."
	return proposedAction{
		Kind:    "enquiry.create",
		Title:   "Log an admissions enquiry",
		Summary: summary,
		Before:  "no enquiry yet",
		After:   after,
		Params: map[string]any{
			"student_name": childName, "parent_name": parent, "phone": phone,
			"class_sought": classSought, "source": source, "email": pstr(p, "email"),
		},
	}, nil
}

func executeEnquiryCreate(s *Server, r *http.Request, id *httpx.Identity, p map[string]any) (string, error) {
	req := upsertEnquiryRequest{
		StudentName: pstr(p, "student_name"),
		ParentName:  pstr(p, "parent_name"),
		Phone:       pstr(p, "phone"),
		Email:       pstr(p, "email"),
		ClassSought: pstr(p, "class_sought"),
		Source:      strings.ToLower(pstr(p, "source")),
	}
	_, _, _, err := s.applyCreateEnquiry(r, id, req)
	if eie := (enquiryInputError{}); errors.As(err, &eie) {
		return "", fmt.Errorf("%s", eie.msg)
	}
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Logged an enquiry for %s.", req.StudentName), nil
}

// --- the endpoints -----------------------------------------------------------

type assistantActionRequest struct {
	Kind   string         `json:"kind"`
	Params map[string]any `json:"params"`
}

/*
assistantActionExecute performs a confirmed change. Called by the card's

	Confirm button, never by the chat call. Re-checks the permission, so a
	forged request without it is refused exactly as the preview was.
*/
func (s *Server) assistantActionExecute(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id == nil {
		httpx.Unauthorized(w, r)
		return
	}
	var req assistantActionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	spec, ok := assistantActions[req.Kind]
	if !ok {
		httpx.BadRequest(w, r, "that action is not one the assistant can take")
		return
	}
	if !id.Can(spec.perm) {
		httpx.Forbidden(w, r, spec.perm)
		return
	}
	msg, err := spec.execute(s, r, id, req.Params)
	if err != nil {
		httpx.Error(w, r, http.StatusUnprocessableEntity, "action_failed", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
}
