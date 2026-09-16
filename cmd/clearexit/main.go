package main

/* A LEAVING DATE NOBODY RECORDED SHOULD READ AS BLANK.

   Seventy-two withdrawn children carry a leaving date, and it is the same date
   for dozens of them at a time: forty-five on 2026-09-09, twenty-nine on
   2026-04-12. Those are the days somebody worked through the list and pressed
   withdraw. No child left school in a group of forty-five.

   A wrong date is worse than none, because it gets believed. It prints on a
   transfer certificate, it decides which academic year a leaver belongs to,
   and nothing about it looks uncertain. A blank tells the office to go and
   look it up in the register, which is the true state of the knowledge.

   Only those two batch dates are cleared. A date that stands on its own is
   somebody's actual entry and is left where it is. The reasons stay whatever
   they are: they came from the school's own leavers list and are real.
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

	fmt.Println("leaving dates, before:")
	rows, err := tx.Query(ctx, `
		SELECT exit_date::text, count(*)
		  FROM students
		 WHERE institution_id=$1 AND status='withdrawn' AND exit_date IS NOT NULL
		 GROUP BY 1 ORDER BY 2 DESC`, inst)
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var d string
		var n int
		if err := rows.Scan(&d, &n); err != nil {
			panic(err)
		}
		mark := ""
		if n > 5 {
			mark = "  <- a batch, not a day children left"
		}
		fmt.Printf("  %-12s %3d%s\n", d, n, mark)
	}
	rows.Close()

	// Any date shared by more than five children is a day the list was worked
	// through, not a day a family left. Stated as a rule rather than as two
	// hard-coded dates, so a third batch does not slip past unnoticed.
	tag, err := tx.Exec(ctx, `
		UPDATE students SET exit_date = NULL, updated_at = now()
		 WHERE institution_id = $1 AND status = 'withdrawn'
		   AND exit_date IN (
			SELECT exit_date FROM students
			 WHERE institution_id = $1 AND status = 'withdrawn' AND exit_date IS NOT NULL
			 GROUP BY exit_date HAVING count(*) > 5)`, inst)
	if err != nil {
		panic(err)
	}
	fmt.Printf("\nbatch dates cleared: %d\n", tag.RowsAffected())

	var left, reasons int
	if err := tx.QueryRow(ctx, `
		SELECT count(exit_date), count(exit_reason) FROM students
		 WHERE institution_id=$1 AND status='withdrawn'`, inst).Scan(&left, &reasons); err != nil {
		panic(err)
	}
	fmt.Printf("still holding a leaving date: %d\nreasons kept:                %d\n", left, reasons)

	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}
