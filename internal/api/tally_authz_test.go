package api

import (
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Authorization for the Tally bridge, decided here rather than by a hidden button.

	These drive the real routers mountTally and mountTallyConnector build, inside
	groups carrying exactly the middleware api.go applies, so they check the
	wiring rather than a restatement of it.

	No database is needed: RequirePermission runs before the handler, so a
	refusal never reaches one. identityWith and statusOf already exist in this
	package (fee_engine_authz_test.go) and are reused rather than redeclared —
	a second copy would compile until somebody changed one of them.

	The property that matters most is the last test in this file. The Tally
	gateway address describes the school's internal network and is deliberately
	out of reach of the school's own administrator; if that ever stops being
	true, it will stop quietly.
*/

// mountedTally builds the export half as api.go does: inside the /finance
// group, which carries RequirePermission(InvoicesRead).
func mountedTally(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.InvoicesRead))
		s.mountTally(r)
	})
	return r
}

// mountedTallyConnector builds the platform half as api.go does: inside
// /admin, which carries no group-level permission at all, so every route must
// bring its own.
func mountedTallyConnector(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) {
		s.mountTallyConnector(r)
	})
	return r
}

// A signed-in user with no finance grant at all reaches none of the export.
func TestTallyExportRefusesWithoutInvoicesRead(t *testing.T) {
	h := mountedTally(identityWith())
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/tally/settings"},
		{http.MethodGet, "/tally/validate"},
		{http.MethodPost, "/tally/export"},
		{http.MethodGet, "/tally/runs"},
		{http.MethodGet, "/tally/runs/" + uuid.NewString() + "/file"},
		{http.MethodPost, "/tally/runs/" + uuid.NewString() + "/confirm"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s without any permission: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Reading the finance module does not entitle you to hand the books to another
system.

	A clerk who may look up an invoice holds finance.invoices.read. Producing a
	file of every voucher in the year, and marking them exported, is a different
	act — it is the one finance.export names — and the group gate alone would
	have let the clerk through.
*/
func TestTallyExportNeedsFinanceExportNotJustRead(t *testing.T) {
	clerk := mountedTally(identityWith(rbac.InvoicesRead))

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/tally/validate"},
		{http.MethodPost, "/tally/export"},
		{http.MethodGet, "/tally/runs/" + uuid.NewString() + "/file"},
		{http.MethodPost, "/tally/runs/" + uuid.NewString() + "/confirm"},
	} {
		if got := statusOf(t, clerk, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only invoices.read: got %d, want 403", tc.method, tc.path, got)
		}
	}

	// And the accountant who holds it gets past the guard. Anything but 403
	// means the request reached a handler, which is all that is asserted here.
	acct := mountedTally(identityWith(rbac.InvoicesRead, rbac.FinanceExport))
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/tally/validate"},
		{http.MethodPost, "/tally/export"},
	} {
		if got := statusOf(t, acct, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with finance.export was refused", tc.method, tc.path)
		}
	}
}

/*
The connector is the vendor's screen, and a school administrator is not the
vendor.

	institution_admin is granted every permission except platform.tenants.write
	and platform.plans.write (rbac.keysExcept). This test pins that the connector
	sits on the far side of exactly that line: the identity below holds the full
	finance set, which is more than any real school user would carry, and still
	reaches nothing.
*/
func TestTallyConnectorIsRefusedToAnInstitutionAdmin(t *testing.T) {
	admin := mountedTallyConnector(identityWith(
		rbac.InvoicesRead, rbac.FinanceExport, rbac.FeesWrite,
		rbac.SettingsWrite, rbac.IntegrationsWrite, rbac.InstitutionWrite,
	))

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/tally/connector"},
		{http.MethodPut, "/tally/connector"},
		{http.MethodGet, "/tally/connector/accounts"},
		{http.MethodPut, "/tally/connector/mappings"},
		{http.MethodPut, "/tally/connector/voucher-types"},
		{http.MethodPost, "/tally/connector/voucher-types/defaults"},
	} {
		if got := statusOf(t, admin, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s as an institution admin: got %d, want 403", tc.method, tc.path, got)
		}
	}

	vendor := mountedTallyConnector(identityWith(rbac.PlatformTenantsRW))
	if got := statusOf(t, vendor, http.MethodGet, "/tally/connector"); got == http.StatusForbidden {
		t.Error("the vendor key was refused the connector")
	}
}

/*
The gateway address is the one thing a school must never read.

	It describes the school's internal network and carries a sealed credential
	beside it. The table's RLS policy is app_is_platform_admin() with no tenant
	escape, so a leak needs both this middleware and that policy to fail — but
	the middleware is the half a future edit is most likely to drop, so it is
	the half pinned here.
*/
func TestTallyGatewayIsPlatformOnly(t *testing.T) {
	admin := mountedTallyConnector(identityWith(
		rbac.InvoicesRead, rbac.FinanceExport, rbac.SettingsWrite,
		rbac.IntegrationsWrite, rbac.InstitutionWrite, rbac.AuditRead,
	))
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		if got := statusOf(t, admin, method, "/tally/connector/gateway"); got != http.StatusForbidden {
			t.Errorf("%s /tally/connector/gateway as an institution admin: got %d, want 403", method, got)
		}
	}
}

/*
Every write is gated, enumerated from the routes chi actually registered.

	A list kept by hand goes stale the first time somebody adds an endpoint. This
	walks the real routers instead, so a new POST that forgot its permission
	fails here rather than in production.
*/
func TestEveryTallyWriteIsGated(t *testing.T) {
	for _, r := range []struct {
		name  string
		mux   http.Handler
		perms []string
	}{
		// The identity holds the group gate but no write key, so every write
		// must still refuse.
		{"export", mountedTally(identityWith(rbac.InvoicesRead)), nil},
		// The connector group has no gate of its own; an identity with nothing
		// must be refused everywhere, reads included.
		{"connector", mountedTallyConnector(identityWith()), nil},
	} {
		mux, ok := r.mux.(*chi.Mux)
		if !ok {
			t.Fatalf("%s: router is not a chi.Mux", r.name)
		}
		err := chi.Walk(mux, func(method, route string,
			_ http.Handler, _ ...func(http.Handler) http.Handler) error {
			if method == http.MethodGet || method == http.MethodHead {
				return nil
			}
			path := chiRouteToPath(route)
			if got := statusOf(t, r.mux, method, path); got != http.StatusForbidden {
				t.Errorf("%s: %s %s is not gated: got %d, want 403", r.name, method, path, got)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("%s: walk: %v", r.name, err)
		}
	}
}

// chiRouteToPath turns a registered pattern into something requestable by
// substituting a real uuid for each {param}.
func chiRouteToPath(route string) string {
	out := ""
	for _, seg := range splitPath(route) {
		if seg == "" {
			continue
		}
		if seg[0] == '{' {
			out += "/" + uuid.NewString()
			continue
		}
		out += "/" + seg
	}
	if out == "" {
		return "/"
	}
	return out
}

func splitPath(p string) []string {
	out := []string{}
	cur := ""
	for _, c := range p {
		if c == '/' {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(c)
	}
	return append(out, cur)
}
