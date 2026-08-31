package api

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/*
Needs attention: the one question every role opens the product to ask.

A catalogue answers "what can I do here". Nobody signs in to ask that. A
principal wants to know that 42 report cards are waiting on them, a class
teacher that 8-B has no register today, a parent that ₹18,500 is due on the
tenth — and each of those is the same question asked from a different chair.

So it is one engine, not seventeen dashboards. Each probe below declares the
permission it needs and the scope it runs under; the caller's own scope narrows
the rows. A teacher's "attendance not marked" counts their sections, a vice
principal's counts the school, and neither query knows which one it is running
for — internal/scope decided that before the SQL was built.

Every item carries somewhere to go. An attention item with no action is a
notification, and a notification a person cannot act on is noise they learn to
scroll past.
*/

// Severity orders the list and colours it. It is deliberately coarse: three
// levels a person can act on, rather than a priority number nobody can rank.
type Severity string

const (
	// SeverityCritical is money, safety or a statutory deadline already missed.
	SeverityCritical Severity = "critical"
	// SeverityWarning is work that is late but recoverable today.
	SeverityWarning Severity = "warning"
	// SeverityInfo is worth knowing and nothing is on fire.
	SeverityInfo Severity = "info"
)

var severityRank = map[Severity]int{SeverityCritical: 0, SeverityWarning: 1, SeverityInfo: 2}

// AttentionItem is one line of the panel.
type AttentionItem struct {
	Key      string   `json:"key"`
	Severity Severity `json:"severity"`
	// Count is the number of things needing action. Zero-count items are never
	// emitted: "0 payments failed" is a line of reassurance that costs a line
	// of attention, and a panel of them trains people to stop reading it.
	Count int `json:"count"`
	// Headline reads as a sentence with the count already in it, because
	// "18 students absent today" is a fact and "Students absent: 18" is a form
	// field.
	Headline string `json:"headline"`
	Detail   string `json:"detail,omitempty"`
	// Action is the verb, not the destination: "Arrange substitute", not
	// "Staff attendance".
	Action string `json:"action"`
	Href   string `json:"href,omitempty"`
	// Amount is set for money items, in paise, so the client formats one way.
	AmountPaise int64 `json:"amount_paise,omitempty"`
	// Total is the denominator Count was drawn from: 3 sections unmarked out of
	// 41 is a different morning from 3 out of 4. It is a pointer because a
	// probe that has no honest denominator must send nothing at all — a zero
	// total is indistinguishable on the wire from a real one, and a card that
	// renders "3 of 0" or divides by it is the bug this shape exists to
	// prevent.
	Total *int `json:"total,omitempty"`
	// Breakdown splits Count into the parts the same query already knew: the
	// admissions funnel by stage, overdue fees by age. Omitted, never empty,
	// for the same reason as Total.
	Breakdown []AttentionBucket `json:"breakdown,omitempty"`
}

// AttentionBucket is one slice of an item's Count — a funnel stage, an ageing
// band. The label is rendered server-side because the split is the database's
// vocabulary and the client should not be maintaining a second copy of it.
type AttentionBucket struct {
	Label string `json:"label"`
	Count int    `json:"count"`
}

type attentionResponse struct {
	Role    string          `json:"role"`
	Items   []AttentionItem `json:"items"`
	Summary []summaryStat   `json:"summary"`
	// Greeting is the time of day, resolved server-side so every client agrees
	// with the school's timezone rather than the device's.
	Greeting string `json:"greeting"`
}

// summaryStat is the "today's school" strip: what happened, not what is wrong.
type summaryStat struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Hint  string `json:"hint,omitempty"`
	// "good" where the hint is the answer somebody wanted — every register
	// taken, nothing outstanding. Empty for a fact that is merely a fact.
	// Never "bad": what is wrong belongs in the attention panel above, and a
	// strip that alarms is the dashboard this replaced.
	Tone string `json:"tone,omitempty"`
}

/*
probeResult is everything a probe found.

	A probe used to return (count, amount, detail) and nothing else, which is
	why fifteen cells on the principal's board could only ever print a number:
	no proportion, no ageing, no funnel. The extra two fields are optional on
	purpose — Total and Breakdown are filled in only where the probe's own
	query already scans the rows they describe, so no cell costs a second
	round trip and no denominator is invented to fill a hole in a layout.
*/
type probeResult struct {
	Count  int
	Amount int64
	Detail string
	// Total is the denominator, nil when the probe has none to give.
	Total *int
	// Breakdown is nil unless the query produced a real split.
	Breakdown []AttentionBucket
}

// plain wraps the common "just a count" probe so the ones with nothing more to
// say stay one line: return plain(countQuery(...)).
func plain(n int, err error) (probeResult, error) {
	return probeResult{Count: n}, err
}

// total is a helper for the denominators below; taking the address of a local
// in each probe would be six identical three-line dances.
func total(n int) *int { return &n }

// probe is one attention query.
//
// Needs is the permission that makes the question meaningful to the caller.
// Run returns the count, an optional amount and detail line, and — where the
// query already knew them — a denominator and a breakdown; a zero count drops
// the item before it reaches the response.
type probe struct {
	Key      string
	Needs    string
	Severity Severity
	Action   string
	Href     string
	Run      func(ctx context.Context, tx pgx.Tx, sc *scope.Resolved) (probeResult, error)
	// Headline renders the count. Kept as a function so plural and singular
	// read properly — "1 students absent" is the tell of a generated screen.
	Headline func(n int, amount int64) string
}

// plural lives in faculty_work.go and already renders the count with the noun,
// so every headline below reads "3 sections without attendance today" rather
// than being assembled from a format string and a bare word.

// rupees renders paise the way an Indian school reads money: ₹4.26L, ₹1.84Cr.
func rupees(paise int64) string {
	r := float64(paise) / 100
	switch {
	case r >= 1e7:
		return fmt.Sprintf("₹%.2fCr", r/1e7)
	case r >= 1e5:
		return fmt.Sprintf("₹%.2fL", r/1e5)
	case r >= 1000:
		return fmt.Sprintf("₹%.1fK", r/1000)
	default:
		return fmt.Sprintf("₹%.0f", r)
	}
}

// countQuery runs a single-row count, applying no scope of its own.
func countQuery(ctx context.Context, tx pgx.Tx, sql string, args ...any) (int, error) {
	var n int
	err := tx.QueryRow(ctx, sql, args...).Scan(&n)
	return n, err
}

/*
probes is the whole vocabulary of "something needs doing".

	Ordered by the shape of a school day rather than by module, because the
	panel is read top to bottom by someone deciding what to do next: the
	register first, then money, then the queues other people are blocked on.
*/
var probes = []probe{
	// --- the register -----------------------------------------------------
	{
		Key: "attendance.unmarked", Needs: rbac.AttendanceWrite,
		Severity: SeverityWarning, Action: "Mark attendance", Href: "attendance",
		Headline: func(n int, _ int64) string {
			return plural(n, "section", "sections") + " without attendance today"
		},
		Run: func(ctx context.Context, tx pgx.Tx, sc *scope.Resolved) (probeResult, error) {
			// Sections the caller can mark, minus the ones already marked. A
			// section with a holiday row counts as marked; that is what a
			// holiday is.
			pred, arg := "TRUE", any(nil)
			if !sc.AnySection {
				pred, arg = "s.id = ANY($1)", sc.SectionIDs
			}
			sql := `
				SELECT count(*) FROM sections s
				 WHERE ` + pred + `
				   AND NOT EXISTS (
				       SELECT 1 FROM student_attendance sa
				        WHERE sa.section_id = s.id AND sa.on_date = CURRENT_DATE)
				   AND EXISTS (
				       SELECT 1 FROM enrollments e
				        WHERE e.section_id = s.id AND e.status = 'active')`
			var n int
			var err error
			if arg == nil {
				n, err = countQuery(ctx, tx, sql)
			} else {
				n, err = countQuery(ctx, tx, sql, arg)
			}
			return probeResult{Count: n}, err
		},
	},
	{
		Key: "attendance.absent_today", Needs: rbac.AttendanceRead,
		Severity: SeverityInfo, Action: "View register", Href: "attendance",
		Headline: func(n int, _ int64) string {
			return plural(n, "student", "students") + " absent today"
		},
		Run: func(ctx context.Context, tx pgx.Tx, sc *scope.Resolved) (probeResult, error) {
			pred, args := sc.AttendancePredicate("sa", 1)
			n, err := countQuery(ctx, tx, `
				SELECT count(*) FROM student_attendance sa
				 WHERE sa.on_date = CURRENT_DATE
				   AND sa.status IN ('absent','leave')
				   AND `+pred, args...)
			return probeResult{Count: n}, err
		},
	},
	{
		Key: "attendance.corrections", Needs: rbac.AttendanceWriteAny,
		Severity: SeverityWarning, Action: "Review", Href: "approvals",
		Headline: func(n int, _ int64) string {
			return plural(n, "attendance correction", "attendance corrections") + " awaiting review"
		},
		Run: func(ctx context.Context, tx pgx.Tx, _ *scope.Resolved) (probeResult, error) {
			n, err := countQuery(ctx, tx,
				`SELECT count(*) FROM attendance_corrections WHERE status = 'pending'`)
			return probeResult{Count: n}, err
		},
	},
	{
		Key: "staff.absent_today", Needs: rbac.EmployeesRead,
		Severity: SeverityWarning, Action: "Arrange substitute", Href: "staff",
		Headline: func(n int, _ int64) string {
			return plural(n, "teacher", "teachers") + " absent today"
		},
		Run: func(ctx context.Context, tx pgx.Tx, _ *scope.Resolved) (probeResult, error) {
			// Absent and unsubstituted. A covered absence is not a problem, and
			// listing it as one is how a panel earns its reputation for crying
			// wolf.
			n, err := countQuery(ctx, tx, `
				SELECT count(*) FROM staff_attendance sa
				 WHERE sa.on_date = CURRENT_DATE
				   AND sa.status IN ('absent','leave')
				   AND NOT EXISTS (
				       SELECT 1 FROM substitutions su
				        JOIN timetable_entries te ON te.id = su.timetable_entry_id
				        WHERE su.on_date = CURRENT_DATE
				          AND te.teacher_user_id = sa.user_id)`)
			return probeResult{Count: n}, err
		},
	},

	// --- money ------------------------------------------------------------
	{
		Key: "fees.overdue", Needs: rbac.InvoicesRead,
		/* The list, not the counter.

		   "fees" matched Take fee payment first — a counter that asks for one
		   student's name — so the one row telling an accountant that ₹23.7K is
		   overdue sent them to a search box with nothing to search for. The
		   defaulters list is where the money is, by section and by family. */
		Severity: SeverityCritical, Action: "Review",
		Href: "unpaid_fees_reminders student_dues fees",
		Headline: func(n int, amount int64) string {
			return rupees(amount) + " overdue across " + plural(n, "student", "students")
		},
		Run: func(ctx context.Context, tx pgx.Tx, sc *scope.Resolved) (probeResult, error) {
			pred, args := sc.StudentPredicate("st", 1)
			var n int
			var amount *int64
			err := tx.QueryRow(ctx, `
				SELECT count(DISTINCT i.student_id),
				       COALESCE(sum(i.net_paise - i.paid_paise), 0)
				  FROM invoices i
				  JOIN students st ON st.id = i.student_id
				 WHERE i.status IN ('unpaid','partial','overdue')
				   AND i.due_on < CURRENT_DATE
				   AND `+pred, args...).Scan(&n, &amount)
			var a int64
			if amount != nil {
				a = *amount
			}
			return probeResult{Count: n, Amount: a}, err
		},
	},
	{
		Key: "payments.failed", Needs: rbac.PaymentsRead,
		Severity: SeverityCritical, Action: "Retry or reconcile", Href: "payments",
		Headline: func(n int, _ int64) string {
			return plural(n, "payment", "payments") + " failed in the last week"
		},
		Run: func(ctx context.Context, tx pgx.Tx, _ *scope.Resolved) (probeResult, error) {
			n, err := countQuery(ctx, tx, `
				SELECT count(*) FROM payments
				 WHERE status = 'failed'
				   AND created_at >= CURRENT_DATE - INTERVAL '7 days'`)
			return probeResult{Count: n}, err
		},
	},
	{
		Key: "payments.bounced", Needs: rbac.PaymentsRead,
		Severity: SeverityCritical, Action: "Raise fine", Href: "payments",
		Headline: func(n int, _ int64) string {
			return plural(n, "cheque", "cheques") + " bounced"
		},
		Run: func(ctx context.Context, tx pgx.Tx, _ *scope.Resolved) (probeResult, error) {
			n, err := countQuery(ctx, tx,
				`SELECT count(*) FROM payments WHERE status = 'bounced'`)
			return probeResult{Count: n}, err
		},
	},
	{
		Key: "fees.concessions_pending", Needs: rbac.FeesWrite,
		Severity: SeverityWarning, Action: "Approve", Href: "approvals",
		Headline: func(n int, _ int64) string {
			return plural(n, "concession request", "concession requests") + " awaiting approval"
		},
		Run: func(ctx context.Context, tx pgx.Tx, _ *scope.Resolved) (probeResult, error) {
			n, err := countQuery(ctx, tx,
				`SELECT count(*) FROM fee_concessions WHERE approved_by IS NULL`)
			return probeResult{Count: n}, err
		},
	},

	// --- admissions -------------------------------------------------------
	{
		Key: "admissions.applications", Needs: rbac.AdmissionsRead,
		Severity: SeverityWarning, Action: "Review", Href: "admissions",
		Headline: func(n int, _ int64) string {
			return plural(n, "admission application", "admission applications") + " waiting on a decision"
		},
		Run: func(ctx context.Context, tx pgx.Tx, _ *scope.Resolved) (probeResult, error) {
			n, err := countQuery(ctx, tx, `
				SELECT count(*) FROM applications
				 WHERE status IN ('submitted','under_review','test_scheduled','interviewed')`)
			return probeResult{Count: n}, err
		},
	},
	{
		Key: "admissions.documents", Needs: rbac.AdmissionsRead,
		Severity: SeverityWarning, Action: "Chase documents", Href: "admissions",
		Headline: func(n int, _ int64) string {
			return plural(n, "applicant", "applicants") + " stuck on missing documents"
		},
		Run: func(ctx context.Context, tx pgx.Tx, _ *scope.Resolved) (probeResult, error) {
			n, err := countQuery(ctx, tx,
				`SELECT count(*) FROM applications WHERE status = 'documents_pending'`)
			return probeResult{Count: n}, err
		},
	},
	{
		Key: "admissions.followups", Needs: rbac.AdmissionsRead,
		Severity: SeverityWarning, Action: "Call", Href: "admissions",
		Headline: func(n int, _ int64) string {
			return plural(n, "follow-up", "follow-ups") + " overdue"
		},
		Run: func(ctx context.Context, tx pgx.Tx, _ *scope.Resolved) (probeResult, error) {
			n, err := countQuery(ctx, tx, `
				SELECT count(*) FROM enquiries
				 WHERE next_follow_up IS NOT NULL
				   AND next_follow_up <= CURRENT_DATE
				   AND status NOT IN ('applied','lost')`)
			return probeResult{Count: n}, err
		},
	},

	// --- queues other people are blocked on -------------------------------
	{
		Key: "leave.pending", Needs: rbac.LeaveApprove,
		Severity: SeverityWarning, Action: "Approve", Href: "approvals",
		Headline: func(n int, _ int64) string {
			return plural(n, "leave request", "leave requests") + " pending"
		},
		Run: func(ctx context.Context, tx pgx.Tx, _ *scope.Resolved) (probeResult, error) {
			n, err := countQuery(ctx, tx,
				`SELECT count(*) FROM leave_requests WHERE status = 'pending'`)
			return probeResult{Count: n}, err
		},
	},
	{
		Key: "reportcards.unpublished", Needs: rbac.ReportCardsGenerate,
		// Named for every workspace that keeps this screen, because they do not
		// agree: a class teacher's is report_cards, a head's is exams_results.
		Severity: SeverityWarning, Action: "Review and publish",
		Href: "report_cards exams_results marks",
		Headline: func(n int, _ int64) string {
			return plural(n, "report card", "report cards") + " awaiting publication"
		},
		Run: func(ctx context.Context, tx pgx.Tx, sc *scope.Resolved) (probeResult, error) {
			pred, args := sc.StudentPredicate("st", 1)
			n, err := countQuery(ctx, tx, `
				SELECT count(*) FROM report_cards rc
				  JOIN students st ON st.id = rc.student_id
				 WHERE NOT rc.is_published AND `+pred, args...)
			return probeResult{Count: n}, err
		},
	},
	{
		Key: "marks.pending", Needs: rbac.MarksWrite,
		Severity: SeverityWarning, Action: "Enter marks", Href: "marks",
		Headline: func(n int, _ int64) string {
			return plural(n, "exam paper", "exam papers") + " without marks"
		},
		Run: func(ctx context.Context, tx pgx.Tx, sc *scope.Resolved) (probeResult, error) {
			// Papers already sat, with nothing entered. A paper mid-exam is not
			// late; one whose date has passed is.
			// A paper belongs to a class, not to a section — class_subjects
			// carries class_id — so a teacher's own papers are the ones whose
			// class contains a section they teach.
			pred, arg := "TRUE", any(nil)
			if !sc.AllStudents {
				pred, arg = `EXISTS (SELECT 1 FROM sections sn
				                      WHERE sn.class_id = cs.class_id
				                        AND sn.id = ANY($1))`, sc.SectionIDs
			}
			sql := `
				SELECT count(*) FROM exam_subjects es
				  JOIN class_subjects cs ON cs.id = es.class_subject_id
				 WHERE es.exam_date IS NOT NULL
				   AND es.exam_date < CURRENT_DATE
				   AND ` + pred + `
				   AND NOT EXISTS (
				       SELECT 1 FROM marks m WHERE m.exam_subject_id = es.id)`
			var n int
			var err error
			if arg == nil {
				n, err = countQuery(ctx, tx, sql)
			} else {
				n, err = countQuery(ctx, tx, sql, arg)
			}
			return probeResult{Count: n}, err
		},
	},
	{
		Key: "certificates.requested", Needs: rbac.StudentsWrite,
		/* The screen that issues one, not the section it lives in.

		   "students" matched Student 360 first — a screen about one child,
		   which cannot issue anything — and for a role whose workspace has no
		   feature with "students" in its slug it matched nothing at all, so the
		   row sat there with nothing to press. */
		Severity: SeverityInfo, Action: "Issue",
		Href: "certificates_transfers certificates students",
		Headline: func(n int, _ int64) string {
			return plural(n, "certificate request", "certificate requests") + " to issue"
		},
		Run: func(ctx context.Context, tx pgx.Tx, _ *scope.Resolved) (probeResult, error) {
			n, err := countQuery(ctx, tx,
				`SELECT count(*) FROM issued_certificates WHERE status = 'requested'`)
			return probeResult{Count: n}, err
		},
	},

	// --- the family side --------------------------------------------------
	{
		Key: "self.fees_due", Needs: rbac.SelfFeesRead,
		/* "Open", not "Pay now".

		   A dashboard row cannot take a payment: it can only put somebody on
		   the fees screen, where the amount, the instalments and the Pay now
		   button actually are. A button labelled with an action it does not
		   perform is a button that is pressed once and distrusted afterwards. */
		Severity: SeverityCritical, Action: "Open", Href: "fees",
		Headline: func(_ int, amount int64) string {
			return fmt.Sprintf("%s due", rupees(amount))
		},
		Run: func(ctx context.Context, tx pgx.Tx, sc *scope.Resolved) (probeResult, error) {
			if len(sc.StudentIDs) == 0 {
				return probeResult{}, nil
			}
			var n int
			var amount *int64
			var due *string
			err := tx.QueryRow(ctx, `
				SELECT count(*), COALESCE(sum(net_paise - paid_paise), 0),
				       to_char(min(due_on), 'DD Mon')
				  FROM invoices
				 WHERE student_id = ANY($1)
				   AND status IN ('unpaid','partial','overdue')`, sc.StudentIDs).
				Scan(&n, &amount, &due)
			var a int64
			if amount != nil {
				a = *amount
			}
			detail := ""
			if due != nil {
				detail = "Due by " + *due
			}
			return probeResult{Count: n, Amount: a, Detail: detail}, err
		},
	},
	{
		Key: "self.homework_due", Needs: rbac.SelfProfileRead,
		Severity: SeverityWarning, Action: "Open homework", Href: "homework",
		Headline: func(n int, _ int64) string {
			return plural(n, "piece", "pieces") + " of homework still to hand in"
		},
		/* Everything still owed, not the single day that happens to be
		   tomorrow.

		   This probe asked for `due_on = CURRENT_DATE + 1`, so a child with a
		   fortnight of unfinished work and nothing due precisely tomorrow was
		   told they had nothing outstanding — and on most days that is every
		   child, which is how a reminders panel comes to be ignored. It also
		   counted work already handed in, so finishing a piece did not make it
		   go away. */
		Run: func(ctx context.Context, tx pgx.Tx, sc *scope.Resolved) (probeResult, error) {
			if len(sc.StudentIDs) == 0 {
				return probeResult{}, nil
			}
			var n int
			var soonest *string
			err := tx.QueryRow(ctx, `
				SELECT count(*), to_char(min(h.due_on), 'DD Mon')
				  FROM homework h
				  JOIN enrollments e ON e.section_id = h.section_id
				                    AND e.student_id = ANY($1)
				                    AND e.status = 'active'
				 WHERE h.is_published
				   AND h.due_on >= CURRENT_DATE
				   AND NOT EXISTS (SELECT 1 FROM homework_submissions sub
				                    WHERE sub.homework_id = h.id
				                      AND sub.student_id = e.student_id)`,
				sc.StudentIDs).Scan(&n, &soonest)
			detail := ""
			if soonest != nil {
				detail = "Soonest due " + *soonest
			}
			return probeResult{Count: n, Detail: detail}, err
		},
	},
}

// getAttention answers "what needs me" for the signed-in caller.
func (s *Server) getAttention(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sc, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	out := attentionResponse{
		Role:     r.URL.Query().Get("role"),
		Greeting: greeting(),
		Items:    []AttentionItem{},
		Summary:  []summaryStat{},
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, p := range probes {
			if !id.Can(p.Needs) {
				continue
			}
			res, err := p.Run(r.Context(), tx, sc)
			if err != nil {
				// One broken probe must not blank the panel. A school with no
				// transport module still wants to know its fees are overdue.
				return fmt.Errorf("attention probe %s: %w", p.Key, err)
			}
			if res.Count == 0 {
				continue
			}
			out.Items = append(out.Items, AttentionItem{
				Key: p.Key, Severity: p.Severity, Count: res.Count,
				Headline: p.Headline(res.Count, res.Amount), Detail: res.Detail,
				Action: p.Action, Href: p.Href, AmountPaise: res.Amount,
				Total: res.Total, Breakdown: res.Breakdown,
			})
		}
		var err error
		out.Summary, err = todaySummary(r.Context(), tx, id, sc)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	sort.SliceStable(out.Items, func(a, b int) bool {
		return severityRank[out.Items[a].Severity] < severityRank[out.Items[b].Severity]
	})
	httpx.JSON(w, http.StatusOK, out)
}

/*
todaySummary is the "today's school" strip — what happened, not what is wrong.

	Kept apart from the attention items on purpose. Mixing the two produces the
	dashboard this replaces, where "Total students 1,482" sits beside "3 buses
	delayed" as though they were the same kind of fact and both were equally
	worth a glance.
*/
func todaySummary(ctx context.Context, tx pgx.Tx, id *httpx.Identity, sc *scope.Resolved) ([]summaryStat, error) {
	// Empty, not nil. A nil slice marshals to JSON null, and every caller of
	// this endpoint reads .length off it — a parent holds none of the five
	// permissions below, so for the two roles that always take that path the
	// panel threw on load and blanked the whole route.
	out := []summaryStat{}

	if id.Can(rbac.StudentsRead) {
		pred, args := sc.StudentPredicate("st", 1)
		var total int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM students st
			 WHERE st.id IN (SELECT e.student_id FROM enrollments e WHERE e.status = 'active')
			   AND `+pred, args...).Scan(&total); err != nil {
			return nil, fmt.Errorf("summary students: %w", err)
		}
		if total > 0 {
			out = append(out, summaryStat{Label: "Students", Value: fmt.Sprint(total)})
		}
	}

	if id.Can(rbac.AttendanceRead) {
		pred, args := sc.AttendancePredicate("sa", 1)
		var present, marked int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE sa.status IN ('present','late')), count(*)
			  FROM student_attendance sa
			 WHERE sa.on_date = CURRENT_DATE AND `+pred, args...).Scan(&present, &marked); err != nil {
			return nil, fmt.Errorf("summary attendance: %w", err)
		}
		if marked > 0 {
			out = append(out, summaryStat{
				Label: "Present today",
				Value: fmt.Sprintf("%.1f%%", float64(present)*100/float64(marked)),
				Hint:  fmt.Sprintf("%d of %d marked", present, marked),
			})
		}
	}

	/* A teacher's today is her timetable, not the school's headcount.

	   The strip was written for a principal — students, attendance, money,
	   enquiries, staff — and a teacher holds two of those five. With nothing
	   marked yet the attendance figure drops out too, so she was left with one
	   tile reading "21 Students" across the width of the page: true, and not
	   what she opened the app to find out.

	   Only for somebody actually timetabled. A head of department who teaches
	   nothing gets no periods and no tile rather than a zero. */
	if id.Can(rbac.TimetableRead) {
		var periods, sections int
		if err := tx.QueryRow(ctx, `
			SELECT count(*)::int, count(DISTINCT te.section_id)::int
			  FROM timetable_entries te
			 WHERE te.teacher_user_id = $1
			   AND te.weekday = EXTRACT(isodow FROM CURRENT_DATE)::int`,
			id.UserID).Scan(&periods, &sections); err != nil {
			return nil, fmt.Errorf("summary periods: %w", err)
		}
		if periods > 0 {
			hint := fmt.Sprintf("%d section", sections)
			if sections != 1 {
				hint += "s"
			}
			out = append(out, summaryStat{
				Label: "Classes today", Value: fmt.Sprint(periods), Hint: hint,
			})
		}
	}

	/* Registers she still owes, said as a count rather than a warning.

	   The attention panel already tells her which sections are unmarked and
	   sends her to the register. This is the other half of the same fact —
	   how much of the day's marking is done — and it is the figure that makes
	   the strip mean something before anybody has marked anything. */
	if id.Can(rbac.AttendanceWrite) && !sc.AnySection && len(sc.SectionIDs) > 0 {
		var marked int
		if err := tx.QueryRow(ctx, `
			SELECT count(DISTINCT sa.section_id)::int
			  FROM student_attendance sa
			 WHERE sa.on_date = CURRENT_DATE AND sa.section_id = ANY($1)`,
			sc.SectionIDs).Scan(&marked); err != nil {
			return nil, fmt.Errorf("summary registers: %w", err)
		}
		total := len(sc.SectionIDs)
		out = append(out, summaryStat{
			Label: "Registers taken",
			Value: fmt.Sprintf("%d of %d", marked, total),
			Hint: map[bool]string{
				true:  "All done",
				false: "Still to mark",
			}[marked >= total],
			Tone: map[bool]string{true: "good", false: ""}[marked >= total],
		})
	}

	if id.Can(rbac.PaymentsRead) {
		var collected *int64
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE(sum(amount_paise), 0) FROM payments
			 WHERE status = 'success' AND paid_on = CURRENT_DATE`).Scan(&collected); err != nil {
			return nil, fmt.Errorf("summary collection: %w", err)
		}
		if collected != nil {
			out = append(out, summaryStat{Label: "Collected today", Value: rupees(*collected)})
		}
	}

	if id.Can(rbac.AdmissionsRead) {
		var n int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM enquiries WHERE created_at::date = CURRENT_DATE`).Scan(&n); err != nil {
			return nil, fmt.Errorf("summary enquiries: %w", err)
		}
		out = append(out, summaryStat{Label: "New enquiries", Value: fmt.Sprint(n)})
	}

	if id.Can(rbac.EmployeesRead) {
		var present, marked int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE status IN ('present','late','half_day')), count(*)
			  FROM staff_attendance WHERE on_date = CURRENT_DATE`).Scan(&present, &marked); err != nil {
			return nil, fmt.Errorf("summary staff: %w", err)
		}
		if marked > 0 {
			out = append(out, summaryStat{
				Label: "Staff present",
				Value: fmt.Sprintf("%.0f%%", float64(present)*100/float64(marked)),
			})
		}
	}

	return out, nil
}

// greeting is the time of day in the school's own terms.
//
// Resolved server-side rather than from the browser clock: a parent opening the
// app from another timezone should be greeted by their child's school day, not
// by their own.
func greeting() string {
	/* The school's clock, not the server's.

	   time.Now() on this box is UTC, so "Good morning" ran until half past
	   five in the evening in India and "Good evening" began at half past nine
	   at night. The comment above said the greeting was in the school's terms;
	   it was in Greenwich's. */
	h := time.Now().In(indiaTZ()).Hour()
	switch {
	case h < 12:
		return "Good morning"
	case h < 17:
		return "Good afternoon"
	default:
		return "Good evening"
	}
}

// statusTone maps every status vocabulary in the schema onto four tones, so a
// pill means the same thing wherever it appears.
//
// The vocabularies are the database's, not a second set invented for the UI:
// invoices already distinguish partial from overdue, applications already carry
// the enquiry-to-enrolled ladder. Restating them in the client would have been
// a second place for "what does partial mean" to drift.
var statusTone = map[string]string{
	// invoices / payments
	"paid": "good", "success": "good", "partial": "warn", "unpaid": "warn",
	"overdue": "bad", "failed": "bad", "bounced": "bad", "refunded": "neutral",
	"cancelled": "neutral", "draft": "neutral",
	// attendance
	"present": "good", "late": "warn", "half_day": "warn",
	"absent": "bad", "leave": "neutral", "holiday": "neutral", "week_off": "neutral",
	// applications / enquiries
	"new": "neutral", "contacted": "neutral", "visit_scheduled": "neutral",
	"submitted": "neutral", "under_review": "warn", "documents_pending": "warn",
	"test_scheduled": "neutral", "interviewed": "neutral", "waitlisted": "warn",
	"offered": "good", "accepted": "good", "applied": "good",
	"rejected": "bad", "withdrawn": "neutral", "lost": "bad",
	// approvals / certificates
	"pending": "warn", "approved": "good", "requested": "warn", "issued": "good",
	// enrolment
	"active": "good", "promoted": "good", "detained": "warn",
	"transferred": "neutral", "completed": "good",
}

// StatusTone is exported for handlers that render a status alongside a row.
func StatusTone(status string) string {
	if t, ok := statusTone[strings.ToLower(strings.TrimSpace(status))]; ok {
		return t
	}
	return "neutral"
}
