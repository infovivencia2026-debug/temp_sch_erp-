package sis

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/school-erp/erp/internal/audit"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/httpx"
)

// Grade is a class as an idea — "Class 8". Level orders grades for promotion:
// pre-primary years are negative so that Class 1 can be 1.
type Grade struct {
	ID       uuid.UUID `json:"id"`
	SchoolID uuid.UUID `json:"school_id"`
	Name     string    `json:"name"`
	Level    int       `json:"level"`
	Stage    string    `json:"stage"`
	Stream   *string   `json:"stream,omitempty"`
}

// Section is a class in a given year — "8A, 2026-27". Grade and AcademicYear are
// denormalised into the response because every screen that shows a section shows
// them together.
type Section struct {
	ID             uuid.UUID `json:"id"`
	OrganizationID uuid.UUID `json:"-"`
	SchoolID       uuid.UUID `json:"school_id"`
	GradeID        uuid.UUID `json:"grade_id"`
	Grade          string    `json:"grade"`
	AcademicYearID uuid.UUID `json:"academic_year_id"`
	AcademicYear   string    `json:"academic_year"`
	Name           string    `json:"name"`
	Label          string    `json:"label"` // "Class 8 A"
	Capacity       *int      `json:"capacity,omitempty"`
	Enrolled       int64     `json:"enrolled"`
	ClassTeacher   *Teacher  `json:"class_teacher,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

type Teacher struct {
	UserID   uuid.UUID `json:"user_id"`
	FullName string    `json:"full_name"`
}

type AcademicsService struct {
	db       *database.DB
	audit    *audit.Writer
	sections sectionRepository
}

func NewAcademicsService(db *database.DB, auditor *audit.Writer) *AcademicsService {
	return &AcademicsService{db: db, audit: auditor}
}

func (s *AcademicsService) ListGrades(ctx context.Context, actor *httpx.Actor, schoolID *uuid.UUID) ([]Grade, error) {
	scope := schoolScope(actor)
	if scope.denied {
		return []Grade{}, nil
	}
	grades, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) ([]Grade, error) {
		return s.sections.listGrades(ctx, tx, scope, schoolID)
	})
	if err != nil {
		return nil, httpx.AsError(err)
	}
	return grades, nil
}

type ListSectionsInput struct {
	SchoolID       *uuid.UUID
	GradeID        *uuid.UUID
	AcademicYearID *uuid.UUID
}

// ListSections shows the sections an actor may see, with live occupancy. The
// enrolled count is computed in the query rather than cached on the row: a
// stale seat count is how a section ends up over capacity.
func (s *AcademicsService) ListSections(ctx context.Context, actor *httpx.Actor, in ListSectionsInput) ([]Section, error) {
	scope := schoolScope(actor)
	if scope.denied {
		return []Section{}, nil
	}
	sections, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) ([]Section, error) {
		return s.sections.listSections(ctx, tx, scope, in)
	})
	if err != nil {
		return nil, httpx.AsError(err)
	}
	return sections, nil
}

type CreateSectionInput struct {
	GradeID        uuid.UUID `json:"grade_id"`
	AcademicYearID uuid.UUID `json:"academic_year_id"`
	Name           string    `json:"name"`
	Capacity       *int      `json:"capacity"`
}

func (s *AcademicsService) CreateSection(ctx context.Context, actor *httpx.Actor,
	meta audit.Entry, in CreateSectionInput) (Section, error) {

	in.Name = strings.ToUpper(strings.TrimSpace(in.Name))

	fields := map[string]any{}
	if in.GradeID == uuid.Nil {
		fields["grade_id"] = "Choose the class this section belongs to."
	}
	if in.AcademicYearID == uuid.Nil {
		fields["academic_year_id"] = "Choose the academic year."
	}
	if l := len([]rune(in.Name)); l < 1 || l > 12 {
		fields["name"] = "Enter a section name, such as A or Blue."
	}
	if in.Capacity != nil && *in.Capacity < 1 {
		// Zero would mean "nobody may enrol", which is not what anyone means by
		// leaving capacity blank.
		fields["capacity"] = "Capacity must be at least 1, or leave it empty for no limit."
	}
	if len(fields) > 0 {
		return Section{}, httpx.ErrValidation.WithDetails(map[string]any{"fields": fields})
	}

	section, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (Section, error) {
		grade, err := s.sections.getGrade(ctx, tx, in.GradeID)
		if err != nil {
			if database.NoRows(err) {
				return Section{}, httpx.NotFound("GRADE_NOT_FOUND", "That class could not be found.")
			}
			return Section{}, err
		}
		if !actor.CanAccessSchool(grade.SchoolID) {
			return Section{}, httpx.OutOfScope("class")
		}

		created, err := s.sections.insertSection(ctx, tx, actor.OrganizationID, grade, in)
		if err != nil {
			return Section{}, err
		}

		entry := meta
		entry.Action = "section.create"
		entry.EntityKind = "section"
		entry.EntityID = &created.ID
		entry.SchoolID = &created.SchoolID
		entry.After = created
		if err := s.audit.Write(ctx, tx, entry); err != nil {
			return Section{}, err
		}
		return created, nil
	})
	if err != nil {
		if database.IsUniqueViolation(err, "sections_name_unique") {
			return Section{}, httpx.Conflict("SECTION_EXISTS",
				"That class already has a section with this name for the year.")
		}
		if database.IsForeignKeyViolation(err) {
			return Section{}, httpx.BadRequest("ACADEMIC_YEAR_NOT_FOUND",
				"That academic year could not be found.")
		}
		return Section{}, httpx.AsError(err)
	}
	return section, nil
}

// AssignClassTeacher makes a user the class teacher of a section, which is what
// grants them access to its students. The previous class teacher's allocation is
// ended in the same transaction — and with it, their access.
func (s *AcademicsService) AssignClassTeacher(ctx context.Context, actor *httpx.Actor,
	meta audit.Entry, sectionID, userID uuid.UUID) error {

	_, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (struct{}, error) {
		section, err := s.sections.getForUpdate(ctx, tx, sectionID)
		if err != nil {
			if database.NoRows(err) {
				return struct{}{}, httpx.NotFound("SECTION_NOT_FOUND", "That section could not be found.")
			}
			return struct{}{}, err
		}
		if !actor.CanAccessSchool(section.SchoolID) {
			return struct{}{}, httpx.OutOfScope("section")
		}

		previous, err := s.sections.endClassTeacher(ctx, tx, sectionID)
		if err != nil {
			return struct{}{}, err
		}
		if err := s.sections.assignClassTeacher(ctx, tx, actor.OrganizationID, section, userID); err != nil {
			return struct{}{}, err
		}

		entry := meta
		entry.Action = "section.assign_class_teacher"
		entry.EntityKind = "section"
		entry.EntityID = &section.ID
		entry.SchoolID = &section.SchoolID
		if previous != uuid.Nil {
			entry.Before = map[string]any{"class_teacher_user_id": previous}
		}
		entry.After = map[string]any{"class_teacher_user_id": userID}
		return struct{}{}, s.audit.Write(ctx, tx, entry)
	})
	if err != nil {
		if database.IsForeignKeyViolation(err) {
			return httpx.BadRequest("USER_NOT_FOUND", "That user could not be found.")
		}
		return httpx.AsError(err)
	}
	return nil
}

// schoolFilter narrows academic-structure reads. Unlike students, sections are
// not personal data — every role that can see a school can see its classes — so
// the filter is simply the actor's school access.
type schoolFilter struct {
	orgWide bool
	schools []uuid.UUID
	denied  bool
}

func schoolScope(actor *httpx.Actor) schoolFilter {
	if actor.OrgWide() {
		return schoolFilter{orgWide: true}
	}
	if len(actor.SchoolAccess) == 0 {
		return schoolFilter{denied: true}
	}
	return schoolFilter{schools: actor.SchoolAccess}
}
