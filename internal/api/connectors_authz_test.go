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
Authorization for the two platform connectors, decided here rather than by a
hidden button.

	These drive the real router mountConnectors builds, inside a group carrying
	exactly the middleware api.go applies to /admin — which is none, so every
	route must bring its own. No database is needed: RequirePermission runs
	before the handler, so a refusal never reaches one.

	identityWith, statusOf and chiRouteToPath already exist in this package
	(fee_engine_authz_test.go, tally_authz_test.go) and are reused rather than
	redeclared; a second copy would compile until somebody changed one of them.

	The property that matters most is the credential test. A CRM API key can
	read and write every lead in a school's marketing pipeline, and a meeting
	provider secret can create meetings in the installation's own Zoom account.
	Both are the vendor's to hold. If that ever stops being true it will stop
	quietly, so it is pinned.
*/

// mountedConnectors builds the connectors as api.go does: inside /admin, which
// carries no group-level permission at all.
func mountedConnectors(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) {
		s.mountConnectors(r)
	})
	return r
}

/*
A school administrator is not the vendor.

	institution_admin is granted every permission except platform.tenants.write
	and platform.plans.write (rbac.keysExcept). The identity below holds far more
	than any real school user would carry — the whole admissions set, settings,
	integrations — and still reaches nothing, because the line these connectors
	sit behind is exactly that one.
*/
func TestConnectorsAreRefusedToAnInstitutionAdmin(t *testing.T) {
	admin := mountedConnectors(identityWith(
		rbac.AdmissionsRead, rbac.AdmissionsWrite, rbac.SettingsWrite,
		rbac.IntegrationsWrite, rbac.InstitutionWrite, rbac.AuditRead,
	))

	run := uuid.NewString()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/connectors/crm"},
		{http.MethodPut, "/connectors/crm"},
		{http.MethodPut, "/connectors/crm/mappings"},
		{http.MethodGet, "/connectors/crm/queue"},
		{http.MethodPost, "/connectors/crm/export"},
		{http.MethodPost, "/connectors/crm/import"},
		{http.MethodGet, "/connectors/crm/runs"},
		{http.MethodGet, "/connectors/crm/runs/" + run + "/file"},
		{http.MethodGet, "/connectors/crm/runs/" + run + "/items"},
		{http.MethodGet, "/connectors/crm/conflicts"},
		{http.MethodPost, "/connectors/crm/conflicts/" + uuid.NewString() + "/resolve"},
		{http.MethodGet, "/connectors/meetings"},
		{http.MethodPut, "/connectors/meetings/providers"},
		{http.MethodDelete, "/connectors/meetings/providers/" + uuid.NewString()},
		{http.MethodGet, "/connectors/meetings/requests"},
		{http.MethodPost, "/connectors/meetings/sessions/" + uuid.NewString() + "/meeting"},
	} {
		if got := statusOf(t, admin, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s as an institution admin: got %d, want 403", tc.method, tc.path, got)
		}
	}

	// And the vendor key gets past the guard. Anything but 403 means the
	// request reached a handler, which is all that is asserted here.
	vendor := mountedConnectors(identityWith(rbac.PlatformTenantsRW))
	if got := statusOf(t, vendor, http.MethodGet, "/connectors/crm"); got == http.StatusForbidden {
		t.Error("the vendor key was refused the CRM connector")
	}
}

/*
The credentials are the one thing a school must never read.

	crm_api_credentials and virtual_meeting_platform_providers both carry an RLS
	policy of app_is_platform_admin() with no tenant limb, so a leak needs both
	that policy and this middleware to fail. The middleware is the half a future
	edit is most likely to drop, so it is the half pinned here.
*/
func TestConnectorCredentialsArePlatformOnly(t *testing.T) {
	admin := mountedConnectors(identityWith(
		rbac.AdmissionsRead, rbac.AdmissionsWrite, rbac.SettingsWrite,
		rbac.IntegrationsWrite, rbac.InstitutionWrite, rbac.AuditRead,
		rbac.UsersWrite, rbac.RolesWrite,
	))
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/connectors/crm/credentials"},
		{http.MethodPut, "/connectors/crm/credentials"},
		{http.MethodGet, "/connectors/meetings"},
		{http.MethodPut, "/connectors/meetings/providers"},
	} {
		if got := statusOf(t, admin, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s as an institution admin: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Every write is gated, enumerated from the routes chi actually registered.

	A list kept by hand goes stale the first time somebody adds an endpoint.
	This walks the real router, so a new POST that forgot its permission fails
	here rather than in production.
*/
func TestEveryConnectorWriteIsGated(t *testing.T) {
	// An identity with nothing at all must be refused everywhere, reads
	// included: the /admin group has no gate of its own.
	h := mountedConnectors(identityWith())
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
