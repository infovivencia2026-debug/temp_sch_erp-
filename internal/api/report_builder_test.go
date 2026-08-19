package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The report builder's safety properties, pinned.

	Three things must stay true, and none of them is visible by reading a
	handler:

	  1. Nothing a client sends reaches the SQL text. The builder is given
	     keys and picks expressions written in Go; a key it does not know is
	     refused rather than interpolated.
	  2. Every generated query carries the scope predicate. A report that
	     forgot it would return the whole school to a head of department and
	     look entirely correct while doing so.
	  3. The screens are behind admin.reports.read.

	identityWith and statusOf come from fee_engine_authz_test.go and
	chiRouteToPath from tally_authz_test.go; reused rather than redeclared,
	because a second copy compiles right up until somebody changes one of them.
*/

func mountedReportBuilder(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	// api.go mounts this at the authenticated router, which carries no
	// group-level permission, so every route must bring its own.
	r.Group(func(r chi.Router) { s.mountReportBuilder(r) })
	return r
}

// Nobody reaches any of it without admin.reports.read — reads included, since
// the schema endpoint describes what the school holds.
func TestReportBuilderNeedsReportsRead(t *testing.T) {
	h := mountedReportBuilder(identityWith())
	id := uuid.NewString()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/report-builder/schema"},
		{http.MethodGet, "/report-builder/definitions"},
		{http.MethodPost, "/report-builder/definitions"},
		{http.MethodGet, "/report-builder/definitions/" + id},
		{http.MethodDelete, "/report-builder/definitions/" + id},
		{http.MethodGet, "/report-builder/definitions/" + id + "/run"},
		{http.MethodPost, "/report-builder/definitions/" + id + "/shares"},
		{http.MethodPost, "/report-builder/preview"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s without reports.read: got %d, want 403", tc.method, tc.path, got)
		}
	}
	// And a holder gets past the guard. Anything but 403 means the request
	// reached a handler, which is all that is asserted here.
	ok := mountedReportBuilder(identityWith(rbac.ReportsRead))
	if got := statusOf(t, ok, http.MethodGet, "/report-builder/schema"); got == http.StatusForbidden {
		t.Error("a holder of reports.read was refused the schema")
	}
}

// Enumerated from the routes chi actually registered, so a new endpoint that
// forgot its permission fails here rather than in production.
func TestEveryReportBuilderRouteIsGated(t *testing.T) {
	h := mountedReportBuilder(identityWith())
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
A definition may only name things the whitelist carries.

	This is the property that keeps the builder from being an SQL console. Each
	case below is a shape a client could post; every one must be refused before
	any SQL is built.
*/
func TestReportDefinitionRefusesAnythingOffTheWhitelist(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  reportDefinitionRequest
	}{
		{"unknown subject", reportDefinitionRequest{
			Name: "x", Subject: "pg_shadow", Columns: []string{"full_name"}}},
		{"a table name as a subject", reportDefinitionRequest{
			Name: "x", Subject: "users", Columns: []string{"full_name"}}},
		{"unknown column", reportDefinitionRequest{
			Name: "x", Subject: "students", Columns: []string{"aadhaar_last4"}}},
		{"SQL as a column", reportDefinitionRequest{
			Name: "x", Subject: "students",
			Columns: []string{"full_name, (SELECT password_hash FROM users LIMIT 1)"}}},
		{"no columns", reportDefinitionRequest{
			Name: "x", Subject: "students", Columns: []string{}}},
		{"unknown filter field", reportDefinitionRequest{
			Name: "x", Subject: "students", Columns: []string{"full_name"},
			Filters: []reportFilterClause{{Field: "bank_account", Op: "eq", Value: "1"}}}},
		{"operator the field does not admit", reportDefinitionRequest{
			Name: "x", Subject: "students", Columns: []string{"full_name"},
			Filters: []reportFilterClause{{Field: "class_id", Op: "contains", Value: "x"}}}},
		{"a measure without grouping", reportDefinitionRequest{
			Name: "x", Subject: "students", Columns: []string{"student_count"}}},
		{"an ungrouped dimension beside a measure", reportDefinitionRequest{
			Name: "x", Subject: "students", Columns: []string{"full_name", "student_count"},
			GroupBy: []string{"class"}}},
		{"grouping by something not shown", reportDefinitionRequest{
			Name: "x", Subject: "students", Columns: []string{"student_count"},
			GroupBy: []string{"class"}}},
		{"sorting by a column not shown", reportDefinitionRequest{
			Name: "x", Subject: "students", Columns: []string{"full_name"},
			SortColumn: "date_of_birth"}},
		{"a row cap past the ceiling", reportDefinitionRequest{
			Name: "x", Subject: "students", Columns: []string{"full_name"},
			RowLimit: reportMaxLimit + 1}},
		{"no name", reportDefinitionRequest{
			Subject: "students", Columns: []string{"full_name"}}},
	} {
		req := tc.req
		if _, err := validateReportDefinition(&req); err == nil {
			t.Errorf("%s: accepted, want a refusal", tc.name)
		}
	}
}

// The legal shapes stay legal, or the feature is a wall of error messages.
func TestReportDefinitionAcceptsWhatItShould(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  reportDefinitionRequest
	}{
		{"a plain list", reportDefinitionRequest{
			Name: "Roll", Subject: "students",
			Columns:    []string{"admission_no", "full_name", "class", "section"},
			Filters:    []reportFilterClause{{Field: "status", Op: "eq", Value: "active"}},
			SortColumn: "full_name"}},
		{"a grouped count", reportDefinitionRequest{
			Name: "Strength", Subject: "students",
			Columns: []string{"class", "student_count"}, GroupBy: []string{"class"}}},
		{"a money report", reportDefinitionRequest{
			Name: "Dues", Subject: "fees",
			Columns: []string{"class", "outstanding_paise"}, GroupBy: []string{"class"},
			Filters: []reportFilterClause{{Field: "balance_paise", Op: "gt", Value: "0"}}}},
		{"a date range", reportDefinitionRequest{
			Name: "Absences", Subject: "attendance",
			Columns: []string{"on_date", "full_name", "status"},
			Filters: []reportFilterClause{
				{Field: "on_date", Op: "between", Value: "2026-04-01", Value2: "2026-06-30"},
				{Field: "status", Op: "in", Values: []string{"absent", "late"}}}}},
		{"staff by department", reportDefinitionRequest{
			Name: "Staff", Subject: "staff",
			Columns: []string{"department", "staff_count"}, GroupBy: []string{"department"}}},
	} {
		req := tc.req
		if _, err := validateReportDefinition(&req); err != nil {
			t.Errorf("%s: refused: %v", tc.name, err)
		}
	}
}

/*
Every generated query carries the caller's boundary, and no value of theirs.

	The scope predicate is asserted by shape rather than by string equality so
	it survives a rename; what must not survive is its absence. The second half
	is the one that matters more: a filter value known to be SQL must appear
	only in the args, never in the text.
*/
func TestGeneratedSQLIsScopedAndParameterised(t *testing.T) {
	nasty := "x'; DROP TABLE students; --"
	for _, subj := range reportSubjects {
		req := reportDefinitionRequest{
			Name: "t", Subject: subj.Key,
			Columns: []string{subj.Dimensions[0].Key},
		}
		// Attach a text filter carrying an injection attempt wherever the
		// subject has one to attach it to.
		for _, f := range subj.Fields {
			if f.Kind == "text" {
				req.Filters = []reportFilterClause{{Field: f.Key, Op: "contains", Value: nasty}}
				break
			}
		}
		if _, err := validateReportDefinition(&req); err != nil {
			t.Fatalf("%s: %v", subj.Key, err)
		}
		depts := []uuid.UUID{uuid.New()}
		sqlText, countText, args, _, err := buildReportSQL(subj, &req, depts, 50, 0)
		if err != nil {
			t.Fatalf("%s: %v", subj.Key, err)
		}
		if !strings.Contains(sqlText, subj.ScopeExpr) {
			t.Errorf("%s: generated SQL does not restrict %s", subj.Key, subj.ScopeExpr)
		}
		if !strings.Contains(countText, subj.ScopeExpr) {
			t.Errorf("%s: the count is not scoped, so the total would lie", subj.Key)
		}
		if strings.Contains(sqlText, nasty) || strings.Contains(sqlText, "DROP TABLE") {
			t.Errorf("%s: a filter value reached the SQL text:\n%s", subj.Key, sqlText)
		}
		if len(req.Filters) > 0 {
			found := false
			for _, a := range args {
				if s, ok := a.(string); ok && s == nasty {
					found = true
				}
			}
			if !found {
				t.Errorf("%s: the filter value was not bound as a parameter", subj.Key)
			}
		}
		// The scope array is always argument one, whatever else follows.
		if len(args) == 0 {
			t.Fatalf("%s: no arguments at all", subj.Key)
		}
		if ids, ok := args[0].([]uuid.UUID); !ok || len(ids) != 1 || ids[0] != depts[0] {
			t.Errorf("%s: the first argument is not the caller's boundary: %#v", subj.Key, args[0])
		}
	}
}

/*
An empty boundary is empty, and no boundary is unrestricted.

	These are the two ends of the same parameter and they must not be confused:
	a NULL array means "see everything", a zero-length array means "see
	nothing". A teacher timetabled for no section falls in the second case, and
	getting it backwards hands them the school.
*/
func TestScopeDistinguishesUnrestrictedFromEmpty(t *testing.T) {
	subj, _ := lookupReportSubject("students")
	req := reportDefinitionRequest{
		Name: "t", Subject: "students", Columns: []string{"full_name"}}
	if _, err := validateReportDefinition(&req); err != nil {
		t.Fatal(err)
	}

	_, _, args, _, err := buildReportSQL(subj, &req, nil, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if args[0] != nil {
		t.Errorf("an unrestricted caller must bind NULL, got %#v", args[0])
	}

	_, _, args, _, err = buildReportSQL(subj, &req, []uuid.UUID{}, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	ids, ok := args[0].([]uuid.UUID)
	if !ok || ids == nil || len(ids) != 0 {
		t.Errorf("an empty boundary must bind an empty array, not NULL: %#v", args[0])
	}
}

// The saved cap is a ceiling a query string cannot lift.
func TestSavedRowLimitCapsThePage(t *testing.T) {
	subj, _ := lookupReportSubject("students")
	req := reportDefinitionRequest{
		Name: "t", Subject: "students", Columns: []string{"full_name"}, RowLimit: 25}
	if _, err := validateReportDefinition(&req); err != nil {
		t.Fatal(err)
	}
	_, _, args, _, err := buildReportSQL(subj, &req, nil, 10000, 0)
	if err != nil {
		t.Fatal(err)
	}
	limit, ok := args[len(args)-2].(int)
	if !ok || limit > 25 {
		t.Errorf("a page of 10000 was not trimmed to the saved cap of 25: %#v", args[len(args)-2])
	}
}

/*
No subject may exist without a scope.

	The cheapest possible guard against the commonest possible mistake: adding
	a fifth subject and forgetting the two fields that bound it. A nil Scope
	would panic at run time on a request; here it fails at build time.
*/
func TestEveryReportSubjectDeclaresAScope(t *testing.T) {
	for _, s := range reportSubjects {
		if s.ScopeExpr == "" || s.Scope == nil {
			t.Errorf("subject %q has no scope — it would return the whole school", s.Key)
		}
		if len(s.Dimensions) == 0 {
			t.Errorf("subject %q has no columns", s.Key)
		}
		for _, d := range s.Dimensions {
			if d.Expr == "" {
				t.Errorf("subject %q: column %q has no expression", s.Key, d.Key)
			}
		}
		for _, f := range s.Fields {
			if f.Expr == "" || len(f.Ops) == 0 {
				t.Errorf("subject %q: filter %q is unusable", s.Key, f.Key)
			}
		}
	}
}

/*
The schema must survive being serialised.

	reportSubject carries a func field (Scope) and several SQL expressions that
	must never leave the server. encoding/json refuses a func outright, so a
	missing `json:"-"` would turn the first request to /schema into a 500 —
	and a missing one on Expr would ship the whitelist's SQL to the browser,
	which is a map of the schema handed to anyone with reports.read.
*/
func TestReportSchemaMarshalsWithoutLeakingSQL(t *testing.T) {
	blob, err := json.Marshal(reportSubjects)
	if err != nil {
		t.Fatalf("the schema cannot be sent to the client: %v", err)
	}
	out := string(blob)
	for _, s := range reportSubjects {
		if !strings.Contains(out, s.Key) {
			t.Errorf("subject %q did not survive marshalling", s.Key)
		}
		if strings.Contains(out, s.From) {
			t.Errorf("subject %q shipped its FROM clause to the client", s.Key)
		}
		for _, d := range s.Dimensions {
			if strings.Contains(out, d.Expr) {
				t.Errorf("subject %q shipped the SQL for %q to the client", s.Key, d.Key)
			}
		}
	}
}
