package api

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
	"github.com/school-erp/erp/internal/scope"
)

/* The classroom: five things a teacher does that the schema could nearly do
   already, and the one place each of them was actually missing.

   Language allocation. An Indian school offers a choice of second and third
   language and the choice decides which class-subject a child sits in and which
   paper they write. The subject already exists as a class_subjects row, so
   nothing here describes a language: class_language_options says which existing
   class-subjects are alternatives to each other in a slot, and an election
   points a child at one of them. Everything downstream — the timetable, the
   mark sheet, the exam entry — keys off the same class_subject_id it always
   did, which is the only reason the allocation is worth anything.

   Portfolio. Two portfolio tables exist and are deliberately different:
   student_achievements is what the school awarded, student_portfolio_items is
   what the child claims. Migration 00037 is explicit that merging them would
   destroy a distinction a reader is entitled to. So the teacher's builder here
   reads both and writes neither: it writes a curation row that points at one
   item and carries the school's comment and the decision to print it.

   Montessori. Not marks, and not hpc_observations either — see the migration
   for why that table's one-row-per-observer-per-term shape is the wrong one for
   a record whose entire value is the repetition over months.

   Offline capture. Read the honest scope note above syncCapturedRegister. The
   server side is complete: a batch is idempotent, it never silently overwrites
   somebody else's row, and what it refuses is kept and shown. The client
   queues in the browser and replays; it is not an installable offline PWA and
   this file does not pretend otherwise.

   No-OMR grading. question_bank_questions, question_bank_options, online_tests
   and online_test_questions were all built in 00041. What was missing was
   anybody's answers, so the grading path here is two new tables and one grading
   function that both a portal attempt and a teacher typing off a paper script
   go through — because an item analysis computed two ways is two analyses.

   Scope. Every handler resolves the caller's real reach first and filters on
   it. The gate on the group proves nothing: academics.timetable.read is held by
   students too. This file deliberately follows hr_growth.go and not
   hr_lifecycle.go, which never calls resolveScope at all.
*/

// mountClassroom registers the classroom workspace.
//
// Mounted at the authenticated router level, alongside mountHRGrowth, with its
// own /classroom prefix rather than inside r.Route("/teaching", ...). Two
// reasons: chi panics if a second Route claims a pattern that already has one,
// and the attendance-capture endpoints need academics.attendance.write, which
// is not what the /teaching group gates on.
func (s *Server) mountClassroom(r chi.Router) {
	r.Route("/classroom", func(r chi.Router) {
		// The opener. Every teacher and class teacher holds it; so does a
		// student, which is exactly why nothing below trusts it and every
		// handler narrows to the caller's own sections.
		r.Use(httpx.RequirePermission(rbac.TimetableRead))

		// --- faculty.my_classes.language_subject_allocation -------------
		//
		// Defining what a school offers is academics.write: it is the same
		// authority as creating the class-subject the option points at, and
		// it belongs to the vice principal or the HOD who staffs the group.
		// Recording one child's election is students.write OR academics.write
		// — a class teacher holds the first and no academics.write at all,
		// and electing a language for a child is editing that child's record.
		r.Get("/languages/options", s.listLanguageOptions)
		r.With(httpx.RequirePermission(rbac.AcademicsWrite)).
			Post("/languages/options", s.saveLanguageOption)
		r.With(httpx.RequirePermission(rbac.AcademicsWrite)).
			Delete("/languages/options/{id}", s.retireLanguageOption)
		r.Get("/languages/elections", s.listLanguageElections)
		r.With(httpx.RequireAnyPermission(rbac.StudentsWrite, rbac.AcademicsWrite)).
			Post("/languages/elections", s.recordLanguageElection)
		r.Get("/languages/allocation", s.getLanguageAllocation)

		// --- faculty.my_classes.student_portfolio_builder ---------------
		//
		// discipline.write, not students.write: faculty holds the first and
		// not the second, and the comment a teacher writes against a child's
		// project is the same kind of act as the remark they already write.
		r.Get("/portfolio/{studentID}", s.getPortfolioForCuration)
		r.With(httpx.RequirePermission(rbac.DisciplineWrite)).
			Post("/portfolio/curations", s.curatePortfolioItem)

		// --- faculty.my_classes.montessori_early_years_tracking ---------
		//
		// An observation is assessment, and academics.marks.write is the
		// assessment permission every teaching role holds. The material
		// sequence itself is a school-level list, so it takes academics.write.
		r.Get("/montessori/materials", s.listMontessoriMaterials)
		r.With(httpx.RequirePermission(rbac.AcademicsWrite)).
			Post("/montessori/materials", s.saveMontessoriMaterial)
		r.Get("/montessori/child/{studentID}", s.getMontessoriChild)
		r.Get("/montessori/section", s.getMontessoriSection)
		r.With(httpx.RequirePermission(rbac.MarksWrite)).
			Post("/montessori/progress", s.recordMontessoriProgress)

		// --- faculty.attendance.offline_attendance_diary_capture --------
		r.Get("/attendance/batches", s.listCaptureBatches)
		r.Get("/attendance/conflicts", s.listCaptureConflicts)
		r.With(httpx.RequirePermission(rbac.AttendanceWrite)).
			Post("/attendance/capture", s.syncCapturedRegister)
		r.With(httpx.RequirePermission(rbac.AttendanceWrite)).
			Post("/attendance/conflicts/{id}/resolve", s.resolveCaptureConflict)
		r.Get("/diary", s.listDiaryEntries)
		r.With(httpx.RequirePermission(rbac.HomeworkWrite)).
			Post("/diary", s.saveDiaryEntry)

		// --- faculty.question_papers_online_tests.no_omr_exam_grading ---
		//
		// academics.homework.write for the same reason teaching.go gates the
		// question bank on it: faculty does not hold exams.write, which
		// belongs to the examination controller who sets the board timetable.
		// Gating a screen the catalogue scopes to assigned_classes on a
		// permission the assigned teacher lacks leaves it reachable only by
		// the one role with no use for it.
		r.Get("/grading/tests", s.listGradableTests)
		r.Get("/grading/tests/{id}/key", s.getGradingKey)
		r.Get("/grading/tests/{id}/results", s.listGradingResults)
		r.Get("/grading/tests/{id}/item-analysis", s.getItemAnalysis)
		r.With(httpx.RequirePermission(rbac.HomeworkWrite)).
			Post("/grading/tests/{id}/attempts", s.enterAnswerSheet)
		r.With(httpx.RequirePermission(rbac.HomeworkWrite)).
			Post("/grading/tests/{id}/regrade", s.regradeTest)
	})
}

// ===========================================================================
// Shared helpers
// ===========================================================================

// pathUUID reads a uuid from the URL and answers 404 rather than 400 for a
// malformed one: a caller probing ids should not learn the difference between
// "not a uuid" and "not yours".
// pathUUID lives in student_life.go -- W11 and this worker arrived at the same
// helper independently, with the same reasoning, so there is one of it.

// queryUUID reads an optional uuid query parameter.
func queryUUID(r *http.Request, name string) (*uuid.UUID, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, nil
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%s is not a valid id", name)
	}
	return &id, nil
}

// classroomTx runs one tenant-scoped transaction with the caller's resolved
// reach already loaded, because every handler in this file needs both and
// forgetting the second is the failure this file exists to avoid.
func (s *Server) classroomTx(w http.ResponseWriter, r *http.Request,
	fn func(tx pgx.Tx, res *scope.Resolved) error) bool {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return false
	}
	id := httpx.IdentityFrom(r.Context())
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return fn(tx, res)
	})
	if err != nil {
		if errors.Is(err, errClassroomDenied) {
			httpx.Denied(w, r, "that is not one of your classes")
			return false
		}
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return false
		}
		var bad classroomBadRequest
		if errors.As(err, &bad) {
			httpx.BadRequest(w, r, bad.msg)
			return false
		}
		httpx.Internal(w, r, err)
		return false
	}
	return true
}

// errClassroomDenied is a scope refusal raised from inside a transaction. It is
// a 403 with no detail: telling a caller that the child exists but is not
// theirs is itself a disclosure.
var errClassroomDenied = errors.New("outside the caller's reach")

type classroomBadRequest struct{ msg string }

func (e classroomBadRequest) Error() string { return e.msg }

func badInput(msg string) error { return classroomBadRequest{msg: msg} }

// classReachesSection is the section gate used by every handler here.
// AllAttendance is honoured alongside AllStudents because a vice principal or
// exam controller legitimately reads every register, which is precisely the
// override scope.Resolved already carries.
func classReachesSection(res *scope.Resolved, sectionID uuid.UUID) bool {
	if res.AllStudents || res.AllAttendance {
		return true
	}
	for _, id := range res.SectionIDs {
		if id == sectionID {
			return true
		}
	}
	return false
}

// classReachesClass reports whether the caller teaches any section of a class.
// The language option list is per class, and a teacher of 6-A is entitled to
// see what Class 6 offers.
func classReachesClass(ctx context.Context, tx pgx.Tx, res *scope.Resolved,
	classID uuid.UUID) (bool, error) {
	if res.AllStudents || res.AllAttendance {
		return true, nil
	}
	if len(res.SectionIDs) == 0 {
		return false, nil
	}
	var ok bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM sections sec
		                WHERE sec.class_id = $1 AND sec.id = ANY($2))`,
		classID, res.SectionIDs).Scan(&ok)
	return ok, err
}

// requireTaughtStudent raises errClassroomDenied unless the caller teaches the
// child. Every write in this file goes through it.
func requireTaughtStudent(ctx context.Context, tx pgx.Tx, res *scope.Resolved,
	studentID uuid.UUID) error {
	ok, err := reachesTaughtStudent(ctx, tx, res, studentID)
	if err != nil {
		return err
	}
	if !ok {
		return errClassroomDenied
	}
	return nil
}

func itemsJSON[T any](w http.ResponseWriter, items []T) {
	if items == nil {
		items = []T{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// ===========================================================================
// 1. faculty.my_classes.language_subject_allocation
// ===========================================================================

type langOptionRow struct {
	ID             string  `json:"id"`
	ClassID        string  `json:"class_id"`
	ClassName      string  `json:"class_name"`
	ClassSubjectID string  `json:"class_subject_id"`
	SubjectName    string  `json:"subject_name"`
	SubjectCode    string  `json:"subject_code"`
	Slot           string  `json:"slot"`
	DisplayName    *string `json:"display_name,omitempty"`
	Capacity       *int32  `json:"capacity,omitempty"`
	IsActive       bool    `json:"is_active"`
	Elected        int32   `json:"elected_count"`
}

func (s *Server) listLanguageOptions(w http.ResponseWriter, r *http.Request) {
	classID, err := queryUUID(r, "class_id")
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	var out []langOptionRow
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		where := "TRUE"
		args := []any{}
		if classID != nil {
			reach, err := classReachesClass(r.Context(), tx, res, *classID)
			if err != nil {
				return err
			}
			if !reach {
				return errClassroomDenied
			}
			where = "o.class_id = $1"
			args = append(args, *classID)
		} else if !(res.AllStudents || res.AllAttendance) {
			// Without a class named, show the options of every class the
			// caller teaches a section of. An empty section set yields no
			// rows, never all of them.
			if len(res.SectionIDs) == 0 {
				itemsJSON(w, out)
				return nil
			}
			where = `o.class_id IN (SELECT sec.class_id FROM sections sec WHERE sec.id = ANY($1))`
			args = append(args, res.SectionIDs)
		}
		rows, err := tx.Query(r.Context(), `
			SELECT o.id::text, o.class_id::text, cl.name,
			       o.class_subject_id::text, sub.name, sub.code,
			       o.slot, o.display_name, o.capacity, o.is_active,
			       (SELECT count(*) FROM student_language_elections el
			         WHERE el.option_id = o.id AND el.status <> 'withdrawn')::int
			  FROM class_language_options o
			  JOIN classes cl        ON cl.id = o.class_id
			  JOIN class_subjects cs ON cs.id = o.class_subject_id
			  JOIN subjects sub      ON sub.id = cs.subject_id
			 WHERE `+where+`
			 ORDER BY cl.level, cl.name, o.slot, sub.name`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v langOptionRow
			if err := rows.Scan(&v.ID, &v.ClassID, &v.ClassName, &v.ClassSubjectID,
				&v.SubjectName, &v.SubjectCode, &v.Slot, &v.DisplayName,
				&v.Capacity, &v.IsActive, &v.Elected); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if ok {
		itemsJSON(w, out)
	}
}

type langOptionRequest struct {
	ID             *uuid.UUID `json:"id"`
	ClassSubjectID uuid.UUID  `json:"class_subject_id"`
	Slot           string     `json:"slot"`
	DisplayName    *string    `json:"display_name"`
	Capacity       *int32     `json:"capacity"`
	IsActive       *bool      `json:"is_active"`
}

/*
saveLanguageOption declares that a class-subject is one of the choices in a
language slot.

	class_id is derived from the class_subject rather than accepted from the
	client. The two must agree — the option list is read by class — and a
	client-supplied class_id is a way to file Class 6's Sanskrit under Class 9.
*/
func (s *Server) saveLanguageOption(w http.ResponseWriter, r *http.Request) {
	var in langOptionRequest
	if !httpx.Decode(w, r, &in) {
		return
	}
	switch in.Slot {
	case "first", "second", "third":
	default:
		httpx.BadRequest(w, r, "slot must be first, second or third")
		return
	}
	if in.ClassSubjectID == uuid.Nil {
		httpx.BadRequest(w, r, "a language option needs a class subject")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var saved string
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		var classID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT class_id FROM class_subjects WHERE id = $1`,
			in.ClassSubjectID).Scan(&classID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return badInput("that subject is not on any class")
			}
			return err
		}
		active := true
		if in.IsActive != nil {
			active = *in.IsActive
		}
		if in.ID != nil {
			return tx.QueryRow(r.Context(), `
				UPDATE class_language_options
				   SET class_subject_id = $2, class_id = $3, slot = $4,
				       display_name = $5, capacity = $6, is_active = $7,
				       updated_at = now()
				 WHERE id = $1
				 RETURNING id::text`,
				*in.ID, in.ClassSubjectID, classID, in.Slot,
				in.DisplayName, in.Capacity, active).Scan(&saved)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO class_language_options
			    (institution_id, class_id, class_subject_id, slot,
			     display_name, capacity, is_active)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (class_subject_id, slot) DO UPDATE
			   SET display_name = EXCLUDED.display_name,
			       capacity     = EXCLUDED.capacity,
			       is_active    = EXCLUDED.is_active,
			       updated_at   = now()
			RETURNING id::text`,
			id.InstitutionID, classID, in.ClassSubjectID, in.Slot,
			in.DisplayName, in.Capacity, active).Scan(&saved)
	})
	if ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": saved})
	}
}

// retireLanguageOption deactivates rather than deletes: children have elected
// it, and a DELETE would cascade their elections away along with the record of
// what they studied last year.
func (s *Server) retireLanguageOption(w http.ResponseWriter, r *http.Request) {
	optID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	if s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE class_language_options
			   SET is_active = false, updated_at = now()
			 WHERE id = $1`, optID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	}) {
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

type langElectionRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	AdmissionNo string  `json:"admission_no"`
	StudentName string  `json:"student_name"`
	Section     string  `json:"section"`
	Slot        string  `json:"slot"`
	OptionID    string  `json:"option_id"`
	SubjectName string  `json:"subject_name"`
	Status      string  `json:"status"`
	Note        *string `json:"note,omitempty"`
	DecidedOn   string  `json:"decided_on"`
}

func (s *Server) listLanguageElections(w http.ResponseWriter, r *http.Request) {
	sectionID, err := queryUUID(r, "section_id")
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	var out []langElectionRow
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		args := []any{}
		where := []string{"el.status <> 'withdrawn'"}
		if sectionID != nil {
			if !classReachesSection(res, *sectionID) {
				return errClassroomDenied
			}
			args = append(args, *sectionID)
			where = append(where, fmt.Sprintf(`en.section_id = $%d`, len(args)))
		} else if !res.AllStudents {
			if len(res.SectionIDs) == 0 {
				return nil
			}
			args = append(args, res.SectionIDs)
			where = append(where, fmt.Sprintf(`en.section_id = ANY($%d)`, len(args)))
		}
		rows, err := tx.Query(r.Context(), `
			SELECT el.id::text, st.id::text, st.admission_no,
			       concat_ws(' ', st.first_name, st.last_name),
			       COALESCE(sec.name, '—'), el.slot, o.id::text, sub.name,
			       el.status, el.note, to_char(el.decided_on, 'YYYY-MM-DD')
			  FROM student_language_elections el
			  JOIN students st ON st.id = el.student_id
			  JOIN class_language_options o ON o.id = el.option_id
			  JOIN class_subjects cs ON cs.id = o.class_subject_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			  JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE `+strings.Join(where, " AND ")+`
			 ORDER BY sec.name, el.slot, st.admission_no`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v langElectionRow
			if err := rows.Scan(&v.ID, &v.StudentID, &v.AdmissionNo, &v.StudentName,
				&v.Section, &v.Slot, &v.OptionID, &v.SubjectName, &v.Status,
				&v.Note, &v.DecidedOn); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if ok {
		itemsJSON(w, out)
	}
}

type langElectionRequest struct {
	StudentID uuid.UUID  `json:"student_id"`
	OptionID  uuid.UUID  `json:"option_id"`
	Status    string     `json:"status"`
	Note      *string    `json:"note"`
	YearID    *uuid.UUID `json:"academic_year_id"`
}

/*
recordLanguageElection points one child at one option in one slot.

	Withdrawing the previous election rather than deleting it is what makes the
	history readable: a child moved off Hindi in September did study Hindi in
	August, and the mark sheet for that term says so.

	The option's class must be the class the child is actually enrolled in.
	Without that check a teacher could file a child into Class 9's French group
	from the Class 6 screen, and the allocation would then place them in a
	timetable slot that does not exist for them.
*/
func (s *Server) recordLanguageElection(w http.ResponseWriter, r *http.Request) {
	var in langElectionRequest
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.StudentID == uuid.Nil || in.OptionID == uuid.Nil {
		httpx.BadRequest(w, r, "an election needs a student and an option")
		return
	}
	status := in.Status
	if status == "" {
		status = "confirmed"
	}
	switch status {
	case "proposed", "confirmed", "withdrawn":
	default:
		httpx.BadRequest(w, r, "status must be proposed, confirmed or withdrawn")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var saved string
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if err := requireTaughtStudent(r.Context(), tx, res, in.StudentID); err != nil {
			return err
		}
		var slot string
		var optClass uuid.UUID
		var active bool
		if err := tx.QueryRow(r.Context(),
			`SELECT slot, class_id, is_active FROM class_language_options WHERE id = $1`,
			in.OptionID).Scan(&slot, &optClass, &active); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return badInput("no such language option")
			}
			return err
		}
		if !active {
			return badInput("that language option has been withdrawn")
		}
		var sameClass bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1
			                 FROM enrollments e
			                 JOIN sections sec ON sec.id = e.section_id
			                WHERE e.student_id = $1 AND e.status = 'active'
			                  AND sec.class_id = $2)`,
			in.StudentID, optClass).Scan(&sameClass); err != nil {
			return err
		}
		if !sameClass {
			return badInput("that option belongs to a class this child is not in")
		}

		// Retire the live election for this slot before writing the new one.
		// The partial unique index would otherwise reject the insert, and a
		// teacher correcting a choice would get a duplicate-key error with
		// nothing useful in it.
		if _, err := tx.Exec(r.Context(), `
			UPDATE student_language_elections
			   SET status = 'withdrawn', updated_at = now()
			 WHERE student_id = $1 AND slot = $2 AND status <> 'withdrawn'
			   AND COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid)
			     = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
			   AND option_id <> $4`,
			in.StudentID, slot, in.YearID, in.OptionID); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO student_language_elections
			    (institution_id, student_id, option_id, slot, academic_year_id,
			     status, note, decided_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (student_id, slot,
			             COALESCE(academic_year_id,
			                      '00000000-0000-0000-0000-000000000000'::uuid))
			     WHERE status <> 'withdrawn'
			DO UPDATE SET option_id = EXCLUDED.option_id,
			              status    = EXCLUDED.status,
			              note      = EXCLUDED.note,
			              decided_by = EXCLUDED.decided_by,
			              updated_at = now()
			RETURNING id::text`,
			id.InstitutionID, in.StudentID, in.OptionID, slot, in.YearID,
			status, in.Note, id.UserID).Scan(&saved)
	})
	if ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": saved})
	}
}

type langGroupRow struct {
	OptionID    string   `json:"option_id"`
	Slot        string   `json:"slot"`
	SubjectName string   `json:"subject_name"`
	Capacity    *int32   `json:"capacity,omitempty"`
	Elected     int32    `json:"elected"`
	Proposed    int32    `json:"proposed"`
	OverBy      int32    `json:"over_capacity_by"`
	Sections    []string `json:"sections"`
}

type langUnchosenRow struct {
	StudentID    string   `json:"student_id"`
	AdmissionNo  string   `json:"admission_no"`
	StudentName  string   `json:"student_name"`
	Section      string   `json:"section"`
	MissingSlots []string `json:"missing_slots"`
}

type langClashRow struct {
	StudentID   string `json:"student_id"`
	StudentName string `json:"student_name"`
	Weekday     int32  `json:"weekday"`
	PeriodName  string `json:"period_name"`
	SubjectA    string `json:"subject_a"`
	SubjectB    string `json:"subject_b"`
}

type langAllocation struct {
	ClassID  string            `json:"class_id"`
	Groups   []langGroupRow    `json:"groups"`
	Unchosen []langUnchosenRow `json:"unchosen"`
	Clashes  []langClashRow    `json:"clashes"`
}

/*
getLanguageAllocation answers the three questions the allocation is for: who is
in which group, who has not chosen, and whose two groups collide.

	The clash query is the reason this feature connects to the timetable rather
	than sitting beside it. Because an election points at a class_subject, and
	timetable_entries is keyed on the same class_subject, a child elected into
	second-language Hindi and third-language Sanskrit that are both timetabled
	in Tuesday period 4 is a fact the schema can already state — but only if the
	election is modelled this way. That is the whole argument for reusing
	class_subjects instead of inventing a language table.
*/
func (s *Server) getLanguageAllocation(w http.ResponseWriter, r *http.Request) {
	classID, err := queryUUID(r, "class_id")
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if classID == nil {
		httpx.BadRequest(w, r, "class_id is required")
		return
	}
	out := langAllocation{ClassID: classID.String(), Groups: []langGroupRow{},
		Unchosen: []langUnchosenRow{}, Clashes: []langClashRow{}}
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		reach, err := classReachesClass(r.Context(), tx, res, *classID)
		if err != nil {
			return err
		}
		if !reach {
			return errClassroomDenied
		}

		// --- the groups ------------------------------------------------
		rows, err := tx.Query(r.Context(), `
			SELECT o.id::text, o.slot, COALESCE(o.display_name, sub.name), o.capacity,
			       count(*) FILTER (WHERE el.status = 'confirmed')::int,
			       count(*) FILTER (WHERE el.status = 'proposed')::int,
			       COALESCE(array_agg(DISTINCT sec.name)
			                FILTER (WHERE sec.name IS NOT NULL), '{}')
			  FROM class_language_options o
			  JOIN class_subjects cs ON cs.id = o.class_subject_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			  LEFT JOIN student_language_elections el
			         ON el.option_id = o.id AND el.status <> 'withdrawn'
			  LEFT JOIN enrollments en
			         ON en.student_id = el.student_id AND en.status = 'active'
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE o.class_id = $1 AND o.is_active
			 GROUP BY o.id, o.slot, o.display_name, sub.name, o.capacity
			 ORDER BY o.slot, sub.name`, *classID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var g langGroupRow
			if err := rows.Scan(&g.OptionID, &g.Slot, &g.SubjectName, &g.Capacity,
				&g.Elected, &g.Proposed, &g.Sections); err != nil {
				rows.Close()
				return err
			}
			if g.Capacity != nil && g.Elected+g.Proposed > *g.Capacity {
				g.OverBy = g.Elected + g.Proposed - *g.Capacity
			}
			if g.Sections == nil {
				g.Sections = []string{}
			}
			out.Groups = append(out.Groups, g)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// --- who has not chosen ----------------------------------------
		//
		// A slot with no option defined for the class is not a slot anybody
		// can be missing, so the expected set is read from the options rather
		// than assumed to be all three. A school that offers no third language
		// must not have every child reported as incomplete.
		rows, err = tx.Query(r.Context(), `
			WITH slots AS (
			    SELECT DISTINCT slot FROM class_language_options
			     WHERE class_id = $1 AND is_active
			)
			SELECT st.id::text, st.admission_no,
			       concat_ws(' ', st.first_name, st.last_name),
			       COALESCE(sec.name, '—'),
			       array_agg(slots.slot ORDER BY slots.slot)
			  FROM students st
			  JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
			  JOIN sections sec ON sec.id = en.section_id
			 CROSS JOIN slots
			 WHERE sec.class_id = $1
			   AND NOT EXISTS (
			       SELECT 1 FROM student_language_elections el
			        WHERE el.student_id = st.id
			          AND el.slot = slots.slot
			          AND el.status <> 'withdrawn')
			 GROUP BY st.id, st.admission_no, st.first_name, st.last_name, sec.name
			 ORDER BY sec.name, st.admission_no`, *classID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v langUnchosenRow
			if err := rows.Scan(&v.StudentID, &v.AdmissionNo, &v.StudentName,
				&v.Section, &v.MissingSlots); err != nil {
				rows.Close()
				return err
			}
			out.Unchosen = append(out.Unchosen, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// --- timetable clashes -----------------------------------------
		rows, err = tx.Query(r.Context(), `
			SELECT st.id::text, concat_ws(' ', st.first_name, st.last_name),
			       ta.weekday, COALESCE(p.name, 'Period ' || p.sequence::text),
			       sa.name, sb.name
			  FROM student_language_elections ea
			  JOIN student_language_elections eb
			    ON eb.student_id = ea.student_id AND eb.id <> ea.id
			   AND eb.status <> 'withdrawn'
			  JOIN class_language_options oa ON oa.id = ea.option_id
			  JOIN class_language_options ob ON ob.id = eb.option_id
			  JOIN students st ON st.id = ea.student_id
			  JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
			  JOIN timetable_entries ta
			    ON ta.class_subject_id = oa.class_subject_id
			   AND ta.section_id = en.section_id
			  JOIN timetable_entries tb
			    ON tb.class_subject_id = ob.class_subject_id
			   AND tb.section_id = en.section_id
			   AND tb.weekday = ta.weekday AND tb.period_id = ta.period_id
			  JOIN periods p ON p.id = ta.period_id
			  JOIN class_subjects csa ON csa.id = oa.class_subject_id
			  JOIN class_subjects csb ON csb.id = ob.class_subject_id
			  JOIN subjects sa ON sa.id = csa.subject_id
			  JOIN subjects sb ON sb.id = csb.subject_id
			 WHERE ea.status <> 'withdrawn'
			   AND oa.class_id = $1
			   AND oa.id < ob.id
			 ORDER BY ta.weekday, p.sequence`, *classID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v langClashRow
			if err := rows.Scan(&v.StudentID, &v.StudentName, &v.Weekday,
				&v.PeriodName, &v.SubjectA, &v.SubjectB); err != nil {
				return err
			}
			out.Clashes = append(out.Clashes, v)
		}
		return rows.Err()
	})
	if ok {
		httpx.JSON(w, http.StatusOK, out)
	}
}

// ===========================================================================
// 2. faculty.my_classes.student_portfolio_builder
// ===========================================================================

// curatedItemRow is one piece of evidence from either portfolio table, with
// whatever the school has said about it.
//
// source is carried all the way to the screen on purpose: the whole reason two
// tables exist is that a school prize and a self-declared hackathon are
// different kinds of claim, and a builder that rendered them identically would
// undo that at the last step.
type curatedItemRow struct {
	Source        string  `json:"source"` // award | claim
	ItemID        string  `json:"item_id"`
	Title         string  `json:"title"`
	Kind          string  `json:"kind"`
	Description   *string `json:"description,omitempty"`
	HappenedOn    *string `json:"happened_on,omitempty"`
	EvidenceURL   *string `json:"evidence_url,omitempty"`
	SharedByChild bool    `json:"shared_by_child"`

	CurationID      *string `json:"curation_id,omitempty"`
	Status          string  `json:"status"`
	Comment         *string `json:"comment,omitempty"`
	IncludeInReport bool    `json:"include_in_report"`
	IsFeatured      bool    `json:"is_featured"`
	CuratedBy       *string `json:"curated_by,omitempty"`
	CuratedAt       *string `json:"curated_at,omitempty"`
}

/*
getPortfolioForCuration is the teacher's working view of one child's portfolio.

	Both tables, one list, LEFT JOINed to the curation so an uncurated item
	appears with status "uncurated" rather than not appearing at all — the
	items nobody has looked at are the ones the screen exists to surface.
*/
func (s *Server) getPortfolioForCuration(w http.ResponseWriter, r *http.Request) {
	studentID, ok := pathUUID(w, r, "studentID")
	if !ok {
		return
	}
	var out []curatedItemRow
	done := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if err := requireTaughtStudent(r.Context(), tx, res, studentID); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT 'award', a.id::text, a.title, a.kind, a.description,
			       -- awarded_on, not achieved_on: the column has never been
			       -- called that, so opening any student's portfolio 500'd.
			       to_char(a.awarded_on, 'YYYY-MM-DD'), NULL::text, false,
			       c.id::text, COALESCE(c.status, 'uncurated'), c.comment,
			       COALESCE(c.include_in_report, false), COALESCE(c.is_featured, false),
			       u.full_name, to_char(c.curated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM student_achievements a
			  LEFT JOIN student_portfolio_curations c ON c.achievement_id = a.id
			  LEFT JOIN users u ON u.id = c.curated_by
			 WHERE a.student_id = $1
			UNION ALL
			SELECT 'claim', p.id::text, p.title, p.kind, p.description,
			       to_char(p.happened_on, 'YYYY-MM-DD'), p.evidence_url, p.is_shared,
			       c.id::text, COALESCE(c.status, 'uncurated'), c.comment,
			       COALESCE(c.include_in_report, false), COALESCE(c.is_featured, false),
			       u.full_name, to_char(c.curated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z'
			  FROM student_portfolio_items p
			  LEFT JOIN student_portfolio_curations c ON c.portfolio_item_id = p.id
			  LEFT JOIN users u ON u.id = c.curated_by
			 WHERE p.student_id = $1
			 ORDER BY 6 DESC NULLS LAST, 3`, studentID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v curatedItemRow
			if err := rows.Scan(&v.Source, &v.ItemID, &v.Title, &v.Kind, &v.Description,
				&v.HappenedOn, &v.EvidenceURL, &v.SharedByChild,
				&v.CurationID, &v.Status, &v.Comment, &v.IncludeInReport,
				&v.IsFeatured, &v.CuratedBy, &v.CuratedAt); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if done {
		itemsJSON(w, out)
	}
}

type curationRequest struct {
	StudentID       uuid.UUID `json:"student_id"`
	Source          string    `json:"source"` // award | claim
	ItemID          uuid.UUID `json:"item_id"`
	Status          string    `json:"status"`
	Comment         *string   `json:"comment"`
	IncludeInReport *bool     `json:"include_in_report"`
	IsFeatured      *bool     `json:"is_featured"`
	DisplayOrder    *int32    `json:"display_order"`
}

/*
curatePortfolioItem writes the school's verdict on one existing piece.

	It writes to neither portfolio table. A teacher may not edit the child's own
	claim — that is the child's record and rewriting it would be the school
	quietly editing a statement made by someone else — and the achievement's own
	fields belong to the office that awarded it. What a teacher may do is say
	what the school thinks, and that is this row.

	The item is re-checked against the student id rather than trusted from the
	body: an item id belonging to another child, submitted with a student id
	that the caller does teach, would otherwise attach a comment to a stranger's
	certificate.
*/
func (s *Server) curatePortfolioItem(w http.ResponseWriter, r *http.Request) {
	var in curationRequest
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.StudentID == uuid.Nil || in.ItemID == uuid.Nil {
		httpx.BadRequest(w, r, "a curation needs a student and an item")
		return
	}
	status := in.Status
	if status == "" {
		status = "noted"
	}
	switch status {
	case "noted", "endorsed", "returned":
	default:
		httpx.BadRequest(w, r, "status must be noted, endorsed or returned")
		return
	}
	var table, column string
	switch in.Source {
	case "award":
		table, column = "student_achievements", "achievement_id"
	case "claim":
		table, column = "student_portfolio_items", "portfolio_item_id"
	default:
		httpx.BadRequest(w, r, "source must be award or claim")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var saved string
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if err := requireTaughtStudent(r.Context(), tx, res, in.StudentID); err != nil {
			return err
		}
		var belongs bool
		// table is one of two literals chosen above, never client text.
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM `+table+
				` WHERE id = $1 AND student_id = $2)`,
			in.ItemID, in.StudentID).Scan(&belongs); err != nil {
			return err
		}
		if !belongs {
			return badInput("that item does not belong to this child")
		}
		report := in.IncludeInReport != nil && *in.IncludeInReport
		featured := in.IsFeatured != nil && *in.IsFeatured
		var order int32
		if in.DisplayOrder != nil {
			order = *in.DisplayOrder
		}
		// A returned draft is not printed and not featured, whatever the body
		// said. The two flags are an audience decision and "sent back to the
		// child" has no audience.
		if status == "returned" {
			report, featured = false, false
		}
		sentinel := "00000000-0000-0000-0000-000000000000"
		return tx.QueryRow(r.Context(), `
			INSERT INTO student_portfolio_curations
			    (institution_id, student_id, `+column+`, status, comment,
			     include_in_report, is_featured, display_order, curated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (COALESCE(achievement_id, '`+sentinel+`'::uuid),
			             COALESCE(portfolio_item_id, '`+sentinel+`'::uuid))
			DO UPDATE SET status            = EXCLUDED.status,
			              comment           = EXCLUDED.comment,
			              include_in_report = EXCLUDED.include_in_report,
			              is_featured       = EXCLUDED.is_featured,
			              display_order     = EXCLUDED.display_order,
			              curated_by        = EXCLUDED.curated_by,
			              updated_at        = now()
			RETURNING id::text`,
			id.InstitutionID, in.StudentID, in.ItemID, status, in.Comment,
			report, featured, order, id.UserID).Scan(&saved)
	})
	if ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": saved})
	}
}

// ===========================================================================
// 3. faculty.my_classes.montessori_early_years_tracking
// ===========================================================================

type montMaterialRow struct {
	ID          string  `json:"id"`
	Area        string  `json:"area"`
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	Sequence    int32   `json:"sequence"`
	MinAge      *int32  `json:"min_age_months,omitempty"`
	MaxAge      *int32  `json:"max_age_months,omitempty"`
	IsActive    bool    `json:"is_active"`
}

func (s *Server) listMontessoriMaterials(w http.ResponseWriter, r *http.Request) {
	area := strings.TrimSpace(r.URL.Query().Get("area"))
	items, err := collect(s, r, `
		SELECT id::text, area, name, description, sequence,
		       min_age_months, max_age_months, is_active
		  FROM montessori_materials
		 WHERE is_active AND ($1 = '' OR area = $1)
		 ORDER BY area, sequence, name`, []any{area},
		func(rows pgx.Rows) (montMaterialRow, error) {
			var v montMaterialRow
			return v, rows.Scan(&v.ID, &v.Area, &v.Name, &v.Description, &v.Sequence,
				&v.MinAge, &v.MaxAge, &v.IsActive)
		})
	respond(w, r, items, err)
}

type montMaterialRequest struct {
	ID          *uuid.UUID `json:"id"`
	Area        string     `json:"area"`
	Name        string     `json:"name"`
	Description *string    `json:"description"`
	Sequence    int32      `json:"sequence"`
	MinAge      *int32     `json:"min_age_months"`
	MaxAge      *int32     `json:"max_age_months"`
	IsActive    *bool      `json:"is_active"`
}

func (s *Server) saveMontessoriMaterial(w http.ResponseWriter, r *http.Request) {
	var in montMaterialRequest
	if !httpx.Decode(w, r, &in) {
		return
	}
	switch in.Area {
	case "practical_life", "sensorial", "language", "mathematics", "culture":
	default:
		httpx.BadRequest(w, r, "area must be one of the five Montessori areas")
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		httpx.BadRequest(w, r, "a material needs a name")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	active := in.IsActive == nil || *in.IsActive
	var saved string
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if in.ID != nil {
			return tx.QueryRow(r.Context(), `
				UPDATE montessori_materials
				   SET area = $2, name = $3, description = $4, sequence = $5,
				       min_age_months = $6, max_age_months = $7, is_active = $8
				 WHERE id = $1
				 RETURNING id::text`,
				*in.ID, in.Area, strings.TrimSpace(in.Name), in.Description,
				in.Sequence, in.MinAge, in.MaxAge, active).Scan(&saved)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO montessori_materials
			    (institution_id, area, name, description, sequence,
			     min_age_months, max_age_months, is_active)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (institution_id, area, lower(btrim(name)))
			DO UPDATE SET description = EXCLUDED.description,
			              sequence    = EXCLUDED.sequence,
			              min_age_months = EXCLUDED.min_age_months,
			              max_age_months = EXCLUDED.max_age_months,
			              is_active   = EXCLUDED.is_active
			RETURNING id::text`,
			id.InstitutionID, in.Area, strings.TrimSpace(in.Name), in.Description,
			in.Sequence, in.MinAge, in.MaxAge, active).Scan(&saved)
	})
	if ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": saved})
	}
}

// montSequenceRow is where one child stands with one material: the current
// stage, when it was reached, and every observation behind it.
type montSequenceRow struct {
	MaterialID   string            `json:"material_id"`
	Area         string            `json:"area"`
	Name         string            `json:"name"`
	Sequence     int32             `json:"sequence"`
	CurrentStage string            `json:"current_stage"`
	LastSeenOn   *string           `json:"last_seen_on,omitempty"`
	History      []montObservation `json:"history"`
}

type montObservation struct {
	ID         string  `json:"id"`
	Stage      string  `json:"stage"`
	ObservedOn string  `json:"observed_on"`
	Note       *string `json:"note,omitempty"`
	ObservedBy *string `json:"observed_by,omitempty"`
}

/*
getMontessoriChild is one child's position in every sequence.

	Materials with no observation are returned with stage "not_presented"
	rather than omitted: the shelf a child has not reached yet is the half of
	the picture a guide plans from.

	The current stage is the most recent observation by date, not the highest
	stage reached. A 'revisit' recorded in October after a 'mastered' in July
	means the child has lost it, and a view that took the maximum would report
	a mastery the guide has explicitly withdrawn.
*/
func (s *Server) getMontessoriChild(w http.ResponseWriter, r *http.Request) {
	studentID, ok := pathUUID(w, r, "studentID")
	if !ok {
		return
	}
	out := []montSequenceRow{}
	done := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if err := requireTaughtStudent(r.Context(), tx, res, studentID); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT m.id::text, m.area, m.name, m.sequence,
			       COALESCE(cur.stage, 'not_presented'),
			       to_char(cur.observed_on, 'YYYY-MM-DD')
			  FROM montessori_materials m
			  LEFT JOIN LATERAL (
			      SELECT p.stage, p.observed_on
			        FROM montessori_progress p
			       WHERE p.material_id = m.id AND p.student_id = $1
			       ORDER BY p.observed_on DESC, p.created_at DESC
			       LIMIT 1
			  ) cur ON TRUE
			 WHERE m.is_active
			 ORDER BY m.area, m.sequence, m.name`, studentID)
		if err != nil {
			return err
		}
		byMaterial := map[string]int{}
		for rows.Next() {
			var v montSequenceRow
			if err := rows.Scan(&v.MaterialID, &v.Area, &v.Name, &v.Sequence,
				&v.CurrentStage, &v.LastSeenOn); err != nil {
				rows.Close()
				return err
			}
			v.History = []montObservation{}
			byMaterial[v.MaterialID] = len(out)
			out = append(out, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		hist, err := tx.Query(r.Context(), `
			SELECT p.id::text, p.material_id::text, p.stage,
			       to_char(p.observed_on, 'YYYY-MM-DD'), p.note, u.full_name
			  FROM montessori_progress p
			  LEFT JOIN users u ON u.id = p.observed_by
			 WHERE p.student_id = $1
			 ORDER BY p.observed_on DESC, p.created_at DESC`, studentID)
		if err != nil {
			return err
		}
		defer hist.Close()
		for hist.Next() {
			var mat string
			var o montObservation
			if err := hist.Scan(&o.ID, &mat, &o.Stage, &o.ObservedOn,
				&o.Note, &o.ObservedBy); err != nil {
				return err
			}
			if i, found := byMaterial[mat]; found {
				out[i].History = append(out[i].History, o)
			}
		}
		return hist.Err()
	})
	if done {
		itemsJSON(w, out)
	}
}

// montChildSummary is one child's line on the section view: how far through
// each area they are.
type montChildSummary struct {
	StudentID   string          `json:"student_id"`
	AdmissionNo string          `json:"admission_no"`
	StudentName string          `json:"student_name"`
	Areas       []montAreaCount `json:"areas"`
	LastSeenOn  *string         `json:"last_observed_on,omitempty"`
}

type montAreaCount struct {
	Area       string `json:"area"`
	Total      int32  `json:"materials"`
	Presented  int32  `json:"presented"`
	Practising int32  `json:"practising"`
	Mastered   int32  `json:"mastered"`
}

// getMontessoriSection is the guide's whole-room view: one row per child, the
// count at each stage per area, and when they were last observed at all. The
// last column is the one that matters — a child nobody has recorded in three
// weeks is the child being missed.
func (s *Server) getMontessoriSection(w http.ResponseWriter, r *http.Request) {
	sectionID, err := queryUUID(r, "section_id")
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if sectionID == nil {
		httpx.BadRequest(w, r, "section_id is required")
		return
	}
	out := []montChildSummary{}
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if !classReachesSection(res, *sectionID) {
			return errClassroomDenied
		}
		rows, err := tx.Query(r.Context(), `
			WITH latest AS (
			    SELECT DISTINCT ON (p.student_id, p.material_id)
			           p.student_id, p.material_id, p.stage, p.observed_on
			      FROM montessori_progress p
			      JOIN enrollments e ON e.student_id = p.student_id
			                        AND e.status = 'active' AND e.section_id = $1
			     ORDER BY p.student_id, p.material_id, p.observed_on DESC, p.created_at DESC
			)
			SELECT st.id::text, st.admission_no,
			       concat_ws(' ', st.first_name, st.last_name),
			       m.area,
			       count(*)::int,
			       count(*) FILTER (WHERE l.stage = 'presented')::int,
			       count(*) FILTER (WHERE l.stage = 'practising')::int,
			       count(*) FILTER (WHERE l.stage = 'mastered')::int,
			       to_char(max(l.observed_on), 'YYYY-MM-DD')
			  FROM students st
			  JOIN enrollments en ON en.student_id = st.id
			                     AND en.status = 'active' AND en.section_id = $1
			  CROSS JOIN (SELECT DISTINCT area FROM montessori_materials WHERE is_active) m
			  LEFT JOIN latest l ON l.student_id = st.id
			  LEFT JOIN montessori_materials mm
			         ON mm.id = l.material_id AND mm.area = m.area
			 WHERE l.material_id IS NULL OR mm.id IS NOT NULL
			 GROUP BY st.id, st.admission_no, st.first_name, st.last_name, m.area
			 ORDER BY st.admission_no, m.area`, *sectionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		byStudent := map[string]int{}
		for rows.Next() {
			var sid, adm, name, area string
			var total, pres, prac, mast int32
			var last *string
			if err := rows.Scan(&sid, &adm, &name, &area, &total,
				&pres, &prac, &mast, &last); err != nil {
				return err
			}
			i, found := byStudent[sid]
			if !found {
				out = append(out, montChildSummary{StudentID: sid, AdmissionNo: adm,
					StudentName: name, Areas: []montAreaCount{}})
				i = len(out) - 1
				byStudent[sid] = i
			}
			// The materials count is the number the child has been seen with
			// in this area, not the shelf size; the shelf is on the child
			// view, and repeating it per row would triple the query.
			out[i].Areas = append(out[i].Areas, montAreaCount{Area: area,
				Total: pres + prac + mast, Presented: pres,
				Practising: prac, Mastered: mast})
			if last != nil && (out[i].LastSeenOn == nil || *last > *out[i].LastSeenOn) {
				out[i].LastSeenOn = last
			}
			_ = total
		}
		return rows.Err()
	})
	if ok {
		itemsJSON(w, out)
	}
}

type montProgressRequest struct {
	StudentID  uuid.UUID `json:"student_id"`
	MaterialID uuid.UUID `json:"material_id"`
	Stage      string    `json:"stage"`
	ObservedOn *string   `json:"observed_on"`
	Note       *string   `json:"note"`
}

// recordMontessoriProgress appends one observation. It appends rather than
// updates because the sequence over time is the assessment; a screen that
// overwrote the July record with the October one would leave a guide unable to
// answer the only question a parent asks, which is whether it is coming.
func (s *Server) recordMontessoriProgress(w http.ResponseWriter, r *http.Request) {
	var in montProgressRequest
	if !httpx.Decode(w, r, &in) {
		return
	}
	switch in.Stage {
	case "presented", "practising", "mastered", "revisit":
	default:
		httpx.BadRequest(w, r, "stage must be presented, practising, mastered or revisit")
		return
	}
	if in.StudentID == uuid.Nil || in.MaterialID == uuid.Nil {
		httpx.BadRequest(w, r, "an observation needs a child and a material")
		return
	}
	on := time.Now()
	if in.ObservedOn != nil && strings.TrimSpace(*in.ObservedOn) != "" {
		parsed, err := time.Parse("2006-01-02", strings.TrimSpace(*in.ObservedOn))
		if err != nil {
			httpx.BadRequest(w, r, "observed_on must be YYYY-MM-DD")
			return
		}
		on = parsed
	}
	id := httpx.IdentityFrom(r.Context())
	var saved string
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if err := requireTaughtStudent(r.Context(), tx, res, in.StudentID); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO montessori_progress
			    (institution_id, student_id, material_id, stage, observed_on,
			     note, observed_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (student_id, material_id, stage, observed_on)
			DO UPDATE SET note = EXCLUDED.note, observed_by = EXCLUDED.observed_by
			RETURNING id::text`,
			id.InstitutionID, in.StudentID, in.MaterialID, in.Stage,
			on.Format("2006-01-02"), in.Note, id.UserID).Scan(&saved)
	})
	if ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": saved})
	}
}

// ===========================================================================
// 4. faculty.attendance.offline_attendance_diary_capture
// ===========================================================================

type captureMark struct {
	StudentID   uuid.UUID `json:"student_id"`
	Status      string    `json:"status"`
	MinutesLate *int32    `json:"minutes_late"`
	Remarks     *string   `json:"remarks"`
}

type captureDiaryLine struct {
	ClassSubjectID  *uuid.UUID `json:"class_subject_id"`
	Kind            string     `json:"kind"`
	Body            string     `json:"body"`
	VisibleToFamily *bool      `json:"is_visible_to_family"`
}

type captureRequest struct {
	SectionID      uuid.UUID          `json:"section_id"`
	OnDate         string             `json:"on_date"`
	ClientBatchRef string             `json:"client_batch_ref"`
	CapturedAt     string             `json:"captured_at"`
	DeviceNote     *string            `json:"device_note"`
	Marks          []captureMark      `json:"marks"`
	Diary          []captureDiaryLine `json:"diary"`
}

type captureConflictRow struct {
	ID             string  `json:"id"`
	StudentID      string  `json:"student_id"`
	StudentName    string  `json:"student_name"`
	AdmissionNo    string  `json:"admission_no"`
	OnDate         string  `json:"on_date"`
	OfflineStatus  string  `json:"offline_status"`
	ServerStatus   string  `json:"server_status"`
	ServerMarkedBy *string `json:"server_marked_by,omitempty"`
	ServerMarkedAt *string `json:"server_marked_at,omitempty"`
	Resolution     string  `json:"resolution"`
}

type captureResult struct {
	BatchID    string               `json:"batch_id"`
	Replayed   bool                 `json:"replayed"`
	Accepted   int                  `json:"accepted"`
	Conflicted int                  `json:"conflicted"`
	DiaryLines int                  `json:"diary_lines"`
	Conflicts  []captureConflictRow `json:"conflicts"`
}

/*
syncCapturedRegister takes a day's register recorded while the device was
offline and replays it.

	What this endpoint does, precisely, because the feature name promises more
	than any server alone can deliver:

	  - it is idempotent per client_batch_ref, so a device that loses the
	    response and retries does not double-write and does not report the same
	    conflicts twice;
	  - it records when the teacher marked the register, separately from when
	    the server heard about it, because on a field trip those differ by
	    hours and the first is what the teacher will be asked about;
	  - it will create a register row that does not exist, and it will update
	    one this same batch created, and it will do nothing else. A row somebody
	    else entered in the meantime is NOT overwritten: the offline value, the
	    server value and who wrote it are recorded as a conflict and handed back
	    for a person to decide.

	That last rule is the whole design. Last-write-wins would mean a device that
	has been out of signal since 09:00 silently erasing an absence the office
	corrected to 'leave' at 11:00 with a phone call from the parent in hand.
	The offline copy is always the one with less information.

	What the client does is described in classroom-keys.ts and in the report:
	it queues in the browser and replays on reconnect. It is not an installable
	offline PWA and nothing here should be read as claiming one.
*/
func (s *Server) syncCapturedRegister(w http.ResponseWriter, r *http.Request) {
	var in captureRequest
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.SectionID == uuid.Nil {
		httpx.BadRequest(w, r, "a capture needs a section")
		return
	}
	if strings.TrimSpace(in.ClientBatchRef) == "" {
		httpx.BadRequest(w, r, "client_batch_ref is required — it is what makes a replay safe")
		return
	}
	onDate, err := time.Parse("2006-01-02", strings.TrimSpace(in.OnDate))
	if err != nil {
		httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
		return
	}
	capturedAt := time.Now()
	if strings.TrimSpace(in.CapturedAt) != "" {
		capturedAt, err = time.Parse(time.RFC3339, strings.TrimSpace(in.CapturedAt))
		if err != nil {
			httpx.BadRequest(w, r, "captured_at must be an RFC3339 timestamp")
			return
		}
	}
	for _, m := range in.Marks {
		switch m.Status {
		case "present", "absent", "late", "half_day", "leave", "holiday":
		default:
			httpx.BadRequest(w, r, "unknown attendance status: "+m.Status)
			return
		}
	}
	for _, d := range in.Diary {
		switch d.Kind {
		case "", "note", "classwork", "homework", "reminder":
		default:
			httpx.BadRequest(w, r, "unknown diary kind: "+d.Kind)
			return
		}
		if strings.TrimSpace(d.Body) == "" {
			httpx.BadRequest(w, r, "a diary line needs text")
			return
		}
	}

	id := httpx.IdentityFrom(r.Context())
	out := captureResult{Conflicts: []captureConflictRow{}}
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		// AnySection is the widener the schema already has for "may mark a
		// register they do not teach"; a class teacher without it reaches only
		// their own sections.
		if !res.AnySection && !classReachesSection(res, in.SectionID) {
			return errClassroomDenied
		}

		var batchID uuid.UUID
		var existing bool
		err := tx.QueryRow(r.Context(), `
			INSERT INTO attendance_capture_batches
			    (institution_id, section_id, on_date, client_batch_ref,
			     captured_at, device_note, submitted_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (institution_id, client_batch_ref) DO NOTHING
			RETURNING id`,
			id.InstitutionID, in.SectionID, onDate, strings.TrimSpace(in.ClientBatchRef),
			capturedAt, in.DeviceNote, id.UserID).Scan(&batchID)
		if errors.Is(err, pgx.ErrNoRows) {
			// A replay. Return the batch's stored outcome rather than
			// applying anything again — the device asked the same question
			// twice and must get the same answer.
			existing = true
			if err := tx.QueryRow(r.Context(), `
				SELECT id, rows_accepted, rows_conflicted
				  FROM attendance_capture_batches
				 WHERE institution_id = $1 AND client_batch_ref = $2`,
				id.InstitutionID, strings.TrimSpace(in.ClientBatchRef)).
				Scan(&batchID, &out.Accepted, &out.Conflicted); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		out.BatchID = batchID.String()
		out.Replayed = existing

		if !existing {
			for _, m := range in.Marks {
				applied, conflict, err := applyCapturedMark(r.Context(), tx, res,
					id.UserID, id.InstitutionID, batchID, in.SectionID, onDate, capturedAt, m)
				if err != nil {
					return err
				}
				if applied {
					out.Accepted++
				}
				if conflict {
					out.Conflicted++
				}
			}
			for _, d := range in.Diary {
				kind := d.Kind
				if kind == "" {
					kind = "note"
				}
				visible := d.VisibleToFamily == nil || *d.VisibleToFamily
				ct, err := tx.Exec(r.Context(), `
					INSERT INTO class_diary_entries
					    (institution_id, section_id, class_subject_id, on_date, kind,
					     body, captured_offline, captured_at, capture_batch_id,
					     is_visible_to_family, written_by)
					VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10)
					ON CONFLICT DO NOTHING`,
					id.InstitutionID, in.SectionID, d.ClassSubjectID, onDate, kind,
					strings.TrimSpace(d.Body), capturedAt, batchID, visible, id.UserID)
				if err != nil {
					return err
				}
				out.DiaryLines += int(ct.RowsAffected())
			}
			if _, err := tx.Exec(r.Context(), `
				UPDATE attendance_capture_batches
				   SET rows_accepted = $2, rows_conflicted = $3
				 WHERE id = $1`, batchID, out.Accepted, out.Conflicted); err != nil {
				return err
			}
		}

		rows, err := tx.Query(r.Context(), `
			SELECT c.id::text, st.id::text,
			       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
			       to_char(c.on_date, 'YYYY-MM-DD'),
			       c.offline_status, c.server_status, u.full_name,
			       to_char(c.server_marked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       c.resolution
			  FROM attendance_capture_conflicts c
			  JOIN students st ON st.id = c.student_id
			  LEFT JOIN users u ON u.id = c.server_marked_by
			 WHERE c.batch_id = $1
			 ORDER BY st.admission_no`, batchID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v captureConflictRow
			if err := rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.OnDate, &v.OfflineStatus, &v.ServerStatus, &v.ServerMarkedBy,
				&v.ServerMarkedAt, &v.Resolution); err != nil {
				return err
			}
			out.Conflicts = append(out.Conflicts, v)
		}
		return rows.Err()
	})
	if ok {
		httpx.JSON(w, http.StatusOK, out)
	}
}

/*
applyCapturedMark writes one child's offline mark, or records why it could not.

	The decision is made on what is already in student_attendance for that child
	on that day, at the daily (period_id IS NULL) grain that the existing
	student_attendance_daily unique index enforces:

	  nothing there            -> insert, flagged as captured offline
	  a row from this batch    -> update it; a device correcting itself before
	                              the sync is still one act of marking
	  anyone else's row        -> refuse, and record both values as a conflict

	The third case deliberately does not compare statuses first. Two people
	independently marking the same child present is still two people marking the
	same register, and a teacher is entitled to know their offline copy was not
	what the office was working from.
*/
func applyCapturedMark(ctx context.Context, tx pgx.Tx, res *scope.Resolved,
	userID, instID, batchID, sectionID uuid.UUID, onDate, capturedAt time.Time,
	m captureMark) (applied bool, conflicted bool, err error) {
	// The child must actually be in the section the batch names. A device
	// carrying a stale roster would otherwise write a mark against a child who
	// has since moved class.
	var enrolled bool
	if err = tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM enrollments e
		                WHERE e.student_id = $1 AND e.status = 'active'
		                  AND e.section_id = $2)`,
		m.StudentID, sectionID).Scan(&enrolled); err != nil {
		return false, false, err
	}
	if !enrolled {
		return false, false, nil
	}

	var existingID uuid.UUID
	var existingStatus string
	var existingBatch *uuid.UUID
	var markedBy *uuid.UUID
	var markedAt time.Time
	err = tx.QueryRow(ctx, `
		SELECT id, status, capture_batch_id, marked_by, marked_at
		  FROM student_attendance
		 WHERE student_id = $1 AND on_date = $2 AND period_id IS NULL`,
		m.StudentID, onDate).Scan(&existingID, &existingStatus, &existingBatch,
		&markedBy, &markedAt)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		if _, err = tx.Exec(ctx, `
			INSERT INTO student_attendance
			    (institution_id, student_id, section_id, on_date, status,
			     minutes_late, remarks, marked_by, captured_offline,
			     captured_at, capture_batch_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10)
			ON CONFLICT DO NOTHING`,
			instID, m.StudentID, sectionID, onDate, m.Status,
			m.MinutesLate, m.Remarks, userID, capturedAt, batchID); err != nil {
			return false, false, err
		}
		return true, false, nil

	case err != nil:
		return false, false, err

	case existingBatch != nil && *existingBatch == batchID:
		if _, err = tx.Exec(ctx, `
			UPDATE student_attendance
			   SET status = $2, minutes_late = $3, remarks = $4,
			       captured_at = $5, marked_at = now()
			 WHERE id = $1`,
			existingID, m.Status, m.MinutesLate, m.Remarks, capturedAt); err != nil {
			return false, false, err
		}
		return true, false, nil
	}

	// Somebody else's row. Keep it, and hand the disagreement back.
	if _, err = tx.Exec(ctx, `
		INSERT INTO attendance_capture_conflicts
		    (institution_id, batch_id, student_id, on_date, offline_status,
		     offline_remarks, server_status, server_marked_by, server_marked_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (batch_id, student_id) DO NOTHING`,
		instID, batchID, m.StudentID, onDate, m.Status, m.Remarks,
		existingStatus, markedBy, markedAt); err != nil {
		return false, false, err
	}
	return false, true, nil
}

func (s *Server) listCaptureBatches(w http.ResponseWriter, r *http.Request) {
	type batchRow struct {
		ID          string  `json:"id"`
		SectionID   string  `json:"section_id"`
		SectionName string  `json:"section_name"`
		OnDate      string  `json:"on_date"`
		CapturedAt  string  `json:"captured_at"`
		SyncedAt    string  `json:"synced_at"`
		DeviceNote  *string `json:"device_note,omitempty"`
		Accepted    int32   `json:"rows_accepted"`
		Conflicted  int32   `json:"rows_conflicted"`
	}
	var out []batchRow
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		where, args := "TRUE", []any{}
		if !(res.AllAttendance || res.AnySection) {
			if len(res.SectionIDs) == 0 {
				return nil
			}
			where = "b.section_id = ANY($1)"
			args = append(args, res.SectionIDs)
		}
		rows, err := tx.Query(r.Context(), `
			SELECT b.id::text, b.section_id::text, COALESCE(sec.name, '—'),
			       to_char(b.on_date, 'YYYY-MM-DD'),
			       to_char(b.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       to_char(b.synced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       b.device_note, b.rows_accepted, b.rows_conflicted
			  FROM attendance_capture_batches b
			  LEFT JOIN sections sec ON sec.id = b.section_id
			 WHERE `+where+`
			 ORDER BY b.synced_at DESC
			 LIMIT 200`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v batchRow
			if err := rows.Scan(&v.ID, &v.SectionID, &v.SectionName, &v.OnDate,
				&v.CapturedAt, &v.SyncedAt, &v.DeviceNote, &v.Accepted,
				&v.Conflicted); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if ok {
		itemsJSON(w, out)
	}
}

func (s *Server) listCaptureConflicts(w http.ResponseWriter, r *http.Request) {
	openOnly := r.URL.Query().Get("resolution") != "all"
	var out []captureConflictRow
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		where := []string{"TRUE"}
		args := []any{}
		if openOnly {
			where = append(where, "c.resolution = 'pending'")
		}
		if !(res.AllAttendance || res.AnySection) {
			if len(res.SectionIDs) == 0 {
				return nil
			}
			args = append(args, res.SectionIDs)
			where = append(where, fmt.Sprintf("b.section_id = ANY($%d)", len(args)))
		}
		rows, err := tx.Query(r.Context(), `
			SELECT c.id::text, st.id::text,
			       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
			       to_char(c.on_date, 'YYYY-MM-DD'),
			       c.offline_status, c.server_status, u.full_name,
			       to_char(c.server_marked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'Z',
			       c.resolution
			  FROM attendance_capture_conflicts c
			  JOIN attendance_capture_batches b ON b.id = c.batch_id
			  JOIN students st ON st.id = c.student_id
			  LEFT JOIN users u ON u.id = c.server_marked_by
			 WHERE `+strings.Join(where, " AND ")+`
			 ORDER BY c.on_date DESC, st.admission_no
			 LIMIT 500`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v captureConflictRow
			if err := rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.OnDate, &v.OfflineStatus, &v.ServerStatus, &v.ServerMarkedBy,
				&v.ServerMarkedAt, &v.Resolution); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if ok {
		itemsJSON(w, out)
	}
}

/*
resolveCaptureConflict is a person deciding which of the two values stands.

	Applying the offline value goes through the register's own correction
	columns — corrected_from, corrected_by, corrected_at — rather than
	overwriting status quietly. attendance_corrections has existed since the
	baseline for exactly this, and a conflict resolution that left no trace
	would be the one thing worse than last-write-wins.
*/
func (s *Server) resolveCaptureConflict(w http.ResponseWriter, r *http.Request) {
	conflictID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var in struct {
		Resolution string `json:"resolution"` // kept | applied
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Resolution != "kept" && in.Resolution != "applied" {
		httpx.BadRequest(w, r, "resolution must be kept or applied")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	if s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		var studentID, sectionID uuid.UUID
		var onDate time.Time
		var offlineStatus, resolution string
		var offlineRemarks *string
		if err := tx.QueryRow(r.Context(), `
			SELECT c.student_id, b.section_id, c.on_date, c.offline_status,
			       c.offline_remarks, c.resolution
			  FROM attendance_capture_conflicts c
			  JOIN attendance_capture_batches b ON b.id = c.batch_id
			 WHERE c.id = $1`, conflictID).
			Scan(&studentID, &sectionID, &onDate, &offlineStatus,
				&offlineRemarks, &resolution); err != nil {
			return err
		}
		if !res.AnySection && !classReachesSection(res, sectionID) {
			return errClassroomDenied
		}
		if resolution != "pending" {
			return badInput("that conflict has already been resolved")
		}
		if in.Resolution == "applied" {
			if _, err := tx.Exec(r.Context(), `
				UPDATE student_attendance
				   SET corrected_from = status,
				       status         = $3,
				       remarks        = COALESCE($4, remarks),
				       corrected_by   = $5,
				       corrected_at   = now()
				 WHERE student_id = $1 AND on_date = $2 AND period_id IS NULL`,
				studentID, onDate, offlineStatus, offlineRemarks, id.UserID); err != nil {
				return err
			}
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE attendance_capture_conflicts
			   SET resolution = $2, resolved_by = $3, resolved_at = now()
			 WHERE id = $1`, conflictID, in.Resolution, id.UserID)
		return err
	}) {
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

type diaryEntryRow struct {
	ID              string  `json:"id"`
	SectionID       string  `json:"section_id"`
	SectionName     string  `json:"section_name"`
	SubjectName     *string `json:"subject_name,omitempty"`
	OnDate          string  `json:"on_date"`
	Kind            string  `json:"kind"`
	Body            string  `json:"body"`
	CapturedOffline bool    `json:"captured_offline"`
	VisibleToFamily bool    `json:"is_visible_to_family"`
	WrittenBy       *string `json:"written_by,omitempty"`
}

func (s *Server) listDiaryEntries(w http.ResponseWriter, r *http.Request) {
	sectionID, err := queryUUID(r, "section_id")
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	var out []diaryEntryRow
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		where := []string{"TRUE"}
		args := []any{}
		if sectionID != nil {
			if !classReachesSection(res, *sectionID) {
				return errClassroomDenied
			}
			args = append(args, *sectionID)
			where = append(where, fmt.Sprintf("d.section_id = $%d", len(args)))
		} else if !(res.AllAttendance || res.AllStudents) {
			if len(res.SectionIDs) == 0 {
				return nil
			}
			args = append(args, res.SectionIDs)
			where = append(where, fmt.Sprintf("d.section_id = ANY($%d)", len(args)))
		}
		rows, err := tx.Query(r.Context(), `
			SELECT d.id::text, d.section_id::text, COALESCE(sec.name, '—'), sub.name,
			       to_char(d.on_date, 'YYYY-MM-DD'), d.kind, d.body,
			       d.captured_offline, d.is_visible_to_family, u.full_name
			  FROM class_diary_entries d
			  LEFT JOIN sections sec ON sec.id = d.section_id
			  LEFT JOIN class_subjects cs ON cs.id = d.class_subject_id
			  LEFT JOIN subjects sub ON sub.id = cs.subject_id
			  LEFT JOIN users u ON u.id = d.written_by
			 WHERE `+strings.Join(where, " AND ")+`
			 ORDER BY d.on_date DESC, d.created_at DESC
			 LIMIT 300`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v diaryEntryRow
			if err := rows.Scan(&v.ID, &v.SectionID, &v.SectionName, &v.SubjectName,
				&v.OnDate, &v.Kind, &v.Body, &v.CapturedOffline,
				&v.VisibleToFamily, &v.WrittenBy); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if ok {
		itemsJSON(w, out)
	}
}

// saveDiaryEntry writes one line online. The same table the offline sync writes
// to, so the diary a teacher keeps on a trip and the one they type at their
// desk are the same diary.
func (s *Server) saveDiaryEntry(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SectionID       uuid.UUID  `json:"section_id"`
		ClassSubjectID  *uuid.UUID `json:"class_subject_id"`
		OnDate          *string    `json:"on_date"`
		Kind            string     `json:"kind"`
		Body            string     `json:"body"`
		VisibleToFamily *bool      `json:"is_visible_to_family"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.SectionID == uuid.Nil || strings.TrimSpace(in.Body) == "" {
		httpx.BadRequest(w, r, "a diary line needs a section and some text")
		return
	}
	kind := in.Kind
	if kind == "" {
		kind = "note"
	}
	switch kind {
	case "note", "classwork", "homework", "reminder":
	default:
		httpx.BadRequest(w, r, "unknown diary kind")
		return
	}
	onDate := time.Now()
	if in.OnDate != nil && strings.TrimSpace(*in.OnDate) != "" {
		parsed, err := time.Parse("2006-01-02", strings.TrimSpace(*in.OnDate))
		if err != nil {
			httpx.BadRequest(w, r, "on_date must be YYYY-MM-DD")
			return
		}
		onDate = parsed
	}
	id := httpx.IdentityFrom(r.Context())
	visible := in.VisibleToFamily == nil || *in.VisibleToFamily
	var saved string
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if !classReachesSection(res, in.SectionID) {
			return errClassroomDenied
		}
		err := tx.QueryRow(r.Context(), `
			INSERT INTO class_diary_entries
			    (institution_id, section_id, class_subject_id, on_date, kind,
			     body, is_visible_to_family, written_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT DO NOTHING
			RETURNING id::text`,
			id.InstitutionID, in.SectionID, in.ClassSubjectID, onDate, kind,
			strings.TrimSpace(in.Body), visible, id.UserID).Scan(&saved)
		if errors.Is(err, pgx.ErrNoRows) {
			return badInput("that line is already in the diary for this day")
		}
		return err
	})
	if ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": saved})
	}
}

// ===========================================================================
// 5. faculty.question_papers_online_tests.no_omr_exam_grading
// ===========================================================================

type gradableTestRow struct {
	ID            string  `json:"id"`
	Title         string  `json:"title"`
	SectionID     string  `json:"section_id"`
	SectionName   string  `json:"section_name"`
	SubjectName   string  `json:"subject_name"`
	Status        string  `json:"status"`
	Questions     int32   `json:"question_count"`
	MaxScore      float64 `json:"max_score"`
	RollStrength  int32   `json:"roll_strength"`
	Graded        int32   `json:"graded_attempts"`
	PartialCredit bool    `json:"allow_partial_credit"`
}

func (s *Server) listGradableTests(w http.ResponseWriter, r *http.Request) {
	var out []gradableTestRow
	ok := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		where, args := "TRUE", []any{}
		if !res.AllStudents {
			if len(res.SectionIDs) == 0 {
				return nil
			}
			where = "t.section_id = ANY($1)"
			args = append(args, res.SectionIDs)
		}
		rows, err := tx.Query(r.Context(), `
			SELECT t.id::text, t.title, t.section_id::text, COALESCE(sec.name, '—'),
			       sub.name, t.status,
			       COALESCE(q.n, 0), COALESCE(q.total, 0),
			       (SELECT count(*) FROM enrollments e
			         WHERE e.section_id = t.section_id AND e.status = 'active')::int,
			       (SELECT count(*) FROM online_test_attempts a
			         WHERE a.test_id = t.id AND a.status = 'graded')::int,
			       t.allow_partial_credit
			  FROM online_tests t
			  LEFT JOIN sections sec ON sec.id = t.section_id
			  JOIN class_subjects cs ON cs.id = t.class_subject_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			  LEFT JOIN LATERAL (
			      SELECT count(*)::int AS n, COALESCE(sum(tq.marks), 0)::float8 AS total
			        FROM online_test_questions tq WHERE tq.test_id = t.id
			  ) q ON TRUE
			 WHERE `+where+`
			 ORDER BY t.created_at DESC
			 LIMIT 200`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v gradableTestRow
			if err := rows.Scan(&v.ID, &v.Title, &v.SectionID, &v.SectionName,
				&v.SubjectName, &v.Status, &v.Questions, &v.MaxScore,
				&v.RollStrength, &v.Graded, &v.PartialCredit); err != nil {
				return err
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if ok {
		itemsJSON(w, out)
	}
}

// gradingKeyQuestion is one question as the entry screen needs it: the stem,
// every option in reading order, and — because this is the teacher's screen and
// nobody else's — which of them are right.
type gradingKeyQuestion struct {
	TestQuestionID string             `json:"test_question_id"`
	Sequence       int32              `json:"sequence"`
	Kind           string             `json:"kind"`
	Stem           string             `json:"stem"`
	Marks          float64            `json:"marks"`
	NegativeMarks  float64            `json:"negative_marks"`
	MultiAnswer    bool               `json:"multi_answer"`
	Options        []gradingKeyOption `json:"options"`
}

type gradingKeyOption struct {
	ID        string `json:"id"`
	Sequence  int32  `json:"sequence"`
	Body      string `json:"body"`
	IsCorrect bool   `json:"is_correct"`
}

type gradingKeyStudent struct {
	StudentID   string   `json:"student_id"`
	AdmissionNo string   `json:"admission_no"`
	StudentName string   `json:"student_name"`
	AttemptID   *string  `json:"attempt_id,omitempty"`
	Status      *string  `json:"attempt_status,omitempty"`
	Score       *float64 `json:"score,omitempty"`
}

type gradingKeyView struct {
	TestID        string               `json:"test_id"`
	Title         string               `json:"title"`
	MaxScore      float64              `json:"max_score"`
	PartialCredit bool                 `json:"allow_partial_credit"`
	Questions     []gradingKeyQuestion `json:"questions"`
	Roster        []gradingKeyStudent  `json:"roster"`
}

// getGradingKey is the answer-key entry screen: the paper, the key, and the
// roll with whoever has already been entered.
func (s *Server) getGradingKey(w http.ResponseWriter, r *http.Request) {
	testID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	view := gradingKeyView{TestID: testID.String(),
		Questions: []gradingKeyQuestion{}, Roster: []gradingKeyStudent{}}
	done := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		sectionID, err := gradingTestSection(r.Context(), tx, res, testID)
		if err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(),
			`SELECT title, allow_partial_credit FROM online_tests WHERE id = $1`,
			testID).Scan(&view.Title, &view.PartialCredit); err != nil {
			return err
		}
		qs, err := loadGradingQuestions(r.Context(), tx, testID)
		if err != nil {
			return err
		}
		for _, q := range qs {
			view.Questions = append(view.Questions, q.view())
			view.MaxScore += q.Marks
		}
		rows, err := tx.Query(r.Context(), `
			SELECT st.id::text, st.admission_no,
			       concat_ws(' ', st.first_name, st.last_name),
			       a.id::text, a.status, a.score::float8
			  FROM students st
			  JOIN enrollments e ON e.student_id = st.id
			                    AND e.status = 'active' AND e.section_id = $1
			  LEFT JOIN LATERAL (
			      SELECT id, status, score FROM online_test_attempts at
			       WHERE at.test_id = $2 AND at.student_id = st.id
			         AND at.status <> 'void'
			       ORDER BY at.attempt_no DESC LIMIT 1
			  ) a ON TRUE
			 ORDER BY st.admission_no`, sectionID, testID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v gradingKeyStudent
			if err := rows.Scan(&v.StudentID, &v.AdmissionNo, &v.StudentName,
				&v.AttemptID, &v.Status, &v.Score); err != nil {
				return err
			}
			view.Roster = append(view.Roster, v)
		}
		return rows.Err()
	})
	if done {
		httpx.JSON(w, http.StatusOK, view)
	}
}

// gradingTestSection resolves a test to its section and refuses one outside the
// caller's reach. Every grading endpoint starts here.
func gradingTestSection(ctx context.Context, tx pgx.Tx, res *scope.Resolved,
	testID uuid.UUID) (uuid.UUID, error) {
	var sectionID uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT section_id FROM online_tests WHERE id = $1`, testID).Scan(&sectionID); err != nil {
		return uuid.Nil, err
	}
	if !classReachesSection(res, sectionID) {
		return uuid.Nil, errClassroomDenied
	}
	return sectionID, nil
}

// gradingQuestion is one question with everything grading needs, loaded once
// per request rather than per answer sheet.
type gradingQuestion struct {
	TestQuestionID uuid.UUID
	QuestionID     uuid.UUID
	Sequence       int32
	Kind           string
	Stem           string
	Marks          float64
	Negative       float64
	Options        []gradingOption
}

type gradingOption struct {
	ID        uuid.UUID
	Sequence  int32
	Body      string
	IsCorrect bool
}

func (q gradingQuestion) correctIDs() map[uuid.UUID]bool {
	out := map[uuid.UUID]bool{}
	for _, o := range q.Options {
		if o.IsCorrect {
			out[o.ID] = true
		}
	}
	return out
}

func (q gradingQuestion) view() gradingKeyQuestion {
	v := gradingKeyQuestion{TestQuestionID: q.TestQuestionID.String(),
		Sequence: q.Sequence, Kind: q.Kind, Stem: q.Stem, Marks: q.Marks,
		NegativeMarks: q.Negative, MultiAnswer: len(q.correctIDs()) > 1,
		Options: []gradingKeyOption{}}
	for _, o := range q.Options {
		v.Options = append(v.Options, gradingKeyOption{ID: o.ID.String(),
			Sequence: o.Sequence, Body: o.Body, IsCorrect: o.IsCorrect})
	}
	return v
}

func loadGradingQuestions(ctx context.Context, tx pgx.Tx, testID uuid.UUID) ([]gradingQuestion, error) {
	rows, err := tx.Query(ctx, `
		SELECT tq.id, q.id, tq.sequence, q.kind, q.stem,
		       tq.marks::float8, tq.negative_marks::float8
		  FROM online_test_questions tq
		  JOIN question_bank_questions q ON q.id = tq.question_id
		 WHERE tq.test_id = $1
		 ORDER BY tq.sequence`, testID)
	if err != nil {
		return nil, err
	}
	var out []gradingQuestion
	byQuestion := map[uuid.UUID][]int{}
	for rows.Next() {
		var q gradingQuestion
		if err := rows.Scan(&q.TestQuestionID, &q.QuestionID, &q.Sequence,
			&q.Kind, &q.Stem, &q.Marks, &q.Negative); err != nil {
			rows.Close()
			return nil, err
		}
		byQuestion[q.QuestionID] = append(byQuestion[q.QuestionID], len(out))
		out = append(out, q)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	opts, err := tx.Query(ctx, `
		SELECT o.question_id, o.id, o.sequence, o.body, o.is_correct
		  FROM question_bank_options o
		  JOIN online_test_questions tq ON tq.question_id = o.question_id
		 WHERE tq.test_id = $1
		 ORDER BY o.sequence`, testID)
	if err != nil {
		return nil, err
	}
	defer opts.Close()
	for opts.Next() {
		var qid uuid.UUID
		var o gradingOption
		if err := opts.Scan(&qid, &o.ID, &o.Sequence, &o.Body, &o.IsCorrect); err != nil {
			return nil, err
		}
		// The same bank question may legitimately sit on the paper once only —
		// online_test_questions_once enforces that — so this loop assigns each
		// option to the single row that holds it.
		for _, i := range byQuestion[qid] {
			out[i].Options = append(out[i].Options, o)
		}
	}
	return out, opts.Err()
}

type answerSheetResponse struct {
	TestQuestionID  uuid.UUID   `json:"test_question_id"`
	SelectedOptions []uuid.UUID `json:"selected_option_ids"`
	TextResponse    *string     `json:"text_response"`
}

type answerSheetRequest struct {
	StudentID uuid.UUID             `json:"student_id"`
	AttemptNo *int32                `json:"attempt_no"`
	Responses []answerSheetResponse `json:"responses"`
}

type gradedSheet struct {
	AttemptID   string  `json:"attempt_id"`
	Score       float64 `json:"score"`
	MaxScore    float64 `json:"max_score"`
	Correct     int     `json:"correct"`
	Wrong       int     `json:"wrong"`
	Unattempted int     `json:"unattempted"`
}

/*
enterAnswerSheet is a teacher typing one child's paper script in, and grading it.

	This is what "no OMR" means in practice: no scanner, no special sheet, a
	teacher with a stack of scripts and a keyboard. It writes an attempt with
	source 'key_entry' and grades it through gradeAttempt — the same function a
	portal attempt goes through — so the item analysis over a hand-entered paper
	and a portal one is one analysis rather than two.
*/
func (s *Server) enterAnswerSheet(w http.ResponseWriter, r *http.Request) {
	testID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var in answerSheetRequest
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.StudentID == uuid.Nil {
		httpx.BadRequest(w, r, "an answer sheet needs a student")
		return
	}
	id := httpx.IdentityFrom(r.Context())
	var out gradedSheet
	done := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		sectionID, err := gradingTestSection(r.Context(), tx, res, testID)
		if err != nil {
			return err
		}
		var enrolled bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM enrollments e
			                WHERE e.student_id = $1 AND e.status = 'active'
			                  AND e.section_id = $2)`,
			in.StudentID, sectionID).Scan(&enrolled); err != nil {
			return err
		}
		if !enrolled {
			return badInput("that child does not sit in the section this test was set for")
		}
		questions, err := loadGradingQuestions(r.Context(), tx, testID)
		if err != nil {
			return err
		}
		if len(questions) == 0 {
			return badInput("that paper has no questions on it yet")
		}
		byTQ := map[uuid.UUID]gradingQuestion{}
		for _, q := range questions {
			byTQ[q.TestQuestionID] = q
		}
		for _, resp := range in.Responses {
			if _, found := byTQ[resp.TestQuestionID]; !found {
				return badInput("a response names a question that is not on this paper")
			}
		}

		attemptNo := int32(1)
		if in.AttemptNo != nil && *in.AttemptNo > 0 {
			attemptNo = *in.AttemptNo
		}
		var attemptID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO online_test_attempts
			    (institution_id, test_id, student_id, attempt_no, source,
			     status, submitted_at, entered_by)
			VALUES ($1, $2, $3, $4, 'key_entry', 'submitted', now(), $5)
			ON CONFLICT (test_id, student_id, attempt_no)
			DO UPDATE SET status = 'submitted', submitted_at = now(),
			              entered_by = EXCLUDED.entered_by, updated_at = now()
			RETURNING id`,
			id.InstitutionID, testID, in.StudentID, attemptNo, id.UserID).
			Scan(&attemptID); err != nil {
			return err
		}

		// A re-entry replaces the sheet rather than merging with it: a teacher
		// correcting a mis-keyed script means the new sheet, not the union of
		// the two.
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM online_test_responses WHERE attempt_id = $1`, attemptID); err != nil {
			return err
		}
		for _, resp := range in.Responses {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO online_test_responses
				    (institution_id, attempt_id, test_question_id,
				     selected_option_ids, text_response)
				VALUES ($1, $2, $3, $4, $5)`,
				id.InstitutionID, attemptID, resp.TestQuestionID,
				resp.SelectedOptions, resp.TextResponse); err != nil {
				return err
			}
		}
		out, err = gradeAttempt(r.Context(), tx, attemptID, questions, id.UserID)
		return err
	})
	if done {
		httpx.JSON(w, http.StatusOK, out)
	}
}

/*
gradeAttempt marks one sitting and writes the result back.

	Three rules that are all real requirements of Indian objective papers and
	all get this wrong when they are implemented ad hoc:

	  multiple correct answers   a question whose key has more than one right
	                             option is marked on the whole set. All of them
	                             and nothing else is right; anything less is
	                             wrong, unless the paper allows partial credit,
	                             in which case the award is the net proportion
	                             of the key found — right options chosen minus
	                             wrong ones — and never below zero.
	  negative marking           applies to a wrong answer and NEVER to an
	                             unanswered one. That distinction is why an
	                             empty selection array and no response row are
	                             different things in the schema.
	  per-question weight        already on online_test_questions.marks, which
	                             is per paper rather than per bank question.

	Fill-in-the-blank and short answers are compared against the correct option
	bodies case- and whitespace-insensitively. A long answer cannot be graded
	this way, so it is left ungraded and excluded from the max — reporting a
	child as having lost the marks for an essay nobody has read yet would be a
	lie with a number on it.
*/
func gradeAttempt(ctx context.Context, tx pgx.Tx, attemptID uuid.UUID,
	questions []gradingQuestion, graderID uuid.UUID) (gradedSheet, error) {
	out := gradedSheet{AttemptID: attemptID.String()}
	var partialCredit bool
	if err := tx.QueryRow(ctx, `
		SELECT t.allow_partial_credit
		  FROM online_test_attempts a
		  JOIN online_tests t ON t.id = a.test_id
		 WHERE a.id = $1`, attemptID).Scan(&partialCredit); err != nil {
		return out, err
	}

	type given struct {
		selected []uuid.UUID
		text     *string
	}
	answers := map[uuid.UUID]given{}
	rows, err := tx.Query(ctx, `
		SELECT test_question_id, selected_option_ids, text_response
		  FROM online_test_responses WHERE attempt_id = $1`, attemptID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var tq uuid.UUID
		var g given
		if err := rows.Scan(&tq, &g.selected, &g.text); err != nil {
			rows.Close()
			return out, err
		}
		answers[tq] = g
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	var score, maxScore float64
	for _, q := range questions {
		if q.Kind == "long" {
			// Not machine-gradable. Excluded from both sides of the fraction.
			continue
		}
		maxScore += q.Marks
		g, answered := answers[q.TestQuestionID]
		attempted := answered && (len(g.selected) > 0 ||
			(g.text != nil && strings.TrimSpace(*g.text) != ""))
		if !attempted {
			out.Unattempted++
			if answered {
				if _, err := tx.Exec(ctx, `
					UPDATE online_test_responses
					   SET is_correct = NULL, marks_awarded = 0
					 WHERE attempt_id = $1 AND test_question_id = $2`,
					attemptID, q.TestQuestionID); err != nil {
					return out, err
				}
			}
			continue
		}

		correct := q.correctIDs()
		var awarded float64
		var right bool
		switch {
		case len(g.selected) > 0:
			hits, misses := 0, 0
			seen := map[uuid.UUID]bool{}
			for _, sel := range g.selected {
				if seen[sel] {
					continue
				}
				seen[sel] = true
				if correct[sel] {
					hits++
				} else {
					misses++
				}
			}
			right = misses == 0 && hits == len(correct) && hits > 0
			switch {
			case right:
				awarded = q.Marks
			case partialCredit && len(correct) > 0:
				net := float64(hits-misses) / float64(len(correct))
				if net < 0 {
					net = 0
				}
				awarded = q.Marks * net
				if awarded == 0 {
					awarded = -q.Negative
				}
			default:
				awarded = -q.Negative
			}
		default:
			// A typed answer. Any correct option body matching, ignoring case
			// and surrounding space, is right: "New Delhi" and "new delhi " are
			// the same answer and a child should not lose a mark to a space.
			typed := strings.ToLower(strings.Join(strings.Fields(*g.text), " "))
			for _, o := range q.Options {
				if !o.IsCorrect {
					continue
				}
				if strings.ToLower(strings.Join(strings.Fields(o.Body), " ")) == typed {
					right = true
					break
				}
			}
			if right {
				awarded = q.Marks
			} else {
				awarded = -q.Negative
			}
		}

		if right {
			out.Correct++
		} else {
			out.Wrong++
		}
		score += awarded
		if _, err := tx.Exec(ctx, `
			UPDATE online_test_responses
			   SET is_correct = $3, marks_awarded = $4
			 WHERE attempt_id = $1 AND test_question_id = $2`,
			attemptID, q.TestQuestionID, right, awarded); err != nil {
			return out, err
		}
	}

	// A paper with heavy negative marking can put a child below zero. Schools
	// report the floor rather than a negative total, and the per-question marks
	// are still stored unclamped for anyone who wants to see why.
	if score < 0 {
		score = 0
	}
	out.Score, out.MaxScore = clrRound2(score), clrRound2(maxScore)
	_, err = tx.Exec(ctx, `
		UPDATE online_test_attempts
		   SET score = $2, max_score = $3, status = 'graded',
		       graded_at = now(), graded_by = $4, updated_at = now()
		 WHERE id = $1`, attemptID, out.Score, out.MaxScore, graderID)
	return out, err
}

func clrRound2(v float64) float64 { return math.Round(v*100) / 100 }

// regradeTest re-marks every attempt on a paper.
//
// The reason this endpoint exists: a key entered wrongly is discovered by the
// item analysis below — a question the whole class got wrong is usually a
// mis-keyed answer, not thirty children failing the same idea — and after the
// teacher fixes the key, every sheet already entered has to be marked again.
func (s *Server) regradeTest(w http.ResponseWriter, r *http.Request) {
	testID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	id := httpx.IdentityFrom(r.Context())
	regraded := 0
	done := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if _, err := gradingTestSection(r.Context(), tx, res, testID); err != nil {
			return err
		}
		questions, err := loadGradingQuestions(r.Context(), tx, testID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT id FROM online_test_attempts
			 WHERE test_id = $1 AND status IN ('submitted', 'graded')
			 ORDER BY created_at`, testID)
		if err != nil {
			return err
		}
		var ids []uuid.UUID
		for rows.Next() {
			var a uuid.UUID
			if err := rows.Scan(&a); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, a)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, a := range ids {
			if _, err := gradeAttempt(r.Context(), tx, a, questions, id.UserID); err != nil {
				return err
			}
			regraded++
		}
		return nil
	})
	if done {
		httpx.JSON(w, http.StatusOK, map[string]any{"regraded": regraded})
	}
}

type gradingResultRow struct {
	AttemptID   string   `json:"attempt_id"`
	StudentID   string   `json:"student_id"`
	AdmissionNo string   `json:"admission_no"`
	StudentName string   `json:"student_name"`
	Source      string   `json:"source"`
	Status      string   `json:"status"`
	Score       *float64 `json:"score,omitempty"`
	MaxScore    *float64 `json:"max_score,omitempty"`
	Percent     *float64 `json:"percent,omitempty"`
}

func (s *Server) listGradingResults(w http.ResponseWriter, r *http.Request) {
	testID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	var out []gradingResultRow
	done := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if _, err := gradingTestSection(r.Context(), tx, res, testID); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT a.id::text, st.id::text, st.admission_no,
			       concat_ws(' ', st.first_name, st.last_name),
			       a.source, a.status, a.score::float8, a.max_score::float8
			  FROM online_test_attempts a
			  JOIN students st ON st.id = a.student_id
			 WHERE a.test_id = $1
			 ORDER BY a.score DESC NULLS LAST, st.admission_no`, testID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v gradingResultRow
			if err := rows.Scan(&v.AttemptID, &v.StudentID, &v.AdmissionNo,
				&v.StudentName, &v.Source, &v.Status, &v.Score, &v.MaxScore); err != nil {
				return err
			}
			if v.Score != nil && v.MaxScore != nil && *v.MaxScore > 0 {
				p := clrRound2(*v.Score / *v.MaxScore * 100)
				v.Percent = &p
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if done {
		itemsJSON(w, out)
	}
}

type itemAnalysisRow struct {
	TestQuestionID string  `json:"test_question_id"`
	Sequence       int32   `json:"sequence"`
	Stem           string  `json:"stem"`
	Marks          float64 `json:"marks"`
	Sat            int     `json:"sat"`
	Attempted      int     `json:"attempted"`
	Correct        int     `json:"correct"`
	// Facility (the p-value): the share of those who attempted it who got it
	// right. Below ~0.2 or above ~0.9 the question told the teacher nothing.
	Facility *float64 `json:"facility,omitempty"`
	// Discrimination: how much better the strong third of the class did on this
	// question than the weak third. Near zero or negative on a question the
	// class as a whole answered means the question, not the class, is wrong.
	Discrimination *float64 `json:"discrimination,omitempty"`
	// Which wrong option pulled the most children. A distractor nobody chose is
	// dead weight; one that beat the key is usually a mis-keyed answer.
	TopDistractor      *string `json:"top_distractor,omitempty"`
	TopDistractorCount int     `json:"top_distractor_count"`
	Flag               string  `json:"flag"` // ok | too_easy | too_hard | poor_discrimination | check_key
}

/*
getItemAnalysis is the half of grading that is actually worth having.

	A mark sheet says who failed. An item analysis says whether the paper was
	fair: question 7 was answered correctly by four children out of thirty, and
	the four were not the four who topped the paper — which is the signature of
	a mis-keyed answer, not of a hard question. A teacher without this looks at
	a low average and concludes the class did not revise.

	Discrimination is computed on the classic upper/lower 27% split, on scored
	attempts only. With fewer than six sitters the split is meaningless and the
	field is left null rather than filled with a number computed from two
	children.
*/
func (s *Server) getItemAnalysis(w http.ResponseWriter, r *http.Request) {
	testID, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	out := []itemAnalysisRow{}
	done := s.classroomTx(w, r, func(tx pgx.Tx, res *scope.Resolved) error {
		if _, err := gradingTestSection(r.Context(), tx, res, testID); err != nil {
			return err
		}
		questions, err := loadGradingQuestions(r.Context(), tx, testID)
		if err != nil {
			return err
		}
		if len(questions) == 0 {
			return nil
		}

		// Attempts in descending score order, so the upper and lower groups
		// are a slice of one list rather than two more queries.
		var attempts []uuid.UUID
		rows, err := tx.Query(r.Context(), `
			SELECT id FROM online_test_attempts
			 WHERE test_id = $1 AND status = 'graded'
			 ORDER BY score DESC NULLS LAST, created_at`, testID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var a uuid.UUID
			if err := rows.Scan(&a); err != nil {
				rows.Close()
				return err
			}
			attempts = append(attempts, a)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		rank := map[uuid.UUID]int{}
		for i, a := range attempts {
			rank[a] = i
		}
		type stat struct {
			attempted, correct, upperCorrect, lowerCorrect int
			distractors                                    map[uuid.UUID]int
		}
		stats := map[uuid.UUID]*stat{}
		for _, q := range questions {
			stats[q.TestQuestionID] = &stat{distractors: map[uuid.UUID]int{}}
		}
		group := len(attempts) * 27 / 100
		if group < 1 {
			group = 1
		}

		resp, err := tx.Query(r.Context(), `
			SELECT rp.attempt_id, rp.test_question_id, rp.is_correct,
			       rp.selected_option_ids, rp.text_response
			  FROM online_test_responses rp
			  JOIN online_test_attempts a ON a.id = rp.attempt_id
			 WHERE a.test_id = $1 AND a.status = 'graded'`, testID)
		if err != nil {
			return err
		}
		defer resp.Close()
		correctSets := map[uuid.UUID]map[uuid.UUID]bool{}
		for _, q := range questions {
			correctSets[q.TestQuestionID] = q.correctIDs()
		}
		for resp.Next() {
			var attempt, tq uuid.UUID
			var isCorrect *bool
			var selected []uuid.UUID
			var text *string
			if err := resp.Scan(&attempt, &tq, &isCorrect, &selected, &text); err != nil {
				return err
			}
			st, found := stats[tq]
			if !found {
				continue
			}
			if isCorrect == nil {
				continue // not attempted; it counts against nothing
			}
			st.attempted++
			if *isCorrect {
				st.correct++
				i := rank[attempt]
				if i < group {
					st.upperCorrect++
				}
				if i >= len(attempts)-group {
					st.lowerCorrect++
				}
				continue
			}
			for _, sel := range selected {
				if !correctSets[tq][sel] {
					st.distractors[sel]++
				}
			}
		}
		if err := resp.Err(); err != nil {
			return err
		}

		for _, q := range questions {
			st := stats[q.TestQuestionID]
			row := itemAnalysisRow{TestQuestionID: q.TestQuestionID.String(),
				Sequence: q.Sequence, Stem: truncateStem(q.Stem), Marks: q.Marks,
				Sat: len(attempts), Attempted: st.attempted, Correct: st.correct,
				Flag: "ok"}
			if st.attempted > 0 {
				f := clrRound2(float64(st.correct) / float64(st.attempted))
				row.Facility = &f
			}
			if len(attempts) >= 6 {
				d := clrRound2(float64(st.upperCorrect-st.lowerCorrect) / float64(group))
				row.Discrimination = &d
			}
			// The strongest wrong option, by name, so a teacher can see what
			// the class actually believed.
			best, bestN := uuid.Nil, 0
			for id, n := range st.distractors {
				if n > bestN {
					best, bestN = id, n
				}
			}
			if bestN > 0 {
				for _, o := range q.Options {
					if o.ID == best {
						body := o.Body
						row.TopDistractor = &body
						row.TopDistractorCount = bestN
					}
				}
			}
			switch {
			case row.Facility != nil && *row.Facility <= 0.2 && bestN > st.correct:
				// Almost nobody right, and a single wrong option beat the key.
				// That pattern is a wrong answer key far more often than it is
				// a hard question, and it is the one this screen exists for.
				row.Flag = "check_key"
			case row.Facility != nil && *row.Facility >= 0.95:
				row.Flag = "too_easy"
			case row.Facility != nil && *row.Facility <= 0.2:
				row.Flag = "too_hard"
			case row.Discrimination != nil && *row.Discrimination <= 0 && st.attempted > 0:
				row.Flag = "poor_discrimination"
			}
			out = append(out, row)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Sequence < out[j].Sequence })
		return nil
	})
	if done {
		itemsJSON(w, out)
	}
}

// truncateStem keeps the analysis table readable. The full stem is on the
// question bank screen, which is one click away and already built.
func truncateStem(s string) string {
	const max = 140
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}
