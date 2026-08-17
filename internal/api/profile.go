package api

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

type profile struct {
	ID          string  `json:"id"`
	FullName    string  `json:"full_name"`
	Email       *string `json:"email,omitempty"`
	Phone       *string `json:"phone,omitempty"`
	AvatarKey   *string `json:"avatar_key,omitempty"`
	Status      string  `json:"status"`
	LastLoginAt *string `json:"last_login_at,omitempty"`
	MFAEnabled  bool    `json:"mfa_enabled"`
}

func (s *Server) getProfile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var p profile
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT id::text, full_name, email::text, phone, avatar_key, status,
			       to_char(last_login_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       mfa_secret IS NOT NULL
			  FROM users WHERE id = $1`, id.UserID).
			Scan(&p.ID, &p.FullName, &p.Email, &p.Phone, &p.AvatarKey,
				&p.Status, &p.LastLoginAt, &p.MFAEnabled)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

type updateProfileRequest struct {
	FullName string  `json:"full_name"`
	Phone    *string `json:"phone"`
}

func (s *Server) updateProfile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req updateProfileRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.FullName = strings.TrimSpace(req.FullName)
	if req.FullName == "" || utf8.RuneCountInString(req.FullName) > 120 {
		httpx.BadRequest(w, r, "full_name must be 1-120 characters")
		return
	}
	// Email is deliberately not editable here: it is a login identifier, so
	// changing it needs a verification round trip, not a PUT.
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(),
			`UPDATE users SET full_name = $2, phone = $3, updated_at = now() WHERE id = $1`,
			id.UserID, req.FullName, req.Phone)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.getProfile(w, r)
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// changePassword rotates the caller's password and drops every other session.
//
// Revoking the rest is the point of changing a password after a suspected
// compromise; leaving them live would make the change cosmetic.
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req changePasswordRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if n := utf8.RuneCountInString(req.NewPassword); n < 12 || n > 200 {
		httpx.BadRequest(w, r, "new_password must be 12-200 characters")
		return
	}
	if req.NewPassword == req.CurrentPassword {
		httpx.BadRequest(w, r, "new_password must differ from the current one")
		return
	}

	var current *string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT password_hash FROM users WHERE id = $1`, id.UserID).Scan(&current)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if current == nil || s.Hasher.Verify(*current, req.CurrentPassword) != nil {
		httpx.Error(w, r, http.StatusForbidden, "invalid_credentials", "current password is incorrect")
		return
	}

	hash, err := s.Hasher.Hash(req.NewPassword)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(),
			`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`,
			id.UserID, hash); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE sessions SET revoked_at = now()
			 WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
			id.UserID, id.SessionID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"changed": true, "other_sessions_revoked": true})
}
