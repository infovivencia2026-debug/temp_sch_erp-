package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The second step of a sign-in.

   A password that checks out for an account with a second factor does not
   open a session. It opens a short-lived pending ticket -- who, which
   school, how they signed in, until when -- signed with the server's pepper
   and set as a cookie, and the login page asks for the six-digit code. The
   code plus a valid ticket is what opens the session. The ticket carries
   no secret and expires in five minutes; a forged one fails the signature. */

const (
	mfaPendingCookie = "erp_mfa"
	mfaPendingTTL    = 5 * time.Minute
)

func (h *Handler) signPending(parts ...string) string {
	msg := strings.Join(parts, "|")
	mac := hmac.New(sha256.New, h.hasher.pepper)
	mac.Write([]byte("mfa-pending\x00" + msg))
	return base64.RawURLEncoding.EncodeToString([]byte(msg)) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (h *Handler) openPending(tok string) (userID, instID uuid.UUID, via string, until time.Time, next string, ok bool) {
	i := strings.LastIndexByte(tok, '.')
	if i < 0 {
		return
	}
	msgB, err := base64.RawURLEncoding.DecodeString(tok[:i])
	if err != nil {
		return
	}
	sig, err := base64.RawURLEncoding.DecodeString(tok[i+1:])
	if err != nil {
		return
	}
	mac := hmac.New(sha256.New, h.hasher.pepper)
	mac.Write([]byte("mfa-pending\x00" + string(msgB)))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return
	}
	parts := strings.Split(string(msgB), "|")
	if len(parts) != 6 {
		return
	}
	exp, err := strconv.ParseInt(parts[4], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return
	}
	userID, err = uuid.Parse(parts[0])
	if err != nil {
		return
	}
	instID, _ = uuid.Parse(parts[1])
	via = parts[2]
	if u, err := strconv.ParseInt(parts[3], 10, 64); err == nil && u > 0 {
		until = time.Unix(u, 0)
	}
	next = safeNext(parts[5])
	ok = true
	return
}

// mfaSecretFor returns the account's TOTP secret, empty when the account
// has no second factor.
func (h *Handler) mfaSecretFor(r *http.Request, userID uuid.UUID) string {
	var secret *string
	_ = h.db.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `SELECT mfa_secret FROM users WHERE id = $1`, userID).Scan(&secret)
	})
	if secret == nil {
		return ""
	}
	return *secret
}

// askForCode sets the pending ticket and renders the code step.
func (h *Handler) askForCode(w http.ResponseWriter, r *http.Request, won signedIn, via string, until time.Time, next string) {
	u := int64(0)
	if !until.IsZero() {
		u = until.Unix()
	}
	tok := h.signPending(won.userID.String(), won.instID.String(), via,
		strconv.FormatInt(u, 10), strconv.FormatInt(time.Now().Add(mfaPendingTTL).Unix(), 10), next)
	http.SetCookie(w, &http.Cookie{
		Name: mfaPendingCookie, Value: tok, Path: "/login", MaxAge: int(mfaPendingTTL.Seconds()),
		HttpOnly: true, Secure: h.secure, SameSite: http.SameSiteLaxMode,
	})
	h.record(r.Context(), r, LoginEvent{Outcome: "mfa_required", UserID: won.userID, InstID: won.instID, Via: via})
	h.render(w, r, http.StatusOK, loginPage{CSRFToken: h.issueCSRF(w), Next: next, MFAStep: true})
}

// LoginMFA answers POST /login/mfa: the six-digit code against the pending
// ticket. Three wrong codes end the ticket; the person starts again from
// the password, which is also what the throttle counts.
func (h *Handler) LoginMFA(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		h.render(w, r, http.StatusBadRequest, loginPage{CSRFToken: h.issueCSRF(w), Error: "Malformed form submission."})
		return
	}
	c, err := r.Cookie(csrfCookie)
	if err != nil || !constantTimeEqual(c.Value, r.PostFormValue("csrf_token")) {
		h.render(w, r, http.StatusForbidden, loginPage{CSRFToken: h.issueCSRF(w), Error: "Your sign-in form expired. Please try again."})
		return
	}
	pc, err := r.Cookie(mfaPendingCookie)
	if err != nil || pc.Value == "" {
		h.render(w, r, http.StatusUnauthorized, loginPage{CSRFToken: h.issueCSRF(w),
			Error: "That code step has expired. Sign in with your password again."})
		return
	}
	userID, instID, via, until, next, ok := h.openPending(pc.Value)
	if !ok {
		h.clearPending(w)
		h.render(w, r, http.StatusUnauthorized, loginPage{CSRFToken: h.issueCSRF(w),
			Error: "That code step has expired. Sign in with your password again."})
		return
	}
	secret := h.mfaSecretFor(r, userID)
	if secret == "" || !VerifyTOTP(secret, r.PostFormValue("code"), time.Now()) {
		h.record(r.Context(), r, LoginEvent{Outcome: "mfa_failed", UserID: userID, InstID: instID, Via: via})
		h.render(w, r, http.StatusUnauthorized, loginPage{CSRFToken: h.issueCSRF(w), Next: next, MFAStep: true,
			Error: "That code is not right. Open your authenticator app and type the current six digits."})
		return
	}
	h.clearPending(w)
	sid, err := h.store.IssueViaID(r.Context(), w, r, userID, instID, via, until)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	slog.Info("mfa sign-in", "user", userID)
	h.record(r.Context(), r, LoginEvent{Outcome: "success", UserID: userID, InstID: instID, SessionID: sid, Via: via + "+totp"})
	http.Redirect(w, r, next, http.StatusSeeOther)
}

func (h *Handler) clearPending(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: mfaPendingCookie, Value: "", Path: "/login", MaxAge: -1,
		HttpOnly: true, Secure: h.secure, SameSite: http.SameSiteLaxMode})
}
