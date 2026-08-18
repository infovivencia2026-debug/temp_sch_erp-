package api

import (
	"net/http/httptest"
	"testing"
)

// The allow-list is matched against the path below /api/v1. Getting this wrong
// locks a school out of the very endpoint that would explain why it is locked,
// which looks like an outage rather than an invoice.
func TestAPIPathStripsMountPrefix(t *testing.T) {
	for path, want := range map[string]string{
		"/api/v1/session":         "/session",
		"/api/v1/catalog":         "/catalog",
		"/api/v1/students":        "/students",
		"/api/v1/students/abc123": "/students/abc123",
		"/api/v1":                 "",
		"/session":                "/session", // already relative
	} {
		r := httptest.NewRequest("GET", path, nil)
		if got := apiPath(r); got != want {
			t.Errorf("apiPath(%q) = %q, want %q", path, got, want)
		}
	}
}

// Segment-wise matching: /profiles must not be mistaken for /profile, or a
// locked school gets a module free because its name starts the same way.
func TestPathHasPrefixIsSegmentWise(t *testing.T) {
	yes := map[string]string{
		"/profile":       "/profile",
		"/profile/photo": "/profile",
		"/me":            "/me",
		"/session":       "/session",
	}
	for path, prefix := range yes {
		if !pathHasPrefix(path, prefix) {
			t.Errorf("pathHasPrefix(%q,%q) = false, want true", path, prefix)
		}
	}
	no := map[string]string{
		"/profiles":       "/profile",
		"/profile-photos": "/profile",
		"/sessions":       "/session",
		"/method":         "/me",
		"/":               "/me",
	}
	for path, prefix := range no {
		if pathHasPrefix(path, prefix) {
			t.Errorf("pathHasPrefix(%q,%q) = true, want false", path, prefix)
		}
	}
}

// Every path on the free list must be one somebody genuinely cannot work
// without while locked. This pins the list so that widening it is a deliberate
// edit to a test, not an accident in a middleware.
func TestOpenWhileLockedIsMinimal(t *testing.T) {
	want := map[string]bool{
		"/session": true, "/catalog": true, "/me": true,
		"/profile": true, "/ref-data": true,
	}
	if len(openWhileLocked) != len(want) {
		t.Fatalf("the free list has %d entries, expected %d: %v",
			len(openWhileLocked), len(want), openWhileLocked)
	}
	for _, p := range openWhileLocked {
		if !want[p] {
			t.Errorf("%q was added to the free list — is it really free?", p)
		}
	}
	// The endpoints that must never be free, because they are the product.
	for _, locked := range []string{"/students", "/fees", "/attendance", "/exams", "/hr", "/setup"} {
		for _, open := range openWhileLocked {
			if pathHasPrefix(locked, open) {
				t.Errorf("%s is reachable while locked via %s", locked, open)
			}
		}
	}
}
