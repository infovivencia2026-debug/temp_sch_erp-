package api

import (
	"encoding/base64"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
)

/* Two-factor, and the devices you are signed in on: the person's own
   security screen, under Profile.

   Setup is two steps so a mistyped secret cannot lock somebody out: the
   server mints a secret and shows it as a QR (drawn here with the same
   encoder the fee code uses) and as text; the person's authenticator app
   produces a code; only when that code verifies is the secret saved. Until
   then the pending secret lives in a short-lived signed cookie, not in the
   database, so abandoning setup leaves nothing behind.

   Switching it off asks for the password, not a code: the case that
   brings somebody here is the lost phone. An administrator can switch it
   off for a colleague from Logins & access, which is the answer for the
   person who has lost both. */

const mfaSetupCookie = "erp_mfa_setup"

func (s *Server) mfaSetup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if id.DayCode {
		httpx.Denied(w, r, "two-factor is set up from your own sign-in, not the classroom day code")
		return
	}
	secret, err := auth.NewTOTPSecret()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	var account, issuer string
	_ = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT COALESCE(u.email::text, u.phone, u.username, u.full_name), COALESCE(i.short_name, i.name, 'WISEN')
			  FROM users u LEFT JOIN institutions i ON i.id = u.institution_id WHERE u.id = $1`, id.UserID).
			Scan(&account, &issuer)
	})
	uri := auth.TOTPURI(secret, account, issuer)
	png, err := fees.UPIQRPNG(uri, 360)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: mfaSetupCookie, Value: s.Hasher.Sign("mfa-setup", id.UserID.String()) + "." + secret,
		Path: "/api/v1/profile/mfa", MaxAge: 600, HttpOnly: true, Secure: s.Sessions != nil && strings.HasPrefix(s.BaseURL, "https"),
		SameSite: http.SameSiteLaxMode,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"secret": secret,
		"uri":    uri,
		"image":  "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
	})
}

func (s *Server) mfaEnable(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req struct {
		Code string `json:"code"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	c, err := r.Cookie(mfaSetupCookie)
	if err != nil || c.Value == "" {
		httpx.BadRequest(w, r, "start the setup again: the code on screen has expired")
		return
	}
	i := strings.IndexByte(c.Value, '.')
	if i < 0 || c.Value[:i] != s.Hasher.Sign("mfa-setup", id.UserID.String()) {
		httpx.BadRequest(w, r, "start the setup again: the code on screen has expired")
		return
	}
	secret := c.Value[i+1:]
	if !auth.VerifyTOTP(secret, req.Code, time.Now()) {
		httpx.Error(w, r, http.StatusUnauthorized, "wrong_code", "That code is not right. Type the current six digits from the app.")
		return
	}
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `UPDATE users SET mfa_secret = $2 WHERE id = $1`, id.UserID, secret)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: mfaSetupCookie, Value: "", Path: "/api/v1/profile/mfa", MaxAge: -1, HttpOnly: true})
	httpx.JSON(w, http.StatusOK, map[string]any{"mfa_enabled": true})
}

func (s *Server) mfaDisable(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req struct {
		Password string `json:"password"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	var hash *string
	if err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `SELECT password_hash FROM users WHERE id = $1`, id.UserID).Scan(&hash)
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if hash == nil || s.Hasher.Verify(*hash, req.Password) != nil {
		httpx.Error(w, r, http.StatusUnauthorized, "wrong_password", "That password is not right.")
		return
	}
	if err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `UPDATE users SET mfa_secret = NULL WHERE id = $1`, id.UserID)
		return err
	}); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"mfa_enabled": false})
}

// adminMFADisable answers POST /admin/users/{id}/mfa/disable: the office
// switching a colleague's second factor off, for the lost phone. Audited
// like every other write here.
func (s *Server) adminMFADisable(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	target := chiURLParam(r, "id")
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `UPDATE users SET mfa_secret = NULL WHERE id = $1::uuid`, target)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"mfa_enabled": false})
}

// --- the person's own devices ----------------------------------------------

type ownSession struct {
	ID         string `json:"id"`
	Device     string `json:"device"`
	IP         string `json:"ip,omitempty"`
	CreatedAt  string `json:"created_at"`
	LastSeenAt string `json:"last_seen_at"`
	Current    bool   `json:"current"`
}

func (s *Server) listOwnSessions(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items, err := collect(s, r, `
		SELECT se.id::text, COALESCE(se.user_agent,''), COALESCE(host(se.ip),''),
		       to_char(se.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       to_char(se.last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
		       se.id = $2
		  FROM sessions se
		 WHERE se.user_id = $1 AND se.revoked_at IS NULL AND se.expires_at > now()
		 ORDER BY se.last_seen_at DESC`, []any{id.UserID, id.SessionID},
		func(rows pgx.Rows) (ownSession, error) {
			var v ownSession
			var ua string
			err := rows.Scan(&v.ID, &ua, &v.IP, &v.CreatedAt, &v.LastSeenAt, &v.Current)
			v.Device = deviceLabel(ua)
			return v, err
		})
	respond(w, r, items, err)
}

// signOutOtherDevices answers POST /profile/sessions/sign-out-others.
func (s *Server) signOutOtherDevices(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var n int64
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE sessions SET revoked_at = now(), ended_reason = 'signed_out'
			 WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, id.UserID, id.SessionID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.Sessions.ForgetUser(id.UserID)
	httpx.JSON(w, http.StatusOK, map[string]any{"signed_out": n})
}
