package main

/* TWO CHILDREN THE SYSTEM HAD BURIED.

   UBAIDULLA SAAD MOHAMMED and T TRISHAAN are marked withdrawn with no class,
   and yet the school's fee register bills them for 2026-27 and its students
   sheet lists them as Active in Sr KG and Grade 6. They appear in neither the
   leavers list nor either transfer-certificate sheet -- there is no record
   anywhere of them having left.

   A child wrongly marked withdrawn is not a cosmetic fault. They are off the
   roll, so no attendance is taken for them, no demand run reaches them, and
   no report counts them. They vanish from the school while still attending it.

   The school's own students sheet is the authority here, so this puts them
   back: active, enrolled in the class that sheet names, for the current year.
*/

import (
	"context"
	"fmt"
	"os"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

// Admission number to the class and section the students sheet puts them in.
// The section is named rather than guessed: enrollments requires one, and the
// sheet has it.
var putBack = map[string]struct{ class, section string }{
	"24YPS0040": {"Sr KG", "A"},
	"25YPS0090": {"Grade 6", "HITHA"},
}

func main() {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, os.Getenv("DBURL"))
	if err != nil {
		panic(err)
	}
	defer conn.Close(ctx)
	instID := uuid.MustParse(inst)

	tx, err := conn.Begin(ctx)
	if err != nil {
		panic(err)
	}
	defer tx.Rollback(ctx)

	var yearID uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM academic_years WHERE institution_id=$1 AND is_current`,
		instID).Scan(&yearID); err != nil {
		panic(err)
	}

	for admn, want := range putBack {
		var sid uuid.UUID
		var was string
		if err := tx.QueryRow(ctx,
			`SELECT id, status FROM students WHERE institution_id=$1 AND upper(admission_no)=$2`,
			instID, admn).Scan(&sid, &was); err != nil {
			fmt.Printf("%-11s not found: %v\n", admn, err)
			continue
		}
		var cid, secID uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT id FROM classes WHERE institution_id=$1 AND name=$2`,
			instID, want.class).Scan(&cid); err != nil {
			panic(fmt.Errorf("class %s: %w", want.class, err))
		}
		if err := tx.QueryRow(ctx,
			`SELECT id FROM sections
			  WHERE institution_id=$1 AND class_id=$2 AND upper(name)=upper($3)`,
			instID, cid, want.section).Scan(&secID); err != nil {
			panic(fmt.Errorf("section %s of %s: %w", want.section, want.class, err))
		}

		// Cleared, not kept: an exit reason on a child who never left is the
		// sentence that put them here.
		if _, err := tx.Exec(ctx, `
			UPDATE students
			   SET status = 'active', exit_date = NULL, exit_reason = NULL, updated_at = now()
			 WHERE id = $1`, sid); err != nil {
			panic(err)
		}

		// A section is not guessed at. The enrolment names the class, which is
		// what the demand run and the roll both read; whoever knows the section
		// can set it in the app.
		var already int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM enrollments
			 WHERE student_id=$1 AND academic_year_id=$2 AND status='active'`,
			sid, yearID).Scan(&already); err != nil {
			panic(err)
		}
		if already == 0 {
			if _, err := tx.Exec(ctx, `
				INSERT INTO enrollments (institution_id, student_id, academic_year_id,
				                         class_id, section_id, status)
				VALUES ($1,$2,$3,$4,$5,'active')`,
				instID, sid, yearID, cid, secID); err != nil {
				panic(err)
			}
		}
		fmt.Printf("%-11s was %-10s -> active, enrolled in %s\n", admn, was, want.class+" "+want.section)
	}

	var active, withdrawn int
	tx.QueryRow(ctx, `SELECT count(*) FROM students WHERE institution_id=$1 AND status='active'`, instID).Scan(&active)
	tx.QueryRow(ctx, `SELECT count(*) FROM students WHERE institution_id=$1 AND status='withdrawn'`, instID).Scan(&withdrawn)
	fmt.Printf("\nroll now: %d active, %d withdrawn\n", active, withdrawn)

	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}
