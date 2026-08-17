// Package health exposes the endpoints a load balancer and an operator need:
// liveness (is the process up), readiness (can it actually serve), and metrics.
package health

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/school-erp/erp/pkg/database"
)

type Handler struct {
	db      *database.DB
	rdb     *redis.Client
	version string
	started time.Time
}

func NewHandler(db *database.DB, rdb *redis.Client, version string) *Handler {
	return &Handler{db: db, rdb: rdb, version: version, started: time.Now()}
}

func (h *Handler) Register(r gin.IRoutes) {
	r.GET("/healthz", h.live)
	r.GET("/readyz", h.ready)
}

// live answers "is this process running". It must not touch dependencies:
// a liveness probe that fails when the database blips restarts a healthy pod
// and turns a database incident into an outage.
func (h *Handler) live(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"version": h.version,
		"uptime":  time.Since(h.started).Round(time.Second).String(),
	})
}

// ready answers "should traffic come here", and so does check dependencies.
func (h *Handler) ready(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
	defer cancel()

	checks := gin.H{}
	healthy := true

	if err := h.db.Ping(ctx); err != nil {
		checks["database"] = "unavailable"
		healthy = false
	} else {
		checks["database"] = "ok"
	}

	if h.rdb == nil {
		checks["redis"] = "not configured"
		healthy = false
	} else if err := h.rdb.Ping(ctx).Err(); err != nil {
		checks["redis"] = "unavailable"
		healthy = false
	} else {
		checks["redis"] = "ok"
	}

	status := http.StatusOK
	state := "ready"
	if !healthy {
		status = http.StatusServiceUnavailable
		state = "not ready"
	}
	c.JSON(status, gin.H{"status": state, "checks": checks, "version": h.version})
}
