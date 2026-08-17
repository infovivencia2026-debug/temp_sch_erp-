package api

import (
	"crypto/rand"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Account recovery and login protection.

   Self-service reset over email or SMS needs a delivery gateway this
   deployment does not have, and pretending otherwise would produce a button
   that silently does nothing. Instead an administrator resets the password and
   hands over a one-time value, which is how a school office already works when
   a teacher is locked out. */

type resetPasswordResponse struct {
	UserID            string `json:"user_id"`
	TemporaryPassword string `json:"temporary_password"`
	Note              string `json:"note"`
}

// resetUserPassword issues a temporary password and invalidates every session.
//
// Revoking sessions matters: if the account was locked out because it was
// compromised, leaving the intruder's cookie alive makes the reset cosmetic.
func (s *Server) resetUserPassword(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	target, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid user id")
		return
	}

	temp, err := temporaryPassword()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	hash, err := s.Hasher.Hash(temp)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE users SET password_hash = $2, status = 'active', updated_at = now()
			 WHERE id = $1`, target, hash)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		_, err = tx.Exec(r.Context(), `
			UPDATE sessions SET revoked_at = now()
			 WHERE user_id = $1 AND revoked_at IS NULL`, target)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, resetPasswordResponse{
		UserID:            target.String(),
		TemporaryPassword: temp,
		Note: "Shown once. Give it to the user in person and ask them to change it " +
			"from their profile. All their existing sessions have been signed out.",
	})
}

// temporaryPassword produces something a person can read aloud once and type
// correctly — no characters that are ambiguous in handwriting or over a phone.
func temporaryPassword() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no I, O, 0, 1
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, len(b))
	for i, v := range b {
		out[i] = alphabet[int(v)%len(alphabet)]
	}
	return string(out[:4]) + "-" + string(out[4:8]) + "-" + string(out[8:]), nil
}
