package api

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

/* Arrears: what a family still owed when the year turned.

   The fee engine had no brought-forward. The old year's invoices stayed open
   in the ledger, which is honest, but the new year's demand was raised from
   the new structure alone -- and the demand is the paper the family pays
   against. A defaulter's June bill read as though March had been settled. */

type carriedInvoice struct {
	id        uuid.UUID
	invoiceNo string
	yearName  string
	balance   int64
}

// carryArrears brings a child's unpaid balance from earlier years onto the
// invoice just raised, and returns how much it moved.
//
// Each old invoice becomes one line on the new one, named for the invoice
// and year it came from, and is then settled by an adjustment allocated to
// it -- the same mode a write-off uses, and one every collection report
// already excludes. The debt therefore exists in exactly one open place, and
// the ledger's own totals (charged less paid) come out unchanged: the old
// charge stays, its adjustment cancels it, and the new line restates it.
// Cancelling the old invoice instead would have dropped a part-paid bill's
// charge while keeping its payment, and the family would have been owed
// money it never paid.
//
// Only earlier years. An unpaid first instalment is not arrears when the
// second is raised; it is a bill the family has, and moving it would reset
// its due date and its ageing.
func carryArrears(ctx context.Context, tx pgx.Tx, inst, campus uuid.UUID,
	student, year, invoiceID uuid.UUID, invoiceNo string) (int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT i.id, i.invoice_no, ay.name, i.net_paise - i.paid_paise
		  FROM invoices i
		  JOIN academic_years ay ON ay.id = i.academic_year_id
		  JOIN academic_years this ON this.id = $2
		 WHERE i.student_id = $1
		   AND i.academic_year_id <> $2
		   AND ay.starts_on < this.starts_on
		   AND i.status IN ('unpaid','partial','overdue')
		   AND i.net_paise > i.paid_paise
		   AND NOT EXISTS (SELECT 1 FROM invoice_carry_forwards cf WHERE cf.from_invoice_id = i.id)
		 ORDER BY COALESCE(i.due_on, i.issued_on), i.invoice_no
		 FOR UPDATE OF i`, student, year)
	if err != nil {
		return 0, fmt.Errorf("find arrears: %w", err)
	}
	var old []carriedInvoice
	for rows.Next() {
		var c carriedInvoice
		if err := rows.Scan(&c.id, &c.invoiceNo, &c.yearName, &c.balance); err != nil {
			rows.Close()
			return 0, err
		}
		old = append(old, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(old) == 0 {
		return 0, nil
	}

	head, err := ensureFeeHead(ctx, tx, inst, "arrears", "Arrears brought forward")
	if err != nil {
		return 0, err
	}
	var moved int64
	for _, c := range old {
		if _, err := tx.Exec(ctx, `
			INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id, description, amount_paise, discount_paise)
			VALUES ($1, $2, $3, $4, $5, 0)`,
			inst, invoiceID, head,
			fmt.Sprintf("Brought forward from %s (%s)", c.invoiceNo, c.yearName), c.balance); err != nil {
			return 0, fmt.Errorf("arrears line for %s: %w", c.invoiceNo, err)
		}
		// Nobody collected this: it is the year turning, not a cashier.
		// collected_by is left empty rather than named, so the adjustment
		// does not appear in anybody's cash-in-hand.
		var paymentID uuid.UUID
		if err := tx.QueryRow(ctx, `
			INSERT INTO payments (institution_id, campus_id, student_id, amount_paise, mode,
			                      paid_on, status, remarks)
			VALUES ($1, $2, $3, $4, 'adjustment', CURRENT_DATE, 'success', $5)
			RETURNING id`,
			inst, campus, student, c.balance,
			"Carried forward to "+invoiceNo).Scan(&paymentID); err != nil {
			return 0, fmt.Errorf("settle %s by carry: %w", c.invoiceNo, err)
		}
		// The allocation is what closes the old invoice: the sync triggers
		// on payment_allocations write paid_paise and status from it.
		if _, err := tx.Exec(ctx, `
			INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise)
			VALUES ($1, $2, $3, $4)`, inst, paymentID, c.id, c.balance); err != nil {
			return 0, fmt.Errorf("allocate carry to %s: %w", c.invoiceNo, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO invoice_carry_forwards (institution_id, from_invoice_id, to_invoice_id, payment_id, amount_paise)
			VALUES ($1, $2, $3, $4, $5)`, inst, c.id, invoiceID, paymentID, c.balance); err != nil {
			return 0, fmt.Errorf("record carry of %s: %w", c.invoiceNo, err)
		}
		moved += c.balance
	}
	return moved, nil
}
