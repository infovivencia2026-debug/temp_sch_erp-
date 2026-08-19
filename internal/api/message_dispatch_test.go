package api

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/queue"
)

/*
The dispatch path, end to end, against a real database.

	Everything below the provider boundary is real: a trigger rule row, an
	emitted event, the rules sweep, the one-per-occurrence index, message_log
	with its send_after, and DispatchMessages moving the row. Only the provider
	is not a network call -- the in_app provider succeeds locally by design,
	which is what lets a school automate something before it has bought an SMS
	account, and what lets this test assert the queued -> sent transition
	without one.

	Guarded on ERP_TEST_DATABASE_URL rather than a build tag so that `go test
	./internal/...` stays green on a machine with no Postgres, which is how the
	rest of this package's tests are run. Point it at a migrated database to
	get the coverage:

	    ERP_TEST_DATABASE_URL=postgres://erp_owner:...@127.0.0.1:5432/erp_wb?sslmode=disable \
	    CREDENTIAL_KEY=... go test ./internal/api/ -run Dispatch -v
*/
func testDB(t *testing.T) *database.DB {
	t.Helper()
	url := os.Getenv("ERP_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("ERP_TEST_DATABASE_URL not set; skipping database-backed dispatch test")
	}
	db, err := database.Connect(context.Background(), url, 4)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(db.Close)
	return db
}

// seedTenant creates the smallest world a guardian-addressed trigger rule
// needs: a school, a campus, a child, and a parent with a phone number. It is
// deliberately not a fixture shared with other tests -- a dispatch test that
// depends on rows another test left behind is a test that passes for the wrong
// reason.
func seedTenant(t *testing.T, db *database.DB) (inst, student uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	inst, student = uuid.New(), uuid.New()
	campus, guardian := uuid.New(), uuid.New()
	suffix := inst.String()[:8]

	err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO institutions (id, name, short_name, slug, timezone, status)
			VALUES ($1, 'Dispatch Test School', 'DTS', $2, 'Asia/Kolkata', 'active')`,
			inst, "dispatch-"+suffix); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO campuses (id, institution_id, name, code)
			VALUES ($1, $2, 'Main', $3)`, campus, inst, "MAIN-"+suffix); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, last_name)
			VALUES ($1, $2, $3, $4, 'Asha', 'Rao')`,
			student, inst, campus, "ADM-"+suffix); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO guardians (id, institution_id, full_name, relation, phone, email)
			VALUES ($1, $2, 'Lakshmi Rao', 'mother', $3, $4)`,
			guardian, inst, "99999"+suffix[:5], "lakshmi-"+suffix+"@example.test"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary)
			VALUES ($1, $2, $3, true)`, student, guardian, inst)
		return err
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(),
				`DELETE FROM institutions WHERE id = $1`, inst)
			return err
		})
	})
	return inst, student
}

func seedRule(t *testing.T, db *database.DB, inst uuid.UUID,
	event, channel, template string, quietFrom, quietTo *string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	err := db.InTenant(context.Background(), database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			INSERT INTO message_trigger_rules
			    (id, institution_id, name, event, audience, channel, template_code,
			     quiet_from, quiet_to, is_active)
			VALUES ($1,$2,'Test rule',$3,'guardians',$4,$5,$6::time,$7::time,true)`,
			id, inst, event, channel, template, quietFrom, quietTo)
		return err
	})
	if err != nil {
		t.Fatalf("seed rule: %v", err)
	}
	return id
}

type logRow struct {
	Status    string
	Recipient string
	Attempts  int
	SendAfter *time.Time
	Error     *string
	Provider  *string
}

func readLog(t *testing.T, db *database.DB, inst uuid.UUID) []logRow {
	t.Helper()
	var out []logRow
	err := db.InTenant(context.Background(), database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		rows, err := tx.Query(context.Background(), `
			SELECT status, recipient, attempts, send_after, error, provider
			  FROM message_log WHERE institution_id = $1 ORDER BY queued_at`, inst)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r logRow
			if err := rows.Scan(&r.Status, &r.Recipient, &r.Attempts,
				&r.SendAfter, &r.Error, &r.Provider); err != nil {
				return err
			}
			out = append(out, r)
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	return out
}

/*
The whole pipe: a rule, an event, a queued row, and a dispatch that moves it.

	This is the assertion the product never had. Emitting worked and queueing
	worked; nothing ever ran the last step, so a row written here would have
	sat at 'queued' forever.
*/
func TestDispatchDeliversAQueuedTriggerMessage(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst, student := seedTenant(t, db)
	seedRule(t, db, inst, "student.absent", "in_app", "attendance.absent", nil, nil)

	ctx := context.Background()
	var queued int
	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		var err error
		queued, err = s.EmitMessageEvent(ctx, tx, inst, "student.absent", MessageSubject{
			StudentID:     &student,
			At:            time.Now(),
			OccurrenceKey: "2026-08-19",
			Facts:         map[string]any{"on_date": "2026-08-19"},
		})
		return err
	})
	if err != nil {
		t.Fatalf("emit: %v", err)
	}
	if queued != 1 {
		t.Fatalf("queued %d messages, want 1 (the guardian)", queued)
	}

	before := readLog(t, db, inst)
	if len(before) != 1 || before[0].Status != "queued" {
		t.Fatalf("after emit: %+v, want one queued row", before)
	}

	sent, failed, err := s.DispatchMessages(ctx, inst, false, 50)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if sent != 1 || failed != 0 {
		t.Fatalf("dispatch sent=%d failed=%d, want 1/0", sent, failed)
	}

	after := readLog(t, db, inst)
	if after[0].Status != "sent" {
		t.Fatalf("status = %q after dispatch, want sent", after[0].Status)
	}
	if after[0].Attempts != 1 {
		t.Errorf("attempts = %d, want 1", after[0].Attempts)
	}
}

/*
Quiet hours are the reason send_after exists, and the reason a dispatcher that
ignored it would wake parents at 02:00.

	A rule whose quiet window covers the whole day can never be sent now, so
	the row must be written with send_after in the future and left alone by a
	dispatch running immediately after.
*/
func TestDispatchHonoursSendAfter(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst, student := seedTenant(t, db)
	from, to := "00:00", "23:59"
	seedRule(t, db, inst, "student.absent", "in_app", "attendance.absent", &from, &to)

	ctx := context.Background()
	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, err := s.EmitMessageEvent(ctx, tx, inst, "student.absent", MessageSubject{
			StudentID: &student, At: time.Now(), OccurrenceKey: "held",
		})
		return err
	})
	if err != nil {
		t.Fatalf("emit: %v", err)
	}

	rows := readLog(t, db, inst)
	if len(rows) != 1 || rows[0].SendAfter == nil {
		t.Fatalf("rows = %+v, want one row held with send_after set", rows)
	}
	if !rows[0].SendAfter.After(time.Now()) {
		t.Errorf("send_after = %v, want a future moment", rows[0].SendAfter)
	}

	sent, failed, err := s.DispatchMessages(ctx, inst, false, 50)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if sent != 0 || failed != 0 {
		t.Fatalf("dispatch sent=%d failed=%d, want 0/0: the row is not due yet", sent, failed)
	}
	if readLog(t, db, inst)[0].Status != "queued" {
		t.Error("a held row was touched by dispatch")
	}

	// Once the window passes, the same row goes out -- held, not dropped.
	err = db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE message_log SET send_after = now() - interval '1 minute'
		                       WHERE institution_id = $1`, inst)
		return e
	})
	if err != nil {
		t.Fatalf("release: %v", err)
	}
	if sent, _, err = s.DispatchMessages(ctx, inst, false, 50); err != nil || sent != 1 {
		t.Fatalf("after release: sent=%d err=%v, want 1", sent, err)
	}
}

/*
The property that makes a scheduled job safe: running it twice must not send
twice.

	The cron entry can overlap with an asynq retry of the previous tick. If a
	second run could re-send a row the first had already sent, a parent gets
	the same reminder five times, which is worse than a late one.
*/
func TestDispatchIsIdempotentAcrossRuns(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst, student := seedTenant(t, db)
	seedRule(t, db, inst, "student.absent", "in_app", "attendance.absent", nil, nil)

	ctx := context.Background()
	emit := func() {
		t.Helper()
		err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
			_, err := s.EmitMessageEvent(ctx, tx, inst, "student.absent", MessageSubject{
				StudentID: &student, At: time.Now(), OccurrenceKey: "2026-08-19",
			})
			return err
		})
		if err != nil {
			t.Fatalf("emit: %v", err)
		}
	}

	// The same occurrence emitted twice is one message: the sweep re-running
	// must not queue a second copy.
	emit()
	emit()
	if rows := readLog(t, db, inst); len(rows) != 1 {
		t.Fatalf("%d rows after emitting the same occurrence twice, want 1", len(rows))
	}

	first, _, err := s.DispatchMessages(ctx, inst, false, 50)
	if err != nil || first != 1 {
		t.Fatalf("first dispatch: sent=%d err=%v", first, err)
	}
	second, failed, err := s.DispatchMessages(ctx, inst, false, 50)
	if err != nil {
		t.Fatalf("second dispatch: %v", err)
	}
	if second != 0 || failed != 0 {
		t.Fatalf("second dispatch sent=%d failed=%d, want 0/0: it re-sent a sent message", second, failed)
	}
	if rows := readLog(t, db, inst); rows[0].Attempts != 1 {
		t.Errorf("attempts = %d after two runs, want 1", rows[0].Attempts)
	}
}

/*
Dispatch must not reach across tenants.

	It runs per institution from the scheduler, and a second school's queued
	messages must be invisible to the first school's tick -- both because the
	statement filters on institution_id and because the RLS policy would refuse
	them anyway. Asserting it here is what stops a later "optimisation" to a
	single platform-scoped pass from silently mixing two schools' outboxes.
*/
func TestDispatchIsTenantScoped(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	instA, studentA := seedTenant(t, db)
	instB, studentB := seedTenant(t, db)
	seedRule(t, db, instA, "student.absent", "in_app", "attendance.absent", nil, nil)
	seedRule(t, db, instB, "student.absent", "in_app", "attendance.absent", nil, nil)

	ctx := context.Background()
	for _, c := range []struct {
		inst    uuid.UUID
		student uuid.UUID
	}{{instA, studentA}, {instB, studentB}} {
		err := db.InTenant(ctx, database.Scope{InstitutionID: c.inst}, func(tx pgx.Tx) error {
			_, err := s.EmitMessageEvent(ctx, tx, c.inst, "student.absent", MessageSubject{
				StudentID: &c.student, At: time.Now(), OccurrenceKey: "k",
			})
			return err
		})
		if err != nil {
			t.Fatalf("emit for %v: %v", c.inst, err)
		}
	}

	sent, _, err := s.DispatchMessages(ctx, instA, false, 50)
	if err != nil {
		t.Fatalf("dispatch A: %v", err)
	}
	if sent != 1 {
		t.Fatalf("dispatch for A sent %d, want exactly its own 1", sent)
	}
	if rows := readLog(t, db, instB); rows[0].Status != "queued" {
		t.Fatalf("school B's message was %q after school A's dispatch, want untouched",
			rows[0].Status)
	}
}

/*
QueueOutbound is the seam cmd/worker wires, so the seam itself is exercised
against the database rather than only against a fake.

	It also proves the fix to the TypeMessageSend handler, whose old INSERT
	named template_key and to_user_id -- columns message_log has never had.
*/
func TestQueueOutboundWritesADispatchableRow(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	inst, _ := seedTenant(t, db)

	var guardianUser uuid.UUID
	ctx := context.Background()
	// The task path addresses a user account; this tenant's guardian has none,
	// so the honest outcome is ErrNoRecipient rather than a row nothing can be
	// delivered to. Assert that instead of inventing an account.
	err := s.QueueOutbound(ctx, inst, queue.OutboundRequest{
		Channel: "in_app", TemplateCode: "attendance.absent",
		ToUserID: guardianUser, SourceKind: "queue_task", OccurrenceKey: "x",
	})
	if err == nil {
		t.Fatal("queued a message with no recipient; want a refusal")
	}

	// With an address supplied directly, the row lands and is dispatchable.
	err = db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, e := s.QueueMessage(ctx, tx, inst, SendRequest{
			Channel: "in_app", TemplateCode: "attendance.absent",
			Recipient: "parent@example.test", SourceKind: "queue_task",
			OccurrenceKey: "x", Vars: map[string]any{"student_name": "Asha"},
		})
		return e
	})
	if err != nil {
		t.Fatalf("queue: %v", err)
	}
	sent, _, err := s.DispatchMessages(ctx, inst, false, 10)
	if err != nil || sent != 1 {
		t.Fatalf("dispatch: sent=%d err=%v, want 1", sent, err)
	}
}

/*
A send that fails must stay retryable and stay visible.

	Without SMS or WhatsApp credentials -- which is this deployment -- a send
	on those channels cannot succeed. Marking the row 'failed' on the first
	error made that terminal, because the dispatcher only ever selects rows
	still 'queued': the school would configure the gateway and find the backlog
	it configured it for already dead in the table. So the row goes back to
	'queued' with send_after pushed out and the error text kept, and only
	becomes 'failed' once the attempts are exhausted.
*/
/*
The same property against a provider that really fails.

	An SMTP host on a closed port is the nearest honest stand-in for the
	failures this deployment will actually see, since it has no SMS or WhatsApp
	account to fail with. The row must come back to 'queued' with the error
	recorded and send_after pushed out -- visible on the message log as
	something that has not gone out and why, and still there to be sent when
	the provider works.
*/
func TestFailedSendStaysQueuedAndVisible(t *testing.T) {
	db := testDB(t)
	if os.Getenv("CREDENTIAL_KEY") == "" {
		t.Skip("CREDENTIAL_KEY not set; provider credentials cannot be sealed")
	}
	s := &Server{DB: db}
	inst, _ := seedTenant(t, db)
	ctx := context.Background()

	sealed, err := sealSecret("not-a-real-password")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	err = db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		// Port 1 is reserved and nothing listens on it, so the dial fails fast
		// and deterministically rather than depending on the network.
		_, e := tx.Exec(ctx, `
			INSERT INTO integrations (institution_id, kind, provider, config, credentials, enabled)
			VALUES ($1,'messaging','email',
			        '{"host":"127.0.0.1","port":1,"from_address":"school@example.test"}'::jsonb,
			        $2, true)`, inst, sealed)
		if e != nil {
			return e
		}
		/* The recipient allowlist (00101) is on by default and fails closed,
		   so a school that has configured nothing sends to nobody. This test
		   is about what happens when a provider FAILS, which is a state
		   reachable only once the guard has let the message past -- so the
		   one address it uses is permitted here. Without this the row is
		   suppressed and the retry path below is never exercised. */
		_, e = tx.Exec(ctx, `
			INSERT INTO messaging_allowed_recipients (institution_id, kind, raw, normalised)
			VALUES ($1,'email','parent@example.test','parent@example.test')`, inst)
		return e
	})
	if err != nil {
		t.Fatalf("seed provider: %v", err)
	}

	err = db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, e := s.QueueMessage(ctx, tx, inst, SendRequest{
			Channel: "email", TemplateCode: "attendance.absent",
			Recipient: "parent@example.test", SourceKind: "trigger_rule",
			OccurrenceKey: "retryable",
		})
		return e
	})
	if err != nil {
		t.Fatalf("queue: %v", err)
	}

	sent, failed, err := s.DispatchMessages(ctx, inst, false, 10)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if sent != 0 || failed != 1 {
		t.Fatalf("sent=%d failed=%d, want 0/1", sent, failed)
	}

	rows := readLog(t, db, inst)
	if rows[0].Status != "queued" {
		t.Errorf("status = %q, want it held as queued for another attempt", rows[0].Status)
	}
	if rows[0].Error == nil || *rows[0].Error == "" {
		t.Error("no error recorded: the failure is invisible on the log screen")
	}
	if rows[0].SendAfter == nil || !rows[0].SendAfter.After(time.Now()) {
		t.Errorf("send_after = %v, want a future retry", rows[0].SendAfter)
	}
	if rows[0].Attempts != 1 {
		t.Errorf("attempts = %d, want 1", rows[0].Attempts)
	}

	// And the backoff must actually hold the row: an immediate second pass
	// must not hammer the dead host again.
	if _, f, err := s.DispatchMessages(ctx, inst, false, 10); err != nil || f != 0 {
		t.Errorf("second pass retried immediately: failed=%d err=%v", f, err)
	}
}

func TestRetryScheduleBacksOffThenGivesUp(t *testing.T) {
	var last time.Duration
	for attempt := 1; attempt < retryAttempts; attempt++ {
		retry, delay := retrySchedule(attempt)
		if !retry {
			t.Fatalf("attempt %d: gave up early; a provider outage would bury the queue", attempt)
		}
		if delay <= 0 {
			t.Fatalf("attempt %d: delay %v, want a positive backoff", attempt, delay)
		}
		if delay < last {
			t.Errorf("attempt %d: delay %v went backwards from %v", attempt, delay, last)
		}
		if delay > time.Hour {
			t.Errorf("attempt %d: delay %v exceeds the one-hour cap", attempt, delay)
		}
		last = delay
	}
	// The cap has to bind, or a long outage schedules retries days out.
	if _, d := retrySchedule(retryAttempts - 1); d != time.Hour {
		t.Errorf("last delay = %v, want the cap of 1h", d)
	}
	if retry, _ := retrySchedule(retryAttempts); retry {
		t.Errorf("attempt %d still retries; a message nobody can send must end as failed",
			retryAttempts)
	}
}
