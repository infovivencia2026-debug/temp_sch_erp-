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

// The fee engine: versioned structures, and the receipt series GST asks about.
//
// These drive the package against a real database because the guarantees are
// enforced by Postgres — a row lock, a partial unique index over a COALESCE —
// and a fake would only prove the fake works.

/*
The series must be gapless, unique and per-year, under concurrent cashiers.

	Twenty-five simultaneous collections must produce sequences 1..25 with no
	duplicate and no hole. A duplicate is two parents holding the same receipt
	number; a hole is what an auditor reads as a suppressed receipt. This
	asserts on receipt_seq rather than on the rendered string, because the
	string is a format the school may change and the sequence is the fact the
	compliance question is actually about.
*/
func TestReceiptSeriesIsGaplessAndUniqueUnderConcurrency(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, _ := feeFixture(t, db)

	const n = 25
	students := make([]uuid.UUID, n)
	for i := range students {
		students[i] = newStudent(t, db, inst, campus, uuid.NewString()[:8], "Payer")
		invoice(t, db, inst, campus, year, students[i], "INV-"+uuid.NewString()[:8], 500000, 7)
	}

	var wg sync.WaitGroup
	errs := make(chan error, n)
	seqs := make(chan int64, n)

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
					seqs <- rec.ReceiptSeq
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
	close(seqs)

	for err := range errs {
		t.Fatalf("concurrent collect: %v", err)
	}

	seen := map[int64]bool{}
	for s := range seqs {
		if seen[s] {
			t.Errorf("sequence %d issued twice", s)
		}
		seen[s] = true
	}
	if len(seen) != n {
		t.Fatalf("issued %d distinct sequences, want %d", len(seen), n)
	}
	// Gapless: exactly 1..n, nothing skipped.
	for i := int64(1); i <= n; i++ {
		if !seen[i] {
			t.Errorf("gap in the series: sequence %d was never issued", i)
		}
	}

	// And the database agrees, through the index that enforces it.
	var distinct, maxSeq, minSeq int64
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT count(DISTINCT receipt_seq), COALESCE(max(receipt_seq),0), COALESCE(min(receipt_seq),0)
			  FROM payments
			 WHERE institution_id = $1 AND receipt_seq IS NOT NULL`, inst).
			Scan(&distinct, &maxSeq, &minSeq)
	}); err != nil {
		t.Fatalf("read series: %v", err)
	}
	if distinct != n || minSeq != 1 || maxSeq != n {
		t.Errorf("stored series is %d rows spanning %d..%d, want %d spanning 1..%d",
			distinct, minSeq, maxSeq, n, n)
	}
}

/*
The same sequence must not be reusable within a financial year.

	The unique index COALESCEs receipt_fy because it is nullable, which is the
	trap this codebase keeps falling into: bare, the index would enforce nothing
	for exactly the rows written while a year rollover is being got wrong.
*/
func TestReceiptSequenceCannotBeReusedWithinAYear(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, student := feeFixture(t, db)
	invoice(t, db, inst, campus, year, student, "INV-DUP", 500000, 7)

	var fy string
	var seq int64
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		rec, err := fees.Collect(ctx, tx, fees.CollectRequest{
			InstitutionID: inst, CampusID: campus, StudentID: student,
			AmountPaise: 100000, Mode: "cash", PaidOn: time.Now(),
		})
		if err != nil {
			return err
		}
		fy, seq = rec.ReceiptFY, rec.ReceiptSeq
		return nil
	}); err != nil {
		t.Fatalf("first collect: %v", err)
	}

	// Forcing the same (year, sequence) in must be refused by the index.
	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO payments (institution_id, campus_id, student_id, receipt_no,
			                      receipt_seq, receipt_fy, amount_paise, mode, status)
			VALUES ($1,$2,$3,'FORGED',$4,$5,100,'cash','success')`,
			inst, campus, student, seq, fy)
		return err
	})
	if err == nil {
		t.Fatal("reusing a receipt sequence within the year was allowed; the series is not unique")
	}
}

/*
The counter restarts at 1 in a new financial year, and not before.

	reset_yearly has been on numbering_schemes since the first migration and
	nothing read it: the year was rendered into the string while the count ran
	on, so a school's first receipt of the new year continued the old series.
	GST wants each year to start at 1.

	The second half matters as much as the first. A counter that predates
	current_fy is mid-series with receipts already printed against it, so
	adopting the year must NOT reset it — that would reissue numbers parents are
	holding.
*/
func TestReceiptCounterResetsOnlyAtTheFinancialYearBoundary(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, _, _, _ := feeFixture(t, db)

	march := time.Date(2027, time.March, 31, 10, 0, 0, 0, time.UTC)
	april := time.Date(2027, time.April, 1, 10, 0, 0, 0, time.UTC)

	var first, second, third, fourth fees.Number
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		var err error
		if first, err = fees.NextNumberOn(ctx, tx, inst, "receipt", march); err != nil {
			return err
		}
		if second, err = fees.NextNumberOn(ctx, tx, inst, "receipt", march); err != nil {
			return err
		}
		// Over the boundary.
		if third, err = fees.NextNumberOn(ctx, tx, inst, "receipt", april); err != nil {
			return err
		}
		fourth, err = fees.NextNumberOn(ctx, tx, inst, "receipt", april)
		return err
	}); err != nil {
		t.Fatalf("allocate: %v", err)
	}

	if first.FY != "2026-27" || first.Seq != 1 {
		t.Errorf("31 March 2027 should be FY 2026-27 seq 1, got %s seq %d", first.FY, first.Seq)
	}
	if second.Seq != 2 {
		t.Errorf("second draw in the same year should be 2, got %d", second.Seq)
	}
	if third.FY != "2027-28" {
		t.Errorf("1 April 2027 should be FY 2027-28, got %s", third.FY)
	}
	if third.Seq != 1 {
		t.Errorf("the new year must restart at 1, got %d — this is the GST defect", third.Seq)
	}
	if fourth.Seq != 2 {
		t.Errorf("the new year's second receipt should be 2, got %d", fourth.Seq)
	}
	if third.Text == second.Text {
		t.Error("numbers either side of the boundary must differ")
	}
}

// A receipt is numbered by the date the money was taken, not by the clock, so
// a payment written up on 2 April for cash taken on 31 March stays in the
// closing year's series.
func TestReceiptNumberFollowsThePaymentDateNotTheClock(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, student := feeFixture(t, db)
	invoice(t, db, inst, campus, year, student, "INV-BACKDATED", 500000, 7)

	paidOn := time.Date(2027, time.March, 31, 18, 0, 0, 0, time.UTC)
	var rec *fees.Receipt
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		var err error
		rec, err = fees.Collect(ctx, tx, fees.CollectRequest{
			InstitutionID: inst, CampusID: campus, StudentID: student,
			AmountPaise: 100000, Mode: "cash", PaidOn: paidOn,
		})
		return err
	}); err != nil {
		t.Fatalf("collect: %v", err)
	}
	if rec.ReceiptFY != "2026-27" {
		t.Errorf("money taken on 31 March 2027 belongs to FY 2026-27, got %s", rec.ReceiptFY)
	}
}

/*
Exactly one active version per structure per financial year.

	academic_year_id is nullable, so the index has to COALESCE it — the trap
	the contract names. Without that, two active versions coexist and the
	invoice run bills a class two different amounts in one term with nothing in
	the schema objecting.
*/
func TestOnlyOneActiveVersionPerStructureAndYear(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, _ := feeFixture(t, db)

	var structure uuid.UUID
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO fee_structures (institution_id, campus_id, academic_year_id, name, applies_to)
			VALUES ($1,$2,$3,'Class 5 fees','all') RETURNING id`, inst, campus, year).Scan(&structure)
	}); err != nil {
		t.Fatalf("structure: %v", err)
	}

	// 00045 seeds a v1 for structures that exist when it runs; this one was
	// created afterwards, so add its first version here.
	mkVersion := func(no int, status string) error {
		return db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `
				INSERT INTO fee_structure_versions
				    (institution_id, fee_structure_id, academic_year_id, version_no,
				     status, effective_from, activated_at)
				VALUES ($1,$2,NULL,$3,$4,DATE '2026-04-01',
				        CASE WHEN $4 = 'draft' THEN NULL ELSE now() END)`,
				inst, structure, no, status)
			return err
		})
	}

	if err := mkVersion(1, "active"); err != nil {
		t.Fatalf("v1: %v", err)
	}
	// A second active version for the same structure and year must be refused.
	if err := mkVersion(2, "active"); err == nil {
		t.Fatal("a second active version was allowed; the one-active index is not enforcing")
	}
	// A draft alongside it is fine — that is how a revision is prepared.
	if err := mkVersion(2, "draft"); err != nil {
		t.Fatalf("a draft revision must be allowed alongside the active one: %v", err)
	}
	// And so is a superseded one.
	if err := mkVersion(3, "superseded"); err != nil {
		t.Fatalf("a superseded version must be allowed: %v", err)
	}
}

/*
A version an invoice cites cannot be deleted.

	This is the whole guarantee of versioning: ON DELETE RESTRICT means a fee
	revision cannot quietly restate what a parent was already billed.
*/
func TestAVersionCitedByAnInvoiceCannotBeDeleted(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, student := feeFixture(t, db)

	var structure, version uuid.UUID
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO fee_structures (institution_id, campus_id, academic_year_id, name, applies_to)
			VALUES ($1,$2,$3,'Class 6 fees','all') RETURNING id`, inst, campus, year).Scan(&structure); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `
			INSERT INTO fee_structure_versions
			    (institution_id, fee_structure_id, version_no, status, effective_from, activated_at)
			VALUES ($1,$2,1,'active',DATE '2026-04-01',now()) RETURNING id`,
			inst, structure).Scan(&version)
	}); err != nil {
		t.Fatalf("fixture: %v", err)
	}

	inv := invoice(t, db, inst, campus, year, student, "INV-VERSIONED", 4500000, -10)
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE invoices SET fee_structure_version_id = $2 WHERE id = $1`, inv, version)
		return err
	}); err != nil {
		t.Fatalf("pin invoice to version: %v", err)
	}

	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM fee_structure_versions WHERE id = $1`, version)
		return err
	})
	if err == nil {
		t.Fatal("deleted a version an invoice was raised under; history is not protected")
	}
}

/*
A nil invoice filter must mean "every open due", not "none".

	loadFineSubjects narrows with `$2::uuid[] IS NULL OR i.id = ANY($2)`. Preview
	passes nil to mean unfiltered; apply always passes a named list. The
	distinction rests entirely on pgx encoding a nil slice as SQL NULL rather
	than as an empty array — and an empty array makes `= ANY` false for every
	row, so if that ever changed the preview would quietly show nothing at all
	and a school would conclude no fines were due.

	Asserted here because it is a silent, wrong-direction failure: no error, no
	empty-state hint, just an apparently clean fine run.
*/
func TestNilInvoiceFilterMeansEveryDueNotNone(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, campus, year, student := feeFixture(t, db)
	invoice(t, db, inst, campus, year, student, "INV-FILTER", 500000, -30)

	count := func(filter []uuid.UUID) int {
		t.Helper()
		var n int
		if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT count(*)::int FROM invoices i
				 WHERE i.institution_id = $1
				   AND ($2::uuid[] IS NULL OR i.id = ANY($2::uuid[]))`,
				inst, filter).Scan(&n)
		}); err != nil {
			t.Fatalf("count: %v", err)
		}
		return n
	}

	if got := count(nil); got != 1 {
		t.Errorf("nil filter matched %d invoices, want 1 — preview would show nothing", got)
	}
	if got := count([]uuid.UUID{uuid.New()}); got != 0 {
		t.Errorf("a filter naming another invoice matched %d, want 0", got)
	}
}

// Two active fine rules for the same target must be impossible — all three
// targeting columns are nullable and the catch-all rule has all three NULL,
// which is exactly the case a bare unique index would fail to constrain.
func TestOnlyOneActiveFineRulePerTarget(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	inst, _, _, _ := feeFixture(t, db)

	add := func(name string, active bool) error {
		return db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `
				INSERT INTO fee_fine_rules (institution_id, name, kind, grace_days,
				                            amount_paise, is_active)
				VALUES ($1,$2,'per_day',5,5000,$3)`, inst, name, active)
			return err
		})
	}

	if err := add("Standard late fee", true); err != nil {
		t.Fatalf("first rule: %v", err)
	}
	if err := add("Another catch-all", true); err == nil {
		t.Fatal("two active catch-all rules were allowed; a parent would be fined twice")
	}
	// Retiring a rule and replacing it is the normal path and must work.
	if err := add("Superseded policy", false); err != nil {
		t.Fatalf("an inactive rule must be allowed for the audit trail: %v", err)
	}
}
