// Command worker runs background jobs and the outbox relay.
//
// Same module, same config, same migrations as cmd/api — only the entrypoint
// differs, so a job and a request can never disagree about business rules.
//
// Phase 1 ships the machinery: weighted queues, the task registry, and the relay
// that turns outbox rows into queued tasks. The jobs themselves (email, SMS,
// PDFs, imports, reconciliation) arrive with the modules that need them.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hibiken/asynq"

	"github.com/school-erp/erp/pkg/config"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/observability"
	"github.com/school-erp/erp/pkg/queue"
)

func main() {
	if err := run(); err != nil {
		slog.Error("worker failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "configuration error: %v\n", err)
		return err
	}
	observability.SetupLogger(cfg.LogLevel, !cfg.IsProduction())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := database.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()

	redisOpt := asynq.RedisClientOpt{Addr: cfg.RedisAddr, DB: cfg.RedisDB}

	// Weighted queues, so a fifty-thousand-row import cannot starve a fee
	// receipt. Asynq drains higher-weighted queues proportionally more often.
	srv := asynq.NewServer(redisOpt, asynq.Config{
		Concurrency: 10,
		Queues: map[string]int{
			queue.QueueCritical: 6, // payments, receipts, OTP
			queue.QueueDefault:  3, // notifications, PDFs
			queue.QueueBulk:     1, // imports, exports, report card runs
		},
		RetryDelayFunc: queue.RetryDelay,
		ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, task *asynq.Task, err error) {
			retried, _ := asynq.GetRetryCount(ctx)
			maxRetry, _ := asynq.GetMaxRetry(ctx)
			logger := slog.With("task", task.Type(), "retry", retried, "max_retry", maxRetry)
			if retried >= maxRetry {
				// Exhausted tasks are archived by Asynq. This is the line an
				// alert watches: a dead job is work a school expected to happen.
				logger.Error("task exhausted its retries and was archived", "error", err)
				return
			}
			logger.Warn("task failed, will retry", "error", err)
		}),
	})

	mux := asynq.NewServeMux()
	queue.Register(mux)

	// The relay publishes outbox rows written inside business transactions. It
	// is what makes "payment recorded" and "receipt sent" survive a crash
	// between the commit and the enqueue.
	relay := queue.NewRelay(db, asynq.NewClient(redisOpt), 2*time.Second)
	go relay.Run(ctx)

	go func() {
		<-ctx.Done()
		slog.Info("shutdown signal received, finishing in-flight tasks")
		srv.Shutdown()
	}()

	slog.Info("worker starting", "redis", cfg.RedisAddr, "concurrency", 10)
	if err := srv.Run(mux); err != nil {
		return fmt.Errorf("worker: %w", err)
	}
	return nil
}
