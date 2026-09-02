package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
)

/*
An account on its issued password reaches two things and no others.

	The issued password is the person's own mobile number, so between "the
	office made you an account" and "you chose a password", the credential is
	public: it is on the class list and in every other parent's phone. The
	client renders one screen, but a client is not a gate — the check has to
	hold for anybody who can type a URL, which is what this pins.
*/
func TestPasswordChangeGateAllowsOnlyTheWayOut(t *testing.T) {
	s := &Server{}
	reached := false
	handler := s.requirePasswordChanged(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))

	call := func(method, path string, mustChange bool) int {
		reached = false
		req := httptest.NewRequest(method, path, nil)
		req = req.WithContext(httpx.WithIdentity(req.Context(), &httpx.Identity{
			UserID:             uuid.New(),
			InstitutionID:      uuid.New(),
			MustChangePassword: mustChange,
		}))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w.Code
	}

	if got := call("GET", "/session", true); got != http.StatusOK || !reached {
		t.Errorf("reading the session was refused: %d", got)
	}
	/* The way out, at the path the request actually carries.

	   This asked for "/profile/password" and passed while production served
	   "/api/v1/profile/password" and refused it — so the one call that clears
	   the flag was blocked by the flag, and every new parent was stuck on the
	   screen telling them to set a password. Both forms are asserted now:
	   which one arrives depends on where the API is mounted, and that is not
	   this middleware's business. */
	for _, path := range []string{"/profile/password", "/api/v1/profile/password"} {
		if got := call("POST", path, true); got != http.StatusOK || !reached {
			t.Errorf("setting a new password at %s was refused: %d", path, got)
		}
	}

	// Everything else, including the reads that look harmless. A parent's
	// child list is exactly what the guessed password is worth stealing.
	for _, path := range []string{
		"/students", "/api/v1/students", "/transport/live",
		"/profile", "/api/v1/profile", "/fees/invoices",
	} {
		if got := call("GET", path, true); got != http.StatusForbidden {
			t.Errorf("%s answered %d, want 403", path, got)
		}
		if reached {
			t.Errorf("%s reached the handler behind the gate", path)
		}
	}

	// And once the password is their own, nothing is in the way.
	if got := call("GET", "/students", false); got != http.StatusOK || !reached {
		t.Errorf("a settled account was blocked: %d", got)
	}
}

// The password a school hands out is one the family already knows by heart.
func TestIssuedPasswordPrefersTheNumberOverAGeneratedCode(t *testing.T) {
	pw, known, err := issuedPassword(" 9848012345 ", "parent@example.in")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if pw != "9848012345" || !known {
		t.Errorf("got %q known=%v, want the trimmed phone and known=true", pw, known)
	}

	pw, known, err = issuedPassword("", "office@school.edu.in")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if pw != "office@school.edu.in" || !known {
		t.Errorf("got %q known=%v, want the email and known=true", pw, known)
	}

	/* Neither on file — a child whose sign-in is an admission number. There is
	   nothing to derive from, so it is generated and the account is NOT held:
	   nobody can guess it, and holding it would strand a child behind a screen
	   asking for a password only the office has. */
	pw, known, err = issuedPassword("", "")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if known {
		t.Error("a generated password was reported as one the person knows")
	}
	if len(pw) < 12 {
		t.Errorf("generated password %q is too short to be unguessable", pw)
	}
}

/*
An issued PIN is six digits, and the gate that accepts it agrees.

	The product settled on six for everything a person types on a keypad --
	the pairing codes, the bus sticker, this. A school that has to remember
	"the PIN is four but the bus code is six" gets one of them wrong at the
	counter, and four digits is ten thousand guesses where six is a million.

	The window either side stays open on purpose: a PIN handed out before this
	change still verifies, because locking every driver out of their handset on
	the morning of a deploy is not a security improvement.
*/
func TestTemporaryPINIsSixDigitsAndAccepted(t *testing.T) {
	for i := 0; i < 50; i++ {
		pin, err := temporaryPIN()
		if err != nil {
			t.Fatalf("mint: %v", err)
		}
		if len(pin) != pinDigits {
			t.Fatalf("PIN %q is %d digits, want %d", pin, len(pin), pinDigits)
		}
		if !validPIN(pin) {
			t.Fatalf("the sign-in gate refuses %q, which was just issued", pin)
		}
	}
	// The four-digit PINs already in the field.
	if !validPIN("1234") {
		t.Error("a PIN issued before this change stopped working")
	}
	if validPIN("12345a") || validPIN("123") {
		t.Error("the gate accepts a PIN it should not")
	}
}
