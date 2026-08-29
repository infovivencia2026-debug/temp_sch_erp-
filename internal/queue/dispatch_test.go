package queue

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
)

/*
The wiring that had never existed, tested where it is decidable without a
database.

	What broke this feature was not a bug inside any one function -- it was
	that nothing joined them up: message_log had a send_after column, the
	dispatcher knew how to read it, and no scheduler entry ever ran the
	dispatcher. So these tests assert the joins. That the cron entry exists and
	names the dispatch task; that the mux routes that task to a handler; that
	the handler reaches the messaging contract with the tenant it was given;
	and that a worker without a messaging contract degrades quietly instead of
	panicking.

	The sends themselves need providers, templates and rows, and are asserted
	end to end in internal/api against a real database.
*/

// fakeMessaging records what the handlers asked for. It stands in for
// *api.Server, which the queue package cannot import -- which is the whole
// point of the interface being declared here.
type fakeMessaging struct {
	queued    []OutboundRequest
	queuedFor []uuid.UUID

	dispatchedFor []uuid.UUID
	dispatchedAs  []bool
	limits        []int

	sent, failed int
	queueErr     error
	dispatchErr  error

	plansFor []uuid.UUID
	plansErr error
}

func (f *fakeMessaging) QueueOutbound(_ context.Context, inst uuid.UUID, req OutboundRequest) error {
	f.queued = append(f.queued, req)
	f.queuedFor = append(f.queuedFor, inst)
	return f.queueErr
}

func (f *fakeMessaging) DispatchMessages(_ context.Context, inst uuid.UUID, platform bool, limit int) (int, int, error) {
	f.dispatchedFor = append(f.dispatchedFor, inst)
	f.dispatchedAs = append(f.dispatchedAs, platform)
	f.limits = append(f.limits, limit)
	return f.sent, f.failed, f.dispatchErr
}

func (f *fakeMessaging) RunMessagePlans(_ context.Context, inst uuid.UUID) error {
	f.plansFor = append(f.plansFor, inst)
	return f.plansErr
}

func task(t *testing.T, typ string, payload any) *asynq.Task {
	t.Helper()
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return asynq.NewTask(typ, b)
}

// The regression this whole task exists to prevent: a scheduler with no
// message dispatch entry, which is what shipped and why no trigger rule ever
// delivered anything.
func TestSchedulerRegistersMessageDispatch(t *testing.T) {
	inst := uuid.New()
	env := Envelope{InstitutionID: inst}

	var found bool
	for _, e := range schedulerEntries(env) {
		if e.typ != TypeMessageDispatch {
			continue
		}
		found = true
		if e.spec != "* * * * *" {
			t.Errorf("dispatch cron spec = %q, want every 1 minute", e.spec)
		}
		p, ok := e.payload.(MessageDispatchPayload)
		if !ok {
			t.Fatalf("dispatch payload is %T, want MessageDispatchPayload", e.payload)
		}
		// Without the institution on the envelope the handler would run with
		// no tenant scope and see zero rows -- a dispatch that silently does
		// nothing, which is indistinguishable from the bug being fixed.
		if p.InstitutionID != inst {
			t.Errorf("dispatch payload institution = %v, want %v", p.InstitutionID, inst)
		}
		if p.Limit <= 0 {
			t.Errorf("dispatch limit = %d, want a positive bound", p.Limit)
		}
	}
	if !found {
		t.Fatal("no cron entry for TypeMessageDispatch: queued messages would never be flushed")
	}
}

// Every scheduled entry must carry the tenant it runs for, or it runs against
// no tenant at all. Guards the three that existed as well as the new one.
func TestSchedulerEntriesAreWellFormed(t *testing.T) {
	env := Envelope{InstitutionID: uuid.New()}
	seen := map[string]bool{}
	for _, e := range schedulerEntries(env) {
		if seen[e.typ] {
			t.Errorf("%s registered twice: asynq would run it twice per tick", e.typ)
		}
		seen[e.typ] = true
		if _, err := json.Marshal(e.payload); err != nil {
			t.Errorf("%s payload does not marshal: %v", e.typ, err)
		}
		if len(e.opts) == 0 {
			t.Errorf("%s has no options: it would inherit asynq's defaults, not ours", e.typ)
		}
	}
}

// The mux is the other half of the join: an entry that enqueues a task type no
// handler is registered for fails at run time, not at build time.
func TestMuxHandlesEveryScheduledType(t *testing.T) {
	routes := (&Handlers{}).routes()
	for _, e := range schedulerEntries(Envelope{InstitutionID: uuid.New()}) {
		if _, ok := routes[e.typ]; !ok {
			t.Errorf("scheduled type %s has no handler registered: every tick "+
				"would fail with \"handler not found\"", e.typ)
		}
	}
}

func TestMessageDispatchUsesTenantScope(t *testing.T) {
	f := &fakeMessaging{sent: 3, failed: 1}
	h := &Handlers{Messaging: f}
	inst := uuid.New()

	err := h.messageDispatch(context.Background(),
		task(t, TypeMessageDispatch, MessageDispatchPayload{
			Envelope: Envelope{InstitutionID: inst}, Limit: 25,
		}))
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if len(f.dispatchedFor) != 1 || f.dispatchedFor[0] != inst {
		t.Fatalf("dispatched for %v, want [%v]", f.dispatchedFor, inst)
	}
	// The scoping decision the task brief calls out: dispatch runs per tenant
	// inside that tenant's RLS scope, not as platform across all of them.
	if f.dispatchedAs[0] {
		t.Error("dispatch ran as platform admin; it must run inside the tenant's own scope")
	}
	if f.limits[0] != 25 {
		t.Errorf("limit = %d, want 25", f.limits[0])
	}
}

// A dispatch error must propagate so asynq retries. Retrying is safe because
// DispatchMessages claims rows with FOR UPDATE SKIP LOCKED and only ever
// selects status = 'queued'.
func TestMessageDispatchPropagatesError(t *testing.T) {
	boom := errors.New("postgres unreachable")
	h := &Handlers{Messaging: &fakeMessaging{dispatchErr: boom}}
	err := h.messageDispatch(context.Background(),
		task(t, TypeMessageDispatch, MessageDispatchPayload{Envelope: Envelope{InstitutionID: uuid.New()}}))
	if !errors.Is(err, boom) {
		t.Fatalf("error = %v, want it to propagate for retry", err)
	}
}

func TestMessageSendGoesThroughTheContract(t *testing.T) {
	f := &fakeMessaging{}
	h := &Handlers{Messaging: f}
	inst, job, user := uuid.New(), uuid.New(), uuid.New()

	err := h.messageSend(context.Background(), task(t, TypeMessageSend, MessageSendPayload{
		Envelope:    Envelope{InstitutionID: inst, JobID: job},
		Channel:     "sms",
		TemplateKey: "attendance.absent",
		ToUserID:    user,
		Vars:        map[string]any{"student_name": "Asha"},
	}))
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(f.queued) != 1 {
		t.Fatalf("queued %d messages, want 1", len(f.queued))
	}
	got := f.queued[0]
	if f.queuedFor[0] != inst {
		t.Errorf("queued for %v, want %v", f.queuedFor[0], inst)
	}
	if got.Channel != "sms" || got.TemplateCode != "attendance.absent" || got.ToUserID != user {
		t.Errorf("request = %+v, want the payload's channel, template and recipient", got)
	}
	if got.Vars["student_name"] != "Asha" {
		t.Errorf("vars lost in translation: %+v", got.Vars)
	}
	// The idempotency key. asynq redelivers an identical payload on retry, so
	// a stable JobID here is what lets the one-per-occurrence index refuse the
	// second copy rather than a parent getting the same SMS on every attempt.
	if got.SourceKind == "" || got.SourceID != job {
		t.Errorf("source = %q/%v, want a stable key from the job id %v",
			got.SourceKind, got.SourceID, job)
	}
}

// Two deliveries of the same task must produce the same idempotency key, or
// the index cannot recognise the retry as a duplicate.
func TestMessageSendKeyIsStableAcrossRetries(t *testing.T) {
	f := &fakeMessaging{}
	h := &Handlers{Messaging: f}
	tk := task(t, TypeMessageSend, MessageSendPayload{
		Envelope: Envelope{InstitutionID: uuid.New(), JobID: uuid.New()},
		Channel:  "email", TemplateKey: "fees.overdue", ToUserID: uuid.New(),
	})

	for i := 0; i < 2; i++ {
		if err := h.messageSend(context.Background(), tk); err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	a, b := f.queued[0], f.queued[1]
	if a.SourceKind != b.SourceKind || a.SourceID != b.SourceID || a.OccurrenceKey != b.OccurrenceKey {
		t.Errorf("idempotency key differs between attempts: %+v vs %+v", a, b)
	}
}

// A worker built without the messaging contract -- a test binary, or a future
// queue-only deployment -- must not panic on a message task.
func TestMessageTasksTolerateNoMessagingContract(t *testing.T) {
	h := &Handlers{}
	if err := h.messageDispatch(context.Background(),
		task(t, TypeMessageDispatch, MessageDispatchPayload{})); err != nil {
		t.Errorf("dispatch without contract: %v", err)
	}
	if err := h.messageSend(context.Background(),
		task(t, TypeMessageSend, MessageSendPayload{})); err != nil {
		t.Errorf("send without contract: %v", err)
	}
}

// A malformed payload must not be retried: it will not parse on the fifth
// attempt either.
func TestMessageDispatchSkipsRetryOnBadPayload(t *testing.T) {
	h := &Handlers{Messaging: &fakeMessaging{}}
	err := h.messageDispatch(context.Background(), asynq.NewTask(TypeMessageDispatch, []byte("{not json")))
	if err == nil || !errors.Is(err, asynq.SkipRetry) {
		t.Fatalf("error = %v, want SkipRetry", err)
	}
}
