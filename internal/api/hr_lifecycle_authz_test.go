package api

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The lifecycle registers, and who reaches whose.

	Two kinds of test, for the reason hr_growth_test.go gives. The first needs
	no database and drives the real router, so a write route added later
	without RequirePermission(EmployeesWrite) fails here rather than in a
	school — which matters more in this file than in most, because the reads
	are narrowed on the assumption that anybody who may write is the back
	office.

	The second needs a real Postgres and is skipped without TEST_DATABASE_URL.
	The narrowing is a SQL predicate under row level security, and a fake would
	only prove the fake works. These are the tests that pin the actual defect:
	a head of department holding hr.employees.read used to read the whole
	school's police verifications, and must now read their department's.
*/

// mountedHRLifecycle builds the tree exactly as api.go does: inside an /hr
// group carrying RequirePermission(EmployeesRead), which every read inherits.
func mountedHRLifecycle(s *Server, id *httpx.Identity) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Route("/hr", func(r chi.Router) {
		r.Use(httpx.RequirePermission(rbac.EmployeesRead))
		r.Get("/documents", s.listEmployeeDocuments)
		s.mountHRLifecycle(r)
	})
	return r
}

// A signed-in caller holding nothing reaches none of it.
func TestHRLifecycleRefusesACallerWithNoPermissions(t *testing.T) {
	s := &Server{}
	h := mountedHRLifecycle(s, identityWith())

	probe := chi.NewRouter()
	probe.Route("/hr", func(r chi.Router) {
		r.Get("/documents", s.listEmployeeDocuments)
		s.mountHRLifecycle(r)
	})
	walk(t, probe, func(method, path string) {
		if got := statusOf(t, h, method, path); got != http.StatusForbidden {
			t.Errorf("%s %s without any permission: got %d, want 403", method, path, got)
		}
	})
}

/*
Reading staff records does not entitle you to change them.

	Every write is walked rather than listed, so a route added later without
	the gate fails here. This test carries more weight than the usual version
	of it: growthReach treats hr.employees.write as the marker for the back
	office and hands its holder the whole institution, so a write route that
	escaped the gate would widen the reads as well.
*/
func TestHRLifecycleWritesNeedEmployeesWrite(t *testing.T) {
	s := &Server{}
	probe := chi.NewRouter()
	probe.Route("/hr", func(r chi.Router) {
		r.Get("/documents", s.listEmployeeDocuments)
		s.mountHRLifecycle(r)
	})
	reader := mountedHRLifecycle(s, identityWith(rbac.EmployeesRead, rbac.SelfProfileRead))

	walked := 0
	walk(t, probe, func(method, path string) {
		if method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions {
			return
		}
		walked++
		if got := statusOf(t, reader, method, path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — a write reachable with only hr.employees.read",
				method, path, got)
		}
	})
	if walked == 0 {
		t.Fatal("walked no writes; the probe router is not being built")
	}
}

func walk(t *testing.T, r chi.Routes, fn func(method, path string)) {
	t.Helper()
	err := chi.Walk(r, func(method, route string, _ http.Handler,
		_ ...func(http.Handler) http.Handler) error {
		fn(method, strings.ReplaceAll(route, "{id}", uuid.NewString()))
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// --- against a real database -------------------------------------------------

/*
lifeSchool is two departments and four people, which is the smallest shape in
which the narrowing can be wrong in both directions.

	Science is headed by Asha, who holds hr.employees.read and nothing more —
	the seeded hod role exactly. Ravi is in Science under her; Meera is in
	Arts, headed by nobody. The HR clerk holds read and write. If the
	predicate is too wide Asha reaches Meera; if it is too narrow she loses
	Ravi, and a head of department who cannot see their own department's
	fitness certificates raises a support ticket on Monday.
*/
type lifeSchool struct {
	db     *database.DB
	inst   uuid.UUID
	campus uuid.UUID
	desig  uuid.UUID

	science, arts uuid.UUID

	hrUser              uuid.UUID
	hodUser, hodEmp     uuid.UUID // Asha, heads Science
	sameUser, sameEmp   uuid.UUID // Ravi, in Science
	otherUser, otherEmp uuid.UUID // Meera, in Arts
}

func (sc *lifeSchool) tx(t *testing.T, fn func(tx pgx.Tx) error) {
	t.Helper()
	if err := sc.db.InTenant(context.Background(),
		database.Scope{InstitutionID: sc.inst}, fn); err != nil {
		t.Fatalf("tenant query: %v", err)
	}
}

func (sc *lifeSchool) as(user uuid.UUID, perms ...string) *httpx.Identity {
	set := map[string]struct{}{}
	for _, p := range perms {
		set[p] = struct{}{}
	}
	return &httpx.Identity{UserID: user, InstitutionID: sc.inst, Permissions: set}
}

func newLifeSchool(t *testing.T) *lifeSchool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	db, err := database.Connect(ctx, url, 4)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(db.Close)

	sc := &lifeSchool{db: db}
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO institutions (name, short_name, slug)
			VALUES ('Lifecycle Test','Life',$1) RETURNING id`,
			"lc-"+uuid.NewString()[:8]).Scan(&sc.inst)
	}); err != nil {
		t.Fatalf("institution: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(),
				`DELETE FROM institutions WHERE id = $1`, sc.inst)
			return err
		})
	})

	sc.tx(t, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO campuses (institution_id, name, code)
			VALUES ($1,'Main','MAIN') RETURNING id`, sc.inst).Scan(&sc.campus); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO designations (institution_id, name, category)
			VALUES ($1,'TGT','teaching') RETURNING id`, sc.inst).Scan(&sc.desig); err != nil {
			return err
		}

		mkUser := func(email, name string) (uuid.UUID, error) {
			var u uuid.UUID
			err := tx.QueryRow(ctx, `
				INSERT INTO users (institution_id, email, full_name, status)
				VALUES ($1,$2::citext,$3,'active') RETURNING id`,
				sc.inst, email, name).Scan(&u)
			return u, err
		}
		var err error
		if sc.hrUser, err = mkUser("hr@life.test", "HR Clerk"); err != nil {
			return err
		}
		if sc.hodUser, err = mkUser("asha@life.test", "Asha"); err != nil {
			return err
		}
		if sc.sameUser, err = mkUser("ravi@life.test", "Ravi"); err != nil {
			return err
		}
		if sc.otherUser, err = mkUser("meera@life.test", "Meera"); err != nil {
			return err
		}

		// The department has to exist before the employees point at it, and
		// its head has to be Asha before scope.Resolve will give her anything.
		if err := tx.QueryRow(ctx, `
			INSERT INTO departments (institution_id, campus_id, name, head_user_id)
			VALUES ($1,$2,'Science',$3) RETURNING id`,
			sc.inst, sc.campus, sc.hodUser).Scan(&sc.science); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO departments (institution_id, campus_id, name)
			VALUES ($1,$2,'Arts') RETURNING id`,
			sc.inst, sc.campus).Scan(&sc.arts); err != nil {
			return err
		}

		mkEmp := func(user, dept uuid.UUID, name string) (uuid.UUID, error) {
			var e uuid.UUID
			err := tx.QueryRow(ctx, `
				INSERT INTO employees (institution_id, campus_id, user_id, employee_code,
				        first_name, department_id, designation_id, joined_on, status)
				VALUES ($1,$2,$3,$4,$5,$6,$7,'2024-06-01','active') RETURNING id`,
				sc.inst, sc.campus, user, "E-"+uuid.NewString()[:6], name,
				dept, sc.desig).Scan(&e)
			return e, err
		}
		if sc.hodEmp, err = mkEmp(sc.hodUser, sc.science, "Asha"); err != nil {
			return err
		}
		if sc.sameEmp, err = mkEmp(sc.sameUser, sc.science, "Ravi"); err != nil {
			return err
		}
		sc.otherEmp, err = mkEmp(sc.otherUser, sc.arts, "Meera")
		return err
	})
	return sc
}

// hod is Asha's identity: the seeded head-of-department capability set, which
// is hr.employees.read without hr.employees.write.
func (sc *lifeSchool) hod() *httpx.Identity {
	return sc.as(sc.hodUser, rbac.EmployeesRead)
}

func (sc *lifeSchool) backOffice() *httpx.Identity {
	return sc.as(sc.hrUser, rbac.EmployeesRead, rbac.EmployeesWrite)
}

// namesIn pulls the full_name of every returned row, which is what the
// assertions below are really about: whose record came back.
func namesIn(v map[string]any) []string {
	out := []string{}
	for _, it := range itemsOf(v) {
		row, _ := it.(map[string]any)
		if n, ok := row["full_name"].(string); ok {
			out = append(out, n)
		}
	}
	return out
}

func hasName(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

/*
The defect, pinned.

	One GET to /hr/background-checks returned the whole school's police
	verifications to any holder of hr.employees.read. Asha must now see her
	department and herself, and must not see Meera in Arts. The back office
	still sees all three, because an HR clerk who cannot see the school's
	verifications cannot chase the ones that have lapsed.
*/
func TestBackgroundChecksNarrowToTheCallersDepartment(t *testing.T) {
	sc := newLifeSchool(t)
	s := &Server{DB: sc.db}

	sc.tx(t, func(tx pgx.Tx) error {
		for _, emp := range []uuid.UUID{sc.hodEmp, sc.sameEmp, sc.otherEmp} {
			if _, err := tx.Exec(context.Background(), `
				INSERT INTO background_verifications (institution_id, employee_id, kind,
				    status, completed_on, valid_until, findings)
				VALUES ($1,$2,'police','clear','2025-01-01','2030-01-01','nothing recorded')`,
				sc.inst, emp); err != nil {
				return err
			}
		}
		return nil
	})

	code, body := callJSON(t, mountedHRLifecycle(s, sc.hod()),
		"GET", "/hr/background-checks", "")
	if code != http.StatusOK {
		t.Fatalf("head of department reading background checks: got %d, want 200", code)
	}
	names := namesIn(body)
	if hasName(names, "Meera") {
		t.Errorf("a head of Science read the police verification of a teacher in Arts: %v", names)
	}
	if !hasName(names, "Ravi") || !hasName(names, "Asha") {
		t.Errorf("a head of Science lost her own department's verifications: %v", names)
	}

	_, all := callJSON(t, mountedHRLifecycle(s, sc.backOffice()),
		"GET", "/hr/background-checks", "")
	if got := len(itemsOf(all)); got != 3 {
		t.Errorf("the back office sees %d verifications, want 3 — the narrowing has caught HR too", got)
	}
}

// The same boundary, on the registers that carry medical restrictions, the
// service book, qualifications and the KYC an appointment was conditional on.
// Walked together because the failure is one predicate, not five.
func TestPersonalRegistersNarrowToTheCallersDepartment(t *testing.T) {
	sc := newLifeSchool(t)
	s := &Server{DB: sc.db}

	sc.tx(t, func(tx pgx.Tx) error {
		ctx := context.Background()
		for _, emp := range []uuid.UUID{sc.hodEmp, sc.sameEmp, sc.otherEmp} {
			if _, err := tx.Exec(ctx, `
				INSERT INTO medical_fitness_certificates (institution_id, employee_id,
				    purpose, issued_on, valid_until, fit)
				VALUES ($1,$2,'general','2025-01-01','2030-01-01',true)`,
				sc.inst, emp); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO staff_qualifications (institution_id, employee_id,
				    qualification, level)
				VALUES ($1,$2,'B.Ed','graduate')`, sc.inst, emp); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO service_book_entries (institution_id, employee_id,
				    entry_kind, event_date, title, source, created_by)
				VALUES ($1,$2,'appointment','2024-06-01','Appointed','manual',$3)`,
				sc.inst, emp, sc.hrUser); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO staff_onboarding (institution_id, employee_id, status)
				VALUES ($1,$2,'submitted')`, sc.inst, emp); err != nil {
				return err
			}
		}
		return nil
	})

	h := mountedHRLifecycle(s, sc.hod())
	for _, path := range []string{
		"/hr/medical-fitness",
		"/hr/qualifications",
		"/hr/service-book",
		"/hr/onboarding",
	} {
		code, body := callJSON(t, h, "GET", path, "")
		if code != http.StatusOK {
			t.Errorf("GET %s as head of department: got %d, want 200", path, code)
			continue
		}
		names := namesIn(body)
		if hasName(names, "Meera") {
			t.Errorf("GET %s leaked a record from another department: %v", path, names)
		}
		if !hasName(names, "Ravi") {
			t.Errorf("GET %s lost the caller's own department: %v", path, names)
		}
	}
}

/*
A grievance is narrower still, and this is the test that says why.

	Asha heads Science and Ravi is in it, so every other register in this file
	shows her his row. His complaint is the one thing that must not work that
	way — a grievance mechanism whose complaints reach the person complained
	about is not a mechanism. She sees her own and the one she was assigned to
	handle; she does not see Ravi's, and nobody outside the back office sees
	the anonymous one.
*/
func TestGrievancesDoNotWidenToTheDepartment(t *testing.T) {
	sc := newLifeSchool(t)
	s := &Server{DB: sc.db}

	sc.tx(t, func(tx pgx.Tx) error {
		ctx := context.Background()
		mk := func(ref string, emp *uuid.UUID, anon bool, assigned *uuid.UUID, subject string) error {
			_, err := tx.Exec(ctx, `
				INSERT INTO staff_grievances (institution_id, reference_no, employee_id,
				    raised_by, is_anonymous, subject, description, assigned_to)
				VALUES ($1,$2,$3,$4,$5,$6,'what happened',$7)`,
				sc.inst, ref, emp, nil, anon, subject, assigned)
			return err
		}
		if err := mk("GRV/0001", &sc.sameEmp, false, nil, "raised by Ravi"); err != nil {
			return err
		}
		if err := mk("GRV/0002", &sc.hodEmp, false, nil, "raised by Asha"); err != nil {
			return err
		}
		if err := mk("GRV/0003", &sc.otherEmp, false, &sc.hodUser, "assigned to Asha"); err != nil {
			return err
		}
		return mk("GRV/0004", nil, true, nil, "raised anonymously")
	})

	code, body := callJSON(t, mountedHRLifecycle(s, sc.hod()), "GET", "/hr/grievances", "")
	if code != http.StatusOK {
		t.Fatalf("head of department reading grievances: got %d, want 200", code)
	}
	seen := map[string]bool{}
	for _, it := range itemsOf(body) {
		row, _ := it.(map[string]any)
		if sub, ok := row["subject"].(string); ok {
			seen[sub] = true
		}
	}
	if seen["raised by Ravi"] {
		t.Error("a head of department read a complaint raised by somebody in their department")
	}
	if seen["raised anonymously"] {
		t.Error("an anonymous grievance reached somebody outside the back office")
	}
	if !seen["raised by Asha"] {
		t.Error("the caller cannot see the complaint they raised themselves")
	}
	if !seen["assigned to Asha"] {
		t.Error("the caller cannot see the complaint they were assigned to handle")
	}

	_, all := callJSON(t, mountedHRLifecycle(s, sc.backOffice()), "GET", "/hr/grievances", "")
	if got := len(itemsOf(all)); got != 4 {
		t.Errorf("the grievance cell sees %d complaints, want 4", got)
	}
}

/*
An exit belonging to another department is not found, rather than found and
empty.

	The distinction is the whole point of exitInReach: "no clearances raised"
	is untrue and tells the asker the id was worth trying, which is the only
	thing an id-guessing attempt learns from.
*/
func TestAnotherDepartmentsExitIsNotFound(t *testing.T) {
	sc := newLifeSchool(t)
	s := &Server{DB: sc.db}

	var exitID uuid.UUID
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			INSERT INTO staff_exits (institution_id, employee_id, kind, notice_on)
			VALUES ($1,$2,'resignation',CURRENT_DATE) RETURNING id`,
			sc.inst, sc.otherEmp).Scan(&exitID)
	})

	path := "/hr/exits/" + exitID.String() + "/clearances"
	if code, _ := callJSON(t, mountedHRLifecycle(s, sc.hod()), "GET", path, ""); code != http.StatusNotFound {
		t.Errorf("a head of Science asking for an Arts exit: got %d, want 404", code)
	}
	if code, _ := callJSON(t, mountedHRLifecycle(s, sc.backOffice()), "GET", path, ""); code != http.StatusOK {
		t.Errorf("the back office reading the same exit: got %d, want 200", code)
	}
}

/*
The registers that are institution-wide stay institution-wide.

	This is the half of the change that is easy to get wrong in the other
	direction. A seniority list narrowed to one department is not a seniority
	list, and the celebration diary exists precisely to be read across the
	staff room. If a later sweep applies the predicate to these, this fails.
*/
func TestSchoolWideRegistersAreNotNarrowed(t *testing.T) {
	sc := newLifeSchool(t)
	s := &Server{DB: sc.db}
	h := mountedHRLifecycle(s, sc.hod())

	code, body := callJSON(t, h, "GET", "/hr/seniority", "")
	if code != http.StatusOK {
		t.Fatalf("seniority as head of department: got %d, want 200", code)
	}
	if !hasName(namesIn(body), "Meera") {
		t.Errorf("seniority was narrowed to a department: %v", namesIn(body))
	}
}

/*
The predicate's placeholders line up with the arguments it hands back.

	Every narrowed handler splices a fragment into SQL that already has its own
	$1, $2, so an off-by-one here is not a compile error and not a wrong answer
	— it is "there is no parameter $4" at run time, on whichever screen was
	opened first. Asserted without a database because the arithmetic is the
	part that breaks, and the arithmetic is pure.
*/
func TestNarrowNumbersItsPlaceholdersFromTheEndOfTheCallersArguments(t *testing.T) {
	dept, own := uuid.New(), uuid.New()

	for _, tc := range []struct {
		name  string
		re    *growthReach
		args  []any
		frag  string
		binds int
	}{
		{"back office reads everything", &growthReach{All: true},
			[]any{"a", "b"}, "TRUE", 0},
		{"heads a department and has a record",
			&growthReach{DeptIDs: []uuid.UUID{dept}, OwnEmpID: &own},
			[]any{"a", "b"}, "(e.department_id = ANY($3) OR e.id = $4)", 2},
		{"heads nothing but is on the staff",
			&growthReach{OwnEmpID: &own}, []any{"a"}, "(e.id = $2)", 1},
		{"heads nothing and is not staff",
			&growthReach{}, []any{"a"}, "FALSE", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := len(tc.args)
			frag, args := narrow(tc.re, "e", tc.args)
			if frag != tc.frag {
				t.Errorf("fragment: got %q, want %q", frag, tc.frag)
			}
			if got := len(args) - before; got != tc.binds {
				t.Errorf("bound %d arguments, want %d", got, tc.binds)
			}
			assertPlaceholdersResolve(t, frag, len(args))
		})
	}
}

// A caller who heads nothing and has no employee row reads nothing, rather
// than everything. The direction this fails in is the whole point.
func TestGrievanceFilterNeverWidensToADepartment(t *testing.T) {
	dept, own := uuid.New(), uuid.New()
	re := &growthReach{UserID: uuid.New(), DeptIDs: []uuid.UUID{dept}, OwnEmpID: &own}

	frag, args := grievanceFilter(re, "g", 2)
	if strings.Contains(frag, "department") {
		t.Errorf("a grievance widened to the caller's department: %q", frag)
	}
	if want := "(g.assigned_to = $2 OR g.employee_id = $3)"; frag != want {
		t.Errorf("fragment: got %q, want %q", frag, want)
	}
	assertPlaceholdersResolve(t, frag, len(args)+1)

	if frag, _ := grievanceFilter(&growthReach{All: true}, "g", 2); frag != "TRUE" {
		t.Errorf("the grievance cell was narrowed: %q", frag)
	}
}

// assertPlaceholdersResolve checks that every $N in the fragment names an
// argument that will actually be bound.
func assertPlaceholdersResolve(t *testing.T, frag string, total int) {
	t.Helper()
	for i, part := range strings.Split(frag, "$")[1:] {
		n := 0
		for _, c := range part {
			if c < '0' || c > '9' {
				break
			}
			n = n*10 + int(c-'0')
		}
		if n < 1 || n > total {
			t.Errorf("placeholder %d in %q is $%d, but only %d arguments are bound",
				i+1, frag, n, total)
		}
	}
}
