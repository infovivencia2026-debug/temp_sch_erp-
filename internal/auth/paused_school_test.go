package auth

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
)

/*
A paused school's people are told the school is paused, not that they do not exist.

	Before this, the candidate query filtered suspended schools out entirely, so a
	principal whose school was switched off that morning was shown the sentence
	meant for a stranger: "No account here uses that username, email or phone".
	On this deployment that cost an afternoon — a stray click suspended the
	school and two people concluded the credentials were wrong.

	Three things have to hold at once:
	  - right password + paused school  -> "paused", so they ring the office
	  - wrong password + paused school  -> "wrong password", so a stranger typing
	    addresses learns nothing about which schools exist or their standing
	  - the same account once the school is active again -> signs in
*/
func TestAPausedSchoolIsNamedAsPausedOnlyAfterThePasswordIsRight(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	db, err := database.Connect(ctx, url, 2)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(db.Close)

	hasher := NewHasher("test-pepper")
	hash, err := hasher.Hash("correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	email := "paused-" + uuid.NewString()[:8] + "@school.test"

	var inst uuid.UUID
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO institutions (name, short_name, slug, status)
			VALUES ('Paused Test', 'PT', $1, 'suspended') RETURNING id`,
			"pt-"+uuid.NewString()[:8]).Scan(&inst); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO users (institution_id, email, full_name, password_hash, status)
			VALUES ($1, $2::citext, 'Paused Principal', $3, 'active')`, inst, email, hash)
		return err
	}); err != nil {
		t.Fatalf("setup: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `DELETE FROM institutions WHERE id = $1`, inst)
			return err
		})
	})

	h := &Handler{db: db, hasher: hasher, throttle: NewThrottle()}

	// Right password: the honest sentence.
	if _, _, err := h.authenticate(ctx, email, "correct-horse-battery"); !errors.Is(err, errSchoolPaused) {
		t.Fatalf("right password on a paused school: got %v, want errSchoolPaused", err)
	}
	// Wrong password: still "wrong password" -- nothing about the school leaks.
	if _, _, err := h.authenticate(ctx, email, "nope"); !errors.Is(err, ErrMismatch) {
		t.Fatalf("wrong password on a paused school: got %v, want ErrMismatch (no leak)", err)
	}
	// And it must not be the stranger's sentence in either case.
	if _, _, err := h.authenticate(ctx, email, "nope"); errors.Is(err, errNoAccount) {
		t.Fatal("a paused school's user was told no such account exists")
	}

	// Switched back on: the same credentials sign in.
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE institutions SET status = 'active' WHERE id = $1`, inst)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, gotInst, err := h.authenticate(ctx, email, "correct-horse-battery"); err != nil || gotInst != inst {
		t.Fatalf("after reactivation: err=%v inst=%v want nil, %v", err, gotInst, inst)
	}
}
