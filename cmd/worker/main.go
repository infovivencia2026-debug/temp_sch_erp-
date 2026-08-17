// Command worker consumes the asynq queues and runs the cron scheduler.
//
// It is a separate process from the web server on purpose: a report-card run
// that pins the CPU must not be able to make health checks time out, and the
// two can be scaled and restarted independently.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/config"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/queue"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := database.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns)
	if err != nil {
		return err
	}
	defer db.Close()

	redisOpt, err := asynq.ParseRedisURI(cfg.RedisURL)
	if err != nil {
		return err
	}

	srv := asynq.NewServer(redisOpt, asynq.Config{
		// One vCPU shared with nginx, Postgres and Redis. More goroutines here
		// would not add throughput, they would just add contention -- the
		// bottleneck for every task in this system is Postgres, not Go.
		Concurrency: 4,
		Queues:      queue.Priorities,
		// StrictPriority off: low-priority housekeeping should still run even
		// while a large import is draining.
		StrictPriority: false,
		ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, t *asynq.Task, err error) {
			retried, _ := asynq.GetRetryCount(ctx)
			max, _ := asynq.GetMaxRetry(ctx)
			slog.Error("task error", "type", t.Type(), "retried", retried, "max_retry", max, "error", err)
		}),
		// Exponential with a floor, so a transient Postgres blip does not
		// hammer a recovering database.
		RetryDelayFunc: asynq.RetryDelayFunc(func(n int, _ error, _ *asynq.Task) time.Duration {
			d := time.Duration(1<<uint(n)) * time.Second
			if d > 10*time.Minute {
				return 10 * time.Minute
			}
			return d
		}),
		ShutdownTimeout: 30 * time.Second,
		HealthCheckFunc: func(err error) {
			if err != nil {
				slog.Error("queue health check failed", "error", err)
			}
		},
	})

	handlers := &queue.Handlers{DB: db}

	scheduler, err := queue.NewScheduler(cfg.RedisURL, schedulerTimezone(ctx, db))
	if err != nil {
		return err
	}
	for _, inst := range institutions(ctx, db) {
		if err := scheduler.Register(inst); err != nil {
			return err
		}
	}
	if err := scheduler.Start(); err != nil {
		return err
	}
	defer scheduler.Shutdown()

	go func() {
		<-ctx.Done()
		slog.Info("shutting down worker")
		srv.Shutdown()
	}()

	slog.Info("worker started", "concurrency", 4, "queues", queue.Priorities)
	return srv.Run(handlers.Mux())
}

// schedulerTimezone reads the tenant timezone so nightly jobs fire at local
// 00:30, not UTC 00:30 -- a five-and-a-half hour difference in India, which
// would put the "yesterday" rollup in the middle of the school day.
func schedulerTimezone(ctx context.Context, db *database.DB) string {
	tz := "UTC"
	_ = db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT timezone FROM institutions WHERE status = 'active' ORDER BY created_at LIMIT 1`).
			Scan(&tz)
	})
	return tz
}

func institutions(ctx context.Context, db *database.DB) []uuid.UUID {
	var out []uuid.UUID
	_ = db.AsPlatform(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id FROM institutions WHERE status = 'active'`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				return err
			}
			out = append(out, id)
		}
		return rows.Err()
	})
	return out
}
