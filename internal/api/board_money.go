package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* WHERE THE MONEY GOES, BY CAMPUS.

   The finance dashboard answers "how is the desk doing today" for one campus
   at a time, in the operator's terms: today's drawer, unreconciled gateway
   money, refunds waiting. A board member asks a different question of the
   same tables — over a period, for every campus, what came in, what is still
   owed, what went out on salaries, and for how many people — and asks it
   maybe four times a year. So this is its own read, grouped by campus, and
   nothing on it can be changed from the screen that shows it.

   PAYROLL IS BY THE EMPLOYEE'S CAMPUS, not the run's: a payroll run has no
   campus (one run pays the whole school), so a payslip is attributed through
   the person it paid. A run counts when its month falls inside the period.
   Employees with no campus land under "Unassigned" rather than vanishing —
   a board that cannot see 6 lakh of salaries because six people have no
   campus set is a board with a hole in its numbers. */

type campusMoney struct {
	CampusID         *string `json:"campus_id"`
	Campus           string  `json:"campus"`
	CollectedPaise   int64   `json:"collected_paise"`
	OutstandingPaise int64   `json:"outstanding_paise"`
	OverduePaise     int64   `json:"overdue_paise"`
	PayrollPaise     int64   `json:"payroll_paise"`
	Students         int     `json:"students"`
	Staff            int     `json:"staff"`
}

type boardMoney struct {
	Range    dateRange     `json:"range"`
	Campuses []campusMoney `json:"campuses"`
	Total    campusMoney   `json:"total"`
}

func (s *Server) mountBoard(r chi.Router) {
	// Both keys, because the sheet shows both kinds of money. A role with one
	// and not the other is not a board and should not see half a picture.
	r.With(httpx.RequirePermission(rbac.InvoicesRead), httpx.RequirePermission(rbac.PayrollRead)).
		Get("/board/money", s.getBoardMoney)
}

func (s *Server) getBoardMoney(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	rng := resolveRange(r)
	out := boardMoney{Range: rng, Campuses: []campusMoney{}}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			WITH c AS (
			  SELECT id, name FROM campuses
			  UNION ALL SELECT NULL::uuid, 'Unassigned'
			)
			SELECT c.id::text, c.name,
			  COALESCE((SELECT sum(p.amount_paise) FROM payments p
			             WHERE p.campus_id IS NOT DISTINCT FROM c.id
			               AND p.status = 'success' AND p.mode <> 'adjustment'
			               AND p.paid_on::date BETWEEN $1::date AND $2::date), 0),
			  COALESCE((SELECT sum(i.net_paise - i.paid_paise) FROM invoices i
			             WHERE i.campus_id IS NOT DISTINCT FROM c.id
			               AND i.status IN ('unpaid','partial','overdue')), 0),
			  COALESCE((SELECT sum(i.net_paise - i.paid_paise) FROM invoices i
			             WHERE i.campus_id IS NOT DISTINCT FROM c.id
			               AND i.status IN ('unpaid','partial','overdue')
			               AND i.due_on IS NOT NULL AND i.due_on < CURRENT_DATE), 0),
			  COALESCE((SELECT sum(ps.net_paise) FROM payslips ps
			             JOIN employees e ON e.id = ps.employee_id
			             JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
			             WHERE e.campus_id IS NOT DISTINCT FROM c.id
			               AND make_date(pr.period_year, pr.period_month, 1)
			                   BETWEEN date_trunc('month', $1::date)::date
			                       AND date_trunc('month', $2::date)::date), 0),
			  (SELECT count(*) FROM students st
			    WHERE st.campus_id IS NOT DISTINCT FROM c.id AND st.status = 'active'),
			  (SELECT count(*) FROM employees e
			    WHERE e.campus_id IS NOT DISTINCT FROM c.id AND e.status = 'active')
			FROM c
			ORDER BY c.id IS NULL, c.name`, rng.FromS, rng.ToS)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var m campusMoney
			if err := rows.Scan(&m.CampusID, &m.Campus, &m.CollectedPaise, &m.OutstandingPaise,
				&m.OverduePaise, &m.PayrollPaise, &m.Students, &m.Staff); err != nil {
				return err
			}
			/* "Unassigned" is shown only when it holds something. An empty
			   row for a campus nobody has would be a question on every
			   board's sheet about a problem it does not have. */
			if m.CampusID == nil && m.CollectedPaise == 0 && m.OutstandingPaise == 0 &&
				m.PayrollPaise == 0 && m.Students == 0 && m.Staff == 0 {
				continue
			}
			out.Campuses = append(out.Campuses, m)
			out.Total.CollectedPaise += m.CollectedPaise
			out.Total.OutstandingPaise += m.OutstandingPaise
			out.Total.OverduePaise += m.OverduePaise
			out.Total.PayrollPaise += m.PayrollPaise
			out.Total.Students += m.Students
			out.Total.Staff += m.Staff
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out.Total.Campus = "All campuses"
	httpx.JSON(w, http.StatusOK, out)
}
