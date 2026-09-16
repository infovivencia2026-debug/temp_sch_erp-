package main

/* THE THOUSAND RUPEES TO FILL IN THE FORM.

   A new admission pays 1,000 for the application. The register does not give
   it a column -- it is folded into the term-one row, which is why a new child
   shows 36,000 paid against a 35,000 charge, and why seven children's "due"
   cells read exactly a thousand more than they are short.

   Neither half of that was in the ledger. Nobody was billed the fee, so the
   families who paid it have 1,13,450 sitting as unallocated credit across 64
   receipts, and the families who have not paid it appear to owe a thousand
   less than the office thinks. Two errors pointing opposite ways, both
   invisible, both explained by one missing invoice.

   So: raise it for every child admitted this year, then let the credit they
   already paid settle it. A family that paid 36,000 against a 35,000 term is
   square afterwards and always was; a family that owes it now says so.

   Only this year's admissions. The fee is charged once, at admission, and
   billing it to a child who joined in 2024 would be inventing a debt.

   Idempotent: a child already billed for it is skipped.
*/

import (
	"context"
	"fmt"
	"os"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	inst   = "f0455c35-f2f2-4b4e-86ef-05f40933f39c"
	amount = 100000 // one thousand rupees, in paise
)

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

	var yearID, campusID, appl uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT id FROM academic_years WHERE institution_id=$1 AND is_current`,
		instID).Scan(&yearID); err != nil {
		panic(err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id FROM campuses WHERE institution_id=$1 LIMIT 1`, instID).Scan(&campusID); err != nil {
		panic(err)
	}
	if err := tx.QueryRow(ctx,
		`SELECT id FROM fee_heads WHERE institution_id=$1 AND code='APPL'`,
		instID).Scan(&appl); err != nil {
		panic(fmt.Errorf("no application fee head: %w", err))
	}

	// Every child admitted inside the current academic year who has not
	// already been billed for it.
	rows, err := tx.Query(ctx, `
		SELECT s.id, s.admission_no,
		       trim(s.first_name||' '||COALESCE(s.last_name,''))
		  FROM students s
		  JOIN academic_years ay ON ay.id = $2
		 WHERE s.institution_id = $1
		   AND s.status = 'active'
		   AND s.admission_date BETWEEN ay.starts_on AND ay.ends_on
		   AND NOT EXISTS (
		       SELECT 1 FROM invoice_lines il
		         JOIN invoices i ON i.id = il.invoice_id
		        WHERE i.student_id = s.id AND i.academic_year_id = $2
		          AND il.fee_head_id = $3 AND i.status <> 'cancelled')
		 ORDER BY s.admission_no`, instID, yearID, appl)
	if err != nil {
		panic(err)
	}
	type kid struct {
		id   uuid.UUID
		admn string
		name string
	}
	var kids []kid
	for rows.Next() {
		var k kid
		if err := rows.Scan(&k.id, &k.admn, &k.name); err != nil {
			panic(err)
		}
		kids = append(kids, k)
	}
	rows.Close()

	seq := 0
	settled, owing := 0, 0
	var settledAmt int64

	for _, k := range kids {
		seq++
		var invID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO invoices (institution_id, campus_id, student_id, academic_year_id,
			                      invoice_no, instalment_no, issued_on, due_on,
			                      gross_paise, discount_paise, status, note)
			VALUES ($1,$2,$3,$4,$5,40,CURRENT_DATE,CURRENT_DATE+14,$6,0,'unpaid',$7)
			RETURNING id`,
			instID, campusID, k.id, yearID,
			fmt.Sprintf("INV/2026-27/APP%03d", seq), amount,
			"Application fee, charged at admission").Scan(&invID); err != nil {
			panic(fmt.Errorf("%s: %w", k.admn, err))
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id,
			                           description, amount_paise, discount_paise)
			VALUES ($1,$2,$3,'Application fee',$4,0)`,
			instID, invID, appl, amount); err != nil {
			panic(err)
		}

		/* AND THE MONEY THEY ALREADY HANDED OVER.

		   The extra thousand was paid at the counter and recorded whole, with
		   the surplus left unallocated because there was nothing to allocate it
		   to. Now there is. Oldest receipt first, so the credit is consumed in
		   the order it arrived rather than from whichever row the query happened
		   to return. */
		prows, err := tx.Query(ctx, `
			SELECT id, amount_paise - allocated_paise
			  FROM payments
			 WHERE institution_id = $1 AND student_id = $2
			   AND amount_paise > allocated_paise
			 ORDER BY paid_on, created_at`, instID, k.id)
		if err != nil {
			panic(err)
		}
		type credit struct {
			id   uuid.UUID
			left int64
		}
		var credits []credit
		for prows.Next() {
			var c credit
			if err := prows.Scan(&c.id, &c.left); err != nil {
				panic(err)
			}
			credits = append(credits, c)
		}
		prows.Close()

		owed := int64(amount)
		for _, c := range credits {
			if owed <= 0 {
				break
			}
			take := c.left
			if take > owed {
				take = owed
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise)
				VALUES ($1,$2,$3,$4)`, instID, c.id, invID, take); err != nil {
				panic(err)
			}
			/* payments.allocated_paise is not touched here. A trigger --
			   sync_payment_allocated, on payment_allocations -- already keeps it
			   equal to the sum of the allocations, and adding to it by hand made
			   it double, which the check constraint that allocated may not exceed
			   the amount caught immediately. */
			owed -= take
			settledAmt += take
		}
		if owed == 0 {
			settled++
		} else {
			owing++
		}
	}

	fmt.Printf("new admissions billed:       %d\n", len(kids))
	fmt.Printf("  settled from credit already paid: %d  (Rs %d)\n", settled, settledAmt/100)
	fmt.Printf("  now showing as owing:             %d  (Rs %d)\n",
		owing, (int64(len(kids))*amount-settledAmt)/100)

	var left int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_paise - allocated_paise),0)::bigint
		  FROM payments WHERE institution_id=$1 AND amount_paise > allocated_paise`,
		instID).Scan(&left); err != nil {
		panic(err)
	}
	fmt.Printf("\nunallocated credit remaining: Rs %d\n", left/100)

	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}
