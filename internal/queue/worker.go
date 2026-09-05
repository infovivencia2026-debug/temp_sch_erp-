package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
)

/*
Task is one delivery of one job, as the handlers see it.

	The shape asynq's *Task had, minus asynq: a kind, the payload bytes, and
	which attempt this is. The handlers were written against exactly this much
	and nothing about River is visible to them, which is what let the bodies
	below survive the change of library untouched.
*/
type Task struct {
	ID      int64
	Kind    string
	Payload []byte
	Attempt int
}

// Handler is what every task type maps to.
type Handler func(context.Context, *Task) error

// SkipRetry marks an error that retrying cannot fix -- a payload that will
// not parse now will not parse on the fifth attempt either. The worker
// adapter turns it into a cancel, so the job is finalised on the first
// attempt instead of burning the queue. Wrap it: fmt.Errorf("%w: ...", SkipRetry).
var SkipRetry = errors.New("skip retry")

// Handlers carries the dependencies every task needs. Jobs talk to Postgres
// through the same RLS-scoped helper the HTTP layer uses, so a bug in a task
// cannot read across tenants either.
type Handlers struct {
	DB *database.DB

	/* Messaging is the way out of this package and into the messaging
	   contract, which lives in internal/api.

	   The dependency runs api -> queue: internal/api enqueues tasks, so queue
	   cannot import it back to reach s.DispatchMessages. Rather than move the
	   dispatcher -- its provider set, template resolution and quiet-hours
	   rules are the messaging feature, not the queue's -- the direction is
	   inverted here: queue declares the narrow interface it needs, api.Server
	   already satisfies it, and cmd/worker is the one place that knows both.

	   Nil is a supported state, not a bug. A worker built without messaging
	   skips these tasks and says so in the log rather than panicking or
	   reporting a success that did not happen. */
	Messaging Messaging

	// extra holds handlers registered from outside the package through Handle
	// -- the bus-tracker sweeps in internal/api, which cannot be listed in
	// routes because api imports queue and not the other way round. Filled
	// before New is called; the worker is built from the union.
	extra map[string]entry
}

// entry is one row of the task table: the handler and the deadline one
// attempt gets when the enqueue named none.
type entry struct {
	fn      Handler
	timeout time.Duration
}

/*
Handle registers a task type declared outside this package.

	Must run before New builds the worker: River takes its worker set at
	construction and a kind registered later is a kind it has never heard of.
	cmd/worker calls RegisterBusTrackerJobs, which calls this, and only then
	opens the queue. Registering a kind twice is a programming error and says
	so at once rather than letting the second silently win.
*/
func (h *Handlers) Handle(kind string, timeout time.Duration, fn Handler) error {
	if _, dup := h.routes()[kind]; dup {
		return fmt.Errorf("queue: %s is a built-in task type", kind)
	}
	if _, dup := h.extra[kind]; dup {
		return fmt.Errorf("queue: %s registered twice", kind)
	}
	if h.extra == nil {
		h.extra = map[string]entry{}
	}
	h.extra[kind] = entry{fn: fn, timeout: timeout}
	return nil
}

// table is the full worker set: the built-in routes with their default
// timeouts, plus everything Handle added.
func (h *Handlers) table() map[string]entry {
	out := map[string]entry{}
	for kind, fn := range h.routes() {
		out[kind] = entry{fn: fn, timeout: defaultTimeouts[kind]}
	}
	for kind, e := range h.extra {
		out[kind] = e
	}
	return out
}

// defaultTimeouts are the per-type deadlines when an enqueue names none.
// They mirror what the cron entries and the option profiles hand out, so a
// job that arrives without metadata -- one inserted by hand in psql, say --
// still gets the deadline its kind was designed for rather than River's
// none.
var defaultTimeouts = map[string]time.Duration{
	TypeReportCardGenerate: 30 * time.Minute,
	TypeInvoiceGenerate:    30 * time.Minute,
	TypeFeeReminderFanout:  30 * time.Minute,
	TypeMessageSend:        time.Minute,
	TypeMessageDispatch:    10 * time.Minute,
	TypeMessagePlans:       10 * time.Minute,
	TypeBulkImport:         30 * time.Minute,
	TypeExportBuild:        30 * time.Minute,
	TypeAttendanceRollup:   10 * time.Minute,
	TypeSessionPrune:       5 * time.Minute,
	TypeDiaryReminders:     2 * time.Minute,
}

/*
Messaging is what the queue needs from the messaging feature, and no more.

	Two methods, both already on api.Server. Declaring the interface here
	rather than in internal/api is what makes the inversion work at all: Go
	interfaces are satisfied structurally, so api.Server needs no reference to
	this declaration and no import cycle is created.
*/
type Messaging interface {
	// QueueOutbound resolves the template and the recipient's address and
	// writes one row to message_log, respecting the one-per-occurrence index.
	// It does not send; the dispatcher does that.
	QueueOutbound(ctx context.Context, inst uuid.UUID, req OutboundRequest) error

	// DispatchMessages hands due rows to their provider. platform selects the
	// RLS scope: false for a single tenant's own queue, which is what the
	// per-institution cron entries want.
	DispatchMessages(ctx context.Context, inst uuid.UUID, platform bool, limit int) (sent, failed int, err error)

	// RunMessagePlans evaluates one school's reminder plans -- the overdue-fee
	// chase and the absence alert -- and queues what they produce. It queues
	// only; DispatchMessages is still the one road out of the building, which
	// is what keeps the recipient allowlist in front of every message.
	RunMessagePlans(ctx context.Context, inst uuid.UUID) error
}

// OutboundRequest is one message to queue. Declared here for the same reason
// the interface is: it is part of the contract queue depends on, and naming it
// must not require importing api.
type OutboundRequest struct {
	Channel       string
	TemplateCode  string
	ToUserID      uuid.UUID
	Vars          map[string]any
	SourceKind    string
	SourceID      uuid.UUID
	OccurrenceKey string
}

// routes is the task table, as data rather than as a sequence of calls, so
// that a test can ask which types are handled without executing any of them --
// which is how a scheduled type with no handler is caught at test time instead
// of as a "handler not found" in production at 00:30.
func (h *Handlers) routes() map[string]Handler {
	return map[string]Handler{
		TypeReportCardGenerate: h.reportCardGenerate,
		TypeInvoiceGenerate:    h.invoiceGenerate,
		TypeFeeReminderFanout:  h.feeReminderFanout,
		TypeMessageSend:        h.messageSend,
		TypeMessageDispatch:    h.messageDispatch,
		TypeMessagePlans:       h.messagePlans,
		TypeBulkImport:         h.bulkImport,
		TypeExportBuild:        h.exportBuild,
		TypeAttendanceRollup:   h.attendanceRollup,
		TypeSessionPrune:       h.sessionPrune,
		TypeDiaryReminders:     h.diaryReminders,
	}
}

// logging wraps every handler with the one log line per run that the
// worker's logs are read by: the task, how long, which tenant, which request
// started it. The River adapter applies it; nothing else needs to.
func (h *Handlers) logging(next Handler) Handler {
	return func(ctx context.Context, t *Task) error {
		start := time.Now()
		var env struct {
			Envelope
		}
		_ = json.Unmarshal(t.Payload, &env)

		err := next(ctx, t)

		attrs := []any{
			"task", t.Kind,
			"river_id", t.ID,
			"attempt", t.Attempt,
			"duration_ms", time.Since(start).Milliseconds(),
			"institution_id", env.InstitutionID,
			"job_id", env.JobID,
			"request_id", env.RequestID,
		}
		if err != nil {
			slog.Error("task failed", append(attrs, "error", err)...)
		} else {
			slog.Info("task", attrs...)
		}
		return err
	}
}

// decode unmarshals the payload and rebuilds the tenant scope it must run in.
func decode[T any](t *Task) (T, database.Scope, error) {
	var p T
	if err := json.Unmarshal(t.Payload, &p); err != nil {
		// SkipRetry: a payload that will not parse now will not parse on the
		// fifth attempt either. Retrying it just burns the queue.
		return p, database.Scope{}, fmt.Errorf("%w: %v", SkipRetry, err)
	}
	var env struct{ Envelope }
	_ = json.Unmarshal(t.Payload, &env)
	return p, database.Scope{InstitutionID: env.InstitutionID}, nil
}

// --- handlers ---------------------------------------------------------------
//
// Each handler below establishes its tenant scope and then does the real work.
// The bodies are intentionally the minimum that exercises the plumbing
// end-to-end; the business rules for each belong in their own package as the
// modules are built out.

func (h *Handlers) reportCardGenerate(ctx context.Context, t *Task) error {
	p, scope, err := decode[ReportCardGeneratePayload](t)
	if err != nil {
		return err
	}
	return h.DB.InTenant(ctx, scope, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT e.student_id
			  FROM enrollments e
			 WHERE e.section_id = $1 AND e.status = 'active'`, p.SectionID)
		if err != nil {
			return err
		}
		defer rows.Close()

		n := 0
		for rows.Next() {
			n++
		}
		if err := rows.Err(); err != nil {
			return err
		}
		slog.Info("report cards queued for render", "exam_id", p.ExamID, "students", n)
		return nil
	})
}

func (h *Handlers) invoiceGenerate(ctx context.Context, t *Task) error {
	p, scope, err := decode[InvoiceGeneratePayload](t)
	if err != nil {
		return err
	}
	return h.DB.InTenant(ctx, scope, func(tx pgx.Tx) error {
		var students int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM enrollments WHERE academic_year_id = $1 AND status = 'active'`,
			p.AcademicYearID).Scan(&students); err != nil {
			return err
		}
		slog.Info("invoice run", "fee_structure_id", p.FeeStructureID, "students", students)
		return nil
	})
}

func (h *Handlers) feeReminderFanout(ctx context.Context, t *Task) error {
	p, scope, err := decode[FeeReminderFanoutPayload](t)
	if err != nil {
		return err
	}
	// Fan-out reads the overdue set here and enqueues one message per guardian
	// rather than sending inline: a single task that sends 3,000 SMS holds a
	// worker slot for minutes and loses all progress if it dies at message
	// 2,900. One task per message retries independently.
	return h.DB.InTenant(ctx, scope, func(tx pgx.Tx) error {
		var overdue int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM invoices
			 WHERE status IN ('unpaid','partial','overdue') AND due_on < $1`,
			p.OverdueSince).Scan(&overdue); err != nil {
			return err
		}
		slog.Info("fee reminder fanout", "overdue_invoices", overdue, "template", p.TemplateKey)
		return nil
	})
}

/*
messageSend queues one outbound message through the messaging contract.

	It used to write message_log directly, naming columns the table has never
	had -- template_key and to_user_id, where the columns are template_code and
	user_id -- and omitting recipient, which is NOT NULL. Every execution
	errored, was retried ten times under CriticalOptions and died, so the two
	live callers (the absence SMS in mod_academics, the circular fan-out in
	mod_ops) have never delivered anything. Rebuilding that INSERT correctly
	here would mean rebuilding template resolution, address lookup and the
	provider check beside it, and then maintaining two of each. It delegates.

	Idempotency comes from the envelope's JobID. River redelivers the identical
	payload on retry, so JobID is stable across attempts, and it names the
	occurrence -- which makes the one-per-occurrence index the thing that stops
	a parent being told twice, rather than this handler having to remember.
*/
func (h *Handlers) messageSend(ctx context.Context, t *Task) error {
	p, _, err := decode[MessageSendPayload](t)
	if err != nil {
		return err
	}
	if h.Messaging == nil {
		slog.Warn("message send skipped: no messaging contract wired",
			"institution_id", p.InstitutionID, "template", p.TemplateKey)
		return nil
	}
	return h.Messaging.QueueOutbound(ctx, p.InstitutionID, OutboundRequest{
		Channel:      p.Channel,
		TemplateCode: p.TemplateKey,
		ToUserID:     p.ToUserID,
		Vars:         p.Vars,
		SourceKind:   "queue_task",
		SourceID:     p.JobID,
		// The template code is part of the occurrence, not only its source: a
		// second template about the same event is a second message, and both
		// are wanted.
		OccurrenceKey: p.TemplateKey,
	})
}

/*
messageDispatch is the flush that had never been scheduled.

	message_log accumulated rows with send_after set and nothing ever selected
	them, so every trigger rule in the product queued correctly and delivered
	nothing. This is the other end of that pipe, driven by the cron entry in
	scheduler.go.

	Safe to run twice. DispatchMessages claims each row with FOR UPDATE SKIP
	LOCKED and only ever selects status = 'queued', so two overlapping ticks --
	a retry firing beside the next scheduled run -- divide the queue between
	them instead of both sending it. That property lives in the SQL rather than
	in a lock held here, which is what makes a retry harmless.
*/
func (h *Handlers) messageDispatch(ctx context.Context, t *Task) error {
	p, _, err := decode[MessageDispatchPayload](t)
	if err != nil {
		return err
	}
	if h.Messaging == nil {
		slog.Warn("message dispatch skipped: no messaging contract wired",
			"institution_id", p.InstitutionID)
		return nil
	}
	// platform=false: the sweep runs once per institution, inside that
	// institution's own RLS scope. As platform, one tick would see every
	// school's queue at once -- the dispatcher filters on institution_id
	// anyway, but the row-level policy would stop being what guarantees it.
	sent, failed, err := h.Messaging.DispatchMessages(ctx, p.InstitutionID, false, p.Limit)
	if sent > 0 || failed > 0 || err != nil {
		slog.Info("message dispatch", "institution_id", p.InstitutionID,
			"sent", sent, "failed", failed)
	}
	return err
}

/*
messagePlans runs the reminder plans for one school.

	Separate from messageDispatch because they are opposite ends of the same
	pipe and fail differently: this one fills message_log from what is true
	right now, and a fault here means nothing was queued; that one drains it,
	and a fault there means a provider is refusing. Merging them would report
	one number for two questions.

	A nil Messaging is a supported state, not a bug -- a worker built without
	the messaging feature says so and moves on rather than panicking.
*/
func (h *Handlers) messagePlans(ctx context.Context, t *Task) error {
	p, _, err := decode[MessagePlansPayload](t)
	if err != nil {
		return err
	}
	if h.Messaging == nil {
		slog.Warn("message plans skipped: no messaging contract wired",
			"institution_id", p.InstitutionID)
		return nil
	}
	return h.Messaging.RunMessagePlans(ctx, p.InstitutionID)
}

func (h *Handlers) bulkImport(ctx context.Context, t *Task) error {
	p, _, err := decode[BulkImportPayload](t)
	if err != nil {
		return err
	}
	slog.Info("bulk import", "kind", p.Kind, "file_key", p.FileKey)
	return nil
}

func (h *Handlers) exportBuild(ctx context.Context, t *Task) error {
	p, _, err := decode[ExportBuildPayload](t)
	if err != nil {
		return err
	}
	slog.Info("export build", "kind", p.Kind, "format", p.Format)
	return nil
}

func (h *Handlers) attendanceRollup(ctx context.Context, t *Task) error {
	p, scope, err := decode[AttendanceRollupPayload](t)
	if err != nil {
		return err
	}
	return h.DB.InTenant(ctx, scope, func(tx pgx.Tx) error {
		var marked int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM student_attendance WHERE on_date = $1`, p.On).Scan(&marked); err != nil {
			return err
		}
		slog.Info("attendance rollup", "on", p.On.Format(time.DateOnly), "rows", marked)
		return nil
	})
}

// sessionPrune is cron-driven housekeeping. Expired rows are harmless to reads
// (Resolve filters on expires_at) but the table grows without bound otherwise.
/* Reminders the child asked for, delivered when they asked.

   A diary note carried a date and nothing else, so "hand in the science
   project" sat on Thursday's page and reached nobody on Thursday: the child had
   to open the diary to be reminded by the diary, which is the one thing a
   reminder exists not to require.

   Swept rather than scheduled per note. A job queued for each reminder would
   mean a job to cancel when a note is edited or ticked off, and a queue holding
   thousands of pending tasks for reminders most of which will be done before
   they fire. One query every five minutes over a partial index costs almost
   nothing and has no state to keep in step.

   Late rather than early, and never twice. reminded_at is stamped in the same
   statement that selects the row, so two sweeps overlapping cannot both claim
   it — a reminder arriving twice is worse than one arriving four minutes late.
*/
func (h *Handlers) diaryReminders(ctx context.Context, _ *Task) error {
	var sent int

	err := h.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		/* Claim and read in one statement.

		   The UPDATE ... RETURNING is the whole concurrency story: whichever
		   sweep gets there first stamps reminded_at, and the other's WHERE no
		   longer matches. Nothing needs locking and nothing needs a queue. */
		rows, err := tx.Query(ctx, `
			UPDATE student_diary_notes n
			   SET reminded_at = now()
			 WHERE n.id IN (
			     SELECT id FROM student_diary_notes
			      WHERE remind_at IS NOT NULL
			        AND reminded_at IS NULL
			        AND remind_at <= now()
			        AND done_at IS NULL
			      ORDER BY remind_at
			      LIMIT 500)
			RETURNING n.institution_id, n.author_user_id, n.student_id,
			          n.kind, n.body, to_char(n.on_date, 'YYYY-MM-DD')`)
		if err != nil {
			return fmt.Errorf("claim due reminders: %w", err)
		}

		type due struct {
			inst, author, student any
			kind, body, onDate    string
		}
		var batch []due
		for rows.Next() {
			var d due
			if err := rows.Scan(&d.inst, &d.author, &d.student,
				&d.kind, &d.body, &d.onDate); err != nil {
				rows.Close()
				return err
			}
			batch = append(batch, d)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		/* Told to whoever wrote it, not to the child.

		   A parent keeping a young child's diary is a real case — the note
		   belongs to the child's day and the reminder belongs to the person who
		   asked to be reminded. Sending it to the student would tell the wrong
		   person, and sending it to both would tell a fourteen-year-old their
		   mother set them a reminder. */
		for _, d := range batch {
			title := "Reminder"
			if d.kind != "" && d.kind != "note" {
				title = "Reminder: " + d.kind
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO notifications
				    (institution_id, user_id, kind, title, body, link)
				VALUES ($1, $2, 'diary_reminder', $3, $4, '/go/digital_diary_schedule')`,
				d.inst, d.author, title, d.body); err != nil {
				return fmt.Errorf("notify: %w", err)
			}
			sent++
		}
		return nil
	})
	if err != nil {
		return err
	}
	if sent > 0 {
		slog.Info("diary reminders sent", "count", sent)
	}
	return nil
}

func (h *Handlers) sessionPrune(ctx context.Context, _ *Task) error {
	return h.DB.AsPlatform(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`)
		if err != nil {
			return err
		}
		slog.Info("pruned sessions", "rows", tag.RowsAffected())

		/* The receipts the offline outbox retries against.
		 *
		 * Each one is a stored copy of a response, kept so a client that
		 * resent a write is answered rather than made to do it twice. They
		 * are only useful while a client might still retry, and the client
		 * gives up after seven days -- so a receipt older than that can
		 * answer nobody and is just a copy of a response body sitting in the
		 * table that sees every write in the product.
		 *
		 * Fourteen rather than seven: the two clocks are not the same clock,
		 * and expiring the receipt while a client still believes it may retry
		 * is the one ordering that reintroduces the double write. */
		tag, err = tx.Exec(ctx,
			`DELETE FROM idempotency_keys WHERE created_at < now() - interval '14 days'`)
		if err != nil {
			return err
		}
		slog.Info("pruned idempotency receipts", "rows", tag.RowsAffected())
		return nil
	})
}
