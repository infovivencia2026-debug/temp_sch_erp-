// Package sis implements the student information system: students, guardians,
// enrollment and the academic structure they sit in.
package sis

import (
	"context"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/httpx"
	"github.com/school-erp/erp/pkg/rbac"
)

// Scope answers "which students may this actor see?".
//
// This is the third authorization gate, and the one a school ERP lives or dies
// by. A permission can say "may read students"; only this can say "may read
// *these* students". It is resolved from data — teaching allocations and
// guardian links — never from anything the caller sends.
//
// The four dimensions are OR-ed together, because an actor can be several things
// at once: a teacher whose own child studies at the school is entitled to both
// their section's students and their own children.
type Scope struct {
	// OrgWide short-circuits everything: an organisation admin or auditor.
	OrgWide bool
	// SchoolIDs: every student in these schools (principal, accountant).
	SchoolIDs []uuid.UUID
	// SectionIDs: students enrolled in these sections (class and subject teachers).
	SectionIDs []uuid.UUID
	// StudentIDs: named students (a parent's children, a student themselves).
	StudentIDs []uuid.UUID
}

// Empty reports that the actor may see no students at all. It is a legitimate
// state — a newly created teacher with no allocations yet — and callers should
// answer with an empty list rather than an error.
func (s Scope) Empty() bool {
	return !s.OrgWide && len(s.SchoolIDs) == 0 &&
		len(s.SectionIDs) == 0 && len(s.StudentIDs) == 0
}

// scopeResolver builds a Scope for an actor. It runs one query per dimension
// that applies, and only for the roles that need it — a principal never pays
// for the guardian-link lookup.
type scopeResolver struct{}

func (r scopeResolver) resolve(ctx context.Context, tx database.Tx, actor *httpx.Actor) (Scope, error) {
	var scope Scope

	if actor.OrgWide() {
		scope.OrgWide = true
		return scope, nil
	}

	// School-level roles see everything in the schools they belong to. The
	// membership rows already tell us which.
	if hasAnyRole(actor, "school_admin", "campus_admin", "principal",
		"vice_principal", "academic_coordinator", "exam_coordinator",
		"accountant", "finance_manager", "admissions_officer", "front_office") {
		scope.SchoolIDs = actor.SchoolAccess
	}

	// Teachers see the students they teach. Derived from live allocations, so
	// a timetable change moves their access with it.
	if hasAnyRole(actor, "class_teacher", "teacher") {
		rows, err := tx.Query(ctx, `
			SELECT DISTINCT section_id
			FROM   section_teachers
			WHERE  user_id = $1 AND status = 'active'`, actor.UserID)
		if err != nil {
			return Scope{}, err
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return Scope{}, err
			}
			scope.SectionIDs = append(scope.SectionIDs, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return Scope{}, err
		}
	}

	// A parent's children. Note the conditions: the link must be active, and it
	// is found through the guardian record that carries this user's id. There is
	// no path here for a caller to name a student themselves.
	if hasAnyRole(actor, "parent") {
		rows, err := tx.Query(ctx, `
			SELECT sg.student_id
			FROM   student_guardians sg
			JOIN   guardians g ON g.id = sg.guardian_id
			WHERE  g.user_id = $1
			  AND  sg.status = 'active'
			  AND  g.archived_at IS NULL`, actor.UserID)
		if err != nil {
			return Scope{}, err
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return Scope{}, err
			}
			scope.StudentIDs = append(scope.StudentIDs, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return Scope{}, err
		}
	}

	// A student sees themselves.
	if hasAnyRole(actor, "student") {
		rows, err := tx.Query(ctx,
			`SELECT id FROM students WHERE user_id = $1 AND archived_at IS NULL`, actor.UserID)
		if err != nil {
			return Scope{}, err
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return Scope{}, err
			}
			scope.StudentIDs = append(scope.StudentIDs, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return Scope{}, err
		}
	}

	return scope, nil
}

func hasAnyRole(actor *httpx.Actor, roles ...string) bool {
	for _, held := range actor.Roles {
		for _, want := range roles {
			if held == want {
				return true
			}
		}
	}
	return false
}

// visibility is how a Scope reaches SQL. Every student query applies it, so the
// filter is written once and cannot be forgotten in a new query — the arguments
// are always the same four, in the same order.
//
//	$1 org-wide (bool), $2 school ids, $3 section ids, $4 student ids
const studentVisibilityClause = `(
	$1::boolean
	OR s.school_id = ANY($2::uuid[])
	OR s.id = ANY($4::uuid[])
	OR EXISTS (
		SELECT 1 FROM enrollments e
		WHERE  e.student_id = s.id
		  AND  e.status = 'active'
		  AND  e.section_id = ANY($3::uuid[])
	)
)`

func (s Scope) args() (bool, any, any, any) {
	return s.OrgWide, uuidArray(s.SchoolIDs), uuidArray(s.SectionIDs), uuidArray(s.StudentIDs)
}

// uuidArray turns an empty slice into an empty array rather than NULL: `x = ANY
// (NULL)` is NULL, not false, which would make the whole OR-chain unpredictable.
func uuidArray(ids []uuid.UUID) any {
	if len(ids) == 0 {
		return []uuid.UUID{}
	}
	return ids
}

// canSeeRestricted gates the fields that are nobody's business by default:
// category, religion, and government identifiers. Reading them is itself audited.
func canSeeRestricted(actor *httpx.Actor) bool {
	return actor.Can(rbac.StudentReadRestricted)
}
