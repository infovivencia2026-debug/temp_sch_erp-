package sis

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/school-erp/erp/internal/audit"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/httpx"
)

// Student is the record as returned to a caller. Restricted fields are pointers
// so that "not permitted to see this" and "empty" are distinguishable in JSON:
// omitted rather than blank.
type Student struct {
	ID              uuid.UUID      `json:"id"`
	SchoolID        uuid.UUID      `json:"school_id"`
	AdmissionNumber string         `json:"admission_number"`
	FirstName       string         `json:"first_name"`
	MiddleName      *string        `json:"middle_name,omitempty"`
	LastName        string         `json:"last_name"`
	PreferredName   *string        `json:"preferred_name,omitempty"`
	DateOfBirth     time.Time      `json:"date_of_birth"`
	Gender          string         `json:"gender"`
	BloodGroup      *string        `json:"blood_group,omitempty"`
	MotherTongue    *string        `json:"mother_tongue,omitempty"`
	Nationality     string         `json:"nationality"`
	Address         map[string]any `json:"address"`
	AdmissionDate   time.Time      `json:"admission_date"`
	Status          string         `json:"status"`

	// Restricted: present only for callers holding sis.student.read_restricted.
	Category *string `json:"category,omitempty"`
	Religion *string `json:"religion,omitempty"`

	// Current placement, from the active enrollment. Absent for a student who
	// has been admitted but not yet enrolled.
	Enrollment *Placement `json:"enrollment,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Placement is where a student currently sits. It is deliberately a separate
// struct: it comes from the enrollment row, not from the student row, and the
// distinction is what keeps last year's class intact after promotion.
type Placement struct {
	EnrollmentID   uuid.UUID `json:"enrollment_id"`
	AcademicYearID uuid.UUID `json:"academic_year_id"`
	AcademicYear   string    `json:"academic_year"`
	GradeID        uuid.UUID `json:"grade_id"`
	Grade          string    `json:"grade"`
	SectionID      uuid.UUID `json:"section_id"`
	Section        string    `json:"section"`
	RollNumber     *int      `json:"roll_number,omitempty"`
	Status         string    `json:"status"`
}

// FullName is how a name is rendered wherever one line is wanted. Indian names
// vary enormously in structure, so we join what we have rather than assuming a
// first/last split means anything in particular.
func (s Student) FullName() string {
	parts := []string{s.FirstName}
	if s.MiddleName != nil && *s.MiddleName != "" {
		parts = append(parts, *s.MiddleName)
	}
	if s.LastName != "" {
		parts = append(parts, s.LastName)
	}
	return strings.Join(parts, " ")
}

var admissionNumberPattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9/-]{2,23}$`)

type StudentService struct {
	db       *database.DB
	audit    *audit.Writer
	repo     studentRepository
	scopes   scopeResolver
	sections sectionRepository
}

func NewStudentService(db *database.DB, auditor *audit.Writer) *StudentService {
	return &StudentService{db: db, audit: auditor}
}

// ------------------------------------------------------------- reading -----

type ListStudentsInput struct {
	Search    string
	SectionID *uuid.UUID
	GradeID   *uuid.UUID
	SchoolID  *uuid.UUID
	Status    string
	Limit     int
	Offset    int
}

// List returns the students this actor may see, filtered further by the query.
//
// The scope is applied inside the SQL, not after it. That matters for more than
// speed: a filtered-after-fetch implementation reports a total that includes
// rows the caller may not see, which is a small leak that tells a parent how
// many children are in a class they cannot open.
func (s *StudentService) List(ctx context.Context, actor *httpx.Actor, in ListStudentsInput) ([]Student, int64, error) {
	if in.Limit <= 0 || in.Limit > 200 {
		in.Limit = 50
	}

	type result struct {
		rows  []Student
		total int64
	}

	res, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (result, error) {
		scope, err := s.scopes.resolve(ctx, tx, actor)
		if err != nil {
			return result{}, err
		}
		if scope.Empty() {
			// Holds the permission, is scoped to nothing yet. An empty list is a
			// truer answer than a 403 — a new teacher has simply not been given
			// a class.
			return result{rows: []Student{}}, nil
		}

		rows, err := s.repo.list(ctx, tx, scope, in, canSeeRestricted(actor))
		if err != nil {
			return result{}, err
		}
		total, err := s.repo.count(ctx, tx, scope, in)
		if err != nil {
			return result{}, err
		}
		return result{rows: rows, total: total}, nil
	})
	if err != nil {
		return nil, 0, httpx.AsError(err)
	}
	return res.rows, res.total, nil
}

// Get returns one student if the actor's scope covers them.
//
// A student outside the scope is reported as not found, not as forbidden. This
// differs from the school endpoints on purpose: school codes are common
// knowledge within an organisation, but confirming that a particular admission
// number exists would let a parent probe for another family's child.
func (s *StudentService) Get(ctx context.Context, actor *httpx.Actor, id uuid.UUID) (Student, error) {
	student, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (Student, error) {
		scope, err := s.scopes.resolve(ctx, tx, actor)
		if err != nil {
			return Student{}, err
		}
		if scope.Empty() {
			return Student{}, errStudentNotFound
		}
		return s.repo.get(ctx, tx, scope, id, canSeeRestricted(actor))
	})
	if err != nil {
		if database.NoRows(err) {
			return Student{}, errStudentNotFound
		}
		return Student{}, httpx.AsError(err)
	}
	return student, nil
}

var errStudentNotFound = httpx.NotFound("STUDENT_NOT_FOUND", "That student could not be found.")

// ------------------------------------------------------------- writing -----

type CreateStudentInput struct {
	SchoolID        uuid.UUID      `json:"school_id"`
	AdmissionNumber string         `json:"admission_number"`
	FirstName       string         `json:"first_name"`
	MiddleName      string         `json:"middle_name"`
	LastName        string         `json:"last_name"`
	PreferredName   string         `json:"preferred_name"`
	DateOfBirth     string         `json:"date_of_birth"` // YYYY-MM-DD
	Gender          string         `json:"gender"`
	BloodGroup      string         `json:"blood_group"`
	MotherTongue    string         `json:"mother_tongue"`
	Nationality     string         `json:"nationality"`
	Category        string         `json:"category"`
	Religion        string         `json:"religion"`
	Address         map[string]any `json:"address"`
	AdmissionDate   string         `json:"admission_date"`

	// Optional: place the student straight into a section. Admission and
	// enrollment are separate events, but the common case does both at once.
	SectionID *uuid.UUID `json:"section_id"`
}

var validGenders = map[string]bool{"male": true, "female": true, "other": true, "unspecified": true}

func (in *CreateStudentInput) normaliseAndValidate() (dob, admitted time.Time, err error) {
	in.AdmissionNumber = strings.ToUpper(strings.TrimSpace(in.AdmissionNumber))
	in.FirstName = strings.TrimSpace(in.FirstName)
	in.MiddleName = strings.TrimSpace(in.MiddleName)
	in.LastName = strings.TrimSpace(in.LastName)
	in.PreferredName = strings.TrimSpace(in.PreferredName)
	in.Gender = strings.ToLower(strings.TrimSpace(in.Gender))
	in.Nationality = strings.TrimSpace(in.Nationality)

	fields := map[string]any{}

	if in.SchoolID == uuid.Nil {
		fields["school_id"] = "Choose the school this student is being admitted to."
	}
	if !admissionNumberPattern.MatchString(in.AdmissionNumber) {
		fields["admission_number"] = "Use 3 to 24 characters: capital letters, digits, hyphens and slashes."
	}
	if l := len([]rune(in.FirstName)); l < 1 || l > 80 {
		fields["first_name"] = "Enter the student's first name."
	}
	if l := len([]rune(in.LastName)); l < 1 || l > 80 {
		fields["last_name"] = "Enter the student's last name."
	}

	dob, dobErr := time.Parse("2006-01-02", strings.TrimSpace(in.DateOfBirth))
	switch {
	case dobErr != nil:
		fields["date_of_birth"] = "Enter the date of birth as YYYY-MM-DD."
	case dob.After(time.Now()):
		fields["date_of_birth"] = "The date of birth cannot be in the future."
	case dob.Before(time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)):
		fields["date_of_birth"] = "That date of birth is not plausible."
	}

	if in.Gender == "" {
		in.Gender = "unspecified"
	} else if !validGenders[in.Gender] {
		fields["gender"] = "Choose male, female, other, or leave it unspecified."
	}
	if in.Nationality == "" {
		in.Nationality = "Indian"
	}
	if in.Address == nil {
		in.Address = map[string]any{}
	}

	admitted = time.Now()
	if raw := strings.TrimSpace(in.AdmissionDate); raw != "" {
		parsed, parseErr := time.Parse("2006-01-02", raw)
		if parseErr != nil {
			fields["admission_date"] = "Enter the admission date as YYYY-MM-DD."
		} else {
			admitted = parsed
		}
	}

	if len(fields) > 0 {
		return time.Time{}, time.Time{}, httpx.ErrValidation.WithDetails(map[string]any{"fields": fields})
	}
	return dob, admitted, nil
}

// Create admits a student, and optionally enrols them in one transaction.
//
// Admission and enrollment are separate records but a single event to the
// person doing it, so they either both happen or neither does — a student who
// exists but sits in no class is a support call waiting to happen.
func (s *StudentService) Create(ctx context.Context, actor *httpx.Actor, meta audit.Entry, in CreateStudentInput) (Student, error) {
	dob, admitted, err := in.normaliseAndValidate()
	if err != nil {
		return Student{}, err
	}
	if !actor.CanAccessSchool(in.SchoolID) {
		return Student{}, httpx.OutOfScope("school")
	}

	student, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (Student, error) {
		created, err := s.repo.insert(ctx, tx, actor, in, dob, admitted)
		if err != nil {
			return Student{}, err
		}

		entry := meta
		entry.Action = "student.admit"
		entry.EntityKind = "student"
		entry.EntityID = &created.ID
		entry.SchoolID = &created.SchoolID
		entry.After = created
		if err := s.audit.Write(ctx, tx, entry); err != nil {
			return Student{}, err
		}
		if err := s.recordLifecycle(ctx, tx, actor, created.ID, "admitted", nil,
			map[string]any{"admission_number": created.AdmissionNumber}, ""); err != nil {
			return Student{}, err
		}

		if in.SectionID != nil {
			placement, err := s.enrol(ctx, tx, actor, meta, created, *in.SectionID, "")
			if err != nil {
				return Student{}, err
			}
			created.Enrollment = &placement
		}
		return created, nil
	})
	if err != nil {
		if database.IsUniqueViolation(err, "students_admission_number_unique") {
			return Student{}, httpx.Conflict("ADMISSION_NUMBER_TAKEN",
				"Another student at this school already has that admission number.").
				WithDetails(map[string]any{"admission_number": in.AdmissionNumber})
		}
		return Student{}, httpx.AsError(err)
	}
	return student, nil
}

type UpdateStudentInput struct {
	FirstName     *string         `json:"first_name"`
	MiddleName    *string         `json:"middle_name"`
	LastName      *string         `json:"last_name"`
	PreferredName *string         `json:"preferred_name"`
	BloodGroup    *string         `json:"blood_group"`
	MotherTongue  *string         `json:"mother_tongue"`
	Address       *map[string]any `json:"address"`
	Category      *string         `json:"category"`
	Religion      *string         `json:"religion"`
}

func (s *StudentService) Update(ctx context.Context, actor *httpx.Actor, meta audit.Entry,
	id uuid.UUID, in UpdateStudentInput) (Student, error) {

	// Changing a restricted field requires the permission to see it. Otherwise a
	// clerk could overwrite a category they are not allowed to read.
	if (in.Category != nil || in.Religion != nil) && !canSeeRestricted(actor) {
		return Student{}, httpx.PermissionDenied("sis.student.read_restricted")
	}

	updated, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (Student, error) {
		scope, err := s.scopes.resolve(ctx, tx, actor)
		if err != nil {
			return Student{}, err
		}
		if scope.Empty() {
			return Student{}, errStudentNotFound
		}

		before, err := s.repo.getForUpdate(ctx, tx, scope, id)
		if err != nil {
			return Student{}, err
		}

		next := before
		fields := map[string]any{}

		if in.FirstName != nil {
			name := strings.TrimSpace(*in.FirstName)
			if l := len([]rune(name)); l < 1 || l > 80 {
				fields["first_name"] = "Enter the student's first name."
			}
			next.FirstName = name
		}
		if in.LastName != nil {
			name := strings.TrimSpace(*in.LastName)
			if l := len([]rune(name)); l < 1 || l > 80 {
				fields["last_name"] = "Enter the student's last name."
			}
			next.LastName = name
		}
		next.MiddleName = replaceOptional(next.MiddleName, in.MiddleName)
		next.PreferredName = replaceOptional(next.PreferredName, in.PreferredName)
		next.BloodGroup = replaceOptional(next.BloodGroup, in.BloodGroup)
		next.MotherTongue = replaceOptional(next.MotherTongue, in.MotherTongue)
		next.Category = replaceOptional(next.Category, in.Category)
		next.Religion = replaceOptional(next.Religion, in.Religion)
		if in.Address != nil {
			next.Address = *in.Address
		}

		if len(fields) > 0 {
			return Student{}, httpx.ErrValidation.WithDetails(map[string]any{"fields": fields})
		}

		saved, err := s.repo.update(ctx, tx, actor.UserID, next)
		if err != nil {
			return Student{}, err
		}

		entry := meta
		entry.Action = "student.update"
		entry.EntityKind = "student"
		entry.EntityID = &saved.ID
		entry.SchoolID = &saved.SchoolID
		entry.Before = before
		entry.After = saved
		if err := s.audit.Write(ctx, tx, entry); err != nil {
			return Student{}, err
		}
		return saved, nil
	})
	if err != nil {
		if database.NoRows(err) {
			return Student{}, errStudentNotFound
		}
		return Student{}, httpx.AsError(err)
	}
	return updated, nil
}

// ---------------------------------------------------------- enrollment -----

type EnrolInput struct {
	SectionID uuid.UUID `json:"section_id"`
	Reason    string    `json:"reason"`
}

// Enrol places a student in a section, closing any active enrollment for the
// same year first. It is how both initial placement and a mid-year section
// change happen — the difference is only whether a previous row exists.
func (s *StudentService) Enrol(ctx context.Context, actor *httpx.Actor, meta audit.Entry,
	studentID uuid.UUID, in EnrolInput) (Placement, error) {

	if in.SectionID == uuid.Nil {
		return Placement{}, httpx.ErrValidation.WithDetails(map[string]any{
			"fields": map[string]any{"section_id": "Choose a section."}})
	}

	return database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (Placement, error) {
		scope, err := s.scopes.resolve(ctx, tx, actor)
		if err != nil {
			return Placement{}, err
		}
		if scope.Empty() {
			return Placement{}, errStudentNotFound
		}
		student, err := s.repo.getForUpdate(ctx, tx, scope, studentID)
		if err != nil {
			if database.NoRows(err) {
				return Placement{}, errStudentNotFound
			}
			return Placement{}, err
		}
		return s.enrol(ctx, tx, actor, meta, student, in.SectionID, in.Reason)
	})
}

// enrol is the shared body, called both by Create and by Enrol. It assumes the
// caller has already established scope over the student.
func (s *StudentService) enrol(ctx context.Context, tx database.Tx, actor *httpx.Actor,
	meta audit.Entry, student Student, sectionID uuid.UUID, reason string) (Placement, error) {

	// Lock the section row first. Two clerks enrolling the last two children
	// into a section with one seat left must not both succeed, and the capacity
	// check below is only meaningful while this lock is held.
	section, err := s.sections.getForUpdate(ctx, tx, sectionID)
	if err != nil {
		if database.NoRows(err) {
			return Placement{}, httpx.NotFound("SECTION_NOT_FOUND", "That section could not be found.")
		}
		return Placement{}, err
	}
	if section.SchoolID != student.SchoolID {
		return Placement{}, httpx.BadRequest("SECTION_WRONG_SCHOOL",
			"That section belongs to a different school.")
	}
	if !actor.CanAccessSchool(section.SchoolID) {
		return Placement{}, httpx.OutOfScope("section")
	}

	if section.Capacity != nil {
		occupied, err := s.sections.countActiveEnrollments(ctx, tx, section.ID)
		if err != nil {
			return Placement{}, err
		}
		if occupied >= int64(*section.Capacity) {
			return Placement{}, httpx.Conflict("SECTION_FULL",
				fmt.Sprintf("%s is full: %d of %d seats are taken.",
					section.Label, occupied, *section.Capacity)).
				WithDetails(map[string]any{
					"section_id": section.ID, "capacity": *section.Capacity, "occupied": occupied,
				})
		}
	}

	previous, err := s.repo.activeEnrollment(ctx, tx, student.ID, section.AcademicYearID)
	if err != nil && !database.NoRows(err) {
		return Placement{}, err
	}
	hadPrevious := err == nil

	if hadPrevious {
		if previous.SectionID == section.ID {
			return Placement{}, httpx.Conflict("ALREADY_ENROLLED",
				"That student is already in this section.")
		}
		if err := s.repo.closeEnrollment(ctx, tx, previous.EnrollmentID, "transferred"); err != nil {
			return Placement{}, err
		}
	}

	placement, err := s.repo.createEnrollment(ctx, tx, student, section)
	if err != nil {
		if database.IsUniqueViolation(err, "enrollments_one_active_per_year") {
			// Another request enrolled this student between our read and write.
			return Placement{}, httpx.Conflict("ALREADY_ENROLLED",
				"That student was enrolled for this year by someone else a moment ago.")
		}
		return Placement{}, err
	}

	kind := "enrolled"
	if hadPrevious {
		kind = "section_changed"
	}
	from := map[string]any(nil)
	if hadPrevious {
		from = map[string]any{"section_id": previous.SectionID, "section": previous.Section}
	}
	if err := s.recordLifecycle(ctx, tx, actor, student.ID, kind, from,
		map[string]any{"section_id": placement.SectionID, "section": placement.Section}, reason); err != nil {
		return Placement{}, err
	}

	entry := meta
	entry.Action = "student." + kind
	entry.EntityKind = "student"
	entry.EntityID = &student.ID
	entry.SchoolID = &student.SchoolID
	entry.Before = from
	entry.After = placement
	entry.Reason = reason
	if err := s.audit.Write(ctx, tx, entry); err != nil {
		return Placement{}, err
	}
	return placement, nil
}

func (s *StudentService) recordLifecycle(ctx context.Context, tx database.Tx, actor *httpx.Actor,
	studentID uuid.UUID, kind string, from, to map[string]any, reason string) error {

	fromJSON, err := optionalJSON(from)
	if err != nil {
		return err
	}
	toJSON, err := optionalJSON(to)
	if err != nil {
		return err
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO student_lifecycle_events
			(organization_id, student_id, kind, from_state, to_state, reason, actor_user_id)
		VALUES ($1, $2, $3, $4, $5, nullif($6, ''), $7)`,
		actor.OrganizationID, studentID, kind, fromJSON, toJSON, reason, actor.UserID)
	return err
}

func optionalJSON(v map[string]any) (any, error) {
	if v == nil {
		return nil, nil
	}
	return json.Marshal(v)
}

// replaceOptional applies a patch to a nullable field, treating an explicit
// empty string as "clear it".
func replaceOptional(current, patch *string) *string {
	if patch == nil {
		return current
	}
	trimmed := strings.TrimSpace(*patch)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
