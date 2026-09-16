package main

/* A CONCESSION THE SCHOOL HAS ALREADY GIVEN IS NOT A REQUEST.

   fee_concessions carries both a decision and a request for one: status runs
   pending -> approved or rejected, and the record screen reads it to say
   whether a family is waiting on the principal. The register load set
   approved_at and left status alone, so 251 discounts the school granted
   months ago -- and has been collecting against all year -- displayed as
   "pending, waiting on the principal".

   The money was never wrong: the discount sits on the invoice line, and every
   balance in the system already reflects it. What was wrong was the sentence
   the screen put next to it, which invited an office to approve a thing that
   had been settled before the software existed.

   These are marked approved and dated the day the register was exported.
   approved_by is deliberately left empty: no one person decided this inside
   this system, and naming an account that merely ran an import would put a
   signature on a decision it did not make. The note says where it came from,
   which is the honest answer to "who approved this".
*/

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

const inst = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"

func main() {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, os.Getenv("DBURL"))
	if err != nil {
		panic(err)
	}
	defer conn.Close(ctx)

	tx, err := conn.Begin(ctx)
	if err != nil {
		panic(err)
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx, `
		UPDATE fee_concessions
		   SET status        = 'approved',
		       decided_at    = COALESCE(decided_at, approved_at, now()),
		       decision_note = COALESCE(NULLIF(decision_note,''),
		                                'Granted before the school moved onto this system; '
		                                || 'carried in from its own fee register.')
		 WHERE institution_id = $1
		   AND status = 'pending'
		   AND approved_at IS NOT NULL
		   AND reason LIKE '%fee register%'`, inst)
	if err != nil {
		panic(err)
	}
	fmt.Printf("concessions marked approved: %d\n", tag.RowsAffected())

	rows, err := tx.Query(ctx,
		`SELECT status, count(*), sum(amount_paise)/100
		   FROM fee_concessions WHERE institution_id=$1 GROUP BY 1 ORDER BY 1`, inst)
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var s string
		var n, amt int64
		if err := rows.Scan(&s, &n, &amt); err != nil {
			panic(err)
		}
		fmt.Printf("  %-10s %4d  Rs %d\n", s, n, amt)
	}
	rows.Close()

	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}
