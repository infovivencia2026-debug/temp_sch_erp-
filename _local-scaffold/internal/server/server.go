// Package server wires the modules together. It is the only place that knows
// about every module, which is what keeps the modules from knowing about each
// other.
package server

import (
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"github.com/school-erp/erp/internal/audit"
	authmod "github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/health"
	"github.com/school-erp/erp/internal/sis"
	"github.com/school-erp/erp/internal/tenancy"
	"github.com/school-erp/erp/pkg/auth"
	"github.com/school-erp/erp/pkg/config"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/httpx"
	"github.com/school-erp/erp/pkg/observability"
)

const Version = "0.1.0-phase1"

type Server struct {
	Engine *gin.Engine
}

func New(cfg config.Config, db *database.DB, rdb *redis.Client) *Server {
	if cfg.IsProduction() {
		gin.SetMode(gin.ReleaseMode)
	}

	engine := gin.New()

	// Gin trusts X-Forwarded-For from every peer by default, which would make
	// the client IP in the audit log whatever the caller claims. Trust only the
	// proxies we were told about.
	_ = engine.SetTrustedProxies(cfg.TrustedProxies)

	engine.Use(
		httpx.RequestIDMiddleware(),
		httpx.RecoveryMiddleware(),
		httpx.LoggingMiddleware(),
		observability.MetricsMiddleware(),
		httpx.SecurityHeadersMiddleware(),
		httpx.CORSMiddleware(cfg.CORSOrigins),
		httpx.BodyLimitMiddleware(2<<20), // 2 MiB; uploads have their own route
	)

	// --- shared collaborators -------------------------------------------------
	auditWriter := audit.NewWriter()
	auditReader := audit.NewReader(db)
	sessions := auth.NewSessionStore(rdb, cfg.SessionTTL)

	// --- modules --------------------------------------------------------------
	authService := authmod.NewService(db, sessions, auditWriter)
	authHandler := authmod.NewHandler(authService, sessions, cfg.SessionTTL, cfg.IsProduction())
	authenticated := authHandler.Authenticate()

	tenancyHandler := tenancy.NewHandler(tenancy.NewService(db, auditWriter))
	sisHandler := sis.NewHandler(
		sis.NewStudentService(db, auditWriter),
		sis.NewGuardianService(db, auditWriter),
		sis.NewAcademicsService(db, auditWriter),
	)
	auditHandler := audit.NewHandler(auditReader)
	healthHandler := health.NewHandler(db, rdb, Version)

	// --- routes ---------------------------------------------------------------
	healthHandler.Register(engine)
	engine.GET("/metrics", gin.WrapH(promhttp.Handler()))

	v1 := engine.Group("/api/v1")
	authHandler.Register(v1, authenticated)

	secured := v1.Group("", authenticated)
	tenancyHandler.Register(secured)
	sisHandler.Register(secured)
	auditHandler.Register(secured)

	return &Server{Engine: engine}
}

// ReadTimeout and friends live here so cmd/api stays a thin main.
const (
	ReadHeaderTimeout = 10 * time.Second
	ReadTimeout       = 30 * time.Second
	WriteTimeout      = 60 * time.Second
	IdleTimeout       = 120 * time.Second
)
