package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* A child who leaves without a transfer certificate.

   Issuing a TC already ends a child's time at the school: it stamps the exit
   date, writes the reason, closes the enrolment and freezes a snapshot into
   the certificate. That is the right path for a family moving to another
   school, because the other school will ask for the document.

   It is not the only way a child leaves. They graduate. The family moves
   abroad and never asks for anything. A child stops coming and after a term
   the office has to say so. None of those produce a TC, and the product had
   no way to record them — so the roll kept counting children who had not been
   in the building for a year, and the only way to remove one was to issue a
   certificate the family never asked for and that says something untrue.

   WHAT THIS DOES NOT DO

   It does not delete anything. The child's record, marks, attendance, fees
   and documents stay exactly where they are; the status changes and the
   enrolment closes. A school is asked about a former pupil years later — for
   a reference, a duplicate certificate, a legal matter — and a product that
   answered by deleting the record would be answering "we no longer know".

   That is also why there is a way back. An exit recorded against the wrong
   child is an ordinary mistake at a busy counter, and a mistake that cannot
   be undone is one somebody hides instead of correcting.
*/

// The states a child can leave in. Not free text: these feed the roll count,
// the alumni register and the statutory returns, and a school typing
// "left"/"Left"/"LEFT" would be three different answers to one question.
var exitStatuses = map[string]string{
	"graduated":   "Completed the final year",
	"transferred": "Moved to another school",
	"withdrawn":   "Withdrawn by the family",
	"alumni":      "Former pupil",
}

type studentExitRequest struct {
	// graduated | transferred | withdrawn | alumni
	Status string `json:"status"`
	// Blank means today, which is what the counter means nine times in ten.
	ExitDate string `json:"exit_date,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

func (s *Server) recordStudentExit(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	var req studentExitRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	status := strings.ToLower(strings.TrimSpace(req.Status))
	if status == "" {
		status = "withdrawn"
	}
	if _, ok := exitStatuses[status]; !ok {
		httpx.BadRequest(w, r,
			"status must be graduated, transferred, withdrawn or alumni")
		return
	}
	exitDate := strings.TrimSpace(req.ExitDate)
	if exitDate != "" {
		d, err := time.Parse(time.DateOnly, exitDate)
		if err != nil {
			httpx.BadRequest(w, r, "exit_date must be YYYY-MM-DD")
			return
		}
		/* A leaving date in the future would take a child off the roll who is
		   still in the classroom on Monday — and the attendance register, which
		   reads the enrolment, would stop expecting them. */
		if d.After(time.Now().In(indiaTZ()).AddDate(0, 0, 1)) {
			httpx.BadRequest(w, r, "a leaving date cannot be in the future")
			return
		}
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 4)

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE students st
			   SET status = $1,
			       exit_date = COALESCE($2::date, CURRENT_DATE),
			       exit_reason = $3,
			       updated_at = now()
			 WHERE st.id = $4 AND `+pred,
			append([]any{status, nullString(exitDate), nullString(req.Reason), sid},
				args...)...)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		if touched == 0 {
			return nil
		}
		/* The enrolment closes with the child.

		   Left open, the section still counts them: the class list, the
		   attendance register and every "how many in 7-A" would include a
		   child who has left, and the register would mark them absent every
		   day for the rest of the year. */
		_, err = tx.Exec(r.Context(), `
			UPDATE enrollments SET status = $2
			 WHERE student_id = $1 AND status = 'active'`, sid, status)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if touched == 0 {
		httpx.Forbidden(w, r, "this child is not one you can edit")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": status})
}

/*
Putting a child back on the roll.

	Two real cases, and both happen at a counter. An exit recorded against the
	wrong child — two children with the same name is the usual way. And a
	family that leaves in April and returns in June, which in a school with a
	transient intake is routine rather than exceptional.

	Re-admitting does NOT restore the old enrolment. The child needs a section
	for the year they are coming back into, and reopening a closed enrolment
	would put them in last year's class. They come back unplaced and the office
	places them, which is the same path a new admission takes.
*/
func (s *Server) readmitStudent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 2)

	var touched int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE students st
			   SET status = 'active', exit_date = NULL, exit_reason = NULL,
			       updated_at = now()
			 WHERE st.id = $1 AND st.status <> 'active' AND `+pred,
			append([]any{sid}, args...)...)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if touched == 0 {
		httpx.Error(w, r, http.StatusConflict, "not_readmittable",
			"this child is either already on the roll or not one you can edit")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "active"})
}
