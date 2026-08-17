package tests

import (
	"fmt"
	"net/http"
	"testing"
)

// TestAuthorizationMatrix runs every route against every role and asserts the
// outcome. This is the suite the roadmap gates the build on: a permission
// mistake in an ERP is not a bug report, it is a parent reading another child's
// records.
//
// The matrix is written out in full rather than derived from the permission
// table on purpose. Deriving it would test that the code agrees with itself;
// spelling it out tests that the code agrees with what we decided.
func TestAuthorizationMatrix(t *testing.T) {
	hyd := schoolIDByCode(t, "VNPS-HYD")
	sec := schoolIDByCode(t, "VNPS-SEC")

	cases := []struct {
		name   string
		email  string
		method string
		path   string
		body   string
		want   int
		code   string // expected error code, when denied
	}{
		// --- unauthenticated ------------------------------------------------
		{"anonymous cannot list schools", "", http.MethodGet, "/api/v1/schools", "",
			http.StatusUnauthorized, "UNAUTHENTICATED"},
		{"anonymous cannot read the session", "", http.MethodGet, "/api/v1/auth/session", "",
			http.StatusUnauthorized, "UNAUTHENTICATED"},
		{"anonymous cannot create a school", "", http.MethodPost, "/api/v1/schools",
			`{"name":"Ghost School","code":"GHOST"}`, http.StatusUnauthorized, "UNAUTHENTICATED"},

		// --- grant gate: the permission itself -------------------------------
		{"teacher cannot create a school", teacher, http.MethodPost, "/api/v1/schools",
			`{"name":"Sneaky","code":"SNEAK"}`, http.StatusForbidden, "PERMISSION_DENIED"},
		{"teacher cannot update a school", teacher, http.MethodPatch, "/api/v1/schools/" + hyd,
			`{"name":"Renamed"}`, http.StatusForbidden, "PERMISSION_DENIED"},
		{"teacher cannot archive a school", teacher, http.MethodDelete, "/api/v1/schools/" + hyd,
			`{"reason":"why not"}`, http.StatusForbidden, "PERMISSION_DENIED"},
		{"teacher cannot read the audit log", teacher, http.MethodGet, "/api/v1/audit-logs", "",
			http.StatusForbidden, "PERMISSION_DENIED"},

		// An accountant handles money and must never touch academic or tenancy
		// records. This is the separation a school's auditor asks about.
		{"accountant cannot update a school", accountant, http.MethodPatch, "/api/v1/schools/" + hyd,
			`{"name":"Renamed"}`, http.StatusForbidden, "PERMISSION_DENIED"},
		{"accountant cannot create a school", accountant, http.MethodPost, "/api/v1/schools",
			`{"name":"Books","code":"BOOKS"}`, http.StatusForbidden, "PERMISSION_DENIED"},
		{"accountant cannot read the audit log", accountant, http.MethodGet, "/api/v1/audit-logs", "",
			http.StatusForbidden, "PERMISSION_DENIED"},

		// A principal runs the school but does not create or delete schools.
		{"principal cannot create a school", principal, http.MethodPost, "/api/v1/schools",
			`{"name":"New Wing","code":"WING"}`, http.StatusForbidden, "PERMISSION_DENIED"},
		{"principal cannot archive a school", principal, http.MethodDelete, "/api/v1/schools/" + hyd,
			`{"reason":"no"}`, http.StatusForbidden, "PERMISSION_DENIED"},

		// An auditor reads everything and writes nothing, anywhere.
		{"auditor can read the audit log", auditor, http.MethodGet, "/api/v1/audit-logs", "",
			http.StatusOK, ""},
		{"auditor can list schools", auditor, http.MethodGet, "/api/v1/schools", "",
			http.StatusOK, ""},
		{"auditor cannot create a school", auditor, http.MethodPost, "/api/v1/schools",
			`{"name":"Audit School","code":"AUDIT"}`, http.StatusForbidden, "PERMISSION_DENIED"},
		{"auditor cannot update a school", auditor, http.MethodPatch, "/api/v1/schools/" + hyd,
			`{"name":"Renamed"}`, http.StatusForbidden, "PERMISSION_DENIED"},
		{"auditor cannot archive a school", auditor, http.MethodDelete, "/api/v1/schools/" + hyd,
			`{"reason":"no"}`, http.StatusForbidden, "PERMISSION_DENIED"},

		// --- scope gate: holds the permission, but not over this object ------
		// Deepak administers VNPS-SEC. He has school.update, so the grant gate
		// lets him through — only the scope gate stops him touching VNPS-HYD.
		{"school admin cannot read another school", schoolAdmin, http.MethodGet, "/api/v1/schools/" + hyd, "",
			http.StatusForbidden, "OUT_OF_SCOPE"},
		{"school admin cannot update another school", schoolAdmin, http.MethodPatch, "/api/v1/schools/" + hyd,
			`{"name":"Not Mine"}`, http.StatusForbidden, "OUT_OF_SCOPE"},
		{"school admin cannot archive another school", schoolAdmin, http.MethodDelete, "/api/v1/schools/" + hyd,
			`{"reason":"not mine"}`, http.StatusForbidden, "OUT_OF_SCOPE"},
		{"teacher cannot read another school", teacher, http.MethodGet, "/api/v1/schools/" + sec, "",
			http.StatusForbidden, "OUT_OF_SCOPE"},

		// --- allowed paths ---------------------------------------------------
		{"school admin can read their own school", schoolAdmin, http.MethodGet, "/api/v1/schools/" + sec, "",
			http.StatusOK, ""},
		{"school admin can update their own school", schoolAdmin, http.MethodPatch, "/api/v1/schools/" + sec,
			`{"locale":"te-IN"}`, http.StatusOK, ""},
		{"teacher can read their own school", teacher, http.MethodGet, "/api/v1/schools/" + hyd, "",
			http.StatusOK, ""},
		{"principal can read their own school", principal, http.MethodGet, "/api/v1/schools/" + hyd, "",
			http.StatusOK, ""},
		{"org admin can read any school", orgAdmin, http.MethodGet, "/api/v1/schools/" + sec, "",
			http.StatusOK, ""},
		{"org admin can read the audit log", orgAdmin, http.MethodGet, "/api/v1/audit-logs", "",
			http.StatusOK, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var a *actor
			if tc.email == "" {
				a = anonymous()
			} else {
				a = signIn(t, tc.email)
			}

			resp := a.do(t, tc.method, tc.path, tc.body)
			if resp.status != tc.want {
				t.Errorf("status = %d, want %d (body: %s)", resp.status, tc.want, resp.body)
			}
			if tc.code != "" && resp.code() != tc.code {
				t.Errorf("error code = %q, want %q (body: %s)", resp.code(), tc.code, resp.body)
			}
		})
	}
}

// TestScopeFiltersLists checks that scope narrows collections, not just single
// objects. A teacher who asks for "all schools" must receive their own, rather
// than a full list the frontend is trusted to filter.
func TestScopeFiltersLists(t *testing.T) {
	cases := []struct {
		email string
		want  int
	}{
		{orgAdmin, 2},    // organisation-wide
		{auditor, 2},     // organisation-wide, read-only
		{principal, 1},   // VNPS-HYD
		{accountant, 1},  // VNPS-HYD
		{teacher, 1},     // VNPS-HYD
		{schoolAdmin, 1}, // VNPS-SEC
	}

	for _, tc := range cases {
		t.Run(tc.email, func(t *testing.T) {
			resp := signIn(t, tc.email).get(t, "/api/v1/schools")
			if resp.status != http.StatusOK {
				t.Fatalf("status %d: %s", resp.status, resp.body)
			}
			var schools []schoolPayload
			resp.decodeData(t, &schools)
			if len(schools) != tc.want {
				t.Errorf("saw %d schools, want %d", len(schools), tc.want)
			}
		})
	}
}

// TestUnknownSchoolIsNotFound distinguishes "does not exist" from "not yours".
// Both are refusals, but conflating them makes support impossible.
func TestUnknownSchoolIsNotFound(t *testing.T) {
	resp := signIn(t, orgAdmin).get(t, "/api/v1/schools/2f8a0f66-0000-4000-8000-000000000000")
	if resp.status != http.StatusNotFound {
		t.Errorf("status = %d, want 404 (body: %s)", resp.status, resp.body)
	}
	if resp.code() != "SCHOOL_NOT_FOUND" {
		t.Errorf("code = %q, want SCHOOL_NOT_FOUND", resp.code())
	}
}

// TestMalformedIDIsRejected: a path parameter is user input like any other.
func TestMalformedIDIsRejected(t *testing.T) {
	resp := signIn(t, orgAdmin).get(t, "/api/v1/schools/not-a-uuid")
	if resp.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (body: %s)", resp.status, resp.body)
	}
}

// TestSessionEndsOnLogout: revocation must be immediate, not at expiry.
func TestSessionEndsOnLogout(t *testing.T) {
	a := signIn(t, orgAdmin)

	if resp := a.get(t, "/api/v1/auth/session"); resp.status != http.StatusOK {
		t.Fatalf("session before logout: %d", resp.status)
	}
	if resp := a.do(t, http.MethodPost, "/api/v1/auth/logout", ""); resp.status != http.StatusNoContent {
		t.Fatalf("logout: %d", resp.status)
	}

	resp := a.get(t, "/api/v1/auth/session")
	if resp.status != http.StatusUnauthorized {
		t.Errorf("session after logout: status = %d, want 401 (body: %s)", resp.status, resp.body)
	}
}

// TestLoginDoesNotRevealWhichAccountsExist. A different message, code or status
// for "no such user" is an account enumeration oracle — and for a school, the
// account list is the parent list.
func TestLoginDoesNotRevealWhichAccountsExist(t *testing.T) {
	a := anonymous()

	real := a.do(t, http.MethodPost, "/api/v1/auth/login",
		fmt.Sprintf(`{"email":%q,"password":"definitely-wrong"}`, orgAdmin))
	fake := a.do(t, http.MethodPost, "/api/v1/auth/login",
		`{"email":"nobody@vidyaniketan.test","password":"definitely-wrong"}`)

	if real.status != fake.status {
		t.Errorf("status differs: existing account %d, unknown account %d", real.status, fake.status)
	}
	if real.code() != fake.code() {
		t.Errorf("error code differs: existing %q, unknown %q", real.code(), fake.code())
	}
}

// TestArchiveRequiresReason: the reason is not decoration, it is the audit
// record's explanation of why a school disappeared.
func TestArchiveRequiresReason(t *testing.T) {
	admin := signIn(t, orgAdmin)

	created := admin.do(t, http.MethodPost, "/api/v1/schools",
		`{"name":"Temporary Annexe","code":"TEMP-ARC"}`)
	if created.status != http.StatusCreated {
		t.Fatalf("create: %d %s", created.status, created.body)
	}
	var school schoolPayload
	created.decodeData(t, &school)

	without := admin.do(t, http.MethodDelete, "/api/v1/schools/"+school.ID, `{}`)
	if without.status != http.StatusBadRequest || without.code() != "VALIDATION_FAILED" {
		t.Errorf("archive without a reason: got %d/%s, want 400/VALIDATION_FAILED",
			without.status, without.code())
	}

	with := admin.do(t, http.MethodDelete, "/api/v1/schools/"+school.ID,
		`{"reason":"Annexe closed at the end of the session"}`)
	if with.status != http.StatusNoContent {
		t.Errorf("archive with a reason: got %d, want 204 (body: %s)", with.status, with.body)
	}
}

// TestDuplicateCodeIsAConflict: the uniqueness is enforced by the database, so
// two administrators racing produce a clean 409 rather than a 500 or a duplicate.
func TestDuplicateCodeIsAConflict(t *testing.T) {
	admin := signIn(t, orgAdmin)

	first := admin.do(t, http.MethodPost, "/api/v1/schools",
		`{"name":"Race One","code":"RACE-1"}`)
	if first.status != http.StatusCreated {
		t.Fatalf("first create: %d %s", first.status, first.body)
	}

	second := admin.do(t, http.MethodPost, "/api/v1/schools",
		`{"name":"Race Two","code":"race-1"}`) // same code, different case
	if second.status != http.StatusConflict {
		t.Errorf("duplicate code: status = %d, want 409 (body: %s)", second.status, second.body)
	}
	if second.code() != "SCHOOL_CODE_TAKEN" {
		t.Errorf("duplicate code: error = %q, want SCHOOL_CODE_TAKEN", second.code())
	}
}

// TestValidationReportsEveryBadField at once. Fixing a form one error per
// round-trip is how data entry staff come to hate a product.
func TestValidationReportsEveryBadField(t *testing.T) {
	resp := signIn(t, orgAdmin).do(t, http.MethodPost, "/api/v1/schools",
		`{"name":"X","code":"bad code!","board":"HOGWARTS"}`)

	if resp.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.status)
	}

	var envelope struct {
		Error struct {
			Details struct {
				Fields map[string]string `json:"fields"`
			} `json:"details"`
		} `json:"error"`
	}
	if err := jsonUnmarshal(resp.body, &envelope); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, field := range []string{"name", "code", "board"} {
		if _, ok := envelope.Error.Details.Fields[field]; !ok {
			t.Errorf("no message for invalid field %q (got %v)", field, envelope.Error.Details.Fields)
		}
	}
}
