package httpx

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// RequestIDMiddleware assigns every request an id, echoes it back, and puts it
// on every log line and error body for the rest of the request's life.
func RequestIDMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader("X-Request-ID")
		if id == "" || len(id) > 64 {
			id = uuid.NewString()
		}
		c.Set(ctxRequestID, id)
		c.Header("X-Request-ID", id)
		c.Next()
	}
}

// RecoveryMiddleware turns a panic into a 500 with a request id instead of a
// dropped connection, and logs the stack on our side only.
func RecoveryMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic recovered",
					"request_id", RequestID(c),
					"path", c.Request.URL.Path,
					"panic", r,
					"stack", string(debug.Stack()))
				if !c.Writer.Written() {
					var body errorBody
					body.Error.Code = "INTERNAL_ERROR"
					body.Error.Message = "Something went wrong on our side. Quote the request id if you contact support."
					body.Error.RequestID = RequestID(c)
					c.AbortWithStatusJSON(http.StatusInternalServerError, body)
				}
			}
		}()
		c.Next()
	}
}

// LoggingMiddleware emits one structured line per request. Query strings are not
// logged: they carry names and admission numbers.
func LoggingMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()

		attrs := []any{
			"request_id", RequestID(c),
			"method", c.Request.Method,
			"path", c.FullPath(),
			"status", c.Writer.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
		}
		if a := CurrentActor(c); a != nil {
			attrs = append(attrs, "user_id", a.UserID, "org_id", a.OrganizationID)
		}

		switch {
		case c.Writer.Status() >= 500:
			slog.Error("request", attrs...)
		case c.Writer.Status() >= 400:
			slog.Warn("request", attrs...)
		default:
			slog.Info("request", attrs...)
		}
	}
}

// SecurityHeadersMiddleware sets the headers that cost nothing and close whole
// classes of attack. The CSP here guards the API's own responses; the frontend
// ships its own, stricter, nonce-based policy.
func SecurityHeadersMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		h.Set("Cross-Origin-Resource-Policy", "same-site")
		// Responses carry student data; no shared cache should keep them.
		h.Set("Cache-Control", "no-store")
		c.Next()
	}
}

// CORSMiddleware allows exactly the configured origins with credentials. A
// wildcard is never correct here: the session lives in a cookie.
func CORSMiddleware(origins []string) gin.HandlerFunc {
	allowed := make(map[string]struct{}, len(origins))
	for _, o := range origins {
		allowed[strings.TrimSuffix(o, "/")] = struct{}{}
	}
	return func(c *gin.Context) {
		origin := strings.TrimSuffix(c.GetHeader("Origin"), "/")
		if origin != "" {
			if _, ok := allowed[origin]; ok {
				h := c.Writer.Header()
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Access-Control-Allow-Credentials", "true")
				h.Set("Access-Control-Allow-Headers", "Content-Type, X-Request-ID, X-School-ID, Idempotency-Key")
				h.Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
				h.Set("Access-Control-Max-Age", "600")
				h.Add("Vary", "Origin")
			}
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// BodyLimitMiddleware caps request bodies. File uploads take a different route
// with its own, larger, per-purpose limit.
func BodyLimitMiddleware(maxBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
		c.Next()
	}
}

// RequirePermission is the grant gate. Every mutating route declares one; a
// route with no permission is caught by the route-coverage test, not by review.
//
// It deliberately does not check scope: whether this actor may touch *this*
// object is a per-object question the service answers, because only the service
// knows what the object is.
func RequirePermission(permission string) gin.HandlerFunc {
	return func(c *gin.Context) {
		actor := CurrentActor(c)
		if actor == nil {
			Fail(c, ErrUnauthenticated)
			return
		}
		if !actor.Can(permission) {
			Fail(c, PermissionDenied(permission))
			return
		}
		c.Next()
	}
}
