package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
Correcting and removing an examination.

	An exam could be created and never touched again. A school that scheduled
	"Formative Assesment 1" with the dates a week out had one exam with a
	spelling mistake in it forever, printed on every report card it produced,
	and one extra exam sitting in every list for the rest of the year -- and
	the only way out was to ask us to run SQL.

	This is not a small omission dressed up. An exam is the thing report cards
	hang off, and a school gets its name wrong on the first attempt more often
	than on any other record, because it is typed once, in a hurry, before term.
*/

type examPatch struct {
	Name           *string `json:"name,omitempty"`
	Kind           *string `json:"kind,omitempty"`
	StartsOn       *string `json:"starts_on,omitempty"`
	EndsOn         *string `json:"ends_on,omitempty"`
	GradingScaleID *string `json:"grading_scale_id,omitempty"`
}

func (s *Server) updateExam(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	examID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid exam id")
		return
	}
	var req examPatch
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		httpx.BadRequest(w, r, "an exam needs a name")
		return
	}
	if req.Kind != nil && !validExamKind(*req.Kind) {
		httpx.BadRequest(w, r,
			"kind must be one of unit_test, periodic, term, practical, internal, "+
				"formative, summative, board")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE exams SET
			    name             = COALESCE(NULLIF(btrim($2),''), name),
			    kind             = COALESCE(NULLIF($3,''), kind),
			    /* Dates clear when sent empty. A school that scheduled an exam
			       and then decided not to fix the days yet needs to be able to
			       take the dates off, which COALESCE alone would not allow. */
			    starts_on        = CASE WHEN $4::text IS NULL THEN starts_on
			                            ELSE NULLIF($4,'')::date END,
			    ends_on          = CASE WHEN $5::text IS NULL THEN ends_on
			                            ELSE NULLIF($5,'')::date END,
			    grading_scale_id = CASE WHEN $6::text IS NULL THEN grading_scale_id
			                            ELSE NULLIF($6,'')::uuid END
			 WHERE id = $1`,
			examID, req.Name, req.Kind, req.StartsOn, req.EndsOn, req.GradingScaleID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errRefGone
		}
		return nil
	})
	writeRefResult(w, r, err, "exam", examID)
}

/*
deleteExam removes an exam that has no marks against it.

	Refused once a single mark exists, and refused rather than cascaded. The
	rows underneath an exam are a child's marks and their report cards, and a
	school deleting "the wrong exam" would take a term of results with it and
	be told only that it had worked.

	The count is reported so the refusal is actionable: "43 marks" tells
	somebody this is the exam their teachers have been entering, which is
	usually the moment they realise they meant the other one.
*/
func (s *Server) deleteExam(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	examID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid exam id")
		return
	}

	var marks, cards int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT (SELECT count(*)::int FROM marks m
			          JOIN exam_subjects es ON es.id = m.exam_subject_id
			         WHERE es.exam_id = e.id),
			       (SELECT count(*)::int FROM report_cards rc WHERE rc.exam_id = e.id)
			  FROM exams e WHERE e.id = $1`, examID).Scan(&marks, &cards); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errRefGone
			}
			return err
		}
		if marks > 0 || cards > 0 {
			return errRefInUse
		}
		// The papers go with it: an exam_subject is a paper of this exam and
		// means nothing without it. Nothing else points at them, because no
		// mark exists.
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM exam_subjects WHERE exam_id = $1`, examID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM exams WHERE id = $1`, examID)
		return err
	})
	if errors.Is(err, errRefInUse) {
		httpx.BadRequest(w, r,
			plural(marks, "mark", "marks")+" and "+
				plural(cards, "report card", "report cards")+
				" belong to this exam. Deleting it would take them with it — "+
				"if this is the wrong exam, check which one your teachers have "+
				"been entering into")
		return
	}
	writeRefResult(w, r, err, "exam", examID)
}

// validExamKind mirrors the table's own CHECK, so a bad value is a 400 naming
// the alternatives rather than a 500 from the constraint.
func validExamKind(k string) bool {
	switch strings.TrimSpace(k) {
	case "unit_test", "periodic", "term", "practical",
		"internal", "formative", "summative", "board":
		return true
	}
	return false
}
