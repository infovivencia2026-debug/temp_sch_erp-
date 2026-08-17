package tests

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// randomSuffix keeps repeated runs from colliding on a unique email or title.
// These tests write to the shared demo tenant on purpose — the bugs they cover
// only appear against real seeded data — so every run needs its own names.
func randomSuffix() string { return uuid.NewString()[:8] }

/*
Throwaway accounts clean up after themselves.

	Without this, every run left a "boundary-4c2f0be1@vivencia.test" behind and
	a month of CI turned the demo school's user directory into a list of test
	fixtures. Worse, a directory full of them is what a prospective customer
	would be shown.

	Suspended rather than deleted, and only through the API the product already
	exposes: a test that reaches past the application to tidy the database is a
	test that can corrupt it. An account nobody can sign in to is enough.
*/
func disposable(t *testing.T, c *http.Client, base, userID string) {
	t.Helper()
	t.Cleanup(func() {
		send(t, c, http.MethodPut, base+"/api/v1/admin/users/"+userID+"/status",
			map[string]any{"status": "archived"}, nil)
	})
}

/* The screens a school meets on day one, and the rules behind them.

   Everything here goes through HTTP as a real signed-in person, because the
   bugs these cover were all in the seam between the handler and the database:
   a check constraint spelling 'staff' where the code said 'employee', a role
   grant that Postgres refused but the API reported as an internal error, a
   subject that the caller cannot be expected to resolve to a join row. None of
   those are visible from a unit test of the function alone. */

// send performs a JSON request and returns the status with the decoded body.
func send(t *testing.T, c *http.Client, method, url string, body, into any) int {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal %s: %v", url, err)
		}
		rdr = bytes.NewReader(raw)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatalf("build %s %s: %v", method, url, err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	if into != nil {
		_ = json.NewDecoder(resp.Body).Decode(into)
	}
	return resp.StatusCode
}

type apiError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// The institution profile is the header on every receipt, report card and
// UDISE return, and until recently there was no way to set it at all.
func TestSchoolProfileIsEditableAndValidated(t *testing.T) {
	base := baseURL(t)
	admin := login(t, base, "institution_admin@vivencia.test")

	var before map[string]any
	if code := getJSON(t, admin, base+"/api/v1/setup/institution", &before); code != 200 {
		t.Fatalf("read institution = %d", code)
	}
	if before["name"] == nil {
		t.Fatal("institution has no name")
	}

	t.Run("a bad UDISE code is refused before it reaches the state return", func(t *testing.T) {
		var e apiError
		code := send(t, admin, http.MethodPut, base+"/api/v1/setup/institution",
			map[string]any{"name": "X", "udise_code": "1234"}, &e)
		if code != 400 {
			t.Fatalf("short udise = %d, want 400", code)
		}
		if e.Error.Message == "" {
			t.Error("no explanation given for the rejected code")
		}
	})

	t.Run("an enum the constraint would reject is named, not 500'd", func(t *testing.T) {
		var e apiError
		code := send(t, admin, http.MethodPut, base+"/api/v1/setup/institution",
			map[string]any{"name": "X", "management_type": "Private Unaided"}, &e)
		if code != 400 {
			t.Fatalf("bad management type = %d, want 400 (a 500 means the check "+
				"constraint is doing the validation)", code)
		}
		if !bytes.Contains([]byte(e.Error.Message), []byte("private_unaided")) {
			t.Errorf("error does not name the legal values: %q", e.Error.Message)
		}
	})

	t.Run("the options behind the dropdowns are published", func(t *testing.T) {
		var opts struct {
			ManagementTypes   []struct{ Value, Label string } `json:"management_types"`
			SchoolCategories  []struct{ Value, Label string } `json:"school_categories"`
			Boards            []struct{ Value, Label string } `json:"affiliation_boards"`
			TelanganaDistrict []string                        `json:"telangana_districts"`
		}
		if code := getJSON(t, admin, base+"/api/v1/setup/institution/options", &opts); code != 200 {
			t.Fatalf("options = %d", code)
		}
		if len(opts.ManagementTypes) == 0 || len(opts.SchoolCategories) == 0 {
			t.Error("the form has no values to offer")
		}
		if len(opts.TelanganaDistrict) < 30 {
			t.Errorf("Telangana has 33 districts, got %d", len(opts.TelanganaDistrict))
		}
	})

	t.Run("a valid profile saves and reads back", func(t *testing.T) {
		var saved map[string]any
		code := send(t, admin, http.MethodPut, base+"/api/v1/setup/institution",
			map[string]any{
				"name": "Vivencia High School, Kompally", "affiliation_board": "BSE Telangana",
				"state": "Telangana", "district": "Medchal-Malkajgiri", "mandal": "Quthbullapur",
				"school_category": "high_school", "management_type": "private_unaided",
				"udise_code": "36051200145",
			}, &saved)
		if code != 200 {
			t.Fatalf("save = %d", code)
		}
		// A short name is derived rather than demanded: it exists to fit on a
		// receipt, and the system can work it out.
		if saved["short_name"] != "VHSK" {
			t.Errorf("derived short name = %v, want VHSK", saved["short_name"])
		}
	})
}

// The checklist is the wizard's spine — if a step cannot be satisfied through
// the API then the wizard has a dead end in it.
func TestEverySetupStepHasAWayToSatisfyIt(t *testing.T) {
	base := baseURL(t)
	admin := login(t, base, "institution_admin@vivencia.test")

	var st struct {
		Steps []struct {
			Key      string `json:"key"`
			Done     bool   `json:"done"`
			Blocking bool   `json:"blocking"`
		} `json:"steps"`
		Ready bool `json:"ready"`
	}
	if code := getJSON(t, admin, base+"/api/v1/setup/status", &st); code != 200 {
		t.Fatalf("setup status = %d", code)
	}

	// Every step the wizard renders needs a panel behind it. The panel keys
	// live in the client, so the guard here is that the server's step list has
	// not grown a key the client has never heard of.
	known := map[string]bool{
		"profile": true, "campus": true, "academic_year": true, "classes": true,
		"sections": true, "subjects": true, "class_subjects": true, "periods": true,
		"staff": true, "students": true, "grading": true, "fee_heads": true,
		"fee_structures": true, "exams": true, "udise": true,
	}
	for _, s := range st.Steps {
		if !known[s.Key] {
			t.Errorf("step %q has no wizard panel — it would render a dead end", s.Key)
		}
	}
	if len(st.Steps) != len(known) {
		t.Errorf("%d steps, %d panels", len(st.Steps), len(known))
	}
	if !st.Ready {
		t.Error("the demo school should already be operable")
	}
}

// A campus is the address on a transfer certificate. ensureCampus invented one
// called "Main Campus" and nothing could correct it.
func TestCampusCanBeNamedAndCorrected(t *testing.T) {
	base := baseURL(t)
	admin := login(t, base, "institution_admin@vivencia.test")

	var list struct {
		Items []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"items"`
	}
	if code := getJSON(t, admin, base+"/api/v1/setup/campuses", &list); code != 200 {
		t.Fatalf("list campuses = %d", code)
	}
	if len(list.Items) == 0 {
		t.Fatal("no campus exists")
	}

	id := list.Items[0].ID
	if code := send(t, admin, http.MethodPut, base+"/api/v1/setup/campuses/"+id,
		map[string]any{"name": "Kompally Campus", "code": "KMP", "city": "Hyderabad",
			"state": "Telangana", "pincode": "500067"}, nil); code != 200 {
		t.Fatalf("rename campus = %d", code)
	}

	var after struct {
		Items []struct {
			Name string `json:"name"`
			City *string
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/setup/campuses", &after)
	if after.Items[0].Name != "Kompally Campus" {
		t.Errorf("campus name = %q, want the corrected one", after.Items[0].Name)
	}

	if code := send(t, admin, http.MethodPut,
		base+"/api/v1/setup/campuses/00000000-0000-0000-0000-000000000000",
		map[string]any{"name": "Ghost"}, nil); code != 404 {
		t.Errorf("editing a campus that does not exist = %d, want 404", code)
	}
}

/*
Roles.

	The escalation this covers was real and only stopped by accident: RLS
	refused the insert because a platform role has no institution, so the
	attempt surfaced as an opaque 500 rather than as a rule. A boundary
	enforced by a side effect is one refactor from not being enforced.
*/
func TestRoleGrantsRespectTheBoundary(t *testing.T) {
	base := baseURL(t)
	admin := login(t, base, "institution_admin@vivencia.test")

	var created struct {
		ID    string   `json:"id"`
		Roles []string `json:"roles"`
	}
	code := send(t, admin, http.MethodPost, base+"/api/v1/admin/users",
		map[string]any{"full_name": "Role Boundary Test",
			"email":     "boundary-" + randomSuffix() + "@vivencia.test",
			"role_keys": []string{"finance"}, "set_password": true}, &created)
	if code != 201 && code != 200 {
		t.Fatalf("create user = %d", code)
	}
	disposable(t, admin, base, created.ID)

	t.Run("a school admin cannot mint a platform operator", func(t *testing.T) {
		var e apiError
		got := send(t, admin, http.MethodPut,
			base+"/api/v1/admin/users/"+created.ID+"/roles",
			map[string]any{"role_keys": []string{"finance", "super_admin"}}, &e)
		if got != 403 {
			t.Fatalf("granting super_admin = %d, want 403 (500 means only RLS is stopping it)", got)
		}
	})

	t.Run("parent and student are derived, not granted", func(t *testing.T) {
		var e apiError
		if got := send(t, admin, http.MethodPut,
			base+"/api/v1/admin/users/"+created.ID+"/roles",
			map[string]any{"role_keys": []string{"finance", "parent"}}, &e); got != 403 {
			t.Errorf("granting parent = %d, want 403", got)
		}
	})

	t.Run("the picker never offers what it would refuse", func(t *testing.T) {
		var roles struct {
			Items []struct {
				Key string `json:"key"`
			} `json:"items"`
		}
		getJSON(t, admin, base+"/api/v1/admin/assignable-roles", &roles)
		for _, r := range roles.Items {
			switch r.Key {
			case "super_admin", "parent", "student":
				t.Errorf("assignable roles offers %q, which cannot be granted", r.Key)
			}
		}
	})
}

// One person, several roles — the school with a single maintainer. Both the
// preset and the individual path have to land on the same place.
func TestPresetsAndCheckboxesAgree(t *testing.T) {
	base := baseURL(t)
	admin := login(t, base, "institution_admin@vivencia.test")

	var presets struct {
		Items []struct {
			Key         string   `json:"key"`
			RoleKeys    []string `json:"role_keys"`
			Recommended bool     `json:"recommended"`
		} `json:"items"`
	}
	if code := getJSON(t, admin, base+"/api/v1/admin/role-presets", &presets); code != 200 {
		t.Fatalf("presets = %d", code)
	}

	var sole []string
	for _, p := range presets.Items {
		if p.Key == "sole_maintainer" {
			sole = p.RoleKeys
			if !p.Recommended {
				t.Error("the one-person-runs-everything preset should lead")
			}
		}
	}
	if len(sole) < 10 {
		t.Fatalf("sole maintainer preset holds %d roles, expected the full set", len(sole))
	}

	// The preset path.
	var viaPreset struct {
		ID    string   `json:"id"`
		Roles []string `json:"roles"`
	}
	send(t, admin, http.MethodPost, base+"/api/v1/admin/users",
		map[string]any{"full_name": "Preset Path", "email": "preset-" + randomSuffix() + "@vivencia.test",
			"role_keys": sole, "set_password": true}, &viaPreset)
	disposable(t, admin, base, viaPreset.ID)
	if len(viaPreset.Roles) != len(sole) {
		t.Errorf("preset produced %d roles, expected %d", len(viaPreset.Roles), len(sole))
	}

	// The individual path, ticking exactly the same boxes.
	var viaBoxes struct {
		ID    string   `json:"id"`
		Roles []string `json:"roles"`
	}
	send(t, admin, http.MethodPost, base+"/api/v1/admin/users",
		map[string]any{"full_name": "Checkbox Path", "email": "boxes-" + randomSuffix() + "@vivencia.test",
			"role_keys": sole, "set_password": true}, &viaBoxes)

	disposable(t, admin, base, viaBoxes.ID)
	if len(viaBoxes.Roles) != len(viaPreset.Roles) {
		t.Errorf("the two paths disagree: %d vs %d roles",
			len(viaBoxes.Roles), len(viaPreset.Roles))
	}

	// And adjusting away from a preset keeps working — the case the product
	// exists for, since the accountant who also runs the library is ordinary.
	if code := send(t, admin, http.MethodPut,
		base+"/api/v1/admin/users/"+viaBoxes.ID+"/roles",
		map[string]any{"role_keys": []string{"finance", "librarian"}}, nil); code != 200 {
		t.Fatalf("narrowing to a custom pair = %d", code)
	}
	var after struct {
		Roles []struct {
			Key string `json:"key"`
		} `json:"roles"`
	}
	getJSON(t, admin, base+"/api/v1/admin/users/"+viaBoxes.ID, &after)
	if len(after.Roles) != 2 {
		t.Errorf("after narrowing, %d roles remain, want 2", len(after.Roles))
	}
}

/*
Leave, and the queue it lands in.

	subject_kind is 'staff' in the check constraint and the handler wrote
	'employee'. It never fired because no teacher had an employees row to get
	that far — two latent bugs hiding each other.
*/
func TestStaffAndStudentLeaveReachTheSameQueue(t *testing.T) {
	base := baseURL(t)
	teacher := login(t, base, "faculty@vivencia.test")
	admin := login(t, base, "institution_admin@vivencia.test")

	var applied struct {
		ID     string  `json:"id"`
		Days   float64 `json:"days"`
		Status string  `json:"status"`
	}
	code := send(t, teacher, http.MethodPost, base+"/api/v1/workflow/leave",
		map[string]any{"from_date": "2026-09-01", "to_date": "2026-09-03",
			"reason": "Family function"}, &applied)
	if code != 201 && code != 200 {
		t.Fatalf("teacher applying for leave = %d (a 500 is the subject_kind "+
			"constraint; a 400 means they have no employee record)", code)
	}
	if applied.Days != 3 {
		t.Errorf("1 to 3 September counted as %v days, want 3", applied.Days)
	}
	if applied.Status != "pending" {
		t.Errorf("new leave is %q, want pending", applied.Status)
	}

	var inbox struct {
		Total  int            `json:"total"`
		ByKind map[string]int `json:"by_kind"`
		Items  []struct {
			ID        string `json:"id"`
			Kind      string `json:"kind"`
			Title     string `json:"title"`
			DecideURL string `json:"decide_url"`
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/workflow/approvals", &inbox)
	if inbox.Total == 0 {
		t.Fatal("the leave never reached the approvals queue")
	}

	var found string
	for _, it := range inbox.Items {
		if it.ID == applied.ID {
			found = it.DecideURL
			// The name comes from a COALESCE over two concat_ws calls, which
			// return '' rather than NULL — so an empty title means the wrong
			// branch won and the request shows up belonging to nobody.
			if it.Title == "" || it.Title[0] == ' ' {
				t.Errorf("approval title is missing the person: %q", it.Title)
			}
		}
	}
	if found == "" {
		t.Fatalf("the teacher's leave is not in the queue of %d items", inbox.Total)
	}

	if code := send(t, admin, http.MethodPost, base+found,
		map[string]any{"decision": "approved", "note": "Enjoy"}, nil); code != 200 {
		t.Fatalf("approving = %d", code)
	}

	var after struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/workflow/approvals", &after)
	for _, it := range after.Items {
		if it.ID == applied.ID {
			t.Error("an approved request is still sitting in the queue")
		}
	}
}

// A guardian may apply for their own child and nobody else's.
func TestParentLeaveIsLimitedToTheirOwnChild(t *testing.T) {
	base := baseURL(t)
	parent := login(t, base, "parent@vivencia.test")
	admin := login(t, base, "institution_admin@vivencia.test")

	var mine struct {
		Items []struct {
			StudentID string `json:"student_id"`
		} `json:"items"`
	}
	getJSON(t, parent, base+"/api/v1/portal/students", &mine)
	if len(mine.Items) == 0 {
		t.Skip("the demo parent has no children")
	}

	if code := send(t, parent, http.MethodPost, base+"/api/v1/workflow/leave",
		map[string]any{"student_id": mine.Items[0].StudentID,
			"from_date": "2026-09-05", "to_date": "2026-09-05",
			"reason": "Doctor appointment"}, nil); code != 201 && code != 200 {
		t.Fatalf("applying for their own child = %d", code)
	}

	// Someone else's child, found through an account that can see everyone.
	var all struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/students?limit=50", &all)
	own := map[string]bool{}
	for _, k := range mine.Items {
		own[k.StudentID] = true
	}
	for _, s := range all.Items {
		if own[s.ID] {
			continue
		}
		if code := send(t, parent, http.MethodPost, base+"/api/v1/workflow/leave",
			map[string]any{"student_id": s.ID, "from_date": "2026-09-05",
				"to_date": "2026-09-05", "reason": "Not my child"}, nil); code != 404 {
			t.Errorf("applying for an unrelated child = %d, want 404", code)
		}
		break
	}
}

/* Homework, from both ends of the same endpoint. */
func TestHomeworkReachesTheClassAndComesBack(t *testing.T) {
	base := baseURL(t)
	teacher := login(t, base, "faculty@vivencia.test")
	student := login(t, base, "student@vivencia.test")

	var sections struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, teacher, base+"/api/v1/academics/sections", &sections)
	var subjects struct {
		Items []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"items"`
	}
	getJSON(t, teacher, base+"/api/v1/academics/subjects", &subjects)
	if len(sections.Items) == 0 || len(subjects.Items) == 0 {
		t.Skip("the teacher has no section or subject to set work for")
	}

	title := "Exercise " + randomSuffix()
	var published struct {
		ID string `json:"id"`
	}
	// By subject, not by class_subject_id: a teacher knows they teach maths,
	// not the row that joins maths to a class.
	code := send(t, teacher, http.MethodPost, base+"/api/v1/homework",
		map[string]any{"section_id": sections.Items[0].ID,
			"subject_id": subjects.Items[0].ID, "title": title,
			"instructions": "Show every step.", "due_on": "2026-09-20"}, &published)
	if code != 201 && code != 200 {
		t.Fatalf("publishing homework = %d", code)
	}

	t.Run("a subject the class does not study is refused clearly", func(t *testing.T) {
		var e apiError
		got := send(t, teacher, http.MethodPost, base+"/api/v1/homework",
			map[string]any{"section_id": sections.Items[0].ID,
				"subject_id": "00000000-0000-0000-0000-000000000000",
				"title":      "Nonsense"}, &e)
		if got != 400 {
			t.Errorf("unknown subject = %d, want 400", got)
		}
	})

	type hw struct {
		ID          string `json:"id"`
		Title       string `json:"title"`
		Submitted   bool   `json:"submitted"`
		Submissions int    `json:"submissions"`
		Strength    int    `json:"strength"`
	}
	var studentView struct {
		Items []hw `json:"items"`
	}
	getJSON(t, student, base+"/api/v1/homework", &studentView)

	var target *hw
	for i := range studentView.Items {
		if studentView.Items[i].Title == title {
			target = &studentView.Items[i]
		}
	}
	if target == nil {
		t.Fatal("the work never reached the student's diary")
	}
	if target.Submitted {
		t.Error("brand-new homework is already marked as turned in")
	}
	if target.Strength == 0 {
		t.Error("class strength is zero, so the teacher's x/y count is meaningless")
	}

	// Submissions default to open. They used to default to closed, so a
	// teacher who did not know about the flag set work nobody could turn in.
	if code := send(t, student, http.MethodPost,
		base+"/api/v1/homework/"+target.ID+"/submit",
		map[string]any{"text_answer": "Done in the maths notebook."}, nil); code != 200 {
		t.Fatalf("turning it in = %d", code)
	}

	getJSON(t, student, base+"/api/v1/homework", &studentView)
	for _, h := range studentView.Items {
		if h.ID == target.ID {
			if !h.Submitted {
				t.Error("after submitting, the student is still shown as owing it")
			}
			if h.Submissions < 1 {
				t.Error("the submission count did not move")
			}
		}
	}
}

// Nothing that changes state may go unrecorded, and nothing secret may be
// recorded. Both halves matter: an audit trail that leaks passwords is worse
// than none.
func TestAuditTrailRecordsChangesWithoutSecrets(t *testing.T) {
	base := baseURL(t)
	admin := login(t, base, "institution_admin@vivencia.test")

	email := "audited-" + randomSuffix() + "@vivencia.test"
	var created struct {
		ID                string `json:"id"`
		TemporaryPassword string `json:"temporary_password"`
	}
	if code := send(t, admin, http.MethodPost, base+"/api/v1/admin/users",
		map[string]any{"full_name": "Audited Account", "email": email,
			"role_keys": []string{"finance"}, "set_password": true}, &created); code != 201 && code != 200 {
		t.Fatalf("create user = %d", code)
	}
	disposable(t, admin, base, created.ID)
	if created.TemporaryPassword == "" {
		t.Fatal("no temporary password was issued, so there is nothing to leak")
	}

	var trail struct {
		Items []struct {
			Action   string          `json:"action"`
			Entity   string          `json:"entity_type"`
			Actor    *string         `json:"actor"`
			Request  json.RawMessage `json:"request"`
			Response json.RawMessage `json:"response"`
		} `json:"items"`
	}
	if code := getJSON(t, admin, base+"/api/v1/admin/audit?limit=50", &trail); code != 200 {
		t.Fatalf("audit = %d", code)
	}

	var recorded bool
	for _, row := range trail.Items {
		if row.Action == "POST /api/v1/admin/users" {
			recorded = true
			if row.Actor == nil || *row.Actor == "" {
				t.Error("a change was recorded with nobody attached to it")
			}
		}
		for _, blob := range []json.RawMessage{row.Request, row.Response} {
			if bytes.Contains(blob, []byte(created.TemporaryPassword)) {
				t.Fatalf("the audit trail stored a live password in %s", row.Action)
			}
		}
	}
	if !recorded {
		t.Error("creating a user was not recorded in the audit trail")
	}

	t.Run("a teacher cannot read it", func(t *testing.T) {
		teacher := login(t, base, "faculty@vivencia.test")
		if code := status(t, teacher, base+"/api/v1/admin/audit"); code != 403 {
			t.Errorf("teacher reading the audit trail = %d, want 403", code)
		}
	})
}

// A teacher's reach comes from their assignments, so making someone class
// teacher of an existing section had to be possible — it could only be set at
// the moment the section was created, which is the one moment a school does
// not yet know who will take it.
func TestClassTeacherCanBeSetAfterTheFact(t *testing.T) {
	base := baseURL(t)
	admin := login(t, base, "institution_admin@vivencia.test")

	var sections struct {
		Items []struct {
			ID      string `json:"id"`
			ClassID string `json:"class_id"`
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/academics/sections", &sections)
	var teachers struct {
		Items []struct {
			UserID string `json:"user_id"`
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/timetable/teachers", &teachers)
	if len(sections.Items) == 0 || len(teachers.Items) == 0 {
		t.Skip("no sections or teachers in the dataset")
	}

	sec := sections.Items[0]
	if code := send(t, admin, http.MethodPost, base+"/api/v1/setup/class-teacher",
		map[string]any{"section_id": sec.ID, "teacher_user_id": teachers.Items[0].UserID},
		nil); code != 200 {
		t.Fatalf("assigning a class teacher = %d", code)
	}

	// Clearing it is how a school records that the class teacher has left
	// before the replacement is decided.
	if code := send(t, admin, http.MethodPost, base+"/api/v1/setup/class-teacher",
		map[string]any{"section_id": sec.ID, "teacher_user_id": ""}, nil); code != 200 {
		t.Errorf("clearing a class teacher = %d", code)
	}
	// Put it back so the checklist stays satisfied for other tests.
	send(t, admin, http.MethodPost, base+"/api/v1/setup/class-teacher",
		map[string]any{"section_id": sec.ID, "teacher_user_id": teachers.Items[0].UserID}, nil)

	var cs struct {
		Items []struct {
			SubjectName string `json:"subject_name"`
			Unassigned  int    `json:"sections_unassigned"`
		} `json:"items"`
	}
	if code := getJSON(t, admin,
		base+"/api/v1/setup/class-subjects?class_id="+sec.ClassID, &cs); code != 200 {
		t.Fatalf("class subjects = %d", code)
	}
	if len(cs.Items) == 0 {
		t.Error("the class has no subjects, so no teacher can be assigned to one")
	}
}

/*
A timetable that means "mine".

	listTimetableEntries had no scope at all: it returned every section's grid to
	whoever asked. In the demo that meant a Grade 6-A student opening "My
	timetable" saw Grade 6-B's week and none of their own, and a teacher's own
	timetable listed periods they do not teach. Nothing here is secret — a
	timetable goes on a noticeboard — but a screen labelled "mine" that shows
	somebody else's is simply wrong, and the same query feeds the attendance
	register.
*/
func TestTimetableShowsOnlyYourOwnSections(t *testing.T) {
	base := baseURL(t)

	type entry struct {
		SectionID   string `json:"section_id"`
		SectionName string `json:"section_name"`
		ClassName   string `json:"class_name"`
	}
	read := func(c *http.Client) []entry {
		var out struct {
			Items []entry `json:"items"`
		}
		if code := getJSON(t, c, base+"/api/v1/timetable/entries", &out); code != 200 {
			t.Fatalf("timetable = %d", code)
		}
		return out.Items
	}
	sectionsIn := func(rows []entry) map[string]bool {
		set := map[string]bool{}
		for _, e := range rows {
			set[e.SectionID] = true
		}
		return set
	}

	t.Run("a student sees their own section and no other", func(t *testing.T) {
		student := login(t, base, "student@vivencia.test")
		var mine struct {
			Items []struct {
				StudentID string `json:"student_id"`
			} `json:"items"`
		}
		getJSON(t, student, base+"/api/v1/portal/students", &mine)
		if len(mine.Items) == 0 {
			t.Skip("the demo student has no enrolment")
		}

		rows := read(student)
		if len(rows) == 0 {
			t.Skip("no timetable seeded for this student's section")
		}
		if n := len(sectionsIn(rows)); n != 1 {
			t.Errorf("a student's timetable spans %d sections, want exactly their own", n)
		}
	})

	t.Run("a teacher sees the sections they teach", func(t *testing.T) {
		teacher := login(t, base, "faculty@vivencia.test")
		var taught struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
		}
		getJSON(t, teacher, base+"/api/v1/academics/sections", &taught)
		allowed := map[string]bool{}
		for _, s := range taught.Items {
			allowed[s.ID] = true
		}

		for _, e := range read(teacher) {
			if !allowed[e.SectionID] {
				t.Errorf("teacher's timetable includes %s-%s, which is not theirs",
					e.ClassName, e.SectionName)
			}
		}
	})

	t.Run("the office still sees the whole grid", func(t *testing.T) {
		admin := login(t, base, "institution_admin@vivencia.test")
		student := login(t, base, "student@vivencia.test")
		whole, one := len(sectionsIn(read(admin))), len(sectionsIn(read(student)))
		if whole == 0 {
			t.Skip("no timetable in the dataset")
		}
		if whole <= one {
			t.Errorf("the office sees %d sections and a student %d — "+
				"scoping has been applied to the wrong side", whole, one)
		}
	})
}

// A platform operator holds no institution, which is what marks them as
// platform staff. The setup screens are listed under their role because
// standing a school up is their job, so they name the school they are in.
func TestPlatformOperatorMustNameASchool(t *testing.T) {
	base := baseURL(t)
	operator := login(t, base, "super_admin@vivencia.test")

	t.Run("without one, the answer says so rather than failing", func(t *testing.T) {
		var e apiError
		code := send(t, operator, http.MethodGet, base+"/api/v1/setup/status", nil, &e)
		if code != 400 {
			t.Fatalf("setup status with no school = %d, want 400 (500 means the "+
				"handler is still assuming an institution)", code)
		}
		if e.Error.Message == "" {
			t.Error("the refusal does not explain what to do")
		}
	})

	var schools struct {
		Items []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"items"`
	}
	if code := getJSON(t, operator, base+"/api/v1/admin/institutions", &schools); code != 200 {
		t.Fatalf("school list = %d", code)
	}
	if len(schools.Items) == 0 {
		t.Fatal("a platform operator can see no schools at all")
	}

	t.Run("naming one puts them inside it", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodGet, base+"/api/v1/setup/status", nil)
		req.Header.Set("X-Acting-Institution", schools.Items[0].ID)
		resp, err := operator.Do(req)
		if err != nil {
			t.Fatalf("acting request: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("acting as a school = %d", resp.StatusCode)
		}
	})

	t.Run("a school admin cannot borrow another school", func(t *testing.T) {
		admin := login(t, base, "institution_admin@vivencia.test")
		other := ""
		for _, s := range schools.Items {
			if s.Name != "" {
				other = s.ID
			}
		}
		var own, borrowed map[string]any
		getJSON(t, admin, base+"/api/v1/setup/institution", &own)

		req, _ := http.NewRequest(http.MethodGet, base+"/api/v1/setup/institution", nil)
		req.Header.Set("X-Acting-Institution", other)
		resp, err := admin.Do(req)
		if err != nil {
			t.Fatalf("borrow attempt: %v", err)
		}
		defer resp.Body.Close()
		_ = json.NewDecoder(resp.Body).Decode(&borrowed)

		if borrowed["name"] != own["name"] {
			t.Errorf("the header moved a school admin into %v; it must be ignored "+
				"for anyone whose institution comes from their session", borrowed["name"])
		}
	})
}

/*
The NEP Holistic Progress Card.

	Two properties matter more than the rest, and both are the kind that a
	screenshot would hide.

	The stage rule. CBSE forbids marks, percentage and rank below Class 6
	outright. A card that shows a Class 2 child a number is not a cosmetic
	defect, it is non-compliance — and it is exactly what happens when the
	grading path is shared and somebody adds a percentage "for completeness".

	The 360 loop. The teacher, the child and the guardian each file their own
	view. If the client could name the role, a parent could file the school's
	assessment, which would make the card worthless as a record.
*/
func TestHolisticProgressCard(t *testing.T) {
	base := baseURL(t)
	teacher := login(t, base, "faculty@vivencia.test")
	parent := login(t, base, "parent@vivencia.test")

	var competencies struct {
		Items []struct {
			ID     string `json:"id"`
			Domain string `json:"domain"`
			Code   string `json:"code"`
		} `json:"items"`
	}
	if code := getJSON(t, teacher, base+"/api/v1/hpc/competencies", &competencies); code != 200 {
		t.Fatalf("competencies = %d", code)
	}
	byDomain := map[string][]string{}
	for _, c := range competencies.Items {
		byDomain[c.Domain] = append(byDomain[c.Domain], c.ID)
	}
	for _, want := range []string{"cognitive", "affective", "psychomotor"} {
		if len(byDomain[want]) == 0 {
			t.Fatalf("no %s competencies seeded — the card has nothing to report", want)
		}
	}

	var mine struct {
		Items []struct {
			StudentID string `json:"student_id"`
		} `json:"items"`
	}
	getJSON(t, parent, base+"/api/v1/portal/students", &mine)
	if len(mine.Items) == 0 {
		t.Skip("the demo parent has no children")
	}
	child := mine.Items[0].StudentID

	t.Run("a teacher records the school's view", func(t *testing.T) {
		for _, id := range byDomain["cognitive"][:2] {
			if code := send(t, teacher, http.MethodPost, base+"/api/v1/hpc/observations",
				map[string]any{"student_id": child, "competency_id": id,
					"level": 3, "note": "Consistent this term."}, nil); code != 200 {
				t.Fatalf("recording an observation = %d", code)
			}
		}
	})

	t.Run("a guardian files their own view, not the school's", func(t *testing.T) {
		if code := send(t, parent, http.MethodPost, base+"/api/v1/hpc/observations",
			map[string]any{"student_id": child, "competency_id": byDomain["cognitive"][0],
				"observer_role": "parent", "level": 2, "note": "Shy at home."}, nil); code != 200 {
			t.Fatalf("parent's own view = %d", code)
		}
		// The whole integrity of the card rests on this refusal.
		if code := send(t, parent, http.MethodPost, base+"/api/v1/hpc/observations",
			map[string]any{"student_id": child, "competency_id": byDomain["cognitive"][1],
				"observer_role": "teacher", "level": 4}, nil); code != 403 {
			t.Errorf("parent filing the teacher's assessment = %d, want 403", code)
		}
	})

	t.Run("a guardian cannot rate another family's child", func(t *testing.T) {
		admin := login(t, base, "institution_admin@vivencia.test")
		var all struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
		}
		getJSON(t, admin, base+"/api/v1/students?limit=50", &all)
		own := map[string]bool{}
		for _, k := range mine.Items {
			own[k.StudentID] = true
		}
		for _, s := range all.Items {
			if own[s.ID] {
				continue
			}
			if code := send(t, parent, http.MethodPost, base+"/api/v1/hpc/observations",
				map[string]any{"student_id": s.ID, "competency_id": byDomain["affective"][0],
					"observer_role": "parent", "level": 4}, nil); code != 404 {
				t.Errorf("rating an unrelated child = %d, want 404", code)
			}
			break
		}
	})

	type card struct {
		Reporting struct {
			Stage   string `json:"stage"`
			Numeric bool   `json:"numeric_grades"`
			Scale   string `json:"scale"`
		} `json:"reporting"`
		Domains []struct {
			Domain       string `json:"domain"`
			Competencies []struct {
				Descriptor string `json:"descriptor"`
				Gap        bool   `json:"self_teacher_gap"`
				Views      []struct {
					Role  string `json:"role"`
					Level *int   `json:"level"`
				} `json:"views"`
			} `json:"competencies"`
		} `json:"domains"`
		Scholastic []struct{ Subject string } `json:"scholastic"`
		Percentage *float64                   `json:"percentage"`
		Grade      *string                    `json:"grade"`
		CGPA       *float64                   `json:"cgpa"`
		Incomplete []string                   `json:"incomplete"`
	}

	t.Run("every view is kept, none averaged away", func(t *testing.T) {
		var c card
		if code := getJSON(t, parent, base+"/api/v1/hpc/card?student_id="+child, &c); code != 200 {
			t.Fatalf("card = %d", code)
		}
		if len(c.Domains) != 3 {
			t.Fatalf("card has %d domains, want cognitive, affective and psychomotor", len(c.Domains))
		}
		var roles []string
		for _, d := range c.Domains {
			for _, comp := range d.Competencies {
				for _, v := range comp.Views {
					roles = append(roles, v.Role)
				}
			}
		}
		var sawTeacher, sawParent bool
		for _, r := range roles {
			sawTeacher = sawTeacher || r == "teacher"
			sawParent = sawParent || r == "parent"
		}
		if !sawTeacher || !sawParent {
			t.Errorf("the card collapsed the 360 views: saw %v", roles)
		}
	})

	// The compliance property. Runs against whichever stages the dataset has.
	t.Run("no numbers below Class 6, numbers above", func(t *testing.T) {
		admin := login(t, base, "institution_admin@vivencia.test")
		var all struct {
			Items []struct {
				ID        string `json:"id"`
				ClassName string `json:"class_name"`
			} `json:"items"`
		}
		getJSON(t, admin, base+"/api/v1/students?limit=100", &all)

		checked := 0
		for _, s := range all.Items {
			var c card
			if getJSON(t, admin, base+"/api/v1/hpc/card?student_id="+s.ID, &c) != 200 {
				continue
			}
			checked++
			switch c.Reporting.Stage {
			case "foundational", "preparatory":
				if c.Reporting.Numeric {
					t.Errorf("%s (%s): numeric grading allowed at %s — CBSE forbids it",
						s.ID, s.ClassName, c.Reporting.Stage)
				}
				if c.Percentage != nil || c.Grade != nil || c.CGPA != nil {
					t.Errorf("%s (%s) at %s carries a percentage/grade/CGPA; the card must be "+
						"descriptive only below Class 6", s.ID, s.ClassName, c.Reporting.Stage)
				}
				if len(c.Scholastic) != 0 {
					t.Errorf("%s (%s) at %s lists %d scholastic rows; there should be none",
						s.ID, s.ClassName, c.Reporting.Stage, len(c.Scholastic))
				}
			case "secondary", "senior_secondary":
				if !c.Reporting.Numeric {
					t.Errorf("%s (%s): numeric grading refused at %s",
						s.ID, s.ClassName, c.Reporting.Stage)
				}
			}
			if checked > 12 {
				break
			}
		}
		if checked == 0 {
			t.Skip("no student cards could be read")
		}
		t.Logf("    checked %d cards across stages", checked)
	})
}

/*
Metrics carry a period, and know which of them a period cannot apply to.

	Dashboards had their spans welded into the SQL, so every number was "today"
	or "this calendar month" and nothing said which. Two properties are worth
	holding onto now that they take a range.

	A range must actually change the flows. If the query ignores it, every
	preset returns the same figure and the picker is decoration.

	A range must never be applied to a level. Outstanding balance is true at an
	instant; "outstanding between June and August" is not a smaller number, it
	is a meaningless one, and a dashboard that quietly filters it is worse than
	one that cannot filter at all.
*/
func TestMetricsTakeADateRange(t *testing.T) {
	base := baseURL(t)
	admin := login(t, base, "institution_admin@vivencia.test")

	var presets struct {
		Items []struct {
			Value string `json:"value"`
			Group string `json:"group"`
		} `json:"items"`
		Default string `json:"default"`
	}
	if code := getJSON(t, admin, base+"/api/v1/date-ranges", &presets); code != 200 {
		t.Fatalf("date-ranges = %d", code)
	}
	if len(presets.Items) < 8 {
		t.Errorf("only %d presets offered; a school asks in three calendars",
			len(presets.Items))
	}
	// The academic year is not the financial year is not the calendar year,
	// and an Indian school asks in all three.
	want := map[string]bool{"today": false, "this_month": false,
		"this_year": false, "fin_year": false, "custom": false}
	for _, p := range presets.Items {
		if _, ok := want[p.Value]; ok {
			want[p.Value] = true
		}
	}
	for k, seen := range want {
		if !seen {
			t.Errorf("preset %q is missing", k)
		}
	}

	type kpis struct {
		Collected   int64    `json:"collected_paise"`
		Outstanding int64    `json:"outstanding_paise"`
		Defaulters  int      `json:"defaulters"`
		AsOf        []string `json:"as_of_now"`
		Range       struct {
			Period string `json:"period"`
			From   string `json:"from"`
			To     string `json:"to"`
			Label  string `json:"label"`
		} `json:"range"`
	}

	read := func(q string) kpis {
		var k kpis
		if code := getJSON(t, admin, base+"/api/v1/principal/dashboard?"+q, &k); code != 200 {
			t.Fatalf("dashboard?%s = %d", q, code)
		}
		return k
	}

	t.Run("each preset resolves to its own window", func(t *testing.T) {
		seen := map[string]string{}
		for _, p := range presets.Items {
			if p.Value == "custom" {
				continue
			}
			k := read("period=" + p.Value)
			if k.Range.Period != p.Value {
				t.Errorf("asked for %q, got %q", p.Value, k.Range.Period)
			}
			if k.Range.From == "" || k.Range.To == "" || k.Range.Label == "" {
				t.Errorf("%s resolved to an unlabelled window %q..%q",
					p.Value, k.Range.From, k.Range.To)
			}
			if k.Range.From > k.Range.To {
				t.Errorf("%s runs backwards: %s..%s", p.Value, k.Range.From, k.Range.To)
			}
			seen[p.Value] = k.Range.From + ".." + k.Range.To
		}
		// Today and the academic year must not be the same window, or the
		// resolver is ignoring the preset.
		if seen["today"] == seen["this_year"] {
			t.Errorf("today and this_year resolved identically (%s)", seen["today"])
		}
	})

	t.Run("a custom range is honoured", func(t *testing.T) {
		k := read("from=2026-06-01&to=2026-06-30")
		if k.Range.From != "2026-06-01" || k.Range.To != "2026-06-30" {
			t.Errorf("custom range came back as %s..%s", k.Range.From, k.Range.To)
		}
	})

	t.Run("levels ignore the range", func(t *testing.T) {
		short := read("period=today")
		long := read("period=this_year")
		if short.Outstanding != long.Outstanding {
			t.Errorf("outstanding balance changed with the period (%d vs %d) — a "+
				"balance is true at an instant, not for a window",
				short.Outstanding, long.Outstanding)
		}
		if short.Defaulters != long.Defaulters {
			t.Errorf("defaulter count changed with the period (%d vs %d)",
				short.Defaulters, long.Defaulters)
		}
		if len(short.AsOf) == 0 {
			t.Error("the response does not say which metrics are levels, so a " +
				"client cannot label them")
		}
	})

	t.Run("flows respond to the range", func(t *testing.T) {
		day := read("period=today")
		year := read("period=this_year")
		if year.Collected < day.Collected {
			t.Errorf("a year collected less than a day (%d < %d) — the range is "+
				"not reaching the query", year.Collected, day.Collected)
		}
	})
}
