package api

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Two kinds of test, following hr_growth_test.go.

	The first drives the router mountClassroom actually builds and needs no
	database, so a route added later without a gate fails here rather than in
	production. The second needs a real Postgres and is skipped without
	TEST_DATABASE_URL, because everything worth testing in this file is SQL
	under row level security plus a grading function, and a fake would only
	prove the fake works.
*/

func mountedClassroom(s *Server, id *httpx.Identity) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) { s.mountClassroom(r) })
	return r
}

// A caller holding nothing reaches none of it, reads included. A child's
// portfolio, a register and an answer key are not public.
func TestClassroomRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedClassroom(&Server{}, identityWith())
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/classroom/languages/options"},
		{http.MethodPost, "/classroom/languages/options"},
		{http.MethodGet, "/classroom/languages/allocation"},
		{http.MethodPost, "/classroom/languages/elections"},
		{http.MethodGet, "/classroom/portfolio/" + uuid.NewString()},
		{http.MethodPost, "/classroom/portfolio/curations"},
		{http.MethodGet, "/classroom/montessori/materials"},
		{http.MethodPost, "/classroom/montessori/progress"},
		{http.MethodGet, "/classroom/attendance/conflicts"},
		{http.MethodPost, "/classroom/attendance/capture"},
		{http.MethodGet, "/classroom/diary"},
		{http.MethodPost, "/classroom/diary"},
		{http.MethodGet, "/classroom/grading/tests"},
		{http.MethodGet, "/classroom/grading/tests/" + uuid.NewString() + "/item-analysis"},
		{http.MethodPost, "/classroom/grading/tests/" + uuid.NewString() + "/attempts"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: want 403, got %d", tc.method, tc.path, got)
		}
	}
}

/*
The opener is not the writer.

	academics.timetable.read is held by students. Every write in this file
	therefore names a second permission, and this asserts each one is actually
	on the route rather than assumed — the failure mode being a child with a
	portal login marking their own register.
*/
func TestClassroomReadPermissionDoesNotCarryAnyWrite(t *testing.T) {
	h := mountedClassroom(&Server{}, identityWith(rbac.TimetableRead))
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/classroom/languages/options"},
		{http.MethodPost, "/classroom/languages/elections"},
		{http.MethodPost, "/classroom/portfolio/curations"},
		{http.MethodPost, "/classroom/montessori/materials"},
		{http.MethodPost, "/classroom/montessori/progress"},
		{http.MethodPost, "/classroom/attendance/capture"},
		{http.MethodPost, "/classroom/attendance/conflicts/" + uuid.NewString() + "/resolve"},
		{http.MethodPost, "/classroom/diary"},
		{http.MethodPost, "/classroom/grading/tests/" + uuid.NewString() + "/attempts"},
		{http.MethodPost, "/classroom/grading/tests/" + uuid.NewString() + "/regrade"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: want 403 for a read-only caller, got %d", tc.method, tc.path, got)
		}
	}
}

// The permissions a teacher actually holds do open the writes they are
// entitled to. The mirror of the test above: gating on something no teaching
// role holds would leave these screens reachable by nobody.
func TestClassroomTeacherPermissionsOpenTheirOwnWrites(t *testing.T) {
	h := mountedClassroom(&Server{}, identityWith(rbac.TimetableRead,
		rbac.AttendanceWrite, rbac.HomeworkWrite, rbac.MarksWrite, rbac.DisciplineWrite))
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/classroom/attendance/capture"},
		{http.MethodPost, "/classroom/diary"},
		{http.MethodPost, "/classroom/portfolio/curations"},
		{http.MethodPost, "/classroom/montessori/progress"},
		{http.MethodPost, "/classroom/grading/tests/" + uuid.NewString() + "/attempts"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s: a teacher was refused their own screen", tc.method, tc.path)
		}
	}
}

// --- with a database --------------------------------------------------------

type classroomSchool struct {
	db       *database.DB
	inst     uuid.UUID
	campus   uuid.UUID
	year     uuid.UUID
	class    uuid.UUID
	section  uuid.UUID
	subject  uuid.UUID
	classSub uuid.UUID
	teacher  uuid.UUID
	office   uuid.UUID
	students []uuid.UUID
	test     uuid.UUID
	testQs   []uuid.UUID
	// The right option for each test question, in the same order.
	correct []uuid.UUID
	wrong   []uuid.UUID
}

func (sc *classroomSchool) tx(t *testing.T, fn func(tx pgx.Tx) error) {
	t.Helper()
	if err := sc.db.InTenant(context.Background(),
		database.Scope{InstitutionID: sc.inst}, fn); err != nil {
		t.Fatalf("tenant query: %v", err)
	}
}

func (sc *classroomSchool) as(user uuid.UUID, perms ...string) *httpx.Identity {
	set := map[string]struct{}{}
	for _, p := range perms {
		set[p] = struct{}{}
	}
	return &httpx.Identity{UserID: user, InstitutionID: sc.inst, Permissions: set}
}

// newClassroomSchool builds one section of four children, one subject taught by
// one teacher, and a three-question objective test with a key.
func newClassroomSchool(t *testing.T) *classroomSchool {
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

	sc := &classroomSchool{db: db}
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO institutions (name, short_name, slug)
			VALUES ('Classroom Test','Class',$1) RETURNING id`,
			"cl-"+uuid.NewString()[:8]).Scan(&sc.inst)
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
			INSERT INTO classes (institution_id, campus_id, name, level)
			VALUES ($1,$2,'Grade 6',6) RETURNING id`,
			sc.inst, sc.campus).Scan(&sc.class); err != nil {
			return err
		}
		for _, u := range []struct {
			into  *uuid.UUID
			email string
			name  string
		}{
			{&sc.teacher, "teacher@classroom.test", "Asha"},
			{&sc.office, "office@classroom.test", "Front Desk"},
		} {
			if err := tx.QueryRow(ctx, `
				INSERT INTO users (institution_id, email, full_name, status)
				VALUES ($1,$2::citext,$3,'active') RETURNING id`,
				sc.inst, u.email, u.name).Scan(u.into); err != nil {
				return err
			}
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO sections (institution_id, campus_id, class_id, academic_year_id,
			        name, class_teacher_id)
			VALUES ($1,$2,$3,$4,'6-A',$5) RETURNING id`,
			sc.inst, sc.campus, sc.class, sc.year, sc.teacher).Scan(&sc.section); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO subjects (institution_id, campus_id, name, code)
			VALUES ($1,$2,'Science','SCI') RETURNING id`,
			sc.inst, sc.campus).Scan(&sc.subject); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO class_subjects (institution_id, class_id, subject_id)
			VALUES ($1,$2,$3) RETURNING id`,
			sc.inst, sc.class, sc.subject).Scan(&sc.classSub); err != nil {
			return err
		}
		for i := 0; i < 4; i++ {
			var st uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO students (institution_id, campus_id, admission_no, first_name)
				VALUES ($1,$2,$3,$4) RETURNING id`,
				sc.inst, sc.campus, fmt.Sprintf("A-%03d", i+1),
				fmt.Sprintf("Child%d", i+1)).Scan(&st); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO enrollments (institution_id, student_id, academic_year_id,
				        class_id, section_id, status)
				VALUES ($1,$2,$3,$4,$5,'active')`,
				sc.inst, st, sc.year, sc.class, sc.section); err != nil {
				return err
			}
			sc.students = append(sc.students, st)
		}

		// A three-question objective paper, one mark each with quarter-mark
		// negative marking, keyed to option A every time so the assertions
		// below can be read without a table of answers.
		if err := tx.QueryRow(ctx, `
			INSERT INTO online_tests (institution_id, section_id, class_subject_id,
			        title, status)
			VALUES ($1,$2,$3,'Unit Test 1','published') RETURNING id`,
			sc.inst, sc.section, sc.classSub).Scan(&sc.test); err != nil {
			return err
		}
		for i := 1; i <= 3; i++ {
			var q uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO question_bank_questions (institution_id, class_subject_id,
				        kind, stem, default_marks)
				VALUES ($1,$2,'mcq',$3,1) RETURNING id`,
				sc.inst, sc.classSub, fmt.Sprintf("Question %d", i)).Scan(&q); err != nil {
				return err
			}
			var right, wrong uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO question_bank_options (institution_id, question_id, sequence,
				        body, is_correct)
				VALUES ($1,$2,1,'A',true) RETURNING id`, sc.inst, q).Scan(&right); err != nil {
				return err
			}
			if err := tx.QueryRow(ctx, `
				INSERT INTO question_bank_options (institution_id, question_id, sequence,
				        body, is_correct)
				VALUES ($1,$2,2,'B',false) RETURNING id`, sc.inst, q).Scan(&wrong); err != nil {
				return err
			}
			var tq uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO online_test_questions (institution_id, test_id, question_id,
				        sequence, marks, negative_marks)
				VALUES ($1,$2,$3,$4,1,0.25) RETURNING id`,
				sc.inst, sc.test, q, i).Scan(&tq); err != nil {
				return err
			}
			sc.testQs = append(sc.testQs, tq)
			sc.correct = append(sc.correct, right)
			sc.wrong = append(sc.wrong, wrong)
		}
		// The teacher teaches the section, which is what resolveScope reads.
		_, err := tx.Exec(ctx, `
			INSERT INTO section_subject_teachers (institution_id, section_id,
			        class_subject_id, teacher_user_id)
			VALUES ($1,$2,$3,$4)`, sc.inst, sc.section, sc.classSub, sc.teacher)
		return err
	})
	return sc
}

/*
Grading a hand-entered script: the three rules that matter.

	One child answers everything right, one everything wrong, one leaves the
	paper blank. The assertions are the ones an Indian objective paper turns on:
	full marks for the first, negative marking applied to the second, and NOT
	applied to the third — an unanswered question is not a wrong answer, and the
	whole reason an empty selection and a missing row are different rows in the
	schema is to keep that true.
*/
func TestNoOMRGradingAppliesNegativeMarkingButNotToBlanks(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	h := mountedClassroom(s, sc.as(sc.teacher, rbac.TimetableRead, rbac.HomeworkWrite))

	sheet := func(student uuid.UUID, opts []uuid.UUID) string {
		body := fmt.Sprintf(`{"student_id":%q,"responses":[`, student)
		for i, tq := range sc.testQs {
			if i > 0 {
				body += ","
			}
			body += fmt.Sprintf(`{"test_question_id":%q,"selected_option_ids":[%q]}`,
				tq, opts[i])
		}
		return body + "]}"
	}

	code, top := callJSON(t, h, "POST",
		"/classroom/grading/tests/"+sc.test.String()+"/attempts",
		sheet(sc.students[0], sc.correct))
	if code != http.StatusOK {
		t.Fatalf("all-correct sheet: %d %v", code, top)
	}
	if got := top["score"].(float64); got != 3 {
		t.Errorf("all correct: want 3, got %v", got)
	}

	code, bottom := callJSON(t, h, "POST",
		"/classroom/grading/tests/"+sc.test.String()+"/attempts",
		sheet(sc.students[1], sc.wrong))
	if code != http.StatusOK {
		t.Fatalf("all-wrong sheet: %d %v", code, bottom)
	}
	// Three wrong at a quarter mark each is -0.75, floored to zero on the
	// attempt total; the per-question awards keep the sign.
	if got := bottom["score"].(float64); got != 0 {
		t.Errorf("all wrong: want a floored 0, got %v", got)
	}
	if got := bottom["wrong"].(float64); got != 3 {
		t.Errorf("all wrong: want 3 wrong, got %v", got)
	}

	// A blank script: responses posted with nothing selected.
	blank := fmt.Sprintf(`{"student_id":%q,"responses":[`, sc.students[2])
	for i, tq := range sc.testQs {
		if i > 0 {
			blank += ","
		}
		blank += fmt.Sprintf(`{"test_question_id":%q,"selected_option_ids":[]}`, tq)
	}
	blank += "]}"
	code, empty := callJSON(t, h, "POST",
		"/classroom/grading/tests/"+sc.test.String()+"/attempts", blank)
	if code != http.StatusOK {
		t.Fatalf("blank sheet: %d %v", code, empty)
	}
	if got := empty["score"].(float64); got != 0 {
		t.Errorf("blank: want 0, got %v", got)
	}
	if got := empty["unattempted"].(float64); got != 3 {
		t.Errorf("blank: want 3 unattempted, got %v", got)
	}
	if got := empty["wrong"].(float64); got != 0 {
		t.Errorf("blank: a blank must not be marked wrong, got %v wrong", got)
	}

	// And the analysis reads the paper rather than the class.
	code, body := callJSON(t, h, "GET",
		"/classroom/grading/tests/"+sc.test.String()+"/item-analysis", "")
	if code != http.StatusOK {
		t.Fatalf("item analysis: %d %v", code, body)
	}
	if n := len(itemsOf(body)); n != 3 {
		t.Fatalf("item analysis: want a row per question, got %d", n)
	}
	first := itemsOf(body)[0].(map[string]any)
	if first["attempted"].(float64) != 2 {
		t.Errorf("attempted should exclude the blank script, got %v", first["attempted"])
	}
	if first["facility"].(float64) != 0.5 {
		t.Errorf("facility should be over attempters, got %v", first["facility"])
	}
}

/*
A teacher may not grade another teacher's paper.

	The router's permission is held by every teacher in the school, so the only
	thing standing between one and another's section is resolveScope. This is
	the test that would have caught hr_lifecycle.go.
*/
func TestClassroomRefusesATestOutsideTheCallersSections(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	// The office user teaches nothing at all.
	h := mountedClassroom(s, sc.as(sc.office, rbac.TimetableRead, rbac.HomeworkWrite))

	if code, body := callJSON(t, h, "GET",
		"/classroom/grading/tests/"+sc.test.String()+"/key", ""); code != http.StatusForbidden {
		t.Errorf("answer key for a stranger's test: want 403, got %d %v", code, body)
	}
	if code, body := callJSON(t, h, "GET",
		"/classroom/portfolio/"+sc.students[0].String(), ""); code != http.StatusForbidden {
		t.Errorf("portfolio of a child they do not teach: want 403, got %d %v", code, body)
	}
	code, body := callJSON(t, h, "GET", "/classroom/grading/tests", "")
	if code != http.StatusOK {
		t.Fatalf("list: %d %v", code, body)
	}
	if n := len(itemsOf(body)); n != 0 {
		t.Errorf("a caller with no sections must see no tests, saw %d", n)
	}
}

/*
The offline register: replay is safe, and somebody else's row is never
overwritten.

	Three assertions, in the order they matter. A batch applied twice writes
	once. A row the office entered while the device was out of signal survives
	the sync and comes back as a conflict with both values on it. And resolving
	that conflict as 'applied' goes through the register's own correction
	columns rather than quietly changing status.
*/
func TestOfflineCaptureIsIdempotentAndRefusesToOverwrite(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	h := mountedClassroom(s, sc.as(sc.teacher, rbac.TimetableRead, rbac.AttendanceWrite))

	// The office marks one child on leave while the teacher is out of signal.
	sc.tx(t, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			INSERT INTO student_attendance (institution_id, student_id, section_id,
			        on_date, status, marked_by)
			VALUES ($1,$2,$3,'2026-07-15','leave',$4)`,
			sc.inst, sc.students[0], sc.section, sc.office)
		return err
	})

	ref := uuid.NewString()
	body := fmt.Sprintf(`{"section_id":%q,"on_date":"2026-07-15",
		"client_batch_ref":%q,"captured_at":"2026-07-15T09:30:00+05:30",
		"device_note":"Field trip",
		"marks":[{"student_id":%q,"status":"present"},
		         {"student_id":%q,"status":"absent"}],
		"diary":[{"kind":"note","body":"Bring a water bottle"}]}`,
		sc.section, ref, sc.students[0], sc.students[1])

	code, first := callJSON(t, h, "POST", "/classroom/attendance/capture", body)
	if code != http.StatusOK {
		t.Fatalf("capture: %d %v", code, first)
	}
	if got := first["accepted"].(float64); got != 1 {
		t.Errorf("want 1 accepted, got %v", got)
	}
	if got := first["conflicted"].(float64); got != 1 {
		t.Errorf("want 1 conflict, got %v", got)
	}
	conflicts, _ := first["conflicts"].([]any)
	if len(conflicts) != 1 {
		t.Fatalf("want the conflict returned, got %v", first["conflicts"])
	}
	c := conflicts[0].(map[string]any)
	if c["server_status"] != "leave" || c["offline_status"] != "present" {
		t.Errorf("both sides of the disagreement must be reported, got %v", c)
	}

	// The office's row stands until a person says otherwise.
	var status string
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT status FROM student_attendance
			 WHERE student_id = $1 AND on_date = '2026-07-15'`,
			sc.students[0]).Scan(&status)
	})
	if status != "leave" {
		t.Errorf("the offline copy overwrote a row it should not have: %s", status)
	}

	// Replay: same ref, same answer, nothing written twice.
	code, again := callJSON(t, h, "POST", "/classroom/attendance/capture", body)
	if code != http.StatusOK {
		t.Fatalf("replay: %d %v", code, again)
	}
	if again["replayed"] != true {
		t.Errorf("a replayed batch must say so, got %v", again["replayed"])
	}
	var diaryLines, conflictRows int
	sc.tx(t, func(tx pgx.Tx) error {
		if err := tx.QueryRow(context.Background(),
			`SELECT count(*) FROM class_diary_entries WHERE section_id = $1`,
			sc.section).Scan(&diaryLines); err != nil {
			return err
		}
		return tx.QueryRow(context.Background(),
			`SELECT count(*) FROM attendance_capture_conflicts`).Scan(&conflictRows)
	})
	if diaryLines != 1 {
		t.Errorf("a replayed diary line was written twice: %d rows", diaryLines)
	}
	if conflictRows != 1 {
		t.Errorf("a replayed batch stacked its conflicts: %d rows", conflictRows)
	}

	// Resolving in favour of the teacher goes through the correction columns.
	code, list := callJSON(t, h, "GET", "/classroom/attendance/conflicts", "")
	if code != http.StatusOK || len(itemsOf(list)) != 1 {
		t.Fatalf("conflict list: %d %v", code, list)
	}
	id := itemsOf(list)[0].(map[string]any)["id"].(string)
	if code, body := callJSON(t, h, "POST",
		"/classroom/attendance/conflicts/"+id+"/resolve",
		`{"resolution":"applied"}`); code != http.StatusOK {
		t.Fatalf("resolve: %d %v", code, body)
	}
	var newStatus string
	var correctedFrom *string
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT status, corrected_from FROM student_attendance
			 WHERE student_id = $1 AND on_date = '2026-07-15'`,
			sc.students[0]).Scan(&newStatus, &correctedFrom)
	})
	if newStatus != "present" {
		t.Errorf("an applied resolution should stand: %s", newStatus)
	}
	if correctedFrom == nil || *correctedFrom != "leave" {
		t.Errorf("the correction must record what it replaced, got %v", correctedFrom)
	}
}

/*
A language election has to agree with the child's class, and with itself.

	Two properties: an option belonging to another class is refused rather than
	filed, and re-electing in the same slot replaces the live choice instead of
	producing two.
*/
func TestLanguageElectionReplacesTheLiveChoiceAndChecksTheClass(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	h := mountedClassroom(s, sc.as(sc.teacher, rbac.TimetableRead,
		rbac.AcademicsWrite, rbac.StudentsWrite))

	// Two second-language options on this class, plus one on a class nobody
	// here is enrolled in.
	var hindi, sanskrit, otherClassOption string
	for _, opt := range []struct {
		name string
		into *string
	}{{"Hindi", &hindi}, {"Sanskrit", &sanskrit}} {
		var cs uuid.UUID
		sc.tx(t, func(tx pgx.Tx) error {
			var sub uuid.UUID
			if err := tx.QueryRow(context.Background(), `
				INSERT INTO subjects (institution_id, campus_id, name, code)
				VALUES ($1,$2,$3,$4) RETURNING id`,
				sc.inst, sc.campus, opt.name, opt.name[:3]).Scan(&sub); err != nil {
				return err
			}
			return tx.QueryRow(context.Background(), `
				INSERT INTO class_subjects (institution_id, class_id, subject_id, is_elective)
				VALUES ($1,$2,$3,true) RETURNING id`,
				sc.inst, sc.class, sub).Scan(&cs)
		})
		code, body := callJSON(t, h, "POST", "/classroom/languages/options",
			fmt.Sprintf(`{"class_subject_id":%q,"slot":"second"}`, cs))
		if code != http.StatusOK {
			t.Fatalf("option %s: %d %v", opt.name, code, body)
		}
		*opt.into = body["id"].(string)
	}

	// An option on another class entirely.
	sc.tx(t, func(tx pgx.Tx) error {
		ctx := context.Background()
		var cls, sub, cs uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO classes (institution_id, campus_id, name, level)
			VALUES ($1,$2,'Grade 9',9) RETURNING id`,
			sc.inst, sc.campus).Scan(&cls); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO subjects (institution_id, campus_id, name, code)
			VALUES ($1,$2,'French','FRE') RETURNING id`,
			sc.inst, sc.campus).Scan(&sub); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO class_subjects (institution_id, class_id, subject_id, is_elective)
			VALUES ($1,$2,$3,true) RETURNING id`, sc.inst, cls, sub).Scan(&cs); err != nil {
			return err
		}
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO class_language_options (institution_id, class_id,
			        class_subject_id, slot)
			VALUES ($1,$2,$3,'second') RETURNING id`, sc.inst, cls, cs).Scan(&id); err != nil {
			return err
		}
		otherClassOption = id.String()
		return nil
	})

	if code, body := callJSON(t, h, "POST", "/classroom/languages/elections",
		fmt.Sprintf(`{"student_id":%q,"option_id":%q}`,
			sc.students[0], otherClassOption)); code != http.StatusBadRequest {
		t.Errorf("an option from another class must be refused, got %d %v", code, body)
	}

	for _, opt := range []string{hindi, sanskrit} {
		if code, body := callJSON(t, h, "POST", "/classroom/languages/elections",
			fmt.Sprintf(`{"student_id":%q,"option_id":%q}`,
				sc.students[0], opt)); code != http.StatusOK {
			t.Fatalf("election: %d %v", code, body)
		}
	}
	var live int
	sc.tx(t, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT count(*) FROM student_language_elections
			 WHERE student_id = $1 AND status <> 'withdrawn'`,
			sc.students[0]).Scan(&live)
	})
	if live != 1 {
		t.Errorf("a child must hold one live election per slot, holds %d", live)
	}

	code, alloc := callJSON(t, h, "GET",
		"/classroom/languages/allocation?class_id="+sc.class.String(), "")
	if code != http.StatusOK {
		t.Fatalf("allocation: %d %v", code, alloc)
	}
	unchosen, _ := alloc["unchosen"].([]any)
	if len(unchosen) != 3 {
		t.Errorf("three children have not chosen; the allocation reported %d", len(unchosen))
	}
}
