package main

/* TWO CHILDREN THE ROLL KEPT AND THE SCHOOL HAD LET GO.

   RAHIL SYED and KATTA REDDY are active in Grade 6, absent from the 2026-27
   fee register, and named in the 2025-26 TC register as having left. Three
   sources; the students sheet was the odd one out, and it was the one the
   import trusted.

   The office has confirmed both left with a TC. So: withdrawn as of the year
   end the TC register gives, their enrolment closed, and the reason written in
   the school's own words rather than as a status code.

   'withdrawn' rather than 'transferred', because neither has a certificate
   number -- one applied, one simply did not return -- and 'transferred' says a
   document exists. */

import (
	"context"
	"fmt"
	"os"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

var leavers = map[string]string{
	"24YPS0076": "TC applied; left at the end of 2025-26",
	"25YPS0060": "Did not return for 2026-27",
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

	for admn, why := range leavers {
		var sid uuid.UUID
		var name, status string
		if err := tx.QueryRow(ctx, `
			SELECT id, trim(first_name||' '||COALESCE(last_name,'')), status
			  FROM students WHERE institution_id=$1 AND upper(admission_no)=$2`,
			instID, admn).Scan(&sid, &name, &status); err != nil {
			panic(fmt.Errorf("%s: %w", admn, err))
		}
		var bills int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM invoices i JOIN academic_years ay ON ay.id=i.academic_year_id
			 WHERE i.student_id=$1 AND ay.is_current AND i.status<>'cancelled'`, sid).Scan(&bills); err != nil {
			panic(err)
		}
		if bills > 0 {
			fmt.Printf("REFUSING %s: %d bills this year -- a child with bills is not a leaver\n", admn, bills)
			os.Exit(1)
		}

		if _, err := tx.Exec(ctx, `
			UPDATE students
			   SET status = 'withdrawn', exit_date = '2026-03-31', exit_reason = $2,
			       updated_at = now()
			 WHERE id = $1`, sid, why); err != nil {
			panic(err)
		}
		// The enrolment is closed, not deleted: it is the record that they were
		// in Grade 6 when the year began.
		tag, err := tx.Exec(ctx, `
			UPDATE enrollments SET status = 'withdrawn'
			 WHERE student_id = $1 AND status = 'active'`, sid)
		if err != nil {
			panic(err)
		}
		fmt.Printf("%-11s %-22s was %-8s -> withdrawn, %d enrolment closed: %s\n",
			admn, name, status, tag.RowsAffected(), why)
	}

	var active, withdrawn, transferred int
	tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='active'),
	                         count(*) FILTER (WHERE status='withdrawn'),
	                         count(*) FILTER (WHERE status='transferred')
	                    FROM students WHERE institution_id=$1`, instID).Scan(&active, &withdrawn, &transferred)
	fmt.Printf("\nroll now: %d active, %d withdrawn, %d transferred\n", active, withdrawn, transferred)

	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}
