package main

/* THE FORM FEE IS NOT A CLASS FEE.

   A thousand rupees to fill in an admission form is paid once, by a family
   applying, before there is a child on any roll. It was loaded onto all
   thirteen class fee structures, which says something quite different: that
   every child in Grade 4 owes a thousand rupees this year for having applied.

   Nobody has been billed it -- the demand runs raised tuition, books and
   uniform only -- so this is removing a wrong statement rather than unwinding
   a wrong charge. The head itself stays: the school does collect it, at
   admission, and Admissions raises it against the application. What goes is
   its place on the structure that prices a class for the year.

   Refuses to run if anything has actually been billed under it, because then
   the fix is a credit note and a conversation, not a delete.
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

	var headID string
	if err := tx.QueryRow(ctx,
		`SELECT id::text FROM fee_heads WHERE institution_id=$1 AND code='APPL'`,
		inst).Scan(&headID); err != nil {
		fmt.Println("no application fee head:", err)
		return
	}

	var billed int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM invoice_lines il
		  JOIN invoices i ON i.id = il.invoice_id
		 WHERE i.institution_id=$1 AND il.fee_head_id=$2 AND i.status <> 'cancelled'`,
		inst, headID).Scan(&billed); err != nil {
		panic(err)
	}
	if billed > 0 {
		fmt.Printf("REFUSING: %d invoice lines already charge the application fee.\n", billed)
		fmt.Println("Those are real bills; taking the head off the structure would not undo them.")
		os.Exit(1)
	}
	fmt.Println("nothing has been billed under the application fee")

	tag, err := tx.Exec(ctx, `
		DELETE FROM fee_structure_items i
		 USING fee_structures s
		 WHERE i.fee_structure_id = s.id
		   AND s.institution_id = $1 AND i.fee_head_id = $2`, inst, headID)
	if err != nil {
		panic(err)
	}
	fmt.Printf("priced lines removed from structures: %d\n", tag.RowsAffected())

	// A structure left with nothing priced on it is not a structure. These were
	// created only to hold the form fee.
	tag, err = tx.Exec(ctx, `
		DELETE FROM fee_structures s
		 WHERE s.institution_id = $1
		   AND upper(s.name) LIKE 'APPLICATION%'
		   AND NOT EXISTS (SELECT 1 FROM fee_structure_items i WHERE i.fee_structure_id = s.id)`,
		inst)
	if err != nil {
		panic(err)
	}
	fmt.Printf("empty application-fee structures removed: %d\n", tag.RowsAffected())

	rows, err := tx.Query(ctx, `
		SELECT s.name, COALESCE(c.name,'(all classes)'), count(i.id), COALESCE(sum(i.amount_paise),0)/100
		  FROM fee_structures s
		  LEFT JOIN classes c ON c.id = s.class_id
		  LEFT JOIN fee_structure_items i ON i.fee_structure_id = s.id
		 WHERE s.institution_id=$1
		 GROUP BY 1,2 ORDER BY 2,1`, inst)
	if err != nil {
		panic(err)
	}
	fmt.Println("\nwhat each class is priced at now:")
	for rows.Next() {
		var n, c string
		var lines, amt int64
		if err := rows.Scan(&n, &c, &lines, &amt); err != nil {
			panic(err)
		}
		fmt.Printf("  %-13s %-42s %d terms  Rs %d\n", c, n, lines, amt)
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
