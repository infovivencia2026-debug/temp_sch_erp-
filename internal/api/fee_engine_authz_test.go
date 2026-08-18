package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Authorization is decided here, not by the screen that hides a button.

	These drive the real router mountFeeEngine builds, so they check the wiring
	rather than a restatement of it: a route added later without a permission
	is caught by the "every write is gated" test below, which enumerates the
	routes chi actually registered instead of a list kept by hand.

	No database is needed. RequirePermission runs before the handler, so a
	refusal never reaches one — and a test that had to reach a handler to prove
	a 403 would be proving the wrong thing.
*/

// mountedFeeEngine builds the router as api.go will, inside a group carrying
// the same read gate the /finance group applies.
func mountedFeeEngine(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.InvoicesRead))
		s.mountFeeEngine(r)
	})
	return r
}

func identityWith(perms ...string) *httpx.Identity {
	set := map[string]struct{}{}
	for _, p := range perms {
		set[p] = struct{}{}
	}
	return &httpx.Identity{
		UserID:        uuid.New(),
		InstitutionID: uuid.New(),
		Permissions:   set,
	}
}

/*
statusOf issues one request and reports the status the router produced.

	A handler that gets past the permission check reaches a nil *database.DB and
	panics. That panic is reported as 500, because for these tests it means the
	same thing as any other non-403: the guard let the request through, which is
	the only fact being asserted. Recovering in the goroutine rather than in the
	caller keeps a panic from taking the test binary down with it.
*/
func statusOf(t *testing.T, h http.Handler, method, path string) int {
	t.Helper()
	done := make(chan int, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- http.StatusInternalServerError
			}
		}()
		req := httptest.NewRequest(method, path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		done <- w.Code
	}()
	return <-done
}

// A caller holding nothing gets 403 from every route, read and write alike.
func TestFeeEngineRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedFeeEngine(identityWith())

	for _, tc := range []struct{ method, path string }{
		{"GET", "/fee-engine/structures"},
		{"GET", "/fee-engine/fine-rules"},
		{"GET", "/fee-engine/fines/preview"},
		{"GET", "/fee-engine/receipt-series"},
		{"POST", "/fee-engine/versions"},
		{"POST", "/fee-engine/fine-rules"},
		{"POST", "/fee-engine/fines/apply"},
		{"PUT", "/fee-engine/receipt-series/receipt"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 for a caller holding no permissions",
				tc.method, tc.path, got)
		}
	}
}

/*
Reading dues does not entitle you to change the fee book.

	A cashier holds finance.invoices.read and must be able to see what a class
	is charged. Opening a fee revision, editing a fine rule or reshaping the
	receipt series are all decisions somebody else signs off, and the read gate
	must not be mistaken for consent to any of them.
*/
func TestFeeEngineReadPermissionDoesNotGrantWrites(t *testing.T) {
	h := mountedFeeEngine(identityWith(rbac.InvoicesRead))

	// Reads are allowed: past the guard, into a handler with no database.
	for _, path := range []string{
		"/fee-engine/structures",
		"/fee-engine/fine-rules",
		"/fee-engine/receipt-series",
	} {
		if got := statusOf(t, h, "GET", path); got == http.StatusForbidden {
			t.Errorf("GET %s: 403 for a holder of finance.invoices.read, which should read", path)
		}
	}

	// Writes are not.
	for _, tc := range []struct{ method, path string }{
		{"POST", "/fee-engine/versions"},
		{"PUT", "/fee-engine/versions/" + uuid.NewString() + "/items"},
		{"POST", "/fee-engine/versions/" + uuid.NewString() + "/activate"},
		{"DELETE", "/fee-engine/versions/" + uuid.NewString()},
		{"POST", "/fee-engine/fine-rules"},
		{"DELETE", "/fee-engine/fine-rules/" + uuid.NewString()},
		{"POST", "/fee-engine/fines/apply"},
		{"POST", "/fee-engine/fines/charges/" + uuid.NewString() + "/waive"},
		{"PUT", "/fee-engine/receipt-series/receipt"},
		{"PUT", "/fee-engine/gst-heads/" + uuid.NewString()},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — read permission must not grant this",
				tc.method, tc.path, got)
		}
	}
}

/*
Configuring the fine policy and running it are different jobs.

	finance.fees.write is fee master data: the structures, the rules. Raising a
	fine changes what a parent owes, so it takes finance.invoices.write. Someone
	who may edit the policy must not thereby be able to charge the whole school
	on the strength of it.
*/
func TestFineRuleAuthorIsNotAutomaticallyAbleToLevy(t *testing.T) {
	h := mountedFeeEngine(identityWith(rbac.InvoicesRead, rbac.FeesWrite))

	// May configure.
	if got := statusOf(t, h, "POST", "/fee-engine/fine-rules"); got == http.StatusForbidden {
		t.Error("POST /fee-engine/fine-rules: 403 for a holder of finance.fees.write")
	}
	// May not levy.
	for _, tc := range []struct{ method, path string }{
		{"POST", "/fee-engine/fines/apply"},
		{"POST", "/fee-engine/fines/charges/" + uuid.NewString() + "/waive"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — raising a fine is finance.invoices.write",
				tc.method, tc.path, got)
		}
	}
}

// And the converse: whoever runs the fine sweep cannot quietly rewrite the fee
// book or the receipt series on the way past.
func TestLevyPermissionDoesNotGrantMasterData(t *testing.T) {
	h := mountedFeeEngine(identityWith(rbac.InvoicesRead, rbac.InvoicesWrite))

	if got := statusOf(t, h, "POST", "/fee-engine/fines/apply"); got == http.StatusForbidden {
		t.Error("POST /fee-engine/fines/apply: 403 for a holder of finance.invoices.write")
	}
	for _, tc := range []struct{ method, path string }{
		{"POST", "/fee-engine/versions"},
		{"POST", "/fee-engine/fine-rules"},
		{"PUT", "/fee-engine/receipt-series/receipt"},
		{"PUT", "/fee-engine/gst-heads/" + uuid.NewString()},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — that is fee master data",
				tc.method, tc.path, got)
		}
	}
}

/*
Every mutating route is gated, enumerated from the router itself.

	The point of walking chi's tree rather than listing paths is that a route
	added to mountFeeEngine later is covered without anybody remembering to
	update a test. An ungated POST is the failure this whole file exists to
	prevent.
*/
func TestEveryFeeEngineWriteIsGated(t *testing.T) {
	// A caller holding only the group's read gate must be refused every write.
	h := mountedFeeEngine(identityWith(rbac.InvoicesRead))

	var writes []string
	err := chi.Walk(mountedFeeEngine(identityWith()).(*chi.Mux),
		func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
			if method == http.MethodGet || method == http.MethodHead {
				return nil
			}
			writes = append(writes, method+" "+route)
			return nil
		})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	if len(writes) == 0 {
		t.Fatal("no write routes found — the walk is not seeing mountFeeEngine's routes")
	}

	for _, w := range writes {
		method, route, _ := strings.Cut(w, " ")
		// chi reports patterns with {params}; substitute a real uuid.
		path := route
		for strings.Contains(path, "{") {
			open := strings.Index(path, "{")
			close := strings.Index(path[open:], "}") + open
			if close <= open {
				break
			}
			path = path[:open] + uuid.NewString() + path[close+1:]
		}
		if got := statusOf(t, h, method, path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — this write is not gated on a permission",
				method, path, got)
		}
	}
	t.Logf("%d write routes, all refused without their permission", len(writes))
}
