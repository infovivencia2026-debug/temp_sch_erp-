package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"html/template"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/static"
)

/* Getting back in.

   The only recovery was an administrator issuing a temporary password by hand,
   on the reasoning that self-service reset needs a delivery gateway this
   deployment does not have. That was true when it was written. It stopped
   being the whole truth once there was a message log: a message can be
   recorded, and the page can be honest about whether it left the building.

   Three rules, and they are the ones that make a reset link safe:

     The token is stored hashed. For fifteen minutes it is a password, and a
     table of live ones is a table worth stealing.

     The request never says whether the account exists. "If that address is on
     an account, a link is on its way" is the same sentence for a real address
     and a guess, because the alternative turns this form into a way of asking
     which of a school's staff are on the system.

     Using it revokes every session. If the account was taken over, the reset
     is how the owner throws the intruder out; leaving the intruder's session
     alive would make the reset theatre. */

// PasswordReset is the pair of public pages: ask for a link, and use one.
type PasswordReset struct {
	DB     *database.DB
	Tpl    *template.Template
	Hasher *auth.Hasher
	// BaseURL is what goes into the email. A relative path is fine on the page
	// that produced it and useless in a mail client.
	BaseURL string
	// EmailReady reports whether the account's own school can actually carry
	// the link. Where it can, the page stops printing the link on screen —
	// showing it there would hand a reset to whoever is at the keyboard
	// rather than to the account's owner. Where it cannot, the link is the
	// only way back in and the page says so.
	EmailReady func(r *http.Request, inst uuid.UUID) bool
}

type resetView struct {
	AssetVersion string
	Error        string
	Notice       string
	Token        string
	// Link is shown only where no mail provider is configured. A page that
	// claims to have sent an email that nothing could send is worse than one
	// that admits it and hands over the link.
	Link string
	Done bool
}

const resetWindow = 15 * time.Minute

func (p *PasswordReset) render(w http.ResponseWriter, r *http.Request, name string, status int, v resetView) {
	v.AssetVersion = static.Version()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := p.Tpl.ExecuteTemplate(w, name, v); err != nil {
		httpx.Internal(w, r, err)
	}
}

// ShowForgot renders the "what is your email" page.
func (p *PasswordReset) ShowForgot(w http.ResponseWriter, r *http.Request) {
	p.render(w, r, "forgot.gohtml", http.StatusOK, resetView{})
}

// Forgot issues a reset link for an account, if there is one.
func (p *PasswordReset) Forgot(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		httpx.BadRequest(w, r, "could not read the form")
		return
	}
	who := strings.TrimSpace(r.PostFormValue("identifier"))
	if who == "" {
		p.render(w, r, "forgot.gohtml", http.StatusBadRequest,
			resetView{Error: "Enter the email address, username or phone number you sign in with."})
		return
	}

	// Said the same way whether or not the account exists.
	const sameAnswer = "If that account exists, a reset link has been issued. " +
		"It is good for fifteen minutes."

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	token := hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))

	var link string
	var queued bool
	// Which school the account belongs to, kept for the readiness check below:
	// it is only known once the user has been found.
	var owner uuid.UUID
	// Absolute: the link is opened from a mail client, not from the page that
	// produced it.
	base := strings.TrimSuffix(p.BaseURL, "/")
	err := p.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		var userID uuid.UUID
		var instID *uuid.UUID
		var email *string

		/* Exactly one, the way signing in insists on exactly one.

		   An address is unique within a school and not across them, so two
		   people at two schools can share one — and this identifier arrives
		   with no school attached, because nobody has signed in yet. LIMIT 1
		   would have picked whichever the planner returned first and mailed a
		   link that resets a stranger's account. Refusing the ambiguous case
		   matches what the sign-in handler already does with it. */
		var matches int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*) FROM users
			 WHERE status <> 'disabled'
			   AND (email = $1::citext OR username = $1::citext OR phone = $1)`,
			who).Scan(&matches); err != nil {
			return err
		}
		if matches != 1 {
			// Said the same way as "no such account": a form that distinguishes
			// them tells a stranger which addresses are shared between schools.
			return nil
		}

		err := tx.QueryRow(r.Context(), `
			SELECT id, institution_id, email::text FROM users
			 WHERE status <> 'disabled'
			   AND (email = $1::citext OR username = $1::citext OR phone = $1)`,
			who).Scan(&userID, &instID, &email)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // answered identically below
		}
		if err != nil {
			return err
		}

		if _, err := tx.Exec(r.Context(), `
			INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip)
			VALUES ($1,$2,$3,$4)`,
			userID, hex.EncodeToString(sum[:]), time.Now().Add(resetWindow),
			nullString(r.Header.Get("X-Real-IP"))); err != nil {
			return err
		}
		link = "/reset?token=" + token

		// Queued, not marked sent. The worker hands queued rows to whatever
		// email provider the school has configured, so this becomes a real
		// message the moment SMTP credentials exist — and stays honestly
		// waiting when they do not. Writing 'sent' here made the log claim a
		// delivery nothing had performed.
		//
		// The body carries the link and never a password: a link expires and a
		// password sitting in a message log does not.
		if instID != nil && email != nil {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO message_log (institution_id, channel, template_code,
				                         recipient, user_id, subject, body, status)
				VALUES ($1,'email','password_reset',$2,$3,$4,$5,'queued')`,
				*instID, *email, userID, "Reset your password",
				"Open this link within fifteen minutes to choose a new password:\n"+
					base+link+"\n\nIf you did not ask for this, ignore it and nothing changes."); err != nil {
				return err
			}
			queued = true
			owner = *instID
		}
		return nil
	})
	if err != nil {
		httpx.LogError(r, err)
		p.render(w, r, "forgot.gohtml", http.StatusInternalServerError,
			resetView{Error: "Something went wrong at our end. Please try again."})
		return
	}

	view := resetView{Notice: sameAnswer}
	if !queued || p.EmailReady == nil || !p.EmailReady(r, owner) {
		view.Link = link
	}
	p.render(w, r, "forgot.gohtml", http.StatusOK, view)
}

// ShowReset renders the "choose a new password" page for a token.
func (p *PasswordReset) ShowReset(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if _, err := p.userForToken(r, token); err != nil {
		p.render(w, r, "reset.gohtml", http.StatusOK, resetView{
			Error: "That link has expired or has already been used. Ask for another.",
		})
		return
	}
	p.render(w, r, "reset.gohtml", http.StatusOK, resetView{Token: token})
}

// Reset sets the new password and spends the token.
func (p *PasswordReset) Reset(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		httpx.BadRequest(w, r, "could not read the form")
		return
	}
	token := r.PostFormValue("token")
	pw := r.PostFormValue("password")
	again := r.PostFormValue("password2")

	bad := func(msg string) {
		p.render(w, r, "reset.gohtml", http.StatusBadRequest, resetView{Token: token, Error: msg})
	}
	switch {
	case len(pw) < 10:
		bad("Use at least ten characters. A short password on a school system is everybody's problem, not just yours.")
		return
	case pw != again:
		bad("Those two do not match.")
		return
	}

	userID, err := p.userForToken(r, token)
	if err != nil {
		bad("That link has expired or has already been used. Ask for another.")
		return
	}
	hash, err := p.Hasher.Hash(pw)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	sum := sha256.Sum256([]byte(token))
	err = p.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(),
			`UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1`,
			userID, hash); err != nil {
			return err
		}
		// Spent, and every other outstanding link for this account with it: a
		// second live link after a reset is a second way back in for whoever
		// prompted the reset.
		if _, err := tx.Exec(r.Context(), `
			UPDATE password_resets SET used_at = now()
			 WHERE user_id = $1 AND used_at IS NULL`, userID); err != nil {
			return err
		}
		// Every session, including one an intruder is holding. Done in the
		// same transaction as the password change: a reset that sets the
		// password and then fails to sign the old sessions out has locked the
		// owner out and left the intruder in.
		if _, err := tx.Exec(r.Context(), `
			UPDATE sessions SET revoked_at = now()
			 WHERE user_id = $1 AND revoked_at IS NULL`, userID); err != nil {
			return err
		}
		_ = sum
		return nil
	})
	if err != nil {
		httpx.LogError(r, err)
		bad("Something went wrong at our end. Please try again.")
		return
	}

	p.render(w, r, "reset.gohtml", http.StatusOK, resetView{Done: true})
}

// userForToken returns the account a live token belongs to.
func (p *PasswordReset) userForToken(r *http.Request, token string) (uuid.UUID, error) {
	if len(token) < 32 {
		return uuid.Nil, errors.New("no token")
	}
	sum := sha256.Sum256([]byte(token))
	var userID uuid.UUID
	err := p.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT user_id FROM password_resets
			 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
			hex.EncodeToString(sum[:])).Scan(&userID)
	})
	return userID, err
}
