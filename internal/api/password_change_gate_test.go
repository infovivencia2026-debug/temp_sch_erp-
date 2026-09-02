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

	// The two the screen itself needs.
	if got := call("GET", "/session", true); got != http.StatusOK || !reached {
		t.Errorf("reading the session was refused: %d", got)
	}
	if got := call("POST", "/profile/password", true); got != http.StatusOK || !reached {
		t.Errorf("setting a new password was refused: %d", got)
	}

	// Everything else, including the reads that look harmless. A parent's
	// child list is exactly what the guessed password is worth stealing.
	for _, path := range []string{"/students", "/transport/live", "/profile", "/fees/invoices"} {
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
