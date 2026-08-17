package tests

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
)

// TestTenantIsolation is the test that matters most in this system: it proves
// the RLS policies, not application code, are what keep two schools apart.
func TestTenantIsolation(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	instA := newInstitution(t, db, "Alpha School")
	instB := newInstitution(t, db, "Beta School")
	campusA := newCampus(t, db, instA)
	campusB := newCampus(t, db, instB)

	studentA := newStudent(t, db, instA, campusA, "A-001", "Asha")
	newStudent(t, db, instB, campusB, "B-001", "Bala")

	t.Run("sees only its own rows", func(t *testing.T) {
		var n int
		err := db.InTenant(ctx, database.Scope{InstitutionID: instA}, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM students`).Scan(&n)
		})
		if err != nil {
			t.Fatalf("count: %v", err)
		}
		if n != 1 {
			t.Fatalf("tenant A should see exactly its own 1 student, saw %d", n)
		}
	})

	t.Run("cannot read another tenant's row by id", func(t *testing.T) {
		var name string
		err := db.InTenant(ctx, database.Scope{InstitutionID: instB}, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT first_name FROM students WHERE id = $1`, studentA).Scan(&name)
		})
		// No rows, not a permission error: RLS filters rather than rejects, so
		// a cross-tenant id is indistinguishable from a nonexistent one.
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("expected ErrNoRows reading across tenants, got %v (name=%q)", err, name)
		}
	})

	t.Run("cannot update another tenant's row", func(t *testing.T) {
		var affected int64
		err := db.InTenant(ctx, database.Scope{InstitutionID: instB}, func(tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `UPDATE students SET first_name = 'hacked' WHERE id = $1`, studentA)
			affected = tag.RowsAffected()
			return err
		})
		if err != nil {
			t.Fatalf("update: %v", err)
		}
		if affected != 0 {
			t.Fatalf("expected 0 rows updated across tenants, got %d", affected)
		}
	})

	t.Run("cannot insert a row belonging to another tenant", func(t *testing.T) {
		// The WITH CHECK half of the policy: even naming tenant A's id
		// explicitly must fail while scoped to B.
		err := db.InTenant(ctx, database.Scope{InstitutionID: instB}, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `
				INSERT INTO students (institution_id, campus_id, admission_no, first_name)
				VALUES ($1,$2,'X-999','Mallory')`, instA, campusA)
			return err
		})
		if err == nil {
			t.Fatal("expected the WITH CHECK policy to reject a cross-tenant insert")
		}
	})

	t.Run("unset scope sees nothing", func(t *testing.T) {
		// The safe failure direction: forget to set the scope and you get zero
		// rows, never everyone's rows.
		var n int
		err := db.InTenant(ctx, database.Scope{InstitutionID: uuid.Nil}, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM students`).Scan(&n)
		})
		if err != nil {
			t.Fatalf("count: %v", err)
		}
		if n != 0 {
			t.Fatalf("expected 0 rows with no tenant scope, got %d", n)
		}
	})

	t.Run("platform scope sees across tenants", func(t *testing.T) {
		var n int
		err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx,
				`SELECT count(*) FROM students WHERE institution_id IN ($1,$2)`, instA, instB).Scan(&n)
		})
		if err != nil {
			t.Fatalf("count: %v", err)
		}
		if n != 2 {
			t.Fatalf("platform scope should see both students, saw %d", n)
		}
	})

	t.Run("scope does not leak between transactions", func(t *testing.T) {
		// SET LOCAL is transaction-scoped, so the pooled connection that just
		// served tenant A must not still be scoped to A for the next caller.
		_ = db.InTenant(ctx, database.Scope{InstitutionID: instA}, func(tx pgx.Tx) error {
			var n int
			return tx.QueryRow(ctx, `SELECT count(*) FROM students`).Scan(&n)
		})
		var n int
		err := db.InTenant(ctx, database.Scope{InstitutionID: uuid.Nil}, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM students`).Scan(&n)
		})
		if err != nil {
			t.Fatalf("count: %v", err)
		}
		if n != 0 {
			t.Fatalf("tenant scope leaked across transactions: saw %d rows", n)
		}
	})
}
