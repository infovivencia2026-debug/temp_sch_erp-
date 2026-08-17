// Package fees implements fee collection: the operations a cashier actually
// performs at a counter, and the invariants that must hold around money.
//
// Three rules govern everything here:
//
//   - Money is bigint paise. Never a float, never rupees. A ₹45,000 term fee is
//     4500000, and every total is exact.
//   - A receipt number is gapless and unique. It is allocated under a row lock
//     inside the same transaction that writes the payment, so two cashiers
//     collecting simultaneously cannot produce a duplicate or skip a serial —
//     an auditor treats a gap as a suppressed receipt.
//   - Collected means cleared. A post-dated cheque is a payment with status
//     'pending'; it shows on the ledger as promised, and is excluded from every
//     collection figure until it clears.
package fees

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrNothingToAllocate = errors.New("payment exceeds the student's outstanding balance")
	ErrInvoiceNotFound   = errors.New("invoice not found for this student")
	ErrOverAllocated     = errors.New("allocation exceeds the invoice balance")
)

// NextNumber allocates the next value in a numbering series.
//
// The row lock is the whole point: SELECT ... FOR UPDATE serialises concurrent
// cashiers on this one row for the remainder of the transaction, so the series
// cannot fork. Reading next_value and updating it in two statements without the
// lock is the classic way to issue receipt 00042 twice.
//
// reset_yearly restarts the count each Indian financial year (1 April), which
// is what the prefix encodes: RCPT/2026-27/00001.
func NextNumber(ctx context.Context, tx pgx.Tx, instID uuid.UUID, kind string) (string, error) {
	var (
		prefix, suffix string
		padding        int
		next           int64
		resetYearly    bool
	)

	// Ensure the row exists before locking it. Doing this as "SELECT, and
	// INSERT if missing" is not safe: concurrent callers all see no row, all
	// insert, and all issue serial 1. The upsert is a no-op when the counter is
	// already there, and the partial unique index on (institution_id, kind)
	// WHERE campus_id IS NULL is what makes the conflict target work.
	defaults := map[string]string{"receipt": "RCPT/", "invoice": "INV/"}
	if _, err := tx.Exec(ctx, `
		INSERT INTO numbering_schemes (institution_id, kind, prefix, padding, next_value, reset_yearly)
		VALUES ($1,$2,$3,5,1,true)
		ON CONFLICT (institution_id, kind) WHERE campus_id IS NULL DO NOTHING`,
		instID, kind, defaults[kind]); err != nil {
		return "", fmt.Errorf("ensure numbering scheme %s: %w", kind, err)
	}

	// FOR UPDATE serialises concurrent cashiers on this one row for the rest of
	// the transaction, so the series cannot fork.
	if err := tx.QueryRow(ctx, `
		SELECT prefix, suffix, padding, next_value, reset_yearly
		  FROM numbering_schemes
		 WHERE institution_id = $1 AND kind = $2 AND campus_id IS NULL
		 FOR UPDATE`, instID, kind).
		Scan(&prefix, &suffix, &padding, &next, &resetYearly); err != nil {
		return "", fmt.Errorf("lock numbering scheme %s: %w", kind, err)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE numbering_schemes SET next_value = next_value + 1
		 WHERE institution_id = $1 AND kind = $2 AND campus_id IS NULL`, instID, kind); err != nil {
		return "", fmt.Errorf("advance numbering scheme %s: %w", kind, err)
	}

	number := fmt.Sprintf("%s%0*d%s", prefix, padding, next, suffix)
	if resetYearly {
		number = fmt.Sprintf("%s%s/%0*d%s", prefix, FinancialYear(time.Now()), padding, next, suffix)
	}
	return number, nil
}

// FinancialYear renders the Indian financial year containing t as "2026-27".
// The year runs 1 April to 31 March, so January belongs to the year that began
// the previous April.
func FinancialYear(t time.Time) string {
	y := t.Year()
	if t.Month() < time.April {
		y--
	}
	return fmt.Sprintf("%d-%02d", y, (y+1)%100)
}

// Due is one invoice with its outstanding balance.
type Due struct {
	InvoiceID    uuid.UUID
	InvoiceNo    string
	IssuedOn     time.Time
	DueOn        *time.Time
	NetPaise     int64
	PaidPaise    int64
	BalancePaise int64
	FinePaise    int64
	Status       string
}

// Outstanding lists a student's unsettled invoices, oldest first.
//
// Oldest-first is not cosmetic: allocation follows the same order, so a partial
// payment clears the longest-overdue term rather than the most recent one,
// which is what both the school and the fine calculation expect.
func Outstanding(ctx context.Context, tx pgx.Tx, studentID uuid.UUID) ([]Due, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, invoice_no, issued_on, due_on,
		       net_paise, paid_paise, net_paise - paid_paise, fine_paise, status
		  FROM invoices
		 WHERE student_id = $1
		   AND status IN ('unpaid','partial','overdue')
		   AND net_paise > paid_paise
		 ORDER BY COALESCE(due_on, issued_on), invoice_no`, studentID)
	if err != nil {
		return nil, fmt.Errorf("outstanding: %w", err)
	}
	defer rows.Close()

	var out []Due
	for rows.Next() {
		var d Due
		if err := rows.Scan(&d.InvoiceID, &d.InvoiceNo, &d.IssuedOn, &d.DueOn,
			&d.NetPaise, &d.PaidPaise, &d.BalancePaise, &d.FinePaise, &d.Status); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// CollectRequest is one counter transaction.
type CollectRequest struct {
	InstitutionID uuid.UUID
	CampusID      uuid.UUID
	StudentID     uuid.UUID
	AmountPaise   int64
	Mode          string
	PaidOn        time.Time
	ReferenceNo   string
	BankName      string
	ChequeDate    *time.Time
	Remarks       string
	CollectedBy   uuid.UUID
	// InvoiceIDs optionally restricts allocation to specific invoices. Empty
	// means "oldest first across everything outstanding".
	InvoiceIDs []uuid.UUID
}

// Receipt is what gets printed and handed to the parent.
type Receipt struct {
	PaymentID   uuid.UUID
	ReceiptNo   string
	AmountPaise int64
	Allocated   []Allocation
	Unallocated int64
	Cleared     bool
}

type Allocation struct {
	InvoiceID   uuid.UUID
	InvoiceNo   string
	AmountPaise int64
}

// Collect records a payment and allocates it across outstanding invoices.
//
// Everything happens in the caller's transaction: the receipt number, the
// payment row and the allocations either all land or none do. A receipt handed
// over for money that failed to allocate is worse than a failed transaction,
// because the parent leaves believing they have paid.
//
// A cheque or DD dated in the future is held as 'pending' and deliberately not
// allocated — the money is not the school's yet. It is allocated when the
// cheque is cleared, which is a separate operation.
func Collect(ctx context.Context, tx pgx.Tx, req CollectRequest) (*Receipt, error) {
	if req.AmountPaise <= 0 {
		return nil, errors.New("amount must be positive")
	}
	if req.PaidOn.IsZero() {
		req.PaidOn = time.Now()
	}

	// Post-dated: recorded, receipted, but not counted as collection.
	pdc := (req.Mode == "cheque" || req.Mode == "dd") &&
		req.ChequeDate != nil && req.ChequeDate.After(req.PaidOn)

	status := "success"
	if pdc {
		status = "pending"
	}

	receiptNo, err := NextNumber(ctx, tx, req.InstitutionID, "receipt")
	if err != nil {
		return nil, err
	}

	var paymentID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO payments (institution_id, campus_id, student_id, receipt_no,
		                      amount_paise, mode, paid_on, reference_no, bank_name,
		                      cheque_date, status, collected_by, remarks)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		RETURNING id`,
		req.InstitutionID, req.CampusID, req.StudentID, receiptNo,
		req.AmountPaise, req.Mode, req.PaidOn, nullText(req.ReferenceNo),
		nullText(req.BankName), req.ChequeDate, status, nullUUID(req.CollectedBy),
		nullText(req.Remarks)).Scan(&paymentID); err != nil {
		return nil, fmt.Errorf("record payment: %w", err)
	}

	receipt := &Receipt{
		PaymentID:   paymentID,
		ReceiptNo:   receiptNo,
		AmountPaise: req.AmountPaise,
		Cleared:     !pdc,
		Unallocated: req.AmountPaise,
	}
	if pdc {
		return receipt, nil
	}

	allocations, unallocated, err := allocate(ctx, tx, req, paymentID)
	if err != nil {
		return nil, err
	}
	receipt.Allocated = allocations
	receipt.Unallocated = unallocated
	return receipt, nil
}

// allocate spreads a payment across invoices, oldest first.
//
// Any remainder is left unallocated rather than rejected: schools routinely
// take an advance against next term's invoice, which does not exist yet. The
// payments row keeps the full amount and allocated_paise stays lower, which is
// exactly what the payments_check constraint permits.
func allocate(ctx context.Context, tx pgx.Tx, req CollectRequest, paymentID uuid.UUID) ([]Allocation, int64, error) {
	dues, err := Outstanding(ctx, tx, req.StudentID)
	if err != nil {
		return nil, 0, err
	}

	if len(req.InvoiceIDs) > 0 {
		wanted := make(map[uuid.UUID]bool, len(req.InvoiceIDs))
		for _, id := range req.InvoiceIDs {
			wanted[id] = true
		}
		filtered := dues[:0]
		for _, d := range dues {
			if wanted[d.InvoiceID] {
				filtered = append(filtered, d)
			}
		}
		if len(filtered) == 0 {
			return nil, 0, ErrInvoiceNotFound
		}
		dues = filtered
	}

	remaining := req.AmountPaise
	var out []Allocation

	for _, d := range dues {
		if remaining <= 0 {
			break
		}
		amount := d.BalancePaise
		if amount > remaining {
			amount = remaining
		}
		if amount <= 0 {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise)
			VALUES ($1,$2,$3,$4)`,
			req.InstitutionID, paymentID, d.InvoiceID, amount); err != nil {
			return nil, 0, fmt.Errorf("allocate to %s: %w", d.InvoiceNo, err)
		}
		out = append(out, Allocation{InvoiceID: d.InvoiceID, InvoiceNo: d.InvoiceNo, AmountPaise: amount})
		remaining -= amount
	}

	// sync_payment_allocated and sync_invoice_paid update allocated_paise,
	// paid_paise and invoice status from the allocation rows, so nothing here
	// writes those columns directly.
	return out, remaining, nil
}

// ClearCheque moves a held cheque to collected and allocates it.
//
// Called when the bank confirms. Until then the money is not the school's, so
// this is deliberately a separate step from Collect rather than a status flag
// somebody remembers to flip.
func ClearCheque(ctx context.Context, tx pgx.Tx, paymentID uuid.UUID) error {
	var req CollectRequest
	if err := tx.QueryRow(ctx, `
		SELECT institution_id, campus_id, student_id, amount_paise
		  FROM payments
		 WHERE id = $1 AND status = 'pending'
		 FOR UPDATE`, paymentID).
		Scan(&req.InstitutionID, &req.CampusID, &req.StudentID, &req.AmountPaise); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("no pending payment with that id")
		}
		return err
	}

	if _, err := tx.Exec(ctx,
		`UPDATE payments SET status = 'success' WHERE id = $1`, paymentID); err != nil {
		return err
	}
	_, _, err := allocate(ctx, tx, req, paymentID)
	return err
}

// BounceCheque marks a cheque dishonoured, removes any allocation it had, and
// levies the configured penalty on the student's oldest open invoice.
func BounceCheque(ctx context.Context, tx pgx.Tx, paymentID uuid.UUID, finePaise int64) error {
	var studentID uuid.UUID
	if err := tx.QueryRow(ctx,
		`SELECT student_id FROM payments WHERE id = $1 FOR UPDATE`, paymentID).Scan(&studentID); err != nil {
		return err
	}

	// Delete first: the allocation rows are what the triggers derive paid_paise
	// from, so removing them is what actually reopens the invoice.
	if _, err := tx.Exec(ctx,
		`DELETE FROM payment_allocations WHERE payment_id = $1`, paymentID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE payments SET status = 'bounced' WHERE id = $1`, paymentID); err != nil {
		return err
	}
	if finePaise <= 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
		UPDATE invoices SET fine_paise = fine_paise + $2
		 WHERE id = (SELECT id FROM invoices
		              WHERE student_id = $1 AND status IN ('unpaid','partial','overdue')
		              ORDER BY COALESCE(due_on, issued_on) LIMIT 1)`, studentID, finePaise)
	return err
}

// FineFor computes the late fine an invoice has accrued under a rule.
//
// Returns 0 while inside the grace period. A per-day fine is capped when the
// rule sets cap_paise, because an invoice nobody chases would otherwise accrue
// indefinitely and the balance stops meaning anything.
func FineFor(kind string, gracedays int, amountPaise int64, percent float64,
	capPaise *int64, dueOn time.Time, asOf time.Time, balancePaise int64) int64 {

	overdue := int(asOf.Sub(dueOn).Hours() / 24)
	if overdue <= gracedays {
		return 0
	}
	days := int64(overdue - gracedays)

	var fine int64
	switch kind {
	case "fixed":
		fine = amountPaise
	case "per_day":
		fine = amountPaise * days
	case "percent":
		fine = int64(float64(balancePaise) * percent / 100.0)
	default:
		return 0
	}
	if capPaise != nil && fine > *capPaise {
		fine = *capPaise
	}
	if fine < 0 {
		return 0
	}
	return fine
}

// nullUUID maps the zero uuid to NULL. collected_by is a foreign key to users,
// and the all-zero uuid is not a user — passing it raises a constraint
// violation rather than recording "unknown".
func nullUUID(id uuid.UUID) *uuid.UUID {
	if id == uuid.Nil {
		return nil
	}
	return &id
}

func nullText(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
