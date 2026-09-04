// Command web serves the JSON API and the server-rendered auth pages.
//
// It listens on loopback only; nginx terminates TLS and proxies to it. The
// React SPA is served by nginx directly from /var/www, not from this process.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/school-erp/erp/internal/api"
	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/config"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/queue"
	"github.com/school-erp/erp/internal/static"
	"github.com/school-erp/erp/internal/storage"
	"github.com/school-erp/erp/internal/templates"
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
		// Logger is not configured yet, so use the default one.
		return err
	}
	setupLogging(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := database.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns)
	if err != nil {
		return err
	}
	defer db.Close()

	qc, err := queue.NewClient(cfg.RedisURL)
	if err != nil {
		return err
	}
	defer qc.Close()

	inspector, err := queue.NewInspector(cfg.RedisURL)
	if err != nil {
		return err
	}
	defer inspector.Close()

	// R2 is optional at boot. The deploy script ships REPLACE_ME placeholders
	// and production is running with them, so refusing to start would take the
	// whole ERP down over a feature most requests never touch. Uploads return
	// 503 with an explicit reason instead.
	var store *storage.Store
	if s, err := storage.New(cfg.R2); err != nil {
		if errors.Is(err, storage.ErrNotConfigured) {
			slog.Warn("R2 is not configured; file uploads will return 503",
				"bucket", cfg.R2.Bucket)
		} else {
			return err
		}
	} else {
		store = s
	}

	tpl, err := templates.Parse()
	if err != nil {
		return err
	}

	sessions := auth.NewStore(db, cfg.SessionTTL, cfg.SessionIdleTTL, cfg.IsProduction())
	hasher := auth.NewHasher(cfg.PasswordPepper)
	authHandler := auth.NewHandler(db, sessions, hasher, tpl, cfg.IsProduction())

	apiServer := &api.Server{
		DB: db, Sessions: sessions, Hasher: hasher,
		Queue: qc, Inspector: inspector, Storage: store,
		FileStoreDir: cfg.FileStoreDir,
		BaseURL:      cfg.BaseURL,
	}

	r := chi.NewRouter()
	r.Use(httpx.RequestID, httpx.RealIP, httpx.Recoverer, httpx.SecurityHeaders)
	/* The logger is outermost on purpose: it has to time authentication, which
	   is where the time actually went. It still logs user_id -- see the slot in
	   httpx.WithIdentity. */
	r.Use(httpx.Logger)
	r.Use(sessions.Middleware) // attaches identity when a cookie is present
	/* And the same identity from a header, for callers that are not browsers.

	   Here rather than inside api.Server.Routes because AuditMiddleware wraps
	   /api/v1 from outside and reads the identity after the handler returns:
	   attached any further in, every write an integration made would appear in
	   audit_log with no actor. Transparent unless the request carries an
	   Authorization: Bearer erpk. token, so the cookie path is untouched.
	   See internal/api/api_keys.go. */
	r.Use(apiServer.APIKeyAuth)

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := db.Health(r.Context()); err != nil {
			httpx.JSON(w, http.StatusServiceUnavailable,
				map[string]string{"status": "degraded", "database": err.Error()})
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// The public front door: pricing and an enquiry, reachable with no account
	// and before any tenant exists.
	buyPage := &api.BuyPage{DB: db, Tpl: tpl}
	r.Get("/buy", buyPage.Show)
	r.Post("/buy", buyPage.Submit)

	// The staff Android apps, until they are on Google Play. Public by
	// necessity: the driver has no ERP account and the gateway handset lives
	// in a drawer. Safe to be public because both APKs are inert until an
	// administrator issues a pair code -- see internal/api/apps.go.
	appsPage := &api.AppsPage{Tpl: tpl, Dir: cfg.APKDir}
	r.Get("/apps", appsPage.Show)
	r.Get("/apps/{slug}.apk", appsPage.Download)
	// HEAD as well as GET: a download manager asks for the size before it
	// starts, and chi answers an unregistered method with 405, which some of
	// them treat as the file being gone rather than as an odd server.
	r.Head("/apps/{slug}.apk", appsPage.Download)

	// Self-service purchase. The enquiry form above is for schools that want
	// to talk to somebody; this is for schools that have finished deciding.
	// The gateway is simulated until real credentials are configured — see
	// internal/api/signup.go — but the signature it verifies is the real
	// algorithm against a real secret, so the swap is a two-line change.
	signup := &api.SignupPages{
		DB: db, Tpl: tpl, Hasher: hasher,
		GatewaySecret: cfg.GatewaySecret,
	}
	r.Get("/signup", signup.Show)
	r.Post("/signup", signup.Start)
	r.Get("/signup/pay/{order}", signup.Pay)
	r.Post("/signup/pay/{order}", signup.Callback)
	r.Get("/signup/welcome/{order}", signup.Welcome)

	// Getting back in without telephoning the school office. Public by
	// necessity: somebody who cannot sign in cannot be asked to sign in first.
	reset := &api.PasswordReset{
		DB: db, Tpl: tpl, Hasher: hasher, BaseURL: cfg.BaseURL,
		// Answered by the seller's own providers, not the school's: the
		// seller carries every school's reset links. The page never prints
		// a link on screen; where nothing can carry it, it says so.
		EmailReady: apiServer.EmailProviderReady,
	}
	r.Get("/forgot", reset.ShowForgot)
	r.Post("/forgot", reset.Forgot)
	r.Get("/reset", reset.ShowReset)
	r.Post("/reset", reset.Reset)

	r.Get("/login", authHandler.ShowLogin)
	r.Post("/login", authHandler.Login)
	r.Post("/logout", authHandler.Logout)
	r.Get("/logout", authHandler.Logout)

	/* The fingerprint reader, outside the session.

	   ADMS is a protocol for a client that cannot hold a session: no header,
	   no token, a serial number in a query string and nothing else. So these
	   sit above /api/v1 rather than inside it. The serial is the credential,
	   which is stated plainly in internal/api/iclock.go along with what that
	   does and does not permit — punches in, nothing out. */
	apiServer.MountDeviceProtocol(r)

	r.Handle("/static/*", http.StripPrefix("/static/", http.FileServer(http.FS(static.FS))))
	// Audit every mutation below /api/v1. Applied as middleware rather than
	// per handler, because per-handler auditing is the kind that ends up 80%
	// complete and nobody notices until the missing record is needed.
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(api.AuditMiddleware(db))
		r.Mount("/", apiServer.Routes())
	})

	srv := &http.Server{
		Addr:    cfg.HTTPAddr,
		Handler: r,
		// Generous read timeout for slow mobile uploads on school wifi; the
		// write timeout stays short because every response here is small JSON
		// and anything slow belongs on the queue.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("web server started", "addr", cfg.HTTPAddr, "env", cfg.AppEnv)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		slog.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func setupLogging(cfg *config.Config) {
	level := slog.LevelDebug
	if cfg.IsProduction() {
		level = slog.LevelInfo
	}
	// JSON to stdout; systemd captures it and journald indexes the fields.
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})))
}
