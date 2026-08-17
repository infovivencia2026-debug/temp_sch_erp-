// Package seed loads development data: one organisation, two schools, and a
// user for each role so the authorization model can be exercised by hand as
// well as by the test suite.
//
// Names are realistic Indian school names rather than "Test School 1", because
// a seed that looks like the real thing surfaces layout and sorting problems
// that placeholder data hides. They are invented; any resemblance to a real
// institution is coincidental.
package seed

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/auth"
	"github.com/school-erp/erp/pkg/database"
)

// DevPassword is the password every seeded account shares. It is printed on
// completion and is only ever installed by this command, which refuses to run
// against a database that already holds a seeded organisation.
const DevPassword = "Password123!"

type seedUser struct {
	name  string
	email string
	role  string
	// school is the code of the school this user is scoped to. Empty means an
	// organisation-wide membership, which is how org_admin and auditor differ
	// from a principal.
	school string
}

var users = []seedUser{
	{"Priya Nair", "priya.nair@vidyaniketan.test", "org_admin", ""},
	{"Radhika Menon", "radhika.menon@vidyaniketan.test", "principal", "VNPS-HYD"},
	{"Suresh Kumar", "suresh.kumar@vidyaniketan.test", "accountant", "VNPS-HYD"},
	// Anitha is a class teacher, not a plain teacher: she owns Class 6A, which
	// is what her data access is derived from.
	{"Anitha Reddy", "anitha.reddy@vidyaniketan.test", "class_teacher", "VNPS-HYD"},
	{"Deepak Varma", "deepak.varma@vidyaniketan.test", "school_admin", "VNPS-SEC"},
	{"Lakshmi Rao", "lakshmi.rao@vidyaniketan.test", "auditor", ""},
}

// Run is idempotent in the only way that matters: it refuses to run twice
// rather than quietly duplicating data or resetting passwords.
func Run(ctx context.Context, db *database.DB) error {
	existing, err := database.InTx(ctx, db, func(tx database.Tx) (int, error) {
		var n int
		err := tx.QueryRow(ctx,
			`SELECT count(*) FROM organizations WHERE slug = 'vidya-niketan'`).Scan(&n)
		return n, err
	})
	if err != nil {
		return fmt.Errorf("check for existing seed: %w", err)
	}
	if existing > 0 {
		slog.Warn("seed data already present, nothing to do",
			"organization", "vidya-niketan")
		return nil
	}

	hash, err := auth.HashPassword(DevPassword)
	if err != nil {
		return err
	}

	// The seeder runs before any tenant exists, so it uses the untenanted path.
	// It is a development command; production tenants are provisioned through
	// the super-admin flow in Phase 4.
	orgID, err := database.InTx(ctx, db, func(tx database.Tx) (uuid.UUID, error) {
		var orgID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO organizations (name, slug, settings)
			VALUES ('Vidya Niketan Educational Trust', 'vidya-niketan',
			        '{"country":"IN","financial_year_start_month":4}'::jsonb)
			RETURNING id`).Scan(&orgID); err != nil {
			return uuid.Nil, fmt.Errorf("create organisation: %w", err)
		}

		schools := []struct {
			name, code, board, city string
		}{
			{"Vidya Niketan Public School", "VNPS-HYD", "CBSE", "Hyderabad"},
			{"Vidya Niketan High School", "VNPS-SEC", "TS_SSC", "Secunderabad"},
		}
		schoolIDs := map[string]uuid.UUID{}
		currentYearIDs := map[string]uuid.UUID{}

		for _, s := range schools {
			var id uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO schools (organization_id, name, code, board, address)
				VALUES ($1, $2, $3, $4, jsonb_build_object(
					'line1', 'Plot 12, Road No. 4', 'city', $5::text,
					'district', $5::text, 'state', 'Telangana', 'pin', '500034'))
				RETURNING id`, orgID, s.name, s.code, s.board, s.city).Scan(&id); err != nil {
				return uuid.Nil, fmt.Errorf("create school %s: %w", s.code, err)
			}
			schoolIDs[s.code] = id

			if _, err := tx.Exec(ctx, `
				INSERT INTO campuses (organization_id, school_id, name, code)
				VALUES ($1, $2, 'Main Campus', 'MAIN')`, orgID, id); err != nil {
				return uuid.Nil, fmt.Errorf("create campus for %s: %w", s.code, err)
			}

			// The Indian academic session runs June to April in much of the
			// country; the dates are data, not an assumption in code.
			var currentYearID uuid.UUID
			if err := tx.QueryRow(ctx, `
				WITH inserted AS (
					INSERT INTO academic_years (organization_id, school_id, name,
					                            start_date, end_date, status, is_current)
					VALUES ($1, $2, '2026-27', '2026-06-01', '2027-04-30', 'active', true),
					       ($1, $2, '2025-26', '2025-06-01', '2026-04-30', 'closed', false)
					RETURNING id, is_current
				)
				SELECT id FROM inserted WHERE is_current`,
				orgID, id).Scan(&currentYearID); err != nil {
				return uuid.Nil, fmt.Errorf("create academic years for %s: %w", s.code, err)
			}
			currentYearIDs[s.code] = currentYearID
		}

		roleIDs := map[string]uuid.UUID{}
		rows, err := tx.Query(ctx, `SELECT key, id FROM roles WHERE organization_id IS NULL`)
		if err != nil {
			return uuid.Nil, fmt.Errorf("load system roles: %w", err)
		}
		for rows.Next() {
			var key string
			var id uuid.UUID
			if err := rows.Scan(&key, &id); err != nil {
				rows.Close()
				return uuid.Nil, err
			}
			roleIDs[key] = id
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return uuid.Nil, err
		}

		userIDs := map[string]uuid.UUID{}

		for _, u := range users {
			roleID, ok := roleIDs[u.role]
			if !ok {
				return uuid.Nil, fmt.Errorf("system role %q is missing — did migration 0004 run?", u.role)
			}

			var userID uuid.UUID
			if err := tx.QueryRow(ctx, `
				INSERT INTO users (organization_id, email, full_name, password_hash)
				VALUES ($1, $2, $3, $4) RETURNING id`,
				orgID, u.email, u.name, hash).Scan(&userID); err != nil {
				return uuid.Nil, fmt.Errorf("create user %s: %w", u.email, err)
			}
			userIDs[u.email] = userID

			var schoolID *uuid.UUID
			if u.school != "" {
				id, ok := schoolIDs[u.school]
				if !ok {
					return uuid.Nil, fmt.Errorf("seed user %s references unknown school %s", u.email, u.school)
				}
				schoolID = &id
			}

			if _, err := tx.Exec(ctx, `
				INSERT INTO memberships (user_id, organization_id, school_id, role_id)
				VALUES ($1, $2, $3, $4)`, userID, orgID, schoolID, roleID); err != nil {
				return uuid.Nil, fmt.Errorf("create membership for %s: %w", u.email, err)
			}
		}

		// The academic structure and student population go into the CBSE school.
		// The second school is left empty on purpose: it is what proves that a
		// principal at one school sees none of the other's students.
		if err := seedSIS(ctx, tx, orgID, schoolIDs["VNPS-HYD"], currentYearIDs["VNPS-HYD"],
			userIDs["anitha.reddy@vidyaniketan.test"], hash); err != nil {
			return uuid.Nil, err
		}

		return orgID, nil
	})
	if err != nil {
		return err
	}

	slog.Info("seed complete", "organization_id", orgID, "schools", 2, "users", len(users))
	fmt.Println()
	fmt.Println("  Seeded Vidya Niketan Educational Trust")
	fmt.Println("  Sign in with any of these — password:", DevPassword)
	fmt.Println()
	for _, u := range users {
		scope := u.school
		if scope == "" {
			scope = "organisation-wide"
		}
		fmt.Printf("    %-40s %-14s %s\n", u.email, u.role, scope)
	}
	fmt.Println()
	return nil
}
