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
Authorization for the three concessions screens, decided here rather than by a
hidden button.

	These drive the real router mountConcessions builds, inside a group carrying
	exactly the middleware api.go applies to /finance, so they test the wiring
	rather than a restatement of it.

	No database is needed: RequirePermission runs before the handler, so a
	refusal never reaches one. identityWith and statusOf already exist in this
	package (fee_engine_authz_test.go) and are reused rather than redeclared.

	The properties that matter most are the last two. A clerk who may read the
	fee module must not be able to tell the state what it sanctioned, and must
	not be able to pull a CSV naming every quota child and their social
	category. If either of those ever stops being true, it will stop quietly.
*/

// mountedConcessions builds the router as api.go does: inside the /finance
// group, which carries RequirePermission(InvoicesRead).
func mountedConcessions(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.InvoicesRead))
		s.mountConcessions(r)
	})
	return r
}

// Every route, so a new one added later without a rung is caught here rather
// than in production.
var concessionRoutes = []struct{ method, path string }{
	{http.MethodGet, "/concessions/schemes"},
	{http.MethodPost, "/concessions/schemes"},
	{http.MethodGet, "/concessions/rates"},
	{http.MethodPost, "/concessions/rates"},
	{http.MethodGet, "/concessions/claims"},
	{http.MethodGet, "/concessions/claims/ageing"},
	{http.MethodPost, "/concessions/claims"},
	{http.MethodGet, "/concessions/claims/" + uuid.NewString()},
	{http.MethodPost, "/concessions/claims/" + uuid.NewString() + "/build"},
	{http.MethodDelete, "/concessions/claims/" + uuid.NewString() + "/lines/" + uuid.NewString()},
	{http.MethodPost, "/concessions/claims/" + uuid.NewString() + "/receipts"},
	{http.MethodPost, "/concessions/claims/" + uuid.NewString() + "/submit"},
	{http.MethodPost, "/concessions/claims/" + uuid.NewString() + "/sanction"},
	{http.MethodGet, "/concessions/claims/" + uuid.NewString() + "/file"},
	{http.MethodGet, "/concessions/scholarships"},
	{http.MethodPost, "/concessions/scholarships"},
	{http.MethodPost, "/concessions/scholarships/" + uuid.NewString() + "/verify"},
	{http.MethodPost, "/concessions/scholarships/" + uuid.NewString() + "/fee-credit"},
	{http.MethodGet, "/concessions/scholarships/imports"},
	{http.MethodPost, "/concessions/scholarships/imports"},
	{http.MethodGet, "/concessions/scholarships/imports/" + uuid.NewString()},
	{http.MethodPost, "/concessions/scholarships/lines/" + uuid.NewString() + "/match"},
	{http.MethodGet, "/concessions/loans/lenders"},
	{http.MethodPost, "/concessions/loans/lenders"},
	{http.MethodGet, "/concessions/loans/applications"},
	{http.MethodPost, "/concessions/loans/applications"},
	{http.MethodGet, "/concessions/loans/applications/" + uuid.NewString()},
	{http.MethodPost, "/concessions/loans/applications/" + uuid.NewString() + "/status"},
	{http.MethodPost, "/concessions/loans/applications/" + uuid.NewString() + "/documents"},
}

// A signed-in user with no grant at all reaches nothing.
func TestConcessionsRefuseACallerWithNoPermissions(t *testing.T) {
	h := mountedConcessions(identityWith())
	for _, tc := range concessionRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s without any permission: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

// The group gate alone is not enough. Somebody who may look up an invoice has
// no business with a child's scholarship record or an RTE claim.
func TestConcessionsRefuseInvoicesReadAlone(t *testing.T) {
	h := mountedConcessions(identityWith(rbac.InvoicesRead))
	for _, tc := range concessionRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only invoices.read: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

// Reading is not writing. A caller with the read rung reaches every list and
// nothing that changes anything.
func TestConcessionsReadRungReachesReadsOnly(t *testing.T) {
	h := mountedConcessions(identityWith(rbac.InvoicesRead, rbac.FeesRead))

	for _, path := range []string{
		"/concessions/schemes", "/concessions/rates", "/concessions/claims",
		"/concessions/claims/ageing", "/concessions/scholarships",
		"/concessions/scholarships/imports", "/concessions/loans/lenders",
		"/concessions/loans/applications",
	} {
		if got := statusOf(t, h, http.MethodGet, path); got == http.StatusForbidden {
			t.Errorf("GET %s with fees.read: got 403, want the handler to be reached", path)
		}
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/concessions/schemes"},
		{http.MethodPost, "/concessions/claims"},
		{http.MethodPost, "/concessions/scholarships"},
		{http.MethodPost, "/concessions/loans/applications"},
		{http.MethodPost, "/concessions/claims/" + uuid.NewString() + "/receipts"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only fees.read: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Telling the state what it sanctioned is not a clerk's job.

	Submitting a claim and recording a sanction order are the two assertions the
	school will be audited on, so they sit on the Approve rung of the finance
	group (finance.refunds.write) rather than on the write rung a clerk holds
	for assembling the claim.
*/
func TestConcessionsSanctionNeedsTheApproveRung(t *testing.T) {
	clerk := mountedConcessions(identityWith(rbac.InvoicesRead, rbac.FeesRead, rbac.FeesWrite))
	claim := uuid.NewString()

	for _, path := range []string{
		"/concessions/claims/" + claim + "/submit",
		"/concessions/claims/" + claim + "/sanction",
	} {
		if got := statusOf(t, clerk, http.MethodPost, path); got != http.StatusForbidden {
			t.Errorf("POST %s as a clerk with fees.write: got %d, want 403", path, got)
		}
	}

	// The same clerk may still assemble the claim they are not allowed to send.
	for _, path := range []string{
		"/concessions/claims/" + claim + "/build",
		"/concessions/claims/" + claim + "/receipts",
	} {
		if got := statusOf(t, clerk, http.MethodPost, path); got == http.StatusForbidden {
			t.Errorf("POST %s as a clerk with fees.write: got 403, want reachable", path)
		}
	}

	approver := mountedConcessions(identityWith(rbac.InvoicesRead, rbac.RefundsWrite))
	for _, path := range []string{
		"/concessions/claims/" + claim + "/submit",
		"/concessions/claims/" + claim + "/sanction",
	} {
		if got := statusOf(t, approver, http.MethodPost, path); got == http.StatusForbidden {
			t.Errorf("POST %s with refunds.write: got 403, want reachable", path)
		}
	}
}

/*
The claim file is the most disclosive thing this feature produces.

	One CSV naming every 25% quota child, their class, their date of birth and
	their social category. Nothing below finance.export reaches it — not the
	clerk who assembled the claim, and not the officer who signed it off.

	This is the test that protects students.category. It is selected in exactly
	two places in internal/api/concessions.go: this export, and the scholarship
	list where an NSP application cannot be verified without it.
*/
func TestClaimFileNeedsFinanceExport(t *testing.T) {
	claim := uuid.NewString()
	path := "/concessions/claims/" + claim + "/file"

	for _, id := range []*httpx.Identity{
		identityWith(rbac.InvoicesRead),
		identityWith(rbac.InvoicesRead, rbac.FeesRead),
		identityWith(rbac.InvoicesRead, rbac.FeesRead, rbac.FeesWrite),
		identityWith(rbac.InvoicesRead, rbac.FeesRead, rbac.FeesWrite, rbac.RefundsWrite),
	} {
		if got := statusOf(t, mountedConcessions(id), http.MethodGet, path); got != http.StatusForbidden {
			t.Errorf("GET the claim file without finance.export: got %d, want 403", got)
		}
	}

	h := mountedConcessions(identityWith(rbac.InvoicesRead, rbac.FinanceExport))
	if got := statusOf(t, h, http.MethodGet, path); got == http.StatusForbidden {
		t.Error("GET the claim file with finance.export: got 403, want reachable")
	}
}

// --- pure logic, no router ---------------------------------------------------

// A quarter of a notified annual rate is a quarter, rounded rather than
// truncated. Truncation loses a paisa per child per quarter, and a claim four
// paise under the clerk's own calculator total is a claim the department
// queries.
func TestProrataPaiseRoundsRatherThanTruncates(t *testing.T) {
	for _, tc := range []struct {
		annual int64
		months int
		want   int64
	}{
		{annual: 1200000, months: 12, want: 1200000},
		{annual: 1200000, months: 3, want: 300000},
		{annual: 1200000, months: 0, want: 0},
		// 1,00,001 paise over one month is 8333.4166…; rounds down.
		{annual: 100001, months: 1, want: 8333},
		// 100 paise over one month is 8.33; rounds down to 8.
		{annual: 100, months: 1, want: 8},
		// 110 paise over one month is 9.166…; rounds down to 9.
		{annual: 110, months: 1, want: 9},
		// 6 paise over one month is 0.5 exactly; rounds up, not away.
		{annual: 6, months: 1, want: 1},
		// More months than a year cannot claim more than the year.
		{annual: 500000, months: 15, want: 500000},
	} {
		if got := prorataPaise(tc.annual, tc.months); got != tc.want {
			t.Errorf("prorataPaise(%d, %d) = %d, want %d",
				tc.annual, tc.months, got, tc.want)
		}
	}
}

// The bucket boundaries are the ones a school talks in, and the oldest bucket
// is open-ended on purpose.
func TestAgeBucketBoundaries(t *testing.T) {
	for _, tc := range []struct {
		days int
		want string
	}{
		{0, "0-90"}, {90, "0-90"}, {91, "91-180"}, {180, "91-180"},
		{181, "181-365"}, {365, "181-365"}, {366, "365+"}, {900, "365+"},
	} {
		if got := ageBucket(tc.days); got != tc.want {
			t.Errorf("ageBucket(%d) = %q, want %q", tc.days, got, tc.want)
		}
	}
}

// The scheme's direction of debt is derived from its kind, never taken from the
// caller. A mis-ticked box would put an NSP scheme on the claims screen and
// have the school raise a claim against a department that owes it nothing.
func TestPaidToIsDerivedFromKind(t *testing.T) {
	for kind, want := range map[string]string{
		"rte_reimbursement": "school",
		"fee_reimbursement": "school",
		"nsp_scholarship":   "student",
		"state_scholarship": "student",
	} {
		got, ok := paidToForKind(kind)
		if !ok || got != want {
			t.Errorf("paidToForKind(%q) = %q, %v; want %q, true", kind, got, ok, want)
		}
	}
	if _, ok := paidToForKind("something_else"); ok {
		t.Error("paidToForKind accepted a kind the schema's CHECK would refuse")
	}
}

/*
The exception is what the reconciliation screen is for, so the order it reports
them in is load-bearing.

	A sanctioned scholarship that never arrived outranks a missing bank account,
	because one is money owed to a child and the other is paperwork.
*/
func TestAwardExceptionNamesTheWorstProblemFirst(t *testing.T) {
	sanctioned := int64(500000)

	cases := []struct {
		name string
		in   scholarshipAwardView
		want string
	}{{
		name: "sanctioned but nothing credited",
		in: scholarshipAwardView{Stage: "sanctioned", StudentStatus: "active",
			SanctionedPaise: &sanctioned},
		want: "sanctioned_not_credited",
	}, {
		name: "credited to a child who has left",
		in: scholarshipAwardView{Stage: "credited", StudentStatus: "withdrawn",
			SanctionedPaise: &sanctioned, CreditedPaise: sanctioned},
		want: "student_left",
	}, {
		name: "portal paid something other than the sanction",
		in: scholarshipAwardView{Stage: "credited", StudentStatus: "active",
			SanctionedPaise: &sanctioned, CreditedPaise: 400000},
		want: "amount_differs",
	}, {
		name: "verified with nowhere for the money to land",
		in: scholarshipAwardView{Stage: "school_verified", StudentStatus: "active",
			HasAccount: false},
		want: "no_bank_account",
	}, {
		name: "verified, account on file, not seeded",
		in: scholarshipAwardView{Stage: "school_verified", StudentStatus: "active",
			HasAccount: true, AadhaarSeeded: false},
		want: "not_aadhaar_seeded",
	}, {
		name: "credited exactly as sanctioned, child on roll",
		in: scholarshipAwardView{Stage: "credited", StudentStatus: "active",
			SanctionedPaise: &sanctioned, CreditedPaise: sanctioned},
		want: "",
	}}

	for _, tc := range cases {
		if got := awardException(tc.in); got != tc.want {
			t.Errorf("%s: awardException = %q, want %q", tc.name, got, tc.want)
		}
	}
}

/*
The loan tracker's ladder only goes forward, with one deliberate way back.

	A family told "under review" after being told "declined" has been told
	nothing, so the tracker refuses it. Reopening a declined application as
	documents_pending is allowed, because families genuinely do try again with
	more paperwork.
*/
func TestLoanStatusLadderOnlyGoesForward(t *testing.T) {
	allows := func(from, to string) bool {
		for _, a := range loanTransitions[from] {
			if a == to {
				return true
			}
		}
		return false
	}

	for _, tc := range []struct {
		from, to string
		want     bool
	}{
		{"documents_pending", "submitted_to_lender", true},
		{"submitted_to_lender", "sanctioned", true},
		{"sanctioned", "disbursed", true},
		{"declined", "documents_pending", true},
		{"withdrawn", "documents_pending", true},

		{"declined", "under_review", false},
		{"disbursed", "sanctioned", false},
		{"disbursed", "documents_pending", false},
		{"sanctioned", "declined", false},
		{"documents_pending", "sanctioned", false},
		{"under_review", "submitted_to_lender", false},
	} {
		if got := allows(tc.from, tc.to); got != tc.want {
			t.Errorf("%s -> %s: allowed = %v, want %v", tc.from, tc.to, got, tc.want)
		}
	}

	// Disbursed is terminal. Nothing follows money actually reaching the family.
	if len(loanTransitions["disbursed"]) != 0 {
		t.Error("disbursed should be terminal")
	}
}

/*
The portal's column names are whatever that portal calls them.

	NSP, the state portals and the bank files a department forwards all differ,
	and every one of them has been through somebody's Excel. A header is only
	accepted once it carries an amount and some way to name a child; anything
	above that is the preamble portals put over the table.
*/
func TestDisbursementHeaderNeedsAnAmountAndAnIdentifier(t *testing.T) {
	if _, ok := mapDisbursementHeader([]string{
		"Sr No", "Application ID", "Student Name", "Amount Disbursed", "UTR",
	}); !ok {
		t.Error("a header with an application id and an amount was not recognised")
	}
	if cols, ok := mapDisbursementHeader([]string{
		"Admission No", "Name of Student", "Amount (INR)", "Date of Credit",
	}); !ok {
		t.Error("a header keyed by admission number was not recognised")
	} else if cols["credited_on"] != 3 {
		t.Errorf("credited_on mapped to column %d, want 3", cols["credited_on"])
	}

	// Preamble, and a table that names money without naming anybody.
	for _, rec := range [][]string{
		{"Government of Telangana"},
		{"Student Name", "Class", "Remarks"},
		{"Amount", "UTR"},
	} {
		if _, ok := mapDisbursementHeader(rec); ok {
			t.Errorf("%v was accepted as a header row", rec)
		}
	}
}

// cellAt must never panic on a short row. Portal exports have ragged rows, and
// a nil-safe read is the difference between a reject line and a 500.
func TestCellAtToleratesRaggedRows(t *testing.T) {
	cols := map[string]int{"amount": 3, "student_name": 1}
	rec := []string{"1", " Asha "}
	if got := cellAt(rec, cols, "amount"); got != "" {
		t.Errorf("amount off the end of the row = %q, want empty", got)
	}
	if got := cellAt(rec, cols, "student_name"); got != "Asha" {
		t.Errorf("student_name = %q, want %q", got, "Asha")
	}
	if got := cellAt(rec, cols, "not_a_field"); got != "" {
		t.Errorf("unknown field = %q, want empty", got)
	}
}
