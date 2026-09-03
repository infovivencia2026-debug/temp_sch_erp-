package api

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* IS ANYBODY READING WHAT THE SCHOOL PAYS FOR.

   The digital catalogue lists holdings and lends the single-copy ones; it
   never knew whether a title was opened. Now every open through this product
   leaves one row (digital_holding_opens), and this reads them back two ways:
   the last few months as a line — opens and distinct readers each month — and
   every holding with its opens this month against last month, so the title
   nobody has touched since the subscription was renewed is visible.

   Only opens made here are counted. A vendor's own portal keeps its own
   figures and nothing on this screen pretends to know them. */

type usageMonth struct {
	Month   string `json:"month"` // YYYY-MM
	Opens   int    `json:"opens"`
	Readers int    `json:"readers"`
}

type usageHolding struct {
	ID               string  `json:"id"`
	Title            string  `json:"title"`
	Kind             string  `json:"kind"`
	AccessModel      string  `json:"access_model"`
	IsActive         bool    `json:"is_active"`
	OpensThisMonth   int     `json:"opens_this_month"`
	OpensLastMonth   int     `json:"opens_last_month"`
	ReadersThisMonth int     `json:"readers_this_month"`
	OpensTotal       int     `json:"opens_total"`
	LastOpenedAt     *string `json:"last_opened_at,omitempty"`
}

type digitalUsage struct {
	Months         []usageMonth   `json:"months"`
	Holdings       []usageHolding `json:"holdings"`
	ActiveReaders  int            `json:"active_readers"` // distinct readers, this month
	OpensThisMonth int            `json:"opens_this_month"`
	OpensLastMonth int            `json:"opens_last_month"`
}

// usageMonthKeys lists the n month keys ending at now's month, oldest first,
// so a month with no opens is still a point on the line rather than a gap
// the eye reads as "the chart skipped a month".
func usageMonthKeys(now time.Time, n int) []string {
	if n < 1 {
		n = 1
	}
	first := time.Date(now.Year(), now.Month()-time.Month(n-1), 1, 0, 0, 0, 0, time.UTC)
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, first.AddDate(0, i, 0).Format("2006-01"))
	}
	return out
}

// usageMonthsParam bounds ?months= to something a screen can draw. Six is
// what "how is engagement moving" needs; two years is the most a subscription
// review looks back.
func usageMonthsParam(raw string) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 2 {
		return 6
	}
	if n > 24 {
		return 24
	}
	return n
}

// logDigitalOpen records one open. Called inside the open's own transaction so
// a redirect that was handed out is a row that exists, and vice versa.
func logDigitalOpen(ctx context.Context, tx pgx.Tx, inst, holding, user uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO digital_holding_opens (institution_id, holding_id, user_id)
		VALUES ($1, $2, $3)`, inst, holding, nullUUIDArg(user))
	return err
}

func (s *Server) getDigitalUsage(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	n := usageMonthsParam(r.URL.Query().Get("months"))
	keys := usageMonthKeys(time.Now(), n)
	byMonth := map[string]*usageMonth{}
	out := digitalUsage{Months: make([]usageMonth, 0, n), Holdings: []usageHolding{}}
	for _, k := range keys {
		out.Months = append(out.Months, usageMonth{Month: k})
	}
	for i := range out.Months {
		byMonth[out.Months[i].Month] = &out.Months[i]
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT to_char(opened_at, 'YYYY-MM'), count(*)::int,
			       count(DISTINCT user_id)::int
			  FROM digital_holding_opens
			 WHERE opened_at >= date_trunc('month', now()) - ($1::int - 1) * interval '1 month'
			 GROUP BY 1`, n)
		if err != nil {
			return err
		}
		for rows.Next() {
			var k string
			var opens, readers int
			if err := rows.Scan(&k, &opens, &readers); err != nil {
				rows.Close()
				return err
			}
			if m := byMonth[k]; m != nil {
				m.Opens, m.Readers = opens, readers
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			SELECT count(DISTINCT user_id) FILTER (WHERE opened_at >= date_trunc('month', now()))::int,
			       count(*) FILTER (WHERE opened_at >= date_trunc('month', now()))::int,
			       count(*) FILTER (WHERE opened_at <  date_trunc('month', now()))::int
			  FROM digital_holding_opens
			 WHERE opened_at >= date_trunc('month', now()) - interval '1 month'`).
			Scan(&out.ActiveReaders, &out.OpensThisMonth, &out.OpensLastMonth); err != nil {
			return err
		}

		rows, err = tx.Query(r.Context(), `
			SELECT h.id::text, h.title, h.kind, h.access_model, h.is_active,
			       COALESCE(o.this_month, 0), COALESCE(o.last_month, 0),
			       COALESCE(o.readers, 0), COALESCE(o.total, 0),
			       to_char(o.last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
			  FROM digital_holdings h
			  LEFT JOIN LATERAL (
			    SELECT count(*) FILTER (WHERE opened_at >= date_trunc('month', now()))::int AS this_month,
			           count(*) FILTER (WHERE opened_at >= date_trunc('month', now()) - interval '1 month'
			                              AND opened_at <  date_trunc('month', now()))::int AS last_month,
			           count(DISTINCT user_id) FILTER (WHERE opened_at >= date_trunc('month', now()))::int AS readers,
			           count(*)::int AS total,
			           max(opened_at) AS last_at
			      FROM digital_holding_opens x WHERE x.holding_id = h.id
			  ) o ON true
			 ORDER BY COALESCE(o.this_month, 0) DESC, COALESCE(o.total, 0) DESC, h.title`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var h usageHolding
			if err := rows.Scan(&h.ID, &h.Title, &h.Kind, &h.AccessModel, &h.IsActive,
				&h.OpensThisMonth, &h.OpensLastMonth, &h.ReadersThisMonth, &h.OpensTotal,
				&h.LastOpenedAt); err != nil {
				return err
			}
			out.Holdings = append(out.Holdings, h)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
