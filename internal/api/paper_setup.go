package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What a paper is out of, and which scale turns it into a grade.

   Both were decided once, invisibly, when the exam was created: every paper
   took the same maximum, and the grade came from whichever scale happened to be
   the school's default. Neither could be changed afterwards from anywhere in
   the product.

   That is wrong twice over. A formative is out of 20 and a term paper out of
   80, in the same exam, in every school in the country — one number for all of
   them is a number that is wrong for most of them. And a school that grades A1
   to E2 on one board and O to F on another cannot be told which scale its own
   report cards use.

   Both are set here, before marks are entered, which is the only safe moment.
   Changing the maximum after marks exist re-grades every child silently: 45
   out of 50 is a distinction and 45 out of 100 is a fail, and nothing on the
   screen would have moved. So it is refused once a single mark is in, and the
   refusal says how many marks are in the way.
*/

type paperSetupReq struct {
	// Out of. The number a parent reads as the denominator on the report card.
	MaxMarks *float64 `json:"max_marks,omitempty"`
	// The line between a pass and a fail on this paper. Defaults to a third,
	// which is the usual Indian minimum, but a practical or an internal often
	// sits higher.
	PassMarks *float64 `json:"pass_marks,omitempty"`
	// Which scale turns a percentage into a letter. Set on the exam rather than
	// the paper: a report card mixing two scales is unreadable.
	GradingScaleID *string `json:"grading_scale_id,omitempty"`
}

// setPaperSetup fixes what a paper is out of and which scale grades it.
func (s *Server) setPaperSetup(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	esID, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var in paperSetupReq
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.BadRequest(w, r, "Send what the paper is out of.")
		return
	}
	if in.MaxMarks == nil && in.PassMarks == nil && in.GradingScaleID == nil {
		httpx.BadRequest(w, r, "Nothing to change.")
		return
	}
	if in.MaxMarks != nil && (*in.MaxMarks <= 0 || *in.MaxMarks > 1000) {
		httpx.BadRequest(w, r, "A paper is out of somewhere between 1 and 1000.")
		return
	}
	if in.MaxMarks != nil && in.PassMarks != nil && *in.PassMarks > *in.MaxMarks {
		httpx.BadRequest(w, r,
			"The pass mark cannot be higher than what the paper is out of — nobody could pass it.")
		return
	}

	var entered int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var examID string
		if err := tx.QueryRow(r.Context(), `
			SELECT exam_id::text,
			       (SELECT count(*)::int FROM marks m WHERE m.exam_subject_id = $1)
			  FROM exam_subjects WHERE id = $1`, esID).Scan(&examID, &entered); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				httpx.NotFound(w, r)
				return errStopped
			}
			return err
		}

		/* Once a mark is in, the denominator is part of what was recorded.

		   45 out of 50 is a distinction and 45 out of 100 is a fail. Moving the
		   maximum afterwards changes every child's result without touching a
		   single mark, and nothing on the screen would move to say so. */
		if entered > 0 && in.MaxMarks != nil {
			return errMarksAlreadyIn
		}

		if in.MaxMarks != nil || in.PassMarks != nil {
			if _, err := tx.Exec(r.Context(), `
				UPDATE exam_subjects
				   SET max_marks  = COALESCE($2, max_marks),
				       pass_marks = COALESCE($3, LEAST(pass_marks, COALESCE($2, max_marks)))
				 WHERE id = $1`, esID, in.MaxMarks, in.PassMarks); err != nil {
				return err
			}
		}
		if in.GradingScaleID != nil {
			// Belongs to the exam, so every paper in it grades the same way.
			if _, err := tx.Exec(r.Context(), `
				UPDATE exams SET grading_scale_id = NULLIF($2,'')::uuid WHERE id = $1::uuid`,
				examID, *in.GradingScaleID); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, errStopped) {
		return
	}
	if errors.Is(err, errMarksAlreadyIn) {
		httpx.Error(w, r, http.StatusConflict, "marks_already_entered",
			"this paper already has marks entered, so what it is out of can no longer change — 45 out of 50 is a distinction and 45 out of 100 is a fail. Clear the marks first, or set the maximum on a new paper.")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"updated": true, "marks_entered": entered})
}

var errMarksAlreadyIn = errors.New("marks already entered")
