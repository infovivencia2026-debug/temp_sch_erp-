package api

import (
	"errors"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The digital library's two claims, pinned.

	The first is ordinary: browsing needs operations.library.read and
	cataloguing needs operations.library.write, and the /ops group these mount
	inside carries no permission of its own, so every route must bring one.

	The second is the one worth a test file. The catalogue entry for this
	feature promises EBSCO and JSTOR; this deployment has neither subscription.
	The provider seam is built and deliberately inert, and the last test here
	is what stops it quietly becoming a claim: if somebody makes
	resolveDigitalProvider return success for a provider that is not live, this
	fails, and they have to decide on purpose rather than by accident. Same
	shape as the Tally gateway test, and for the same reason.
*/

// mountedDigitalLibrary builds the router as api.go does: inside r.Route("/ops"),
// which applies no middleware of its own.
func mountedDigitalLibrary(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) { s.mountDigitalLibrary(r) })
	return r
}

// A signed-in user with no library grant reaches none of it.
func TestDigitalLibraryRefusesWithoutLibraryRead(t *testing.T) {
	h := mountedDigitalLibrary(identityWith())
	id := uuid.NewString()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/digital-library/catalogue"},
		{http.MethodGet, "/digital-library/holdings/" + id + "/access"},
		{http.MethodPost, "/digital-library/holdings/" + id + "/borrow"},
		{http.MethodPost, "/digital-library/holdings"},
		{http.MethodDelete, "/digital-library/holdings/" + id},
		{http.MethodPut, "/digital-library/holdings/" + id + "/visibility"},
		{http.MethodGet, "/digital-library/providers"},
		{http.MethodPost, "/digital-library/providers"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with no permission: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Browsing is not cataloguing.

	A pupil holds library.read: they may see the catalogue and join a queue,
	and they may not add a title, change who can see one, or record a
	subscription. The group gate alone would have let them do all three.
*/
func TestDigitalCataloguingNeedsLibraryWrite(t *testing.T) {
	reader := mountedDigitalLibrary(identityWith(rbac.LibraryRead))
	id := uuid.NewString()
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/digital-library/holdings"},
		{http.MethodDelete, "/digital-library/holdings/" + id},
		{http.MethodPut, "/digital-library/holdings/" + id + "/visibility"},
		{http.MethodPost, "/digital-library/providers"},
		{http.MethodDelete, "/digital-library/providers/" + id},
	} {
		if got := statusOf(t, reader, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only library.read: got %d, want 403", tc.method, tc.path, got)
		}
	}

	librarian := mountedDigitalLibrary(identityWith(rbac.LibraryRead, rbac.LibraryWrite))
	if got := statusOf(t, librarian, http.MethodPost, "/digital-library/holdings"); got == http.StatusForbidden {
		t.Error("a librarian holding library.write was refused")
	}
}

// Walked from the routes chi registered, so a new write that forgot its
// permission fails here rather than in production.
func TestEveryDigitalLibraryWriteIsGated(t *testing.T) {
	h := mountedDigitalLibrary(identityWith())
	mux, ok := h.(*chi.Mux)
	if !ok {
		t.Fatal("router is not a chi.Mux")
	}
	err := chi.Walk(mux, func(method, route string,
		_ http.Handler, _ ...func(http.Handler) http.Handler) error {
		path := chiRouteToPath(route)
		if got := statusOf(t, h, method, path); got != http.StatusForbidden {
			t.Errorf("%s %s is not gated: got %d, want 403", method, path, got)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

/*
The provider seam is unavailable, and says so.

	No provider on this deployment reaches 'live', because nothing sets it
	there: saveDigitalProvider does not accept a status and the column defaults
	to 'unavailable'. Anything behind a provider therefore refuses, and a
	holding behind no provider is not affected.

	If a future change makes a subscription work, this test is where the change
	has to be argued for — which is the whole point of pinning it.
*/
func TestDigitalProviderSeamIsUnavailable(t *testing.T) {
	provider := uuid.NewString()
	for _, status := range []string{"unavailable", "configured"} {
		st := status
		h := digitalHoldingRow{ProviderID: &provider, ProviderStatus: &st}
		if err := resolveDigitalProvider(h); err == nil {
			t.Errorf("a provider in status %q resolved a link it cannot resolve", st)
		}
	}
	// A provider row with no status at all is not a working subscription either.
	if err := resolveDigitalProvider(digitalHoldingRow{ProviderID: &provider}); err == nil {
		t.Error("a provider with no status resolved a link")
	}
	// A title the school holds itself is behind no provider and always opens.
	if err := resolveDigitalProvider(digitalHoldingRow{}); err != nil {
		t.Errorf("a holding with no provider was refused: %v", err)
	}
}

/*
One licensed reader at a time, enforced on the server.

	The catalogue tells a client whether a single-copy e-book is currently
	theirs, and a client is free to ignore that. This is the check that is not
	optional: without it, everyone who can see a lendable e-book can read it at
	once, and the school is quietly in breach of the licence it paid for.
*/
func TestSingleCopyEbookOpensOnlyForTheBorrower(t *testing.T) {
	lent := digitalHoldingRow{AccessModel: "single_copy_loan", IsActive: true, MineNow: true}
	if err := digitalEntitlement(lent); err != nil {
		t.Errorf("the borrower was refused their own loan: %v", err)
	}

	out := digitalHoldingRow{AccessModel: "single_copy_loan", IsActive: true, MineNow: false}
	if err := digitalEntitlement(out); !errors.Is(err, errNotBorrowed) {
		t.Errorf("an e-book lent to somebody else opened anyway: %v", err)
	}

	// An open or subscribed title is not lent at all and needs no loan.
	for _, model := range []string{"open", "subscription"} {
		h := digitalHoldingRow{AccessModel: model, IsActive: true}
		if err := digitalEntitlement(h); err != nil {
			t.Errorf("%s title refused: %v", model, err)
		}
	}

	// A withdrawn title is gone, whoever holds it.
	for _, model := range []string{"open", "single_copy_loan"} {
		h := digitalHoldingRow{AccessModel: model, MineNow: true}
		if err := digitalEntitlement(h); !errors.Is(err, errHoldingWithdrawn) {
			t.Errorf("a withdrawn %s title was still served: %v", model, err)
		}
	}

	// And the provider seam still applies to a title the reader legitimately
	// holds: the licence is theirs, the subscription is not connected.
	provider, status := uuid.NewString(), "configured"
	h := digitalHoldingRow{
		AccessModel: "subscription", IsActive: true,
		ProviderID: &provider, ProviderStatus: &status,
	}
	if err := digitalEntitlement(h); !errors.Is(err, errProviderUnavailable) {
		t.Errorf("an unconnected subscription resolved: %v", err)
	}
}
