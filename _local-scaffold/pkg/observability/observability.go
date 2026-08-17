// Package observability sets up logging and metrics. Traces (OpenTelemetry) are
// wired in Phase 12 alongside the collector; the seams are here.
package observability

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// SetupLogger installs a structured JSON logger as the default. JSON in every
// environment, because a log line that is grep-friendly locally and
// machine-parseable in production is the same line.
func SetupLogger(level string, pretty bool) {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{Level: lvl, ReplaceAttr: redactSensitive}

	var handler slog.Handler
	if pretty {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}
	slog.SetDefault(slog.New(handler))
}

// redactSensitive is the last line of defence against a password or a token
// reaching the logs because someone logged a whole struct.
func redactSensitive(_ []string, a slog.Attr) slog.Attr {
	switch strings.ToLower(a.Key) {
	case "password", "password_hash", "token", "session", "secret",
		"authorization", "cookie", "aadhaar", "bank_account":
		return slog.String(a.Key, "[redacted]")
	}
	return a
}

var (
	requestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "erp_http_request_duration_seconds",
		Help:    "Request latency by route and status.",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
	}, []string{"method", "route", "status"})

	requestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "erp_http_requests_total",
		Help: "Requests by route and status.",
	}, []string{"method", "route", "status"})

	// Authorization failures are a security signal worth alerting on, so they
	// get their own counter rather than being buried in the 4xx rate.
	AuthFailures = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "erp_auth_failures_total",
		Help: "Authentication and authorization failures by kind.",
	}, []string{"kind"})
)

// MetricsMiddleware records RED metrics per route. It labels by the matched
// route template, never the raw path — labelling by path would put a student id
// into a metric label and blow up cardinality.
func MetricsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()

		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		status := strconv.Itoa(c.Writer.Status())

		requestDuration.WithLabelValues(c.Request.Method, route, status).
			Observe(time.Since(start).Seconds())
		requestsTotal.WithLabelValues(c.Request.Method, route, status).Inc()

		switch c.Writer.Status() {
		case 401:
			AuthFailures.WithLabelValues("unauthenticated").Inc()
		case 403:
			AuthFailures.WithLabelValues("forbidden").Inc()
		}
	}
}
