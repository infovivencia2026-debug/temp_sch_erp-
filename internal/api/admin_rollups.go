package api

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/*
Administrative roll-ups: the seven reporting screens that sit one level above
the operational modules.

	Nothing here owns data. Every figure is an aggregate over tables another
	part of the product already writes — attendance, marks, invoices, receipts,
	the timetable, the staff register. That is deliberate: a report that keeps
	its own copy of the truth is a report that disagrees with the screen it
	summarises, and the school then has two numbers and no answer. There is no
	migration behind this file.

	Consequences of that choice, which the queries below all obey:

	  - Aggregation happens in SQL, never in Go. These run over the whole
	    institution on a 1 vCPU box; pulling rows back to count them is the one
	    thing guaranteed to make a principal's landing page slow.
	  - One round trip per screen wherever a screen is one screen. The Today
	    view issues its queries inside a single transaction rather than as six
	    endpoints the browser fires in parallel.
	  - Every list endpoint answers CSV from the same query that answers JSON
	    (?format=csv). Indian schools live in Excel; a report you cannot get out
	    of the browser is one people re-type by hand.

	Scope is decided here, on the server. resolveScope() gives the caller's real
	boundary and every department-scoped query carries the predicate. A
	principal sees the institution because they hold students.read.all, not
	because the UI drew the whole list.
*/

// --- scope -------------------------------------------------------------------

/*
rollupBoundary is "how much of the school is this caller's".

	catalog.ScopeDepartment on its own is not enough. scope.Resolved.Filter
	returns a false predicate when DepartmentIDs is empty, which is correct for
	a head of department who heads nothing and wrong for a principal, who heads
	no department and must see every one. The discriminator is the capability
	that already means institution-wide reach — students.read.all — which
	institution_admin and vice_principal hold and hod deliberately does not.
*/
type rollupBoundary struct {
	All   bool
	Depts []uuid.UUID
	Res   *scope.Resolved
}

func (s *Server) resolveRollupScope(r *http.Request) (*rollupBoundary, error) {
	res, err := s.resolveScope(r)
	if err != nil {
		return nil, err
	}
	return &rollupBoundary{
		All:   res.PlatformAdmin || res.AllStudents || res.AllAttendance,
		Depts: res.DepartmentIDs,
		Res:   res,
	}, nil
}

// deptPredicate restricts an employees.department_id expression to the caller's
// departments. column is a literal from the handler, never user input.
//
// The dept argument MUST be the last parameter in the query. For a caller who
// sees the whole institution this returns a bare TRUE and no argument, so $argN
// is never referenced and bindScope never appends it — which is only safe while
// nothing above argN exists. Put the predicate at $2 in a query that also uses
// $3 and Postgres rejects the statement outright, for institution-wide users
// only, which is the hardest case to notice. A worker hit exactly that. If you
// need the predicate anywhere but last, write it unconditionally instead:
//
//	($2::uuid[] IS NULL OR e.department_id = ANY($2))
func (b *rollupBoundary) deptPredicate(column string, argN int) (string, any) {
	if b.All {
		return "TRUE", nil
	}
	if len(b.Depts) == 0 {
		return "FALSE", nil
	}
	return fmt.Sprintf("%s = ANY($%d)", column, argN), b.Depts
}

/*
sectionPredicate restricts a section_id expression to the caller's sections.

	Used where a row has no department of its own — an unstaffed period has no
	teacher and therefore no department, but a head of department still has to
	see the hole in their own timetable. scope.Resolve already folds "sections
	my department teaches" into SectionIDs, so this is the right boundary for
	anything keyed on a class rather than on a person.
*/
func (b *rollupBoundary) sectionPredicate(column string, argN int) (string, any) {
	if b.All {
		return "TRUE", nil
	}
	if len(b.Res.SectionIDs) == 0 {
		return "FALSE", nil
	}
	return fmt.Sprintf("%s = ANY($%d)", column, argN), b.Res.SectionIDs
}

func (b *rollupBoundary) label() string {
	if b.All {
		return "institution"
	}
	return "department"
}

// bind appends a scope argument only when the predicate actually took one; an
// institution-wide caller yields "TRUE" and must not shift the placeholders.
func bindScope(args []any, arg any) []any {
	if arg == nil {
		return args
	}
	return append(args, arg)
}

// --- response ----------------------------------------------------------------

/*
rollupRespond answers JSON, or CSV when the caller asks for it.

	The CSV comes off the same query as the JSON rather than a second one kept
	beside it, because the pair drift the moment somebody adds a column to one.
	Rows are already materialised by the time this is called — these are
	summaries, tens or hundreds of rows, not the tens of thousands that
	exportCSV streams — so the simple form is the right one here.
*/
func rollupRespond[T any](w http.ResponseWriter, r *http.Request, name string,
	header []string, items []T, row func(T) []string, err error) {
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !strings.EqualFold(r.URL.Query().Get("format"), "csv") {
		httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
		return
	}
	writeRollupCSV(w, name, header, items, row)
}

func writeRollupCSV[T any](w http.ResponseWriter, name string,
	header []string, items []T, row func(T) []string) {
	filename := fmt.Sprintf("%s-%s.csv", name, nowInIndia().Format(time.DateOnly))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	// Excel reads a UTF-8 CSV as ANSI without a BOM, which turns Telugu names
	// into mojibake for exactly the schools that most need them readable.
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})
	cw := csv.NewWriter(w)
	_ = cw.Write(header)
	for _, it := range items {
		_ = cw.Write(row(it))
	}
	cw.Flush()
}

// rupeesCell renders money as plain rupees for a spreadsheet: no symbol, no
// grouping, two decimals, so Excel reads it as a number and an auditor can sum
// the column. The UI applies Indian digit grouping to the JSON paise figure.
func rupeesCell(v int64) string { return strconv.FormatFloat(float64(v)/100, 'f', 2, 64) }

func intCell(v int) string { return strconv.Itoa(v) }

func pctCell(v *float64) string {
	if v == nil {
		return ""
	}
	return strconv.FormatFloat(*v, 'f', 1, 64)
}

func strCell(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

/*
rollupYear resolves the academic year a report covers.

	Defensive ordering rather than a bare is_current: the partial unique index
	admits one current year per campus, so a multi-campus institution can carry
	several, and a school that never set the flag must still get an answer
	rather than a silently empty report.
*/
func rollupYear(ctx context.Context, tx pgx.Tx, override string) (uuid.UUID, error) {
	if override != "" {
		if id, err := uuid.Parse(override); err == nil {
			return id, nil
		}
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT id FROM academic_years
		 ORDER BY is_current DESC, starts_on DESC LIMIT 1`).Scan(&id)
	return id, err
}

// rollupList runs one tenant-scoped aggregate and maps every row.
func rollupList[T any](s *Server, r *http.Request, sql string, args []any,
	scan func(pgx.Rows) (T, error)) ([]T, error) {
	return collect(s, r, sql, args, scan)
}

// --- 1. institution_admin.home.today ----------------------------------------

type todayStaffAbsence struct {
	UserID     string  `json:"user_id"`
	FullName   string  `json:"full_name"`
	Department *string `json:"department,omitempty"`
	Status     string  `json:"status"`
	Periods    int     `json:"periods_today"`
	Covered    int     `json:"periods_covered"`
	Uncovered  int     `json:"periods_uncovered"`
}

type todayGap struct {
	Period   string `json:"period"`
	StartsAt string `json:"starts_at"`
	Class    string `json:"class_name"`
	Section  string `json:"section_name"`
	Subject  string `json:"subject"`
	Reason   string `json:"reason"`
}

type todayMoney struct {
	DueTodayPaise    int64 `json:"due_today_paise"`
	CollectedPaise   int64 `json:"collected_today_paise"`
	Receipts         int   `json:"receipts_today"`
	OverduePaise     int64 `json:"overdue_as_of_today_paise"`
	OverdueStudents  int   `json:"overdue_students"`
	UnbankedChqPaise int64 `json:"cheques_awaiting_clearance_paise"`
}

type todayDiaryItem struct {
	At    string `json:"at,omitempty"`
	Title string `json:"title"`
	With  string `json:"with,omitempty"`
	Kind  string `json:"kind,omitempty"`
}

type todayDecision struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Count int    `json:"count"`
	Href  string `json:"href"`
}

/*
todayView is the principal's landing page for the day in front of them.

	Deliberately not a second executive_kpis. That screen answers "how is the
	school doing" with levels and flows over a chosen range; needs_attention
	answers "what is wrong" as a severity-ranked list for any role. This one
	answers a narrower and more perishable question — what will still be broken
	at four o'clock if nobody deals with it — so everything on it is either
	today's fact or today's decision, and none of it is a running total.

	The cover picture is the heart of it. "Three teachers absent" is not
	actionable; "three teachers absent, eleven of their periods uncovered, here
	are the classes" is.
*/
type todayView struct {
	Date        string              `json:"date"`
	Weekday     string              `json:"weekday"`
	Scope       string              `json:"scope"`
	StaffAbsent []todayStaffAbsence `json:"staff_absent"`
	Gaps        []todayGap          `json:"uncovered_periods"`
	Money       *todayMoney         `json:"money,omitempty"`
	Visitors    []todayDiaryItem    `json:"visitors_expected"`
	Events      []todayDiaryItem    `json:"events"`
	Decisions   []todayDecision     `json:"decisions"`
}

/*
getToday powers institution_admin.home.today.

	One transaction, several small indexed queries, rather than six endpoints:
	this is the first paint after a principal logs in and every extra round
	trip on a 1 vCPU box is visible.

	The date is computed in Go from nowInIndia() and bound, not taken from
	CURRENT_DATE. A box running UTC rolls into tomorrow at half past five in
	the evening local time, which is exactly when a principal is asking what is
	left to deal with.
*/
func (s *Server) getToday(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	now := nowInIndia()
	day := now.Format(time.DateOnly)
	out := todayView{
		Date:        day,
		Weekday:     now.Format("Monday"),
		Scope:       b.label(),
		StaffAbsent: []todayStaffAbsence{},
		Gaps:        []todayGap{},
		Visitors:    []todayDiaryItem{},
		Events:      []todayDiaryItem{},
		Decisions:   []todayDecision{},
	}

	deptPred, deptArg := b.deptPredicate("e.department_id", 2)
	secPred, secArg := b.sectionPredicate("te.section_id", 2)

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ctx := r.Context()

		// Who is away, and how much of their day is already covered.
		if id.Can(rbac.EmployeesRead) {
			args := bindScope([]any{day}, deptArg)
			rows, err := tx.Query(ctx, `
				SELECT u.id::text, u.full_name, d.name, sa.status,
				       (SELECT count(*) FROM timetable_entries te
				          JOIN periods p ON p.id = te.period_id AND NOT p.is_break
				         WHERE te.teacher_user_id = sa.user_id
				           AND te.weekday = EXTRACT(isodow FROM $1::date)::int),
				       (SELECT count(*) FROM timetable_entries te
				          JOIN periods p ON p.id = te.period_id AND NOT p.is_break
				          JOIN substitutions su ON su.timetable_entry_id = te.id
				                               AND su.on_date = $1::date
				         WHERE te.teacher_user_id = sa.user_id
				           AND te.weekday = EXTRACT(isodow FROM $1::date)::int)
				  FROM staff_attendance sa
				  JOIN users u ON u.id = sa.user_id
				  LEFT JOIN employees   e ON e.user_id = sa.user_id
				  LEFT JOIN departments d ON d.id = e.department_id
				 WHERE sa.on_date = $1::date
				   AND sa.status IN ('absent','leave')
				   AND `+deptPred+`
				 ORDER BY u.full_name`, args...)
			if err != nil {
				return fmt.Errorf("staff absent: %w", err)
			}
			for rows.Next() {
				var v todayStaffAbsence
				if err := rows.Scan(&v.UserID, &v.FullName, &v.Department, &v.Status,
					&v.Periods, &v.Covered); err != nil {
					rows.Close()
					return err
				}
				v.Uncovered = v.Periods - v.Covered
				out.StaffAbsent = append(out.StaffAbsent, v)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		// Periods today with nobody in front of the class: either never
		// staffed, or staffed by somebody who is away and not covered.
		{
			args := bindScope([]any{day}, secArg)
			rows, err := tx.Query(ctx, `
				SELECT p.name, to_char(p.starts_at,'HH24:MI'),
				       c.name, sec.name, sub.name,
				       CASE WHEN te.teacher_user_id IS NULL
				            THEN 'No teacher assigned'
				            ELSE 'Teacher away, no cover arranged' END
				  FROM timetable_entries te
				  JOIN periods  p   ON p.id = te.period_id AND NOT p.is_break
				  JOIN sections sec ON sec.id = te.section_id
				  JOIN classes  c   ON c.id = sec.class_id
				  JOIN class_subjects cs ON cs.id = te.class_subject_id
				  JOIN subjects sub ON sub.id = cs.subject_id
				 WHERE te.weekday = EXTRACT(isodow FROM $1::date)::int
				   AND (
				     te.teacher_user_id IS NULL
				     OR (EXISTS (SELECT 1 FROM staff_attendance sa
				                  WHERE sa.user_id = te.teacher_user_id
				                    AND sa.on_date = $1::date
				                    AND sa.status IN ('absent','leave'))
				         AND NOT EXISTS (SELECT 1 FROM substitutions su
				                          WHERE su.timetable_entry_id = te.id
				                            AND su.on_date = $1::date))
				   )
				   AND `+secPred+`
				 ORDER BY p.sequence, c.level, sec.name`, args...)
			if err != nil {
				return fmt.Errorf("gaps: %w", err)
			}
			for rows.Next() {
				var v todayGap
				if err := rows.Scan(&v.Period, &v.StartsAt, &v.Class, &v.Section,
					&v.Subject, &v.Reason); err != nil {
					rows.Close()
					return err
				}
				out.Gaps = append(out.Gaps, v)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		/* Today's money, for whoever may read invoices.

		   Collections exclude mode='adjustment': a write-off is an accounting
		   entry, not money that came through the door, and counting it as
		   collection flatters the day. Cheques taken today are shown apart
		   because they are a promise until they clear. */
		if id.Can(rbac.InvoicesRead) {
			var m todayMoney
			if err := tx.QueryRow(ctx, `
				SELECT
				  COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices
				             WHERE due_on = $1::date
				               AND status IN ('unpaid','partial','overdue')), 0),
				  COALESCE((SELECT sum(amount_paise) FROM payments
				             WHERE status = 'success' AND paid_on = $1::date
				               AND mode <> 'adjustment'), 0),
				  (SELECT count(*) FROM payments
				    WHERE status = 'success' AND paid_on = $1::date
				      AND mode <> 'adjustment'),
				  COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices
				             WHERE status IN ('unpaid','partial','overdue')
				               AND due_on IS NOT NULL AND due_on < $1::date), 0),
				  (SELECT count(DISTINCT student_id) FROM invoices
				    WHERE status IN ('unpaid','partial','overdue')
				      AND due_on IS NOT NULL AND due_on < $1::date),
				  COALESCE((SELECT sum(amount_paise) FROM payments
				             WHERE status = 'pending' AND mode IN ('cheque','dd')), 0)
			`, day).Scan(&m.DueTodayPaise, &m.CollectedPaise, &m.Receipts,
				&m.OverduePaise, &m.OverdueStudents, &m.UnbankedChqPaise); err != nil {
				return fmt.Errorf("money: %w", err)
			}
			out.Money = &m
		}

		// Who is coming in. appointments is the booked diary; visitors is the
		// gate log, which is a record of arrival rather than an expectation.
		{
			rows, err := tx.Query(ctx, `
				SELECT to_char(a.starts_at,'HH24:MI'), a.visitor_name,
				       COALESCE(concat_ws(' ', e.first_name, e.last_name),''), a.purpose
				  FROM appointments a
				  LEFT JOIN employees e ON e.id = a.with_employee_id
				 WHERE a.on_date = $1::date AND a.status = 'booked'
				 ORDER BY a.starts_at`, day)
			if err != nil {
				return fmt.Errorf("visitors: %w", err)
			}
			for rows.Next() {
				var v todayDiaryItem
				if err := rows.Scan(&v.At, &v.Title, &v.With, &v.Kind); err != nil {
					rows.Close()
					return err
				}
				out.Visitors = append(out.Visitors, v)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		// What is on: published events, and any holiday or exam day declared
		// for today, which is the other thing that changes how the day runs.
		{
			rows, err := tx.Query(ctx, `
				SELECT COALESCE(to_char(starts_at,'HH24:MI'),''), name, venue, kind
				  FROM school_events
				 WHERE is_published
				   AND $1::date BETWEEN on_date AND COALESCE(ends_on, on_date)
				UNION ALL
				SELECT '', name, '', kind
				  FROM holidays
				 WHERE $1::date BETWEEN on_date AND COALESCE(to_date, on_date)
				 ORDER BY 1, 2`, day)
			if err != nil {
				return fmt.Errorf("events: %w", err)
			}
			for rows.Next() {
				var v todayDiaryItem
				var venue *string
				if err := rows.Scan(&v.At, &v.Title, &venue, &v.Kind); err != nil {
					rows.Close()
					return err
				}
				v.With = strCell(venue)
				out.Events = append(out.Events, v)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}

		/* Decisions waiting on this office.

		   Each one is a queue that only a person with the right can clear, so
		   each is gated on that right rather than on the screen: showing a
		   principal a count they cannot action is noise, and showing it to
		   somebody who may not read the queue is a leak. */
		add := func(key, label, href string, n int) {
			if n > 0 {
				out.Decisions = append(out.Decisions,
					todayDecision{Key: key, Label: label, Count: n, Href: href})
			}
		}
		var leave, concessions, corrections, admissions int
		if id.Can(rbac.LeaveApprove) {
			if err := tx.QueryRow(ctx, `
				SELECT count(*) FROM leave_requests
				 WHERE status = 'pending' AND subject_kind = 'staff'
				   AND from_date <= $1::date + 2`, day).Scan(&leave); err != nil {
				return fmt.Errorf("leave: %w", err)
			}
			add("leave.pending", "staff leave requests starting within two days",
				"approvals", leave)
		}
		if id.Can(rbac.FeesWrite) {
			if err := tx.QueryRow(ctx, `
				SELECT count(*) FROM fee_concessions WHERE approved_at IS NULL`).
				Scan(&concessions); err != nil {
				return fmt.Errorf("concessions: %w", err)
			}
			add("fees.concessions", "fee concessions awaiting approval", "approvals", concessions)
		}
		if id.Can(rbac.AttendanceWriteAny) {
			if err := tx.QueryRow(ctx, `
				SELECT count(*) FROM attendance_corrections WHERE status = 'pending'`).
				Scan(&corrections); err != nil {
				return fmt.Errorf("corrections: %w", err)
			}
			add("attendance.corrections", "attendance corrections awaiting review",
				"approvals", corrections)
		}
		if id.Can(rbac.AdmissionsRead) {
			if err := tx.QueryRow(ctx, `
				SELECT count(*) FROM applications
				 WHERE status IN ('submitted','under_review','test_scheduled','interviewed')`).
				Scan(&admissions); err != nil {
				return fmt.Errorf("admissions: %w", err)
			}
			add("admissions.pending", "admission applications waiting on a decision",
				"admissions", admissions)
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// The CSV is the day's action list — the two things a principal would
	// carry out of the room — rather than the whole object.
	if strings.EqualFold(r.URL.Query().Get("format"), "csv") {
		type line struct{ a, b, c, d string }
		rowsOut := []line{}
		for _, v := range out.StaffAbsent {
			rowsOut = append(rowsOut, line{"Staff away", v.FullName,
				strCell(v.Department), fmt.Sprintf("%s, %d of %d periods uncovered",
					v.Status, v.Uncovered, v.Periods)})
		}
		for _, v := range out.Gaps {
			rowsOut = append(rowsOut, line{"Uncovered period",
				v.Period + " " + v.StartsAt, v.Class + "-" + v.Section,
				v.Subject + " - " + v.Reason})
		}
		for _, v := range out.Visitors {
			rowsOut = append(rowsOut, line{"Visitor expected", v.At, v.Title, v.With})
		}
		for _, v := range out.Events {
			rowsOut = append(rowsOut, line{"Event", v.At, v.Title, v.Kind})
		}
		for _, v := range out.Decisions {
			rowsOut = append(rowsOut, line{"Decision", intCell(v.Count), v.Label, ""})
		}
		writeRollupCSV(w, "today", []string{"Item", "When / Who", "Where", "Detail"},
			rowsOut, func(l line) []string { return []string{l.a, l.b, l.c, l.d} })
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// --- 2. institution_admin.fees.fee_overview ---------------------------------

type feeOverviewTotals struct {
	DemandedPaise    int64    `json:"demanded_paise"`
	CollectedPaise   int64    `json:"collected_paise"`
	OutstandingPaise int64    `json:"outstanding_paise"`
	ConcessionPaise  int64    `json:"concession_paise"`
	FinePaise        int64    `json:"fine_paise"`
	Students         int      `json:"students_billed"`
	Defaulters       int      `json:"defaulters"`
	CollectedPct     *float64 `json:"collected_pct,omitempty"`
}

type feeClassRow struct {
	ClassName        string   `json:"class_name"`
	Students         int      `json:"students"`
	DemandedPaise    int64    `json:"demanded_paise"`
	CollectedPaise   int64    `json:"collected_paise"`
	OutstandingPaise int64    `json:"outstanding_paise"`
	ConcessionPaise  int64    `json:"concession_paise"`
	CollectedPct     *float64 `json:"collected_pct,omitempty"`
}

type feeOverviewView struct {
	Year    string            `json:"academic_year"`
	Totals  feeOverviewTotals `json:"totals"`
	ByClass []feeClassRow     `json:"by_class"`
}

/*
getFeeOverview powers institution_admin.fees.fee_overview.

	The principal's view of fees, not the accountant's: what was asked for this
	year, what came in, what is still out, and what the school gave away. The
	operational screens — receipt entry, invoice generation, the student ledger
	— stay in the finance module and are not duplicated here.

	THE THREE WORDS, DEFINED ONCE (the dashboard uses these same definitions):

	  demanded/billed  sum(invoices.net_paise)         academic year shown, status <> 'cancelled'.
	                   net is gross - discount + fine, so concessions are already
	                   netted off and fines are already in.
	  collected        sum(invoices.paid_paise)        the same rows. This is money APPLIED to
	                   this year's bills, not receipts banked: an advance nobody
	                   has allocated yet, and a receipt settling last year's
	                   arrears, are both real money and neither belongs here.
	                   The day book's "collected" is the receipt measure.
	  outstanding      sum(net_paise - paid_paise)     the same rows, as of now.

	Excluded everywhere: cancelled invoices. Not excluded: fines, because a
	fine is billed and is owed.

	Class is taken from the enrolment for the invoice's own academic year, not
	from the student's latest enrolment. The "latest" shortcut used elsewhere
	reads last year's arrears as though they belonged to this year's class,
	which makes a Grade 9 look like a defaulter for a debt they ran up in
	Grade 8.
*/
func (s *Server) getFeeOverview(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := feeOverviewView{
		ByClass: []feeClassRow{},
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ctx := r.Context()
		year, err := rollupYear(ctx, tx, r.URL.Query().Get("year"))
		if err != nil {
			return err
		}
		if err := tx.QueryRow(ctx,
			`SELECT name FROM academic_years WHERE id = $1`, year).Scan(&out.Year); err != nil {
			return err
		}

		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(sum(i.net_paise),0),
			       COALESCE(sum(i.paid_paise),0),
			       COALESCE(sum(i.net_paise - i.paid_paise),0),
			       COALESCE(sum(i.discount_paise),0),
			       COALESCE(sum(i.fine_paise),0),
			       count(DISTINCT i.student_id),
			       count(DISTINCT i.student_id) FILTER (
			           WHERE i.net_paise > i.paid_paise
			             AND i.due_on IS NOT NULL AND i.due_on < CURRENT_DATE)
			  FROM invoices i
			 WHERE i.academic_year_id = $1 AND i.status <> 'cancelled'`, year).
			Scan(&out.Totals.DemandedPaise, &out.Totals.CollectedPaise,
				&out.Totals.OutstandingPaise, &out.Totals.ConcessionPaise,
				&out.Totals.FinePaise, &out.Totals.Students, &out.Totals.Defaulters); err != nil {
			return fmt.Errorf("fee totals: %w", err)
		}
		// Rounded to one decimal, the way every other percentage on the
		// roll-up endpoints is rounded in SQL. Unrounded, this printed
		// 87.66325536062378% on the screen — fourteen digits of precision on a
		// ratio of two sums, which reads as a machine leaking rather than a
		// figure a school quotes.
		if out.Totals.DemandedPaise > 0 {
			v := round1(100 * float64(out.Totals.CollectedPaise) / float64(out.Totals.DemandedPaise))
			out.Totals.CollectedPct = &v
		}

		rows, err := tx.Query(ctx, `
			SELECT c.name,
			       count(DISTINCT i.student_id),
			       COALESCE(sum(i.net_paise),0),
			       COALESCE(sum(i.paid_paise),0),
			       COALESCE(sum(i.net_paise - i.paid_paise),0),
			       COALESCE(sum(i.discount_paise),0)
			  FROM invoices i
			  JOIN enrollments en ON en.student_id = i.student_id
			                     AND en.academic_year_id = i.academic_year_id
			  JOIN classes c ON c.id = en.class_id
			 WHERE i.academic_year_id = $1 AND i.status <> 'cancelled'
			 GROUP BY c.id, c.name, c.level
			 ORDER BY c.level, c.name`, year)
		if err != nil {
			return fmt.Errorf("fees by class: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var v feeClassRow
			if err := rows.Scan(&v.ClassName, &v.Students, &v.DemandedPaise,
				&v.CollectedPaise, &v.OutstandingPaise, &v.ConcessionPaise); err != nil {
				return err
			}
			if v.DemandedPaise > 0 {
				p := round1(100 * float64(v.CollectedPaise) / float64(v.DemandedPaise))
				v.CollectedPct = &p
			}
			out.ByClass = append(out.ByClass, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	if strings.EqualFold(r.URL.Query().Get("format"), "csv") {
		writeRollupCSV(w, "fee-overview",
			[]string{"Class", "Students", "Demanded (Rs)", "Collected (Rs)",
				"Outstanding (Rs)", "Concession (Rs)", "Collected %"},
			out.ByClass, func(v feeClassRow) []string {
				return []string{v.ClassName, intCell(v.Students),
					rupeesCell(v.DemandedPaise), rupeesCell(v.CollectedPaise),
					rupeesCell(v.OutstandingPaise), rupeesCell(v.ConcessionPaise),
					pctCell(v.CollectedPct)}
			})
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type feeAgeingRow struct {
	Bucket      string `json:"bucket"`
	Invoices    int    `json:"invoices"`
	Students    int    `json:"students"`
	AmountPaise int64  `json:"amount_paise"`
}

/*
getFeeAgeing buckets what is outstanding by how long it has been outstanding.

	Deliberately NOT filtered to one academic year: money owed from two years
	ago is exactly what an ageing table exists to surface, and bucketing only
	this year's bills would put the oldest debt in no bucket at all. This is
	why the ageing total exceeds fee_overview's outstanding, which is this
	year's bills only; the screen says so rather than leaving two numbers to
	contradict each other silently.

	The buckets are the ones an Indian school's committee asks for, and the
	predicate is the one the rest of the codebase uses: status IN (unpaid,
	partial, overdue) with an explicit due-date test rather than status =
	'overdue'. The status column is only recomputed when an allocation changes,
	so an untouched invoice that sailed past its due date still reads 'unpaid'.
*/
func (s *Server) getFeeAgeing(w http.ResponseWriter, r *http.Request) {
	items, err := rollupList(s, r, `
		SELECT bucket, count(*), count(DISTINCT student_id), COALESCE(sum(balance),0)
		  FROM (
		    SELECT i.student_id,
		           (i.net_paise - i.paid_paise) AS balance,
		           CASE WHEN i.due_on IS NULL              THEN 5
		                WHEN i.due_on >= CURRENT_DATE      THEN 0
		                WHEN CURRENT_DATE - i.due_on <= 30 THEN 1
		                WHEN CURRENT_DATE - i.due_on <= 60 THEN 2
		                WHEN CURRENT_DATE - i.due_on <= 90 THEN 3
		                ELSE 4 END AS ord,
		           CASE WHEN i.due_on IS NULL              THEN 'No due date set'
		                WHEN i.due_on >= CURRENT_DATE      THEN 'Not yet due'
		                WHEN CURRENT_DATE - i.due_on <= 30 THEN '1-30 days'
		                WHEN CURRENT_DATE - i.due_on <= 60 THEN '31-60 days'
		                WHEN CURRENT_DATE - i.due_on <= 90 THEN '61-90 days'
		                ELSE 'Over 90 days' END AS bucket
		      FROM invoices i
		     WHERE i.status IN ('unpaid','partial','overdue')
		       AND i.net_paise > i.paid_paise
		  ) x
		 GROUP BY bucket, ord
		 ORDER BY ord`, nil,
		func(rows pgx.Rows) (feeAgeingRow, error) {
			var v feeAgeingRow
			return v, rows.Scan(&v.Bucket, &v.Invoices, &v.Students, &v.AmountPaise)
		})
	rollupRespond(w, r, "fee-ageing",
		[]string{"Bucket", "Invoices", "Students", "Amount (Rs)"}, items,
		func(v feeAgeingRow) []string {
			return []string{v.Bucket, intCell(v.Invoices), intCell(v.Students),
				rupeesCell(v.AmountPaise)}
		}, err)
}

type feeConcessionRow struct {
	Kind          string `json:"kind"`
	Students      int    `json:"students"`
	Awards        int    `json:"awards"`
	Pending       int    `json:"pending_approval"`
	GrantedPaise  int64  `json:"granted_amount_paise"`
	PercentAwards int    `json:"percent_awards"`
}

/*
getFeeConcessions is the concession burden by reason.

	Two figures, not one, because they answer different questions. The granted
	amount sums only the absolute awards; percentage awards cannot be added to
	them without knowing each student's bill, so they are counted separately
	rather than silently dropped or wrongly summed. What the school actually
	gave away in the end is invoices.discount_paise, which fee_overview reports
	as the concession total — this screen explains where it came from.
*/
func (s *Server) getFeeConcessions(w http.ResponseWriter, r *http.Request) {
	items, err := rollupList(s, r, `
		SELECT fc.kind,
		       count(DISTINCT fc.student_id),
		       count(*),
		       count(*) FILTER (WHERE fc.approved_at IS NULL),
		       COALESCE(sum(fc.amount_paise) FILTER (WHERE fc.amount_paise IS NOT NULL), 0),
		       count(*) FILTER (WHERE fc.percent IS NOT NULL)
		  FROM fee_concessions fc
		  JOIN academic_years ay ON ay.id = fc.academic_year_id
		 WHERE fc.academic_year_id = COALESCE(
		         (SELECT id FROM academic_years
		           ORDER BY is_current DESC, starts_on DESC LIMIT 1), fc.academic_year_id)
		 GROUP BY fc.kind
		 ORDER BY 5 DESC, fc.kind`, nil,
		func(rows pgx.Rows) (feeConcessionRow, error) {
			var v feeConcessionRow
			return v, rows.Scan(&v.Kind, &v.Students, &v.Awards, &v.Pending,
				&v.GrantedPaise, &v.PercentAwards)
		})
	rollupRespond(w, r, "fee-concessions",
		[]string{"Kind", "Students", "Awards", "Awaiting approval",
			"Absolute awards (Rs)", "Percentage awards"}, items,
		func(v feeConcessionRow) []string {
			return []string{v.Kind, intCell(v.Students), intCell(v.Awards),
				intCell(v.Pending), rupeesCell(v.GrantedPaise), intCell(v.PercentAwards)}
		}, err)
}

// --- 3. institution_admin.standard.fee_collection_summaries ------------------

type collectionDayRow struct {
	Bucket        string `json:"bucket"`
	Receipts      int    `json:"receipts"`
	CashPaise     int64  `json:"cash_paise"`
	ChequePaise   int64  `json:"cheque_paise"`
	OnlinePaise   int64  `json:"online_paise"`
	CardPaise     int64  `json:"card_paise"`
	AdjustedPaise int64  `json:"adjustment_paise"`
	TotalPaise    int64  `json:"total_paise"`
}

/*
getCollectionSummary is the day book: what came in, when, and in what form.

	Modes are folded into the four an Indian school's cash book actually has
	columns for. cheque and dd are one instrument column; upi, neft, netbanking
	and gateway are all "online"; card stands alone because the settlement and
	the charge differ. adjustment is shown apart and excluded from the total,
	because a write-off is an accounting entry and not a rupee that arrived —
	adding it to the day's collection is how a cash book stops tying out.
*/
func (s *Server) getCollectionSummary(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	trunc := "day"
	format := "YYYY-MM-DD"
	if strings.EqualFold(r.URL.Query().Get("group"), "month") {
		trunc, format = "month", "YYYY-MM"
	}
	items, err := rollupList(s, r, `
		SELECT to_char(date_trunc('`+trunc+`', p.paid_on), '`+format+`'),
		       count(*) FILTER (WHERE p.mode <> 'adjustment'),
		       COALESCE(sum(p.amount_paise) FILTER (WHERE p.mode = 'cash'), 0),
		       COALESCE(sum(p.amount_paise) FILTER (WHERE p.mode IN ('cheque','dd')), 0),
		       COALESCE(sum(p.amount_paise) FILTER (
		           WHERE p.mode IN ('upi','neft','netbanking','gateway')), 0),
		       COALESCE(sum(p.amount_paise) FILTER (WHERE p.mode = 'card'), 0),
		       COALESCE(sum(p.amount_paise) FILTER (WHERE p.mode = 'adjustment'), 0),
		       COALESCE(sum(p.amount_paise) FILTER (WHERE p.mode <> 'adjustment'), 0)
		  FROM payments p
		 WHERE p.status = 'success'
		   AND p.paid_on BETWEEN $1::date AND $2::date
		 GROUP BY 1
		 ORDER BY 1`, []any{rng.FromS, rng.ToS},
		func(rows pgx.Rows) (collectionDayRow, error) {
			var v collectionDayRow
			return v, rows.Scan(&v.Bucket, &v.Receipts, &v.CashPaise, &v.ChequePaise,
				&v.OnlinePaise, &v.CardPaise, &v.AdjustedPaise, &v.TotalPaise)
		})
	rollupRespond(w, r, "fee-collections",
		[]string{"Period", "Receipts", "Cash (Rs)", "Cheque/DD (Rs)", "Online (Rs)",
			"Card (Rs)", "Adjustments (Rs)", "Collected (Rs)"}, items,
		func(v collectionDayRow) []string {
			return []string{v.Bucket, intCell(v.Receipts), rupeesCell(v.CashPaise),
				rupeesCell(v.ChequePaise), rupeesCell(v.OnlinePaise),
				rupeesCell(v.CardPaise), rupeesCell(v.AdjustedPaise),
				rupeesCell(v.TotalPaise)}
		}, err)
}

type collectionHeadRow struct {
	Head        string `json:"fee_head"`
	AmountPaise int64  `json:"amount_paise"`
}

/*
getCollectionByHead attributes collections to fee heads.

	A receipt allocates to an invoice, never to a head — there is no
	payment-to-head link in the schema — so each allocation is prorated across
	that invoice's lines in proportion to their net amount. That is an
	apportionment and is labelled as one: it is the only honest answer
	available, and it sums back to the allocated total, which is what makes it
	usable in a report somebody signs.

	Note this ties to allocations, not to receipts: money taken as an advance
	and not yet applied to an invoice belongs to no head yet, and appears in
	the reconciliation below as unallocated rather than being forced somewhere.
*/
func (s *Server) getCollectionByHead(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	items, err := rollupList(s, r, `
		WITH alloc AS (
		    SELECT pa.invoice_id, pa.amount_paise
		      FROM payment_allocations pa
		      JOIN payments p ON p.id = pa.payment_id
		     WHERE p.status = 'success'
		       AND p.mode <> 'adjustment'
		       AND p.paid_on BETWEEN $1::date AND $2::date
		), lines AS (
		    SELECT il.invoice_id, il.fee_head_id,
		           (il.amount_paise - il.discount_paise) AS net,
		           sum(il.amount_paise - il.discount_paise)
		             OVER (PARTITION BY il.invoice_id) AS invoice_net
		      FROM invoice_lines il
		)
		SELECT fh.name,
		       COALESCE(sum(a.amount_paise * l.net / NULLIF(l.invoice_net,0)), 0)::bigint
		  FROM alloc a
		  JOIN lines l     ON l.invoice_id = a.invoice_id
		  JOIN fee_heads fh ON fh.id = l.fee_head_id
		 GROUP BY fh.id, fh.name
		 ORDER BY 2 DESC, fh.name`, []any{rng.FromS, rng.ToS},
		func(rows pgx.Rows) (collectionHeadRow, error) {
			var v collectionHeadRow
			return v, rows.Scan(&v.Head, &v.AmountPaise)
		})
	rollupRespond(w, r, "fee-collections-by-head",
		[]string{"Fee head", "Apportioned collection (Rs)"}, items,
		func(v collectionHeadRow) []string {
			return []string{v.Head, rupeesCell(v.AmountPaise)}
		}, err)
}

type collectorRow struct {
	Collector    string  `json:"collector"`
	Receipts     int     `json:"receipts"`
	CashPaise    int64   `json:"cash_paise"`
	OtherPaise   int64   `json:"other_paise"`
	TotalPaise   int64   `json:"total_paise"`
	FirstReceipt *string `json:"first_receipt,omitempty"`
	LastReceipt  *string `json:"last_receipt,omitempty"`
}

/*
getCollectionByCollector is the counter-wise cash book.

	Cash is split out from everything else because it is the column that has to
	be counted into a bag and handed over at the end of the day; the receipt
	number range is there so the person taking the handover can check the book
	against the drawer without opening the system.
*/
func (s *Server) getCollectionByCollector(w http.ResponseWriter, r *http.Request) {
	rng := resolveRange(r)
	items, err := rollupList(s, r, `
		SELECT COALESCE(u.full_name, 'Unattributed'),
		       count(*),
		       COALESCE(sum(p.amount_paise) FILTER (WHERE p.mode = 'cash'), 0),
		       COALESCE(sum(p.amount_paise) FILTER (WHERE p.mode <> 'cash'), 0),
		       COALESCE(sum(p.amount_paise), 0),
		       min(p.receipt_no), max(p.receipt_no)
		  FROM payments p
		  LEFT JOIN users u ON u.id = p.collected_by
		 WHERE p.status = 'success'
		   AND p.mode <> 'adjustment'
		   AND p.paid_on BETWEEN $1::date AND $2::date
		 GROUP BY u.id, u.full_name
		 ORDER BY 5 DESC`, []any{rng.FromS, rng.ToS},
		func(rows pgx.Rows) (collectorRow, error) {
			var v collectorRow
			return v, rows.Scan(&v.Collector, &v.Receipts, &v.CashPaise, &v.OtherPaise,
				&v.TotalPaise, &v.FirstReceipt, &v.LastReceipt)
		})
	rollupRespond(w, r, "fee-collections-by-collector",
		[]string{"Collected by", "Receipts", "Cash (Rs)", "Other modes (Rs)",
			"Total (Rs)", "First receipt", "Last receipt"}, items,
		func(v collectorRow) []string {
			return []string{v.Collector, intCell(v.Receipts), rupeesCell(v.CashPaise),
				rupeesCell(v.OtherPaise), rupeesCell(v.TotalPaise),
				strCell(v.FirstReceipt), strCell(v.LastReceipt)}
		}, err)
}

type collectionTieOut struct {
	Range             dateRange `json:"range"`
	ReceiptsPaise     int64     `json:"receipts_paise"`
	AllocatedPaise    int64     `json:"allocated_paise"`
	UnallocatedPaise  int64     `json:"unallocated_paise"`
	AdjustmentsPaise  int64     `json:"adjustments_paise"`
	RefundsPaise      int64     `json:"refunds_paise"`
	PendingPaise      int64     `json:"pending_instruments_paise"`
	BouncedPaise      int64     `json:"bounced_paise"`
	FailedCount       int       `json:"failed_count"`
	MissingReceiptNos int       `json:"receipts_without_number"`
	Note              string    `json:"note"`
}

/*
getCollectionTieOut is the control total an auditor checks the day book against.

	The two figures that never match by accident are receipts and allocations:
	a payment may be taken as an advance and left unapplied, so the difference
	is stated explicitly rather than left for somebody to discover. Everything
	that is deliberately excluded from collection — write-offs, refunds,
	uncleared instruments, bounced cheques — is listed with its amount, so the
	exclusions can be verified rather than trusted.
*/
func (s *Server) getCollectionTieOut(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	rng := resolveRange(r)
	out := collectionTieOut{Range: rng,
		Note: "Receipts less allocated is money taken in advance and not yet " +
			"applied to an invoice. Adjustments, refunds, uncleared instruments " +
			"and bounced items are excluded from collection and shown separately."}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT
			  COALESCE((SELECT sum(amount_paise) FROM payments
			             WHERE status='success' AND mode <> 'adjustment'
			               AND paid_on BETWEEN $1::date AND $2::date), 0),
			  COALESCE((SELECT sum(pa.amount_paise) FROM payment_allocations pa
			              JOIN payments p ON p.id = pa.payment_id
			             WHERE p.status='success' AND p.mode <> 'adjustment'
			               AND p.paid_on BETWEEN $1::date AND $2::date), 0),
			  COALESCE((SELECT sum(amount_paise) FROM payments
			             WHERE status='success' AND mode = 'adjustment'
			               AND paid_on BETWEEN $1::date AND $2::date), 0),
			  COALESCE((SELECT sum(amount_paise) FROM refunds
			             WHERE status = 'processed'
			               AND processed_on BETWEEN $1::date AND $2::date), 0),
			  COALESCE((SELECT sum(amount_paise) FROM payments
			             WHERE status='pending'
			               AND paid_on BETWEEN $1::date AND $2::date), 0),
			  COALESCE((SELECT sum(amount_paise) FROM payments
			             WHERE status='bounced'
			               AND paid_on BETWEEN $1::date AND $2::date), 0),
			  (SELECT count(*) FROM payments
			    WHERE status='failed' AND paid_on BETWEEN $1::date AND $2::date),
			  (SELECT count(*) FROM payments
			    WHERE status='success' AND receipt_no IS NULL
			      AND paid_on BETWEEN $1::date AND $2::date)
		`, rng.FromS, rng.ToS).Scan(&out.ReceiptsPaise, &out.AllocatedPaise,
			&out.AdjustmentsPaise, &out.RefundsPaise, &out.PendingPaise,
			&out.BouncedPaise, &out.FailedCount, &out.MissingReceiptNos)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out.UnallocatedPaise = out.ReceiptsPaise - out.AllocatedPaise
	httpx.JSON(w, http.StatusOK, out)
}

// --- 4. institution_admin.department.department_academics --------------------

type deptAcademicsRow struct {
	DepartmentID string   `json:"department_id"`
	Name         string   `json:"name"`
	Head         *string  `json:"head,omitempty"`
	Teachers     int      `json:"teachers"`
	Subjects     int      `json:"subjects"`
	Sections     int      `json:"sections"`
	Periods      int      `json:"weekly_periods"`
	UnitsPlanned int      `json:"syllabus_units_planned"`
	UnitsDone    int      `json:"syllabus_units_delivered"`
	CoveragePct  *float64 `json:"syllabus_coverage_pct,omitempty"`
	AvgScorePct  *float64 `json:"avg_score_pct,omitempty"`
	PassPct      *float64 `json:"pass_pct,omitempty"`
}

/*
deptAcademicsSQL is the department roll-up, as one statement.

	A department owns nothing directly in this schema: subjects carry no
	department, and the only edge that exists is employees.department_id on the
	teacher. So a department's subjects are the subjects its teachers are
	assigned to teach, and everything else follows the same bridge:

	    class_subject -> section_subject_teachers -> employees -> department

	cs_dept collapses that to one department per class-subject before anything
	is counted. Without it, a class-subject taught by three sections would
	multiply every mark by three and report a pass rate over a tripled
	denominator — the fan-out that makes a report quietly wrong rather than
	obviously broken.

	Syllabus coverage uses the same definition as the syllabus screen — a unit
	is covered when some delivered lesson plan names it — so the two agree.
*/
const deptAcademicsSQL = `
WITH cs_dept AS (
    SELECT DISTINCT ON (sst.class_subject_id)
           sst.class_subject_id, e.department_id
      FROM section_subject_teachers sst
      JOIN employees e ON e.user_id = sst.teacher_user_id
     WHERE e.department_id IS NOT NULL
     ORDER BY sst.class_subject_id, e.department_id
), teach AS (
    SELECT e.department_id,
           count(DISTINCT cs.subject_id)  AS subjects,
           count(DISTINCT sst.section_id) AS sections
      FROM section_subject_teachers sst
      JOIN employees      e  ON e.user_id = sst.teacher_user_id
      JOIN class_subjects cs ON cs.id = sst.class_subject_id
     WHERE e.department_id IS NOT NULL
     GROUP BY e.department_id
), load AS (
    SELECT e.department_id, count(*) AS periods
      FROM timetable_entries te
      JOIN employees e ON e.user_id = te.teacher_user_id
     WHERE e.department_id IS NOT NULL
     GROUP BY e.department_id
), syll AS (
    SELECT cd.department_id,
           count(*) AS planned,
           count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM lesson_plan_units lpu
                 JOIN lesson_plans lp ON lp.id = lpu.lesson_plan_id
                WHERE lpu.syllabus_unit_id = su.id
                  AND lp.delivered_on IS NOT NULL)) AS delivered
      FROM cs_dept cd
      JOIN syllabus_units su ON su.class_subject_id = cd.class_subject_id
     WHERE su.is_active
     GROUP BY cd.department_id
), perf AS (
    SELECT cd.department_id,
           round(avg(100.0 * (COALESCE(m.marks_obtained,0) + m.grace_marks)
                     / NULLIF(es.max_marks,0)) FILTER (WHERE NOT m.is_absent), 1) AS avg_pct,
           round(100.0 * count(*) FILTER (
                     WHERE NOT m.is_absent
                       AND (COALESCE(m.marks_obtained,0) + m.grace_marks) >= es.pass_marks)
                 / NULLIF(count(*) FILTER (WHERE NOT m.is_absent), 0), 1) AS pass_pct
      FROM marks m
      JOIN exam_subjects es ON es.id = m.exam_subject_id
      JOIN cs_dept cd       ON cd.class_subject_id = es.class_subject_id
     GROUP BY cd.department_id
)
SELECT d.id::text, d.name, hu.full_name,
       (SELECT count(*) FROM employees e
         WHERE e.department_id = d.id AND e.status = 'active'),
       COALESCE(t.subjects,0), COALESCE(t.sections,0), COALESCE(l.periods,0),
       COALESCE(sy.planned,0), COALESCE(sy.delivered,0),
       pf.avg_pct, pf.pass_pct
  FROM departments d
  LEFT JOIN users hu ON hu.id = d.head_user_id
  LEFT JOIN teach t  ON t.department_id  = d.id
  LEFT JOIN load  l  ON l.department_id  = d.id
  LEFT JOIN syll  sy ON sy.department_id = d.id
  LEFT JOIN perf  pf ON pf.department_id = d.id
 WHERE %s
 ORDER BY d.name`

func (s *Server) getDeptAcademics(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, arg := b.deptPredicate("d.id", 1)
	items, qerr := rollupList(s, r, strings.Replace(deptAcademicsSQL, "%s", pred, 1),
		bindScope(nil, arg),
		func(rows pgx.Rows) (deptAcademicsRow, error) {
			var v deptAcademicsRow
			err := rows.Scan(&v.DepartmentID, &v.Name, &v.Head, &v.Teachers,
				&v.Subjects, &v.Sections, &v.Periods, &v.UnitsPlanned, &v.UnitsDone,
				&v.AvgScorePct, &v.PassPct)
			if err == nil && v.UnitsPlanned > 0 {
				p := round1(100 * float64(v.UnitsDone) / float64(v.UnitsPlanned))
				v.CoveragePct = &p
			}
			return v, err
		})
	rollupRespond(w, r, "department-academics",
		[]string{"Department", "Head", "Teachers", "Subjects", "Sections",
			"Weekly periods", "Units planned", "Units delivered", "Coverage %",
			"Average score %", "Pass %"}, items,
		func(v deptAcademicsRow) []string {
			return []string{v.Name, strCell(v.Head), intCell(v.Teachers),
				intCell(v.Subjects), intCell(v.Sections), intCell(v.Periods),
				intCell(v.UnitsPlanned), intCell(v.UnitsDone), pctCell(v.CoveragePct),
				pctCell(v.AvgScorePct), pctCell(v.PassPct)}
		}, qerr)
}

// --- 5. institution_admin.analysis.department_reports ------------------------

type deptReportRow struct {
	DepartmentID     string   `json:"department_id"`
	Name             string   `json:"name"`
	Teachers         int      `json:"teachers"`
	StaffAttendPct   *float64 `json:"staff_attendance_pct,omitempty"`
	StaffAbsentDays  int      `json:"staff_absent_days"`
	LeaveDays        *float64 `json:"leave_days_taken,omitempty"`
	PeriodsScheduled int      `json:"periods_scheduled"`
	LessonsDelivered int      `json:"lessons_delivered"`
	LessonsPending   int      `json:"lessons_not_delivered"`
	MarksEntered     int      `json:"marks_entered"`
	MarksOutstanding int      `json:"marks_outstanding"`
	PendingLeave     int      `json:"pending_leave_requests"`
}

/*
deptReportSQL is the printable department return for a period.

	Same bridge as department_academics, but every figure is bounded by the
	range rather than being lifetime-to-date: this is the form a head of
	department signs for a term, and a number that silently includes last year
	is worse than no number.

	Marks outstanding is papers sat in the window whose marks are not all in —
	the backlog a department chases — computed as enrolled-minus-entered per
	paper rather than as a flag nobody maintains.
*/
const deptReportSQL = `
WITH cs_dept AS (
    SELECT DISTINCT ON (sst.class_subject_id)
           sst.class_subject_id, e.department_id
      FROM section_subject_teachers sst
      JOIN employees e ON e.user_id = sst.teacher_user_id
     WHERE e.department_id IS NOT NULL
     ORDER BY sst.class_subject_id, e.department_id
), att AS (
    SELECT e.department_id,
           round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late'))
                 / NULLIF(count(*) FILTER (
                     WHERE sa.status NOT IN ('week_off','holiday')), 0), 1) AS pct,
           count(*) FILTER (WHERE sa.status = 'absent') AS absent_days
      FROM staff_attendance sa
      JOIN employees e ON e.user_id = sa.user_id
     WHERE sa.on_date BETWEEN $1::date AND $2::date
       AND e.department_id IS NOT NULL
     GROUP BY e.department_id
), lv AS (
    SELECT e.department_id,
           sum(lr.days) FILTER (WHERE lr.status = 'approved') AS days,
           count(*) FILTER (WHERE lr.status = 'pending')       AS pending
      FROM leave_requests lr
      JOIN employees e ON e.id = lr.employee_id
     WHERE lr.subject_kind = 'staff'
       AND lr.from_date <= $2::date AND lr.to_date >= $1::date
       AND e.department_id IS NOT NULL
     GROUP BY e.department_id
), lp AS (
    SELECT cd.department_id,
           count(*) FILTER (WHERE l.delivered_on IS NOT NULL) AS delivered,
           count(*) FILTER (WHERE l.delivered_on IS NULL)     AS pending
      FROM lesson_plans l
      JOIN cs_dept cd ON cd.class_subject_id = l.class_subject_id
     WHERE l.week_of BETWEEN $1::date - 6 AND $2::date
     GROUP BY cd.department_id
), papers AS (
    SELECT cd.department_id, es.id AS exam_subject_id,
           (SELECT count(*) FROM marks m WHERE m.exam_subject_id = es.id) AS entered,
           (SELECT count(DISTINCT en.student_id)
              FROM class_subjects cs
              JOIN sections sec  ON sec.class_id = cs.class_id
              JOIN enrollments en ON en.section_id = sec.id AND en.status = 'active'
             WHERE cs.id = es.class_subject_id) AS expected
      FROM exam_subjects es
      JOIN cs_dept cd ON cd.class_subject_id = es.class_subject_id
      JOIN exams ex   ON ex.id = es.exam_id
     WHERE COALESCE(es.exam_date, ex.starts_on) BETWEEN $1::date AND $2::date
), mk AS (
    SELECT department_id,
           COALESCE(sum(entered),0) AS entered,
           COALESCE(sum(GREATEST(expected - entered, 0)),0) AS outstanding
      FROM papers GROUP BY department_id
), sched AS (
    SELECT e.department_id, count(*) AS periods
      FROM timetable_entries te
      JOIN employees e ON e.user_id = te.teacher_user_id
     WHERE e.department_id IS NOT NULL
     GROUP BY e.department_id
)
SELECT d.id::text, d.name,
       (SELECT count(*) FROM employees e
         WHERE e.department_id = d.id AND e.status = 'active'),
       att.pct, COALESCE(att.absent_days,0), lv.days,
       COALESCE(sched.periods,0),
       COALESCE(lp.delivered,0), COALESCE(lp.pending,0),
       COALESCE(mk.entered,0), COALESCE(mk.outstanding,0),
       COALESCE(lv.pending,0)
  FROM departments d
  LEFT JOIN att   ON att.department_id   = d.id
  LEFT JOIN lv    ON lv.department_id    = d.id
  LEFT JOIN lp    ON lp.department_id    = d.id
  LEFT JOIN mk    ON mk.department_id    = d.id
  LEFT JOIN sched ON sched.department_id = d.id
 WHERE %s
 ORDER BY d.name`

func (s *Server) getDeptReports(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	rng := resolveRange(r)
	pred, arg := b.deptPredicate("d.id", 3)
	items, qerr := rollupList(s, r, strings.Replace(deptReportSQL, "%s", pred, 1),
		bindScope([]any{rng.FromS, rng.ToS}, arg),
		func(rows pgx.Rows) (deptReportRow, error) {
			var v deptReportRow
			return v, rows.Scan(&v.DepartmentID, &v.Name, &v.Teachers,
				&v.StaffAttendPct, &v.StaffAbsentDays, &v.LeaveDays,
				&v.PeriodsScheduled, &v.LessonsDelivered, &v.LessonsPending,
				&v.MarksEntered, &v.MarksOutstanding, &v.PendingLeave)
		})
	rollupRespond(w, r, "department-reports",
		[]string{"Department", "Teachers", "Staff attendance %", "Absent days",
			"Leave days", "Weekly periods", "Lessons delivered", "Lessons pending",
			"Marks entered", "Marks outstanding", "Leave awaiting decision"}, items,
		func(v deptReportRow) []string {
			return []string{v.Name, intCell(v.Teachers), pctCell(v.StaffAttendPct),
				intCell(v.StaffAbsentDays), pctCell(v.LeaveDays),
				intCell(v.PeriodsScheduled), intCell(v.LessonsDelivered),
				intCell(v.LessonsPending), intCell(v.MarksEntered),
				intCell(v.MarksOutstanding), intCell(v.PendingLeave)}
		}, qerr)
}

// --- 6. institution_admin.analysis.performance_analytics ---------------------

type perfTrendRow struct {
	ExamID    string   `json:"exam_id"`
	ExamName  string   `json:"exam_name"`
	ExamDate  *string  `json:"exam_date,omitempty"`
	ClassName string   `json:"class_name"`
	Students  int      `json:"students"`
	AvgPct    *float64 `json:"avg_pct,omitempty"`
	PassPct   *float64 `json:"pass_pct,omitempty"`
}

/*
getPerfTrend is how each class has moved from one exam to the next.

	Deliberately not exam_grade_analytics, which counts grades within a single
	exam. This is the time series across exams — the shape that shows a class
	sliding two terms in a row, which no single-exam view can.

	Percentages come off exam_subjects.max_marks rather than class_subjects,
	because the paper's ceiling is what the child actually sat; grace marks
	count towards the score, and an absent child is excluded rather than
	scored zero, which would drag a class average down for a fever.
*/
func (s *Server) getPerfTrend(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, arg := b.sectionPredicate("sec.id", 1)
	items, qerr := rollupList(s, r, `
		SELECT ex.id::text, ex.name, to_char(ex.starts_on,'YYYY-MM-DD'), c.name,
		       count(DISTINCT m.student_id),
		       round(avg(100.0 * (COALESCE(m.marks_obtained,0) + m.grace_marks)
		                 / NULLIF(es.max_marks,0)) FILTER (WHERE NOT m.is_absent), 1),
		       round(100.0 * count(*) FILTER (
		                 WHERE NOT m.is_absent
		                   AND (COALESCE(m.marks_obtained,0) + m.grace_marks) >= es.pass_marks)
		             / NULLIF(count(*) FILTER (WHERE NOT m.is_absent), 0), 1)
		  FROM marks m
		  JOIN exam_subjects  es ON es.id = m.exam_subject_id
		  JOIN exams          ex ON ex.id = es.exam_id
		  JOIN class_subjects cs ON cs.id = es.class_subject_id
		  JOIN classes        c  ON c.id = cs.class_id
		  -- Tied to the exam's own year, not to "currently active". A child with
		  -- four years of enrolments would otherwise match four times and every
		  -- average below would be computed over a quadrupled denominator; and
		  -- the class that matters for a past exam is the one they sat it in.
		  JOIN enrollments    en ON en.student_id = m.student_id
		                        AND en.academic_year_id = ex.academic_year_id
		  JOIN sections       sec ON sec.id = en.section_id AND sec.class_id = c.id
		 WHERE `+pred+`
		 GROUP BY ex.id, ex.name, ex.starts_on, c.id, c.name, c.level
		 ORDER BY ex.starts_on NULLS LAST, c.level, c.name`,
		bindScope(nil, arg),
		func(rows pgx.Rows) (perfTrendRow, error) {
			var v perfTrendRow
			return v, rows.Scan(&v.ExamID, &v.ExamName, &v.ExamDate, &v.ClassName,
				&v.Students, &v.AvgPct, &v.PassPct)
		})
	rollupRespond(w, r, "performance-trend",
		[]string{"Exam", "Date", "Class", "Students", "Average %", "Pass %"}, items,
		func(v perfTrendRow) []string {
			return []string{v.ExamName, strCell(v.ExamDate), v.ClassName,
				intCell(v.Students), pctCell(v.AvgPct), pctCell(v.PassPct)}
		}, qerr)
}

type perfSubjectRow struct {
	Subject   string   `json:"subject"`
	Code      string   `json:"code"`
	Papers    int      `json:"papers"`
	Students  int      `json:"students"`
	AvgPct    *float64 `json:"avg_pct,omitempty"`
	PassPct   *float64 `json:"pass_pct,omitempty"`
	FailCount int      `json:"failing"`
	AbsentPct *float64 `json:"absent_pct,omitempty"`
}

// getPerfSubjects ranks subjects by how the school performs in them: the
// strength-and-weakness view, weakest first, which is the order the question
// is actually asked in.
func (s *Server) getPerfSubjects(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, arg := b.deptPredicate("cd.department_id", 1)
	items, qerr := rollupList(s, r, `
		WITH cd AS (
		    SELECT DISTINCT ON (sst.class_subject_id)
		           sst.class_subject_id, e.department_id
		      FROM section_subject_teachers sst
		      JOIN employees e ON e.user_id = sst.teacher_user_id
		     WHERE e.department_id IS NOT NULL
		     ORDER BY sst.class_subject_id, e.department_id
		)
		SELECT sub.name, sub.code,
		       count(DISTINCT es.id), count(DISTINCT m.student_id),
		       round(avg(100.0 * (COALESCE(m.marks_obtained,0) + m.grace_marks)
		                 / NULLIF(es.max_marks,0)) FILTER (WHERE NOT m.is_absent), 1),
		       round(100.0 * count(*) FILTER (
		                 WHERE NOT m.is_absent
		                   AND (COALESCE(m.marks_obtained,0) + m.grace_marks) >= es.pass_marks)
		             / NULLIF(count(*) FILTER (WHERE NOT m.is_absent), 0), 1),
		       count(*) FILTER (WHERE NOT m.is_absent
		                          AND (COALESCE(m.marks_obtained,0) + m.grace_marks) < es.pass_marks),
		       round(100.0 * count(*) FILTER (WHERE m.is_absent) / NULLIF(count(*),0), 1)
		  FROM marks m
		  JOIN exam_subjects  es  ON es.id = m.exam_subject_id
		  JOIN class_subjects cs  ON cs.id = es.class_subject_id
		  JOIN subjects       sub ON sub.id = cs.subject_id
		  LEFT JOIN cd ON cd.class_subject_id = cs.id
		 WHERE `+pred+`
		 GROUP BY sub.id, sub.name, sub.code
		 ORDER BY 5 NULLS LAST, sub.name`,
		bindScope(nil, arg),
		func(rows pgx.Rows) (perfSubjectRow, error) {
			var v perfSubjectRow
			return v, rows.Scan(&v.Subject, &v.Code, &v.Papers, &v.Students,
				&v.AvgPct, &v.PassPct, &v.FailCount, &v.AbsentPct)
		})
	rollupRespond(w, r, "performance-subjects",
		[]string{"Subject", "Code", "Papers", "Students", "Average %", "Pass %",
			"Failing", "Absent %"}, items,
		func(v perfSubjectRow) []string {
			return []string{v.Subject, v.Code, intCell(v.Papers), intCell(v.Students),
				pctCell(v.AvgPct), pctCell(v.PassPct), intCell(v.FailCount),
				pctCell(v.AbsentPct)}
		}, qerr)
}

type perfBandRow struct {
	Band     string   `json:"band"`
	Students int      `json:"students"`
	Marks    int      `json:"mark_entries"`
	SharePct *float64 `json:"share_pct,omitempty"`
}

/*
getPerfDistribution is the spread of results across the school.

	Bands are fixed percentage ranges rather than the configured grading scale.
	grade_bands is per grading scale and a school may run several, so grouping
	by letter would put an A from one scale in the same bucket as an A from
	another that means something different. Percentage is the one axis that
	compares across every scale, and the report says so.
*/
func (s *Server) getPerfDistribution(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, arg := b.sectionPredicate("sec.id", 1)
	items, qerr := rollupList(s, r, `
		WITH scored AS (
		    SELECT m.student_id,
		           100.0 * (COALESCE(m.marks_obtained,0) + m.grace_marks)
		             / NULLIF(es.max_marks,0) AS pct
		      FROM marks m
		      JOIN exam_subjects es ON es.id = m.exam_subject_id
		      JOIN exams         ex ON ex.id = es.exam_id
		      -- The enrolment is here to carry the caller's section scope, and is
		      -- pinned to the exam's year so a child with several years of
		      -- enrolments contributes one row per mark rather than one per year.
		      JOIN enrollments   en ON en.student_id = m.student_id
		                           AND en.academic_year_id = ex.academic_year_id
		      JOIN sections      sec ON sec.id = en.section_id
		     WHERE NOT m.is_absent AND `+pred+`
		), banded AS (
		    SELECT student_id, pct,
		           CASE WHEN pct >= 90 THEN 0 WHEN pct >= 75 THEN 1
		                WHEN pct >= 60 THEN 2 WHEN pct >= 45 THEN 3
		                WHEN pct >= 33 THEN 4 ELSE 5 END AS ord,
		           CASE WHEN pct >= 90 THEN '90-100% Distinction'
		                WHEN pct >= 75 THEN '75-89% First'
		                WHEN pct >= 60 THEN '60-74% Second'
		                WHEN pct >= 45 THEN '45-59% Third'
		                WHEN pct >= 33 THEN '33-44% Pass'
		                ELSE 'Below 33% Fail' END AS band
		      FROM scored WHERE pct IS NOT NULL
		)
		SELECT band, count(DISTINCT student_id), count(*),
		       round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1)
		  FROM banded
		 GROUP BY band, ord
		 ORDER BY ord`,
		bindScope(nil, arg),
		func(rows pgx.Rows) (perfBandRow, error) {
			var v perfBandRow
			return v, rows.Scan(&v.Band, &v.Students, &v.Marks, &v.SharePct)
		})
	rollupRespond(w, r, "performance-distribution",
		[]string{"Band", "Students", "Mark entries", "Share %"}, items,
		func(v perfBandRow) []string {
			return []string{v.Band, intCell(v.Students), intCell(v.Marks),
				pctCell(v.SharePct)}
		}, qerr)
}

type perfAtRiskRow struct {
	StudentID     string   `json:"student_id"`
	AdmissionNo   string   `json:"admission_no"`
	FullName      string   `json:"full_name"`
	ClassName     string   `json:"class_name"`
	SectionName   string   `json:"section_name"`
	Subjects      int      `json:"subjects_assessed"`
	Failing       int      `json:"subjects_failing"`
	AvgPct        *float64 `json:"avg_pct,omitempty"`
	AttendancePct *float64 `json:"attendance_pct,omitempty"`
}

/*
getPerfAtRisk lists the children who are falling behind.

	Two signals, because either alone misleads: an average below the threshold,
	or a failure in any subject. A child averaging 55% while failing
	mathematics is at risk and a single average hides it.

	Attendance rides along because it is almost always the explanation, and
	having to open a second screen to find that out is how a list like this
	stops being used. Daily rows only — student_attendance holds period rows in
	the same table, and counting both double-counts the day.
*/
func (s *Server) getPerfAtRisk(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	threshold := clampInt(r.URL.Query().Get("threshold"), 40, 1, 100)
	pred, arg := b.sectionPredicate("sec.id", 2)
	items, qerr := rollupList(s, r, `
		WITH scored AS (
		    SELECT m.student_id, en.section_id,
		           100.0 * (COALESCE(m.marks_obtained,0) + m.grace_marks)
		             / NULLIF(es.max_marks,0) AS pct,
		           ((COALESCE(m.marks_obtained,0) + m.grace_marks) < es.pass_marks) AS failed,
		           cs.subject_id
		      FROM marks m
		      JOIN exam_subjects  es ON es.id = m.exam_subject_id
		      JOIN class_subjects cs ON cs.id = es.class_subject_id
		      JOIN enrollments    en ON en.student_id = m.student_id AND en.status = 'active'
		      JOIN sections      sec ON sec.id = en.section_id
		     WHERE NOT m.is_absent AND `+pred+`
		), agg AS (
		    SELECT student_id, section_id,
		           count(DISTINCT subject_id) AS subjects,
		           count(DISTINCT subject_id) FILTER (WHERE failed) AS failing,
		           round(avg(pct), 1) AS avg_pct
		      FROM scored GROUP BY student_id, section_id
		)
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       COALESCE(c.name,''), COALESCE(sec.name,''),
		       a.subjects, a.failing, a.avg_pct,
		       (SELECT round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late'))
		                     / NULLIF(count(*),0), 1)
		          FROM student_attendance sa
		         WHERE sa.student_id = st.id AND sa.period_id IS NULL)
		  FROM agg a
		  JOIN students st  ON st.id = a.student_id
		  JOIN sections sec ON sec.id = a.section_id
		  JOIN classes  c   ON c.id = sec.class_id
		 WHERE a.avg_pct < $1 OR a.failing > 0
		 ORDER BY a.failing DESC, a.avg_pct NULLS FIRST
		 LIMIT 200`,
		bindScope([]any{threshold}, arg),
		func(rows pgx.Rows) (perfAtRiskRow, error) {
			var v perfAtRiskRow
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.FullName,
				&v.ClassName, &v.SectionName, &v.Subjects, &v.Failing,
				&v.AvgPct, &v.AttendancePct)
		})
	rollupRespond(w, r, "performance-at-risk",
		[]string{"Admission No", "Student", "Class", "Section", "Subjects assessed",
			"Subjects failing", "Average %", "Attendance %"}, items,
		func(v perfAtRiskRow) []string {
			return []string{v.AdmissionNo, v.FullName, v.ClassName, v.SectionName,
				intCell(v.Subjects), intCell(v.Failing), pctCell(v.AvgPct),
				pctCell(v.AttendancePct)}
		}, qerr)
}

// --- 7. hr.reports.hr_reports ------------------------------------------------

type hrHeadcountRow struct {
	Department  string   `json:"department"`
	Total       int      `json:"total"`
	Teaching    int      `json:"teaching"`
	NonTeaching int      `json:"non_teaching"`
	Permanent   int      `json:"permanent"`
	Contract    int      `json:"contract"`
	Probation   int      `json:"probation"`
	PartTime    int      `json:"part_time"`
	Female      int      `json:"female"`
	Male        int      `json:"male"`
	AvgExp      *float64 `json:"avg_experience_years,omitempty"`
	PostGrad    int      `json:"post_graduate_or_above"`
}

/*
getHRHeadcount is the establishment: who the school employs, by department.

	Teaching versus non-teaching comes from designations.category, which is the
	school's own vocabulary, rather than being inferred from whether somebody
	appears in the timetable — a librarian who covers a period is not thereby
	teaching staff.

	Employees with no department are reported under "Unassigned" rather than
	dropped, because a headcount that does not add up to the payroll is a
	headcount nobody trusts.
*/
func (s *Server) getHRHeadcount(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, arg := b.deptPredicate("e.department_id", 1)
	items, qerr := rollupList(s, r, `
		SELECT COALESCE(d.name, 'Unassigned'),
		       count(*),
		       count(*) FILTER (WHERE dg.category = 'teaching'),
		       count(*) FILTER (WHERE dg.category IS DISTINCT FROM 'teaching'),
		       count(*) FILTER (WHERE e.employment_type = 'permanent'),
		       count(*) FILTER (WHERE e.employment_type = 'contract'),
		       count(*) FILTER (WHERE e.employment_type = 'probation'),
		       count(*) FILTER (WHERE e.employment_type IN ('part_time','visiting')),
		       count(*) FILTER (WHERE e.gender = 'female'),
		       count(*) FILTER (WHERE e.gender = 'male'),
		       round(avg(e.experience_years), 1),
		       count(*) FILTER (WHERE EXISTS (
		           SELECT 1 FROM staff_qualifications q
		            WHERE q.employee_id = e.id
		              AND q.level IN ('post_graduate','doctorate')))
		  FROM employees e
		  LEFT JOIN departments  d  ON d.id = e.department_id
		  LEFT JOIN designations dg ON dg.id = e.designation_id
		 WHERE e.status = 'active' AND `+pred+`
		 GROUP BY d.id, d.name
		 ORDER BY 2 DESC, 1`,
		bindScope(nil, arg),
		func(rows pgx.Rows) (hrHeadcountRow, error) {
			var v hrHeadcountRow
			return v, rows.Scan(&v.Department, &v.Total, &v.Teaching, &v.NonTeaching,
				&v.Permanent, &v.Contract, &v.Probation, &v.PartTime,
				&v.Female, &v.Male, &v.AvgExp, &v.PostGrad)
		})
	rollupRespond(w, r, "hr-headcount",
		[]string{"Department", "Total", "Teaching", "Non-teaching", "Permanent",
			"Contract", "Probation", "Part-time/visiting", "Female", "Male",
			"Average experience (yrs)", "PG or above"}, items,
		func(v hrHeadcountRow) []string {
			return []string{v.Department, intCell(v.Total), intCell(v.Teaching),
				intCell(v.NonTeaching), intCell(v.Permanent), intCell(v.Contract),
				intCell(v.Probation), intCell(v.PartTime), intCell(v.Female),
				intCell(v.Male), pctCell(v.AvgExp), intCell(v.PostGrad)}
		}, qerr)
}

type hrMovementRow struct {
	Month   string `json:"month"`
	Joiners int    `json:"joiners"`
	Leavers int    `json:"leavers"`
	Net     int    `json:"net"`
}

// getHRMovement is joiners and leavers month by month. Leaving is dated from
// relieved_on where it is recorded and from the exit record's last working day
// otherwise, because the two are maintained by different screens and a report
// that reads only one under-counts departures.
func (s *Server) getHRMovement(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	rng := resolveRange(r)
	pred, arg := b.deptPredicate("e.department_id", 3)
	items, qerr := rollupList(s, r, `
		WITH moves AS (
		    SELECT to_char(date_trunc('month', e.joined_on), 'YYYY-MM') AS m, 1 AS j, 0 AS l
		      FROM employees e
		     WHERE e.joined_on BETWEEN $1::date AND $2::date AND `+pred+`
		    UNION ALL
		    SELECT to_char(date_trunc('month',
		             COALESCE(e.relieved_on, x.last_working_day)), 'YYYY-MM'), 0, 1
		      FROM employees e
		      LEFT JOIN LATERAL (
		          SELECT se.last_working_day FROM staff_exits se
		           WHERE se.employee_id = e.id
		           ORDER BY se.created_at DESC LIMIT 1) x ON true
		     WHERE COALESCE(e.relieved_on, x.last_working_day)
		           BETWEEN $1::date AND $2::date AND `+pred+`
		)
		SELECT m, sum(j)::int, sum(l)::int, (sum(j) - sum(l))::int
		  FROM moves GROUP BY m ORDER BY m`,
		bindScope([]any{rng.FromS, rng.ToS}, arg),
		func(rows pgx.Rows) (hrMovementRow, error) {
			var v hrMovementRow
			return v, rows.Scan(&v.Month, &v.Joiners, &v.Leavers, &v.Net)
		})
	rollupRespond(w, r, "hr-movement",
		[]string{"Month", "Joiners", "Leavers", "Net"}, items,
		func(v hrMovementRow) []string {
			return []string{v.Month, intCell(v.Joiners), intCell(v.Leavers),
				intCell(v.Net)}
		}, qerr)
}

type hrAttendanceRow struct {
	EmployeeCode string   `json:"employee_code"`
	FullName     string   `json:"full_name"`
	Department   *string  `json:"department,omitempty"`
	Marked       int      `json:"days_marked"`
	Present      int      `json:"days_present"`
	Absent       int      `json:"days_absent"`
	Late         int      `json:"days_late"`
	OnLeave      int      `json:"days_leave"`
	AttendPct    *float64 `json:"attendance_pct,omitempty"`
	LeaveTaken   *float64 `json:"leave_taken,omitempty"`
	LeaveQuota   *float64 `json:"leave_entitled,omitempty"`
	WeeklyPeriod int      `json:"weekly_periods"`
}

/*
getHRAttendance is the staff register and leave utilisation in one row each.

	Week-offs and holidays are excluded from the denominator: a school running
	a six-day week would otherwise show every teacher at 86% and the number
	would mean nothing. Leave entitlement and leave taken sit beside the
	register because "absent" and "on approved leave" are different facts that
	the same person has to reconcile.
*/
func (s *Server) getHRAttendance(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	rng := resolveRange(r)
	pred, arg := b.deptPredicate("e.department_id", 3)
	items, qerr := rollupList(s, r, `
		SELECT e.employee_code,
		       concat_ws(' ', e.first_name, e.last_name),
		       d.name,
		       count(sa.id) FILTER (WHERE sa.status NOT IN ('week_off','holiday')),
		       count(sa.id) FILTER (WHERE sa.status IN ('present','late')),
		       count(sa.id) FILTER (WHERE sa.status = 'absent'),
		       count(sa.id) FILTER (WHERE sa.status = 'late'),
		       count(sa.id) FILTER (WHERE sa.status = 'leave'),
		       round(100.0 * count(sa.id) FILTER (WHERE sa.status IN ('present','late'))
		             / NULLIF(count(sa.id) FILTER (
		                 WHERE sa.status NOT IN ('week_off','holiday')), 0), 1),
		       (SELECT sum(lb.taken)    FROM leave_balances lb WHERE lb.employee_id = e.id),
		       (SELECT sum(lb.entitled) FROM leave_balances lb WHERE lb.employee_id = e.id),
		       (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = e.user_id)
		  FROM employees e
		  LEFT JOIN departments d ON d.id = e.department_id
		  LEFT JOIN staff_attendance sa ON sa.user_id = e.user_id
		                               AND sa.on_date BETWEEN $1::date AND $2::date
		 WHERE e.status = 'active' AND `+pred+`
		 GROUP BY e.id, e.employee_code, e.first_name, e.last_name, d.name, e.user_id
		 ORDER BY 9 NULLS LAST, e.employee_code`,
		bindScope([]any{rng.FromS, rng.ToS}, arg),
		func(rows pgx.Rows) (hrAttendanceRow, error) {
			var v hrAttendanceRow
			return v, rows.Scan(&v.EmployeeCode, &v.FullName, &v.Department,
				&v.Marked, &v.Present, &v.Absent, &v.Late, &v.OnLeave,
				&v.AttendPct, &v.LeaveTaken, &v.LeaveQuota, &v.WeeklyPeriod)
		})
	rollupRespond(w, r, "hr-attendance",
		[]string{"Code", "Name", "Department", "Days marked", "Present", "Absent",
			"Late", "On leave", "Attendance %", "Leave taken", "Leave entitled",
			"Weekly periods"}, items,
		func(v hrAttendanceRow) []string {
			return []string{v.EmployeeCode, v.FullName, strCell(v.Department),
				intCell(v.Marked), intCell(v.Present), intCell(v.Absent),
				intCell(v.Late), intCell(v.OnLeave), pctCell(v.AttendPct),
				pctCell(v.LeaveTaken), pctCell(v.LeaveQuota), intCell(v.WeeklyPeriod)}
		}, qerr)
}

type hrWorkloadRow struct {
	Band     string   `json:"band"`
	Teachers int      `json:"teachers"`
	SharePct *float64 `json:"share_pct,omitempty"`
}

// getHRWorkload is the shape of the teaching load across the staff room: how
// many people carry how many periods. A distribution rather than a per-teacher
// list, which staff_allocation_workload already provides — the question here
// is whether the load is evenly spread, not who has it.
func (s *Server) getHRWorkload(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	pred, arg := b.deptPredicate("e.department_id", 1)
	items, qerr := rollupList(s, r, `
		WITH per_teacher AS (
		    SELECT e.id,
		           (SELECT count(*) FROM timetable_entries te
		             WHERE te.teacher_user_id = e.user_id) AS periods
		      FROM employees e
		     WHERE e.status = 'active' AND e.user_id IS NOT NULL AND `+pred+`
		), banded AS (
		    SELECT CASE WHEN periods = 0 THEN 0 WHEN periods <= 10 THEN 1
		                WHEN periods <= 20 THEN 2 WHEN periods <= 30 THEN 3
		                ELSE 4 END AS ord,
		           CASE WHEN periods = 0 THEN 'No timetabled periods'
		                WHEN periods <= 10 THEN '1-10 periods'
		                WHEN periods <= 20 THEN '11-20 periods'
		                WHEN periods <= 30 THEN '21-30 periods'
		                ELSE 'Over 30 periods' END AS band
		      FROM per_teacher
		)
		SELECT band, count(*)::int,
		       round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1)
		  FROM banded GROUP BY band, ord ORDER BY ord`,
		bindScope(nil, arg),
		func(rows pgx.Rows) (hrWorkloadRow, error) {
			var v hrWorkloadRow
			return v, rows.Scan(&v.Band, &v.Teachers, &v.SharePct)
		})
	rollupRespond(w, r, "hr-workload",
		[]string{"Weekly load", "Teachers", "Share %"}, items,
		func(v hrWorkloadRow) []string {
			return []string{v.Band, intCell(v.Teachers), pctCell(v.SharePct)}
		}, qerr)
}

type hrExpiryRow struct {
	EmployeeCode string  `json:"employee_code"`
	FullName     string  `json:"full_name"`
	Department   *string `json:"department,omitempty"`
	Kind         string  `json:"kind"`
	Detail       string  `json:"detail"`
	ExpiresOn    string  `json:"expires_on"`
	DaysLeft     int     `json:"days_left"`
}

/*
getHRExpiries is what has to be renewed, and what has already lapsed.

	There is no contract-end column on employees — nothing in the schema
	carries one — so rather than invent a field and leave it empty, this reads
	the dated records the school already keeps: the end of a deputation, the
	last working day once notice is served, and the validity of the medical,
	police and qualification papers an inspection asks for. Anything already
	past shows a negative days-left rather than being hidden, because a lapsed
	police verification is more urgent than one expiring next month.
*/
func (s *Server) getHRExpiries(w http.ResponseWriter, r *http.Request) {
	b, err := s.resolveRollupScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	within := clampInt(r.URL.Query().Get("within_days"), 90, 1, 730)
	pred, arg := b.deptPredicate("e.department_id", 2)
	items, qerr := rollupList(s, r, `
		WITH ex AS (
		    SELECT st.employee_id, st.kind, st.detail, st.expires_on FROM (
		        SELECT t.employee_id, 'Deputation / transfer' AS kind,
		               COALESCE(t.order_no,'—') AS detail, t.effective_to AS expires_on
		          FROM staff_transfers t WHERE t.effective_to IS NOT NULL
		        UNION ALL
		        SELECT se.employee_id, 'Notice served',
		               COALESCE(se.kind,'exit'), se.last_working_day
		          FROM staff_exits se WHERE se.last_working_day IS NOT NULL
		        UNION ALL
		        SELECT m.employee_id, 'Medical fitness',
		               COALESCE(m.purpose,'—'), m.valid_until
		          FROM medical_fitness_certificates m WHERE m.valid_until IS NOT NULL
		        UNION ALL
		        SELECT bv.employee_id, 'Background verification',
		               COALESCE(bv.kind,'—'), bv.valid_until
		          FROM background_verifications bv WHERE bv.valid_until IS NOT NULL
		        UNION ALL
		        SELECT q.employee_id, 'Qualification / registration',
		               COALESCE(q.qualification,'—'), q.valid_until
		          FROM staff_qualifications q WHERE q.valid_until IS NOT NULL
		    ) st
		)
		SELECT e.employee_code, concat_ws(' ', e.first_name, e.last_name), d.name,
		       ex.kind, ex.detail, to_char(ex.expires_on,'YYYY-MM-DD'),
		       (ex.expires_on - CURRENT_DATE)::int
		  FROM ex
		  JOIN employees e ON e.id = ex.employee_id
		  LEFT JOIN departments d ON d.id = e.department_id
		 WHERE e.status = 'active'
		   AND ex.expires_on <= CURRENT_DATE + $1::int
		   AND `+pred+`
		 ORDER BY ex.expires_on, e.employee_code`,
		bindScope([]any{within}, arg),
		func(rows pgx.Rows) (hrExpiryRow, error) {
			var v hrExpiryRow
			return v, rows.Scan(&v.EmployeeCode, &v.FullName, &v.Department,
				&v.Kind, &v.Detail, &v.ExpiresOn, &v.DaysLeft)
		})
	rollupRespond(w, r, "hr-expiries",
		[]string{"Code", "Name", "Department", "Renewal", "Detail", "Expires on",
			"Days left"}, items,
		func(v hrExpiryRow) []string {
			return []string{v.EmployeeCode, v.FullName, strCell(v.Department),
				v.Kind, v.Detail, v.ExpiresOn, intCell(v.DaysLeft)}
		}, qerr)
}

// --- mount -------------------------------------------------------------------

/*
mountAdminRollups registers the seven administrative reporting screens.

	Call it from the top-level /api/v1 group in api.go — everything below is a
	relative path under /rollups, so it does not care where in the tree it is
	spliced as long as the session middleware is above it. It carries no
	group-level permission on purpose: each route names the right that makes
	its own numbers meaningful, so a head of department can read their academic
	returns without thereby reading the fee ledger.

	Permission choices worth stating, all reusing keys already in
	internal/rbac/rbac.go — none was invented:

	  admin.reports.read      the reporting screens themselves
	  finance.invoices.read   anything showing what is owed or outstanding
	  finance.payments.read   the day book and its control totals
	  hr.employees.read       the establishment, the register, renewals

	The two are separated because a head of department holds admin.reports.read
	and must not thereby acquire the school's collections.
*/
func (s *Server) mountAdminRollups(r chi.Router) {
	reports := httpx.RequirePermission(rbac.ReportsRead)
	invoices := httpx.RequirePermission(rbac.InvoicesRead)
	payments := httpx.RequirePermission(rbac.PaymentsRead)
	staff := httpx.RequirePermission(rbac.EmployeesRead)

	r.Route("/rollups", func(r chi.Router) {
		// The principal's day. Reads widely, so it is gated on the reporting
		// right and then narrows each block to what the caller may actually
		// see — the money panel is omitted for somebody without finance rights
		// rather than being blanked in the browser.
		r.With(reports).Get("/today", s.getToday)

		// Fees, one level above the finance module's operational screens.
		r.With(invoices).Get("/fees/overview", s.getFeeOverview)
		r.With(invoices).Get("/fees/ageing", s.getFeeAgeing)
		r.With(invoices).Get("/fees/concessions", s.getFeeConcessions)

		// The day book an accountant prints and signs.
		r.With(payments).Get("/fees/collections", s.getCollectionSummary)
		r.With(payments).Get("/fees/collections/by-head", s.getCollectionByHead)
		r.With(payments).Get("/fees/collections/by-collector", s.getCollectionByCollector)
		r.With(payments).Get("/fees/collections/tie-out", s.getCollectionTieOut)

		// Departments: the standing picture, and the periodic return.
		r.With(reports).Get("/departments/academics", s.getDeptAcademics)
		r.With(reports).Get("/departments/reports", s.getDeptReports)

		// Performance over time, complementing exam_grade_analytics rather
		// than repeating it.
		r.With(reports).Get("/performance/trend", s.getPerfTrend)
		r.With(reports).Get("/performance/subjects", s.getPerfSubjects)
		r.With(reports).Get("/performance/distribution", s.getPerfDistribution)
		r.With(reports).Get("/performance/at-risk", s.getPerfAtRisk)

		// HR.
		r.With(staff).Get("/hr/headcount", s.getHRHeadcount)
		r.With(staff).Get("/hr/movement", s.getHRMovement)
		r.With(staff).Get("/hr/attendance", s.getHRAttendance)
		r.With(staff).Get("/hr/workload", s.getHRWorkload)
		r.With(staff).Get("/hr/expiries", s.getHRExpiries)
	})
}
