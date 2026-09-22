package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What a session did.

   Two sources, joined for the principal. The screens a session opened come
   from session_screens, which the SPA feeds with one beacon per navigation.
   The changes it made come from audit_log, which now carries session_id.
   Together with the session row itself they read as a timeline: signed in
   from this device, opened these screens, changed these things, last seen
   then, signed out or ended thus.

   The beacon is deliberately coarse -- a feature key, not a URL with ids in
   it -- and deliberately cheap: one upsert, no body to speak of, and any
   failure is ignored by the page. It is a record of where a login went, not
   a click log. */

// recordScreen answers POST /session/activity {screen}. Best-effort; the
// page does not wait on it.
func (s *Server) recordScreen(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req struct {
		Screen string `json:"screen"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Screen = strings.TrimSpace(req.Screen)
	if req.Screen == "" || len(req.Screen) > 120 || id.SessionID == uuid.Nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO session_screens (session_id, institution_id, user_id, screen)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (session_id, screen)
			DO UPDATE SET last_at = now(), hits = session_screens.hits + 1`,
			id.SessionID, nullUUIDArg(id.InstitutionID), id.UserID, req.Screen)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type sessionScreen struct {
	Screen  string `json:"screen"`
	FirstAt string `json:"first_at"`
	LastAt  string `json:"last_at"`
	Hits    int    `json:"hits"`
}

type sessionActivity struct {
	Session sessionRow      `json:"session"`
	Screens []sessionScreen `json:"screens"`
	Changes []auditRow      `json:"changes"`
}

// getSessionActivity answers GET /admin/sessions/{id}/activity. Read under
// audit.read like the session list; RLS keeps another school's session id
// from answering, which surfaces as 404.
func (s *Server) getSessionActivity(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sessionID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid session id")
		return
	}
	out := sessionActivity{Screens: []sessionScreen{}, Changes: []auditRow{}}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		v := &out.Session
		if err := tx.QueryRow(r.Context(), `
			SELECT se.id::text, se.user_id::text, u.full_name, host(se.ip), se.user_agent,
			       to_char(se.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(se.last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(se.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       se.revoked_at IS NOT NULL OR se.expires_at <= now()
			  FROM sessions se JOIN users u ON u.id = se.user_id
			 WHERE se.id = $1`, sessionID).
			Scan(&v.ID, &v.UserID, &v.FullName, &v.IP, &v.UserAgent,
				&v.CreatedAt, &v.LastSeenAt, &v.ExpiresAt, &v.Revoked); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT screen,
			       to_char(first_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(last_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       hits
			  FROM session_screens WHERE session_id = $1 ORDER BY first_at`, sessionID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var sc sessionScreen
			if err := rows.Scan(&sc.Screen, &sc.FirstAt, &sc.LastAt, &sc.Hits); err != nil {
				rows.Close()
				return err
			}
			out.Screens = append(out.Screens, sc)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		rows, err = tx.Query(r.Context(), `
			SELECT a.id, to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       u.full_name, a.action, a.entity_type, host(a.ip), a.before, a.after
			  FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
			 WHERE a.session_id = $1 ORDER BY a.id LIMIT 500`, sessionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var a auditRow
			if err := rows.Scan(&a.ID, &a.At, &a.Actor, &a.Action, &a.Entity,
				&a.IP, &a.Request, &a.Response); err != nil {
				return err
			}
			out.Changes = append(out.Changes, a)
		}
		return rows.Err()
	})
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
