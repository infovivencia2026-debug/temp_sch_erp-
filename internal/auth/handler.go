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
		case errors.Is(err, errSchoolPaused):
			msg = "Your password is right, but this school's access is paused at the " +
				"moment. Nothing has been lost. Ask the school office, or whoever " +
				"runs EDU CLOUD for the school, to switch it back on."
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

/*
authenticate resolves an identifier and a password to exactly one account.

	Email, phone and username are unique per institution, not across the
	installation, so one identifier can legitimately name a person at each of
	several schools here. That used to be refused outright, and the message
	beside this now says so in words rather than blaming the password — which
	was the expensive half of the bug and is fixed.

	The other half is that it need not be refused at all. The parent has a
	different password at each school, so the password already answers which
	one she means: every candidate is verified and exactly one match signs in.
	Only a genuine tie — two accounts sharing both a number and a password —
	is still ambiguous, and there is nothing to choose between those two:
	signing whichever sorted first in would put a parent inside another
	school's records.

	Bounded at five candidates. Verification is a deliberately expensive hash,
	and an identifier shared across a dozen tenants would otherwise be a way to
	make one unauthenticated request cost a second of CPU.
*/
func (h *Handler) authenticate(ctx context.Context, identifier, password string) (uuid.UUID, uuid.UUID, error) {
	type candidate struct {
		userID uuid.UUID
		instID *uuid.UUID
		hash   *string
		// The school is suspended. Carried rather than filtered out in SQL,
		// because the difference between "no such account" and "your school
		// is paused" is the difference between a parent concluding they were
		// never enrolled and a parent ringing the office.
		paused bool
	}
	const maxCandidates = 5

	var candidates []candidate
	err := h.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		/* A LOGIN DIES WITH THE SCHOOL THAT ISSUED IT.

		   This asked only whether the USER was active. Nothing asked whether
		   the school still was — so every account of an archived or suspended
		   institution kept working: its parents could sign in, its staff could
		   sign in, and the tenant that had been shut off went on serving
		   whoever still had a password. Archiving a school looked complete on
		   the platform screen and removed nobody's access.

		   It also poisoned the sign-in of live schools. Identifiers are unique
		   per institution, so a number reused at a school that no longer
		   operates still counted as a second match, and this deployment has
		   been logging matches:2 for a parent whose only real account is at
		   Yajur.

		   institution_id IS NULL is the platform staff — the vendor's own
		   accounts belong to no school and must not be filtered out by a join
		   to one. */
		/* A suspended school's people are still found, and told so.

		   This used to filter `i.status = 'active'` here, so every user of a
		   paused school fell through to "No account here uses that username,
		   email or phone" — the sentence for a stranger, shown to a principal
		   whose school was switched off that morning. It cost an afternoon on
		   this deployment: the school was suspended by a stray click, and two
		   people concluded the credentials were wrong. The status comes back
		   as a column instead and is judged after the password is. */
		rows, err := tx.Query(ctx, `
			SELECT u.id, u.institution_id, u.password_hash,
			       (u.institution_id IS NOT NULL AND i.status <> 'active') AS paused
			  FROM users u
			  LEFT JOIN institutions i ON i.id = u.institution_id
			 WHERE u.status = 'active'
			   AND (u.email = $1::citext OR u.phone = $1 OR u.username = $1::citext)
			 ORDER BY u.created_at
			 LIMIT $2`, identifier, maxCandidates)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c candidate
			if err := rows.Scan(&c.userID, &c.instID, &c.hash, &c.paused); err != nil {
				return err
			}
			candidates = append(candidates, c)
		}
		return rows.Err()
	})
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}

	if len(candidates) == 0 {
		// The constant-time dummy: a number nobody uses and a wrong password
		// must cost the same, or the latency answers which numbers exist.
		_ = h.hasher.Verify(dummyHash, password)
		return uuid.Nil, uuid.Nil, errNoAccount
	}

	var matched []candidate
	for _, c := range candidates {
		if c.hash == nil {
			// An invited account with no password yet. Nothing to verify, and
			// nothing to sign in as.
			continue
		}
		if err := h.hasher.Verify(*c.hash, password); err == nil {
			matched = append(matched, c)
		}
	}

	switch len(matched) {
	case 1:
		// The ordinary case, and the interesting one: where the identifier was
		// ambiguous, the password has just said which school she meant.
	case 0:
		/* Nothing matched. This is a wrong password and is said as one, even
		   when the number belongs to accounts at two schools.

		   It used to answer "registered at more than one school, sign in with
		   your email instead" here, which is true of the number and irrelevant
		   to what just happened: the password decides between those accounts
		   now, so a person who typed the right one is already inside. Telling
		   somebody with a mistyped password to go and find a username sends
		   them to the office for a problem they do not have. */
		if len(candidates) > 1 {
			slog.Warn("no password matched an identifier held at several schools",
				"identifier", identifier, "candidates", len(candidates))
		}
		return uuid.Nil, uuid.Nil, ErrMismatch
	default:
		/* A real tie: the same number and the same password at two schools.
		   The only case the ambiguity message is now about, and the only one
		   where "use your email instead" is advice somebody can act on. */
		slog.Warn("identifier and password match more than one account",
			"identifier", identifier, "matches", len(matched))
		return uuid.Nil, uuid.Nil, errAmbiguousIdentifier
	}

	won := matched[0]
	if won.paused {
		/* Right password, paused school. Only reachable past Verify, so a
		   stranger enumerating addresses is still told "wrong password" and
		   learns nothing about which schools exist or their standing. */
		return uuid.Nil, uuid.Nil, errSchoolPaused
	}
	_ = h.db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE users SET last_login_at = now() WHERE id = $1`, won.userID)
		return err
	})

	var inst uuid.UUID
	if won.instID != nil {
		inst = *won.instID
	}
	return won.userID, inst, nil
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
