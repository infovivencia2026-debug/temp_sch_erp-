package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Saying a month is finished.

   The product had five freeze mechanisms and none of them covered the things
   a school is asked about: the register, the fee counter, the payslip, the
   mark sheet. Any past month stayed editable until the accounting year was
   signed, and the academic year never was -- so "show me last March" got a
   different answer in June from the one it got in April, and nobody could
   say when it changed.

   A close is a decision, not a side effect, so it is a row somebody wrote:
   who, when, and -- because a close is sometimes wrong -- who reopened it.
   The guard below is the whole of the enforcement. It is called from the
   handlers that write dated records, inside their transaction, and refuses
   with a plain sentence naming the month and the person who can open it. */

// periodClosedError is what requireOpenPeriod returns. Handlers map it to a
// 409 through periodClosed(); the message is already fit to show.
type periodClosedError struct{ msg string }

func (e *periodClosedError) Error() string { return e.msg }

// periodClosed writes the 409 for a closed period and reports whether it did,
// so a handler's error tail reads `if periodClosed(w, r, err) { return }`.
func periodClosed(w http.ResponseWriter, r *http.Request, err error) bool {
	var pc *periodClosedError
	if !errors.As(err, &pc) {
		return false
	}
	httpx.Error(w, r, http.StatusConflict, "period_closed", pc.msg)
	return true
}

// requireOpenPeriod refuses a write dated inside a closed period.
//
// kind is "month" or "year". A month is closed when it has a live close of
// its own or when the academic year containing the date is closed -- closing
// a year closes every month in it, and a month that was never closed by hand
// is still shut once its year is. A year check ignores month rows: marks and
// invoices belong to a year, not a month, and a closed October must not stop
// a teacher entering a paper set in November.
func (s *Server) requireOpenPeriod(ctx context.Context, tx pgx.Tx, inst uuid.UUID, kind string, on time.Time) error {
	if kind != "month" && kind != "year" {
		return fmt.Errorf("requireOpenPeriod: unknown kind %q", kind)
	}
	key := on.Format("2006-01")
	var monthClosed bool
	var yearName *string
	err := tx.QueryRow(ctx, `
		SELECT $4 = 'month' AND EXISTS (
		         SELECT 1 FROM period_closes
		          WHERE institution_id = $1 AND kind = 'month'
		            AND period_key = $2 AND reopened_at IS NULL),
		       (SELECT name FROM academic_years
		         WHERE institution_id = $1 AND closed_at IS NOT NULL
		           AND $3::date BETWEEN starts_on AND ends_on
		         ORDER BY starts_on DESC LIMIT 1)`,
		inst, key, on.Format(time.DateOnly), kind).Scan(&monthClosed, &yearName)
	if err != nil {
		return err
	}
	if monthClosed {
		return &periodClosedError{msg: on.Format("January 2006") +
			" is closed; ask the principal to reopen it"}
	}
	if yearName != nil {
		return &periodClosedError{msg: "The year " + *yearName +
			" is closed; ask the principal to reopen it"}
	}
	return nil
}

// requireOpenYear is the same refusal for a write that knows its academic
// year by id rather than by date: an exam's marks, a fee structure's invoices.
func (s *Server) requireOpenYear(ctx context.Context, tx pgx.Tx, yearID uuid.UUID) error {
	var name string
	var closed bool
	err := tx.QueryRow(ctx,
		`SELECT name, closed_at IS NOT NULL FROM academic_years WHERE id = $1`, yearID).
		Scan(&name, &closed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if closed {
		return &periodClosedError{msg: "The year " + name +
			" is closed; ask the principal to reopen it"}
	}
	return nil
}

// --- the principal's screen ------------------------------------------------

type periodMonth struct {
	Key      string  `json:"key"`
	Label    string  `json:"label"`
	Closed   bool    `json:"closed"`
	ViaYear  bool    `json:"via_year"`
	ClosedAt *string `json:"closed_at,omitempty"`
	ClosedBy *string `json:"closed_by,omitempty"`
	// A month that has not started yet has nothing to close; the screen
	// shows it without a button.
	Future bool `json:"future"`
}

type periodYear struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	StartsOn string  `json:"starts_on"`
	EndsOn   string  `json:"ends_on"`
	Current  bool    `json:"is_current"`
	Closed   bool    `json:"closed"`
	ClosedAt *string `json:"closed_at,omitempty"`
	ClosedBy *string `json:"closed_by,omitempty"`
}

func (s *Server) mountPeriodClose(r chi.Router) {
	r.With(httpx.RequirePermission(rbac.InstitutionRead)).Get("/period-closes", s.listPeriodCloses)
	// Closing a month is the head's decision: it is the settings permission,
	// not the fee clerk's or the exam controller's, because what becomes
	// read-only crosses every module.
	r.With(httpx.RequirePermission(rbac.SettingsWrite)).Post("/period-closes/close", s.closePeriod)
	r.With(httpx.RequirePermission(rbac.SettingsWrite)).Post("/period-closes/reopen", s.reopenPeriod)
}

// listPeriodCloses is one academic year, month by month, with each month's
// state. Defaults to the current year; ?academic_year_id= picks another.
func (s *Server) listPeriodCloses(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var yearID *uuid.UUID
	if raw := strings.TrimSpace(r.URL.Query().Get("academic_year_id")); raw != "" {
		v, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "academic_year_id must be a uuid")
			return
		}
		yearID = &v
	}

	var year periodYear
	var years []periodYear
	var months []periodMonth
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT ay.id::text, ay.name,
			       to_char(ay.starts_on, 'YYYY-MM-DD'), to_char(ay.ends_on, 'YYYY-MM-DD'),
			       ay.is_current, ay.closed_at IS NOT NULL,
			       to_char(ay.closed_at, 'YYYY-MM-DD'),
			       (SELECT u.full_name FROM users u WHERE u.id = ay.closed_by)
			  FROM academic_years ay
			 WHERE ay.institution_id = $1
			 ORDER BY ay.starts_on DESC`, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var y periodYear
			if err := rows.Scan(&y.ID, &y.Name, &y.StartsOn, &y.EndsOn, &y.Current,
				&y.Closed, &y.ClosedAt, &y.ClosedBy); err != nil {
				return err
			}
			years = append(years, y)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for _, y := range years {
			if (yearID != nil && y.ID == yearID.String()) || (yearID == nil && y.Current) {
				year = y
			}
		}
		if year.ID == "" {
			if len(years) == 0 {
				return nil
			}
			year = years[0]
		}

		live := map[string]periodMonth{}
		crows, err := tx.Query(r.Context(), `
			SELECT pc.period_key, pc.via_year IS NOT NULL,
			       to_char(pc.closed_at, 'YYYY-MM-DD'),
			       (SELECT u.full_name FROM users u WHERE u.id = pc.closed_by)
			  FROM period_closes pc
			 WHERE pc.institution_id = $1 AND pc.kind = 'month' AND pc.reopened_at IS NULL`,
			id.InstitutionID)
		if err != nil {
			return err
		}
		defer crows.Close()
		for crows.Next() {
			var m periodMonth
			if err := crows.Scan(&m.Key, &m.ViaYear, &m.ClosedAt, &m.ClosedBy); err != nil {
				return err
			}
			m.Closed = true
			live[m.Key] = m
		}
		if err := crows.Err(); err != nil {
			return err
		}

		starts, _ := time.Parse(time.DateOnly, year.StartsOn)
		ends, _ := time.Parse(time.DateOnly, year.EndsOn)
		now := time.Now()
		for d := time.Date(starts.Year(), starts.Month(), 1, 0, 0, 0, 0, time.UTC); !d.After(ends); d = d.AddDate(0, 1, 0) {
			key := d.Format("2006-01")
			m, ok := live[key]
			if !ok {
				m = periodMonth{Key: key}
			}
			m.Label = d.Format("January 2006")
			m.Future = d.After(now)
			months = append(months, m)
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if months == nil {
		months = []periodMonth{}
	}
	if years == nil {
		years = []periodYear{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"year": year, "years": years, "months": months,
	})
}

type periodCloseRequest struct {
	Kind      string `json:"kind"`       // month | year
	PeriodKey string `json:"period_key"` // YYYY-MM, or the academic year id
}

func (s *Server) readPeriodRequest(w http.ResponseWriter, r *http.Request) (periodCloseRequest, bool) {
	var req periodCloseRequest
	if !httpx.Decode(w, r, &req) {
		return req, false
	}
	req.Kind = strings.TrimSpace(req.Kind)
	req.PeriodKey = strings.TrimSpace(req.PeriodKey)
	switch req.Kind {
	case "month":
		if _, err := time.Parse("2006-01", req.PeriodKey); err != nil {
			httpx.BadRequest(w, r, "period_key must be YYYY-MM for a month")
			return req, false
		}
	case "year":
		if _, err := uuid.Parse(req.PeriodKey); err != nil {
			httpx.BadRequest(w, r, "period_key must be the academic year's id for a year")
			return req, false
		}
	default:
		httpx.BadRequest(w, r, "kind must be month or year")
		return req, false
	}
	return req, true
}

var errPeriodState = errors.New("period is already in that state")

// closePeriod shuts a month, or a year and every month in it.
func (s *Server) closePeriod(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	req, ok := s.readPeriodRequest(w, r)
	if !ok {
		return
	}
	var closedMonths int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.Kind == "month" {
			tag, err := tx.Exec(r.Context(), `
				INSERT INTO period_closes (institution_id, kind, period_key, closed_by)
				SELECT $1, 'month', $2, $3
				 WHERE NOT EXISTS (SELECT 1 FROM period_closes
				                    WHERE institution_id = $1 AND kind = 'month'
				                      AND period_key = $2 AND reopened_at IS NULL)`,
				id.InstitutionID, req.PeriodKey, id.UserID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errPeriodState
			}
			closedMonths = 1
			return nil
		}

		yearID := uuid.MustParse(req.PeriodKey)
		var starts, ends time.Time
		err := tx.QueryRow(r.Context(), `
			UPDATE academic_years SET closed_at = now(), closed_by = $2
			 WHERE id = $1 AND institution_id = $3 AND closed_at IS NULL
			 RETURNING starts_on, ends_on`, yearID, id.UserID, id.InstitutionID).
			Scan(&starts, &ends)
		if errors.Is(err, pgx.ErrNoRows) {
			var exists bool
			if qerr := tx.QueryRow(r.Context(),
				`SELECT EXISTS (SELECT 1 FROM academic_years WHERE id = $1)`, yearID).
				Scan(&exists); qerr != nil {
				return qerr
			}
			if !exists {
				return pgx.ErrNoRows
			}
			return errPeriodState
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO period_closes (institution_id, kind, period_key, closed_by)
			VALUES ($1, 'year', $2, $3)`,
			id.InstitutionID, yearID.String(), id.UserID); err != nil {
			return err
		}
		/* Every month of the year, in one statement.

		   A month the principal closed by hand earlier is left as it is --
		   its row already says who closed it and when, and the year close
		   should not overwrite that. The rest are marked via_year so that
		   reopening the year opens exactly what the year close shut. */
		tag, err := tx.Exec(r.Context(), `
			INSERT INTO period_closes (institution_id, kind, period_key, via_year, closed_by)
			SELECT $1, 'month', to_char(m, 'YYYY-MM'), $2, $3
			  FROM generate_series(date_trunc('month', $4::date), $5::date, interval '1 month') AS m
			 WHERE NOT EXISTS (SELECT 1 FROM period_closes pc
			                    WHERE pc.institution_id = $1 AND pc.kind = 'month'
			                      AND pc.period_key = to_char(m, 'YYYY-MM')
			                      AND pc.reopened_at IS NULL)`,
			id.InstitutionID, yearID, id.UserID, starts, ends)
		if err != nil {
			return err
		}
		closedMonths = int(tag.RowsAffected())
		return nil
	})
	if errors.Is(err, errPeriodState) {
		httpx.Error(w, r, http.StatusConflict, "already_closed", "That period is already closed.")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"kind": req.Kind, "period_key": req.PeriodKey, "closed": true,
		"months_closed": closedMonths,
	})
}

// reopenPeriod is the correction path. A reopened month keeps its close row;
// the audit trail shows both the close and the person who undid it.
func (s *Server) reopenPeriod(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	req, ok := s.readPeriodRequest(w, r)
	if !ok {
		return
	}
	var reopenedMonths int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.Kind == "month" {
			/* A month shut by its year cannot be opened on its own.

			   The year is the stronger statement: reopening October inside a
			   closed 2026-27 would leave the year saying "final" and one of its
			   months saying otherwise. The principal reopens the year, does
			   what is needed, and closes it again. */
			var viaYear bool
			err := tx.QueryRow(r.Context(), `
				SELECT via_year IS NOT NULL FROM period_closes
				 WHERE institution_id = $1 AND kind = 'month'
				   AND period_key = $2 AND reopened_at IS NULL`,
				id.InstitutionID, req.PeriodKey).Scan(&viaYear)
			if errors.Is(err, pgx.ErrNoRows) {
				return errPeriodState
			}
			if err != nil {
				return err
			}
			if viaYear {
				return errMonthInClosedYear
			}
			tag, err := tx.Exec(r.Context(), `
				UPDATE period_closes SET reopened_at = now(), reopened_by = $3
				 WHERE institution_id = $1 AND kind = 'month'
				   AND period_key = $2 AND reopened_at IS NULL`,
				id.InstitutionID, req.PeriodKey, id.UserID)
			if err != nil {
				return err
			}
			reopenedMonths = int(tag.RowsAffected())
			return nil
		}

		yearID := uuid.MustParse(req.PeriodKey)
		tag, err := tx.Exec(r.Context(), `
			UPDATE academic_years SET closed_at = NULL, closed_by = NULL
			 WHERE id = $1 AND institution_id = $2 AND closed_at IS NOT NULL`,
			yearID, id.InstitutionID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errPeriodState
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE period_closes SET reopened_at = now(), reopened_by = $3
			 WHERE institution_id = $1 AND kind = 'year'
			   AND period_key = $2 AND reopened_at IS NULL`,
			id.InstitutionID, yearID.String(), id.UserID); err != nil {
			return err
		}
		mtag, err := tx.Exec(r.Context(), `
			UPDATE period_closes SET reopened_at = now(), reopened_by = $3
			 WHERE institution_id = $1 AND kind = 'month'
			   AND via_year = $2 AND reopened_at IS NULL`,
			id.InstitutionID, yearID, id.UserID)
		if err != nil {
			return err
		}
		reopenedMonths = int(mtag.RowsAffected())
		return nil
	})
	if errors.Is(err, errPeriodState) {
		httpx.Error(w, r, http.StatusConflict, "not_closed", "That period is not closed.")
		return
	}
	if errors.Is(err, errMonthInClosedYear) {
		httpx.Error(w, r, http.StatusConflict, "year_closed",
			"That month was closed with its year. Reopen the year instead.")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"kind": req.Kind, "period_key": req.PeriodKey, "closed": false,
		"months_reopened": reopenedMonths,
	})
}

var errMonthInClosedYear = errors.New("month closed by its year")
