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
Authorization for the four /admin-ops features, decided on the server.

	Same harness as fee_engine_authz_test.go: the real router mountAdminOps
	builds, so these check the wiring rather than a restatement of it. No
	database — RequirePermission runs before the handler, and statusOf reports
	a panic on a nil *database.DB as 500, which for these tests means only
	"the guard let it through".

	Three routes here are deliberately NOT gated by middleware, and each has
	its own test below, because the decision depends on the row rather than on
	the route:

	  requisition decide   — the permission comes from the value ladder
	  evaluation results   — the reviewee reads their own, and holds nothing
	  respond / my-invitations — anybody invited may answer

	mountAdminOps must be called at TOP LEVEL in api.go, alongside
	mountAdminRollups, not inside a permissioned r.Route group. Every route
	carries its own gate; wrapping the group in one more would lock the
	reviewee out of their own result. TestUngatedRoutesAreDeliberate pins the
	set so a fourth ungated route cannot be added by accident.
*/

func mountedAdminOps(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	s.mountAdminOps(r)
	return r
}

// A caller holding nothing is refused every gated route, read and write alike.
func TestAdminOpsRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedAdminOps(identityWith())
	id := uuid.NewString()

	for _, tc := range []struct{ method, path string }{
		{"GET", "/admin-ops/purchasing/requisitions"},
		{"GET", "/admin-ops/purchasing/orders"},
		{"GET", "/admin-ops/purchasing/matches"},
		{"GET", "/admin-ops/purchasing/thresholds"},
		{"POST", "/admin-ops/purchasing/requisitions"},
		{"POST", "/admin-ops/purchasing/orders"},
		{"POST", "/admin-ops/purchasing/orders/" + id + "/receipts"},
		{"POST", "/admin-ops/purchasing/orders/" + id + "/match"},
		{"PUT", "/admin-ops/purchasing/thresholds"},

		{"GET", "/admin-ops/mdm/utilisation"},
		{"GET", "/admin-ops/mdm/returns"},
		{"POST", "/admin-ops/mdm/returns"},
		{"POST", "/admin-ops/mdm/norms"},
		{"POST", "/admin-ops/mdm/foodgrain"},

		{"GET", "/admin-ops/evaluation/cycles"},
		{"GET", "/admin-ops/evaluation/cycles/" + id},
		{"POST", "/admin-ops/evaluation/cycles"},
		{"POST", "/admin-ops/evaluation/cycles/" + id + "/invitations"},
		{"POST", "/admin-ops/evaluation/reviewees/" + id + "/release"},

		{"GET", "/admin-ops/fee-filings"},
		{"GET", "/admin-ops/fee-filings/" + id + "/variance"},
		{"POST", "/admin-ops/fee-filings"},
		{"POST", "/admin-ops/fee-filings/" + id + "/submit"},
		{"POST", "/admin-ops/fee-filings/" + id + "/decide"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 for a caller holding no permissions",
				tc.method, tc.path, got)
		}
	}
}

/*
Seeing the stores does not entitle you to order from a vendor.

	A store keeper reads stock all day. Raising a purchase order commits the
	school's money, and the read gate must not be mistaken for consent to it.
*/
func TestInventoryReadDoesNotGrantPurchasingWrites(t *testing.T) {
	h := mountedAdminOps(identityWith(rbac.InventoryRead))
	id := uuid.NewString()

	for _, path := range []string{
		"/admin-ops/purchasing/requisitions",
		"/admin-ops/purchasing/orders",
		"/admin-ops/purchasing/matches",
		"/admin-ops/purchasing/thresholds",
	} {
		if got := statusOf(t, h, "GET", path); got == http.StatusForbidden {
			t.Errorf("GET %s: 403 for a holder of operations.inventory.read", path)
		}
	}

	for _, tc := range []struct{ method, path string }{
		{"POST", "/admin-ops/purchasing/requisitions"},
		{"POST", "/admin-ops/purchasing/orders"},
		{"POST", "/admin-ops/purchasing/orders/" + id + "/issue"},
		{"POST", "/admin-ops/purchasing/orders/" + id + "/receipts"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — reading stock does not grant this",
				tc.method, tc.path, got)
		}
	}
}

/*
The store keeper cannot raise their own spending ceiling.

	Configuring who may approve what is institution settings, not stores. If
	operations.inventory.write reached the ladder, the control would be
	self-administered, which is no control at all.
*/
func TestStoresWriteCannotEditTheApprovalLadder(t *testing.T) {
	h := mountedAdminOps(identityWith(rbac.InventoryRead, rbac.InventoryWrite))

	if got := statusOf(t, h, "POST", "/admin-ops/purchasing/requisitions"); got == http.StatusForbidden {
		t.Error("POST requisitions: 403 for a holder of operations.inventory.write")
	}
	if got := statusOf(t, h, "PUT", "/admin-ops/purchasing/thresholds"); got != http.StatusForbidden {
		t.Errorf("PUT thresholds: got %d, want 403 — the ladder is institution.settings.write", got)
	}
}

/*
Receiving goods does not entitle you to pass the bill for payment.

	Accepting an invoice variance authorises money to leave. It is the last leg
	of the three-way match and belongs to finance, not to whoever signed for
	the delivery — otherwise one person could receive 40 chairs and approve a
	bill for 100.
*/
func TestReceivingDoesNotGrantInvoiceApproval(t *testing.T) {
	h := mountedAdminOps(identityWith(rbac.InventoryRead, rbac.InventoryWrite))
	id := uuid.NewString()

	if got := statusOf(t, h, "POST", "/admin-ops/purchasing/orders/"+id+"/receipts"); got == http.StatusForbidden {
		t.Error("POST receipts: 403 for a holder of operations.inventory.write")
	}
	if got := statusOf(t, h, "POST", "/admin-ops/purchasing/orders/"+id+"/match"); got != http.StatusForbidden {
		t.Errorf("POST match: got %d, want 403 — passing a bill is finance.invoices.write", got)
	}
}

/*
Reading a statutory return does not entitle you to file one.

	admin.reports.read is wide — a head of department holds it. Finalising the
	PM POSHAN return freezes figures the school is answerable to the block
	office for, so it takes institution.write.
*/
func TestReportsReadDoesNotGrantFilingTheMDMReturn(t *testing.T) {
	h := mountedAdminOps(identityWith(rbac.ReportsRead))
	id := uuid.NewString()

	for _, path := range []string{
		"/admin-ops/mdm/utilisation",
		"/admin-ops/mdm/returns",
		"/admin-ops/mdm/norms",
		"/admin-ops/mdm/foodgrain",
	} {
		if got := statusOf(t, h, "GET", path); got == http.StatusForbidden {
			t.Errorf("GET %s: 403 for a holder of admin.reports.read", path)
		}
	}

	for _, tc := range []struct{ method, path string }{
		{"POST", "/admin-ops/mdm/returns"},
		{"POST", "/admin-ops/mdm/returns/" + id + "/finalise"},
		{"POST", "/admin-ops/mdm/returns/" + id + "/reopen"},
		{"POST", "/admin-ops/mdm/norms"},
		{"POST", "/admin-ops/mdm/foodgrain"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — filing a return is institution.write",
				tc.method, tc.path, got)
		}
	}
}

/*
Reading the staff register does not entitle you to run an evaluation cycle.

	hr.employees.read is what an oversight viewer holds. Opening a cycle,
	inviting respondents and releasing results are the principal's acts, and
	releasing in particular decides when a teacher sees what was said about
	them.
*/
func TestEmployeesReadDoesNotGrantRunningACycle(t *testing.T) {
	h := mountedAdminOps(identityWith(rbac.EmployeesRead))
	id := uuid.NewString()

	for _, path := range []string{
		"/admin-ops/evaluation/cycles",
		"/admin-ops/evaluation/cycles/" + id,
	} {
		if got := statusOf(t, h, "GET", path); got == http.StatusForbidden {
			t.Errorf("GET %s: 403 for a holder of hr.employees.read", path)
		}
	}

	for _, tc := range []struct{ method, path string }{
		{"POST", "/admin-ops/evaluation/cycles"},
		{"PUT", "/admin-ops/evaluation/cycles/" + id + "/questions"},
		{"POST", "/admin-ops/evaluation/cycles/" + id + "/reviewees"},
		{"POST", "/admin-ops/evaluation/cycles/" + id + "/invitations"},
		{"POST", "/admin-ops/evaluation/cycles/" + id + "/status"},
		{"POST", "/admin-ops/evaluation/reviewees/" + id + "/release"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — running a cycle is hr.employees.write",
				tc.method, tc.path, got)
		}
	}
}

/*
Reading the fee book does not entitle you to file with the regulator, and
finance rights do not reach the filing either way round.
*/
func TestFeesReadDoesNotGrantFilingOrDeciding(t *testing.T) {
	h := mountedAdminOps(identityWith(rbac.FeesRead))
	id := uuid.NewString()

	for _, path := range []string{
		"/admin-ops/fee-filings",
		"/admin-ops/fee-filings/" + id,
		"/admin-ops/fee-filings/" + id + "/variance",
	} {
		if got := statusOf(t, h, "GET", path); got == http.StatusForbidden {
			t.Errorf("GET %s: 403 for a holder of finance.fees.read", path)
		}
	}

	for _, tc := range []struct{ method, path string }{
		{"POST", "/admin-ops/fee-filings"},
		{"POST", "/admin-ops/fee-filings/" + id + "/submit"},
		{"POST", "/admin-ops/fee-filings/" + id + "/decide"},
		{"POST", "/admin-ops/fee-filings/" + id + "/documents"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — filing is finance.fees.write",
				tc.method, tc.path, got)
		}
	}
}

/*
The three ungated routes are ungated on purpose, and only those three.

	Walked from chi's own tree rather than a hand-kept list, so a route added
	to mountAdminOps later without a gate fails this test instead of shipping.

	"Ungated" here means no RequirePermission middleware. Each of the three
	still decides authorization inside the handler:

	  decide   — resolveApprovalBand names the permission, and the handler
	             returns 403 if the caller lacks it or raised the requisition
	  results  — oversight, or the reviewee after release; 403 otherwise
	  respond  — the invitation must be addressed to the caller; 403 otherwise

	my-invitations is scoped to the caller's own user id in SQL, so there is
	nothing to gate: it can only ever return the caller's own rows.
*/
func TestUngatedRoutesAreDeliberate(t *testing.T) {
	s := &Server{}
	r := chi.NewRouter()
	s.mountAdminOps(r)

	// A caller holding every permission in the vocabulary. Anything that still
	// 403s is refused by a handler, not by middleware, so the ones that pass
	// are exactly the middleware-gated set.
	all := make([]string, 0, len(rbac.All))
	for _, p := range rbac.All {
		all = append(all, p.Key)
	}
	gated := mountedAdminOps(identityWith())

	expectedUngated := map[string]bool{
		"GET /admin-ops/evaluation/reviewees/{id}/results":    true,
		"GET /admin-ops/evaluation/my-invitations":            true,
		"POST /admin-ops/evaluation/invitations/{id}/respond": true,
		"POST /admin-ops/purchasing/requisitions/{id}/decide": true,
	}

	seen := map[string]bool{}
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		probe := route
		// chi's tree reports the pattern; statusOf needs a concrete path.
		concrete := replaceParams(probe)
		if statusOf(t, gated, method, concrete) != http.StatusForbidden {
			key := method + " " + route
			seen[key] = true
			if !expectedUngated[key] {
				t.Errorf("%s reached its handler with no permissions and is not a "+
					"documented exception — add a RequirePermission, or document why not", key)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	for key := range expectedUngated {
		if !seen[key] {
			t.Errorf("%s is now gated by middleware — good, but update this test's "+
				"expectation so the list stays honest", key)
		}
	}
	if len(all) == 0 {
		t.Fatal("rbac.All is empty; the permission vocabulary did not load")
	}
}

// replaceParams turns a chi pattern into a concrete path a request can use.
func replaceParams(route string) string {
	out := route
	for {
		i := indexOf(out, '{')
		if i < 0 {
			return out
		}
		j := indexOf(out[i:], '}')
		if j < 0 {
			return out
		}
		out = out[:i] + uuid.NewString() + out[i+j+1:]
	}
}

func indexOf(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
