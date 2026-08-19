// Package queue is the asynchronous execution layer.
//
// Anything whose cost is unbounded by user input goes here rather than into a
// request handler: report-card generation for a whole grade, fee-reminder
// fan-out to a few thousand guardians, bulk imports, PDF and XLSX exports.
// A 1 vCPU web process that renders 400 report cards inline stops answering
// health checks, and nginx starts returning 502 to everyone else.
//
// Redis backs both this and the session cache, and it runs with
// maxmemory-policy noeviction on purpose: silently dropping a queued fee
// reminder is worse than failing the enqueue loudly.
package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
)

// Task type names are stable strings persisted in Redis. Renaming one strands
// every job already queued under the old name, so treat them as a wire format.
const (
	TypeReportCardGenerate = "reportcard:generate"
	TypeInvoiceGenerate    = "invoice:generate"
	TypeFeeReminderFanout  = "fee:reminder_fanout"
	TypeMessageSend        = "message:send"
	TypeMessageDispatch    = "message:dispatch"
	TypeBulkImport         = "bulk:import"
	TypeExportBuild        = "export:build"
	TypeAttendanceRollup   = "attendance:rollup"
	TypeSessionPrune       = "session:prune"
)

// Queue names, highest priority first. The worker weights these so a 5,000-row
// import can never starve a password-reset email.
const (
	QueueCritical = "critical" // auth mail, payment webhooks
	QueueDefault  = "default"  // interactive work a user is waiting on
	QueueBulk     = "bulk"     // imports, exports, fan-outs
	QueueLow      = "low"      // rollups, housekeeping
)

// Priorities are relative weights, not strict ordering: asynq still services
// low-priority queues, just less often. Strict priority would let a long bulk
// backlog starve housekeeping entirely.
var Priorities = map[string]int{
	QueueCritical: 6,
	QueueDefault:  3,
	QueueBulk:     2,
	QueueLow:      1,
}

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
	is 5 minutes away -- the alternative, draining without bound, is one task
	holding a worker slot for an hour with a timeout it cannot meet.
*/
type MessageDispatchPayload struct {
	Envelope
	Limit int `json:"limit"`
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

// --- enqueue ----------------------------------------------------------------

type Client struct{ c *asynq.Client }

func NewClient(redisURL string) (*Client, error) {
	opt, err := asynq.ParseRedisURI(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	return &Client{c: asynq.NewClient(opt)}, nil
}

func (c *Client) Close() error { return c.c.Close() }

// Enqueue serialises the payload and hands it to Redis. The returned job id is
// the same value the caller put in the Envelope, so an HTTP handler can answer
// 202 with something the client can poll.
func (c *Client) Enqueue(ctx context.Context, typ string, payload any, opts ...asynq.Option) (string, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal %s payload: %w", typ, err)
	}
	info, err := c.c.EnqueueContext(ctx, asynq.NewTask(typ, b), opts...)
	if err != nil {
		return "", fmt.Errorf("enqueue %s: %w", typ, err)
	}
	return info.ID, nil
}

// Defaults per task type. Retention keeps completed jobs inspectable so a
// status endpoint can answer "done" rather than "unknown" after success.
func Options(queue string, maxRetry int, timeout time.Duration) []asynq.Option {
	return []asynq.Option{
		asynq.Queue(queue),
		asynq.MaxRetry(maxRetry),
		asynq.Timeout(timeout),
		asynq.Retention(24 * time.Hour),
	}
}

// HeavyOptions is the profile for user-triggered long work: the bulk queue, a
// generous timeout, and few retries, because re-running a half-finished import
// is usually worse than surfacing the failure.
func HeavyOptions() []asynq.Option { return Options(QueueBulk, 2, 30*time.Minute) }

// InteractiveOptions is for work a user is actively waiting on.
func InteractiveOptions() []asynq.Option { return Options(QueueDefault, 5, 2*time.Minute) }

// CriticalOptions is for delivery that must not be lost.
func CriticalOptions() []asynq.Option { return Options(QueueCritical, 10, time.Minute) }
