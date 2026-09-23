// setpw sets a fresh random password on one PLATFORM account -- a user with
// no institution, such as the seller admin -- and prints it once.
//
// The migrate tool cannot do this: create-admin insists on an institution and
// set-passwords targets a school's demo users. Platform accounts had no
// password path of their own except "Forgotten your password?".
//
// Run from a machine with the deploy env sourced (PASSWORD_PEPPER and
// MIGRATE_DATABASE_URL -- the owner DSN, because the users table is under
// FORCE ROW LEVEL SECURITY and AsPlatform is what lifts it):
//
//	cd /path/to/repo
//	set -a; . deploy/cloudrun/.env.cloudrun; set +a
//	go run ./cmd/setpw infovivencia2026@gmail.com
//
// The password is printed to the terminal and nowhere else. Change it after
// the first sign-in if the terminal was shared.
package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"os"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/database"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: setpw <email of a platform account>")
		os.Exit(2)
	}
	if os.Getenv("PASSWORD_PEPPER") == "" || os.Getenv("MIGRATE_DATABASE_URL") == "" {
		fmt.Fprintln(os.Stderr, "PASSWORD_PEPPER and MIGRATE_DATABASE_URL must be set (source deploy/cloudrun/.env.cloudrun)")
		os.Exit(2)
	}

	// Sixteen characters from an alphabet with no 0/O/1/l/I, so it can be
	// read off a screen and typed without a mistake.
	const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 16)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			panic(err)
		}
		b[i] = alphabet[n.Int64()]
	}
	pw := string(b)

	hash, err := auth.NewHasher(os.Getenv("PASSWORD_PEPPER")).Hash(pw)
	if err != nil {
		panic(err)
	}
	db, err := database.Connect(context.Background(), os.Getenv("MIGRATE_DATABASE_URL"), 2)
	if err != nil {
		panic(err)
	}
	defer db.Close()

	var n int64
	err = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
		ct, err := tx.Exec(context.Background(), `
			UPDATE users
			   SET password_hash = $2, must_change_password = false, updated_at = now()
			 WHERE institution_id IS NULL AND email = $1`, os.Args[1], hash)
		n = ct.RowsAffected()
		return err
	})
	if err != nil {
		panic(err)
	}
	if n == 0 {
		fmt.Fprintf(os.Stderr, "no platform account with email %s\n", os.Args[1])
		os.Exit(1)
	}
	fmt.Printf("updated %d account\nID:       %s\nPassword: %s\n", n, os.Args[1], pw)
}
