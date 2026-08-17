package sis

import (
	"context"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/database"
)

type sectionRepository struct{}

func (r sectionRepository) listGrades(ctx context.Context, tx database.Tx,
	scope schoolFilter, schoolID *uuid.UUID) ([]Grade, error) {

	rows, err := tx.Query(ctx, `
		SELECT id, school_id, name, level, stage, stream
		FROM   grades
		WHERE  ($1::boolean OR school_id = ANY($2::uuid[]))
		  AND  ($3::uuid IS NULL OR school_id = $3)
		ORDER  BY school_id, level`,
		scope.orgWide, uuidArray(scope.schools), schoolID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Grade{}
	for rows.Next() {
		var g Grade
		if err := rows.Scan(&g.ID, &g.SchoolID, &g.Name, &g.Level, &g.Stage, &g.Stream); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (r sectionRepository) getGrade(ctx context.Context, tx database.Tx, id uuid.UUID) (Grade, error) {
	var g Grade
	err := tx.QueryRow(ctx, `
		SELECT id, school_id, name, level, stage, stream FROM grades WHERE id = $1`, id).
		Scan(&g.ID, &g.SchoolID, &g.Name, &g.Level, &g.Stage, &g.Stream)
	return g, err
}

// The occupancy count is a correlated subquery rather than a GROUP BY join, so
// a section with nobody in it still comes back with a zero rather than vanishing.
const sectionSelect = `
	SELECT sec.id, sec.organization_id, sec.school_id, sec.grade_id, g.name,
	       sec.academic_year_id, ay.name, sec.name, sec.capacity, sec.created_at,
	       (SELECT count(*) FROM enrollments e
	         WHERE e.section_id = sec.id AND e.status = 'active'),
	       ct.user_id, ctu.full_name
	FROM   sections sec
	JOIN   grades g          ON g.id = sec.grade_id
	JOIN   academic_years ay ON ay.id = sec.academic_year_id
	LEFT   JOIN section_teachers ct
	       ON ct.section_id = sec.id AND ct.kind = 'class_teacher' AND ct.status = 'active'
	LEFT   JOIN users ctu ON ctu.id = ct.user_id`

func scanSection(row interface{ Scan(...any) error }) (Section, error) {
	var s Section
	var teacherID *uuid.UUID
	var teacherName *string

	err := row.Scan(&s.ID, &s.OrganizationID, &s.SchoolID, &s.GradeID, &s.Grade,
		&s.AcademicYearID, &s.AcademicYear, &s.Name, &s.Capacity, &s.CreatedAt,
		&s.Enrolled, &teacherID, &teacherName)
	if err != nil {
		return Section{}, err
	}
	s.Label = s.Grade + " " + s.Name
	if teacherID != nil {
		s.ClassTeacher = &Teacher{UserID: *teacherID, FullName: derefString(teacherName)}
	}
	return s, nil
}

func (r sectionRepository) listSections(ctx context.Context, tx database.Tx,
	scope schoolFilter, in ListSectionsInput) ([]Section, error) {

	rows, err := tx.Query(ctx, sectionSelect+`
		WHERE  ($1::boolean OR sec.school_id = ANY($2::uuid[]))
		  AND  sec.archived_at IS NULL
		  AND  ($3::uuid IS NULL OR sec.school_id = $3)
		  AND  ($4::uuid IS NULL OR sec.grade_id = $4)
		  AND  ($5::uuid IS NULL OR sec.academic_year_id = $5)
		ORDER  BY g.level, sec.name`,
		scope.orgWide, uuidArray(scope.schools), in.SchoolID, in.GradeID, in.AcademicYearID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Section{}
	for rows.Next() {
		s, err := scanSection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// getForUpdate locks the section. Enrollment takes this lock before counting
// seats, so two clerks filling the last place cannot both win the check.
func (r sectionRepository) getForUpdate(ctx context.Context, tx database.Tx, id uuid.UUID) (Section, error) {
	var locked uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM sections WHERE id = $1 AND archived_at IS NULL FOR UPDATE`, id).
		Scan(&locked); err != nil {
		return Section{}, err
	}
	return scanSection(tx.QueryRow(ctx, sectionSelect+` WHERE sec.id = $1`, id))
}

func (r sectionRepository) countActiveEnrollments(ctx context.Context, tx database.Tx, sectionID uuid.UUID) (int64, error) {
	var n int64
	err := tx.QueryRow(ctx,
		`SELECT count(*) FROM enrollments WHERE section_id = $1 AND status = 'active'`,
		sectionID).Scan(&n)
	return n, err
}

func (r sectionRepository) insertSection(ctx context.Context, tx database.Tx,
	orgID uuid.UUID, grade Grade, in CreateSectionInput) (Section, error) {

	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		INSERT INTO sections (organization_id, school_id, grade_id, academic_year_id, name, capacity)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id`,
		orgID, grade.SchoolID, grade.ID, in.AcademicYearID, in.Name, in.Capacity).Scan(&id)
	if err != nil {
		return Section{}, err
	}
	return scanSection(tx.QueryRow(ctx, sectionSelect+` WHERE sec.id = $1`, id))
}

// endClassTeacher closes the current allocation and reports who it was, so the
// audit entry can name both the outgoing and incoming teacher.
func (r sectionRepository) endClassTeacher(ctx context.Context, tx database.Tx, sectionID uuid.UUID) (uuid.UUID, error) {
	var previous uuid.UUID
	err := tx.QueryRow(ctx, `
		UPDATE section_teachers
		SET    status = 'ended'
		WHERE  section_id = $1 AND kind = 'class_teacher' AND status = 'active'
		RETURNING user_id`, sectionID).Scan(&previous)
	if database.NoRows(err) {
		return uuid.Nil, nil
	}
	return previous, err
}

func (r sectionRepository) assignClassTeacher(ctx context.Context, tx database.Tx,
	orgID uuid.UUID, section Section, userID uuid.UUID) error {

	_, err := tx.Exec(ctx, `
		INSERT INTO section_teachers (organization_id, school_id, section_id, user_id, kind)
		VALUES ($1, $2, $3, $4, 'class_teacher')`,
		orgID, section.SchoolID, section.ID, userID)
	return err
}
