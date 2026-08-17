// Package tenancy owns the organisation → school → campus → academic year
// hierarchy that every other module hangs off.
//
// Schools are the Phase 1 vertical slice: the full path from HTTP through
// validation, the three authorization gates, business rules, the database and
// the audit trail. Every later module follows this shape.
package tenancy

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/school-erp/erp/internal/audit"
	"github.com/school-erp/erp/pkg/database"
	"github.com/school-erp/erp/pkg/httpx"
)

type School struct {
	ID             uuid.UUID      `json:"id"`
	OrganizationID uuid.UUID      `json:"organization_id"`
	Name           string         `json:"name"`
	Code           string         `json:"code"`
	Board          string         `json:"board"`
	Address        map[string]any `json:"address"`
	Timezone       string         `json:"timezone"`
	Locale         string         `json:"locale"`
	Currency       string         `json:"currency"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`
	ArchivedAt     *time.Time     `json:"archived_at,omitempty"`
}

// Boards we ship presets for. The list is open on purpose — a school on a board
// we have not met yet picks CUSTOM and configures its own assessment model
// rather than waiting for a release.
var knownBoards = map[string]bool{
	"CBSE": true, "CISCE": true, "ICSE": true, "TS_SSC": true,
	"AP_SSC": true, "STATE": true, "IB": true, "IGCSE": true, "CUSTOM": true,
}

var codePattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{1,15}$`)

type Service struct {
	db    *database.DB
	audit *audit.Writer
	repo  repository
}

func NewService(db *database.DB, auditor *audit.Writer) *Service {
	return &Service{db: db, audit: auditor}
}

// ---------------------------------------------------------------- reads ----

type ListInput struct {
	Search          string
	IncludeArchived bool
	Limit           int
}

// List returns the schools this actor can see. The scope gate is applied in SQL
// rather than after the fetch: a principal asking for "all schools" gets their
// own, and the count in the paging header is honest.
func (s *Service) List(ctx context.Context, actor *httpx.Actor, in ListInput) ([]School, int64, error) {
	if in.Limit <= 0 || in.Limit > 200 {
		in.Limit = 50
	}
	var scope []uuid.UUID
	if !actor.OrgWide() {
		scope = actor.SchoolAccess
		if len(scope) == 0 {
			// Holds the permission but is scoped to nothing. Empty list, not an
			// error: an empty state is a better answer than a 403 here.
			return []School{}, 0, nil
		}
	}

	type result struct {
		rows  []School
		total int64
	}
	res, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (result, error) {
		rows, err := s.repo.list(ctx, tx, scope, in)
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
		return nil, 0, httpx.Internal(err)
	}
	return res.rows, res.total, nil
}

// Get applies the scope gate to a single object. A teacher at school A asking
// for school B gets a 403 that says "out of scope", not a 404 — they are a
// known user of a known system, and the distinction matters for support.
func (s *Service) Get(ctx context.Context, actor *httpx.Actor, id uuid.UUID) (School, error) {
	school, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (School, error) {
		return s.repo.get(ctx, tx, id)
	})
	if err != nil {
		if database.NoRows(err) {
			return School{}, httpx.NotFound("SCHOOL_NOT_FOUND", "That school could not be found.")
		}
		return School{}, httpx.Internal(err)
	}
	if !actor.CanAccessSchool(school.ID) {
		return School{}, httpx.OutOfScope("school")
	}
	return school, nil
}

// --------------------------------------------------------------- writes ----

type CreateInput struct {
	Name     string         `json:"name"`
	Code     string         `json:"code"`
	Board    string         `json:"board"`
	Address  map[string]any `json:"address"`
	Timezone string         `json:"timezone"`
	Locale   string         `json:"locale"`
}

func (in *CreateInput) normaliseAndValidate() error {
	in.Name = strings.TrimSpace(in.Name)
	in.Code = strings.ToUpper(strings.TrimSpace(in.Code))
	in.Board = strings.ToUpper(strings.TrimSpace(in.Board))
	in.Timezone = strings.TrimSpace(in.Timezone)
	in.Locale = strings.TrimSpace(in.Locale)

	fields := map[string]any{}
	if l := len([]rune(in.Name)); l < 2 || l > 160 {
		fields["name"] = "Enter the school's name, between 2 and 160 characters."
	}
	if !codePattern.MatchString(in.Code) {
		fields["code"] = "Use 2 to 16 characters: capital letters, digits and hyphens."
	}
	if in.Board == "" {
		in.Board = "CBSE"
	} else if !knownBoards[in.Board] {
		fields["board"] = "Choose a board we support, or CUSTOM to configure your own."
	}
	if in.Timezone == "" {
		in.Timezone = "Asia/Kolkata"
	} else if _, err := time.LoadLocation(in.Timezone); err != nil {
		fields["timezone"] = "That is not a recognised timezone."
	}
	if in.Locale == "" {
		in.Locale = "en-IN"
	}
	if in.Address == nil {
		in.Address = map[string]any{}
	}

	if len(fields) > 0 {
		return httpx.ErrValidation.WithDetails(map[string]any{"fields": fields})
	}
	return nil
}

// Create adds a school. The uniqueness of the code is enforced by a database
// constraint rather than a pre-check: two administrators creating "MAIN" at the
// same moment is a race a SELECT-then-INSERT would lose.
func (s *Service) Create(ctx context.Context, actor *httpx.Actor, meta audit.Entry, in CreateInput) (School, error) {
	if err := in.normaliseAndValidate(); err != nil {
		return School{}, err
	}

	school, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (School, error) {
		created, err := s.repo.insert(ctx, tx, actor.OrganizationID, actor.UserID, in)
		if err != nil {
			return School{}, err
		}
		entry := meta
		entry.Action = "school.create"
		entry.EntityKind = "school"
		entry.EntityID = &created.ID
		entry.SchoolID = &created.ID
		entry.After = created
		if err := s.audit.Write(ctx, tx, entry); err != nil {
			return School{}, err
		}
		return created, nil
	})
	if err != nil {
		if database.IsUniqueViolation(err, "schools_code_unique") {
			return School{}, httpx.Conflict("SCHOOL_CODE_TAKEN",
				"Another school in this organisation already uses that code.").
				WithDetails(map[string]any{"code": in.Code})
		}
		return School{}, httpx.Internal(err)
	}
	return school, nil
}

type UpdateInput struct {
	Name     *string         `json:"name"`
	Board    *string         `json:"board"`
	Address  *map[string]any `json:"address"`
	Timezone *string         `json:"timezone"`
	Locale   *string         `json:"locale"`
}

// Update applies a partial change. Note the shape: read the row, check scope
// against the object we actually loaded, apply, then write the audit entry with
// both states — all inside one transaction, so a concurrent update cannot land
// between the read and the write.
func (s *Service) Update(ctx context.Context, actor *httpx.Actor, meta audit.Entry, id uuid.UUID, in UpdateInput) (School, error) {
	updated, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (School, error) {
		before, err := s.repo.getForUpdate(ctx, tx, id)
		if err != nil {
			return School{}, err
		}
		if !actor.CanAccessSchool(before.ID) {
			return School{}, httpx.OutOfScope("school")
		}
		if before.ArchivedAt != nil {
			return School{}, httpx.Conflict("SCHOOL_ARCHIVED",
				"That school is archived. Restore it before making changes.")
		}

		next := before
		if in.Name != nil {
			name := strings.TrimSpace(*in.Name)
			if l := len([]rune(name)); l < 2 || l > 160 {
				return School{}, httpx.ErrValidation.WithDetails(map[string]any{
					"fields": map[string]any{"name": "Enter a name between 2 and 160 characters."}})
			}
			next.Name = name
		}
		if in.Board != nil {
			board := strings.ToUpper(strings.TrimSpace(*in.Board))
			if !knownBoards[board] {
				return School{}, httpx.ErrValidation.WithDetails(map[string]any{
					"fields": map[string]any{"board": "Choose a board we support, or CUSTOM."}})
			}
			next.Board = board
		}
		if in.Timezone != nil {
			tz := strings.TrimSpace(*in.Timezone)
			if _, err := time.LoadLocation(tz); err != nil {
				return School{}, httpx.ErrValidation.WithDetails(map[string]any{
					"fields": map[string]any{"timezone": "That is not a recognised timezone."}})
			}
			next.Timezone = tz
		}
		if in.Locale != nil {
			next.Locale = strings.TrimSpace(*in.Locale)
		}
		if in.Address != nil {
			next.Address = *in.Address
		}

		saved, err := s.repo.update(ctx, tx, actor.UserID, next)
		if err != nil {
			return School{}, err
		}

		entry := meta
		entry.Action = "school.update"
		entry.EntityKind = "school"
		entry.EntityID = &saved.ID
		entry.SchoolID = &saved.ID
		entry.Before = before
		entry.After = saved
		if err := s.audit.Write(ctx, tx, entry); err != nil {
			return School{}, err
		}
		return saved, nil
	})
	if err != nil {
		if database.NoRows(err) {
			return School{}, httpx.NotFound("SCHOOL_NOT_FOUND", "That school could not be found.")
		}
		return School{}, httpx.AsError(err)
	}
	return updated, nil
}

// Archive soft-deletes. Schools are never hard-deleted: their students' academic
// and financial history has to outlive the school's operation.
func (s *Service) Archive(ctx context.Context, actor *httpx.Actor, meta audit.Entry, id uuid.UUID, reason string) error {
	if strings.TrimSpace(reason) == "" {
		return httpx.ErrValidation.WithDetails(map[string]any{
			"fields": map[string]any{"reason": "Give a reason — it goes on the audit record."}})
	}

	_, err := database.InTenantTx(ctx, s.db, actor.OrganizationID, func(tx database.Tx) (struct{}, error) {
		before, err := s.repo.getForUpdate(ctx, tx, id)
		if err != nil {
			return struct{}{}, err
		}
		if !actor.CanAccessSchool(before.ID) {
			return struct{}{}, httpx.OutOfScope("school")
		}
		if before.ArchivedAt != nil {
			return struct{}{}, httpx.Conflict("SCHOOL_ALREADY_ARCHIVED", "That school is already archived.")
		}

		after, err := s.repo.archive(ctx, tx, actor.UserID, id)
		if err != nil {
			return struct{}{}, err
		}

		entry := meta
		entry.Action = "school.archive"
		entry.EntityKind = "school"
		entry.EntityID = &id
		entry.SchoolID = &id
		entry.Before = before
		entry.After = after
		entry.Reason = reason
		return struct{}{}, s.audit.Write(ctx, tx, entry)
	})
	if err != nil {
		if database.NoRows(err) {
			return httpx.NotFound("SCHOOL_NOT_FOUND", "That school could not be found.")
		}
		return httpx.AsError(err)
	}
	return nil
}
