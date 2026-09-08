package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
The working year.

	academic_years_one_current is right and stays: one year is being taught,
	and attendance, meals, the day's fee counter and the principal's
	dashboard belong to it. What the flag cannot express is that from
	November a school is also running next year -- admissions, sections, the
	fee structure, the timetable draft, the council -- and every handler that
	resolved "the year" with WHERE is_current answered those questions about
	this year instead.

	So handlers a school uses across the boundary ask here instead. The
	answer, in order: a year the call names itself (a body field or the
	academic_year_id query parameter), the year this person chose for
	themselves (user_working_years), and only then the current one. Nobody
	who has chosen nothing sees anything change.

	The reporting layer's rollupYear already takes an explicit year; this is
	the same idea made available to the writes.
*/

var errUnknownYear = errors.New("academic_year_id names no academic year of this school")

// workingYear resolves the year a request works in, honouring only the
// academic_year_id query parameter as the explicit form. Handlers whose year
// arrives in a body use workingYearOr.
func (s *Server) workingYear(ctx context.Context, tx pgx.Tx, r *http.Request) (uuid.UUID, error) {
	return s.workingYearOr(ctx, tx, r, "")
}

// workingYearOr is workingYear with a year the handler already parsed out of
// its body taking precedence over everything.
func (s *Server) workingYearOr(ctx context.Context, tx pgx.Tx, r *http.Request, explicit string) (uuid.UUID, error) {
	explicit = strings.TrimSpace(explicit)
	if explicit == "" && r != nil {
		explicit = strings.TrimSpace(r.URL.Query().Get("academic_year_id"))
	}
	return workingYearIn(ctx, tx, explicit)
}

// workingYearSQL is the same fallback chain as a SQL expression, for the read
// handlers that run through collect and hold no transaction to ask. userParam
// is the placeholder carrying the caller's user id, e.g. "$2".
func workingYearSQL(userParam string) string {
	return `COALESCE(
	          (SELECT y.id FROM user_working_years w
	             JOIN academic_years y ON y.id = w.academic_year_id
	            WHERE w.user_id = ` + userParam + `::uuid),
	          (SELECT id FROM academic_years
	            ORDER BY is_current DESC, starts_on DESC LIMIT 1))`
}

// workingYearIn is the resolver itself. The caller's identity travels in ctx,
// so the free functions that predate this (resolveYear, boardAcademicYear)
// can ask without holding the request.
func workingYearIn(ctx context.Context, tx pgx.Tx, explicit string) (uuid.UUID, error) {
	explicit = strings.TrimSpace(explicit)
	if explicit != "" {
		want, err := uuid.Parse(explicit)
		if err != nil {
			return uuid.Nil, errUnknownYear
		}
		/* Checked rather than trusted: the transaction is tenant-scoped, so a
		   year of another school reads as absent here, and a foreign-key
		   failure deep inside an insert is a worse message than this one. */
		var id uuid.UUID
		err = tx.QueryRow(ctx, `SELECT id FROM academic_years WHERE id = $1`, want).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, errUnknownYear
		}
		return id, err
	}

	var id uuid.UUID
	if ident := httpx.IdentityFrom(ctx); ident != nil && ident.UserID != uuid.Nil {
		// The join is what makes a stale choice harmless: the row cascades
		// away with its year, but a year deleted in another transaction a
		// moment ago must not be handed out either.
		err := tx.QueryRow(ctx, `
			SELECT y.id FROM user_working_years w
			  JOIN academic_years y ON y.id = w.academic_year_id
			 WHERE w.user_id = $1`, ident.UserID).Scan(&id)
		if err == nil {
			return id, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, err
		}
	}
	// Defensive ordering, as rollupYear: a school that never set the flag
	// still gets its latest year rather than nothing.
	err := tx.QueryRow(ctx, `
		SELECT id FROM academic_years
		 ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&id)
	return id, err
}

// --- the switcher's endpoint --------------------------------------------------

type workingYearRow struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	StartsOn  string `json:"starts_on"`
	EndsOn    string `json:"ends_on"`
	IsCurrent bool   `json:"is_current"`
	// Open is whether the switcher should offer the year at all. A year that
	// has ended is history and belongs to the reports, not to a working
	// choice; the current year is open whatever its dates say, because a
	// school that opened late must still be able to come back to it.
	Open bool `json:"open"`
}

/*
getWorkingYear tells the client which year this person works in, and which
years there are to choose from.

	One call rather than two, because the shell asks on every load and the
	answer to "should the switcher show at all" is the same query.
*/
func (s *Server) getWorkingYear(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := map[string]any{"academic_year_id": nil, "chosen": false, "years": []workingYearRow{}}
	if id.InstitutionID == uuid.Nil {
		// Platform staff outside a school have no year to work in.
		httpx.JSON(w, http.StatusOK, out)
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT id::text, name, to_char(starts_on,'YYYY-MM-DD'),
			       to_char(ends_on,'YYYY-MM-DD'), is_current,
			       (is_current OR ends_on >= CURRENT_DATE)
			  FROM academic_years ORDER BY starts_on DESC`)
		if err != nil {
			return err
		}
		years := []workingYearRow{}
		for rows.Next() {
			var y workingYearRow
			if err := rows.Scan(&y.ID, &y.Name, &y.StartsOn, &y.EndsOn, &y.IsCurrent, &y.Open); err != nil {
				rows.Close()
				return err
			}
			years = append(years, y)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		out["years"] = years

		var chosen uuid.UUID
		err = tx.QueryRow(r.Context(), `
			SELECT y.id FROM user_working_years w
			  JOIN academic_years y ON y.id = w.academic_year_id
			 WHERE w.user_id = $1`, id.UserID).Scan(&chosen)
		switch {
		case err == nil:
			out["academic_year_id"] = chosen.String()
			out["chosen"] = true
			return nil
		case errors.Is(err, pgx.ErrNoRows):
		default:
			return err
		}
		year, err := s.workingYear(r.Context(), tx, r)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		out["academic_year_id"] = year.String()
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

/*
setWorkingYear records the choice, or clears it.

	An empty academic_year_id is "back to the current year" and deletes the
	row rather than storing the current year's id: a stored id would outlive
	the flag moving in April and pin the person to what had become last year.
*/
func (s *Server) setWorkingYear(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	var req struct {
		AcademicYearID string `json:"academic_year_id"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	want := strings.TrimSpace(req.AcademicYearID)
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if want == "" {
			_, err := tx.Exec(r.Context(),
				`DELETE FROM user_working_years WHERE user_id = $1`, id.UserID)
			return err
		}
		year, err := s.workingYearOr(r.Context(), tx, nil, want)
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			INSERT INTO user_working_years (user_id, institution_id, academic_year_id, updated_at)
			VALUES ($1, $2, $3, now())
			ON CONFLICT (user_id, institution_id)
			DO UPDATE SET academic_year_id = EXCLUDED.academic_year_id, updated_at = now()`,
			id.UserID, id.InstitutionID, year)
		return err
	})
	if errors.Is(err, errUnknownYear) {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.getWorkingYear(w, r)
}
