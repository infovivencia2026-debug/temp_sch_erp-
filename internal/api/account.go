package api

import (
	"crypto/rand"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

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

/*
An administrator may also type the new password rather than take the

	generated one.

	The generated value is right when the admin is next to the person: it is
	unguessable and unambiguous read aloud. It is wrong down a phone line to a
	parent who cannot write, for a class teacher setting up thirty children at
	once, or for a school that wants every new account to start on one known
	value it will make them change. Those schools were solving it by resetting
	twice and reading the code back, or by not using the button at all.
*/
type resetPasswordRequest struct {
	// Empty means generate one, which is what the button did before and
	// still does.
	NewPassword string `json:"new_password,omitempty"`
}

type resetPasswordResponse struct {
	UserID            string `json:"user_id"`
	TemporaryPassword string `json:"temporary_password"`
	Note              string `json:"note"`
	// SentBy and SentTo say where the password also went: "email" and a
	// masked address, or "" when the account carries no contact.
	SentBy string `json:"sent_by,omitempty"`
	SentTo string `json:"sent_to,omitempty"`
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

	/* An empty body is still a valid reset — this endpoint took none before
	   a chosen password was possible, and the callers that send none must
	   keep working. */
	var req resetPasswordRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	chosen := strings.TrimSpace(req.NewPassword)
	// The same 12-200 the account holder's own change is held to. A password
	// handed out by the office must not be weaker than one chosen in private.
	if chosen != "" {
		if n := utf8.RuneCountInString(chosen); n < 12 || n > 200 {
			httpx.BadRequest(w, r, "new_password must be 12-200 characters")
			return
		}
	}

	temp := chosen
	if temp == "" {
		temp, err = temporaryPassword()
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
	}
	hash, err := s.Hasher.Hash(temp)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	enabled := s.platformChannels(r.Context())
	var sentBy, sentTo string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* A generated password is a value the office reads aloud, so the
		   account is held on it until the person replaces it. One the
		   administrator typed is not: they chose it, often with the person in
		   front of them, and forcing an immediate second change would make
		   that feature useless. */
		tag, err := tx.Exec(r.Context(), `
			UPDATE users
			   SET password_hash = $2, status = 'active',
			       must_change_password = $3, updated_at = now()
			 WHERE id = $1`, target, hash, chosen == "")
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		if _, err = tx.Exec(r.Context(), `
			UPDATE sessions SET revoked_at = now()
			 WHERE user_id = $1 AND revoked_at IS NULL`, target); err != nil {
			return err
		}
		/* A generated value goes to the person as well as the screen. One the
		   administrator typed does not: they chose it, usually with the
		   person beside them, and it is theirs to hand over. */
		if chosen != "" {
			return nil
		}
		var email, phone *string
		if err := tx.QueryRow(r.Context(),
			`SELECT email::text, phone FROM users WHERE id = $1`, target).Scan(&email, &phone); err != nil {
			return err
		}
		login := ""
		if email != nil && *email != "" {
			login = *email
		} else if phone != nil {
			login = *phone
		}
		sentBy, sentTo, err = s.queueIssuedPassword(r.Context(), tx, id.InstitutionID, target,
			email, phone, login, temp, enabled)
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

	/* WHATEVER IS NOW IN EFFECT COMES BACK, TYPED OR GENERATED.

	   A password the administrator had typed was deliberately not echoed, on
	   the grounds that they already knew it and a value on screen is a value
	   left open on a desk. In an office that is wrong twice over: the person
	   who presses the button is often not the person who typed it -- a clerk
	   resetting a parent's login while the head reads it out -- and a screen
	   that says only "that password is in effect" cannot be read down a phone
	   to the parent who is waiting for it. They were resetting a second time
	   with a generated one just to get something they could read.

	   The value is only ever shown to somebody who already holds
	   users.write on that account and who has just changed it, so nothing is
	   disclosed here that they could not have set themselves a moment ago. */
	out := resetPasswordResponse{
		UserID:            target.String(),
		TemporaryPassword: temp,
		Note: "Shown once. Give it to the user in person and ask them to change it " +
			"from their profile. All their existing sessions have been signed out.",
		SentBy: sentBy,
		SentTo: sentTo,
	}
	if chosen != "" {
		out.TemporaryPassword = chosen
		out.Note = "The password you set is in effect and is shown here so it can be " +
			"read out. All their existing sessions have been signed out."
	}
	httpx.JSON(w, http.StatusOK, out)
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
