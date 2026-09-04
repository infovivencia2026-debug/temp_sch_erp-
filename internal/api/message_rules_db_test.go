package api

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
)

/*
Reminder plans against a real database.

	The four properties this feature would be embarrassing without, each
	asserted end to end rather than argued for in a comment:

	  a parent who paid yesterday is not chased today
	  a child absent in six periods generates one message, not six
	  a family who used the portal's absence button is left alone
	  running the sweep twice sends nothing the second time

	Every one of them is a property of SQL -- an occurrence key, a GROUP BY, an
	EXISTS, a unique index -- so none of them can be tested without a database.
	Guarded on ERP_TEST_DATABASE_URL exactly as message_dispatch_test.go is, so
	`go test ./internal/...` stays green on a machine with no Postgres:

	    ERP_TEST_DATABASE_URL=postgres://erp_owner:...@127.0.0.1:5432/erp_n1?sslmode=disable \
	    go test ./internal/api/ -run Plan -v

	in_app is the channel throughout. It is the one channel the recipient
	allowlist exempts -- its delivery is the message_log row itself, read
	inside the product -- which is what lets these tests assert the queue
	without a school having first bought an SMS account. The allowlist is
	asserted separately, on the preview, where it is the number a school would
	otherwise be misled by.
*/

// planWorld is seedTenant plus the rows an invoice and a period register need:
// an academic year, a class, a section and two periods.
type planWorld struct {
	inst, student, campus, year, section uuid.UUID
	periods                              []uuid.UUID
}

func seedPlanWorld(t *testing.T, db *database.DB) planWorld {
	t.Helper()
	ctx := context.Background()
	inst, student := seedTenant(t, db)

	w := planWorld{inst: inst, student: student, year: uuid.New(), section: uuid.New()}
	class := uuid.New()

	err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`SELECT campus_id FROM students WHERE id = $1`, student).Scan(&w.campus); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO academic_years (id, institution_id, campus_id, name, starts_on, ends_on, is_current)
			VALUES ($1,$2,$3,'2026-27','2026-04-01','2027-03-31',true)`,
			w.year, inst, w.campus); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO classes (id, institution_id, campus_id, name, level)
			VALUES ($1,$2,$3,'Grade 5',5)`, class, inst, w.campus); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name)
			VALUES ($1,$2,$3,$4,$5,'A')`, w.section, inst, w.campus, class, w.year); err != nil {
			return err
		}
		for i := 1; i <= 3; i++ {
			id := uuid.New()
			if _, err := tx.Exec(ctx, `
				INSERT INTO periods (id, institution_id, campus_id, name, sequence, starts_at, ends_at)
				VALUES ($1,$2,$3,$4,$5, make_time(8+$5,0,0), make_time(8+$5,45,0))`,
				id, inst, w.campus, "P", i); err != nil {
				return err
			}
			w.periods = append(w.periods, id)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed plan world: %v", err)
	}
	return w
}

// seedPlan writes one message_trigger_rules row as the save handler would.
func seedPlan(t *testing.T, db *database.DB, inst uuid.UUID, kind, channel, template string,
	condition string, repeat, max int, sendAt *string, skipExplained bool) uuid.UUID {

	t.Helper()
	id := uuid.New()
	err := db.InTenant(context.Background(), database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			INSERT INTO message_trigger_rules
			    (id, institution_id, name, event, condition, audience, channel, template_code,
			     is_active, plan_kind, repeat_days, max_attempts, send_at_time, skip_explained)
			VALUES ($1,$2,$3,$4,$5::jsonb,'guardians',$6,$7,true,$8,$9,$10,$11::time,$12)`,
			id, inst, "Plan "+id.String()[:8], planEventFor(kind), condition,
			channel, template, kind, repeat, max, sendAt, skipExplained)
		return err
	})
	if err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	return id
}

func seedInvoice(t *testing.T, db *database.DB, w planWorld, dueDaysAgo int, gross, paid int64) uuid.UUID {
	t.Helper()
	id := uuid.New()
	err := db.InTenant(context.Background(), database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id,
			                      invoice_no, issued_on, due_on, gross_paise, paid_paise, status)
			VALUES ($1,$2,$3,$4,$5,$6, CURRENT_DATE - $7::int - 10, CURRENT_DATE - $7::int, $8, $9, 'unpaid')`,
			id, w.inst, w.campus, w.student, w.year, "INV-"+id.String()[:8], dueDaysAgo, gross, paid)
		return err
	})
	if err != nil {
		t.Fatalf("seed invoice: %v", err)
	}
	return id
}

func runOnePlan(t *testing.T, s *Server, db *database.DB, inst, plan uuid.UUID, force bool) planRun {
	t.Helper()
	var runs []planRun
	err := db.InTenant(context.Background(), database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		var err error
		runs, err = s.runPlans(context.Background(), tx, inst, &plan, force)
		return err
	})
	if err != nil {
		t.Fatalf("run plan: %v", err)
	}
	if len(runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(runs))
	}
	return runs[0]
}

func countLog(t *testing.T, db *database.DB, inst uuid.UUID, status string) int {
	t.Helper()
	var n int
	err := db.InTenant(context.Background(), database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT count(*) FROM message_log
			 WHERE institution_id = $1 AND ($2 = '' OR status = $2)`, inst, status).Scan(&n)
	})
	if err != nil {
		t.Fatalf("count log: %v", err)
	}
	return n
}

/*
The fee chase, and the reason it is safe to run on a fifteen-minute cron.

	The first pass queues one reminder. The second, third and hundredth pass
	queue nothing at all and say so as "already sent" rather than as a fault --
	because the occurrence key is derived from the invoice's age, so every
	sweep inside the same weekly window produces the same key and the
	one-per-occurrence index refuses the copy.
*/
func TestPlanFeeChaseIsIdempotentAcrossSweeps(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	w := seedPlanWorld(t, db)
	seedInvoice(t, db, w, 10, 500000, 0)
	plan := seedPlan(t, db, w.inst, planFeeReminder, "in_app", "fees.overdue",
		`{"min_days_overdue": 7}`, 7, 3, nil, true)

	first := runOnePlan(t, s, db, w.inst, plan, false)
	if first.Queued != 1 {
		t.Fatalf("first sweep queued %d, want 1 (the guardian): %+v", first.Queued, first)
	}
	for i := 0; i < 3; i++ {
		again := runOnePlan(t, s, db, w.inst, plan, false)
		if again.Queued != 0 {
			t.Fatalf("sweep %d queued %d, want 0 — a duplicate fee reminder is worse than a late one",
				i+2, again.Queued)
		}
		if again.Duplicates != 1 {
			t.Errorf("sweep %d reported %d already-sent, want 1: "+
				"'nothing was sent' and 'nothing needed sending' must not look alike",
				i+2, again.Duplicates)
		}
	}
	if n := countLog(t, db, w.inst, ""); n != 1 {
		t.Fatalf("message_log holds %d rows after four sweeps, want 1", n)
	}
}

// An invoice too young for the policy is not an occurrence at all, so it does
// not inflate the counts a school reads before switching the plan on.
func TestPlanFeeChaseWaitsForTheFirstWindow(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	w := seedPlanWorld(t, db)
	seedInvoice(t, db, w, 2, 500000, 0)
	plan := seedPlan(t, db, w.inst, planFeeReminder, "in_app", "fees.overdue",
		`{"min_days_overdue": 7}`, 7, 3, nil, true)

	run := runOnePlan(t, s, db, w.inst, plan, false)
	if run.Matched != 0 || run.Queued != 0 {
		t.Fatalf("two days overdue against a seven-day policy: matched %d queued %d, want 0/0",
			run.Matched, run.Queued)
	}
}

/*
The requirement that makes this usable rather than embarrassing.

	A reminder queued on Monday sits in message_log until the dispatcher
	reaches it, and the dispatcher does not re-ask why it was queued. So a
	payment landing on Tuesday has to reach back and withdraw Monday's row --
	the same shape stopEnrolment uses when a lead converts.
*/
func TestPlanFeeChaseStopsTheMomentTheInvoiceIsPaid(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	ctx := context.Background()
	w := seedPlanWorld(t, db)
	inv := seedInvoice(t, db, w, 10, 500000, 0)
	plan := seedPlan(t, db, w.inst, planFeeReminder, "in_app", "fees.overdue",
		`{"min_days_overdue": 7}`, 7, 3, nil, true)

	if run := runOnePlan(t, s, db, w.inst, plan, false); run.Queued != 1 {
		t.Fatalf("queued %d, want 1", run.Queued)
	}
	if n := countLog(t, db, w.inst, "queued"); n != 1 {
		t.Fatalf("queued rows = %d, want 1", n)
	}

	// The family pays.
	if err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE invoices SET paid_paise = net_paise, status = 'paid' WHERE id = $1`, inv)
		return err
	}); err != nil {
		t.Fatalf("record payment: %v", err)
	}

	run := runOnePlan(t, s, db, w.inst, plan, false)
	if run.Withdrawn != 1 {
		t.Fatalf("withdrew %d reminders after payment, want 1 — a parent who paid "+
			"yesterday must not be chased today", run.Withdrawn)
	}
	if run.Matched != 0 || run.Queued != 0 {
		t.Errorf("a settled invoice is still an occurrence: matched %d queued %d, want 0/0",
			run.Matched, run.Queued)
	}
	if n := countLog(t, db, w.inst, "queued"); n != 0 {
		t.Errorf("queued rows after payment = %d, want 0", n)
	}
	if n := countLog(t, db, w.inst, "cancelled"); n != 1 {
		t.Errorf("cancelled rows = %d, want 1 — the row is marked and kept, never "+
			"deleted, so the school can see that it stopped chasing", n)
	}

	// And the dispatcher agrees: a cancelled row is not a queued one.
	sent, failed, err := s.DispatchMessages(ctx, w.inst, false, 50)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if sent != 0 || failed != 0 {
		t.Fatalf("dispatch after withdrawal sent=%d failed=%d, want 0/0", sent, failed)
	}
}

func markAbsent(t *testing.T, db *database.DB, w planWorld, periods []uuid.UUID, daysAgo int) {
	t.Helper()
	ctx := context.Background()
	err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		for _, p := range periods {
			if _, err := tx.Exec(ctx, `
				INSERT INTO student_attendance
				    (institution_id, student_id, section_id, on_date, period_id, status)
				VALUES ($1,$2,$3, CURRENT_DATE - $4::int, $5, 'absent')`,
				w.inst, w.student, w.section, daysAgo, p); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("mark absent: %v", err)
	}
}

/*
A child absent all day is one message, whatever a secondary timetable does to
the register.

	Three period rows, one occurrence, one guardian, one message. Keyed on
	(student, date) rather than on the attendance row id, which is what
	collapses them -- and the count has to hold however many times the sweep
	runs while the afternoon registers are still being marked.
*/
func TestPlanAbsenceAlertIsOnePerChildPerDay(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	w := seedPlanWorld(t, db)
	markAbsent(t, db, w, w.periods[:2], 0)
	plan := seedPlan(t, db, w.inst, planAbsenceAlert, "in_app", "attendance.absent",
		`{"max_days_ago": 0}`, 0, 1, nil, true)

	first := runOnePlan(t, s, db, w.inst, plan, false)
	if first.Matched != 1 {
		t.Fatalf("occurrences = %d, want 1 — two period rows are one absent day",
			first.Matched)
	}
	if first.Queued != 1 {
		t.Fatalf("queued %d, want 1", first.Queued)
	}

	// The third period is marked, and the sweep runs again.
	markAbsent(t, db, w, w.periods[2:], 0)
	again := runOnePlan(t, s, db, w.inst, plan, false)
	if again.Queued != 0 {
		t.Fatalf("a later register queued %d more, want 0 — a child absent in every "+
			"period must generate one message and not eight", again.Queued)
	}
	if n := countLog(t, db, w.inst, ""); n != 1 {
		t.Fatalf("message_log holds %d rows, want 1", n)
	}
}

/*
The family used the button. Say nothing.

	reportChildAbsence in the parent portal writes a leave_requests row, and so
	does an ordinary leave application. Either counts, pending or approved: a
	school that waits for approval before staying quiet has texted the parent
	long before anybody opened the queue.
*/
func TestPlanAbsenceAlertHonoursAnExplanation(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	ctx := context.Background()
	w := seedPlanWorld(t, db)
	markAbsent(t, db, w, w.periods[:1], 0)
	plan := seedPlan(t, db, w.inst, planAbsenceAlert, "in_app", "attendance.absent",
		`{"max_days_ago": 0}`, 0, 1, nil, true)

	// The parent reports it before the gate opens.
	if err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO leave_requests (institution_id, subject_kind, student_id,
			                            from_date, to_date, days, reason, status)
			VALUES ($1,'student',$2, CURRENT_DATE, CURRENT_DATE, 1, 'Fever', 'pending')`,
			w.inst, w.student)
		return err
	}); err != nil {
		t.Fatalf("report absence: %v", err)
	}

	run := runOnePlan(t, s, db, w.inst, plan, false)
	if run.Matched != 0 || run.Queued != 0 {
		t.Fatalf("an explained absence produced %d occurrences and %d messages, want 0/0 — "+
			"texting the parent who just told us teaches them the button does nothing",
			run.Matched, run.Queued)
	}
}

// And an explanation that arrives after the alert is queued withdraws it,
// because the queue is not sent the instant it is written.
func TestPlanAbsenceAlertIsWithdrawnWhenExplainedLate(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	ctx := context.Background()
	w := seedPlanWorld(t, db)
	markAbsent(t, db, w, w.periods[:1], 0)
	plan := seedPlan(t, db, w.inst, planAbsenceAlert, "in_app", "attendance.absent",
		`{"max_days_ago": 0}`, 0, 1, nil, true)

	if run := runOnePlan(t, s, db, w.inst, plan, false); run.Queued != 1 {
		t.Fatalf("queued %d, want 1", run.Queued)
	}
	if err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO leave_requests (institution_id, subject_kind, student_id,
			                            from_date, to_date, days, reason, status)
			VALUES ($1,'student',$2, CURRENT_DATE, CURRENT_DATE, 1, 'Fever', 'approved')`,
			w.inst, w.student)
		return err
	}); err != nil {
		t.Fatalf("report absence: %v", err)
	}

	run := runOnePlan(t, s, db, w.inst, plan, false)
	if run.Withdrawn != 1 {
		t.Fatalf("withdrew %d, want 1", run.Withdrawn)
	}
	if n := countLog(t, db, w.inst, "queued"); n != 0 {
		t.Errorf("queued alerts after the explanation = %d, want 0", n)
	}
}

// The gate holds the sweep until the register is plausibly taken, and "Run
// now" overrides it — the operator standing at the screen knows the fact the
// gate was guessing at.
func TestPlanAbsenceGateHoldsTheSweepAndRunNowOverridesIt(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	w := seedPlanWorld(t, db)
	markAbsent(t, db, w, w.periods[:1], 0)

	// A gate an hour into the future, whatever time the test runs.
	later := nowInIndia().Add(90 * time.Minute).Format("15:04")
	if nowInIndia().Hour() >= 22 {
		t.Skip("no room for a future gate before midnight")
	}
	plan := seedPlan(t, db, w.inst, planAbsenceAlert, "in_app", "attendance.absent",
		`{"max_days_ago": 0}`, 0, 1, &later, true)

	held := runOnePlan(t, s, db, w.inst, plan, false)
	if held.Queued != 0 || held.Skipped == "" {
		t.Fatalf("gated sweep queued %d and said %q, want 0 and a reason", held.Queued, held.Skipped)
	}
	forced := runOnePlan(t, s, db, w.inst, plan, true)
	if forced.Queued != 1 {
		t.Fatalf("Run now queued %d, want 1", forced.Queued)
	}
}

/*
The preview, which is the part that stops a school switching on something that
fires four hundred times.

	It must name real people, and it must account for the recipient allowlist,
	which fails closed -- a school with no policy row sends to nobody. A
	preview that promised fourteen and delivered none is how a school concludes
	the feature is broken.
*/
func TestPlanPreviewNamesPeopleAndAccountsForTheAllowlist(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	ctx := context.Background()
	w := seedPlanWorld(t, db)
	seedInvoice(t, db, w, 10, 500000, 0)
	// sms rather than in_app: the allowlist exempts in_app, and the allowlist
	// is the thing under test.
	if err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO integrations (institution_id, provider, kind, config, enabled)
			VALUES ($1,'sms','messaging',
			        '{"endpoint":"https://example.test/send","sender_id":"SCHOOL","auth_header":"Bearer test"}'::jsonb,
			        true)
			ON CONFLICT (institution_id, provider) DO NOTHING`, w.inst)
		return err
	}); err != nil {
		t.Fatalf("configure sms: %v", err)
	}
	plan := seedPlan(t, db, w.inst, planFeeReminder, "sms", "fees.overdue",
		`{"min_days_overdue": 7}`, 7, 3, nil, true)

	var view planPreview
	if err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		plans, err := s.loadPlans(ctx, tx, w.inst, "", &plan)
		if err != nil {
			return err
		}
		if len(plans) != 1 {
			t.Fatalf("loadPlans found %d, want 1", len(plans))
		}
		view, err = s.previewPlan(ctx, tx, w.inst, plans[0])
		return err
	}); err != nil {
		t.Fatalf("preview: %v", err)
	}

	if view.Matched != 1 {
		t.Fatalf("preview matched %d occurrences, want 1", view.Matched)
	}
	if len(view.Sample) != 1 {
		t.Fatalf("sample has %d rows, want 1 — a number nobody can check is a number "+
			"nobody believes", len(view.Sample))
	}
	if view.Sample[0].Name == "" {
		t.Error("preview row has no name")
	}
	// No messaging_recipient_policy row was written, so the guard is
	// 'everyone': holding messages back is something a school chooses, and
	// the preview must promise the send it will actually make.
	if view.GuardMode != "everyone" {
		t.Fatalf("guard mode = %q, want everyone (no row means nobody asked to be held back)", view.GuardMode)
	}
	if view.WouldSend != 1 || view.Suppressed != 0 {
		t.Fatalf("preview says would_send=%d suppressed=%d; want 1/0 — with no policy row "+
			"the message goes out and the preview must say so",
			view.WouldSend, view.Suppressed)
	}

	// Open the allowlist to everyone, and the same preview promises the send.
	if err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO messaging_recipient_policy (institution_id, mode)
			VALUES ($1,'everyone')
			ON CONFLICT (institution_id) DO UPDATE SET mode = 'everyone'`, w.inst)
		return err
	}); err != nil {
		t.Fatalf("open allowlist: %v", err)
	}
	if err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		plans, err := s.loadPlans(ctx, tx, w.inst, "", &plan)
		if err != nil {
			return err
		}
		view, err = s.previewPlan(ctx, tx, w.inst, plans[0])
		return err
	}); err != nil {
		t.Fatalf("preview: %v", err)
	}
	if view.WouldSend != 1 || view.Suppressed != 0 {
		t.Fatalf("with the allowlist open: would_send=%d suppressed=%d, want 1/0",
			view.WouldSend, view.Suppressed)
	}
	// And the preview wrote nothing.
	if n := countLog(t, db, w.inst, ""); n != 0 {
		t.Fatalf("the dry run wrote %d message_log rows, want 0", n)
	}
}

// A plan rule must be invisible to the generic sweep, or both would evaluate it
// with different occurrence keys and one family would be chased twice.
func TestPlanRulesAreExcludedFromTheGenericSweep(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	ctx := context.Background()
	w := seedPlanWorld(t, db)
	seedInvoice(t, db, w, 10, 500000, 0)
	seedPlan(t, db, w.inst, planFeeReminder, "in_app", "fees.overdue",
		`{"min_days_overdue": 7}`, 7, 3, nil, true)

	var results []sweepResult
	if err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		var err error
		results, err = s.runTriggerRules(ctx, tx, w.inst, nil)
		return err
	}); err != nil {
		t.Fatalf("generic sweep: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("the generic sweep saw %d plan rules, want 0: %+v", len(results), results)
	}
	if n := countLog(t, db, w.inst, ""); n != 0 {
		t.Fatalf("the generic sweep queued %d messages from a plan rule, want 0", n)
	}
}
