package queue

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
)

type (
	contextArg      = context.Context
	rivertypeJobRow = rivertype.JobRow
)

/*
What can be asserted about the River wiring without a database.

	The trap this file exists for: River derives a worker's kind from a zero
	value of its args type, and this package's args type carries the kind as
	data. Registered the obvious way, every handler would land under "" and
	the second registration would fail -- or worse, the first would win and
	ten task types would silently have no worker. So the test builds the
	worker set exactly as newRiver does and asks River which kinds it knows.
*/
func TestEveryTaskTypeGetsItsOwnWorker(t *testing.T) {
	h := &Handlers{}
	if err := h.Handle("transport:test_sweep", time.Minute, func(_ contextArg, _ *Task) error { return nil }); err != nil {
		t.Fatal(err)
	}
	workers := river.NewWorkers()
	for kind, e := range h.table() {
		if err := addWorker(workers, kind, &adapter{kind: kind, entry: e, h: h}); err != nil {
			t.Fatalf("register %s: %v", kind, err)
		}
	}
	// Registering the same kind again must be refused, which is also what
	// proves the first registration went under its own name and not "".
	for kind := range h.table() {
		if err := addWorker(workers, kind, &adapter{kind: kind}); err == nil {
			t.Errorf("%s registered twice without complaint: the first went under the wrong key", kind)
		}
	}
}

// An insert-only client -- the web process -- must build with no pool at all,
// which is how River signals "I only insert inside your transactions".
func TestInsertOnlyClientBuilds(t *testing.T) {
	rc, err := newRiver(riverpgxv5.New(nil), nil)
	if err != nil {
		t.Fatalf("insert-only client: %v", err)
	}
	if rc == nil {
		t.Fatal("nil client")
	}
}

// Handle refuses built-in kinds and duplicates loudly, at registration, rather
// than letting the last writer win at the moment a job arrives.
func TestHandleRefusesCollisions(t *testing.T) {
	h := &Handlers{}
	noop := func(contextArg, *Task) error { return nil }
	if err := h.Handle(TypeMessageSend, time.Minute, noop); err == nil {
		t.Error("built-in kind re-registered without complaint")
	}
	if err := h.Handle("x:y", time.Minute, noop); err != nil {
		t.Fatal(err)
	}
	if err := h.Handle("x:y", time.Minute, noop); err == nil {
		t.Error("duplicate kind registered without complaint")
	}
}

// The timeout an enqueue asked for reaches the worker through metadata, and a
// job that carried none gets its kind's default.
func TestTimeoutTravelsInMetadata(t *testing.T) {
	_, opts, err := prepare(TypeBulkImport, BulkImportPayload{Kind: "students"}, HeavyOptions())
	if err != nil {
		t.Fatal(err)
	}
	if opts.Queue != QueueBulk || opts.MaxAttempts != 3 {
		t.Errorf("opts = queue %q, max_attempts %d; want bulk, 3", opts.Queue, opts.MaxAttempts)
	}
	var meta map[string]int64
	if err := json.Unmarshal(opts.Metadata, &meta); err != nil {
		t.Fatalf("metadata: %v", err)
	}
	if meta[metaTimeout] != (30 * time.Minute).Milliseconds() {
		t.Errorf("timeout_ms = %d, want 30 minutes", meta[metaTimeout])
	}

	a := &adapter{kind: TypeBulkImport, entry: entry{timeout: 5 * time.Minute}}
	job := &river.Job[rawArgs]{JobRow: &rivertypeJobRow{Metadata: opts.Metadata}}
	if got := a.Timeout(job); got != 30*time.Minute {
		t.Errorf("Timeout with metadata = %v, want 30m", got)
	}
	job = &river.Job[rawArgs]{JobRow: &rivertypeJobRow{}}
	if got := a.Timeout(job); got != 5*time.Minute {
		t.Errorf("Timeout without metadata = %v, want the kind's 5m", got)
	}
}

// The payload goes to River verbatim and comes back verbatim: what the
// handler decodes is exactly what the caller marshalled.
func TestRawArgsRoundTrip(t *testing.T) {
	args, _, err := prepare(TypeMessageSend, MessageSendPayload{Channel: "sms", TemplateKey: "t"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	var back rawArgs
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	var p MessageSendPayload
	if err := json.Unmarshal(back.raw, &p); err != nil || p.Channel != "sms" || p.TemplateKey != "t" {
		t.Errorf("round trip lost the payload: %s (%v)", back.raw, err)
	}
	if args.Kind() != TypeMessageSend {
		t.Errorf("kind = %q", args.Kind())
	}
}
