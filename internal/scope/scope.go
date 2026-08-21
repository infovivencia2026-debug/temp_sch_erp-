// Package scope resolves the concrete data boundary a request runs under.
//
// RLS already answers "which institution?" — it is enforced by Postgres and a
// handler cannot forget it. But the catalog describes six narrower scopes that
// RLS cannot express, because they depend on who the user is rather than which
// tenant they belong to:
//
//	campus            the campuses a user is posted to (user_roles.campus_id)
//	department        the departments a user heads (departments.head_user_id)
//	assigned_classes  sections a teacher is timetabled for or class-teacher of
//	self              the signed-in user's own student record
//	children          students a guardian is linked to
//
// Each is a set of ids resolved once per request and applied as an explicit
// SQL predicate. Handlers must not hand-roll these filters: a missing one is a
// silent data leak within a tenant, which RLS will not catch because both
// rows legitimately belong to the same institution.
package scope

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

// Resolved is the caller's concrete boundary, loaded once per request.
//
// Empty slices are meaningful and are not the same as "no restriction": a
// teacher with no timetabled sections must see no students. Filter() therefore
// emits a false predicate rather than omitting the clause.
type Resolved struct {
	UserID        uuid.UUID
	InstitutionID uuid.UUID
	PlatformAdmin bool

	CampusIDs     []uuid.UUID
	DepartmentIDs []uuid.UUID
	SectionIDs    []uuid.UUID // taught or class-teacher-of, plus departments headed
	StudentIDs    []uuid.UUID // own record, or linked children

	// Capability overrides. A back-office role legitimately reads the whole
	// institution; a teacher does not. Without this distinction every holder of
	// students.read reaches every student, which is how faculty ended up able
	// to list all 96 students while teaching two sections.
	AllStudents   bool // students.read.all
	AllAttendance bool // academics.attendance.read.all
	AnySection    bool // academics.attendance.write.any
	// AllCampuses is set when the user's role assignment names no campus,
	// which the schema uses to mean "every campus in the institution".
	AllCampuses bool
}

// Resolve loads every scope set for the caller in one round trip.
//
// All five are loaded even if the current request only needs one: they are
// small, indexed lookups, and resolving lazily per handler was how the
// department filter ended up missing from three endpoints.
func Resolve(ctx context.Context, db *database.DB, id *httpx.Identity) (*Resolved, error) {
	r := &Resolved{
		UserID:        id.UserID,
		InstitutionID: id.InstitutionID,
		PlatformAdmin: id.PlatformAdmin,
	}
	r.AllStudents = id.Can(rbac.StudentsReadAll)
	r.AllAttendance = id.Can(rbac.AttendanceReadAll)
	r.AnySection = id.Can(rbac.AttendanceWriteAny)

	if id.PlatformAdmin {
		r.AllCampuses = true
		r.AllStudents, r.AllAttendance, r.AnySection = true, true, true
		return r, nil
	}

	err := db.InTenant(ctx, database.Scope{InstitutionID: id.InstitutionID}, func(tx pgx.Tx) error {
		// Campuses: a NULL campus_id on any role assignment means the user is
		// institution-wide, so it wins over any specific grant.
		rows, err := tx.Query(ctx,
			`SELECT campus_id FROM user_roles WHERE user_id = $1`, id.UserID)
		if err != nil {
			return fmt.Errorf("campuses: %w", err)
		}
		for rows.Next() {
			var c *uuid.UUID
			if err := rows.Scan(&c); err != nil {
				rows.Close()
				return err
			}
			if c == nil {
				r.AllCampuses = true
			} else {
				r.CampusIDs = append(r.CampusIDs, *c)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		if r.DepartmentIDs, err = collectIDs(ctx, tx,
			`SELECT id FROM departments WHERE head_user_id = $1`, id.UserID); err != nil {
			return fmt.Errorf("departments: %w", err)
		}

		// A teacher reaches a section either by being timetabled into it or by
		// being its class teacher. UNION rather than OR across a join so a
		// class teacher with no periods is still covered.
		if r.SectionIDs, err = collectIDs(ctx, tx, `
			SELECT section_id FROM section_subject_teachers WHERE teacher_user_id = $1
			UNION
			SELECT section_id FROM timetable_entries      WHERE teacher_user_id = $1
			UNION
			SELECT id         FROM sections               WHERE class_teacher_id = $1`,
			id.UserID); err != nil {
			return fmt.Errorf("sections: %w", err)
		}

		// A department head reaches the sections their department teaches. They
		// are not timetabled themselves, so without this their section scope is
		// empty and every class-level view is blank.
		deptSections, err := collectIDs(ctx, tx, `
			SELECT DISTINCT te.section_id
			  FROM timetable_entries te
			  JOIN employees emp ON emp.user_id = te.teacher_user_id
			 WHERE emp.department_id = ANY($1)`, r.DepartmentIDs)
		if err != nil {
			return fmt.Errorf("department sections: %w", err)
		}
		r.SectionIDs = union(r.SectionIDs, deptSections)

		// Own student record plus any children linked through guardians.
		if r.StudentIDs, err = collectIDs(ctx, tx, `
			SELECT id FROM students WHERE user_id = $1
			UNION
			SELECT sg.student_id
			  FROM student_guardians sg
			  JOIN guardians g ON g.id = sg.guardian_id
			 WHERE g.user_id = $1`, id.UserID); err != nil {
			return fmt.Errorf("students: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return r, nil
}

func collectIDs(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// Filter returns a SQL predicate restricting a query to the given scope, plus
// the argument to bind. The predicate always references exactly one parameter
// so callers can append it positionally:
//
//	pred, arg := sc.Filter(catalog.ScopeAssignedClasses, "e.section_id", 3)
//	sql := "... WHERE " + pred
//
// column is interpolated, so it must be a literal from the handler, never
// anything derived from user input.
// TimetablePredicate limits a timetable to the sections the caller belongs to.
//
// A timetable is not secret, but "My timetable" has to mean the caller's own —
// unscoped, a Grade 6-A student was shown Grade 6-B's day and none of their
// own, and a teacher's own timetable listed periods they do not teach.
//
// Office and leadership roles read the whole grid; that is the difference
// between planning the school and attending it.
func (r *Resolved) TimetablePredicate(sectionColumn string, argN int) (string, any) {
	if r.AllAttendance || r.AnySection {
		return "TRUE", nil
	}
	// A family's timetable is whichever sections their children sit in. The
	// section set is empty for them — it holds what a person *teaches* — so it
	// is derived from the enrolment instead.
	if len(r.SectionIDs) == 0 && len(r.StudentIDs) > 0 {
		return fmt.Sprintf(`%s IN (SELECT e.section_id FROM enrollments e
		                            WHERE e.student_id = ANY($%d) AND e.status = 'active')`,
			sectionColumn, argN), r.StudentIDs
	}
	return anyOf(sectionColumn, argN, r.SectionIDs)
}

func (r *Resolved) Filter(s catalog.Scope, column string, argN int) (string, any) {
	switch s {
	case catalog.ScopePlatform, catalog.ScopeInstitution:
		// RLS already bounds these; nothing further to add.
		return "TRUE", nil

	case catalog.ScopeCampus:
		if r.AllCampuses {
			return "TRUE", nil
		}
		return anyOf(column, argN, r.CampusIDs)

	case catalog.ScopeDepartment:
		return anyOf(column, argN, r.DepartmentIDs)

	case catalog.ScopeAssignedClasses:
		return anyOf(column, argN, r.SectionIDs)

	case catalog.ScopeSelf, catalog.ScopeChildren:
		return anyOf(column, argN, r.StudentIDs)

	default:
		// An unrecognised scope must not silently widen access.
		return "FALSE", nil
	}
}

// anyOf builds "col = ANY($n)". An empty set yields FALSE rather than an empty
// ANY(), because "this teacher has no sections" must mean "no rows", not "all
// rows" — the direction that turns a scope bug into a breach.
func anyOf(column string, argN int, ids []uuid.UUID) (string, any) {
	if len(ids) == 0 {
		return "FALSE", nil
	}
	return fmt.Sprintf("%s = ANY($%d)", column, argN), ids
}

// Can reports whether the caller may exercise a feature key, combining the
// RBAC grant with the existence of a usable scope.
//
// Holding a department-scoped permission while heading no department is not an
// error, it just means there is nothing to act on — and the UI should not
// offer the feature at all.
func (r *Resolved) Can(id *httpx.Identity, featureKey string) bool {
	if !id.Can(featureKey) {
		return false
	}
	f, ok := catalog.Lookup(featureKey)
	if !ok {
		return false
	}
	return r.HasScope(f.Scope)
}

// HasScope reports whether the caller has any data at all in a scope.
func (r *Resolved) HasScope(s catalog.Scope) bool {
	switch s {
	case catalog.ScopePlatform:
		return r.PlatformAdmin
	case catalog.ScopeInstitution:
		return r.PlatformAdmin || r.InstitutionID != uuid.Nil
	case catalog.ScopeCampus:
		return r.AllCampuses || len(r.CampusIDs) > 0
	case catalog.ScopeDepartment:
		return len(r.DepartmentIDs) > 0
	case catalog.ScopeAssignedClasses:
		return len(r.SectionIDs) > 0
	case catalog.ScopeSelf:
		/* "Self" means the person signed in, and everybody has one.

		   It was answered with "do they have student records", which is what
		   ScopeChildren asks — so a self-service feature belonging to a member
		   of staff was out of scope for every member of staff. The principal's
		   own leave screen was built, registered and reported live, and the
		   menu still drew nothing, because the catalogue had decided a
		   principal has no self.

		   The teacher's version of the same screen escaped only because its
		   row in the sheet says "Self + assigned classes/subjects", which
		   resolves elsewhere. */
		return true
	case catalog.ScopeChildren:
		return len(r.StudentIDs) > 0
	default:
		return false
	}
}

// union merges two id sets, preserving order and dropping duplicates.
func union(a, b []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(a)+len(b))
	out := make([]uuid.UUID, 0, len(a)+len(b))
	for _, list := range [][]uuid.UUID{a, b} {
		for _, id := range list {
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			out = append(out, id)
		}
	}
	return out
}

// StudentPredicate restricts a query to the students the caller may see.
//
// Returns TRUE for a caller holding students.read.all, otherwise the union of
// "enrolled in a section I reach" and "is me / is my child". Callers must pass
// the students table alias; the predicate references it directly.
func (r *Resolved) StudentPredicate(alias string, argN int) (string, []any) {
	if r.AllStudents {
		return "TRUE", nil
	}
	var clauses []string
	var args []any
	if len(r.SectionIDs) > 0 {
		clauses = append(clauses, fmt.Sprintf(
			`EXISTS (SELECT 1 FROM enrollments se WHERE se.student_id = %s.id AND se.section_id = ANY($%d))`,
			alias, argN))
		args = append(args, r.SectionIDs)
		argN++
	}
	if len(r.StudentIDs) > 0 {
		clauses = append(clauses, fmt.Sprintf(`%s.id = ANY($%d)`, alias, argN))
		args = append(args, r.StudentIDs)
	}
	if len(clauses) == 0 {
		// No capability and no reachable set: see nothing, never everything.
		return "FALSE", nil
	}
	return "(" + strings.Join(clauses, " OR ") + ")", args
}

// AttendancePredicate restricts attendance rows to the caller's reach.
func (r *Resolved) AttendancePredicate(alias string, argN int) (string, []any) {
	if r.AllAttendance {
		return "TRUE", nil
	}
	var clauses []string
	var args []any
	if len(r.SectionIDs) > 0 {
		clauses = append(clauses, fmt.Sprintf(`%s.section_id = ANY($%d)`, alias, argN))
		args = append(args, r.SectionIDs)
		argN++
	}
	if len(r.StudentIDs) > 0 {
		clauses = append(clauses, fmt.Sprintf(`%s.student_id = ANY($%d)`, alias, argN))
		args = append(args, r.StudentIDs)
	}
	if len(clauses) == 0 {
		return "FALSE", nil
	}
	return "(" + strings.Join(clauses, " OR ") + ")", args
}

// CanMarkSection reports whether the caller may write attendance for a section.
func (r *Resolved) CanMarkSection(sectionID uuid.UUID) bool {
	if r.AnySection {
		return true
	}
	for _, id := range r.SectionIDs {
		if id == sectionID {
			return true
		}
	}
	return false
}

// OwnsStudent reports whether a student id is inside the caller's own set.
func (r *Resolved) OwnsStudent(studentID uuid.UUID) bool {
	for _, id := range r.StudentIDs {
		if id == studentID {
			return true
		}
	}
	return false
}
