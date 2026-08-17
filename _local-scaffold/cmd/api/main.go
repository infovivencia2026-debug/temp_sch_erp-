// Command api is the ERP HTTP server.
//
//	api serve     start the HTTP server (default)
//	api migrate   apply pending migrations and exit
//	api seed      load development data and exit
//
// One binary, one image, one set of migrations — cmd/worker is the same code
// with a different entrypoint, so background behaviour can never drift from
// request behaviour.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/school-erp/erp/internal/seed"
	"github.com/school-erp/erp/internal/server"
	"github.com/school-erp/erp/migrations"
	"github.com/school-erp/erp/pkg/config"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/observability"
)

func main() {
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}

	if err := run(command); err != nil {
		slog.Error("fatal", "command", command, "error", err)
		os.Exit(1)
	}
}

func run(command string) error {
	cfg, err := config.Load()
	if err != nil {
		// Config failures happen before the logger exists, and are almost always
		// a missing environment variable — say so plainly on stderr.
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

	switch command {
	case "migrate":
		return database.Migrate(ctx, db, migrations.FS, os.Getenv("DB_APP_ROLE"))
	case "seed":
		return seed.Run(ctx, db)
	case "serve":
		return serve(ctx, cfg, db)
	default:
		return fmt.Errorf("unknown command %q (want serve, migrate or seed)", command)
	}
}

func serve(ctx context.Context, cfg config.Config, db *database.DB) error {
	rdb := redis.NewClient(&redis.Options{Addr: cfg.RedisAddr, DB: cfg.RedisDB})
	defer rdb.Close()

	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		// Sessions live in Redis, so serving without it would mean nobody can
		// log in. Fail at startup rather than at the first request.
		return fmt.Errorf("redis at %s: %w", cfg.RedisAddr, err)
	}

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.New(cfg, db, rdb).Engine,
		ReadHeaderTimeout: server.ReadHeaderTimeout,
		ReadTimeout:       server.ReadTimeout,
		WriteTimeout:      server.WriteTimeout,
		IdleTimeout:       server.IdleTimeout,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("api listening",
			"addr", cfg.HTTPAddr, "env", cfg.Env, "version", server.Version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		slog.Info("shutdown signal received, draining connections")
	}

	// Give in-flight requests a chance to finish; a payment in progress should
	// not be cut off by a deploy.
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelShutdown()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	slog.Info("stopped cleanly")
	return nil
}
