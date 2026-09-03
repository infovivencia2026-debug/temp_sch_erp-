package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* A PAPER FROM A BLUEPRINT, DRAWN FROM THE BANK.

   The catalogue calls this an AI paper generator. It is not: it is the draw a
   teacher does by hand the night before — "four easy one-markers from chapter
   3, two hard five-markers from anywhere" — done by the bank instead of by
   turning pages. Nothing is written or invented. A row that asks for more than
   the bank holds comes back short and says by how many, which is the number
   the teacher needs: it is how many questions they still have to write.

   Randomised on purpose, so two teachers with the same blueprint and the same
   bank do not set the same paper, and so a class that has seen last year's
   paper has not seen this one.

   Nothing is saved here. The teacher reads the draw, redraws a row they
   dislike, and takes the result to the online test builder or to print; a
   saved "generated paper" would be a second object standing between the bank
   and the test with nothing to say that either does not. */

type blueprintRow struct {
	Difficulty     string  `json:"difficulty"`
	Kind           string  `json:"kind"`
	SyllabusUnitID string  `json:"syllabus_unit_id"`
	Marks          float64 `json:"marks"`
	Count          int     `json:"count"`
}

type composeRequest struct {
	ClassSubjectID string         `json:"class_subject_id"`
	Rows           []blueprintRow `json:"rows"`
}

type composedQuestion struct {
	ID         string   `json:"id"`
	Stem       string   `json:"stem"`
	Kind       string   `json:"kind"`
	Difficulty string   `json:"difficulty"`
	BloomLevel string   `json:"bloom_level"`
	Chapter    *string  `json:"chapter"`
	Marks      float64  `json:"marks"`
	Options    []string `json:"options"`
}

type composedSection struct {
	Row       blueprintRow       `json:"row"`
	Wanted    int                `json:"wanted"`
	Found     int                `json:"found"`
	Questions []composedQuestion `json:"questions"`
}

type composedPaper struct {
	Sections   []composedSection `json:"sections"`
	TotalMarks float64           `json:"total_marks"`
	Questions  int               `json:"questions"`
	Short      int               `json:"short"`
}

const blueprintMaxRows = 20
const blueprintMaxPerRow = 50

func (s *Server) composePaper(w http.ResponseWriter, r *http.Request) {
	var req composeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	csID, perr := uuid.Parse(req.ClassSubjectID)
	if perr != nil {
		httpx.BadRequest(w, r, "choose a subject first")
		return
	}
	if len(req.Rows) == 0 {
		httpx.BadRequest(w, r, "the blueprint needs at least one row")
		return
	}
	if len(req.Rows) > blueprintMaxRows {
		httpx.BadRequest(w, r, "a blueprint has at most 20 rows")
		return
	}
	for i := range req.Rows {
		row := &req.Rows[i]
		row.Difficulty = strings.TrimSpace(row.Difficulty)
		row.Kind = strings.TrimSpace(row.Kind)
		row.SyllabusUnitID = strings.TrimSpace(row.SyllabusUnitID)
		if row.Difficulty != "" && !difficulties[row.Difficulty] {
			httpx.BadRequest(w, r, "difficulty is easy, medium or hard")
			return
		}
		if row.Kind != "" && !questionKinds[row.Kind] {
			httpx.BadRequest(w, r, "kind is not a recognised value")
			return
		}
		if row.SyllabusUnitID != "" {
			if _, err := uuid.Parse(row.SyllabusUnitID); err != nil {
				httpx.BadRequest(w, r, "syllabus_unit_id must be a uuid")
				return
			}
		}
		if row.Count < 1 || row.Count > blueprintMaxPerRow {
			httpx.BadRequest(w, r, "each row asks for between 1 and 50 questions")
			return
		}
		if row.Marks < 0 {
			httpx.BadRequest(w, r, "marks cannot be negative")
			return
		}
	}

	// Scope is resolved after the body is checked, so a malformed blueprint
	// is refused without a database round trip.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out := composedPaper{Sections: []composedSection{}}
	err = s.DB.InTenant(r.Context(), tenantScope(httpx.IdentityFrom(r.Context())), func(tx pgx.Tx) error {
		ok, err := classSubjectTaught(r.Context(), tx, res, csID)
		if err != nil {
			return err
		}
		if !ok {
			return errNotTaught
		}
		// Drawn once per row, excluding what earlier rows took, so a question
		// cannot appear twice on one paper however the rows overlap.
		taken := []uuid.UUID{}
		for _, row := range req.Rows {
			args := []any{csID, taken, row.Count}
			where := "q.class_subject_id = $1 AND q.is_active AND NOT (q.id = ANY($2))"
			if row.Difficulty != "" {
				args = append(args, row.Difficulty)
				where += " AND q.difficulty = $" + itoa(len(args))
			}
			if row.Kind != "" {
				args = append(args, row.Kind)
				where += " AND q.kind = $" + itoa(len(args))
			}
			if row.SyllabusUnitID != "" {
				args = append(args, row.SyllabusUnitID)
				where += " AND q.syllabus_unit_id = $" + itoa(len(args))
			}
			if row.Marks > 0 {
				args = append(args, row.Marks)
				where += " AND q.default_marks = $" + itoa(len(args))
			}
			rows, err := tx.Query(r.Context(), `
				SELECT q.id, q.stem, q.kind, q.difficulty, q.bloom_level, su.title,
				       q.default_marks::float8,
				       COALESCE((SELECT array_agg(o.body ORDER BY o.sequence)
				                   FROM question_bank_options o WHERE o.question_id = q.id), '{}')
				  FROM question_bank_questions q
				  LEFT JOIN syllabus_units su ON su.id = q.syllabus_unit_id
				 WHERE `+where+`
				 ORDER BY random()
				 LIMIT $3`, args...)
			if err != nil {
				return err
			}
			sec := composedSection{Row: row, Wanted: row.Count, Questions: []composedQuestion{}}
			for rows.Next() {
				var q composedQuestion
				var id uuid.UUID
				if err := rows.Scan(&id, &q.Stem, &q.Kind, &q.Difficulty, &q.BloomLevel,
					&q.Chapter, &q.Marks, &q.Options); err != nil {
					rows.Close()
					return err
				}
				q.ID = id.String()
				taken = append(taken, id)
				sec.Questions = append(sec.Questions, q)
				out.TotalMarks += q.Marks
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
			sec.Found = len(sec.Questions)
			out.Questions += sec.Found
			out.Short += sec.Wanted - sec.Found
			out.Sections = append(out.Sections, sec)
		}
		return nil
	})
	if err == errNotTaught {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
