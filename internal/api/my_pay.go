package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What a member of staff is owed, and what they were paid.

   Payroll existed only as the payroll office's screen: one list of everybody,
   behind finance.payroll.read, which nobody outside HR and accounts holds. So
   the twelve people the payslips are about could not see their own — a teacher
   asking "did I get my full salary this month" had to walk to the office and
   ask somebody to look it up.

   This is deliberately not a second payroll screen. It answers three questions
   and no others:

     what was I paid, month by month, and what was taken off;
     how much of that was tax and provident fund;
     how many days was I here, late, or on leave.

   Self only, and self is not a permission the way the others are: it is the
   row whose user_id is the caller. There is no id in the path and no filter to
   widen, so there is nothing to get wrong — the query cannot return somebody
   else's pay because it never asks for anybody else's.
*/

type myPayslip struct {
	Month     int    `json:"period_month"`
	Year      int    `json:"period_year"`
	PaidDays  string `json:"paid_days"`
	LOPDays   string `json:"lop_days"`
	Gross     int64  `json:"gross_paise"`
	Deduction int64  `json:"deduction_paise"`
	Net       int64  `json:"net_paise"`
	// Breakup carries the named lines — basic, HRA, PF, professional tax —
	// exactly as payroll computed them. Rendering is the client's business;
	// re-deriving them here would be a second opinion on somebody's salary.
	Breakup any `json:"breakup"`
	// Locked says the run is final. An open run is a draft the office is still
	// working on, and showing it as settled pay is how somebody plans around a
	// number that then changes.
	Locked bool `json:"locked"`
}

type myAttendance struct {
	Present int `json:"present"`
	Absent  int `json:"absent"`
	Late    int `json:"late"`
	Leave   int `json:"on_leave"`
	Marked  int `json:"days_marked"`
}

type myPayResponse struct {
	EmployeeCode string        `json:"employee_code,omitempty"`
	Payslips     []myPayslip   `json:"payslips"`
	Attendance   myAttendance  `json:"attendance"`
	Balances     []leaveBalRow `json:"leave_balances"`
	// Note explains an empty answer, which is the usual answer in a school
	// that has not run payroll yet. An empty list with no explanation reads as
	// a fault.
	Note string `json:"note,omitempty"`
}

type leaveBalRow struct {
	Type      string `json:"leave_type"`
	Entitled  string `json:"entitled"`
	Used      string `json:"used"`
	Remaining string `json:"remaining"`
}

// getMyPay answers "did I get my full salary, and how many leaves have I left".
func (s *Server) getMyPay(w http.ResponseWriter, r *http.Request) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	out := myPayResponse{Payslips: []myPayslip{}, Balances: []leaveBalRow{}}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var empID string
		err := tx.QueryRow(r.Context(),
			`SELECT id::text, employee_code FROM employees WHERE user_id = $1 AND status = 'active'`,
			id.UserID).Scan(&empID, &out.EmployeeCode)
		if err == pgx.ErrNoRows {
			// A parent or a student reaching this is not an error; they simply
			// are not on the payroll.
			out.Note = "You are not on the staff roll, so there is no pay record here."
			return nil
		}
		if err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT pr.period_month, pr.period_year, ps.paid_days::text, ps.lop_days::text,
			       ps.gross_paise, ps.deduction_paise, ps.net_paise, ps.breakup,
			       pr.locked_at IS NOT NULL
			  FROM payslips ps
			  JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
			 WHERE ps.employee_id = $1::uuid
			 ORDER BY pr.period_year DESC, pr.period_month DESC
			 LIMIT 24`, empID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v myPayslip
			if err := rows.Scan(&v.Month, &v.Year, &v.PaidDays, &v.LOPDays,
				&v.Gross, &v.Deduction, &v.Net, &v.Breakup, &v.Locked); err != nil {
				rows.Close()
				return err
			}
			out.Payslips = append(out.Payslips, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		/* Their own register, this academic year.

		   Counted rather than listed: "how many days was I here" is the
		   question, and a calendar of two hundred rows is the answer to a
		   different one. */
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FILTER (WHERE status IN ('present', 'half_day'))::int,
			       count(*) FILTER (WHERE status = 'absent')::int,
			       count(*) FILTER (WHERE status = 'late')::int,
			       count(*) FILTER (WHERE status = 'leave')::int,
			       -- Holidays and week-offs are counted in neither: "220 days
			       -- marked" that silently includes every Sunday is a number
			       -- somebody will subtract from and get the wrong answer.
			       count(*) FILTER (WHERE status NOT IN ('holiday', 'week_off'))::int
			  FROM staff_attendance
			 WHERE user_id = $1`, id.UserID).
			Scan(&out.Attendance.Present, &out.Attendance.Absent,
				&out.Attendance.Late, &out.Attendance.Leave,
				&out.Attendance.Marked); err != nil {
			return err
		}

		// What is left of each entitlement — the second half of "how many sick
		// days do I have".
		brows, err := tx.Query(r.Context(), `
			SELECT lt.name, lb.entitled::text, lb.taken::text,
			       (lb.entitled - lb.taken)::text
			  FROM leave_balances lb
			  JOIN leave_types lt ON lt.id = lb.leave_type_id
			 WHERE lb.employee_id = $1::uuid
			 ORDER BY lt.name`, empID)
		if err != nil {
			return err
		}
		for brows.Next() {
			var v leaveBalRow
			if err := brows.Scan(&v.Type, &v.Entitled, &v.Used, &v.Remaining); err != nil {
				brows.Close()
				return err
			}
			out.Balances = append(out.Balances, v)
		}
		brows.Close()
		if err := brows.Err(); err != nil {
			return err
		}

		if len(out.Payslips) == 0 && out.Note == "" {
			out.Note = "No payroll has been run for you yet. Payslips appear here the month after the office runs one."
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
