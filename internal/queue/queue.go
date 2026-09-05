// Package queue is the asynchronous execution layer.
//
// Anything whose cost is unbounded by user input goes here rather than into a
// request handler: report-card generation for a whole grade, fee-reminder
// fan-out to a few thousand guardians, bulk imports, PDF and XLSX exports.
// A 1 vCPU web process that renders 400 report cards inline stops answering
// health checks, and nginx starts returning 502 to everyone else.
//
// Postgres backs the queue. It used to be Redis, through asynq, and the
// change is not about asynq -- it did its job -- but about what it required:
// a Redis to run against and a process that never stopped. The worker had to
// be always-on because it was also the cron scheduler, and Redis had to be
// always-on because the queue lived in it. Neither fits a platform that
// starts a container when a request arrives and stops it when none do. River
// (github.com/riverqueue/river) keeps jobs in river_job, in the same database
// every other table lives in, so a queued fee reminder survives whatever the
// process does, and a worker that is not running is a backlog rather than a
// loss. Cron moved out with it: see cron.go.
//
// What did not change is the shape callers see. Enqueue takes a type, a
// payload and options; the SPA polls GET /api/v1/jobs/{id}; the four queues
// and their weights are the same names. Task types are still a wire format.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

// Task type names are stable strings persisted in river_job.kind. Renaming one
// strands every job already queued under the old name, so treat them as a wire
// format. (River calls this the job's "kind"; the rest of this codebase says
// "type", and both words mean this string.)
const (
	TypeReportCardGenerate = "reportcard:generate"
	TypeInvoiceGenerate    = "invoice:generate"
	TypeFeeReminderFanout  = "fee:reminder_fanout"
	TypeMessageSend        = "message:send"
	TypeMessageDispatch    = "message:dispatch"
	/* Diary reminders that have come due.

	   Swept rather than queued per note: a job per reminder would mean a job to
	   cancel when a note is edited or ticked off, and a queue holding thousands
	   of pending tasks most of which will be done before they fire. */
	TypeDiaryReminders   = "diary:reminders"
	TypeMessagePlans     = "message:plans"
	TypeBulkImport       = "bulk:import"
	TypeExportBuild      = "export:build"
	TypeAttendanceRollup = "attendance:rollup"
	TypeSessionPrune     = "session:prune"
)

// Queue names, highest priority first. The worker weights these so a 5,000-row
// import can never starve a password-reset email.
const (
	QueueCritical = "critical" // auth mail, payment webhooks
	QueueDefault  = "default"  // interactive work a user is waiting on
	QueueBulk     = "bulk"     // imports, exports, fan-outs
	QueueLow      = "low"      // rollups, housekeeping
)

/*
Priorities are the weights of the four queues.

	Under asynq these were relative fetch weights on a shared pool of four
	goroutines. River has no weighted fetch: each queue gets its own producer
	with its own ceiling of concurrent jobs, and that ceiling is what the
	weight becomes. The property the weights existed for survives intact --
	a long bulk backlog cannot starve critical, because critical has its own
	slots, and low is still serviced, because it has one -- but the number
	now means "this many at once" rather than "this many turns in ten". In
	practice three of the four queues are idle at any moment, so the total
	rarely approaches twelve, and every job's bottleneck is Postgres, not Go.
*/
var Priorities = map[string]int{
	QueueCritical: 6,
	QueueDefault:  3,
	QueueBulk:     2,
	QueueLow:      1,
}

// Queues lists the four in priority order, for anything that wants a stable
// iteration rather than a map's.
var Queues = []string{QueueCritical, QueueDefault, QueueBulk, QueueLow}

// --- payloads ---------------------------------------------------------------

// Envelope is embedded in every payload. InstitutionID is what lets the worker
// re-establish the RLS scope the enqueuing request had; without it a job would
// run with no tenant set and quietly see zero rows. RequestID threads the
// originating HTTP request id into the worker's logs.
type Envelope struct {
	InstitutionID uuid.UUID `json:"institution_id"`
	ActorUserID   uuid.UUID `json:"actor_user_id"`
	RequestID     string    `json:"request_id,omitempty"`
	JobID         uuid.UUID `json:"job_id"`
}

type ReportCardGeneratePayload struct {
	Envelope
	ExamID    uuid.UUID   `json:"exam_id"`
	SectionID uuid.UUID   `json:"section_id"`
	StudentID []uuid.UUID `json:"student_ids,omitempty"`
}

type InvoiceGeneratePayload struct {
	Envelope
	FeeStructureID uuid.UUID `json:"fee_structure_id"`
	AcademicYearID uuid.UUID `json:"academic_year_id"`
	DueOn          time.Time `json:"due_on"`
}

type FeeReminderFanoutPayload struct {
	Envelope
	OverdueSince time.Time `json:"overdue_since"`
	TemplateKey  string    `json:"template_key"`
}

type MessageSendPayload struct {
	Envelope
	Channel     string         `json:"channel"` // sms | email | push | whatsapp
	TemplateKey string         `json:"template_key"`
	ToUserID    uuid.UUID      `json:"to_user_id"`
	Vars        map[string]any `json:"vars,omitempty"`
}

/*
MessageDispatchPayload drives the recurring flush of message_log.

	It carries no work of its own -- the queue of what to send is the table,
	not the payload -- so the only field is how much of it to drain in one
	pass. That is deliberate: a payload that named the rows would go stale
	between the scheduler enqueuing it and the worker running it, and a row
	queued in between would wait for the next tick for no reason.

	Limit bounds one run, not the queue. A tick that finds 4,000 due messages
	sends the oldest Limit of them and leaves the rest for the next tick, which
	is a minute away -- the alternative, draining without bound, is one task
	holding a worker slot for an hour with a timeout it cannot meet.
*/
type MessageDispatchPayload struct {
	Envelope
	Limit int `json:"limit"`
}

/*
MessagePlansPayload drives the reminder-plan sweep for one school.

	Nothing but the envelope: which plans exist, how often each chases and
	what it skips are the school's own configuration, held in
	message_trigger_rules, not in a job payload. A payload carrying a rule id
	would be a schedule that goes stale the moment somebody edits the rule.
*/
type MessagePlansPayload struct {
	Envelope
}

type BulkImportPayload struct {
	Envelope
	Kind    string `json:"kind"` // students | employees | marks
	FileKey string `json:"file_key"`
}

type ExportBuildPayload struct {
	Envelope
	Kind   string         `json:"kind"`   // students | invoices | attendance
	Format string         `json:"format"` // csv | xlsx | pdf
	Filter map[string]any `json:"filter,omitempty"`
}

type AttendanceRollupPayload struct {
	Envelope
	On time.Time `json:"on"`
}

// --- options ----------------------------------------------------------------

// Option adjusts one enqueue. It is this package's own type rather than
// River's so that the eleven call sites in internal/api name nothing about
// which library is underneath -- they did not change when asynq left and
// they will not change if River does.
type Option func(*insertSpec)

// insertSpec is what an Option edits: River's insert options plus the one
// thing River does not carry per job, the timeout. River makes the timeout a
// property of the worker, and it is right that a kind has a default -- but
// a caller who knows this particular run is long says so at enqueue, as it
// always could, and the worker honours it. It travels in the job's metadata.
type insertSpec struct {
	river.InsertOpts
	timeout time.Duration
}

// Timeout is the metadata key the per-job deadline travels under.
const metaTimeout = "timeout_ms"

// Options are the defaults per task type: which queue, how many retries, how
// long one attempt may take. Retention is no longer an option because it is
// no longer per job: the worker keeps every completed job for 24 hours (see
// newRiver), which is what lets GET /api/v1/jobs/{id} answer "done" rather
// than "unknown" after success, and 404 after that.
func Options(queue string, maxRetry int, timeout time.Duration) []Option {
	return []Option{
		func(s *insertSpec) { s.Queue = queue },
		// asynq counted retries after the first attempt; River counts
		// attempts including it. Same number of tries either way.
		func(s *insertSpec) { s.MaxAttempts = maxRetry + 1 },
		func(s *insertSpec) { s.timeout = timeout },
	}
}

// HeavyOptions is the profile for user-triggered long work: the bulk queue, a
// generous timeout, and few retries, because re-running a half-finished import
// is usually worse than surfacing the failure.
func HeavyOptions() []Option { return Options(QueueBulk, 2, 30*time.Minute) }

// InteractiveOptions is for work a user is actively waiting on.
func InteractiveOptions() []Option { return Options(QueueDefault, 5, 2*time.Minute) }

// CriticalOptions is for delivery that must not be lost.
func CriticalOptions() []Option { return Options(QueueCritical, 10, time.Minute) }

// ScheduledAt delays a job until a moment. Used by the cron tick for nothing
// today; here so a caller who needs it does not reach for River directly.
func ScheduledAt(at time.Time) Option { return func(s *insertSpec) { s.ScheduledAt = at } }

// --- client -----------------------------------------------------------------

/*
Client is the one handle on the queue: it enqueues, it inspects, and -- when
built with Handlers -- it works.

	It owns a pool of its own to the same database rather than borrowing the
	application's. database.DB deliberately does not hand out its pool, so
	that every query in this codebase goes through InTenant or AsPlatform and
	carries a tenant; River's own queries against river_job carry none and
	want none, and they must not be made to compete for the RLS-scoped
	connections a request is using. The pool is small in the web process,
	which only inserts, and sized to the worker slots in the worker.
*/
type Client struct {
	pool  *pgxpool.Pool
	river *river.Client[pgx.Tx]
	// workersConfigured is whether this client was built with handlers --
	// the difference between "a web process that enqueues" and "the worker".
	// working is whether Start has run and Stop has not.
	workersConfigured bool
	working           bool
}

// New opens the queue. With h nil the client is insert-and-inspect only,
// which is what cmd/web wants; with h set it is a worker and Start begins
// fetching. Insert-only clients neither poll nor lease, so an idle web
// process costs the database nothing.
func New(ctx context.Context, databaseURL string, h *Handlers) (*Client, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL for queue: %w", err)
	}
	// Inserts are one statement each and short. The worker needs a
	// connection per concurrent job plus River's own producers, notifier and
	// maintenance services, so it gets the sum of the weights and headroom.
	cfg.MaxConns = 3
	if h != nil {
		cfg.MaxConns = int32(totalWorkers() + 4)
	}
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = 5 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect queue pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping queue pool: %w", err)
	}

	rc, err := newRiver(riverpgxv5.New(pool), h)
	if err != nil {
		pool.Close()
		return nil, err
	}
	return &Client{pool: pool, river: rc, workersConfigured: h != nil}, nil
}

// Close releases the pool. Stop first if the client is working; Close does
// not wait for jobs.
func (c *Client) Close() error {
	c.pool.Close()
	return nil
}

// Start begins working jobs. Only meaningful on a client built with
// Handlers; on an insert-only client it is an error, because a process that
// thinks it is working and is not is the silent kind of broken.
func (c *Client) Start(ctx context.Context) error {
	if !c.hasWorkers() {
		return errors.New("queue: Start on a client built without handlers")
	}
	if err := c.river.Start(ctx); err != nil {
		return fmt.Errorf("start river: %w", err)
	}
	c.working = true
	slog.Info("queue worker started", "queues", Priorities)
	return nil
}

// Stop lets running jobs finish, then returns. ctx bounds the wait; a job
// still running when it expires is left for another worker to rescue, which
// River does after RescueStuckJobsAfter.
func (c *Client) Stop(ctx context.Context) error {
	if !c.working {
		return nil
	}
	c.working = false
	if err := c.river.Stop(ctx); err != nil {
		return fmt.Errorf("stop river: %w", err)
	}
	return nil
}

// Enqueue serialises the payload and writes it to river_job. The returned id
// is River's, as a decimal string, so an HTTP handler can answer 202 with
// something the client can poll -- it is distinct from Envelope.JobID, which
// is the caller's own idempotency key and is inside the payload.
func (c *Client) Enqueue(ctx context.Context, typ string, payload any, opts ...Option) (string, error) {
	args, insertOpts, err := prepare(typ, payload, opts)
	if err != nil {
		return "", err
	}
	res, err := c.river.Insert(ctx, args, insertOpts)
	if err != nil {
		return "", fmt.Errorf("enqueue %s: %w", typ, err)
	}
	return strconv.FormatInt(res.Job.ID, 10), nil
}

// EnqueueTx is Enqueue inside a caller's transaction, on any connection to
// the same database -- the application's RLS-scoped one included, since
// river_job has no policy. The cron tick uses it so that "this schedule ran"
// and "its job exists" commit together or not at all.
func (c *Client) EnqueueTx(ctx context.Context, tx pgx.Tx, typ string, payload any, opts ...Option) (string, error) {
	args, insertOpts, err := prepare(typ, payload, opts)
	if err != nil {
		return "", err
	}
	res, err := c.river.InsertTx(ctx, tx, args, insertOpts)
	if err != nil {
		return "", fmt.Errorf("enqueue %s: %w", typ, err)
	}
	return strconv.FormatInt(res.Job.ID, 10), nil
}

func prepare(typ string, payload any, opts []Option) (river.JobArgs, *river.InsertOpts, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal %s payload: %w", typ, err)
	}
	spec := insertSpec{}
	for _, o := range opts {
		o(&spec)
	}
	if spec.timeout > 0 {
		meta, err := json.Marshal(map[string]any{metaTimeout: spec.timeout.Milliseconds()})
		if err != nil {
			return nil, nil, err
		}
		spec.Metadata = meta
	}
	return rawArgs{kind: typ, raw: b}, &spec.InsertOpts, nil
}

/*
rawArgs is how a kind chosen at run time becomes a River job.

	River's model is one Go type per kind, with Kind() on the type. This
	codebase's model is a string constant and a payload struct, chosen by the
	caller, decoded by the handler -- which is what let asynq's mux route by
	name and what the eleven call sites in internal/api are written against.
	rawArgs bridges the two: it carries the kind as data and the payload as
	the bytes it already is, so River sees a JobArgs and the handler sees the
	JSON it expects. On the way out MarshalJSON returns the payload verbatim;
	on the way in UnmarshalJSON keeps the bytes for the handler to decode.
*/
type rawArgs struct {
	kind string
	raw  json.RawMessage
}

func (a rawArgs) Kind() string                  { return a.kind }
func (a rawArgs) MarshalJSON() ([]byte, error)  { return a.raw, nil }
func (a *rawArgs) UnmarshalJSON(b []byte) error { a.raw = append(a.raw[:0], b...); return nil }
