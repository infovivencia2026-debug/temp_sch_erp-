package queue

import (
	"context"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
)

/*
The queue against a real database. Skipped unless TEST_DATABASE_URL is set,
like tests/, so `go test ./...` needs nothing running.

	Everything the unit tests could not reach: that River accepts the schema
	00250 lays down, that a job enqueued by an insert-only client is worked by
	a client with handlers, that the cron tick baselines on first sight and
	fires on the second, that two ticks at once take turns on the advisory
	lock, and that Find and Stats speak the SPA's vocabulary about real rows.
*/
func e2eDB(t *testing.T) (*database.DB, string) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := database.Connect(context.Background(), url, 8)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return db, url
}

func seedInstitution(t *testing.T, db *database.DB, slug, tz string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			INSERT INTO institutions (name, short_name, slug, timezone)
			VALUES ($1, $1, $2, $3)
			ON CONFLICT (slug) DO UPDATE SET timezone = EXCLUDED.timezone, status = 'active'
			RETURNING id`, "E2E "+slug, slug, tz).Scan(&id)
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestE2EWorkAndInspect(t *testing.T) {
	db, url := e2eDB(t)
	ctx := context.Background()
	inst := seedInstitution(t, db, "e2e-work", "Asia/Kolkata")

	// A worker with the real handlers over a fake messaging contract, plus
	// one externally registered kind, as cmd/worker registers the sweeps.
	f := &fakeMessaging{}
	h := &Handlers{DB: db, Messaging: f}
	var extraRan sync.WaitGroup
	extraRan.Add(1)
	if err := h.Handle("e2e:extra", time.Minute, func(context.Context, *Task) error { extraRan.Done(); return nil }); err != nil {
		t.Fatal(err)
	}
	worker, err := New(ctx, url, h)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()

	// The web process: insert-only.
	web, err := New(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer web.Close()
	if err := web.Start(ctx); err == nil {
		t.Error("insert-only client agreed to Start")
	}

	env := Envelope{InstitutionID: inst, JobID: uuid.New()}
	ids := map[string]string{}
	enq := func(kind string, payload any, opts ...Option) {
		id, err := web.Enqueue(ctx, kind, payload, opts...)
		if err != nil {
			t.Fatalf("enqueue %s: %v", kind, err)
		}
		ids[kind] = id
	}
	enq(TypeReportCardGenerate, ReportCardGeneratePayload{Envelope: env, ExamID: uuid.New(), SectionID: uuid.New()}, HeavyOptions()...)
	enq(TypeInvoiceGenerate, InvoiceGeneratePayload{Envelope: env, FeeStructureID: uuid.New(), AcademicYearID: uuid.New()}, HeavyOptions()...)
	enq(TypeFeeReminderFanout, FeeReminderFanoutPayload{Envelope: env, OverdueSince: time.Now(), TemplateKey: "fee.overdue"}, HeavyOptions()...)
	enq(TypeMessageSend, MessageSendPayload{Envelope: env, Channel: "sms", TemplateKey: "t", ToUserID: uuid.New()}, CriticalOptions()...)
	enq(TypeMessageDispatch, MessageDispatchPayload{Envelope: env, Limit: 5}, InteractiveOptions()...)
	enq(TypeMessagePlans, MessagePlansPayload{Envelope: env}, InteractiveOptions()...)
	enq(TypeBulkImport, BulkImportPayload{Envelope: env, Kind: "students", FileKey: "k"}, HeavyOptions()...)
	enq(TypeExportBuild, ExportBuildPayload{Envelope: env, Kind: "students", Format: "csv"}, HeavyOptions()...)
	enq(TypeAttendanceRollup, AttendanceRollupPayload{Envelope: env, On: time.Now()}, Options(QueueLow, 3, 10*time.Minute)...)
	enq(TypeSessionPrune, Envelope{}, Options(QueueLow, 2, 5*time.Minute)...)
	enq(TypeDiaryReminders, Envelope{}, Options(QueueDefault, 3, 2*time.Minute)...)
	enq("e2e:extra", map[string]any{}, Options(QueueLow, 1, time.Minute)...)
	// And one that must fail for good: a payload that will never parse into
	// its struct. Enqueue cannot produce one -- it marshals what it is given
	// -- so this is the row a stray INSERT or an older client would leave.
	var badRow int64
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO river_job (kind, args, max_attempts, queue)
			VALUES ($1, '"not an object"'::jsonb, 6, 'default') RETURNING id`, TypeMessageDispatch).Scan(&badRow)
	}); err != nil {
		t.Fatal(err)
	}
	badID := strconv.FormatInt(badRow, 10)

	// Before any worker runs: everything is pending in the SPA's words.
	st, err := web.Inspector().Find(ctx, ids[TypeBulkImport])
	if err != nil || st.State != "pending" || st.Queue != QueueBulk || st.MaxRetry != 2 {
		t.Fatalf("fresh job = %+v, %v; want pending on bulk with max_retry 2", st, err)
	}
	if _, err := web.Inspector().Find(ctx, "999999999"); err != ErrJobNotFound {
		t.Errorf("unknown id: %v, want ErrJobNotFound", err)
	}
	if _, err := web.Inspector().Find(ctx, "not-a-number"); err != ErrJobNotFound {
		t.Errorf("garbage id: %v, want ErrJobNotFound", err)
	}

	if err := worker.Start(ctx); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { extraRan.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("externally registered kind never ran")
	}

	// Wait for every job to finalise.
	deadline := time.Now().Add(30 * time.Second)
	for {
		var open int
		_ = db.AsPlatform(ctx, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE finalized_at IS NULL`).Scan(&open)
		})
		if open == 0 || time.Now().After(deadline) {
			if open != 0 {
				t.Fatalf("%d jobs still not finalised after 30s", open)
			}
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	stopCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := worker.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}

	for kind, id := range ids {
		st, err := web.Inspector().Find(ctx, id)
		if err != nil {
			t.Fatalf("find %s: %v", kind, err)
		}
		if st.State != "completed" {
			t.Errorf("%s: state %q (last error %q), want completed", kind, st.State, st.LastError)
		}
		if st.Type != kind {
			t.Errorf("%s: type reported as %q", kind, st.Type)
		}
	}
	bad, err := web.Inspector().Find(ctx, badID)
	if err != nil {
		t.Fatal(err)
	}
	// SkipRetry -> cancelled -> "archived", on the first attempt.
	if bad.State != "archived" || bad.Retried != 0 {
		t.Errorf("unparseable payload: %+v, want archived after one attempt", bad)
	}
	if f.plansFor == nil || f.dispatchedFor == nil || f.queued == nil {
		t.Errorf("messaging contract not reached: plans=%v dispatch=%v queued=%v", f.plansFor, f.dispatchedFor, f.queued)
	}

	stats, err := web.Inspector().Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range Queues {
		if stats[q] == nil {
			t.Fatalf("queue %s missing from stats", q)
		}
	}
	if stats[QueueDefault].Archived < 1 || stats[QueueDefault].Failed < 1 {
		t.Errorf("default queue stats = %+v, want the archived job counted", stats[QueueDefault])
	}
	if stats[QueueBulk].Completed < 5 || stats[QueueBulk].Size != stats[QueueBulk].Archived {
		t.Errorf("bulk queue stats = %+v", stats[QueueBulk])
	}
	t.Logf("stats: bulk=%+v default=%+v", *stats[QueueBulk], *stats[QueueDefault])
}

func TestE2ECronTick(t *testing.T) {
	db, url := e2eDB(t)
	ctx := context.Background()
	_ = db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM cron_runs`)
		return err
	})
	// Only the seeded schools count: park anything else.
	_ = db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE institutions SET status = 'suspended' WHERE slug NOT LIKE 'e2e-cron-%'`)
		return err
	})
	a := seedInstitution(t, db, "e2e-cron-a", "Asia/Kolkata")
	b := seedInstitution(t, db, "e2e-cron-b", "Europe/London")
	_, _ = a, b

	web, err := New(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer web.Close()

	scheds := Schedules()
	perInst, global := 0, 0
	for _, s := range scheds {
		if s.PerInstitution {
			perInst++
		} else {
			global++
		}
	}
	wantChecked := perInst*2 + global

	clock := time.Date(2026, 9, 5, 3, 29, 30, 0, time.UTC) // 08:59:30 IST, 04:29:30 BST
	c := &Cron{DB: db, Queue: web, Schedules: scheds, Now: func() time.Time { return clock }}

	first, err := c.Tick(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if first.Checked != wantChecked || first.Started != wantChecked || first.Enqueued != 0 || first.Institutions != 2 {
		t.Fatalf("first tick = %+v, want %d checked, all started, nothing enqueued, 2 institutions", first, wantChecked)
	}

	// One minute on: 09:00:30 IST. Every-minute entries fire for both, the
	// 5- and 15-minute ones fire (09:00 is on both grids), fee reminders
	// fire for the Kolkata school only -- London is at 04:30.
	clock = clock.Add(time.Minute)
	var wg sync.WaitGroup
	results := make([]TickResult, 2)
	errs := make([]error, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = c.Tick(ctx)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent tick %d: %v", i, err)
		}
	}
	total := TickResult{Kinds: map[string]int{}}
	for _, r := range results {
		total.Enqueued += r.Enqueued
		for k, n := range r.Kinds {
			total.Kinds[k] += n
		}
	}
	want := map[string]int{
		TypeMessageDispatch:   2,
		TypeMessagePlans:      2,
		TypeDiaryReminders:    1,
		TypeFeeReminderFanout: 1,
	}
	for k, n := range want {
		if total.Kinds[k] != n {
			t.Errorf("%s enqueued %d times across two concurrent ticks, want %d", k, total.Kinds[k], n)
		}
	}
	if total.Enqueued != 6 {
		t.Errorf("two concurrent ticks enqueued %d in total (%v), want 6: the lock did not hold", total.Enqueued, total.Kinds)
	}
	if (results[0].Enqueued == 0) == (results[1].Enqueued == 0) {
		t.Errorf("results %+v / %+v: exactly one tick should have done the work", results[0], results[1])
	}

	// The fee reminder went to the Kolkata school and carries its id.
	var instInPayload uuid.UUID
	err = db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT (args->>'institution_id')::uuid FROM river_job WHERE kind = $1 ORDER BY id DESC LIMIT 1`,
			TypeFeeReminderFanout).Scan(&instInPayload)
	})
	if err != nil || instInPayload != a {
		t.Errorf("fee reminder institution = %v (%v), want Kolkata school %v", instInPayload, err, a)
	}

	// A third tick in the same minute: nothing due.
	clock = clock.Add(10 * time.Second)
	third, err := c.Tick(ctx)
	if err != nil || third.Enqueued != 0 || third.Started != 0 {
		t.Errorf("third tick = %+v, %v; want nothing", third, err)
	}
	_ = b
}
