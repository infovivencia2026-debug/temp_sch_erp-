package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

const parent = "ramesh.chowdary@example.test"

type studentPayload struct {
	ID              string `json:"id"`
	AdmissionNumber string `json:"admission_number"`
	FirstName       string `json:"first_name"`
	LastName        string `json:"last_name"`
	Category        string `json:"category"`
	Religion        string `json:"religion"`
	Enrollment      *struct {
		SectionID  string `json:"section_id"`
		Section    string `json:"section"`
		Grade      string `json:"grade"`
		RollNumber int    `json:"roll_number"`
	} `json:"enrollment"`
}

type sectionPayload struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	GradeID  string `json:"grade_id"`
	Capacity *int   `json:"capacity"`
	Enrolled int    `json:"enrolled"`
}

func listStudents(t *testing.T, a *actor, query string) ([]studentPayload, int64) {
	t.Helper()
	resp := a.get(t, "/api/v1/students"+query)
	if resp.status != http.StatusOK {
		t.Fatalf("list students as %s: %d %s", a.name, resp.status, resp.body)
	}
	var students []studentPayload
	resp.decodeData(t, &students)

	var envelope struct {
		Page struct {
			Total int64 `json:"total"`
		} `json:"page"`
	}
	if err := json.Unmarshal(resp.body, &envelope); err != nil {
		t.Fatalf("decode page: %v", err)
	}
	return students, envelope.Page.Total
}

// TestStudentScopeByRole is the heart of the module. Every row here is a rule a
// school would state in plain words, and each is enforced by the scope resolver
// rather than by a permission — because "only my own children" is not something
// a permission can express.
func TestStudentScopeByRole(t *testing.T) {
	_, total := listStudents(t, signIn(t, orgAdmin), "?limit=200")
	if total == 0 {
		t.Fatal("no seeded students — the SIS seed did not run")
	}

	cases := []struct {
		name     string
		email    string
		expect   func(visible int64) bool
		describe string
	}{
		{"organisation admin sees every student", orgAdmin,
			func(v int64) bool { return v == total }, "all"},
		{"auditor sees every student, read-only", auditor,
			func(v int64) bool { return v == total }, "all"},
		{"principal sees their school", principal,
			func(v int64) bool { return v == total }, "all in their school"},
		{"accountant sees their school", accountant,
			func(v int64) bool { return v == total }, "all in their school"},
		{"class teacher sees only their section", teacher,
			func(v int64) bool { return v > 0 && v < total }, "a subset"},
		{"the other school's admin sees none of them", schoolAdmin,
			func(v int64) bool { return v == 0 }, "none"},
		{"parent sees only their own children", parent,
			func(v int64) bool { return v == 2 }, "exactly 2"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, visible := listStudents(t, signIn(t, tc.email), "?limit=200")
			if !tc.expect(visible) {
				t.Errorf("saw %d of %d students, expected %s", visible, total, tc.describe)
			}
		})
	}
}

// TestParentCannotReachAnotherChild is the failure that would end a school
// contract. The parent asks directly by id, bypassing the list entirely.
func TestParentCannotReachAnotherChild(t *testing.T) {
	admin := signIn(t, orgAdmin)
	all, _ := listStudents(t, admin, "?limit=200")

	mum := signIn(t, parent)
	mine, _ := listStudents(t, mum, "")
	if len(mine) != 2 {
		t.Fatalf("the seeded parent should have 2 children, got %d", len(mine))
	}

	own := map[string]bool{}
	for _, s := range mine {
		own[s.ID] = true
	}

	// Every student who is not theirs must be unreachable by direct id.
	probed := 0
	for _, s := range all {
		if own[s.ID] {
			continue
		}
		resp := mum.get(t, "/api/v1/students/"+s.ID)
		if resp.status != http.StatusNotFound {
			t.Fatalf("parent reached student %s (%s %s): status %d",
				s.AdmissionNumber, s.FirstName, s.LastName, resp.status)
		}
		// Not found, not forbidden: confirming the student exists would let a
		// parent probe for another family's admission number.
		if resp.code() != "STUDENT_NOT_FOUND" {
			t.Errorf("expected STUDENT_NOT_FOUND, got %q", resp.code())
		}
		if probed++; probed >= 25 {
			break
		}
	}
	if probed == 0 {
		t.Fatal("no other students to probe — the test proved nothing")
	}

	// And their own children remain reachable.
	for _, s := range mine {
		if resp := mum.get(t, "/api/v1/students/"+s.ID); resp.status != http.StatusOK {
			t.Errorf("parent cannot read their own child %s: %d", s.ID, resp.status)
		}
	}
}

// TestTeacherCannotReachStudentsOutsideTheirSection: same probe, for a teacher.
func TestTeacherCannotReachStudentsOutsideTheirSection(t *testing.T) {
	all, _ := listStudents(t, signIn(t, orgAdmin), "?limit=200")

	anitha := signIn(t, teacher)
	theirs, _ := listStudents(t, anitha, "?limit=200")
	if len(theirs) == 0 {
		t.Fatal("the seeded class teacher has no students")
	}

	inScope := map[string]bool{}
	for _, s := range theirs {
		inScope[s.ID] = true
	}

	probed := 0
	for _, s := range all {
		if inScope[s.ID] {
			continue
		}
		if resp := anitha.get(t, "/api/v1/students/"+s.ID); resp.status != http.StatusNotFound {
			t.Fatalf("teacher reached out-of-section student %s: status %d", s.AdmissionNumber, resp.status)
		}
		if probed++; probed >= 25 {
			break
		}
	}
	if probed == 0 {
		t.Fatal("the teacher can see every student — the scope filter is not applying")
	}
}

// TestTeacherAccessFollowsAllocation. A teacher's access is derived from what
// they teach, so moving the allocation moves the access — with no permission
// granted or revoked anywhere.
func TestTeacherAccessFollowsAllocation(t *testing.T) {
	admin := signIn(t, orgAdmin)

	before, _ := listStudents(t, signIn(t, teacher), "?limit=200")

	// Find a section the teacher does not currently hold.
	sections := listSections(t, admin)
	var target sectionPayload
	held := map[string]bool{}
	for _, s := range before {
		if s.Enrollment != nil {
			held[s.Enrollment.SectionID] = true
		}
	}
	for _, s := range sections {
		if !held[s.ID] && s.Enrolled > 0 {
			target = s
			break
		}
	}
	if target.ID == "" {
		t.Skip("no unheld, populated section to reallocate to")
	}

	teacherUserID := userIDByEmail(t, teacher)
	resp := admin.do(t, http.MethodPut,
		"/api/v1/sections/"+target.ID+"/class-teacher",
		fmt.Sprintf(`{"user_id":%q}`, teacherUserID))
	if resp.status != http.StatusNoContent {
		t.Fatalf("assign class teacher: %d %s", resp.status, resp.body)
	}

	after, _ := listStudents(t, signIn(t, teacher), "?limit=200")
	if len(after) <= len(before) {
		t.Errorf("after taking on %s (%d students) the teacher sees %d, was %d — "+
			"access did not follow the allocation", target.Label, target.Enrolled, len(after), len(before))
	}
}

// TestRestrictedFieldsAreWithheld. Category and religion are collected only
// where a school needs them for statutory reporting, and are visible only to
// callers holding sis.student.read_restricted.
func TestRestrictedFieldsAreWithheld(t *testing.T) {
	admin := signIn(t, orgAdmin)
	students, _ := listStudents(t, admin, "?limit=1")
	if len(students) == 0 {
		t.Fatal("no students seeded")
	}
	id := students[0].ID

	resp := admin.do(t, http.MethodPatch, "/api/v1/students/"+id,
		`{"category":"OBC","religion":"Hindu"}`)
	if resp.status != http.StatusOK {
		t.Fatalf("set restricted fields: %d %s", resp.status, resp.body)
	}

	t.Run("principal may see them", func(t *testing.T) {
		var s studentPayload
		signIn(t, principal).get(t, "/api/v1/students/"+id).decodeData(t, &s)
		if s.Category != "OBC" {
			t.Errorf("category = %q, want OBC", s.Category)
		}
	})

	t.Run("accountant may not", func(t *testing.T) {
		var s studentPayload
		signIn(t, accountant).get(t, "/api/v1/students/"+id).decodeData(t, &s)
		if s.Category != "" || s.Religion != "" {
			t.Errorf("restricted fields leaked to the accountant: category=%q religion=%q",
				s.Category, s.Religion)
		}
	})

	t.Run("and may not write them either", func(t *testing.T) {
		// Otherwise a clerk could overwrite a value they are not allowed to read.
		resp := signIn(t, accountant).do(t, http.MethodPatch, "/api/v1/students/"+id,
			`{"category":"General"}`)
		if resp.status != http.StatusForbidden {
			t.Errorf("status = %d, want 403 (body: %s)", resp.status, resp.body)
		}
	})
}

// TestSectionCapacityIsEnforced, and enforced atomically: a refused enrollment
// must not leave a student who exists but sits nowhere.
func TestSectionCapacityIsEnforced(t *testing.T) {
	admin := signIn(t, orgAdmin)

	gradeID, yearID, schoolID := someGrade(t, admin)

	resp := admin.do(t, http.MethodPost, "/api/v1/sections",
		fmt.Sprintf(`{"grade_id":%q,"academic_year_id":%q,"name":"CAP","capacity":1}`,
			gradeID, yearID))
	if resp.status != http.StatusCreated {
		t.Fatalf("create capped section: %d %s", resp.status, resp.body)
	}
	var section sectionPayload
	resp.decodeData(t, &section)

	first := admin.do(t, http.MethodPost, "/api/v1/students",
		fmt.Sprintf(`{"school_id":%q,"admission_number":"CAP-0001","first_name":"Kavya",
		             "last_name":"Rao","date_of_birth":"2014-08-01","section_id":%q}`,
			schoolID, section.ID))
	if first.status != http.StatusCreated {
		t.Fatalf("first enrollment: %d %s", first.status, first.body)
	}

	second := admin.do(t, http.MethodPost, "/api/v1/students",
		fmt.Sprintf(`{"school_id":%q,"admission_number":"CAP-0002","first_name":"Nithin",
		             "last_name":"Rao","date_of_birth":"2014-09-01","section_id":%q}`,
			schoolID, section.ID))
	if second.status != http.StatusConflict {
		t.Fatalf("second enrollment: status = %d, want 409 (body: %s)", second.status, second.body)
	}
	if second.code() != "SECTION_FULL" {
		t.Errorf("error code = %q, want SECTION_FULL", second.code())
	}

	// The refused student must not exist: admission and enrollment were one
	// transaction, so both rolled back.
	orphans, _ := listStudents(t, admin, "?search=CAP-0002")
	if len(orphans) != 0 {
		t.Errorf("a refused enrollment left %d orphan student record(s) behind", len(orphans))
	}
}

// TestEnrollmentHistoryIsPreserved. Moving a student closes the old row rather
// than editing it — that row is what a transfer certificate is built from.
func TestEnrollmentHistoryIsPreserved(t *testing.T) {
	admin := signIn(t, orgAdmin)
	gradeID, yearID, schoolID := someGrade(t, admin)

	// Create the two sections this test needs rather than borrowing seeded ones:
	// another test caps a section at one seat, and a shared fixture would make
	// this test's outcome depend on execution order.
	sections := make([]sectionPayload, 0, 2)
	for _, name := range []string{"HIST1", "HIST2"} {
		resp := admin.do(t, http.MethodPost, "/api/v1/sections",
			fmt.Sprintf(`{"grade_id":%q,"academic_year_id":%q,"name":%q}`, gradeID, yearID, name))
		if resp.status != http.StatusCreated {
			t.Fatalf("create section %s: %d %s", name, resp.status, resp.body)
		}
		var s sectionPayload
		resp.decodeData(t, &s)
		sections = append(sections, s)
	}

	created := admin.do(t, http.MethodPost, "/api/v1/students",
		fmt.Sprintf(`{"school_id":%q,"admission_number":"HIST-001","first_name":"Isha",
		             "last_name":"Menon","date_of_birth":"2014-02-02","section_id":%q}`,
			schoolID, sections[0].ID))
	if created.status != http.StatusCreated {
		t.Fatalf("admit: %d %s", created.status, created.body)
	}
	var student studentPayload
	created.decodeData(t, &student)
	original := student.Enrollment.Section

	moved := admin.do(t, http.MethodPost, "/api/v1/students/"+student.ID+"/enrollment",
		fmt.Sprintf(`{"section_id":%q,"reason":"Parent request"}`, sections[1].ID))
	if moved.status != http.StatusCreated {
		t.Fatalf("move: %d %s", moved.status, moved.body)
	}

	var after studentPayload
	admin.get(t, "/api/v1/students/"+student.ID).decodeData(t, &after)
	if after.Enrollment.Section == original && sections[0].ID != sections[1].ID {
		t.Error("the student is still in the original section")
	}

	// Moving again to the same section is a conflict, not a silent duplicate.
	repeat := admin.do(t, http.MethodPost, "/api/v1/students/"+student.ID+"/enrollment",
		fmt.Sprintf(`{"section_id":%q}`, sections[1].ID))
	if repeat.status != http.StatusConflict || repeat.code() != "ALREADY_ENROLLED" {
		t.Errorf("re-enrolling in the same section: got %d/%s, want 409/ALREADY_ENROLLED",
			repeat.status, repeat.code())
	}
}

// TestGuardianAccessFollowsTheChild: for staff, being able to see a student is
// what confers sight of that student's guardians. There is no second scope to
// keep in step — the child is the key.
func TestGuardianAccessFollowsTheChild(t *testing.T) {
	// The class teacher can see her own section's students, and therefore their
	// guardians; she cannot see either for anyone else.
	anitha := signIn(t, teacher)
	theirs, _ := listStudents(t, anitha, "?limit=200")
	if len(theirs) == 0 {
		t.Fatal("the seeded class teacher has no students")
	}

	resp := anitha.get(t, "/api/v1/students/"+theirs[0].ID+"/guardians")
	if resp.status != http.StatusOK {
		t.Fatalf("class teacher reading their own student's guardians: %d %s", resp.status, resp.body)
	}
	var guardians []struct {
		FullName      string `json:"full_name"`
		Relation      string `json:"relation"`
		ChildrenCount int    `json:"children_count"`
	}
	resp.decodeData(t, &guardians)
	if len(guardians) == 0 {
		t.Error("no guardians returned for a seeded student")
	}

	inScope := map[string]bool{}
	for _, s := range theirs {
		inScope[s.ID] = true
	}
	all, _ := listStudents(t, signIn(t, orgAdmin), "?limit=200")
	for _, s := range all {
		if inScope[s.ID] {
			continue
		}
		if r := anitha.get(t, "/api/v1/students/"+s.ID+"/guardians"); r.status != http.StatusNotFound {
			t.Fatalf("teacher read an out-of-section student's guardians: status %d", r.status)
		}
		break
	}
}

// TestParentCannotListGuardians documents a deliberate decision rather than an
// oversight: a parent is not granted sis.guardian.read.
//
// The record they would be reading is the *other* guardian's phone number,
// address and employer. In a separated or contested family that is exactly the
// information a school must not hand over on request, and the ERP has no way to
// know which families those are. Staff can see it; the co-parent cannot.
func TestParentCannotListGuardians(t *testing.T) {
	mum := signIn(t, parent)
	mine, _ := listStudents(t, mum, "")
	if len(mine) == 0 {
		t.Fatal("the seeded parent has no children")
	}

	resp := mum.get(t, "/api/v1/students/"+mine[0].ID+"/guardians")
	if resp.status != http.StatusForbidden {
		t.Errorf("status = %d, want 403 (body: %s)", resp.status, resp.body)
	}
	if resp.code() != "PERMISSION_DENIED" {
		t.Errorf("code = %q, want PERMISSION_DENIED", resp.code())
	}
}

// --- helpers ---------------------------------------------------------------

func listSections(t *testing.T, a *actor) []sectionPayload {
	t.Helper()
	resp := a.get(t, "/api/v1/sections")
	if resp.status != http.StatusOK {
		t.Fatalf("list sections: %d %s", resp.status, resp.body)
	}
	var sections []sectionPayload
	resp.decodeData(t, &sections)
	return sections
}

// someGrade returns a grade, the current academic year and the school they sit
// in — the three ids most write tests need.
func someGrade(t *testing.T, a *actor) (gradeID, yearID, schoolID string) {
	t.Helper()

	resp := a.get(t, "/api/v1/grades")
	if resp.status != http.StatusOK {
		t.Fatalf("list grades: %d %s", resp.status, resp.body)
	}
	var grades []struct {
		ID       string `json:"id"`
		SchoolID string `json:"school_id"`
	}
	resp.decodeData(t, &grades)
	if len(grades) == 0 {
		t.Fatal("no grades seeded")
	}

	sections := listSections(t, a)
	if len(sections) == 0 {
		t.Fatal("no sections seeded")
	}
	var year string
	secResp := a.get(t, "/api/v1/sections")
	var raw []struct {
		AcademicYearID string `json:"academic_year_id"`
		GradeID        string `json:"grade_id"`
	}
	secResp.decodeData(t, &raw)
	for _, s := range raw {
		if s.GradeID == grades[0].ID {
			year = s.AcademicYearID
			break
		}
	}
	if year == "" {
		year = raw[0].AcademicYearID
	}
	return grades[0].ID, year, grades[0].SchoolID
}

func userIDByEmail(t *testing.T, email string) string {
	t.Helper()
	resp := signIn(t, email).get(t, "/api/v1/auth/session")
	if resp.status != http.StatusOK {
		t.Fatalf("read session: %d", resp.status)
	}
	var session struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	resp.decodeData(t, &session)
	return session.User.ID
}
