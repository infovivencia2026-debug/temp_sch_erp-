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
Two kinds of test in this file.

	The first needs no database: the router is built exactly as api.go will
	build it and driven with identities holding different permissions, so a
	route added later without a gate is caught rather than trusted. A refusal
	never reaches a handler, which is the point — proving a 403 by reaching the
	handler would be proving the wrong thing.

	The second needs a real Postgres and is skipped without TEST_DATABASE_URL.
	Everything below the handlers is SQL against a schema with row level
	security on it, and a fake would only prove the fake works. These build a
	small school, run the optimizer end to end, publish it, and put a
	substitution request through submission and approval — because the thing
	worth asserting is that approving writes into the *existing* substitutions
	table, which every other screen already reads.
*/

// mountedTimetableOps builds the three trees the way api.go will: inside the
// authenticated group, with no permission of its own, each subtree carrying
// its own gate.
func mountedTimetableOps(s *Server, id *httpx.Identity) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) { s.mountTimetableOps(r) })
	return r
}

// --- authorization, no database needed ---------------------------------------

// A caller holding nothing is refused everywhere, read and write alike. A
// timetable is not secret, but it is not public either.
func TestTimetableOpsRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedTimetableOps(&Server{}, identityWith())

	for _, tc := range []struct{ method, path string }{
		{"GET", "/timetable-optimizer/inputs"},
		{"GET", "/timetable-optimizer/drafts"},
		{"POST", "/timetable-optimizer/drafts"},
		{"GET", "/department-timetable/"},
		{"GET", "/timetable-cover/my-periods"},
		{"GET", "/timetable-cover/requests"},
		{"POST", "/timetable-cover/requests"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 for a caller holding no permissions",
				tc.method, tc.path, got)
		}
	}
}

/*
Reading a timetable does not entitle you to rewrite one.

	academics.timetable.read is held by every teacher in the school. Generating
	a draft, publishing it over the live grid, capping a colleague's load and
	approving somebody's cover are all decisions the office makes, and the read
	gate must not be mistaken for consent to any of them.
*/
func TestTimetableReadDoesNotGrantTimetableWrites(t *testing.T) {
	h := mountedTimetableOps(&Server{}, identityWith(rbac.TimetableRead))

	// Reads pass the gate and reach a handler with no database, which panics
	// and is reported as 500 — a non-403, which is all this asserts.
	for _, path := range []string{
		"/timetable-optimizer/inputs",
		"/timetable-optimizer/drafts",
		"/department-timetable/",
		"/timetable-cover/requests",
	} {
		if got := statusOf(t, h, "GET", path); got == http.StatusForbidden {
			t.Errorf("GET %s: 403 for a holder of academics.timetable.read, which should read", path)
		}
	}

	for _, tc := range []struct{ method, path string }{
		{"POST", "/timetable-optimizer/drafts"},
		{"POST", "/timetable-optimizer/drafts/" + uuid.NewString() + "/publish"},
		{"POST", "/timetable-optimizer/drafts/" + uuid.NewString() + "/discard"},
		{"PUT", "/timetable-optimizer/requirements"},
		{"PUT", "/timetable-optimizer/load-rules"},
		{"POST", "/timetable-optimizer/unavailability"},
		{"DELETE", "/timetable-optimizer/unavailability/" + uuid.NewString()},
		{"POST", "/timetable-cover/requests/" + uuid.NewString() + "/decide"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — read permission must not grant this",
				tc.method, tc.path, got)
		}
	}
}

/*
Submitting a request is not a timetable edit, and deciding one is.

	A teacher asking for their own periods to be covered holds only
	timetable.read. Requiring write to submit would mean only the office could
	ask, which is the arrangement this feature exists to replace. Approving
	writes cover into the day's grid, so that half needs write.
*/
func TestATeacherMaySubmitCoverButNotApproveIt(t *testing.T) {
	h := mountedTimetableOps(&Server{}, identityWith(rbac.TimetableRead))

	if got := statusOf(t, h, "POST", "/timetable-cover/requests"); got == http.StatusForbidden {
		t.Error("POST /timetable-cover/requests: 403 for a teacher, who must be able to ask")
	}
	if got := statusOf(t, h, "POST", "/timetable-cover/requests/"+uuid.NewString()+"/cancel"); got == http.StatusForbidden {
		t.Error("POST .../cancel: 403 for a teacher withdrawing their own request")
	}
	if got := statusOf(t, h, "POST", "/timetable-cover/requests/"+uuid.NewString()+"/decide"); got != http.StatusForbidden {
		t.Error("POST .../decide: a teacher must not be able to approve their own cover")
	}
}

/*
Every mutating route needs timetable.write, bar two named exceptions.

	Enumerated from the router chi actually built rather than from a list kept
	by hand, so a route added to mountTimetableOps later is covered without
	anybody remembering to add it here.

	The two exceptions are the teacher's own half of the substitution feature.
	They are writes, and they are deliberately reachable with only
	timetable.read — a teacher asking for their own periods to be covered, and
	withdrawing that ask. Both are constrained by an ownership check inside the
	handler instead, which is why they are named here rather than skipped by a
	pattern that would silently swallow a third one.
*/
func TestEveryTimetableOpsWriteIsGated(t *testing.T) {
	teacherOwn := map[string]bool{
		"POST /timetable-cover/requests":             true,
		"POST /timetable-cover/requests/{id}/cancel": true,
	}

	s := &Server{}
	r := chi.NewRouter()
	s.mountTimetableOps(r)

	h := mountedTimetableOps(s, identityWith(rbac.TimetableRead))
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method == "GET" || method == "HEAD" || method == "OPTIONS" {
			return nil
		}
		if teacherOwn[method+" "+route] {
			return nil
		}
		path := strings.ReplaceAll(route, "{id}", uuid.NewString())
		if got := statusOf(t, h, method, path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — a write reachable with only timetable.read",
				method, path, got)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// --- against a real database --------------------------------------------------

type school struct {
	db       *database.DB
	inst     uuid.UUID
	campus   uuid.UUID
	year     uuid.UUID
	dept     uuid.UUID
	head     uuid.UUID // the HOD, and the identity the tests run as
	sections []uuid.UUID
	teachers []uuid.UUID
	periods  []uuid.UUID
}

func (sc *school) tx(t *testing.T, fn func(tx pgx.Tx) error) {
	t.Helper()
	if err := sc.db.InTenant(context.Background(),
		database.Scope{InstitutionID: sc.inst}, fn); err != nil {
		t.Fatalf("tenant query: %v", err)
	}
}

/*
newSchool builds the smallest school the three features need.

	Two sections, four subjects with a weekly requirement, four teachers, six
	periods a day. Small enough to reason about and large enough that the
	generator has to make a choice: every teacher takes both sections, so the
	teacher-clash constraint is live rather than vacuous.
*/
func newSchool(t *testing.T) *school {
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

	sc := &school{db: db}
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO institutions (name, short_name, slug)
			VALUES ('TT Test','TT',$1) RETURNING id`,
			"tt-"+uuid.NewString()[:8]).Scan(&sc.inst)
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

		// Periods belong to a bell schedule (migration 00162), the way the
		// setup panel writes them: one default "Standard day" for the campus.
		var bell uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO bell_schedules (institution_id, campus_id, name, is_default)
			VALUES ($1,$2,'Standard day',true) RETURNING id`,
			sc.inst, sc.campus).Scan(&bell); err != nil {
			return err
		}

		// Six teaching periods and one break, so the break is proved to be
		// excluded from the grid rather than assumed to be.
		for i := 1; i <= 7; i++ {
			isBreak := i == 4
			var pid uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO periods (institution_id, campus_id, bell_schedule_id, name, sequence,
				        starts_at, ends_at, is_break)
				VALUES ($1,$2,$3,$4,$5,$6::time,$7::time,$8) RETURNING id`,
				sc.inst, sc.campus, bell, fmt.Sprintf("P%d", i), i,
				fmt.Sprintf("%02d:00", 7+i), fmt.Sprintf("%02d:45", 7+i), isBreak).Scan(&pid); err != nil {
				return err
			}
			if !isBreak {
				sc.periods = append(sc.periods, pid)
			}
		}

		var classID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO classes (institution_id, campus_id, name, level)
			VALUES ($1,$2,'Class 8',8) RETURNING id`, sc.inst, sc.campus).Scan(&classID); err != nil {
			return err
		}
		for _, name := range []string{"A", "B"} {
			var sid uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO sections (institution_id, campus_id, class_id, academic_year_id, name)
				VALUES ($1,$2,$3,$4,$5) RETURNING id`,
				sc.inst, sc.campus, classID, sc.year, name).Scan(&sid); err != nil {
				return err
			}
			sc.sections = append(sc.sections, sid)
		}

		var classSubjects []uuid.UUID
		for i, name := range []string{"Maths", "English", "Science", "Hindi"} {
			var subjID, csID uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO subjects (institution_id, campus_id, name, code)
				VALUES ($1,$2,$3,$4) RETURNING id`,
				sc.inst, sc.campus, name, fmt.Sprintf("S%d", i)).Scan(&subjID); err != nil {
				return err
			}
			// Five periods a week each: 20 for the section against 36 slots,
			// which leaves the generator room and still makes it choose.
			if err := tx.QueryRow(ctx, `
				INSERT INTO class_subjects (institution_id, class_id, subject_id,
				        periods_per_week, prefers_morning)
				VALUES ($1,$2,$3,5,$4) RETURNING id`,
				sc.inst, classID, subjID, name == "Maths").Scan(&csID); err != nil {
				return err
			}
			classSubjects = append(classSubjects, csID)
		}

		if err := tx.QueryRow(ctx, `
			INSERT INTO departments (institution_id, campus_id, name)
			VALUES ($1,$2,'Middle School') RETURNING id`,
			sc.inst, sc.campus).Scan(&sc.dept); err != nil {
			return err
		}

		for i := 0; i < 4; i++ {
			var uid uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO users (institution_id, email, full_name)
				VALUES ($1,$2,$3) RETURNING id`,
				sc.inst, fmt.Sprintf("t%d.%s@tt.test", i, uuid.NewString()[:6]),
				fmt.Sprintf("Teacher %d", i)).Scan(&uid); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO employees (institution_id, campus_id, user_id, employee_code,
				        first_name, department_id, status)
				VALUES ($1,$2,$3,$4,$5,$6,'active')`,
				sc.inst, sc.campus, uid, fmt.Sprintf("E%03d", i),
				fmt.Sprintf("Teacher %d", i), sc.dept); err != nil {
				return err
			}
			sc.teachers = append(sc.teachers, uid)
		}
		sc.head = sc.teachers[0]
		if _, err := tx.Exec(ctx,
			`UPDATE departments SET head_user_id = $2 WHERE id = $1`, sc.dept, sc.head); err != nil {
			return err
		}

		// One teacher per subject, taking both sections. That is what makes the
		// clash constraint bite: Teacher 0 owes ten periods and cannot be in
		// 8A and 8B at once.
		for _, sec := range sc.sections {
			for i, cs := range classSubjects {
				if _, err := tx.Exec(ctx, `
					INSERT INTO section_subject_teachers (institution_id, section_id,
					        class_subject_id, teacher_user_id)
					VALUES ($1,$2,$3,$4)`, sc.inst, sec, cs, sc.teachers[i]); err != nil {
					return err
				}
			}
		}
		return nil
	})
	return sc
}

func (sc *school) identity(perms ...string) *httpx.Identity {
	set := map[string]struct{}{}
	for _, p := range perms {
		set[p] = struct{}{}
	}
	return &httpx.Identity{
		UserID: sc.head, InstitutionID: sc.inst,
		FullName: "Teacher 0", Permissions: set,
	}
}

// call issues one request against the mounted router and decodes the body.
func call(t *testing.T, h http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	var rdr *strings.Reader
	if body == "" {
		rdr = strings.NewReader("")
	} else {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rdr)
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

/*
The optimizer end to end: read the inputs, generate, publish.

	The assertion that matters is the last one. A generated timetable must not
	appear in timetable_entries until somebody publishes it, because a school
	mid-term has an arrangement in those rows and there is no undo.
*/
func TestOptimizerProducesADraftAndOnlyPublishOnDemandWritesTheGrid(t *testing.T) {
	sc := newSchool(t)
	s := &Server{DB: sc.db}
	h := mountedTimetableOps(s, sc.identity(rbac.TimetableRead, rbac.TimetableWrite))

	code, inputs := call(t, h, "GET", "/timetable-optimizer/inputs", "")
	if code != http.StatusOK {
		t.Fatalf("GET inputs: %d %v", code, inputs)
	}
	summary, _ := inputs["summary"].(map[string]any)
	if summary["required_periods"].(float64) != 40 {
		t.Errorf("two sections of four five-period subjects is 40, got %v", summary["required_periods"])
	}
	// Six teaching periods over six days, with the break excluded.
	if summary["teaching_slots_a_week"].(float64) != 36 {
		t.Errorf("expected 36 teaching slots, got %v", summary["teaching_slots_a_week"])
	}

	code, draft := call(t, h, "POST", "/timetable-optimizer/drafts",
		`{"seed":7,"name":"Round one"}`)
	if code != http.StatusCreated {
		t.Fatalf("POST drafts: %d %v", code, draft)
	}
	draftID, _ := draft["id"].(string)
	if draftID == "" {
		t.Fatal("no draft id returned")
	}
	if draft["periods_placed"].(float64) != 40 {
		t.Errorf("all 40 periods should fit: %v placed, issues %v",
			draft["periods_placed"], draft["blocking_issues"])
	}

	// Nothing in the live grid yet. This is the whole point of a draft.
	var live int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT count(*)::int FROM timetable_entries WHERE academic_year_id = $1`,
			sc.year).Scan(&live)
	})
	if live != 0 {
		t.Fatalf("generating wrote %d rows into the live timetable; it must not", live)
	}

	code, full := call(t, h, "GET", "/timetable-optimizer/drafts/"+draftID, "")
	if code != http.StatusOK {
		t.Fatalf("GET draft: %d %v", code, full)
	}
	if n := len(full["entries"].([]any)); n != 40 {
		t.Errorf("draft should carry 40 entries, got %d", n)
	}

	code, pub := call(t, h, "POST", "/timetable-optimizer/drafts/"+draftID+"/publish", `{}`)
	if code != http.StatusOK {
		t.Fatalf("publish: %d %v", code, pub)
	}
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT count(*)::int FROM timetable_entries WHERE academic_year_id = $1`,
			sc.year).Scan(&live)
	})
	if live != 40 {
		t.Fatalf("publish should have written 40 periods, found %d", live)
	}

	// And a second publish of the same draft is refused rather than doubling
	// the grid.
	if code, _ := call(t, h, "POST", "/timetable-optimizer/drafts/"+draftID+"/publish", `{}`); code != http.StatusConflict {
		t.Errorf("re-publishing a published draft: got %d, want 409", code)
	}
}

/*
A draft that leaves requirements unmet is refused until somebody says otherwise.

	Capping the only Maths teacher below what the requirement needs is the
	everyday version of this: the generator places what it can, reports what it
	cannot, and publishing takes an explicit acknowledgement. A timetable
	published two periods short is a decision, and it should look like one.
*/
func TestPublishRefusesAnUnmetDraftWithoutAcknowledgement(t *testing.T) {
	sc := newSchool(t)
	s := &Server{DB: sc.db}
	h := mountedTimetableOps(s, sc.identity(rbac.TimetableRead, rbac.TimetableWrite))

	// Teacher 0 owes ten periods across the two sections; cap them at six.
	code, _ := call(t, h, "PUT", "/timetable-optimizer/load-rules",
		fmt.Sprintf(`{"teacher_user_id":%q,"max_periods_per_day":2,"max_periods_per_week":6}`,
			sc.teachers[0]))
	if code != http.StatusOK {
		t.Fatalf("save load rule: %d", code)
	}

	code, draft := call(t, h, "POST", "/timetable-optimizer/drafts", `{"seed":3}`)
	if code != http.StatusCreated {
		t.Fatalf("generate: %d %v", code, draft)
	}
	if draft["blocking_issues"].(float64) == 0 {
		t.Fatal("a teacher capped below their demand must produce a blocking issue")
	}
	draftID := draft["id"].(string)

	code, body := call(t, h, "POST", "/timetable-optimizer/drafts/"+draftID+"/publish", `{}`)
	if code != http.StatusConflict {
		t.Fatalf("publishing an unmet draft: got %d, want 409 (%v)", code, body)
	}

	// The report has to name the constraint, not merely count the shortfall.
	_, full := call(t, h, "GET", "/timetable-optimizer/drafts/"+draftID, "")
	named := false
	for _, raw := range full["issues"].([]any) {
		is := raw.(map[string]any)
		if strings.Contains(is["detail"].(string), "of 6 periods") {
			named = true
		}
	}
	if !named {
		t.Errorf("no issue named the teacher's load against their cap: %v", full["issues"])
	}

	code, _ = call(t, h, "POST", "/timetable-optimizer/drafts/"+draftID+"/publish",
		`{"acknowledge_unmet":true}`)
	if code != http.StatusOK {
		t.Fatalf("acknowledged publish: got %d, want 200", code)
	}
}

// The head of department sees their own department's week, and the scope is
// decided on the server rather than by which department the screen asked for.
func TestDepartmentTimetableIsScopedToTheCallersDepartment(t *testing.T) {
	sc := newSchool(t)
	s := &Server{DB: sc.db}
	h := mountedTimetableOps(s, sc.identity(rbac.TimetableRead, rbac.TimetableWrite))

	code, draft := call(t, h, "POST", "/timetable-optimizer/drafts", `{"seed":11}`)
	if code != http.StatusCreated {
		t.Fatalf("generate: %d %v", code, draft)
	}
	if code, _ := call(t, h, "POST",
		"/timetable-optimizer/drafts/"+draft["id"].(string)+"/publish", `{}`); code != http.StatusOK {
		t.Fatal("publish failed")
	}

	code, grid := call(t, h, "GET", "/department-timetable/", "")
	if code != http.StatusOK {
		t.Fatalf("department timetable: %d %v", code, grid)
	}
	if n := len(grid["teachers"].([]any)); n != 4 {
		t.Errorf("the department has four teachers, got %d", n)
	}
	if n := len(grid["entries"].([]any)); n != 40 {
		t.Errorf("the published week is 40 periods, got %d", n)
	}
	sum := grid["summary"].(map[string]any)
	if sum["unmet_requirements"].(float64) != 0 {
		t.Errorf("a fully placed week has no unmet requirement, got %v", sum["unmet_requirements"])
	}

	// A department the caller does not head is refused, not filtered.
	var other uuid.UUID
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			INSERT INTO departments (institution_id, campus_id, name)
			VALUES ($1,$2,'Science') RETURNING id`, sc.inst, sc.campus).Scan(&other)
	})
	if code, _ := call(t, h, "GET", "/department-timetable/?department_id="+other.String(), ""); code != http.StatusForbidden {
		t.Errorf("reading another department: got %d, want 403", code)
	}
}

/*
The substitution round trip, and the reason it is worth building.

	A teacher asks for cover; the approver is shown who is actually free in
	each period; approving writes into substitutions — the table the morning
	board, the class register and the payroll proxy count already read. If the
	approval did not land there this feature would be a form that goes nowhere.
*/
func TestSubstitutionRequestFlowsIntoTheDaysTimetable(t *testing.T) {
	sc := newSchool(t)
	s := &Server{DB: sc.db}
	admin := mountedTimetableOps(s, sc.identity(rbac.TimetableRead, rbac.TimetableWrite))

	code, draft := call(t, admin, "POST", "/timetable-optimizer/drafts", `{"seed":5}`)
	if code != http.StatusCreated {
		t.Fatalf("generate: %d %v", code, draft)
	}
	if code, _ := call(t, admin, "POST",
		"/timetable-optimizer/drafts/"+draft["id"].(string)+"/publish", `{}`); code != http.StatusOK {
		t.Fatal("publish failed")
	}

	// Next Monday, so the range always contains teaching days.
	monday := time.Now()
	for monday.Weekday() != time.Monday {
		monday = monday.AddDate(0, 0, 1)
	}
	from := monday.Format("2006-01-02")
	to := monday.AddDate(0, 0, 1).Format("2006-01-02")

	// The teacher's own view: only timetable.read.
	teacher := mountedTimetableOps(s, sc.identity(rbac.TimetableRead))
	code, mine := call(t, teacher, "GET",
		"/timetable-cover/my-periods?from="+from+"&to="+to, "")
	if code != http.StatusOK {
		t.Fatalf("my-periods: %d %v", code, mine)
	}
	items := mine["items"].([]any)
	if len(items) == 0 {
		t.Fatal("the head of department teaches ten periods a week and got none back")
	}

	first := items[0].(map[string]any)
	body := fmt.Sprintf(
		`{"from_date":%q,"to_date":%q,"reason":"Family function",
		  "periods":[{"timetable_entry_id":%q,"on_date":%q}]}`,
		from, to, first["timetable_entry_id"], first["on_date"])
	code, created := call(t, teacher, "POST", "/timetable-cover/requests", body)
	if code != http.StatusCreated {
		t.Fatalf("submit: %d %v", code, created)
	}
	reqID := created["id"].(string)

	// The same period cannot be asked for twice while the first ask is open.
	if code, _ := call(t, teacher, "POST", "/timetable-cover/requests", body); code != http.StatusConflict {
		t.Errorf("a duplicate open request: got %d, want 409", code)
	}

	// The teacher may read their own request but is offered no candidates and
	// no decision.
	code, own := call(t, teacher, "GET", "/timetable-cover/requests/"+reqID, "")
	if code != http.StatusOK {
		t.Fatalf("own request: %d %v", code, own)
	}
	if own["can_decide"].(bool) {
		t.Error("a teacher must not be offered the approve button on their own request")
	}

	// The approver sees who is genuinely free in that period.
	code, view := call(t, admin, "GET", "/timetable-cover/requests/"+reqID, "")
	if code != http.StatusOK {
		t.Fatalf("approver view: %d %v", code, view)
	}
	lines := view["periods"].([]any)
	if len(lines) != 1 {
		t.Fatalf("one period was asked for, got %d lines", len(lines))
	}
	line := lines[0].(map[string]any)
	cands := line["candidates"].([]any)
	if len(cands) == 0 {
		t.Fatal("nobody was offered as free; the suggestion is the point of this screen")
	}
	// Every suggestion must genuinely be free in that slot.
	for _, raw := range cands {
		c := raw.(map[string]any)
		var busy bool
		sc.tx(t, func(tx pgx.Tx) error {
			return tx.QueryRow(context.Background(), `
				SELECT EXISTS (
				  SELECT 1 FROM timetable_entries te
				   WHERE te.teacher_user_id = $1
				     AND te.weekday = extract(isodow FROM $2::date)::int
				     AND te.period_id = (SELECT period_id FROM timetable_entries WHERE id = $3))`,
				c["user_id"], line["on_date"], line["timetable_entry_id"]).Scan(&busy)
		})
		if busy {
			t.Errorf("%v was offered as free and has a class in that period", c["full_name"])
		}
	}

	chosen := cands[0].(map[string]any)["user_id"].(string)
	decide := fmt.Sprintf(`{"decision":"approve","assignments":[{"period_id":%q,"substitute_user_id":%q}]}`,
		line["id"], chosen)
	code, out := call(t, admin, "POST", "/timetable-cover/requests/"+reqID+"/decide", decide)
	if code != http.StatusOK {
		t.Fatalf("approve: %d %v", code, out)
	}
	if out["status"] != "approved" {
		t.Errorf("every period was covered; status should be approved, got %v", out["status"])
	}

	// And the cover is in the day's timetable, in the table everything else
	// already reads.
	var subs int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT count(*)::int FROM substitutions
			 WHERE timetable_entry_id = $1 AND on_date = $2::date
			   AND substitute_user_id = $3 AND request_id = $4`,
			line["timetable_entry_id"], line["on_date"], chosen, reqID).Scan(&subs)
	})
	if subs != 1 {
		t.Fatalf("approval did not write into substitutions (found %d rows)", subs)
	}

	// A decided request cannot be decided again.
	if code, _ := call(t, admin, "POST", "/timetable-cover/requests/"+reqID+"/decide", decide); code != http.StatusConflict {
		t.Errorf("re-deciding: got %d, want 409", code)
	}
}

// A teacher cannot hand over somebody else's class, however the body is
// crafted. The screen only lists their own periods; that is not the control.
func TestATeacherCannotRequestCoverForAnotherTeachersPeriod(t *testing.T) {
	sc := newSchool(t)
	s := &Server{DB: sc.db}
	admin := mountedTimetableOps(s, sc.identity(rbac.TimetableRead, rbac.TimetableWrite))

	code, draft := call(t, admin, "POST", "/timetable-optimizer/drafts", `{"seed":2}`)
	if code != http.StatusCreated {
		t.Fatalf("generate: %d %v", code, draft)
	}
	if code, _ := call(t, admin, "POST",
		"/timetable-optimizer/drafts/"+draft["id"].(string)+"/publish", `{}`); code != http.StatusOK {
		t.Fatal("publish failed")
	}

	// A period belonging to Teacher 1, asked for by Teacher 0.
	var entryID uuid.UUID
	var weekday int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT id, weekday FROM timetable_entries
			 WHERE teacher_user_id = $1 LIMIT 1`, sc.teachers[1]).Scan(&entryID, &weekday)
	})
	day := time.Now()
	for int(day.Weekday()) != weekday%7 {
		day = day.AddDate(0, 0, 1)
	}
	onDate := day.Format("2006-01-02")

	teacher := mountedTimetableOps(s, sc.identity(rbac.TimetableRead))
	body := fmt.Sprintf(
		`{"from_date":%q,"to_date":%q,"reason":"Not mine",
		  "periods":[{"timetable_entry_id":%q,"on_date":%q}]}`,
		onDate, onDate, entryID, onDate)
	if code, _ := call(t, teacher, "POST", "/timetable-cover/requests", body); code != http.StatusForbidden {
		t.Errorf("asking for cover on another teacher's period: got %d, want 403", code)
	}
}

/*
The screens that only ever read, and the small writes that feed them.

	Four endpoints that no other test reaches: the draft list, the weekly
	requirement, recurring unavailability, and discarding a candidate nobody
	wants. Each is one query, and each of those queries only ever runs against
	the real schema — a column renamed underneath any of them would otherwise
	be found by a user.
*/
func TestOptimizerSupportingEndpointsRunAgainstTheRealSchema(t *testing.T) {
	sc := newSchool(t)
	s := &Server{DB: sc.db}
	h := mountedTimetableOps(s, sc.identity(rbac.TimetableRead, rbac.TimetableWrite))

	// A subject's weekly requirement, read back through the inputs screen.
	var csID uuid.UUID
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT cs.id FROM class_subjects cs
			  JOIN subjects s ON s.id = cs.subject_id
			 WHERE s.name = 'Hindi'`).Scan(&csID)
	})
	if code, _ := call(t, h, "PUT", "/timetable-optimizer/requirements",
		fmt.Sprintf(`{"class_subject_id":%q,"periods_per_week":3,"prefers_morning":false}`, csID)); code != http.StatusOK {
		t.Fatalf("save requirement: %d", code)
	}
	code, inputs := call(t, h, "GET", "/timetable-optimizer/inputs", "")
	if code != http.StatusOK {
		t.Fatalf("inputs: %d", code)
	}
	// Hindi dropped from 5 to 3 in both sections: 40 - 4 = 36.
	if got := inputs["summary"].(map[string]any)["required_periods"].(float64); got != 36 {
		t.Errorf("requirement did not take effect: %v required", got)
	}

	// A teacher who is never available on Saturday.
	if code, _ := call(t, h, "POST", "/timetable-optimizer/unavailability",
		fmt.Sprintf(`{"teacher_user_id":%q,"weekday":6,"reason":"Part-time"}`, sc.teachers[2])); code != http.StatusCreated {
		t.Fatalf("save unavailability: %d", code)
	}
	// Saved twice is one row, not two — the COALESCE in the unique index is
	// what makes "the whole of Saturday" a single fact.
	if code, _ := call(t, h, "POST", "/timetable-optimizer/unavailability",
		fmt.Sprintf(`{"teacher_user_id":%q,"weekday":6,"reason":"Part-time, revised"}`, sc.teachers[2])); code != http.StatusCreated {
		t.Fatalf("re-save unavailability: %d", code)
	}
	var unavail int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT count(*)::int FROM teacher_unavailability WHERE teacher_user_id = $1`,
			sc.teachers[2]).Scan(&unavail)
	})
	if unavail != 1 {
		t.Errorf("the same whole-day unavailability was stored %d times", unavail)
	}

	code, again := call(t, h, "GET", "/timetable-optimizer/inputs", "")
	if code != http.StatusOK {
		t.Fatalf("inputs: %d", code)
	}
	marked := false
	for _, raw := range again["teachers"].([]any) {
		tt := raw.(map[string]any)
		if tt["user_id"] == sc.teachers[2].String() && len(tt["unavailable"].([]any)) == 1 {
			marked = true
		}
	}
	if !marked {
		t.Error("the unavailable day did not come back on the teacher")
	}

	// And the generator honours it.
	code, draft := call(t, h, "POST", "/timetable-optimizer/drafts", `{"seed":13}`)
	if code != http.StatusCreated {
		t.Fatalf("generate: %d %v", code, draft)
	}
	var saturday int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT count(*)::int FROM timetable_draft_entries
			 WHERE draft_id = $1 AND teacher_user_id = $2 AND weekday = 6`,
			draft["id"], sc.teachers[2]).Scan(&saturday)
	})
	if saturday != 0 {
		t.Errorf("%d periods placed on a day the teacher declared unavailable", saturday)
	}

	code, list := call(t, h, "GET", "/timetable-optimizer/drafts", "")
	if code != http.StatusOK || len(list["items"].([]any)) != 1 {
		t.Fatalf("draft list: %d %v", code, list)
	}

	draftID := draft["id"].(string)
	if code, _ := call(t, h, "POST", "/timetable-optimizer/drafts/"+draftID+"/discard", `{}`); code != http.StatusOK {
		t.Errorf("discard: %d", code)
	}
	// A discarded draft cannot then be published.
	if code, _ := call(t, h, "POST", "/timetable-optimizer/drafts/"+draftID+"/publish", `{}`); code != http.StatusConflict {
		t.Error("a discarded draft was publishable")
	}

	// The cover queue, which a teacher and an approver read through the same
	// endpoint with the ownership clause relaxed.
	code, queue := call(t, h, "GET", "/timetable-cover/requests", "")
	if code != http.StatusOK {
		t.Fatalf("cover queue: %d %v", code, queue)
	}
	if !queue["can_decide"].(bool) {
		t.Error("a holder of timetable.write is the approver and should be told so")
	}
}

/*
A principal reads every department; a teacher who heads none reads nothing.

	The widest reach and the narrowest, because the middle case — a head of
	department with exactly one department — is the only one anybody checks by
	hand, and it is the one that works whatever the scope code does. The
	principal path has a shape that fails outright rather than leaking: the
	department filter has to bind a parameter that its own predicate does not
	mention, and Postgres refuses the statement rather than the row.
*/
func TestDepartmentTimetableWidensForAPrincipalAndClosesForATeacher(t *testing.T) {
	sc := newSchool(t)
	s := &Server{DB: sc.db}

	admin := mountedTimetableOps(s, sc.identity(rbac.TimetableRead, rbac.TimetableWrite))
	code, draft := call(t, admin, "POST", "/timetable-optimizer/drafts", `{"seed":21}`)
	if code != http.StatusCreated {
		t.Fatalf("generate: %d %v", code, draft)
	}
	if code, _ := call(t, admin, "POST",
		"/timetable-optimizer/drafts/"+draft["id"].(string)+"/publish", `{}`); code != http.StatusOK {
		t.Fatal("publish failed")
	}

	// A second department with nobody in it, so "every department" is a wider
	// answer than "mine".
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			INSERT INTO departments (institution_id, campus_id, name)
			VALUES ($1,$2,'Languages')`, sc.inst, sc.campus)
		return err
	})

	// students.read.all is what marks institution-wide reach, and its holder
	// heads no department at all.
	principal := &httpx.Identity{
		UserID: uuid.New(), InstitutionID: sc.inst, FullName: "Principal",
		Permissions: map[string]struct{}{
			rbac.TimetableRead: {}, rbac.StudentsReadAll: {},
		},
	}
	code, wide := call(t, mountedTimetableOps(s, principal), "GET", "/department-timetable/", "")
	if code != http.StatusOK {
		t.Fatalf("principal view: %d %v", code, wide)
	}
	if n := len(wide["departments"].([]any)); n != 2 {
		t.Errorf("a principal should see both departments, saw %d", n)
	}
	if n := len(wide["teachers"].([]any)); n != 4 {
		t.Errorf("a principal should see all four teachers, saw %d", n)
	}

	// And a teacher who heads nothing sees nothing, rather than the school.
	plain := &httpx.Identity{
		UserID: sc.teachers[3], InstitutionID: sc.inst, FullName: "Teacher 3",
		Permissions: map[string]struct{}{rbac.TimetableRead: {}},
	}
	code, narrow := call(t, mountedTimetableOps(s, plain), "GET", "/department-timetable/", "")
	if code != http.StatusOK {
		t.Fatalf("plain teacher view: %d %v", code, narrow)
	}
	if n := len(narrow["teachers"].([]any)); n != 0 {
		t.Errorf("a teacher who heads no department must see no department roll, saw %d", n)
	}
	if n := len(narrow["entries"].([]any)); n != 0 {
		t.Errorf("and no grid, saw %d periods", n)
	}
}
