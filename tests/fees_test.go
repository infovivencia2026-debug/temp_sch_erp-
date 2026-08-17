package tests

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/fees"
)

// Fee module tests. Money has invariants that a read-only endpoint test cannot
// reach, so these drive the package directly against a real database.

func feeFixture(t *testing.T, db *database.DB) (inst, campus, year, student uuid.UUID) {
	t.Helper()
	ctx := context.Background()

	inst = newInstitution(t, db, "Fee Test School")
	campus = newCampus(t, db, inst)

	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO academic_years (institution_id, campus_id, name, starts_on, ends_on, is_current)
			VALUES ($1,$2,'2026-27', DATE '2026-04-01', DATE '2027-03-31', true)
			RETURNING id`, inst, campus).Scan(&year); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `
			INSERT INTO students (institution_id, campus_id, admission_no, first_name, last_name)
			VALUES ($1,$2,'FEE-001','Test','Student') RETURNING id`, inst, campus).Scan(&student)
	})
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	return
}

// invoice raises one invoice due `dueInDays` from today (negative = overdue).
func invoice(t *testing.T, db *database.DB, inst, campus, year, student uuid.UUID,
	no string, grossPaise int64, dueInDays int) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO invoices (institution_id, campus_id, student_id, academic_year_id,
			                      invoice_no, issued_on, due_on, gross_paise, status)
			VALUES ($1,$2,$3,$4,$5, CURRENT_DATE, CURRENT_DATE + $6::int, $7, 'unpaid')
			RETURNING id`, inst, campus, student, year, no, dueInDays, grossPaise).Scan(&id)
	})
	if err != nil {
		t.Fatalf("invoice %s: %v", no, err)
	}
	return id
}

// Receipt numbers must be unique and gapless even when several cashiers collect
// at the same instant. Reading next_value and updating it without a row lock is
// the classic way to issue the same serial twice; an auditor reads a gap as a
// suppressed receipt.
func TestReceiptNumbersAreGaplessUnderConcurrency(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, _ := feeFixture(t, db)

	const n = 25
	students := make([]uuid.UUID, n)
	for i := range students {
		students[i] = newStudent(t, db, inst, campus,
			uuid.NewString()[:8], "Payer")
		invoice(t, db, inst, campus, year, students[i],
			"INV-"+uuid.NewString()[:8], 500000, 7)
	}

	var wg sync.WaitGroup
	errs := make(chan error, n)
	receipts := make(chan string, n)

	for _, sid := range students {
		wg.Add(1)
		go func(sid uuid.UUID) {
			defer wg.Done()
			err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
				rec, err := fees.Collect(ctx, tx, fees.CollectRequest{
					InstitutionID: inst, CampusID: campus, StudentID: sid,
					AmountPaise: 100000, Mode: "cash", PaidOn: time.Now(),
				})
				if err == nil {
					receipts <- rec.ReceiptNo
				}
				return err
			})
			if err != nil {
				errs <- err
			}
		}(sid)
	}
	wg.Wait()
	close(errs)
	close(receipts)

	for err := range errs {
		t.Fatalf("concurrent collect: %v", err)
	}

	seen := map[string]bool{}
	count := 0
	for r := range receipts {
		if seen[r] {
			t.Errorf("duplicate receipt number issued: %s", r)
		}
		seen[r] = true
		count++
	}
	if count != n {
		t.Fatalf("issued %d receipts, want %d", count, n)
	}

	// The counter must have advanced by exactly n — no gaps, no reuse.
	var next int64
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT next_value FROM numbering_schemes WHERE institution_id=$1 AND kind='receipt'`,
			inst).Scan(&next)
	}); err != nil {
		t.Fatalf("read counter: %v", err)
	}
	if next != int64(n+1) {
		t.Errorf("counter at %d after %d receipts, want %d", next, n, n+1)
	}
	t.Logf("%d concurrent collections, %d distinct receipts, counter at %d", n, len(seen), next)
}

// A partial payment must clear the longest-overdue invoice first, not the most
// recent one.
func TestAllocationIsOldestFirst(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, student := feeFixture(t, db)

	old := invoice(t, db, inst, campus, year, student, "INV-OLD", 300000, -60)
	mid := invoice(t, db, inst, campus, year, student, "INV-MID", 300000, -30)
	newer := invoice(t, db, inst, campus, year, student, "INV-NEW", 300000, 30)

	// ₹4,500 against ₹9,000 of dues: should fully clear the oldest and part-pay
	// the middle, leaving the newest untouched.
	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, err := fees.Collect(ctx, tx, fees.CollectRequest{
			InstitutionID: inst, CampusID: campus, StudentID: student,
			AmountPaise: 450000, Mode: "cash", PaidOn: time.Now(),
		})
		return err
	})
	if err != nil {
		t.Fatalf("collect: %v", err)
	}

	paid := map[uuid.UUID]int64{}
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT id, paid_paise FROM invoices WHERE student_id = $1`, student)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			var p int64
			if err := rows.Scan(&id, &p); err != nil {
				return err
			}
			paid[id] = p
		}
		return rows.Err()
	}); err != nil {
		t.Fatalf("read invoices: %v", err)
	}

	if paid[old] != 300000 {
		t.Errorf("oldest invoice paid %d, want fully paid 300000", paid[old])
	}
	if paid[mid] != 150000 {
		t.Errorf("middle invoice paid %d, want the 150000 remainder", paid[mid])
	}
	if paid[newer] != 0 {
		t.Errorf("newest invoice paid %d, want 0 — it is not due yet", paid[newer])
	}
}

// Schools take advances against terms that have not been invoiced. The surplus
// must stay on the payment as unallocated rather than being refused.
func TestAdvancePaymentIsHeldUnallocated(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, student := feeFixture(t, db)
	invoice(t, db, inst, campus, year, student, "INV-ONLY", 200000, 7)

	var rec *fees.Receipt
	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		var err error
		rec, err = fees.Collect(ctx, tx, fees.CollectRequest{
			InstitutionID: inst, CampusID: campus, StudentID: student,
			AmountPaise: 500000, Mode: "upi", PaidOn: time.Now(),
		})
		return err
	})
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if rec.Unallocated != 300000 {
		t.Errorf("unallocated %d, want the 300000 advance", rec.Unallocated)
	}

	// payments_check enforces allocated_paise <= amount_paise; the advance must
	// not have violated it.
	var amount, allocated int64
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT amount_paise, allocated_paise FROM payments WHERE id = $1`,
			rec.PaymentID).Scan(&amount, &allocated)
	}); err != nil {
		t.Fatalf("read payment: %v", err)
	}
	if amount != 500000 || allocated != 200000 {
		t.Errorf("payment amount=%d allocated=%d, want 500000/200000", amount, allocated)
	}
}

// A post-dated cheque is promised money, not collected money. It must be
// receipted, visible on the ledger, and excluded from collection until cleared.
func TestPostDatedChequeIsNotCollection(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, student := feeFixture(t, db)
	invoice(t, db, inst, campus, year, student, "INV-PDC", 400000, 7)

	future := time.Now().AddDate(0, 2, 0)
	var rec *fees.Receipt
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		var err error
		rec, err = fees.Collect(ctx, tx, fees.CollectRequest{
			InstitutionID: inst, CampusID: campus, StudentID: student,
			AmountPaise: 400000, Mode: "cheque", PaidOn: time.Now(),
			ReferenceNo: "556677", ChequeDate: &future,
		})
		return err
	}); err != nil {
		t.Fatalf("collect pdc: %v", err)
	}

	if rec.Cleared {
		t.Error("a post-dated cheque must not be reported as cleared")
	}
	if len(rec.Allocated) != 0 {
		t.Errorf("post-dated cheque allocated %d invoices, want 0", len(rec.Allocated))
	}
	if rec.ReceiptNo == "" {
		t.Error("a held cheque must still produce a receipt")
	}

	assertInvoiceUnpaid := func(when string) {
		t.Helper()
		var paid int64
		var status string
		if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx,
				`SELECT paid_paise, status FROM invoices WHERE student_id = $1`, student).
				Scan(&paid, &status)
		}); err != nil {
			t.Fatalf("read invoice: %v", err)
		}
		if paid != 0 {
			t.Errorf("%s: invoice shows %d paid from an uncleared cheque", when, paid)
		}
	}
	assertInvoiceUnpaid("while held")

	// Clearing it turns promised money into collected money.
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return fees.ClearCheque(ctx, tx, rec.PaymentID)
	}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	var paid int64
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT paid_paise FROM invoices WHERE student_id = $1`, student).Scan(&paid)
	}); err != nil {
		t.Fatalf("read invoice: %v", err)
	}
	if paid != 400000 {
		t.Errorf("after clearing, invoice paid %d, want 400000", paid)
	}
}

// A dishonoured cheque must reopen the invoice and levy the penalty.
func TestBouncedChequeReopensInvoiceAndFines(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, student := feeFixture(t, db)
	invoice(t, db, inst, campus, year, student, "INV-BNC", 400000, -5)

	var rec *fees.Receipt
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		var err error
		rec, err = fees.Collect(ctx, tx, fees.CollectRequest{
			InstitutionID: inst, CampusID: campus, StudentID: student,
			AmountPaise: 400000, Mode: "cheque", PaidOn: time.Now(), ReferenceNo: "998877",
		})
		return err
	}); err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(rec.Allocated) == 0 {
		t.Fatal("a same-day cheque should allocate immediately")
	}

	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return fees.BounceCheque(ctx, tx, rec.PaymentID, 50000)
	}); err != nil {
		t.Fatalf("bounce: %v", err)
	}

	var paid, fine int64
	var status, payStatus string
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`SELECT paid_paise, fine_paise, status FROM invoices WHERE student_id = $1`,
			student).Scan(&paid, &fine, &status); err != nil {
			return err
		}
		return tx.QueryRow(ctx,
			`SELECT status FROM payments WHERE id = $1`, rec.PaymentID).Scan(&payStatus)
	}); err != nil {
		t.Fatalf("read back: %v", err)
	}

	if paid != 0 {
		t.Errorf("invoice still shows %d paid after the cheque bounced", paid)
	}
	if fine != 50000 {
		t.Errorf("bounce fine %d, want 50000", fine)
	}
	if payStatus != "bounced" {
		t.Errorf("payment status %q, want bounced", payStatus)
	}
	if status == "paid" {
		t.Error("invoice must not remain paid after a dishonoured cheque")
	}
}

// Late fines: no charge inside grace, per-day accrues, and the cap holds.
func TestLateFineRules(t *testing.T) {
	due := time.Now().AddDate(0, 0, -40)
	now := time.Now()

	if got := fees.FineFor("per_day", 45, 1000, 0, nil, due, now, 500000); got != 0 {
		t.Errorf("inside grace: got %d, want 0", got)
	}
	// 40 days overdue, 5 grace -> 35 chargeable days at ₹10.
	if got := fees.FineFor("per_day", 5, 1000, 0, nil, due, now, 500000); got != 35000 {
		t.Errorf("per_day: got %d, want 35000", got)
	}
	cap := int64(20000)
	if got := fees.FineFor("per_day", 5, 1000, 0, &cap, due, now, 500000); got != 20000 {
		t.Errorf("capped per_day: got %d, want the 20000 cap", got)
	}
	if got := fees.FineFor("fixed", 5, 25000, 0, nil, due, now, 500000); got != 25000 {
		t.Errorf("fixed: got %d, want 25000", got)
	}
	if got := fees.FineFor("percent", 5, 0, 2, nil, due, now, 500000); got != 10000 {
		t.Errorf("percent: 2%% of 500000 should be 10000, got %d", got)
	}
}
