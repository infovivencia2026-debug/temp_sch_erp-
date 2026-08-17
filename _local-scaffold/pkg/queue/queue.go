// Package queue owns background work: the task registry, the weighted queues,
// and the outbox relay.
//
// The relay is the important part. Asynq stores tasks in Redis, so enqueuing is
// not transactional with the Postgres write that caused it — a crash between
// COMMIT and Enqueue would silently drop the job. For work a school notices the
// absence of ("payment received, send the receipt"), the business transaction
// writes an outbox row instead, and this relay turns it into a task. Delivery is
// at-least-once, so every handler must be idempotent.
//
// Fire-and-forget work (an export, a nightly report) can enqueue directly.
package queue

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"time"

	"github.com/hibiken/asynq"
	"github.com/school-erp/erp/pkg/database"
)

// Queue names, weighted in cmd/worker.
const (
	QueueCritical = "critical"
	QueueDefault  = "default"
	QueueBulk     = "bulk"
)

// Task types. One constant per job so a typo is a compile error.
const (
	TaskNotificationSend = "notification:send"
)

// Register wires task types to their handlers. Phase 1 registers the one task
// the relay can already produce; each module adds its own as it lands.
func Register(mux *asynq.ServeMux) {
	mux.HandleFunc(TaskNotificationSend, handleNotificationSend)
}

// handleNotificationSend is a placeholder that logs and succeeds. It exists so
// the relay path is exercised end to end; the real channel adapters (email, SMS,
// WhatsApp, push) arrive in Phase 10.
func handleNotificationSend(_ context.Context, t *asynq.Task) error {
	var payload map[string]any
	_ = json.Unmarshal(t.Payload(), &payload)
	slog.Info("notification task received (no channel adapters until Phase 10)",
		"payload", payload)
	return nil
}

// RetryDelay backs off exponentially with a ceiling. A gateway that is down for
// ten minutes should not be hammered every second, and a task should not wait
// an hour once it recovers.
func RetryDelay(n int, _ error, _ *asynq.Task) time.Duration {
	delay := time.Duration(math.Pow(2, float64(n))) * time.Second
	if delay > 5*time.Minute {
		return 5 * time.Minute
	}
	return delay
}

// Relay moves outbox rows into the queue.
type Relay struct {
	db       *database.DB
	client   *asynq.Client
	interval time.Duration
	batch    int
}

func NewRelay(db *database.DB, client *asynq.Client, interval time.Duration) *Relay {
	return &Relay{db: db, client: client, interval: interval, batch: 100}
}

func (r *Relay) Run(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	slog.Info("outbox relay started", "interval", r.interval)

	for {
		select {
		case <-ctx.Done():
			slog.Info("outbox relay stopped")
			return
		case <-ticker.C:
			if n, err := r.drain(ctx); err != nil {
				slog.Error("outbox relay failed", "error", err)
			} else if n > 0 {
				slog.Debug("outbox relay published", "count", n)
			}
		}
	}
}

type outboxRow struct {
	ID       int64
	EventKey string
	Payload  []byte
}

// drain publishes a batch. Rows are claimed with FOR UPDATE SKIP LOCKED so
// several worker replicas can run this concurrently without publishing the same
// event twice — and if the process dies after publishing but before marking the
// row, the event is delivered again, which is why handlers are idempotent.
func (r *Relay) drain(ctx context.Context) (int, error) {
	return database.InTx(ctx, r.db, func(tx database.Tx) (int, error) {
		rows, err := tx.Query(ctx, `
			SELECT id, event_key, payload
			FROM   outbox_events
			WHERE  published_at IS NULL
			ORDER  BY id
			LIMIT  $1
			FOR UPDATE SKIP LOCKED`, r.batch)
		if err != nil {
			return 0, err
		}

		var pending []outboxRow
		for rows.Next() {
			var row outboxRow
			if err := rows.Scan(&row.ID, &row.EventKey, &row.Payload); err != nil {
				rows.Close()
				return 0, err
			}
			pending = append(pending, row)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return 0, err
		}

		published := 0
		for _, row := range pending {
			task := asynq.NewTask(taskTypeFor(row.EventKey), row.Payload)
			if _, err := r.client.EnqueueContext(ctx, task,
				asynq.Queue(queueFor(row.EventKey)), asynq.MaxRetry(10)); err != nil {
				// Record the failure and leave the row unpublished: the next
				// tick retries it. An outbox row is never dropped.
				if _, uerr := tx.Exec(ctx, `
					UPDATE outbox_events
					SET    attempts = attempts + 1, last_error = $2
					WHERE  id = $1`, row.ID, err.Error()); uerr != nil {
					return published, uerr
				}
				continue
			}
			if _, err := tx.Exec(ctx,
				`UPDATE outbox_events SET published_at = now() WHERE id = $1`, row.ID); err != nil {
				return published, err
			}
			published++
		}
		return published, nil
	})
}

// taskTypeFor maps a domain event to the task that reacts to it. As modules land
// this becomes a registry; for now every event routes to the notification task.
func taskTypeFor(_ string) string { return TaskNotificationSend }

// queueFor decides urgency. Money and credentials go to critical; everything
// else waits its turn.
func queueFor(eventKey string) string {
	switch eventKey {
	case "fee.payment_received", "fee.payment_failed", "auth.otp_requested":
		return QueueCritical
	default:
		return QueueDefault
	}
}
