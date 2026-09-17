package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
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

If a change is asked for that is not in this list (anything about pay, deleting
records, logins or passwords), say you cannot make that change and who can.`

/* parseProposedAction pulls an action out of a model reply, if there is one.

   Returns the cleaned answer (the sentinel line removed) and the raw action, or
   ok=false when the reply is plain prose. Tolerant of the model wrapping the
   line in code fences or whitespace. */
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

/* resolveOneStudent finds the single active student a name or admission number
   names, under the asker's tenant scope. Returns a friendly error when it is
   ambiguous or missing, which the card turns into a plain sentence. */
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

// --- the endpoints -----------------------------------------------------------

type assistantActionRequest struct {
	Kind   string         `json:"kind"`
	Params map[string]any `json:"params"`
}

/* assistantActionExecute performs a confirmed change. Called by the card's
   Confirm button, never by the chat call. Re-checks the permission, so a
   forged request without it is refused exactly as the preview was. */
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
