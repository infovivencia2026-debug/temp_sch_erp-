package sis

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/httpx"
)

type studentRepository struct{}

// The enrollment join is LEFT: a student admitted but not yet placed still has
// to be findable, or the person who admitted them cannot go back and fix it.
const studentSelect = `
	SELECT s.id, s.school_id, s.admission_number, s.first_name, s.middle_name,
	       s.last_name, s.preferred_name, s.date_of_birth, s.gender, s.blood_group,
	       s.mother_tongue, s.nationality, s.address, s.admission_date, s.status,
	       s.category, s.religion, s.created_at, s.updated_at,
	       e.id, e.academic_year_id, ay.name, e.grade_id, g.name,
	       e.section_id, sec.name, e.roll_number, e.status
	FROM   students s
	LEFT   JOIN enrollments e
	       ON e.student_id = s.id AND e.status = 'active'
	LEFT   JOIN academic_years ay ON ay.id = e.academic_year_id
	LEFT   JOIN grades g          ON g.id = e.grade_id
	LEFT   JOIN sections sec      ON sec.id = e.section_id`

func scanStudent(row interface{ Scan(...any) error }, includeRestricted bool) (Student, error) {
	var s Student
	var address []byte
	var category, religion *string

	var (
		enrollmentID *uuid.UUID
		yearID       *uuid.UUID
		yearName     *string
		gradeID      *uuid.UUID
		gradeName    *string
		sectionID    *uuid.UUID
		sectionName  *string
		rollNumber   *int
		enrolStatus  *string
	)

	err := row.Scan(&s.ID, &s.SchoolID, &s.AdmissionNumber, &s.FirstName, &s.MiddleName,
		&s.LastName, &s.PreferredName, &s.DateOfBirth, &s.Gender, &s.BloodGroup,
		&s.MotherTongue, &s.Nationality, &address, &s.AdmissionDate, &s.Status,
		&category, &religion, &s.CreatedAt, &s.UpdatedAt,
		&enrollmentID, &yearID, &yearName, &gradeID, &gradeName,
		&sectionID, &sectionName, &rollNumber, &enrolStatus)
	if err != nil {
		return Student{}, err
	}

	if len(address) > 0 {
		if err := json.Unmarshal(address, &s.Address); err != nil {
			return Student{}, err
		}
	}
	if s.Address == nil {
		s.Address = map[string]any{}
	}

	// Restricted fields are dropped here rather than at the SQL layer, so there
	// is exactly one place that decides — and callers cannot forget to ask.
	if includeRestricted {
		s.Category = category
		s.Religion = religion
	}

	if enrollmentID != nil {
		s.Enrollment = &Placement{
			EnrollmentID:   *enrollmentID,
			AcademicYearID: derefUUID(yearID),
			AcademicYear:   derefString(yearName),
			GradeID:        derefUUID(gradeID),
			Grade:          derefString(gradeName),
			SectionID:      derefUUID(sectionID),
			Section:        derefString(sectionName),
			RollNumber:     rollNumber,
			Status:         derefString(enrolStatus),
		}
	}
	return s, nil
}

func (r studentRepository) list(ctx context.Context, tx database.Tx, scope Scope,
	in ListStudentsInput, includeRestricted bool) ([]Student, error) {

	orgWide, schools, sections, students := scope.args()

	rows, err := tx.Query(ctx, studentSelect+`
		WHERE  `+studentVisibilityClause+`
		  AND  s.archived_at IS NULL
		  AND  ($5::text IS NULL OR s.status = $5)
		  AND  ($6::uuid IS NULL OR e.section_id = $6)
		  AND  ($7::uuid IS NULL OR e.grade_id = $7)
		  AND  ($8::uuid IS NULL OR s.school_id = $8)
		  AND  ($9::text IS NULL
		        OR s.admission_number ILIKE '%' || $9 || '%'
		        OR (s.first_name || ' ' || coalesce(s.middle_name, '') || ' ' || s.last_name)
		           ILIKE '%' || $9 || '%')
		ORDER  BY s.first_name, s.last_name
		LIMIT  $10 OFFSET $11`,
		orgWide, schools, sections, students,
		nullifEmpty(in.Status), in.SectionID, in.GradeID, in.SchoolID,
		nullifEmpty(in.Search), in.Limit, in.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Student{}
	for rows.Next() {
		s, err := scanStudent(rows, includeRestricted)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r studentRepository) count(ctx context.Context, tx database.Tx, scope Scope, in ListStudentsInput) (int64, error) {
	orgWide, schools, sections, students := scope.args()

	var total int64
	err := tx.QueryRow(ctx, `
		SELECT count(*)
		FROM   students s
		LEFT   JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
		WHERE  `+studentVisibilityClause+`
		  AND  s.archived_at IS NULL
		  AND  ($5::text IS NULL OR s.status = $5)
		  AND  ($6::uuid IS NULL OR e.section_id = $6)
		  AND  ($7::uuid IS NULL OR e.grade_id = $7)
		  AND  ($8::uuid IS NULL OR s.school_id = $8)
		  AND  ($9::text IS NULL
		        OR s.admission_number ILIKE '%' || $9 || '%'
		        OR (s.first_name || ' ' || coalesce(s.middle_name, '') || ' ' || s.last_name)
		           ILIKE '%' || $9 || '%')`,
		orgWide, schools, sections, students,
		nullifEmpty(in.Status), in.SectionID, in.GradeID, in.SchoolID,
		nullifEmpty(in.Search)).Scan(&total)
	return total, err
}

func (r studentRepository) get(ctx context.Context, tx database.Tx, scope Scope,
	id uuid.UUID, includeRestricted bool) (Student, error) {

	orgWide, schools, sections, students := scope.args()
	return scanStudent(tx.QueryRow(ctx, studentSelect+`
		WHERE `+studentVisibilityClause+` AND s.id = $5 AND s.archived_at IS NULL`,
		orgWide, schools, sections, students, id), includeRestricted)
}

// getForUpdate locks the student row and returns the full record including
// restricted fields — the caller is about to write, and needs the true before
// state for the audit entry regardless of what it may display.
func (r studentRepository) getForUpdate(ctx context.Context, tx database.Tx, scope Scope, id uuid.UUID) (Student, error) {
	orgWide, schools, sections, students := scope.args()

	// Postgres refuses FOR UPDATE on the nullable side of an outer join, so the
	// lock is taken in a separate statement after visibility is established.
	student, err := scanStudent(tx.QueryRow(ctx, studentSelect+`
		WHERE `+studentVisibilityClause+` AND s.id = $5 AND s.archived_at IS NULL`,
		orgWide, schools, sections, students, id), true)
	if err != nil {
		return Student{}, err
	}

	var locked uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM students WHERE id = $1 FOR UPDATE`, student.ID).Scan(&locked); err != nil {
		return Student{}, err
	}
	return student, nil
}

func (r studentRepository) insert(ctx context.Context, tx database.Tx, actor *httpx.Actor,
	in CreateStudentInput, dob, admitted time.Time) (Student, error) {

	address, err := json.Marshal(in.Address)
	if err != nil {
		return Student{}, err
	}

	var id uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO students (organization_id, school_id, admission_number,
		                      first_name, middle_name, last_name, preferred_name,
		                      date_of_birth, gender, blood_group, mother_tongue,
		                      nationality, category, religion, address,
		                      admission_date, created_by, updated_by)
		VALUES ($1, $2, $3, $4, nullif($5, ''), $6, nullif($7, ''), $8, $9,
		        nullif($10, ''), nullif($11, ''), $12, nullif($13, ''),
		        nullif($14, ''), $15, $16, $17, $17)
		RETURNING id`,
		actor.OrganizationID, in.SchoolID, in.AdmissionNumber,
		in.FirstName, in.MiddleName, in.LastName, in.PreferredName,
		dob, in.Gender, in.BloodGroup, in.MotherTongue,
		in.Nationality, in.Category, in.Religion, address,
		admitted, actor.UserID).Scan(&id)
	if err != nil {
		return Student{}, err
	}

	// Read back through the same projection every other path uses, so a created
	// student and a fetched student are never subtly different shapes.
	return scanStudent(tx.QueryRow(ctx, studentSelect+` WHERE s.id = $1`, id), true)
}

func (r studentRepository) update(ctx context.Context, tx database.Tx, actorID uuid.UUID, s Student) (Student, error) {
	address, err := json.Marshal(s.Address)
	if err != nil {
		return Student{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE students
		SET    first_name = $2, middle_name = $3, last_name = $4, preferred_name = $5,
		       blood_group = $6, mother_tongue = $7, category = $8, religion = $9,
		       address = $10, updated_at = now(), updated_by = $11
		WHERE  id = $1`,
		s.ID, s.FirstName, s.MiddleName, s.LastName, s.PreferredName,
		s.BloodGroup, s.MotherTongue, s.Category, s.Religion, address, actorID); err != nil {
		return Student{}, err
	}
	return scanStudent(tx.QueryRow(ctx, studentSelect+` WHERE s.id = $1`, s.ID), true)
}

func (r studentRepository) activeEnrollment(ctx context.Context, tx database.Tx,
	studentID, yearID uuid.UUID) (Placement, error) {

	var p Placement
	err := tx.QueryRow(ctx, `
		SELECT e.id, e.academic_year_id, ay.name, e.grade_id, g.name,
		       e.section_id, sec.name, e.roll_number, e.status
		FROM   enrollments e
		JOIN   academic_years ay ON ay.id = e.academic_year_id
		JOIN   grades g          ON g.id = e.grade_id
		JOIN   sections sec      ON sec.id = e.section_id
		WHERE  e.student_id = $1 AND e.academic_year_id = $2 AND e.status = 'active'
		FOR    UPDATE OF e`, studentID, yearID).
		Scan(&p.EnrollmentID, &p.AcademicYearID, &p.AcademicYear, &p.GradeID, &p.Grade,
			&p.SectionID, &p.Section, &p.RollNumber, &p.Status)
	return p, err
}

func (r studentRepository) closeEnrollment(ctx context.Context, tx database.Tx, id uuid.UUID, status string) error {
	// The old row is closed, never deleted: it is the evidence of where this
	// student sat, and a transfer certificate is built from exactly these rows.
	_, err := tx.Exec(ctx, `
		UPDATE enrollments
		SET    status = $2, ended_on = current_date, updated_at = now()
		WHERE  id = $1`, id, status)
	return err
}

func (r studentRepository) createEnrollment(ctx context.Context, tx database.Tx,
	student Student, section Section) (Placement, error) {

	var p Placement
	err := tx.QueryRow(ctx, `
		WITH next_roll AS (
			SELECT coalesce(max(roll_number), 0) + 1 AS n
			FROM   enrollments
			WHERE  section_id = $4 AND status = 'active'
		)
		INSERT INTO enrollments (organization_id, school_id, student_id,
		                         academic_year_id, grade_id, section_id, roll_number)
		SELECT $1, $2, $3, $5, $6, $4, n FROM next_roll
		RETURNING id, academic_year_id, grade_id, section_id, roll_number, status`,
		section.OrganizationID, student.SchoolID, student.ID,
		section.ID, section.AcademicYearID, section.GradeID).
		Scan(&p.EnrollmentID, &p.AcademicYearID, &p.GradeID, &p.SectionID, &p.RollNumber, &p.Status)
	if err != nil {
		return Placement{}, err
	}

	p.AcademicYear = section.AcademicYear
	p.Grade = section.Grade
	p.Section = section.Name
	return p, nil
}

func derefUUID(v *uuid.UUID) uuid.UUID {
	if v == nil {
		return uuid.Nil
	}
	return *v
}

func derefString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func nullifEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
