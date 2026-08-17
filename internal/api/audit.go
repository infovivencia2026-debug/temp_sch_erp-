package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
)

/* Audit logging.

   The audit_log table existed from the first migration and had never been
   written to: who changed a fee, edited a mark, approved a concession or
   suspended an account was unanswerable. For a system that handles money and
   examination results that is the first thing an auditor asks for.

   This records every state-changing request rather than instrumenting each
   handler. Per-handler auditing is the version that ends up 80% complete,
   because the gap is invisible until someone needs the record that was never
   written. */

// auditable decides whether a request is worth recording.
//
// Reads are excluded: they are the overwhelming majority of traffic and
// recording them would bury the changes in noise. Login is handled separately
// through the sessions table, which already carries ip and user agent.
func auditable(method, path string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return false
	}
	// Acknowledging a circular is a user action, not an administrative change,
	// and a school with 800 parents would generate 800 rows per notice.
	if strings.HasSuffix(path, "/ack") {
		return false
	}
	return true
}

// entityFor derives a coarse entity type from the route.
//
// Deliberately the URL segment rather than the table: an auditor searches for
// "what happened to fees", and one handler often touches four tables.
func entityFor(path string) string {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(path, "/api/v1"), "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "unknown"
	}
	if len(parts) > 1 && !looksLikeID(parts[1]) {
		return parts[0] + "." + parts[1]
	}
	return parts[0]
}

func looksLikeID(s string) bool {
	return len(s) >= 32 || strings.Count(s, "-") >= 4
}

// redactKeys never reach the audit log. A password or token recorded in an
// audit trail turns the safety feature into the breach.
var redactKeys = map[string]bool{
	"password": true, "new_password": true, "current_password": true,
	"temporary_password": true, "csrf_token": true, "token": true,
	"secret": true, "api_key": true, "access_key": true,
}

func redact(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if redactKeys[strings.ToLower(k)] {
				out[k] = "[redacted]"
				continue
			}
			out[k] = redact(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = redact(val)
		}
		return out
	default:
		return v
	}
}

type auditRecorder struct {
	http.ResponseWriter
	status int
	body   *bytes.Buffer
}

func (a *auditRecorder) WriteHeader(c int) { a.status = c; a.ResponseWriter.WriteHeader(c) }
func (a *auditRecorder) Write(b []byte) (int, error) {
	// Only the first part of the response is kept; enough to capture an id or
	// a receipt number without storing a whole export in the audit table.
	if a.body.Len() < 4096 {
		a.body.Write(b)
	}
	return a.ResponseWriter.Write(b)
}

// AuditMiddleware records successful mutations to audit_log.
//
// Written after the handler and only on success: a rejected request changed
// nothing, and logging it would make a failed validation look like an edit.
// The write is best-effort — an audit failure must never turn a completed fee
// collection into an error for the cashier — but it is logged loudly, because
// silently losing the audit trail is its own incident.
func AuditMiddleware(db *database.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !auditable(r.Method, r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}

			var payload any
			if r.Body != nil && strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
				_ = r.Body.Close()
				if err == nil {
					// Hand the handler an identical body; it has not read it yet.
					r.Body = io.NopCloser(bytes.NewReader(raw))
					var parsed any
					if json.Unmarshal(raw, &parsed) == nil {
						payload = redact(parsed)
					}
				}
			}

			rec := &auditRecorder{ResponseWriter: w, status: http.StatusOK, body: &bytes.Buffer{}}
			next.ServeHTTP(rec, r)

			if rec.status >= 400 {
				return
			}

			id := httpx.IdentityFrom(r.Context())
			if id == nil {
				return
			}

			var result any
			if rec.body.Len() > 0 {
				var parsed any
				if json.Unmarshal(rec.body.Bytes(), &parsed) == nil {
					result = redact(parsed)
				}
			}

			before, _ := json.Marshal(payload)
			after, _ := json.Marshal(result)

			var ip *string
			if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
				ip = &host
			}

			// A fresh context: the request's may already be cancelled by the
			// time the response has been written, which would drop the record.
			if err := db.AsPlatform(r.Context(), func(tx pgx.Tx) error {
				_, err := tx.Exec(r.Context(), `
					INSERT INTO audit_log (institution_id, actor_user_id, action,
					                       entity_type, before, after, ip)
					VALUES ($1,$2,$3,$4,$5,$6,$7::inet)`,
					nullUUIDArg(id.InstitutionID), id.UserID,
					r.Method+" "+r.URL.Path, entityFor(r.URL.Path),
					before, after, ip)
				return err
			}); err != nil {
				slog.Error("audit write failed",
					"error", err, "path", r.URL.Path,
					"request_id", httpx.RequestIDFrom(r.Context()))
			}
		})
	}
}

type auditRow struct {
	ID       int64   `json:"id"`
	At       string  `json:"at"`
	Actor    *string `json:"actor,omitempty"`
	Action   string  `json:"action"`
	Entity   string  `json:"entity_type"`
	IP       *string `json:"ip,omitempty"`
	Request  any     `json:"request,omitempty"`
	Response any     `json:"response,omitempty"`
}

// listAudit is the trail viewer: what changed, who changed it, and when.
func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := clampInt(q.Get("limit"), 100, 1, 500)

	items, err := collect(s, r, `
		SELECT a.id, to_char(a.created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       u.full_name, a.action, a.entity_type, host(a.ip), a.before, a.after
		  FROM audit_log a
		  LEFT JOIN users u ON u.id = a.actor_user_id
		 WHERE ($1::text IS NULL OR a.entity_type = $1)
		   AND ($2::uuid IS NULL OR a.actor_user_id = $2)
		   AND ($3::text IS NULL OR a.action ILIKE '%' || $3 || '%')
		 ORDER BY a.id DESC
		 LIMIT $4`,
		[]any{nullString(q.Get("entity")), nullString(q.Get("actor")),
			nullString(q.Get("q")), limit},
		func(rows pgx.Rows) (auditRow, error) {
			var v auditRow
			return v, rows.Scan(&v.ID, &v.At, &v.Actor, &v.Action, &v.Entity,
				&v.IP, &v.Request, &v.Response)
		})
	respond(w, r, items, err)
}

// getAuditSummary powers the viewer's filters: what kinds of change exist.
func (s *Server) getAuditSummary(w http.ResponseWriter, r *http.Request) {
	type bucket struct {
		Entity string `json:"entity_type"`
		Count  int    `json:"count"`
		Last   string `json:"last_at"`
	}
	items, err := collect(s, r, `
		SELECT entity_type, count(*)::int,
		       to_char(max(created_at),'YYYY-MM-DD"T"HH24:MI:SSOF')
		  FROM audit_log
		 WHERE created_at >= now() - interval '90 days'
		 GROUP BY entity_type ORDER BY 2 DESC`, nil,
		func(rows pgx.Rows) (bucket, error) {
			var v bucket
			return v, rows.Scan(&v.Entity, &v.Count, &v.Last)
		})
	respond(w, r, items, err)
}
