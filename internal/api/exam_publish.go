package api

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
Releasing an exam's marks to families.

	exams has carried is_published, published_at and published_by since the
	baseline, and nothing ever set them. The family portal gated a child's
	marks on "some report card of theirs has been published" instead — which
	held until the first card of the year went out, and from that day on every
	unit-test mark reached the parent the moment the teacher saved it, before
	moderation and before the head had seen it.

	Publication is per exam, by the controller who signs marks off, and it is
	reversible: a withdrawn exam disappears from the portal again. The report
	card workflow is untouched — a published card still shows its own exam's
	marks — so a school that only ever releases cards loses nothing.
*/

type publishExamRequest struct {
	ExamID  string `json:"exam_id"`
	Publish *bool  `json:"publish,omitempty"`
}

var errNothingToPublish = errors.New("no marks entered")

func (s *Server) publishExamResults(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req publishExamRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	examID, err := uuid.Parse(req.ExamID)
	if err != nil {
		httpx.BadRequest(w, r, "exam_id must be a uuid")
		return
	}
	publish := req.Publish == nil || *req.Publish

	var name string
	var marks int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT e.name,
			       (SELECT count(*) FROM marks m
			          JOIN exam_subjects es ON es.id = m.exam_subject_id
			         WHERE es.exam_id = e.id)::int
			  FROM exams e WHERE e.id = $1`, examID).Scan(&name, &marks); err != nil {
			return err
		}
		// Releasing an exam with nothing in it tells every family "results
		// are out" and shows them a blank page.
		if publish && marks == 0 {
			return errNothingToPublish
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE exams
			   SET is_published = $2,
			       published_at = CASE WHEN $2 THEN now() END,
			       published_by = CASE WHEN $2 THEN $3::uuid END
			 WHERE id = $1`, examID, publish, id.UserID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case errors.Is(err, errNothingToPublish):
		httpx.Error(w, r, http.StatusConflict, "nothing_to_publish",
			"no marks have been entered for "+name+" yet, so there is nothing to release")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{
			"exam_id": examID.String(), "published": publish, "marks": marks,
		})
	}
}
