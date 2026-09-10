package api

/* TERM DATES, WHICH THE CALENDAR SHOWED AND NOTHING COULD CREATE.

   The School Calendar screen draws three things as one dated sequence: the
   holiday list, the exam board, and the term dates. Holidays it can write.
   Exams belong to the exam board and are edited there. Terms it could only
   ever display -- there is no INSERT INTO terms anywhere in this codebase,
   and never has been.

   The comment beside the read endpoint says "terms has been in the schema
   from the beginning with nothing reading it". That was the wrong diagnosis
   of the right smell: a co-scholastic grade belongs to a term and a report
   card is filed under one, so things did want to read it. Nothing could fill
   it, so every school has an empty table and every screen that needs a term
   silently has none to offer.

   Deleting is refused in words rather than by foreign key, because a term
   with marks under it is a term somebody is using.
*/

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

// --- terms ------------------------------------------------------------------

type calendarTerm struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	StartsOn string `json:"starts_on"`
	EndsOn   string `json:"ends_on"`
	Sequence int    `json:"sequence"`
	Year     string `json:"academic_year"`
	Current  bool   `json:"is_current"`
}

func (s *Server) listTermsFull(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	items, err := collect(s, r, `
		SELECT t.id::text, t.name, to_char(t.starts_on,'YYYY-MM-DD'),
		       to_char(t.ends_on,'YYYY-MM-DD'), t.sequence, ay.name,
		       (CURRENT_DATE BETWEEN t.starts_on AND t.ends_on)
		  FROM terms t
		  JOIN academic_years ay ON ay.id = t.academic_year_id
		 ORDER BY ay.starts_on DESC, t.sequence`, nil,
		func(rows pgx.Rows) (calendarTerm, error) {
			var v calendarTerm
			return v, rows.Scan(&v.ID, &v.Name, &v.StartsOn, &v.EndsOn,
				&v.Sequence, &v.Year, &v.Current)
		})
	respond(w, r, items, err)
}

type termRequest struct {
	Name     string `json:"name"`
	StartsOn string `json:"starts_on"`
	EndsOn   string `json:"ends_on"`
	Sequence int    `json:"sequence,omitempty"`
}

func (s *Server) saveTerm(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req termRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || req.StartsOn == "" || req.EndsOn == "" {
		httpx.BadRequest(w, r, "a name, a start date and an end date are required")
		return
	}
	if req.Sequence <= 0 {
		req.Sequence = 1
	}
	editing := chiURLParam(r, "id")

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if editing != "" {
			tag, err := tx.Exec(r.Context(), `
				UPDATE terms SET name = $2, starts_on = $3::date, ends_on = $4::date,
				                 sequence = $5
				 WHERE id = $1`,
				editing, req.Name, req.StartsOn, req.EndsOn, req.Sequence)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errRefGone
			}
			newID = editing
			return nil
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO terms (institution_id, academic_year_id, name, starts_on,
			                   ends_on, sequence)
			VALUES ($1,
			        (SELECT id FROM academic_years WHERE is_current LIMIT 1),
			        $2, $3::date, $4::date, $5)
			RETURNING id::text`,
			id.InstitutionID, req.Name, req.StartsOn, req.EndsOn, req.Sequence).Scan(&newID)
	})
	if errors.Is(err, errRefGone) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		// ends_on > starts_on is a database constraint; the message it gives is
		// not one to hand a person.
		if strings.Contains(err.Error(), "terms_check") {
			httpx.BadRequest(w, r, "a term has to end after it starts")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	status := http.StatusCreated
	if editing != "" {
		status = http.StatusOK
	}
	httpx.JSON(w, status, map[string]any{"id": newID})
}

func (s *Server) deleteTerm(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	termID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid term id")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `DELETE FROM terms WHERE id = $1`, termID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errRefGone
		}
		return nil
	})
	if errors.Is(err, errRefGone) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		/* A term something has been filed under cannot simply vanish, and the
		   database says so with a foreign key. What a person needs to hear is
		   which thing is holding it. */
		if strings.Contains(err.Error(), "violates foreign key") {
			httpx.Error(w, r, http.StatusConflict, "term_in_use",
				"marks or grades are filed under this term, so it cannot be removed. "+
					"Change its dates instead.")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
