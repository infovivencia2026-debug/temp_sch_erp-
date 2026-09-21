package api

import (
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The vendor's support desk, as accounts the vendor can mint from the console.

   A platform support engineer needs a login that reaches across tenants to
   reproduce a fault — the support_admin role, one shelf below seller_admin and
   read-only by construction (see internal/rbac: no school PII, no tenant or
   plan writes). Until now those accounts were CLI-only, the same shell command
   that creates a seller, so a support hire could not be given access without an
   engineer at a terminal.

   This is that command as a screen, and nothing more. It is deliberately
   narrower than provisionTenant and than createUser:

     - It can ONLY create a support_admin. The role is hardcoded below and never
       taken from the request, so this door cannot mint a super_admin, a
       seller_admin, or any tenant role. A caller who wants to grant another
       platform role uses the CLI, on purpose.

     - It creates a PLATFORM user — institution_id NULL — the way createSeller
       does, not a tenant-scoped user the way createUser does. The insert and
       the grant both run AsPlatform so RLS lands the NULL-institution rows.

     - It is gated so only a platform operator reaches it: the /seller route
       group already requires platform.tenants.write, which no school role
       holds, and each handler re-checks id.PlatformAdmin so a tenant admin who
       somehow acquired the capability is still refused. A tenant admin gets 403.
*/

type supportAccountRequest struct {
	FullName string `json:"full_name"`
	Email    string `json:"email,omitempty"`
	Phone    string `json:"phone,omitempty"`
}

type supportAccountRow struct {
	ID          string  `json:"id"`
	FullName    string  `json:"full_name"`
	Email       *string `json:"email,omitempty"`
	Phone       *string `json:"phone,omitempty"`
	Status      string  `json:"status"`
	LastLoginAt *string `json:"last_login_at,omitempty"`
	CreatedAt   string  `json:"created_at"`
}

// requirePlatformOperator refuses anyone who is not a full platform operator or
// the vendor's own back-office (seller) account. The route group already gates
// on platform.tenants.write; this is the belt to that braces, and the line that
// makes "a tenant admin may not do this" a rule rather than an accident of RLS.
func requirePlatformOperator(w http.ResponseWriter, r *http.Request) bool {
	id := httpx.IdentityFrom(r.Context())
	if id == nil || !id.PlatformAdmin || !id.Can(rbac.PlatformTenantsRW) {
		httpx.Denied(w, r, "only a platform operator can manage support-team accounts")
		return false
	}
	return true
}

// listSupportAccounts returns the platform accounts holding support_admin, so
// the console can show who is on the support team.
func (s *Server) listSupportAccounts(w http.ResponseWriter, r *http.Request) {
	if !requirePlatformOperator(w, r) {
		return
	}
	items := []supportAccountRow{}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT u.id::text, u.full_name, u.email::text, u.phone, u.status,
			       to_char(u.last_login_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM users u
			 WHERE u.institution_id IS NULL
			   AND EXISTS (SELECT 1 FROM user_roles ur
			                 JOIN roles ro ON ro.id = ur.role_id
			                WHERE ur.user_id = u.id
			                  AND ro.key = 'support_admin'
			                  AND ro.institution_id IS NULL)
			 ORDER BY u.created_at DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v supportAccountRow
			if err := rows.Scan(&v.ID, &v.FullName, &v.Email, &v.Phone,
				&v.Status, &v.LastLoginAt, &v.CreatedAt); err != nil {
				return err
			}
			items = append(items, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// createSupportAccount makes a platform account holding only the support_admin
// role and returns a one-time password to hand over.
func (s *Server) createSupportAccount(w http.ResponseWriter, r *http.Request) {
	if !requirePlatformOperator(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	var req supportAccountRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.FullName = strings.TrimSpace(req.FullName)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Phone = strings.TrimSpace(req.Phone)
	if req.FullName == "" {
		httpx.BadRequest(w, r, "the support account needs a name")
		return
	}
	if req.Email == "" && req.Phone == "" {
		httpx.BadRequest(w, r, "an email or a phone number is required to sign in")
		return
	}

	// The same one-time value the seller-provisioning path issues: readable
	// aloud once, stored only as a hash, and forced to be changed on first
	// sign-in. Reused rather than reinvented so support accounts and the
	// accounts created beside them behave identically.
	password, err := temporaryPassword()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	hash, err := s.Hasher.Hash(password)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var userID string
	err = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		// The support_admin platform role is optional, so a platform that has
		// only ever had seller/super admins may not carry it yet. Seed it on
		// demand against the NULL institution before granting it.
		roleID, err := rbac.EnsurePlatformRole(r.Context(), tx, "support_admin")
		if err != nil {
			return err
		}

		// A platform user: institution_id NULL, like createSeller and never
		// like createUser's tenant-scoped insert.
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO users (institution_id, email, phone, full_name, password_hash,
			                   status, must_change_password)
			VALUES (NULL, $1::citext, $2, $3, $4, 'active', true)
			ON CONFLICT (email) WHERE institution_id IS NULL AND email IS NOT NULL
			DO UPDATE SET full_name = EXCLUDED.full_name,
			              phone = COALESCE(EXCLUDED.phone, users.phone),
			              password_hash = EXCLUDED.password_hash,
			              status = 'active',
			              must_change_password = true,
			              updated_at = now()
			RETURNING id::text`,
			nullString(req.Email), nullString(req.Phone), req.FullName, hash).Scan(&userID); err != nil {
			return err
		}

		// Only support_admin, hardcoded. The role key is never taken from the
		// request, which is what structurally stops this endpoint minting a
		// higher platform role.
		_, err = tx.Exec(r.Context(), `
			INSERT INTO user_roles (institution_id, user_id, role_id)
			VALUES (NULL, $1::uuid, $2)
			ON CONFLICT (user_id, role_id) WHERE campus_id IS NULL DO NOTHING`,
			userID, roleID)
		return err
	})

	subject := req.FullName
	if req.Email != "" {
		subject = req.FullName + " <" + req.Email + ">"
	}
	if err != nil {
		recordPlatformEvent(r.Context(), s.DB, "support_account", false, nil,
			subject, err.Error(), id.UserID)
		if strings.Contains(err.Error(), "users") && isUniqueViolation(err) {
			httpx.Error(w, r, http.StatusConflict, "email_in_use",
				"a platform account already uses that email")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	recordPlatformEvent(r.Context(), s.DB, "support_account", true, nil,
		subject, "support_admin created", id.UserID)

	login := req.Email
	if login == "" {
		login = req.Phone
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"user_id":            userID,
		"full_name":          req.FullName,
		"sign_in_as":         login,
		"role":               "support_admin",
		"temporary_password": password,
		"note": "Shown once and not stored. Hand it over; they are asked to set their " +
			"own password the first time they sign in.",
	})
}
