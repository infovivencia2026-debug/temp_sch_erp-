package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Super Admin — Access & Security, Platform Configuration.
   These endpoints are institution-scoped through RLS like everything else; a
   platform operator (institution_id IS NULL) sees across tenants because
   tenantScope sets app.is_platform_admin, not because these queries skip the
   filter. */

type adminUser struct {
	ID          string   `json:"id"`
	FullName    string   `json:"full_name"`
	Email       *string  `json:"email,omitempty"`
	Phone       *string  `json:"phone,omitempty"`
	Status      string   `json:"status"`
	MFAEnabled  bool     `json:"mfa_enabled"`
	LastLoginAt *string  `json:"last_login_at,omitempty"`
	Roles       []string `json:"roles"`
	Institution *string  `json:"institution,omitempty"`
	Sessions    int      `json:"active_sessions"`
}

// listUsers powers super_admin.access_security.users.
func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	search := strings.TrimSpace(q.Get("q"))
	status := q.Get("status")

	items, err := collect(s, r, `
		SELECT u.id::text, u.full_name, u.email::text, u.phone, u.status,
		       u.mfa_secret IS NOT NULL,
		       to_char(u.last_login_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       COALESCE(array_agg(DISTINCT ro.name)
		                FILTER (WHERE ro.name IS NOT NULL), '{}'),
		       i.name,
		       (SELECT count(*) FROM sessions se
		         WHERE se.user_id = u.id AND se.revoked_at IS NULL AND se.expires_at > now())
		  FROM users u
		  LEFT JOIN user_roles ur ON ur.user_id = u.id
		  LEFT JOIN roles ro      ON ro.id = ur.role_id
		  LEFT JOIN institutions i ON i.id = u.institution_id
		 WHERE ($1::text IS NULL OR u.status = $1)
		   AND ($2::text IS NULL OR
		        u.full_name ILIKE '%' || $2 || '%' OR
		        u.email::text ILIKE '%' || $2 || '%' OR
		        u.phone ILIKE '%' || $2 || '%')
		 GROUP BY u.id, i.name
		 ORDER BY u.full_name
		 LIMIT 200`,
		[]any{nullString(status), nullString(search)},
		func(rows pgx.Rows) (adminUser, error) {
			var v adminUser
			return v, rows.Scan(&v.ID, &v.FullName, &v.Email, &v.Phone, &v.Status,
				&v.MFAEnabled, &v.LastLoginAt, &v.Roles, &v.Institution, &v.Sessions)
		})
	respond(w, r, items, err)
}

type setUserStatusRequest struct {
	Status string `json:"status"`
}

// setUserStatus activates, suspends or archives a user.
//
// Suspending revokes their live sessions in the same transaction: leaving a
// suspended user signed in until their cookie expires would make the control
// advisory rather than real.
func (s *Server) setUserStatus(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	target, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid user id")
		return
	}
	var req setUserStatusRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	switch req.Status {
	case "active", "suspended", "archived", "invited":
	default:
		httpx.BadRequest(w, r, "status must be active, invited, suspended or archived")
		return
	}
	if target == id.UserID && req.Status != "active" {
		// Locking yourself out is never the intent, and recovering needs shell
		// access to the box.
		httpx.BadRequest(w, r, "you cannot suspend your own account")
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(),
			`UPDATE users SET status = $2, updated_at = now() WHERE id = $1`, target, req.Status)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		if req.Status != "active" {
			_, err = tx.Exec(r.Context(), `
				UPDATE sessions SET revoked_at = now()
				 WHERE user_id = $1 AND revoked_at IS NULL`, target)
		}
		return err
	})
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": target.String(), "status": req.Status})
}

type adminRole struct {
	ID       string `json:"id"`
	Key      string `json:"key"`
	Name     string `json:"name"`
	IsSystem bool   `json:"is_system"`
	// IsDefault distinguishes the roles a new school opens with from the
	// optional ones it installs when it needs them.
	IsDefault   bool    `json:"is_default"`
	Institution *string `json:"institution,omitempty"`
	Permissions int     `json:"permissions"`
	// Capabilities counts only the keys the configuration grid governs.
	// Permissions counts those plus the catalog navigation grants, which is why
	// a role can show 60 grants and 14 capabilities.
	Capabilities int `json:"capabilities"`
	Users        int `json:"users"`
}

// listRoles powers super_admin.access_security.roles_permissions.
func (s *Server) listRoles(w http.ResponseWriter, r *http.Request) {
	capKeys := make([]string, 0, len(rbac.All))
	for _, p := range rbac.All {
		capKeys = append(capKeys, p.Key)
	}
	items, err := collect(s, r, `
		SELECT ro.id::text, ro.key, ro.name, ro.is_system, ro.is_default, i.name,
		       (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = ro.id),
		       (SELECT count(*) FROM role_permissions rp
		         WHERE rp.role_id = ro.id AND rp.permission_key = ANY($1)),
		       (SELECT count(*) FROM user_roles ur      WHERE ur.role_id = ro.id)
		  FROM roles ro
		  LEFT JOIN institutions i ON i.id = ro.institution_id
		 ORDER BY ro.is_system DESC, ro.name`, []any{capKeys},
		func(rows pgx.Rows) (adminRole, error) {
			var v adminRole
			return v, rows.Scan(&v.ID, &v.Key, &v.Name, &v.IsSystem, &v.IsDefault,
				&v.Institution, &v.Permissions, &v.Capabilities, &v.Users)
		})
	respond(w, r, items, err)
}

type rolePermission struct {
	Key         string `json:"key"`
	Module      string `json:"module"`
	Description string `json:"description"`
}

// getRolePermissions lists the grants held by one role.
func (s *Server) getRolePermissions(w http.ResponseWriter, r *http.Request) {
	roleID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid role id")
		return
	}
	items, err := collect(s, r, `
		SELECT p.key, p.module, p.description
		  FROM role_permissions rp
		  JOIN permissions p ON p.key = rp.permission_key
		 WHERE rp.role_id = $1
		 ORDER BY p.module, p.key`, []any{roleID},
		func(rows pgx.Rows) (rolePermission, error) {
			var v rolePermission
			return v, rows.Scan(&v.Key, &v.Module, &v.Description)
		})
	respond(w, r, items, err)
}

type moduleSetting struct {
	Module  string `json:"module"`
	Enabled bool   `json:"enabled"`
}

// listModules powers super_admin.platform_configuration.module_configuration.
func (s *Server) listModules(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r,
		`SELECT module, enabled FROM module_settings ORDER BY module`, nil,
		func(rows pgx.Rows) (moduleSetting, error) {
			var v moduleSetting
			return v, rows.Scan(&v.Module, &v.Enabled)
		})
	respond(w, r, items, err)
}

// setModule enables or disables a module for the tenant.
func (s *Server) setModule(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req moduleSetting
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Module) == "" {
		httpx.BadRequest(w, r, "module is required")
		return
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO module_settings (institution_id, module, enabled)
			VALUES ($1,$2,$3)
			ON CONFLICT (institution_id, module) DO UPDATE SET enabled = EXCLUDED.enabled`,
			id.InstitutionID, req.Module, req.Enabled)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, req)
}

type sessionRow struct {
	ID         string  `json:"id"`
	UserID     string  `json:"user_id"`
	FullName   string  `json:"full_name"`
	IP         *string `json:"ip,omitempty"`
	UserAgent  *string `json:"user_agent,omitempty"`
	CreatedAt  string  `json:"created_at"`
	LastSeenAt string  `json:"last_seen_at"`
	ExpiresAt  string  `json:"expires_at"`
	Revoked    bool    `json:"revoked"`
}

// listSessions powers super_admin.platform_setup.login_session_audit_logs.
func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	onlyActive := r.URL.Query().Get("active") == "true"
	items, err := collect(s, r, `
		SELECT se.id::text, se.user_id::text, u.full_name, host(se.ip), se.user_agent,
		       to_char(se.created_at,   'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(se.last_seen_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(se.expires_at,   'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       se.revoked_at IS NOT NULL OR se.expires_at <= now()
		  FROM sessions se
		  JOIN users u ON u.id = se.user_id
		 WHERE NOT $1::bool OR (se.revoked_at IS NULL AND se.expires_at > now())
		 ORDER BY se.last_seen_at DESC
		 LIMIT 200`, []any{onlyActive},
		func(rows pgx.Rows) (sessionRow, error) {
			var v sessionRow
			return v, rows.Scan(&v.ID, &v.UserID, &v.FullName, &v.IP, &v.UserAgent,
				&v.CreatedAt, &v.LastSeenAt, &v.ExpiresAt, &v.Revoked)
		})
	respond(w, r, items, err)
}

// revokeSession terminates one session immediately.
func (s *Server) revokeSession(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sessionID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid session id")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(),
			`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, sessionID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": sessionID.String(), "revoked": true})
}

// chiURLParam is a thin alias so the handlers above do not each import chi.
func chiURLParam(r *http.Request, key string) string { return chi.URLParam(r, key) }
