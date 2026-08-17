package sis

import (
	"context"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/school-erp/erp/internal/audit"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/httpx"
)

// Guardian is a person, stored once however many children they have. That is
// the whole point of the separate table: a father with three children at the
// school is one record and three links, so one login sees all three, and a
// change of phone number is one edit rather than three.
type Guardian struct {
	ID         uuid.UUID      `json:"id"`
	SchoolID   uuid.UUID      `json:"school_id"`
	FullName   string         `json:"full_name"`
	Phone      *string        `json:"phone,omitempty"`
	Email      *string        `json:"email,omitempty"`
	Occupation *string        `json:"occupation,omitempty"`
	Employer   *string        `json:"employer,omitempty"`
	Address    map[string]any `json:"address,omitempty"`
	HasLogin   bool           `json:"has_login"`

	// Populated when read in the context of a student.
	Relation      string `json:"relation,omitempty"`
	IsPrimary     bool   `json:"is_primary,omitempty"`
	IsEmergency   bool   `json:"is_emergency_contact,omitempty"`
	PaysFees      bool   `json:"financial_responsibility,omitempty"`
	CanCollect    bool   `json:"pickup_authorised,omitempty"`
	ChildrenCount int    `json:"children_count,omitempty"`
}

// Indian mobile numbers in E.164. Landlines and international numbers are
// deliberately allowed through the looser branch — a school with an NRI parent
// should not be blocked by our idea of a phone number.
var phonePattern = regexp.MustCompile(`^\+?[0-9]{8,15}$`)

var validRelations = map[string]bool{
	"father": true, "mother": true, "guardian": true, "other": true,
}

type GuardianService struct {
	db      *database.DB
	audit   *audit.Writer
	repo    guardianRepository
	scopes  scopeResolver
	student studentRepository
}

func NewGuardianService(db *database.DB, auditor *audit.Writer) *GuardianService {
	return &GuardianService{db: db, audit: auditor}
}

// ListForStudent returns a student's guardians, if the caller may see the
// student. Access to the child is what confers access to the parents' contact
// details — there is no separate guardian scope to keep in step.
func (s *GuardianService) ListForStudent(ctx context.Context, actor *httpx.Actor, studentID uuid.UUID) ([]Guardian, error) {
	guardians, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) ([]Guardian, error) {
		scope, err := s.scopes.resolve(ctx, tx, actor)
		if err != nil {
			return nil, err
		}
		if scope.Empty() {
			return nil, errStudentNotFound
		}
		if _, err := s.student.get(ctx, tx, scope, studentID, false); err != nil {
			if database.NoRows(err) {
				return nil, errStudentNotFound
			}
			return nil, err
		}
		return s.repo.listForStudent(ctx, tx, studentID)
	})
	if err != nil {
		return nil, httpx.AsError(err)
	}
	return guardians, nil
}

type CreateGuardianInput struct {
	SchoolID   uuid.UUID      `json:"school_id"`
	FullName   string         `json:"full_name"`
	Phone      string         `json:"phone"`
	Email      string         `json:"email"`
	Occupation string         `json:"occupation"`
	Employer   string         `json:"employer"`
	Address    map[string]any `json:"address"`
}

func (in *CreateGuardianInput) normaliseAndValidate() error {
	in.FullName = strings.TrimSpace(in.FullName)
	in.Phone = strings.ReplaceAll(strings.TrimSpace(in.Phone), " ", "")
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))

	fields := map[string]any{}
	if in.SchoolID == uuid.Nil {
		fields["school_id"] = "Choose the school."
	}
	if l := len([]rune(in.FullName)); l < 2 || l > 160 {
		fields["full_name"] = "Enter the guardian's name."
	}
	if in.Phone == "" && in.Email == "" {
		// A guardian the school cannot reach is worse than no record: it looks
		// like a contact exists when nobody can be called.
		fields["phone"] = "Enter a phone number or an email address — the school needs a way to reach them."
	}
	if in.Phone != "" {
		// A bare 10-digit Indian mobile is the common case; store it in E.164.
		if len(in.Phone) == 10 && !strings.HasPrefix(in.Phone, "+") {
			in.Phone = "+91" + in.Phone
		}
		if !phonePattern.MatchString(in.Phone) {
			fields["phone"] = "Enter a valid phone number, such as 9876543210."
		}
	}
	if in.Email != "" && !strings.Contains(in.Email, "@") {
		fields["email"] = "Enter a valid email address."
	}
	if in.Address == nil {
		in.Address = map[string]any{}
	}
	if len(fields) > 0 {
		return httpx.ErrValidation.WithDetails(map[string]any{"fields": fields})
	}
	return nil
}

func (s *GuardianService) Create(ctx context.Context, actor *httpx.Actor,
	meta audit.Entry, in CreateGuardianInput) (Guardian, error) {

	if err := in.normaliseAndValidate(); err != nil {
		return Guardian{}, err
	}
	if !actor.CanAccessSchool(in.SchoolID) {
		return Guardian{}, httpx.OutOfScope("school")
	}

	guardian, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (Guardian, error) {
		created, err := s.repo.insert(ctx, tx, actor.OrganizationID, in)
		if err != nil {
			return Guardian{}, err
		}
		entry := meta
		entry.Action = "guardian.create"
		entry.EntityKind = "guardian"
		entry.EntityID = &created.ID
		entry.SchoolID = &created.SchoolID
		entry.After = created
		if err := s.audit.Write(ctx, tx, entry); err != nil {
			return Guardian{}, err
		}
		return created, nil
	})
	if err != nil {
		return Guardian{}, httpx.AsError(err)
	}
	return guardian, nil
}

type LinkGuardianInput struct {
	GuardianID  uuid.UUID `json:"guardian_id"`
	Relation    string    `json:"relation"`
	IsPrimary   bool      `json:"is_primary"`
	IsEmergency bool      `json:"is_emergency_contact"`
	PaysFees    bool      `json:"financial_responsibility"`
	CanCollect  bool      `json:"pickup_authorised"`
}

// Link attaches a guardian to a student.
//
// This is the single most security-relevant write in the module: it is what
// grants a parent account sight of a child. It therefore requires an explicit
// permission of its own (sis.guardian.link), verifies both sides belong to the
// same school, and is audited with both parties named.
func (s *GuardianService) Link(ctx context.Context, actor *httpx.Actor, meta audit.Entry,
	studentID uuid.UUID, in LinkGuardianInput) error {

	in.Relation = strings.ToLower(strings.TrimSpace(in.Relation))
	if in.GuardianID == uuid.Nil || !validRelations[in.Relation] {
		return httpx.ErrValidation.WithDetails(map[string]any{"fields": map[string]any{
			"guardian_id": "Choose a guardian.",
			"relation":    "Choose father, mother, guardian or other.",
		}})
	}

	_, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (struct{}, error) {
		scope, err := s.scopes.resolve(ctx, tx, actor)
		if err != nil {
			return struct{}{}, err
		}
		if scope.Empty() {
			return struct{}{}, errStudentNotFound
		}
		student, err := s.student.get(ctx, tx, scope, studentID, false)
		if err != nil {
			if database.NoRows(err) {
				return struct{}{}, errStudentNotFound
			}
			return struct{}{}, err
		}

		guardian, err := s.repo.get(ctx, tx, in.GuardianID)
		if err != nil {
			if database.NoRows(err) {
				return struct{}{}, httpx.NotFound("GUARDIAN_NOT_FOUND", "That guardian could not be found.")
			}
			return struct{}{}, err
		}
		if guardian.SchoolID != student.SchoolID {
			return struct{}{}, httpx.BadRequest("GUARDIAN_WRONG_SCHOOL",
				"That guardian belongs to a different school.")
		}

		if in.IsPrimary {
			// One primary guardian per student: demote the incumbent rather than
			// letting the unique index reject the whole request.
			if err := s.repo.clearPrimary(ctx, tx, studentID); err != nil {
				return struct{}{}, err
			}
		}
		if err := s.repo.link(ctx, tx, actor.OrganizationID, studentID, in); err != nil {
			return struct{}{}, err
		}

		entry := meta
		entry.Action = "guardian.link"
		entry.EntityKind = "student"
		entry.EntityID = &studentID
		entry.SchoolID = &student.SchoolID
		entry.After = map[string]any{
			"guardian_id":   in.GuardianID,
			"guardian_name": guardian.FullName,
			"relation":      in.Relation,
			"is_primary":    in.IsPrimary,
			"pays_fees":     in.PaysFees,
		}
		return struct{}{}, s.audit.Write(ctx, tx, entry)
	})
	if err != nil {
		if database.IsUniqueViolation(err, "") {
			return httpx.Conflict("ALREADY_LINKED",
				"That guardian is already linked to this student with that relation.")
		}
		return httpx.AsError(err)
	}
	return nil
}
