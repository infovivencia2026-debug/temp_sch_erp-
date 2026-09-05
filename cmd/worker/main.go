// Command worker consumes the job queue.
//
// It is a separate process from the web server on purpose: a report-card run
// that pins the CPU must not be able to make health checks time out, and the
// two can be scaled and restarted independently. It used to be the cron
// scheduler as well, which is what made it the one process that could never
// stop; the schedule now runs from a request (see internal/queue/cron.go),
// and this process only keeps an in-process tick as a fallback for the box,
// where CRON_INPROCESS=1 and nothing has changed.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/school-erp/erp/internal/api"
	"github.com/school-erp/erp/internal/config"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/push"
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

	// REDIS_URL is read by config for as long as the env files carry it, and
	// means nothing to this process any more. Said once so that an operator
	// reading the boot log does not go looking for the Redis that is not
	// being used.
	if os.Getenv("REDIS_URL") != "" {
		slog.Info("REDIS_URL is set and ignored: the queue is in Postgres now")
	}

	/* The one place that knows about both packages.

	   internal/api imports internal/queue to enqueue, so queue cannot import
	   api back to reach the dispatcher. queue declares the narrow interface it
	   needs (queue.Messaging) and *api.Server satisfies it; this process, which
	   already depends on both, is where the two are joined. Nothing else in the
	   worker touches api, and api learns nothing about the worker.

	   The Server here is deliberately partial: the dispatcher reaches Postgres
	   and the provider registry and nothing else, so Sessions, Hasher, Queue,
	   Inspector and Storage stay nil rather than being constructed to look
	   complete. A worker that could serve HTTP would be a second web process
	   nobody meant to deploy. */
	transport := &api.Server{DB: db}
	handlers := &queue.Handlers{DB: db, Messaging: transport}

	/* THE SWEEPS THAT CLOSE A RUN NOBODY IS ON.

	   Registered before the queue is opened, because River takes its worker
	   set at construction and a kind added afterwards is a kind it does not
	   work. Missing this line was why a trip stayed open for two days with
	   its last fix forty hours old: the office saw a bus mid-run that had
	   finished, and the next driver was refused with "a run is already
	   open". */
	if err := transport.RegisterBusTrackerJobs(handlers); err != nil {
		return err
	}

	qc, err := queue.New(ctx, cfg.DatabaseURL, handlers)
	if err != nil {
		return err
	}
	defer qc.Close()
	// The Server enqueues too -- a fan-out that produces one message:send per
	// guardian goes through the same client the worker consumes from.
	transport.Queue = qc

	/* Cron, in-process, only where asked.

	   The VPS has systemd and no external scheduler, so its worker keeps
	   ticking every minute exactly as the asynq scheduler did, against the
	   same schedule the /api/v1/cron endpoint evaluates. On the platform the
	   variable is unset, a scheduler calls the endpoint, and this process
	   does nothing but work jobs -- which is what lets it be stopped when
	   there are none. */
	if os.Getenv("CRON_INPROCESS") == "1" {
		cron := &queue.Cron{DB: db, Queue: qc, Schedules: transport.CronSchedules()}
		go cron.Run(ctx, time.Minute)
	} else {
		slog.Info("cron is external: expecting a scheduler to call /api/v1/cron")
	}

	/* Push to the parent app. Off unless the Firebase service account is
	   configured, and says so once, so an installation without it is not
	   silently mistaken for one that is failing. */
	if sender, err := push.New(cfg.FCMServiceAccountFile); err != nil {
		slog.Error("push disabled: service account unusable", "err", err)
	} else if sender == nil {
		slog.Info("push disabled: FCM_SERVICE_ACCOUNT_FILE not set")
	} else {
		go transport.RunPushPump(ctx, sender, cfg.BaseURL)
	}

	/* A HEARTBEAT ON A PORT, FOR A HOST THAT INSISTS ON ONE.

	   The worker has no HTTP surface of its own: it consumes a queue. Cloud
	   Run only knows how to keep a service alive if it answers on $PORT, and
	   kills one that does not within the start-up window. So when PORT is
	   set -- and only then, the systemd deployment sets nothing -- a tiny
	   listener answers /healthz with the database's own health, so the
	   platform's probe means "the worker can reach Postgres" rather than "a
	   process exists". Anything else on the port is 404: this is not an API,
	   and the queue is not reachable through it. */
	if port := os.Getenv("PORT"); port != "" {
		health := http.NewServeMux()
		health.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
			if err := db.Health(r.Context()); err != nil {
				http.Error(w, "degraded: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
			if err := qc.Health(r.Context()); err != nil {
				http.Error(w, "degraded: queue: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("ok"))
		})
		hs := &http.Server{Addr: ":" + port, Handler: health, ReadHeaderTimeout: 5 * time.Second}
		go func() {
			<-ctx.Done()
			_ = hs.Close()
		}()
		go func() {
			if err := hs.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				slog.Error("health listener stopped", "err", err)
			}
		}()
		slog.Info("health listener up", "addr", hs.Addr)
	}

	if err := qc.Start(ctx); err != nil {
		return err
	}
	slog.Info("worker started", "queues", queue.Priorities)

	<-ctx.Done()
	slog.Info("shutting down worker")
	// Thirty seconds for in-flight jobs to finish, matching the old
	// ShutdownTimeout. A job still running after that is left "running" and
	// River rescues it back to the queue once RescueStuckJobsAfter passes.
	stopCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return qc.Stop(stopCtx)
}
