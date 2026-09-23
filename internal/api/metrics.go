package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* THE CELLS ANY BOARD CAN ADD, WITH A PERIOD ON EACH.

   Seventeen of the eighteen boards had nothing to add: a board was a fixed
   handful of cells drawn by hand, and the Add gallery opened on "everything
   is on the board". Meanwhile the product holds hundreds of figures a
   person might want on their home -- money in, enquiries, absences, staff
   present, messages sent, books out -- and every one of them is a count or
   a sum over a date range.

   So one registry, here, of named metrics. Each is a permission, a unit,
   and a query over [$1, $2) in school-local dates. The client renders any
   of them as a stat cell keyed `metric:<key>`, with a period the person
   picks on the cell -- today, yesterday, this week, this month, this term,
   this year, all time -- and a comparison against the window before it
   where one exists. Adding a figure to every board on the product is one
   entry in this list.

   PERMISSION PER METRIC, NOT PER ENDPOINT. The list a caller sees is the
   metrics their session may read, and the value endpoint refuses the rest,
   so a board cannot show a number its role was never granted. Same shape as
   the attention probes.

   Dates, not timestamps, at the boundary: every column here is either a
   date already or a timestamptz that is converted to the school's calendar
   day in the query, so "yesterday" is yesterday in Hyderabad and not in
   Iowa. */

type metricUnit string

const (
	unitCount   metricUnit = "count"
	unitPaise   metricUnit = "paise"
	unitPercent metricUnit = "percent"
)

type metric struct {
	Key   string
	Label string
	// What it is, in a sentence, for the gallery tile.
	Hint  string
	Needs string
	Unit  metricUnit
	// AsOf marks a metric that is a standing figure at the end of the window
	// rather than a flow within it -- outstanding fees, books overdue. Those
	// read only $2 and have no previous-window comparison.
	AsOf bool
	// SQL returns one numeric column over $1::date <= x < $2::date.
	SQL string
}

// A timestamptz as a school-local calendar day.
const ist = " AT TIME ZONE 'Asia/Kolkata')::date"

var metrics = []metric{
	// ---- money -----------------------------------------------------------
	{Key: "fees.collected", Label: "Fees collected", Hint: "Money received at the counter and online.", Needs: rbac.PaymentsRead, Unit: unitPaise,
		SQL: `SELECT COALESCE(sum(amount_paise),0) FROM payments
		       WHERE status = 'success' AND mode <> 'adjustment' AND paid_on >= $1 AND paid_on < $2`},
	{Key: "fees.receipts", Label: "Receipts issued", Hint: "How many payments were taken.", Needs: rbac.PaymentsRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM payments
		       WHERE status = 'success' AND mode <> 'adjustment' AND paid_on >= $1 AND paid_on < $2`},
	{Key: "fees.billed", Label: "Fees billed", Hint: "Demands raised, net of concessions.", Needs: rbac.InvoicesRead, Unit: unitPaise,
		SQL: `SELECT COALESCE(sum(net_paise),0) FROM invoices
		       WHERE status <> 'cancelled' AND status <> 'draft' AND issued_on >= $1 AND issued_on < $2`},
	{Key: "fees.outstanding", Label: "Fees outstanding", Hint: "Still owed on bills issued by the end of the period.", Needs: rbac.InvoicesRead, Unit: unitPaise, AsOf: true,
		SQL: `SELECT COALESCE(sum(net_paise - paid_paise),0) FROM invoices
		       WHERE status IN ('unpaid','partial','overdue') AND issued_on < $2`},
	{Key: "fees.bounced", Label: "Cheques bounced", Hint: "Payments that came back.", Needs: rbac.PaymentsRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM payments WHERE status = 'bounced' AND paid_on >= $1 AND paid_on < $2`},
	{Key: "fees.refunds", Label: "Refunds processed", Hint: "Money returned to families.", Needs: rbac.PaymentsRead, Unit: unitPaise,
		SQL: `SELECT COALESCE(sum(amount_paise),0) FROM refunds
		       WHERE processed_on IS NOT NULL AND processed_on >= $1 AND processed_on < $2`},

	// ---- admissions --------------------------------------------------------
	{Key: "admissions.enquiries", Label: "New enquiries", Hint: "Families who asked.", Needs: rbac.AdmissionsRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM enquiries WHERE (created_at` + ist + ` >= $1 AND (created_at` + ist + ` < $2`},
	{Key: "admissions.applications", Label: "Applications", Hint: "Forms filled, at the counter or online.", Needs: rbac.AdmissionsRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM applications WHERE (created_at` + ist + ` >= $1 AND (created_at` + ist + ` < $2`},
	{Key: "admissions.admitted", Label: "Children admitted", Hint: "New students on the roll.", Needs: rbac.StudentsRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM students WHERE admission_date >= $1 AND admission_date < $2`},
	{Key: "admissions.lost", Label: "Leads lost", Hint: "Enquiries closed as lost.", Needs: rbac.AdmissionsRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM enquiries WHERE lost_at IS NOT NULL AND (lost_at` + ist + ` >= $1 AND (lost_at` + ist + ` < $2`},

	// ---- attendance --------------------------------------------------------
	{Key: "attendance.students", Label: "Student attendance", Hint: "Present or late, over the daily register.", Needs: rbac.AttendanceReadAll, Unit: unitPercent,
		SQL: `SELECT COALESCE(round(100.0 * count(*) FILTER (WHERE status IN ('present','late'))
		                            / NULLIF(count(*),0), 1), 0)
		        FROM student_attendance
		       WHERE period_id IS NULL AND status NOT IN ('holiday','leave') AND on_date >= $1 AND on_date < $2`},
	{Key: "attendance.absences", Label: "Absences", Hint: "Child-days marked absent.", Needs: rbac.AttendanceReadAll, Unit: unitCount,
		SQL: `SELECT count(*) FROM student_attendance
		       WHERE period_id IS NULL AND status = 'absent' AND on_date >= $1 AND on_date < $2`},
	{Key: "attendance.late", Label: "Late arrivals", Hint: "Child-days marked late.", Needs: rbac.AttendanceReadAll, Unit: unitCount,
		SQL: `SELECT count(*) FROM student_attendance
		       WHERE period_id IS NULL AND status = 'late' AND on_date >= $1 AND on_date < $2`},

	// ---- staff -------------------------------------------------------------
	{Key: "staff.attendance", Label: "Staff attendance", Hint: "Present, late or half-day, over marked days.", Needs: rbac.EmployeesRead, Unit: unitPercent,
		SQL: `SELECT COALESCE(round(100.0 * count(*) FILTER (WHERE status IN ('present','late','half_day'))
		                            / NULLIF(count(*) FILTER (WHERE status NOT IN ('holiday','week_off','leave')),0), 1), 0)
		        FROM staff_attendance WHERE on_date >= $1 AND on_date < $2`},
	{Key: "staff.leave_requests", Label: "Leave requests", Hint: "Applications for leave.", Needs: rbac.EmployeesRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM leave_requests WHERE (created_at` + ist + ` >= $1 AND (created_at` + ist + ` < $2`},
	{Key: "staff.joined", Label: "Staff joined", Hint: "New members of staff.", Needs: rbac.EmployeesRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM employees WHERE joined_on >= $1 AND joined_on < $2`},
	{Key: "staff.left", Label: "Staff left", Hint: "Relieved in the period.", Needs: rbac.EmployeesRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM employees WHERE relieved_on IS NOT NULL AND relieved_on >= $1 AND relieved_on < $2`},

	// ---- teaching ----------------------------------------------------------
	{Key: "academics.homework", Label: "Homework set", Hint: "Assignments given.", Needs: rbac.AcademicsRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM homework WHERE assigned_on >= $1 AND assigned_on < $2`},
	{Key: "academics.marks_entered", Label: "Marks entered", Hint: "Mark rows saved by teachers.", Needs: rbac.ExamsRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM marks WHERE (entered_at` + ist + ` >= $1 AND (entered_at` + ist + ` < $2`},

	// ---- communication -----------------------------------------------------
	{Key: "comms.sent", Label: "Messages sent", Hint: "SMS, WhatsApp and email that went out.", Needs: rbac.MessagesReadAll, Unit: unitCount,
		SQL: `SELECT count(*) FROM message_log WHERE status = 'sent' AND sent_at IS NOT NULL AND (sent_at` + ist + ` >= $1 AND (sent_at` + ist + ` < $2`},
	{Key: "comms.failed", Label: "Messages failed", Hint: "Sends that did not go.", Needs: rbac.MessagesReadAll, Unit: unitCount,
		SQL: `SELECT count(*) FROM message_log WHERE status = 'failed' AND (queued_at` + ist + ` >= $1 AND (queued_at` + ist + ` < $2`},
	{Key: "comms.tickets", Label: "Concerns raised", Hint: "Grievances and requests from families.", Needs: rbac.FrontDeskRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM support_tickets WHERE audience = 'school' AND (created_at` + ist + ` >= $1 AND (created_at` + ist + ` < $2`},
	{Key: "comms.tickets_resolved", Label: "Concerns resolved", Hint: "Closed with a resolution.", Needs: rbac.FrontDeskRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM support_tickets WHERE audience = 'school' AND resolved_at IS NOT NULL AND (resolved_at` + ist + ` >= $1 AND (resolved_at` + ist + ` < $2`},

	// ---- operations --------------------------------------------------------
	{Key: "library.loans", Label: "Books issued", Hint: "Loans made.", Needs: rbac.LibraryRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM library_loans WHERE issued_on >= $1 AND issued_on < $2`},
	{Key: "library.overdue", Label: "Books overdue", Hint: "Out past their due date at the end of the period.", Needs: rbac.LibraryRead, Unit: unitCount, AsOf: true,
		SQL: `SELECT count(*) FROM library_loans WHERE returned_on IS NULL AND due_on < $2`},
	{Key: "transport.trips", Label: "Bus trips", Hint: "Runs started by the fleet.", Needs: rbac.TransportRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM vehicle_trips WHERE (started_at` + ist + ` >= $1 AND (started_at` + ist + ` < $2`},
	{Key: "hostel.outpasses", Label: "Outpasses", Hint: "Leave from the hostel requested.", Needs: rbac.HostelRead, Unit: unitCount,
		SQL: `SELECT count(*) FROM hostel_outpasses WHERE (expected_out` + ist + ` >= $1 AND (expected_out` + ist + ` < $2`},
}

var metricByKey = func() map[string]metric {
	m := make(map[string]metric, len(metrics))
	for _, x := range metrics {
		m[x.Key] = x
	}
	return m
}()

// periods are the windows a cell may be set to, in the order a menu lists them.
var periods = []string{"today", "yesterday", "week", "month", "term", "year", "all"}

type window struct {
	From, To time.Time // school-local dates, [From, To)
	// Prev is the window of equal length before this one, for a comparison;
	// nil where none makes sense (term, year, all time, as-of figures).
	Prev *window
}

var errUnknownPeriod = errors.New("unknown period")

/*
windowFor resolves a period name to dates in the school's calendar.

	Weeks start on Monday, which is the week every Indian school runs. Term
	and year come from the school's own calendar: the current academic year
	and, within it, the term the date falls in; a school with no term dated
	today gets the year. "All time" starts at the product's epoch.
*/
func windowFor(ctx context.Context, tx pgx.Tx, period string, now time.Time) (window, error) {
	day := func(t time.Time) time.Time {
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
	}
	today := day(now)
	tomorrow := today.AddDate(0, 0, 1)
	prevOf := func(from, to time.Time) *window {
		n := int(to.Sub(from).Hours() / 24)
		return &window{From: from.AddDate(0, 0, -n), To: from}
	}
	switch period {
	case "today":
		return window{From: today, To: tomorrow, Prev: prevOf(today, tomorrow)}, nil
	case "yesterday":
		y := today.AddDate(0, 0, -1)
		return window{From: y, To: today, Prev: prevOf(y, today)}, nil
	case "week":
		back := (int(today.Weekday()) + 6) % 7 // Monday = 0
		monday := today.AddDate(0, 0, -back)
		return window{From: monday, To: tomorrow, Prev: &window{From: monday.AddDate(0, 0, -7), To: monday}}, nil
	case "month":
		first := time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, today.Location())
		return window{From: first, To: tomorrow, Prev: &window{From: first.AddDate(0, -1, 0), To: first}}, nil
	case "term", "year":
		var starts, ends time.Time
		var err error
		if period == "term" {
			err = tx.QueryRow(ctx, `
				SELECT t.starts_on, t.ends_on FROM terms t
				  JOIN academic_years ay ON ay.id = t.academic_year_id AND ay.is_current
				 WHERE $1::date BETWEEN t.starts_on AND t.ends_on
				 ORDER BY t.sequence LIMIT 1`, today).Scan(&starts, &ends)
		}
		if period == "year" || errors.Is(err, pgx.ErrNoRows) {
			err = tx.QueryRow(ctx,
				`SELECT starts_on, ends_on FROM academic_years WHERE is_current LIMIT 1`).Scan(&starts, &ends)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			// No calendar yet: the year that began last April.
			y := today.Year()
			if today.Month() < time.April {
				y--
			}
			starts = time.Date(y, time.April, 1, 0, 0, 0, 0, today.Location())
			ends = starts.AddDate(1, 0, -1)
			err = nil
		}
		if err != nil {
			return window{}, err
		}
		to := day(ends).AddDate(0, 0, 1)
		if to.After(tomorrow) {
			to = tomorrow
		}
		return window{From: day(starts), To: to}, nil
	case "all":
		return window{From: time.Date(2000, 1, 1, 0, 0, 0, 0, today.Location()), To: tomorrow}, nil
	}
	return window{}, errUnknownPeriod
}

type metricListing struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Hint    string   `json:"hint"`
	Unit    string   `json:"unit"`
	AsOf    bool     `json:"as_of"`
	Group   string   `json:"group"`
	Periods []string `json:"periods"`
}

// listMetrics is the gallery's source: every metric this session may read.
func (s *Server) listMetrics(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := []metricListing{}
	for _, m := range metrics {
		if !id.Can(m.Needs) {
			continue
		}
		out = append(out, metricListing{
			Key: m.Key, Label: m.Label, Hint: m.Hint, Unit: string(m.Unit), AsOf: m.AsOf,
			Group: strings.SplitN(m.Key, ".", 2)[0], Periods: periods,
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

type metricValue struct {
	Key      string   `json:"key"`
	Label    string   `json:"label"`
	Unit     string   `json:"unit"`
	AsOf     bool     `json:"as_of"`
	Period   string   `json:"period"`
	From     string   `json:"from"`
	To       string   `json:"to"` // exclusive
	Value    float64  `json:"value"`
	Previous *float64 `json:"previous,omitempty"`
}

// getMetric answers one cell: the figure for the period, and the figure for
// the window before it where that means something.
func (s *Server) getMetric(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !requireInstitution(w, r) {
		return
	}
	m, ok := metricByKey[chi.URLParam(r, "key")]
	if !ok {
		httpx.NotFound(w, r)
		return
	}
	if !id.Can(m.Needs) {
		// 404, like every other refusal a board can meet: a role that was
		// never granted a figure is not told the figure exists.
		httpx.NotFound(w, r)
		return
	}
	period := strings.TrimSpace(r.URL.Query().Get("period"))
	if period == "" {
		period = "month"
	}

	var out metricValue
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		win, err := windowFor(r.Context(), tx, period, nowInIndia())
		if err != nil {
			return err
		}
		run := func(wn window) (float64, error) {
			var v float64
			err := tx.QueryRow(r.Context(), m.SQL, wn.From, wn.To).Scan(&v)
			return v, err
		}
		v, err := run(win)
		if err != nil {
			return err
		}
		out = metricValue{Key: m.Key, Label: m.Label, Unit: string(m.Unit), AsOf: m.AsOf,
			Period: period, From: win.From.Format("2006-01-02"), To: win.To.Format("2006-01-02"), Value: v}
		if win.Prev != nil && !m.AsOf {
			p, err := run(*win.Prev)
			if err != nil {
				return err
			}
			out.Previous = &p
		}
		return nil
	})
	if errors.Is(err, errUnknownPeriod) {
		httpx.BadRequest(w, r, "period must be one of "+strings.Join(periods, ", "))
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
