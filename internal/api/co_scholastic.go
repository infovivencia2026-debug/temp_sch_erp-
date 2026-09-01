package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Art, games and discipline — the half of a report card with no marks in it.

   Every board asks for it and the product had nowhere to put it. So a school
   graded Art and Physical Education on paper, typed them into the report card
   by hand at the end of term, and kept no record afterwards: ask what a child
   got for Discipline last year and the answer was in a cupboard.

   IT IS NOT A SUBJECT. A subject has marks out of a paper, a syllabus, a
   teacher allocation and a place in the timetable. An area has a grade, a
   term and a sentence. Modelling it as a subject would put Discipline in the
   timetable, in the allocation grid, and in every percentage the report card
   computes — and a child with an A in Discipline has not scored anything.

   THE GRADE IS TEXT, deliberately. Schools grade this A/B/C, or Excellent /
   Good / Needs improvement, or 5 to 1. Storing a number invites somebody to
   average it into a percentage, which is the one thing co-scholastic
   assessment exists not to be.
*/

type coScholasticArea struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Sequence int    `json:"sequence"`
	IsActive bool   `json:"is_active"`
}

func (s *Server) listCoScholasticAreas(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, name, sequence, is_active
		  FROM co_scholastic_areas
		 ORDER BY is_active DESC, sequence, name`, nil,
		func(rows pgx.Rows) (coScholasticArea, error) {
			var v coScholasticArea
			return v, rows.Scan(&v.ID, &v.Name, &v.Sequence, &v.IsActive)
		})
	respond(w, r, items, err)
}

type coScholasticAreaRequest struct {
	ID       string `json:"id,omitempty"`
	Name     string `json:"name"`
	Sequence int    `json:"sequence,omitempty"`
	IsActive *bool  `json:"is_active,omitempty"`
}

func (s *Server) saveCoScholasticArea(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req coScholasticAreaRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		httpx.BadRequest(w, r, "an area needs a name")
		return
	}
	if len(name) > 80 {
		httpx.BadRequest(w, r, "keep the name under 80 characters")
		return
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			aid, err := uuid.Parse(req.ID)
			if err != nil {
				return err
			}
			return tx.QueryRow(r.Context(), `
				UPDATE co_scholastic_areas
				   SET name = $2, sequence = $3, is_active = $4
				 WHERE id = $1 RETURNING id::text`,
				aid, name, req.Sequence, active).Scan(&out)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO co_scholastic_areas (institution_id, name, sequence, is_active)
			VALUES ($1,$2,$3,$4) RETURNING id::text`,
			id.InstitutionID, name, req.Sequence, active).Scan(&out)
	})
	if isUniqueViolation(err) {
		httpx.BadRequest(w, r, "there is already an area called that")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": out, "name": name})
}

type coScholasticGradeRequest struct {
	AreaID string `json:"area_id"`
	TermID string `json:"term_id,omitempty"`
	Grade  string `json:"grade"`
	Remark string `json:"remark,omitempty"`
}

/*
Grading a child in one area, for one term.

	An upsert, not an insert. A second grade for the same area and term is a
	correction — a teacher revising what they put down last week — and storing
	both would leave the report card to choose between them.

	BLANK REMOVES IT, which is how a grade entered against the wrong child is
	taken back. There is no other control for that, and a wrong grade nobody
	can delete is one somebody works around by writing a second one.
*/
func (s *Server) saveCoScholasticGrade(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}
	var req coScholasticGradeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	areaID, err := uuid.Parse(strings.TrimSpace(req.AreaID))
	if err != nil {
		httpx.BadRequest(w, r, "choose an area")
		return
	}
	grade := strings.TrimSpace(req.Grade)
	if len(grade) > 40 || len(req.Remark) > 500 {
		httpx.BadRequest(w, r,
			"keep the grade under 40 characters and the remark under 500")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, args := res.StudentPredicate("st", 2)

	var removed bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// The child is checked inside the statement rather than before it, so
		// a row cannot be written for a child outside the caller's scope even
		// if somebody forgets the check next time.
		var allowed bool
		if err := tx.QueryRow(r.Context(),
			`SELECT true FROM students st WHERE st.id = $1 AND `+pred,
			append([]any{sid}, args...)...).Scan(&allowed); err != nil {
			return err
		}

		if grade == "" {
			removed = true
			_, err := tx.Exec(r.Context(), `
				DELETE FROM co_scholastic_grades
				 WHERE student_id = $1 AND area_id = $2
				   AND COALESCE(term_id, '00000000-0000-0000-0000-000000000000'::uuid)
				       = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
				sid, areaID, nullString(req.TermID))
			return err
		}

		_, err := tx.Exec(r.Context(), `
			INSERT INTO co_scholastic_grades (institution_id, student_id, area_id,
			                                  term_id, grade, remark, graded_by)
			VALUES ($1,$2,$3,$4::uuid,$5,NULLIF($6,''),$7)
			ON CONFLICT (student_id, area_id,
			             COALESCE(term_id, '00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET grade = EXCLUDED.grade,
			              remark = EXCLUDED.remark,
			              graded_by = EXCLUDED.graded_by,
			              graded_at = now()`,
			id.InstitutionID, sid, areaID, nullString(req.TermID),
			grade, req.Remark, id.UserID)
		return err
	})
	if err == pgx.ErrNoRows {
		httpx.Forbidden(w, r, "this child is not one you can grade")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": !removed, "removed": removed})
}

/*
The terms a school divides its year into.

	Needed by anything that records something "for Term 2" and by nothing else
	until now, so it was never exposed: terms has been in the schema from the
	beginning with no endpoint reading it. A co-scholastic grade belongs to a
	term — Art in Term 1 and Art in Term 3 are two different judgements about
	the same child — so the list has to be reachable.

	Ordered by sequence rather than by name, because a school that calls them
	"Michaelmas" and "Lent" would otherwise get them alphabetically.
*/
type termRow struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	StartsOn string `json:"starts_on"`
	EndsOn   string `json:"ends_on"`
}

func (s *Server) listTerms(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT t.id::text, t.name,
		       to_char(t.starts_on,'YYYY-MM-DD'), to_char(t.ends_on,'YYYY-MM-DD')
		  FROM terms t
		  JOIN academic_years ay ON ay.id = t.academic_year_id
		 WHERE ay.is_current
		 ORDER BY t.sequence, t.starts_on`, nil,
		func(rows pgx.Rows) (termRow, error) {
			var v termRow
			return v, rows.Scan(&v.ID, &v.Name, &v.StartsOn, &v.EndsOn)
		})
	respond(w, r, items, err)
}
