package main

/* ONE RECEIPT THE BRACKET HID.

   NIMMALA PRANAV's second transport instalment reads "(T.F)7000 paid on
   07.09.26" -- the office's annotation, added when asked what the figure was.
   The bracket at the front is exactly what stopped the amount being read, so
   the child was billed the slab and credited nothing for term two.

   Posted here against the instalment it belongs to, dated as the register
   says. Refuses to post twice. */

import (
	"context"
	"fmt"
	"os"

	"github.com/google/uuid"
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
	instID := uuid.MustParse(inst)

	tx, err := conn.Begin(ctx)
	if err != nil {
		panic(err)
	}
	defer tx.Rollback(ctx)

	var sid, campusID, invID uuid.UUID
	var name, invNo string
	var net, paid int64
	if err := tx.QueryRow(ctx, `
		SELECT s.id, s.campus_id, trim(s.first_name||' '||COALESCE(s.last_name,'')),
		       i.id, i.invoice_no, i.net_paise, i.paid_paise
		  FROM students s
		  JOIN invoices i ON i.student_id = s.id
		  JOIN invoice_lines il ON il.invoice_id = i.id
		  JOIN fee_heads fh ON fh.id = il.fee_head_id AND fh.code = 'TRAN'
		  JOIN academic_years ay ON ay.id = i.academic_year_id AND ay.is_current
		 WHERE s.institution_id = $1 AND upper(s.admission_no) = '25YPS0136'
		   AND i.instalment_no = 31`, instID).Scan(&sid, &campusID, &name, &invID, &invNo, &net, &paid); err != nil {
		panic(fmt.Errorf("second transport instalment: %w", err))
	}
	fmt.Printf("%s  %s  charged %d, paid so far %d\n", name, invNo, net/100, paid/100)
	if paid > 0 {
		fmt.Println("already has a payment -- nothing to do")
		return
	}

	const amount = 700000
	var payID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO payments (institution_id, campus_id, student_id, receipt_no,
		                      amount_paise, allocated_paise, mode, paid_on, status, remarks)
		VALUES ($1,$2,$3,'RCT/2026-27/TRN099',$4,0,'adjustment','2026-09-07','success',
		        'Transport fee, from the school''s fee register: (T.F)7000 paid on 07.09.26')
		RETURNING id`, instID, campusID, sid, amount).Scan(&payID); err != nil {
		panic(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise)
		VALUES ($1,$2,$3,$4)`, instID, payID, invID, amount); err != nil {
		panic(err)
	}
	fmt.Printf("posted Rs %d on 7 Sep 2026 against %s\n", amount/100, invNo)

	if os.Getenv("APPLY") != "1" {
		fmt.Println("\nDRY RUN -- rolled back")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println("\nCOMMITTED")
}
