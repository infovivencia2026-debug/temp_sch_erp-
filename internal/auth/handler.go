package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/static"
)

// Handler serves the server-rendered auth pages.
//
// These stay outside the SPA on purpose: the sign-in form must work before any
// JavaScript bundle loads, and it is the one place a session cookie is minted.
type Handler struct {
	db       *database.DB
	store    *Store
	hasher   *Hasher
	tpl      *template.Template
	secure   bool
	throttle *Throttle
}

func NewHandler(db *database.DB, store *Store, hasher *Hasher, tpl *template.Template, secure bool) *Handler {
	return &Handler{db: db, store: store, hasher: hasher, tpl: tpl,
		secure: secure, throttle: NewThrottle()}
}

const csrfCookie = "erp_csrf"

// issueCSRF uses the double-submit pattern: the same random value goes into a
// cookie and a hidden field, and login compares them. That is sufficient here
// because an attacker on another origin can post a form but cannot read or set
// our cookie.
func (h *Handler) issueCSRF(w http.ResponseWriter) string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	tok := base64.RawURLEncoding.EncodeToString(b)
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookie,
		Value:    tok,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.secure,
		SameSite: http.SameSiteLaxMode,
		// Deliberately a session cookie with no Expires.
		//
		// An absolute expiry is evaluated against the *client's* clock. With a
		// one-hour lifetime, any device running more than an hour fast discards
		// the cookie the moment it arrives and the user can never sign in —
		// they just get "your sign-in form expired" forever, with nothing in
		// the server logs to explain it. A CSRF token only needs to survive the
		// round trip from form render to submit, which a session cookie does
		// regardless of what the device thinks the time is.
	})
	return tok
}

type loginPage struct {
	CSRFToken string
	Error     string
	Next      string
	// AssetVersion busts the seven-day cache nginx puts on /static. Without it
	// a returning visitor keeps whichever stylesheet they first fetched.
	AssetVersion string
}

func (h *Handler) ShowLogin(w http.ResponseWriter, r *http.Request) {
	if httpx.IdentityFrom(r.Context()) != nil {
		http.Redirect(w, r, safeNext(r.URL.Query().Get("next")), http.StatusSeeOther)
		return
	}
	h.render(w, r, http.StatusOK, loginPage{
		CSRFToken: h.issueCSRF(w),
		Next:      safeNext(r.URL.Query().Get("next")),
	})
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		h.render(w, r, http.StatusBadRequest, loginPage{CSRFToken: h.issueCSRF(w), Error: "Malformed form submission."})
		return
	}

	c, err := r.Cookie(csrfCookie)
	if err != nil || !constantTimeEqual(c.Value, r.PostFormValue("csrf_token")) {
		h.render(w, r, http.StatusForbidden, loginPage{
			CSRFToken: h.issueCSRF(w),
			Error:     "Your sign-in form expired. Please try again.",
		})
		return
	}

	identifier := strings.TrimSpace(r.PostFormValue("identifier"))
	password := r.PostFormValue("password")
	next := safeNext(r.PostFormValue("next"))

	// Throttle before touching the database. Without this, the sign-in form is
	// an unlimited password oracle, and the constant-time dummy hash below only
	// hides *which* accounts exist — it does nothing to slow guessing.
	if ok, wait := h.throttle.Allowed(identifier); !ok {
		slog.Warn("login throttled", "identifier", identifier, "retry_in", wait.String())
		h.render(w, r, http.StatusTooManyRequests, loginPage{
			CSRFToken: h.issueCSRF(w),
			Error: fmt.Sprintf("Too many failed attempts. Try again in %d minute(s).",
				int(wait.Minutes())+1),
			Next: next,
		})
		return
	}

	userID, instID, err := h.authenticate(r.Context(), identifier, password)
	if err != nil {
		h.throttle.Failed(identifier)
		/* THREE DIFFERENT FACTS, SAID AS THREE.

		   This was one message — "Incorrect username or password" — chosen so
		   the form could not be used to enumerate accounts. That is a real
		   concern and the reason it stood for a long time. It also cost a full
		   day of this school's time: a parent's number was registered at two
		   institutions, every sign-in was refused for THAT reason, and the
		   screen said the password was wrong. The office reissued the password
		   four times, each one correct, each one rejected, and concluded the
		   accounts were not being created at all.

		   Enumeration is a modest risk here and it is already available: the
		   forgot-password form answers per address, and a school's roll is not
		   a secret from the people holding it. Being unable to tell a wrong
		   password from an unusable account is a daily, certain cost. So the
		   three cases are now three sentences, and only the one that is
		   actually about the password mentions the password. */
		msg := "That password is not right. Try again, or use Forgotten your password."
		switch {
		case errors.Is(err, errNoAccount):
			msg = "No account here uses that username, email or phone. " +
				"Check it with the school office."
		case errors.Is(err, errAmbiguousIdentifier):
			msg = "That number or address is registered at more than one school, " +
				"so we cannot tell which account you mean. Sign in with your email " +
				"address instead, or ask the office for a username."
		}
		h.render(w, r, http.StatusUnauthorized, loginPage{
			CSRFToken: h.issueCSRF(w),
			Error:     msg,
			Next:      next,
		})
		return
	}

	h.throttle.Succeeded(identifier)

	if err := h.store.Issue(r.Context(), w, r, userID, instID); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	http.Redirect(w, r, next, http.StatusSeeOther)
}

// dummyHash is compared against when no user matches, so a missing account and
// a wrong password take the same amount of time. Without it, response latency
// leaks which usernames exist.
const dummyHash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"

func (h *Handler) authenticate(ctx context.Context, identifier, password string) (uuid.UUID, uuid.UUID, error) {
	var (
		userID uuid.UUID
		instID *uuid.UUID
		hash   *string
	)
	// Email, phone and username are each unique *per institution* (users_institution_email /
	// users_institution_phone), not globally, so an identifier can legitimately
	// match one user in each of several tenants. This deployment serves one
	// institution per hostname and the sign-in form has no tenant selector, so
	// rather than guess, refuse: authenticating whichever row sorted first
	// would sign the user into the wrong school.
	var matches int
	err := h.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM users
			 WHERE status = 'active'
			   AND (email = $1::citext OR phone = $1 OR username = $1::citext)`,
			identifier).Scan(&matches); err != nil {
			return err
		}
		if matches == 0 {
			return errNoAccount
		}
		if matches > 1 {
			// Refusing is right — see above — but it is a different fact from
			// a wrong password and the caller has to be able to tell them
			// apart, or the person holding a correct password is told it is
			// wrong and gives up.
			return errAmbiguousIdentifier
		}
		return tx.QueryRow(ctx, `
			SELECT id, institution_id, password_hash
			  FROM users
			 WHERE status = 'active'
			   AND (email = $1::citext OR phone = $1 OR username = $1::citext)`,
			identifier).
			Scan(&userID, &instID, &hash)
	})
	if matches > 1 {
		slog.Warn("ambiguous login identifier across tenants",
			"identifier", identifier, "matches", matches)
	}
	if errors.Is(err, errAmbiguousIdentifier) {
		// Still a constant-time path: the work below is skipped either way and
		// the caller decides what to say.
		_ = h.hasher.Verify(dummyHash, password)
		return uuid.Nil, uuid.Nil, errAmbiguousIdentifier
	}
	if errors.Is(err, errNoAccount) || errors.Is(err, pgx.ErrNoRows) ||
		(err == nil && hash == nil) {
		_ = h.hasher.Verify(dummyHash, password)
		return uuid.Nil, uuid.Nil, errNoAccount
	}
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if err := h.hasher.Verify(*hash, password); err != nil {
		return uuid.Nil, uuid.Nil, err
	}

	_ = h.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE users SET last_login_at = now() WHERE id = $1`, userID)
		return err
	})

	var inst uuid.UUID
	if instID != nil {
		inst = *instID
	}
	return userID, inst, nil
}

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	if id := httpx.IdentityFrom(r.Context()); id != nil {
		_ = h.store.Revoke(r.Context(), id.SessionID)
	}
	h.store.Clear(w)
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func (h *Handler) render(w http.ResponseWriter, r *http.Request, status int, data loginPage) {
	data.AssetVersion = static.Version()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := h.tpl.ExecuteTemplate(w, "login.gohtml", data); err != nil {
		httpx.Internal(w, r, err)
	}
}

// safeNext blocks open redirects: only same-site absolute paths are honoured,
// so "//evil.example" and "https://evil.example" both fall back to "/".
func safeNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") {
		return "/"
	}
	return next
}
