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
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrNothingToAllocate = errors.New("payment exceeds the student's outstanding balance")
	ErrInvoiceNotFound   = errors.New("invoice not found for this student")
	ErrOverAllocated     = errors.New("allocation exceeds the invoice balance")
)

// Number is one allocation from a numbering series.
//
// Seq and FY are carried separately from the rendered Text because the
// compliance question — is this year's series gapless and never reused — is
// about the pair, and answering it by parsing 'RCPT/2026-27/00042' breaks the
// first time a school changes its prefix.
type Number struct {
	Text string
	Seq  int64
	FY   string // "2026-27", empty when the series does not reset yearly
}

// NextNumber allocates the next value in a numbering series.
//
// Uses the current moment in India. Prefer NextNumberOn where the caller
// already knows the date the document bears, so a receipt back-dated across
// 1 April lands in the right year's series.
func NextNumber(ctx context.Context, tx pgx.Tx, instID uuid.UUID, kind string) (string, error) {
	n, err := NextNumberOn(ctx, tx, instID, kind, NowInIndia())
	return n.Text, err
}

/*
NextNumberOn allocates the next number in a series, for a document dated on.

	The row lock is the whole point: SELECT ... FOR UPDATE serialises concurrent
	cashiers on this one row for the remainder of the transaction, so the series
	cannot fork. Reading next_value and updating it in two statements without
	the lock is the classic way to issue receipt 00042 twice.

	A sequence would be the obvious alternative and is the wrong tool. nextval
	is deliberately non-transactional: a payment that fails after drawing a
	number leaves that number unused, and under GST an auditor reads a missing
	receipt number as a suppressed sale. The row lock rolls back with everything
	else, so the series stays gapless as well as unique.

	The financial-year reset is the part that was missing. reset_yearly has been
	on this table since the first migration and nothing read it: the year was
	rendered into the string while the counter ran on, so a school's first
	receipt of 2027-28 came out as RCPT/2027-28/00398. GST requires each year's
	series to restart at 1. current_fy (00045) records which year the counter is
	counting within, and the reset happens here, under the same lock.
*/
func NextNumberOn(ctx context.Context, tx pgx.Tx, instID uuid.UUID, kind string, on time.Time) (Number, error) {
	var (
		prefix, suffix, format string
		currentFY              *string
		padding                int
		next                   int64
		resetYearly            bool
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
		return Number{}, fmt.Errorf("ensure numbering scheme %s: %w", kind, err)
	}

	// FOR UPDATE serialises concurrent cashiers on this one row for the rest of
	// the transaction, so the series cannot fork.
	if err := tx.QueryRow(ctx, `
		SELECT prefix, suffix, padding, next_value, reset_yearly,
		       current_fy, format
		  FROM numbering_schemes
		 WHERE institution_id = $1 AND kind = $2 AND campus_id IS NULL
		 FOR UPDATE`, instID, kind).
		Scan(&prefix, &suffix, &padding, &next, &resetYearly, &currentFY, &format); err != nil {
		return Number{}, fmt.Errorf("lock numbering scheme %s: %w", kind, err)
	}

	out := Number{Seq: next}
	if resetYearly {
		out.FY = FinancialYear(on)
		/* Reset only on a genuine rollover.

		   A NULL current_fy is a counter that predates this column, and its
		   next_value is mid-series with receipts already printed against it.
		   Resetting that to 1 would reissue numbers a parent is holding, which
		   is the one thing a gapless series must never do. So NULL adopts the
		   year at the current count, and the first real reset happens at the
		   next 1 April. */
		if currentFY != nil && *currentFY != "" && *currentFY != out.FY {
			out.Seq = 1
		}
	}

	out.Text = renderNumber(format, prefix, out.FY, out.Seq, padding, suffix)

	if _, err := tx.Exec(ctx, `
		UPDATE numbering_schemes
		   SET next_value = $3 + 1, current_fy = NULLIF($4,''),
		       last_number = $5, last_issued_at = now(), updated_at = now()
		 WHERE institution_id = $1 AND kind = $2 AND campus_id IS NULL`,
		instID, kind, out.Seq, out.FY, out.Text); err != nil {
		return Number{}, fmt.Errorf("advance numbering scheme %s: %w", kind, err)
	}
	return out, nil
}

/*
renderNumber lays a sequence into the school's chosen shape.

	Placeholders are {prefix} {fy} {seq} {suffix}. The shape is data because a
	school that has printed SRV/2026-27/00001 on a year of receipts cannot be
	moved to another format by a release — the series would appear to restart,
	and under GST an apparent restart is an apparent duplicate.

	When the series does not reset yearly there is no year to insert, so the
	separator that would have followed it is removed too. Substituting an empty
	string and leaving 'INV//00001' behind is the kind of defect that only shows
	up on a printed document.
*/
func renderNumber(format, prefix, fy string, seq int64, padding int, suffix string) string {
	if format == "" {
		format = "{prefix}{fy}/{seq}{suffix}"
	}
	if fy == "" {
		for _, dangling := range []string{"{fy}/", "{fy}-", "/{fy}", "-{fy}"} {
			format = strings.ReplaceAll(format, dangling, "")
		}
	}
	return strings.NewReplacer(
		"{prefix}", prefix,
		"{fy}", fy,
		"{seq}", fmt.Sprintf("%0*d", padding, seq),
		"{suffix}", suffix,
	).Replace(format)
}

// NowInIndia is the current moment in the only timezone this product has.
//
// Duplicated from internal/api rather than imported: internal/api already
// depends on this package, so importing it back would be a cycle. The rule it
// encodes — a box running UTC rolls into tomorrow at half past five in the
// evening local — matters more here than anywhere, because getting it wrong
// across 1 April puts a receipt in the wrong year's statutory series.
func NowInIndia() time.Time {
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		loc = time.FixedZone("IST", 5*3600+1800)
	}
	return time.Now().In(loc)
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
	PaymentID uuid.UUID
	ReceiptNo string
	// The sequence and financial year behind ReceiptNo. Kept apart from the
	// rendered string so the GST series can be audited for gaps without
	// parsing a format the school is free to change.
	ReceiptSeq  int64
	ReceiptFY   string
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

	// Dated by the payment, not by the clock: a receipt written up on 2 April
	// for money taken on 31 March belongs to the closing year's series.
	number, err := NextNumberOn(ctx, tx, req.InstitutionID, "receipt", req.PaidOn)
	if err != nil {
		return nil, err
	}

	var paymentID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO payments (institution_id, campus_id, student_id, receipt_no,
		                      receipt_seq, receipt_fy,
		                      amount_paise, mode, paid_on, reference_no, bank_name,
		                      cheque_date, status, collected_by, remarks)
		VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9,$10,$11,$12,$13,$14,$15)
		RETURNING id`,
		req.InstitutionID, req.CampusID, req.StudentID, number.Text,
		number.Seq, number.FY,
		req.AmountPaise, req.Mode, req.PaidOn, nullText(req.ReferenceNo),
		nullText(req.BankName), req.ChequeDate, status, nullUUID(req.CollectedBy),
		nullText(req.Remarks)).Scan(&paymentID); err != nil {
		return nil, fmt.Errorf("record payment: %w", err)
	}

	receipt := &Receipt{
		PaymentID:   paymentID,
		ReceiptNo:   number.Text,
		ReceiptSeq:  number.Seq,
		ReceiptFY:   number.FY,
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
//
// Kept as the narrow, positional form for callers that hold loose values rather
// than a rule row. It delegates to AssessFine so there is exactly one
// implementation of the arithmetic: two fine calculators that disagree by a
// rupee is a dispute the school cannot settle. Use EvaluateFines for anything
// that needs targeting, exemptions, compounding or the working.
func FineFor(kind string, gracedays int, amountPaise int64, percent float64,
	capPaise *int64, dueOn time.Time, asOf time.Time, balancePaise int64) int64 {

	due := dueOn
	a := AssessFine(
		FineSubject{DueOn: &due, BalancePaise: balancePaise},
		FineRule{
			Kind: kind, GraceDays: gracedays, AmountPaise: amountPaise,
			Percent: percent, CapPaise: capPaise, Compound: "none",
		},
		asOf,
	)
	return a.AmountPaise
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
