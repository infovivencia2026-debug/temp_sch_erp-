package httpx

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/google/uuid"
)

// RequestID assigns an id used by the logger, the error envelope, and the
// queue payloads, so one identifier follows a request from nginx through to a
// background job.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(WithRequestID(r.Context(), id)))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusRecorder) WriteHeader(c int) { s.status = c; s.ResponseWriter.WriteHeader(c) }
func (s *statusRecorder) Write(b []byte) (int, error) {
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// Logger emits one structured line per request, matching the shape production
// already writes so existing log tooling keeps working.
func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		/* The slot goes in before anything else runs, so that authentication
		   -- which happens further in -- can hand its identity back out here.
		   Without it this middleware had to be registered AFTER the session
		   middleware to have a user_id to log, and that put session resolution
		   outside the timer: every duration_ms in the log understated the real
		   latency by however long authentication took, which for a long time
		   was about a second. A number that hides the slowest thing on the
		   path is worse than no number. */
		ctx, slot := withIdentitySlot(r.Context())
		r = r.WithContext(ctx)
		next.ServeHTTP(rec, r)

		attrs := []any{
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", RequestIDFrom(r.Context()),
		}
		id := IdentityFrom(r.Context())
		if id == nil {
			id = slot.id
		}
		if id != nil {
			attrs = append(attrs, "institution_id", id.InstitutionID, "user_id", id.UserID)
		}
		slog.Info("request", attrs...)
	})
}

func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				slog.Error("panic",
					"value", v,
					"path", r.URL.Path,
					"request_id", RequestIDFrom(r.Context()),
					"stack", string(debug.Stack()))
				Error(w, r, http.StatusInternalServerError, "internal", "something went wrong")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

// RequireAuth rejects anonymous callers. Mounted on /api/v1 below the handful
// of endpoints (session, login) that must stay reachable while signed out.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if IdentityFrom(r.Context()) == nil {
			Unauthorized(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequirePermission gates a route on an RBAC permission key such as
// "students.read". Keys live in the permissions table; see internal/rbac.
// RequireAnyPermission admits a caller holding at least one of several
// permissions. A dashboard that aggregates the library, the transport fleet
// and the stores has no single permission of its own, and demanding all three
// would lock out the librarian it is partly for.
func RequireAnyPermission(perms ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := IdentityFrom(r.Context())
			if id == nil {
				Unauthorized(w, r)
				return
			}
			for _, p := range perms {
				if id.Can(p) {
					next.ServeHTTP(w, r)
					return
				}
			}
			Forbidden(w, r, strings.Join(perms, " or "))
		})
	}
}

func RequirePermission(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := IdentityFrom(r.Context())
			if id == nil {
				Unauthorized(w, r)
				return
			}
			if !id.Can(perm) {
				Forbidden(w, r, perm)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RealIP trusts X-Forwarded-For because the only ingress is nginx on the same
// host. Exposing this service directly would make the header attacker-controlled.
func RealIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.IndexByte(xff, ','); i > 0 {
				r.RemoteAddr = strings.TrimSpace(xff[:i])
			} else {
				r.RemoteAddr = strings.TrimSpace(xff)
			}
		}
		next.ServeHTTP(w, r)
	})
}
