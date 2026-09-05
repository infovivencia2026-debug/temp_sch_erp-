package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver"
	"github.com/riverqueue/river/rivertype"
)

// Retention keeps completed jobs inspectable for this long, so a status
// endpoint can answer "done" rather than "unknown" after success. The value
// is the contract GET /api/v1/jobs/{id} states: known for a day, then 404.
const Retention = 24 * time.Hour

// maxBackoff caps the exponential retry delay. A transient Postgres blip must
// not hammer a recovering database, and a job that has failed nine times is
// not going to succeed in the tenth second either.
const maxBackoff = 10 * time.Minute

/*
newRiver builds the River client both processes share the configuration of.

	With h nil there are no workers and no queues, which River takes to mean
	insert-only: no producers, no leader election, no maintenance services,
	and no LISTEN. That is the web process. With h set it is the worker:
	every kind in the handler table gets a worker, each queue gets its weight
	in slots, and the cleaner runs to enforce Retention.

	The retry policy and the timeout rule are the two behaviours asynq had
	that River expresses differently, and both are kept: backoff is
	exponential from one second and capped at ten minutes, and a job's own
	timeout is read back out of its metadata by the worker adapter.
*/
func newRiver(driver riverdriver.Driver[pgx.Tx], h *Handlers) (*river.Client[pgx.Tx], error) {
	cfg := &river.Config{
		Logger:      slog.Default(),
		RetryPolicy: backoff{},
		// The insert-only client does not run the cleaner, so setting these
		// there is harmless; the worker is where they take effect.
		CompletedJobRetentionPeriod: Retention,
		CancelledJobRetentionPeriod: Retention,
		// A job that gave up is the one an operator most needs to see, and
		// the platform screen shows it as "archived". A week rather than a
		// day so a Monday can still see Friday's failures.
		DiscardedJobRetentionPeriod: 7 * 24 * time.Hour,
		// A job whose worker died mid-flight sits "running" until this
		// passes, then goes back to available. Longer than the longest
		// timeout we hand out (30 minutes), so a slow import is never
		// rescued out from under a worker that is still on it.
		RescueStuckJobsAfter: 45 * time.Minute,
		ErrorHandler:         errorLogger{},
		// Cloud Run may give the worker a container that cannot hold a
		// LISTEN for long; polling is the fallback River uses when the
		// notifier drops, and a two-second poll is cheap on a table this
		// size. The notifier still wins when it is up.
		FetchPollInterval: 2 * time.Second,
	}
	if h != nil {
		cfg.Workers = river.NewWorkers()
		for kind, e := range h.table() {
			if err := addWorker(cfg.Workers, kind, &adapter{kind: kind, entry: e, h: h}); err != nil {
				return nil, fmt.Errorf("register worker %s: %w", kind, err)
			}
		}
		cfg.Queues = map[string]river.QueueConfig{}
		for q, weight := range Priorities {
			cfg.Queues[q] = river.QueueConfig{MaxWorkers: weight}
		}
	}
	rc, err := river.NewClient(driver, cfg)
	if err != nil {
		return nil, fmt.Errorf("river client: %w", err)
	}
	return rc, nil
}

/*
addWorker registers one adapter under a kind River learns at run time.

	AddWorker and AddWorkerSafely read the kind off a zero value of the args
	type, which for rawArgs is the empty string -- every handler would land
	on one key and River would refuse the second. AddWorkerArgs takes the
	args value explicitly, which is the one door for a kind that is data
	rather than a type; River's own comment calls it internal-only, and it
	panics rather than returning, so the panic is caught here and made an
	error like everything else at boot. If a future River removes it, the
	replacement is one Go type per kind with Kind() on each, and this
	function is the only place that changes.
*/
func addWorker(workers *river.Workers, kind string, w *adapter) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	river.AddWorkerArgs(workers, rawArgs{kind: kind}, w)
	return nil
}

func (c *Client) hasWorkers() bool { return c.river != nil && c.workersConfigured }

func totalWorkers() int {
	n := 0
	for _, w := range Priorities {
		n += w
	}
	return n
}

// backoff is asynq's RetryDelayFunc as a River retry policy: 1s, 2s, 4s, ...
// capped at maxBackoff. job.Attempt is the attempt that just failed, starting
// at one, so the first retry waits two seconds -- close enough to the old
// curve that nothing downstream notices.
type backoff struct{}

func (backoff) NextRetry(job *rivertype.JobRow) time.Time {
	n := job.Attempt
	if n < 0 {
		n = 0
	}
	if n > 20 { // 2^20 seconds is already far past the cap
		n = 20
	}
	d := time.Duration(1<<uint(n)) * time.Second
	if d > maxBackoff {
		d = maxBackoff
	}
	return time.Now().Add(d)
}

// errorLogger is what River tells about a failure. The handler's own logging
// middleware already records the error with the task's context; this adds
// the attempt count, which only River knows.
type errorLogger struct{}

func (errorLogger) HandleError(_ context.Context, job *rivertype.JobRow, err error) *river.ErrorHandlerResult {
	slog.Error("task error", "type", job.Kind, "job_id", job.ID,
		"attempt", job.Attempt, "max_attempts", job.MaxAttempts, "error", err)
	return nil
}

func (errorLogger) HandlePanic(_ context.Context, job *rivertype.JobRow, panicVal any, trace string) *river.ErrorHandlerResult {
	slog.Error("task panic", "type", job.Kind, "job_id", job.ID,
		"attempt", job.Attempt, "panic", panicVal, "trace", trace)
	return nil
}

/*
adapter makes one handler entry into a River worker.

	One instance per kind, registered under that kind by addWorker above.
	Work turns River's job back into the Task the handlers were written
	against, so the handler bodies did not change when the library did.

	Timeout is where the per-job deadline comes back: the enqueue put it in
	metadata, and the kind's own default applies when a caller set none.
	SkipRetry is translated to River's cancel here so that a payload that
	will never parse is finalised on the first attempt rather than retried
	into the ground.
*/
type adapter struct {
	river.WorkerDefaults[rawArgs]
	kind  string
	entry entry
	h     *Handlers
}

func (a *adapter) Timeout(job *river.Job[rawArgs]) time.Duration {
	var meta struct {
		TimeoutMS int64 `json:"timeout_ms"`
	}
	if len(job.Metadata) > 0 {
		_ = json.Unmarshal(job.Metadata, &meta)
	}
	if meta.TimeoutMS > 0 {
		return time.Duration(meta.TimeoutMS) * time.Millisecond
	}
	if a.entry.timeout > 0 {
		return a.entry.timeout
	}
	return 10 * time.Minute
}

func (a *adapter) Work(ctx context.Context, job *river.Job[rawArgs]) error {
	t := &Task{
		ID:      job.ID,
		Kind:    a.kind,
		Payload: job.Args.raw,
		Attempt: job.Attempt,
	}
	err := a.h.logging(a.entry.fn)(ctx, t)
	if errors.Is(err, SkipRetry) {
		return river.JobCancel(err)
	}
	return err
}
