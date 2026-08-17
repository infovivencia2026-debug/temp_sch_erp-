package tests

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/school-erp/erp/internal/catalog"
)

// End-to-end role tests against a running server.
//
// Skipped unless TEST_BASE_URL is set, so `go test ./...` stays green without
// one. These are deliberately black-box: they sign in over the real login form
// and assert on HTTP responses, because that is the path an actual user takes
// and the only one that exercises session resolution, RBAC and scope together.

// The password the demo accounts were seeded with. Read from the environment
// so it tracks whatever `make demo` used rather than being a second literal
// that goes stale the first time someone reseeds with a different one.
var demoPassword = cmp.Or(os.Getenv("DEMO_PASSWORD"), "9")

func baseURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("TEST_BASE_URL")
	if u == "" {
		t.Skip("TEST_BASE_URL not set")
	}
	return strings.TrimRight(u, "/")
}

var csrfRe = regexp.MustCompile(`name="csrf_token" value="([^"]+)"`)

// login performs the real form login and returns a cookie-carrying client.
func login(t *testing.T, base, email string) *http.Client {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	// Do not follow the post-login 303: it points at "/", which nginx serves
	// from the SPA bundle and the Go process answers 404 for. The redirect
	// itself is the success signal.
	c := &http.Client{
		Jar: jar,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	resp, err := c.Get(base + "/login")
	if err != nil {
		t.Fatalf("GET /login: %v", err)
	}
	body := readAll(t, resp)
	m := csrfRe.FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("no csrf token in login page")
	}

	form := url.Values{
		"csrf_token": {m[1]},
		"identifier": {email},
		"password":   {demoPassword},
	}
	resp, err = c.PostForm(base+"/login", form)
	if err != nil {
		t.Fatalf("POST /login as %s: %v", email, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("login as %s: got %d, want 303", email, resp.StatusCode)
	}

	var sess struct {
		Authenticated bool `json:"authenticated"`
	}
	getJSON(t, c, base+"/api/v1/session", &sess)
	if !sess.Authenticated {
		t.Fatalf("login as %s did not establish a session", email)
	}
	return c
}

func readAll(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	b := make([]byte, 0, 4096)
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		b = append(b, buf[:n]...)
		if err != nil {
			break
		}
	}
	return string(b)
}

func getJSON(t *testing.T, c *http.Client, url string, into any) int {
	t.Helper()
	resp, err := c.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	if into != nil && resp.StatusCode == 200 {
		if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
			t.Fatalf("decode %s: %v", url, err)
		}
	}
	return resp.StatusCode
}

func status(t *testing.T, c *http.Client, url string) int {
	t.Helper()
	return getJSON(t, c, url, nil)
}

type catalogResp struct {
	ActiveRole string `json:"active_role"`
	Roles      []struct {
		Key      string `json:"key"`
		Name     string `json:"name"`
		Sections []struct {
			Slug     string `json:"slug"`
			Name     string `json:"name"`
			Features []struct {
				Key     string `json:"key"`
				Scope   string `json:"scope"`
				InScope bool   `json:"in_scope"`
				Live    bool   `json:"live"`
			} `json:"features"`
		} `json:"sections"`
	} `json:"roles"`
	Scope struct {
		PlatformAdmin bool `json:"platform_admin"`
		Departments   int  `json:"departments"`
		Sections      int  `json:"sections"`
		Students      int  `json:"students"`
	} `json:"scope"`
}

// TestEveryRoleCanSignInAndSeeItsWorkspace walks all ten catalog roles.
func TestEveryRoleCanSignInAndSeeItsWorkspace(t *testing.T) {
	base := baseURL(t)

	for _, role := range catalog.Roles {
		role := role
		t.Run(role.Key, func(t *testing.T) {
			c := login(t, base, role.Key+"@vivencia.test")

			var cat catalogResp
			if code := getJSON(t, c, base+"/api/v1/catalog", &cat); code != 200 {
				t.Fatalf("catalog returned %d", code)
			}

			var mine *struct {
				Key      string `json:"key"`
				Name     string `json:"name"`
				Sections []struct {
					Slug     string `json:"slug"`
					Name     string `json:"name"`
					Features []struct {
						Key     string `json:"key"`
						Scope   string `json:"scope"`
						InScope bool   `json:"in_scope"`
						Live    bool   `json:"live"`
					} `json:"features"`
				} `json:"sections"`
			}
			for i := range cat.Roles {
				if cat.Roles[i].Key == role.Key {
					mine = &cat.Roles[i]
					break
				}
			}
			if mine == nil {
				t.Fatalf("role %s not present in its own catalog", role.Key)
			}

			// Every section and feature the catalog defines for this role must
			// come back — the seeder grants the role its whole feature set.
			if len(mine.Sections) != len(role.Sections) {
				t.Errorf("sections: got %d, want %d", len(mine.Sections), len(role.Sections))
			}
			got := 0
			for _, s := range mine.Sections {
				got += len(s.Features)
			}
			want := 0
			for _, s := range role.Sections {
				want += len(s.Features)
			}
			if got != want {
				t.Errorf("features: got %d, want %d", got, want)
			}
			t.Logf("%s: %d sections, %d features", role.Key, len(mine.Sections), got)
		})
	}
}

// TestRolesCannotReachOtherRolesFeatures asserts the catalog is a boundary, not
// just a menu: a role must not be granted another role's feature keys.
func TestRolesCannotReachOtherRolesFeatures(t *testing.T) {
	base := baseURL(t)

	for _, role := range catalog.Roles {
		role := role
		t.Run(role.Key, func(t *testing.T) {
			// A platform admin passes every permission check by design, so its
			// catalog spans all personas. Excluded rather than special-cased in
			// the assertion, because "super_admin sees everything" is the
			// property we want, not a leak.
			if role.Key == "super_admin" {
				t.Skip("platform admin holds every key by design")
			}
			c := login(t, base, role.Key+"@vivencia.test")
			var cat catalogResp
			getJSON(t, c, base+"/api/v1/catalog", &cat)

			for _, r := range cat.Roles {
				if r.Key == role.Key {
					continue
				}
				t.Errorf("%s can also see role %s", role.Key, r.Key)
			}
		})
	}
}

// TestScopeResolution checks that the narrow scopes resolve to real, bounded
// sets — the part RLS cannot enforce.
func TestScopeResolution(t *testing.T) {
	base := baseURL(t)

	cases := []struct {
		role   string
		assert func(t *testing.T, s catalogResp)
	}{
		{"super_admin", func(t *testing.T, s catalogResp) {
			if !s.Scope.PlatformAdmin {
				t.Error("super_admin should resolve as platform admin")
			}
		}},
		{"hod", func(t *testing.T, s catalogResp) {
			if s.Scope.Departments == 0 {
				t.Error("hod should head at least one department")
			}
		}},
		{"faculty", func(t *testing.T, s catalogResp) {
			if s.Scope.Sections == 0 {
				t.Error("faculty should be assigned at least one section")
			}
		}},
		{"student", func(t *testing.T, s catalogResp) {
			if s.Scope.Students != 1 {
				t.Errorf("student should resolve to exactly 1 student record, got %d", s.Scope.Students)
			}
		}},
		{"parent", func(t *testing.T, s catalogResp) {
			if s.Scope.Students == 0 {
				t.Error("parent should be linked to at least one child")
			}
		}},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.role, func(t *testing.T) {
			c := login(t, base, tc.role+"@vivencia.test")
			var cat catalogResp
			getJSON(t, c, base+"/api/v1/catalog", &cat)
			tc.assert(t, cat)
			t.Logf("%s scope: platform=%v departments=%d sections=%d students=%d",
				tc.role, cat.Scope.PlatformAdmin, cat.Scope.Departments,
				cat.Scope.Sections, cat.Scope.Students)
		})
	}
}

// TestRoleEndpointAuthorisation asserts each role's endpoints answer 200 for
// the role that owns them and 403 for one that does not.
func TestRoleEndpointAuthorisation(t *testing.T) {
	base := baseURL(t)

	endpoints := map[string][]string{
		"institution_admin": {"/api/v1/principal/dashboard", "/api/v1/principal/staff-workload"},
		"hod":               {"/api/v1/department/dashboard", "/api/v1/department/faculty"},
		"faculty":           {"/api/v1/teaching/today", "/api/v1/teaching/classes"},
		"finance":           {"/api/v1/finance/dashboard", "/api/v1/finance/invoices"},
		"admissions":        {"/api/v1/admissions/dashboard", "/api/v1/admissions/enquiries"},
		"hr":                {"/api/v1/hr/dashboard", "/api/v1/hr/employees"},
		"operations":        {"/api/v1/operations/dashboard"},
		"student":           {"/api/v1/portal/summary", "/api/v1/portal/attendance"},
		"parent":            {"/api/v1/portal/students", "/api/v1/portal/summary"},
	}

	for role, paths := range endpoints {
		role, paths := role, paths
		t.Run(role+"/allowed", func(t *testing.T) {
			c := login(t, base, role+"@vivencia.test")
			for _, p := range paths {
				if code := status(t, c, base+p); code != 200 {
					t.Errorf("%s GET %s = %d, want 200", role, p, code)
				}
			}
		})
	}

	// A student must not reach staff endpoints. This is the check that matters:
	// the portal roles are the ones exposed to the widest audience.
	t.Run("student/denied", func(t *testing.T) {
		c := login(t, base, "student@vivencia.test")
		for _, p := range []string{
			"/api/v1/principal/dashboard",
			"/api/v1/finance/invoices",
			"/api/v1/hr/employees",
			"/api/v1/admin/users",
			"/api/v1/students",
		} {
			code := status(t, c, base+p)
			if code != 403 {
				t.Errorf("student GET %s = %d, want 403", p, code)
			}
		}
	})

	t.Run("parent/denied", func(t *testing.T) {
		c := login(t, base, "parent@vivencia.test")
		for _, p := range []string{
			"/api/v1/admin/users", "/api/v1/hr/employees", "/api/v1/finance/dashboard",
		} {
			if code := status(t, c, base+p); code != 403 {
				t.Errorf("parent GET %s = %d, want 403", p, code)
			}
		}
	})
}

// TestPortalCannotReadAnotherStudent is the horizontal-access check: a guardian
// editing the student_id in the URL must not be able to summarise a child that
// is not theirs.
func TestPortalCannotReadAnotherStudent(t *testing.T) {
	base := baseURL(t)

	parent := login(t, base, "parent@vivencia.test")
	var mine struct {
		Items []struct {
			StudentID string `json:"student_id"`
		} `json:"items"`
	}
	getJSON(t, parent, base+"/api/v1/portal/students", &mine)
	if len(mine.Items) == 0 {
		t.Skip("parent has no linked children in this dataset")
	}
	own := map[string]bool{}
	for _, c := range mine.Items {
		own[c.StudentID] = true
	}

	// Pick a student this guardian is not linked to, via an account that can
	// legitimately list all of them.
	admin := login(t, base, "institution_admin@vivencia.test")
	var all struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/students?limit=200", &all)

	var foreign string
	for _, s := range all.Items {
		if !own[s.ID] {
			foreign = s.ID
			break
		}
	}
	if foreign == "" {
		t.Skip("no unrelated student available")
	}

	code := status(t, parent, fmt.Sprintf("%s/api/v1/portal/summary?student_id=%s", base, foreign))
	if code != 404 {
		t.Errorf("parent reading unrelated student = %d, want 404", code)
	}
}

// TestAnonymousIsRejected confirms nothing below /api/v1 is readable signed out,
// with /session the single deliberate exception.
func TestAnonymousIsRejected(t *testing.T) {
	base := baseURL(t)
	c := &http.Client{}

	if code := status(t, c, base+"/api/v1/session"); code != 200 {
		t.Errorf("anonymous /session = %d, want 200", code)
	}
	for _, p := range []string{
		"/api/v1/catalog", "/api/v1/students", "/api/v1/principal/dashboard",
		"/api/v1/admin/users", "/api/v1/portal/summary",
	} {
		if code := status(t, c, base+p); code != 401 {
			t.Errorf("anonymous GET %s = %d, want 401", p, code)
		}
	}
}

var _ = context.Background

// --- regressions -------------------------------------------------------------
// Each of these reproduces a bug found by probing the running system. They
// exist so the same hole cannot reopen silently.

// A teacher must see only the students in the sections they teach. Faculty held
// students.read, which was indistinguishable from institution-wide access, so
// a teacher of two sections listed all 96 students.
func TestFacultySeesOnlyTheirOwnStudents(t *testing.T) {
	base := baseURL(t)

	admin := login(t, base, "institution_admin@vivencia.test")
	var all struct {
		Total int `json:"total"`
	}
	getJSON(t, admin, base+"/api/v1/students?limit=1", &all)

	fac := login(t, base, "faculty@vivencia.test")
	var mine struct {
		Total int `json:"total"`
		Items []struct {
			SectionName *string `json:"section_name"`
		} `json:"items"`
	}
	getJSON(t, fac, base+"/api/v1/students?limit=500", &mine)

	var sections struct {
		Items []struct {
			SectionID string `json:"section_id"`
		} `json:"items"`
	}
	getJSON(t, fac, base+"/api/v1/teaching/classes", &sections)

	if mine.Total == 0 {
		t.Fatal("faculty should see the students in their own sections")
	}
	if mine.Total >= all.Total {
		t.Errorf("faculty sees %d of %d students — scope not applied", mine.Total, all.Total)
	}
	t.Logf("faculty sees %d of %d students across %d assigned sections",
		mine.Total, all.Total, len(sections.Items))
}

// Attendance reads were unfiltered: a teacher could pull the register for every
// section in the school.
func TestFacultyAttendanceIsSectionScoped(t *testing.T) {
	base := baseURL(t)
	fac := login(t, base, "faculty@vivencia.test")

	var classes struct {
		Items []struct {
			SectionID string `json:"section_id"`
		} `json:"items"`
	}
	getJSON(t, fac, base+"/api/v1/teaching/classes", &classes)
	own := map[string]bool{}
	for _, c := range classes.Items {
		own[c.SectionID] = true
	}

	var rows struct {
		Items []struct {
			SectionID string `json:"section_id"`
		} `json:"items"`
	}
	getJSON(t, fac, base+"/api/v1/attendance?on_date=2026-08-14", &rows)

	for _, r := range rows.Items {
		if !own[r.SectionID] {
			t.Fatalf("faculty read attendance for section %s, which they do not teach", r.SectionID)
		}
	}
	t.Logf("attendance rows visible to faculty: %d, all within %d own sections",
		len(rows.Items), len(own))
}

// The write path checked only the permission, never the section, so any teacher
// could post a register for any class.
func TestFacultyCannotMarkForeignSection(t *testing.T) {
	base := baseURL(t)
	fac := login(t, base, "faculty@vivencia.test")
	admin := login(t, base, "institution_admin@vivencia.test")

	var classes struct {
		Items []struct {
			SectionID string `json:"section_id"`
		} `json:"items"`
	}
	getJSON(t, fac, base+"/api/v1/teaching/classes", &classes)
	own := map[string]bool{}
	for _, c := range classes.Items {
		own[c.SectionID] = true
	}

	var all struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/academics/sections", &all)

	var foreign string
	for _, s := range all.Items {
		if !own[s.ID] {
			foreign = s.ID
			break
		}
	}
	if foreign == "" {
		t.Skip("faculty teaches every section in this dataset")
	}

	body := strings.NewReader(fmt.Sprintf(
		`{"section_id":%q,"on_date":"2026-08-10","entries":[{"student_id":%q,"status":"absent"}]}`,
		foreign, foreign)) // student id is irrelevant; authorisation fails first
	req, _ := http.NewRequest(http.MethodPost, base+"/api/v1/attendance", body)
	req.Header.Set("Content-Type", "application/json")
	resp, err := fac.Do(req)
	if err != nil {
		t.Fatalf("POST attendance: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("marking a foreign section = %d, want 403", resp.StatusCode)
	}

	// The teacher's own section must still work.
	var roster struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, fac, base+"/api/v1/students?section_id="+classes.Items[0].SectionID+"&limit=1", &roster)
	if len(roster.Items) == 0 {
		t.Skip("no students in the teacher's own section")
	}
	ok := strings.NewReader(fmt.Sprintf(
		`{"section_id":%q,"on_date":"2026-08-10","entries":[{"student_id":%q,"status":"present"}]}`,
		classes.Items[0].SectionID, roster.Items[0].ID))
	req2, _ := http.NewRequest(http.MethodPost, base+"/api/v1/attendance", ok)
	req2.Header.Set("Content-Type", "application/json")
	resp2, err := fac.Do(req2)
	if err != nil {
		t.Fatalf("POST own attendance: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Errorf("marking own section = %d, want 200", resp2.StatusCode)
	}
}

// The portal returned every linked child's attendance merged together, so the
// child switcher changed nothing and same-day marks collided.
func TestPortalAttendanceIsPerChild(t *testing.T) {
	base := baseURL(t)
	parent := login(t, base, "parent@vivencia.test")

	var kids struct {
		Items []struct {
			StudentID string `json:"student_id"`
		} `json:"items"`
	}
	getJSON(t, parent, base+"/api/v1/portal/students", &kids)
	if len(kids.Items) < 2 {
		t.Skip("need at least two linked children")
	}

	counts := make([]int, 0, 2)
	for _, k := range kids.Items[:2] {
		var days struct {
			Items []struct {
				Date string `json:"date"`
			} `json:"items"`
		}
		getJSON(t, parent, base+"/api/v1/portal/attendance?student_id="+k.StudentID, &days)
		seen := map[string]bool{}
		for _, d := range days.Items {
			if seen[d.Date] {
				t.Errorf("duplicate date %s — more than one child's rows returned", d.Date)
			}
			seen[d.Date] = true
		}
		counts = append(counts, len(days.Items))
	}
	t.Logf("per-child attendance row counts: %v", counts)

	// And an unrelated child must still be refused.
	admin := login(t, base, "institution_admin@vivencia.test")
	var all struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/students?limit=200", &all)
	own := map[string]bool{}
	for _, k := range kids.Items {
		own[k.StudentID] = true
	}
	for _, s := range all.Items {
		if !own[s.ID] {
			if code := status(t, parent, base+"/api/v1/portal/attendance?student_id="+s.ID); code != 404 {
				t.Errorf("parent reading unrelated child's attendance = %d, want 404", code)
			}
			break
		}
	}
}

// A guardian must be linked to their own children only. Seeding matched
// guardians to students by display name, and twelve names covered 96 students,
// so each guardian collected eight unrelated children.
func TestGuardianLinksAreOneToOne(t *testing.T) {
	base := baseURL(t)
	parent := login(t, base, "parent@vivencia.test")

	var kids struct {
		Items []struct {
			StudentID   string `json:"student_id"`
			AdmissionNo string `json:"admission_no"`
		} `json:"items"`
	}
	getJSON(t, parent, base+"/api/v1/portal/students", &kids)

	if n := len(kids.Items); n == 0 || n > 4 {
		t.Errorf("demo parent has %d children, expected a small deliberate number", n)
	}
	t.Logf("demo parent children: %d", len(kids.Items))
}
