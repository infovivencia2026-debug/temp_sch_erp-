package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Two kinds of test, for the same reason timetable_ops_test.go has two.

	The first needs no database and drives the real router mountHRGrowth
	builds, so a route added later without a gate is caught rather than
	trusted. The property that matters most is the last one in that group: an
	appraisal score is the most sensitive number in this file after pay, and
	hr.employees.read alone must not reach anybody else's.

	The second needs a real Postgres and is skipped without TEST_DATABASE_URL.
	Everything interesting here is SQL under row level security and three
	database triggers, and a fake would only prove the fake works.
*/

// mountedHRGrowth builds the tree exactly as api.go will: at the authenticated
// router, carrying no permission of its own, each subtree bringing its own.
func mountedHRGrowth(s *Server, id *httpx.Identity) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) { s.mountHRGrowth(r) })
	return r
}

// --- authorization, no database needed --------------------------------------

// A signed-in caller holding nothing reaches none of it. Vacancies, salary
// bands, appraisal scores and the duty roster are all staff records.
func TestHRGrowthRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedHRGrowth(&Server{}, identityWith())
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/hr-growth/designations"},
		{http.MethodGet, "/hr-growth/vacancies"},
		{http.MethodPost, "/hr-growth/vacancies"},
		{http.MethodGet, "/hr-growth/candidates"},
		{http.MethodPost, "/hr-growth/candidates/" + uuid.NewString() + "/hire"},
		{http.MethodGet, "/hr-growth/appraisal/records"},
		{http.MethodGet, "/hr-growth/training/compliance"},
		{http.MethodGet, "/hr-growth/roster"},
		{http.MethodPost, "/hr-growth/roster"},
		{http.MethodGet, "/hr-growth/me/appraisals"},
		{http.MethodGet, "/hr-growth/me/duties"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s without any permission: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Reading staff records does not entitle you to change them.

	Every write in this file is walked, so a route added later without
	RequirePermission(EmployeesWrite) fails here rather than in production. The
	two exceptions are deliberate and named: the reviewer's own form, which a
	head of department reaches with employees.read because the narrowing is
	"you were named on it" rather than a permission, and the four self-service
	routes, which a teacher reaches with self.profile.read alone.
*/
func TestHRGrowthWritesNeedEmployeesWrite(t *testing.T) {
	s := &Server{}
	probe := chi.NewRouter()
	s.mountHRGrowth(probe)

	reader := mountedHRGrowth(s, identityWith(rbac.EmployeesRead, rbac.SelfProfileRead))

	// Gated by a rule rather than a permission; asserted separately below.
	byRule := map[string]bool{
		"POST /hr-growth/appraisal/records/{id}/review":      true,
		"POST /hr-growth/me/appraisals/{id}/self-assessment": true,
		"POST /hr-growth/me/appraisals/{id}/acknowledge":     true,
	}

	err := chi.Walk(probe, func(method, route string, _ http.Handler,
		_ ...func(http.Handler) http.Handler) error {
		if method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions {
			return nil
		}
		if byRule[method+" "+route] {
			return nil
		}
		path := strings.ReplaceAll(route, "{id}", uuid.NewString())
		if got := statusOf(t, reader, method, path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — a write reachable with only hr.employees.read",
				method, path, got)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// The teacher's own record opens on self.profile.read and nothing more. This
// is the bug the leave queue already had: a group-level HR gate 403s a teacher
// asking about themselves.
func TestHRGrowthSelfServiceOpensOnSelfProfileRead(t *testing.T) {
	h := mountedHRGrowth(&Server{}, identityWith(rbac.SelfProfileRead))
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/hr-growth/me/appraisals"},
		{http.MethodGet, "/hr-growth/me/training"},
		{http.MethodGet, "/hr-growth/me/duties"},
		{http.MethodPost, "/hr-growth/me/appraisals/" + uuid.NewString() + "/acknowledge"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with self.profile.read was refused", tc.method, tc.path)
		}
	}
	// And that permission alone reaches nothing of anybody else's.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/hr-growth/appraisal/records"},
		{http.MethodGet, "/hr-growth/candidates"},
		{http.MethodGet, "/hr-growth/designations"},
		{http.MethodGet, "/hr-growth/training/compliance"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only self.profile.read: got %d, want 403",
				tc.method, tc.path, got)
		}
	}
}

// --- against a real database -------------------------------------------------

type growthSchool struct {
	db     *database.DB
	inst   uuid.UUID
	campus uuid.UUID
	year   uuid.UUID
	dept   uuid.UUID
	desig  uuid.UUID
	// The HR clerk the tests mostly run as, and one ordinary teacher.
	hrUser      uuid.UUID
	teacherUser uuid.UUID
	teacherEmp  uuid.UUID
	otherUser   uuid.UUID
	otherEmp    uuid.UUID
}

func (sc *growthSchool) tx(t *testing.T, fn func(tx pgx.Tx) error) {
	t.Helper()
	if err := sc.db.InTenant(context.Background(),
		database.Scope{InstitutionID: sc.inst}, fn); err != nil {
		t.Fatalf("tenant query: %v", err)
	}
}

func (sc *growthSchool) as(user uuid.UUID, perms ...string) *httpx.Identity {
	set := map[string]struct{}{}
	for _, p := range perms {
		set[p] = struct{}{}
	}
	return &httpx.Identity{UserID: user, InstitutionID: sc.inst, Permissions: set}
}

// newGrowthSchool builds the smallest school these four features need: one
// department, one teaching designation, two teachers and an HR clerk.
func newGrowthSchool(t *testing.T) *growthSchool {
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

	sc := &growthSchool{db: db}
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO institutions (name, short_name, slug)
			VALUES ('Growth Test','Growth',$1) RETURNING id`,
			"gr-"+uuid.NewString()[:8]).Scan(&sc.inst)
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
			INSERT INTO academic_years (institution_id, campus_id, name, starts_on, ends_on, is_current)
			VALUES ($1,$2,'2026-27','2026-04-01','2027-03-31',true) RETURNING id`,
			sc.inst, sc.campus).Scan(&sc.year); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO designations (institution_id, name, category)
			VALUES ($1,'TGT Science','teaching') RETURNING id`, sc.inst).Scan(&sc.desig); err != nil {
			return err
		}

		mk := func(email, name string) (uuid.UUID, uuid.UUID, error) {
			var u, e uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO users (institution_id, email, full_name, status)
				VALUES ($1,$2::citext,$3,'active') RETURNING id`,
				sc.inst, email, name).Scan(&u); err != nil {
				return u, e, err
			}
			err := tx.QueryRow(ctx, `
				INSERT INTO employees (institution_id, campus_id, user_id, employee_code,
				        first_name, designation_id, joined_on, status)
				VALUES ($1,$2,$3,$4,$5,$6,'2024-06-01','active') RETURNING id`,
				sc.inst, sc.campus, u, "E-"+uuid.NewString()[:6], name, sc.desig).Scan(&e)
			return u, e, err
		}
		var err error
		if sc.hrUser, _, err = mk("hr@growth.test", "HR Clerk"); err != nil {
			return err
		}
		if sc.teacherUser, sc.teacherEmp, err = mk("t1@growth.test", "Asha"); err != nil {
			return err
		}
		if sc.otherUser, sc.otherEmp, err = mk("t2@growth.test", "Ravi"); err != nil {
			return err
		}
		// A department headed by the teacher, so the department narrowing is
		// live rather than vacuous.
		return tx.QueryRow(ctx, `
			INSERT INTO departments (institution_id, campus_id, name, head_user_id)
			VALUES ($1,$2,'Science',$3) RETURNING id`,
			sc.inst, sc.campus, sc.teacherUser).Scan(&sc.dept)
	})
	return sc
}

func callJSON(t *testing.T, h http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	out := map[string]any{}
	if w.Body.Len() > 0 {
		_ = json.Unmarshal(w.Body.Bytes(), &out)
	}
	return w.Code, out
}

func itemsOf(v map[string]any) []any {
	list, _ := v["items"].([]any)
	return list
}

/*
Recruitment end to end, and the one step that matters.

	A hired candidate must become an employee through the same path the staff
	screen uses, and must still be there afterwards as a candidate. The
	assertions are: an employee row exists, the candidate points at it, the
	candidate is not gone, and a second hire is refused rather than producing a
	second employee.
*/
func TestHiringACandidateCreatesTheEmployeeAndKeepsTheCandidate(t *testing.T) {
	sc := newGrowthSchool(t)
	s := &Server{DB: sc.db}
	h := mountedHRGrowth(s, sc.as(sc.hrUser, rbac.EmployeesRead, rbac.EmployeesWrite))

	code, vac := callJSON(t, h, "POST", "/hr-growth/vacancies", fmt.Sprintf(`{
		"code":"V-1","title":"TGT Science","designation_id":%q,
		"positions":1,"salary_min_paise":2500000,"salary_max_paise":3500000,"submit":true}`,
		sc.desig))
	if code != http.StatusCreated {
		t.Fatalf("POST vacancies: %d %v", code, vac)
	}
	vacID, _ := vac["id"].(string)

	if code, body := callJSON(t, h, "POST", "/hr-growth/vacancies/"+vacID+"/decide",
		`{"action":"approve","note":"budgeted"}`); code != http.StatusOK {
		t.Fatalf("approve: %d %v", code, body)
	}

	code, cand := callJSON(t, h, "POST", "/hr-growth/candidates", fmt.Sprintf(`{
		"vacancy_id":%q,"full_name":"Meera Nair","email":"meera@x.test",
		"phone":"9000000001","qualification":"M.Sc B.Ed","experience_years":6}`, vacID))
	if code != http.StatusCreated {
		t.Fatalf("POST candidates: %d %v", code, cand)
	}
	candID, _ := cand["id"].(string)

	// The same person twice against the same post is one candidate, not two.
	if code, _ := callJSON(t, h, "POST", "/hr-growth/candidates", fmt.Sprintf(`{
		"vacancy_id":%q,"full_name":"Meera Nair","email":"meera@x.test",
		"phone":"9000000001"}`, vacID)); code != http.StatusConflict {
		t.Errorf("a duplicate application: got %d, want 409", code)
	}

	if code, body := callJSON(t, h, "POST", "/hr-growth/candidates/"+candID+"/stage",
		`{"stage":"demo_lesson","note":"class 8-A, photosynthesis"}`); code != http.StatusOK {
		t.Fatalf("stage move: %d %v", code, body)
	}
	// 'joined' is not a status somebody types.
	if code, _ := callJSON(t, h, "POST", "/hr-growth/candidates/"+candID+"/stage",
		`{"stage":"joined"}`); code != http.StatusConflict {
		t.Errorf("setting stage=joined directly: got %d, want 409", code)
	}

	code, hire := callJSON(t, h, "POST", "/hr-growth/candidates/"+candID+"/hire",
		`{"employee_code":"E-NEW-1","joined_on":"2026-06-01","employment_type":"probation"}`)
	if code != http.StatusCreated {
		t.Fatalf("hire: %d %v", code, hire)
	}
	empID, _ := hire["employee_id"].(string)
	if empID == "" {
		t.Fatal("hire returned no employee id")
	}

	sc.tx(t, func(tx pgx.Tx) error {
		var name, empType, stage string
		var pointsAt *string
		if err := tx.QueryRow(context.Background(), `
			SELECT e.first_name, e.employment_type, c.stage, c.employee_id::text
			  FROM job_candidates c JOIN employees e ON e.id = c.employee_id
			 WHERE c.id = $1`, candID).Scan(&name, &empType, &stage, &pointsAt); err != nil {
			return err
		}
		if name != "Meera" {
			t.Errorf("employee first name: got %q, want Meera", name)
		}
		if empType != "probation" {
			t.Errorf("employment_type: got %q, want probation", empType)
		}
		if stage != "joined" {
			t.Errorf("candidate stage after hire: got %q, want joined", stage)
		}
		if pointsAt == nil || *pointsAt != empID {
			t.Errorf("candidate does not point at the employee it became")
		}
		return nil
	})

	// Hiring twice must not produce a second employee.
	if code, _ := callJSON(t, h, "POST", "/hr-growth/candidates/"+candID+"/hire",
		`{"employee_code":"E-NEW-2"}`); code != http.StatusConflict {
		t.Errorf("second hire: got %d, want 409", code)
	}
	var employees int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT count(*)::int FROM employees WHERE employee_code LIKE 'E-NEW-%'`).
			Scan(&employees)
	})
	if employees != 1 {
		t.Errorf("one hire produced %d employee rows", employees)
	}

	// The post is filled, so it stops being advertised.
	code, list := callJSON(t, h, "GET", "/hr-growth/vacancies", "")
	if code != http.StatusOK {
		t.Fatalf("GET vacancies: %d", code)
	}
	row := itemsOf(list)[0].(map[string]any)
	if row["status"] != "filled" {
		t.Errorf("vacancy status after the last position was taken: %v", row["status"])
	}
}

/*
The KPI weights must total 100, and the refusal must be the database's.

	Checked here through the handler and again by raising an appraisal against
	a deliberately unbalanced set, because the handler is not the only way rows
	arrive and a rule enforced only in Go is a rule an import ignores.
*/
func TestAppraisalWeightsMustTotalOneHundred(t *testing.T) {
	sc := newGrowthSchool(t)
	s := &Server{DB: sc.db}
	h := mountedHRGrowth(s, sc.as(sc.hrUser, rbac.EmployeesRead, rbac.EmployeesWrite))

	code, cyc := callJSON(t, h, "POST", "/hr-growth/appraisal/cycles", fmt.Sprintf(`{
		"name":"Annual 2026-27","academic_year_id":%q,"status":"self_assessment"}`, sc.year))
	if code != http.StatusCreated {
		t.Fatalf("POST cycles: %d %v", code, cyc)
	}
	cycID, _ := cyc["id"].(string)

	if code, body := callJSON(t, h, "PUT", "/hr-growth/appraisal/kpis", fmt.Sprintf(`{
		"cycle_id":%q,"designation_id":%q,
		"kpis":[{"code":"TEACH","title":"Classroom practice","weight":60},
		        {"code":"RESULT","title":"Board results","weight":30}]}`, cycID, sc.desig)); code != http.StatusBadRequest {
		t.Errorf("weights totalling 90: got %d, want 400 (%v)", code, body)
	}

	// Thirds must be usable: 33.33 three times is 99.99 and is accepted.
	if code, body := callJSON(t, h, "PUT", "/hr-growth/appraisal/kpis", fmt.Sprintf(`{
		"cycle_id":%q,"designation_id":%q,
		"kpis":[{"code":"A","title":"One","weight":33.33},
		        {"code":"B","title":"Two","weight":33.33},
		        {"code":"C","title":"Three","weight":33.34}]}`, cycID, sc.desig)); code != http.StatusOK {
		t.Errorf("weights totalling 100 in thirds: got %d %v", code, body)
	}

	/*
	   And the database refuses it even when nothing goes through the handler.

	   Built and then violated in two separate transactions on purpose: the
	   trigger aborts the one it fires in, so setup that has to commit cannot
	   share a transaction with a write that is meant to fail.
	*/
	var bad uuid.UUID
	sc.tx(t, func(tx pgx.Tx) error {
		if err := tx.QueryRow(context.Background(), `
			INSERT INTO appraisal_cycles (institution_id, name) VALUES ($1,'Unbalanced')
			RETURNING id`, sc.inst).Scan(&bad); err != nil {
			return err
		}
		_, err := tx.Exec(context.Background(), `
			INSERT INTO appraisal_kpis (institution_id, cycle_id, designation_id, code, title, weight)
			VALUES ($1,$2,$3,'ONLY','Only one',70)`, sc.inst, bad, sc.desig)
		return err
	})

	err := sc.db.InTenant(context.Background(),
		database.Scope{InstitutionID: sc.inst}, func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `
				INSERT INTO appraisals (institution_id, cycle_id, employee_id, designation_id)
				VALUES ($1,$2,$3,$4)`, sc.inst, bad, sc.teacherEmp, sc.desig)
			return err
		})
	if err == nil {
		t.Error("the database accepted an appraisal against weights totalling 70")
	} else if !strings.Contains(err.Error(), "not 100") {
		t.Errorf("refused, but not by the weight gate: %v", err)
	}
}

/*
An employee sees their own appraisal and not their colleague's.

	The most important test in this file. Both teachers hold self.profile.read
	and nothing else, and the score is fetched from the session's employee row
	rather than from anything the caller sends — so there is no id to iterate.
	The department head case is asserted too, because hr.employees.read is held
	by heads of department and the failure in hr_lifecycle.go is precisely that
	it stops there.
*/
func TestAnEmployeeSeesOnlyTheirOwnAppraisal(t *testing.T) {
	sc := newGrowthSchool(t)
	s := &Server{DB: sc.db}
	hr := mountedHRGrowth(s, sc.as(sc.hrUser, rbac.EmployeesRead, rbac.EmployeesWrite))

	code, cyc := callJSON(t, hr, "POST", "/hr-growth/appraisal/cycles",
		`{"name":"Annual","status":"self_assessment"}`)
	if code != http.StatusCreated {
		t.Fatalf("cycle: %d %v", code, cyc)
	}
	cycID, _ := cyc["id"].(string)
	if code, body := callJSON(t, hr, "PUT", "/hr-growth/appraisal/kpis", fmt.Sprintf(`{
		"cycle_id":%q,"kpis":[{"code":"ALL","title":"Overall","weight":100}]}`,
		cycID)); code != http.StatusOK {
		t.Fatalf("kpis: %d %v", code, body)
	}
	code, raised := callJSON(t, hr, "POST", "/hr-growth/appraisal/records",
		fmt.Sprintf(`{"cycle_id":%q}`, cycID))
	if code != http.StatusCreated {
		t.Fatalf("raise: %d %v", code, raised)
	}
	if raised["raised"].(float64) < 3 {
		t.Fatalf("expected an appraisal for every active employee, got %v", raised["raised"])
	}

	// HR sees them all.
	_, all := callJSON(t, hr, "GET", "/hr-growth/appraisal/records", "")
	if len(itemsOf(all)) < 3 {
		t.Fatalf("HR sees %d appraisals, expected every employee's", len(itemsOf(all)))
	}

	// The teacher, holding self.profile.read only, sees exactly one — theirs.
	teacher := mountedHRGrowth(s, sc.as(sc.teacherUser, rbac.SelfProfileRead))
	code, mine := callJSON(t, teacher, "GET", "/hr-growth/me/appraisals", "")
	if code != http.StatusOK {
		t.Fatalf("GET me/appraisals: %d %v", code, mine)
	}
	if len(itemsOf(mine)) != 1 {
		t.Fatalf("a teacher sees %d appraisals on their own screen, want 1", len(itemsOf(mine)))
	}
	own := itemsOf(mine)[0].(map[string]any)
	if own["employee_id"] != sc.teacherEmp.String() {
		t.Errorf("the appraisal on my screen is not mine: %v", own["employee_id"])
	}

	// Their colleague's id is a 404, not a body. Reaching for it by id is the
	// attack a per-row check has to stop, and 404 rather than 403 so the
	// existence of the row is not confirmed either.
	var othersID string
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT id::text FROM appraisals WHERE employee_id = $1`, sc.otherEmp).Scan(&othersID)
	})
	if code, _ := callJSON(t, teacher, "GET", "/hr-growth/me/appraisals/"+othersID, ""); code != http.StatusNotFound {
		t.Errorf("reading a colleague's appraisal by id: got %d, want 404", code)
	}

	/*
	   And with hr.employees.read, which a head of department holds.

	   This is the hr_lifecycle.go weakness restated as an assertion. The
	   teacher heads the Science department but no employee is posted to it, so
	   the only row their reach admits is their own. If this ever returns
	   three, somebody has stopped calling resolveScope.
	*/
	head := mountedHRGrowth(s, sc.as(sc.teacherUser, rbac.EmployeesRead))
	code, seen := callJSON(t, head, "GET", "/hr-growth/appraisal/records", "")
	if code != http.StatusOK {
		t.Fatalf("GET records as head: %d %v", code, seen)
	}
	for _, row := range itemsOf(seen) {
		if row.(map[string]any)["employee_id"] != sc.teacherEmp.String() {
			t.Errorf("a head of department with employees.read read %v's appraisal",
				row.(map[string]any)["full_name"])
		}
	}
}

/*
The three rostering checks, at the three strengths they are meant to have.

	Double-booking and approved leave are refused by the database and no
	override touches them. A period the person teaches is reported and can be
	overridden with a reason, because exam invigilation replaces the lesson it
	clashes with and a hard gate there would block the commonest correct roster
	in the school year.
*/
func TestRosteringRefusesDoubleBookingAndLeaveButReportsTeaching(t *testing.T) {
	sc := newGrowthSchool(t)
	s := &Server{DB: sc.db}
	h := mountedHRGrowth(s, sc.as(sc.hrUser, rbac.EmployeesRead, rbac.EmployeesWrite))

	// Reading the shifts seeds the default set for a school created after the
	// migration ran, the way getLeavePolicy does.
	code, shifts := callJSON(t, h, "GET", "/hr-growth/roster/shifts", "")
	if code != http.StatusOK || len(itemsOf(shifts)) == 0 {
		t.Fatalf("GET shifts: %d, %d rows — the defaults were not seeded",
			code, len(itemsOf(shifts)))
	}
	var gate, assembly string
	for _, row := range itemsOf(shifts) {
		m := row.(map[string]any)
		switch m["code"] {
		case "GATE_AM":
			gate, _ = m["id"].(string)
		case "ASSEMBLY":
			assembly, _ = m["id"].(string)
		}
	}
	if gate == "" || assembly == "" {
		t.Fatal("the seeded shift set is missing the gate or the assembly")
	}

	// A Monday, so the default weekday pattern includes it.
	monday := nextWeekday(time.Monday)
	body := fmt.Sprintf(`{"shift_id":%q,"user_ids":[%q],"from_date":%q}`,
		gate, sc.teacherUser, monday)
	if code, out := callJSON(t, h, "POST", "/hr-growth/roster", body); code != http.StatusCreated {
		t.Fatalf("first duty: %d %v", code, out)
	}

	// 07:15-08:15 and 08:00-09:00 overlap: refused, and by the database.
	overlap := fmt.Sprintf(`{"shift_id":%q,"user_ids":[%q],"from_date":%q,
		"starts_at":"08:00","ends_at":"09:00"}`, assembly, sc.teacherUser, monday)
	if code, out := callJSON(t, h, "POST", "/hr-growth/roster", overlap); code != http.StatusConflict {
		t.Errorf("an overlapping duty: got %d, want 409 (%v)", code, out)
	}
	// And no reason overrides it.
	overlap = strings.TrimSuffix(overlap, "}") + `,"override_reason":"needed"}`
	if code, _ := callJSON(t, h, "POST", "/hr-growth/roster", overlap); code != http.StatusConflict {
		t.Errorf("an overlapping duty with a reason attached was accepted")
	}

	// Approved leave: refused too.
	tuesday := nextWeekday(time.Tuesday)
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			INSERT INTO leave_requests (institution_id, subject_kind, employee_id,
			        from_date, to_date, days, reason, status)
			VALUES ($1,'staff',$2,$3::date,$3::date,1,'personal','approved')`,
			sc.inst, sc.teacherEmp, tuesday)
		return err
	})
	onLeave := fmt.Sprintf(`{"shift_id":%q,"user_ids":[%q],"from_date":%q}`,
		gate, sc.teacherUser, tuesday)
	if code, out := callJSON(t, h, "POST", "/hr-growth/roster", onLeave); code != http.StatusConflict {
		t.Errorf("rostering somebody on approved leave: got %d, want 409 (%v)", code, out)
	}

	// A teaching clash is reported, and overridable with a reason.
	wednesday := nextWeekday(time.Wednesday)
	sc.tx(t, func(tx pgx.Tx) error {
		ctx := context.Background()
		var period, class, section, subject, classSubject uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO periods (institution_id, campus_id, name, sequence, starts_at, ends_at)
			VALUES ($1,$2,'P1',1,'07:30','08:10') RETURNING id`,
			sc.inst, sc.campus).Scan(&period); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO classes (institution_id, campus_id, name, level)
			VALUES ($1,$2,'Class 8',8) RETURNING id`, sc.inst, sc.campus).Scan(&class); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO sections (institution_id, campus_id, class_id, academic_year_id, name)
			VALUES ($1,$2,$3,$4,'A') RETURNING id`,
			sc.inst, sc.campus, class, sc.year).Scan(&section); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO subjects (institution_id, campus_id, name, code)
			VALUES ($1,$2,'Science','SCI') RETURNING id`,
			sc.inst, sc.campus).Scan(&subject); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO class_subjects (institution_id, class_id, subject_id, periods_per_week)
			VALUES ($1,$2,$3,5) RETURNING id`,
			sc.inst, class, subject).Scan(&classSubject); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO timetable_entries (institution_id, academic_year_id, section_id,
			        period_id, weekday, class_subject_id, teacher_user_id)
			VALUES ($1,$2,$3,$4,3,$5,$6)`,
			sc.inst, sc.year, section, period, classSubject, sc.teacherUser)
		return err
	})

	teaching := fmt.Sprintf(`{"shift_id":%q,"user_ids":[%q],"from_date":%q}`,
		gate, sc.teacherUser, wednesday)
	code, out := callJSON(t, h, "POST", "/hr-growth/roster", teaching)
	if code != http.StatusConflict {
		t.Fatalf("a duty over a teaching period: got %d, want 409 (%v)", code, out)
	}
	if list, _ := out["clashes"].([]any); len(list) == 0 {
		t.Error("the refusal did not name what clashed")
	}
	withReason := strings.TrimSuffix(teaching, "}") +
		`,"override_reason":"invigilation replaces the period"}`
	if code, out := callJSON(t, h, "POST", "/hr-growth/roster", withReason); code != http.StatusCreated {
		t.Errorf("a teaching clash with a reason: got %d, want 201 (%v)", code, out)
	}
}

// nextWeekday is the next occurrence of a weekday, in India, comfortably in
// the future so a test run near midnight cannot land on a date already past.
func nextWeekday(want time.Weekday) string {
	d := nowInIndia().AddDate(0, 0, 7)
	for d.Weekday() != want {
		d = d.AddDate(0, 0, 1)
	}
	return d.Format(time.DateOnly)
}

/*
Training hours are counted against the requirement, not merely listed.

	The report an affiliation inspection asks for is hours completed per
	teacher per year against what the board expects, so that is what is
	asserted: fifty required by the seeded CBSE row, twelve completed, and
	thirty-eight short.
*/
func TestTrainingComplianceCountsHoursAgainstTheRequirement(t *testing.T) {
	sc := newGrowthSchool(t)
	s := &Server{DB: sc.db}
	h := mountedHRGrowth(s, sc.as(sc.hrUser, rbac.EmployeesRead, rbac.EmployeesWrite))

	// Reading the requirements seeds the statutory default.
	code, reqs := callJSON(t, h, "GET", "/hr-growth/training/requirements", "")
	if code != http.StatusOK || len(itemsOf(reqs)) == 0 {
		t.Fatalf("GET requirements: %d, %d rows", code, len(itemsOf(reqs)))
	}

	code, prog := callJSON(t, h, "POST", "/hr-growth/training/programmes", fmt.Sprintf(`{
		"code":"CBSE-NEP-1","title":"NEP pedagogy workshop","provider":"CBSE COE Hyderabad",
		"provider_kind":"board","starts_on":"2026-07-10","ends_on":"2026-07-11",
		"hours":12,"is_mandatory":true,"academic_year_id":%q}`, sc.year))
	if code != http.StatusCreated {
		t.Fatalf("POST programmes: %d %v", code, prog)
	}
	progID, _ := prog["id"].(string)

	if code, body := callJSON(t, h, "POST", "/hr-growth/training/records", fmt.Sprintf(`{
		"programme_id":%q,"employee_ids":[%q],"status":"completed",
		"certificate_no":"CBSE/2026/00912","certificate_issued_on":"2026-07-12"}`,
		progID, sc.teacherEmp)); code != http.StatusOK {
		t.Fatalf("POST records: %d %v", code, body)
	}

	code, rep := callJSON(t, h, "GET", "/hr-growth/training/compliance", "")
	if code != http.StatusOK {
		t.Fatalf("GET compliance: %d %v", code, rep)
	}
	var found bool
	for _, row := range itemsOf(rep) {
		m := row.(map[string]any)
		if m["employee_id"] != sc.teacherEmp.String() {
			continue
		}
		found = true
		if m["hours_required"] != 50.0 {
			t.Errorf("hours_required: got %v, want 50", m["hours_required"])
		}
		// Hours default from the programme when completion does not say
		// otherwise, which is the usual case.
		if m["hours_completed"] != 12.0 {
			t.Errorf("hours_completed: got %v, want 12", m["hours_completed"])
		}
		if m["shortfall"] != 38.0 {
			t.Errorf("shortfall: got %v, want 38", m["shortfall"])
		}
		if m["compliant"] != false {
			t.Errorf("compliant: got %v, want false", m["compliant"])
		}
	}
	if !found {
		t.Fatal("the teacher who attended is missing from the compliance report")
	}
}
