// Package tests holds integration tests that run against a real Postgres.
//
// They are skipped unless TEST_DATABASE_URL is set, so `go test ./...` stays
// green on a machine with no database. The RLS behaviour these cover cannot be
// unit-tested: it is enforced by Postgres, not by Go, so a fake would only
// prove the fake works.
package tests

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
)

func testDB(t *testing.T) *database.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := database.Connect(context.Background(), url, 4)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(db.Close)
	return db
}

// newInstitution creates a throwaway tenant and removes it afterwards.
// Everything else cascades from institutions via ON DELETE CASCADE.
func newInstitution(t *testing.T, db *database.DB, name string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO institutions (name, short_name, slug)
			VALUES ($1, $1, $2) RETURNING id`, name, name+"-"+uuid.NewString()[:8]).Scan(&id)
	})
	if err != nil {
		t.Fatalf("create institution %s: %v", name, err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `DELETE FROM institutions WHERE id = $1`, id)
			return err
		})
	})
	return id
}

func newCampus(t *testing.T, db *database.DB, inst uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO campuses (institution_id, name, code)
			VALUES ($1, 'Main', 'MAIN') RETURNING id`, inst).Scan(&id)
	})
	if err != nil {
		t.Fatalf("create campus: %v", err)
	}
	return id
}

func newStudent(t *testing.T, db *database.DB, inst, campus uuid.UUID, admissionNo, first string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO students (institution_id, campus_id, admission_no, first_name)
			VALUES ($1,$2,$3,$4) RETURNING id`, inst, campus, admissionNo, first).Scan(&id)
	})
	if err != nil {
		t.Fatalf("create student: %v", err)
	}
	return id
}
