package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The seams where fees did not join up.

	Each of these was a fact the product recorded and then never read where the
	money is raised: the bus fare on the allocation, last year's unpaid
	balance, the committee's approved amount, and a refund that could be
	listed but never created. What is asserted here is the join, end to end,
	through the handlers -- because every one of these gaps was invisible in
	the source. The allocation code was correct, the invoice code was correct,
	and the child still got the wrong bill.

	Guarded on ERP_TEST_DATABASE_URL like every other database-backed test in
	this package.
*/

type feesWorld struct {
	inst, campus, year, class, section uuid.UUID
	tuition                            uuid.UUID
	db                                 *database.DB
	s                                  *Server
}

func seedFeesWorld(t *testing.T, db *database.DB) *feesWorld {
	t.Helper()
	ctx := context.Background()
	w := &feesWorld{
		inst: uuid.New(), campus: uuid.New(), year: uuid.New(),
		class: uuid.New(), section: uuid.New(), tuition: uuid.New(), db: db,
	}
	suffix := w.inst.String()[:8]
	err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		for _, q := range []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO institutions (id, name, short_name, slug, timezone, status)
			  VALUES ($1, $2, 'FEE', $3, 'Asia/Kolkata', 'active')`,
				[]any{w.inst, "Fees " + suffix, "fee-" + suffix}},
			{`INSERT INTO campuses (id, institution_id, name, code) VALUES ($1,$2,'Main',$3)`,
				[]any{w.campus, w.inst, "MAIN-" + suffix}},
			{`INSERT INTO academic_years (id, institution_id, name, starts_on, ends_on, is_current)
			  VALUES ($1,$2,'This year', CURRENT_DATE - 30, CURRENT_DATE + 300, true)`,
				[]any{w.year, w.inst}},
			{`INSERT INTO classes (id, institution_id, campus_id, name, level) VALUES ($1,$2,$3,'Class 6',6)`,
				[]any{w.class, w.inst, w.campus}},
			{`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name)
			  VALUES ($1,$2,$3,$4,$5,'A')`,
				[]any{w.section, w.inst, w.campus, w.class, w.year}},
			{`INSERT INTO fee_heads (id, institution_id, name, code) VALUES ($1,$2,'Tuition','TUITION')`,
				[]any{w.tuition, w.inst}},
		} {
			if _, err := tx.Exec(ctx, q.sql, q.args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed world: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(),
				`DELETE FROM institutions WHERE id = $1`, w.inst)
			return err
		})
	})
	w.s = &Server{DB: db, Hasher: auth.NewHasher("test-pepper"), BaseURL: "https://school.test"}
	return w
}

func (w *feesWorld) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	err := w.db.InTenant(context.Background(), database.Scope{InstitutionID: w.inst},
		func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), sql, args...)
			return err
		})
	if err != nil {
		t.Fatalf("exec %q: %v", strings.Fields(sql)[0]+" "+strings.Fields(sql)[1]+" "+strings.Fields(sql)[2], err)
	}
}

func (w *feesWorld) scan(t *testing.T, sql string, dest []any, args ...any) {
	t.Helper()
	err := w.db.InTenant(context.Background(), database.Scope{InstitutionID: w.inst},
		func(tx pgx.Tx) error {
			return tx.QueryRow(context.Background(), sql, args...).Scan(dest...)
		})
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
}

// student enrols one child in the class for this year.
func (w *feesWorld) student(t *testing.T, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	w.exec(t, `INSERT INTO students (id, institution_id, campus_id, admission_no, first_name)
	           VALUES ($1,$2,$3,$4,$5)`, id, w.inst, w.campus, "ADM-"+id.String()[:8], name)
	w.exec(t, `INSERT INTO enrollments (institution_id, student_id, academic_year_id, class_id, section_id)
	           VALUES ($1,$2,$3,$4,$5)`, w.inst, id, w.year, w.class, w.section)
	return id
}

// structure prices the class at one tuition line per instalment.
func (w *feesWorld) structure(t *testing.T, year uuid.UUID, perInstalment int64, instalments int) uuid.UUID {
	t.Helper()
	id := uuid.New()
	w.exec(t, `INSERT INTO fee_structures (id, institution_id, campus_id, academic_year_id, class_id, name)
	           VALUES ($1,$2,$3,$4,$5,'Class 6 fee')`, id, w.inst, w.campus, year, w.class)
	for i := 1; i <= instalments; i++ {
		w.exec(t, `INSERT INTO fee_structure_items (institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise)
		           VALUES ($1,$2,$3,$4,$5)`, w.inst, id, w.tuition, i, perInstalment)
	}
	return id
}

func (w *feesWorld) identity(perms ...string) *httpx.Identity {
	id := &httpx.Identity{UserID: uuid.New(), InstitutionID: w.inst, Permissions: map[string]struct{}{}}
	for _, p := range perms {
		id.Permissions[p] = struct{}{}
	}
	return id
}

// call posts a JSON body straight at a handler and returns the status and
// decoded body. The permission gate is asserted where it lives, in the
// router; what is under test is what the handler does once through.
func (w *feesWorld) call(t *testing.T, h http.HandlerFunc, id *httpx.Identity, body string, params ...string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
	req = req.WithContext(httpx.WithIdentity(req.Context(), id))
	if len(params) == 2 {
		req = withURLParam(req, params[0], params[1])
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (w *feesWorld) raise(t *testing.T, structureID uuid.UUID, body string) (int, map[string]any) {
	t.Helper()
	if body == "" {
		body = `{"fee_structure_id":"` + structureID.String() + `","instalment_no":1}`
	}
	return w.call(t, w.s.generateInvoices, w.identity(rbac.InvoicesWrite), body)
}

// invoiceLines reads a child's lines under one head name, for this year's
// non-cancelled invoices.
func (w *feesWorld) lines(t *testing.T, student uuid.UUID, head string) (count int, total int64) {
	t.Helper()
	w.scan(t, `
		SELECT count(*)::int, COALESCE(sum(il.amount_paise - il.discount_paise), 0)
		  FROM invoice_lines il
		  JOIN invoices i ON i.id = il.invoice_id
		  JOIN fee_heads fh ON fh.id = il.fee_head_id
		 WHERE i.student_id = $1 AND i.status <> 'cancelled' AND fh.name = $2`,
		[]any{&count, &total}, student, head)
	return
}

/*
TestTransportFareReachesTheInvoice is the June gap: the fare the transport
office worked out was shown and discarded, and the bus child and the walking
child in the same class got the same bill.
*/
func TestTransportFareReachesTheInvoice(t *testing.T) {
	db := testDB(t)
	requirePolicyBoundConnection(t, db)
	w := seedFeesWorld(t, db)

	bus := w.student(t, "Bus")
	walker := w.student(t, "Walker")
	route, stop := uuid.New(), uuid.New()
	w.exec(t, `INSERT INTO routes (id, institution_id, campus_id, name) VALUES ($1,$2,$3,'Route 7')`,
		route, w.inst, w.campus)
	w.exec(t, `INSERT INTO route_stops (id, institution_id, route_id, name, sequence, fare_paise)
	           VALUES ($1,$2,$3,'Far stop',1,120000)`, stop, w.inst, route)

	// Through the office's own handler, which is where the fare was lost.
	code, out := w.call(t, w.s.allocateTransport, w.identity(rbac.TransportWrite),
		`{"student_id":"`+bus.String()+`","route_id":"`+route.String()+`","pickup_stop_id":"`+stop.String()+`"}`)
	if code != http.StatusCreated {
		t.Fatalf("allocate: %d %v", code, out)
	}

	structure := w.structure(t, w.year, 1000000, 3)
	if code, out := w.raise(t, structure, ""); code != http.StatusCreated || out["created"] != float64(2) {
		t.Fatalf("raise: %d %v", code, out)
	}

	if n, total := w.lines(t, bus, "Transport fee"); n != 1 || total != 120000 {
		t.Errorf("bus child: %d transport lines worth %d, want one worth 120000", n, total)
	}
	if n, _ := w.lines(t, walker, "Transport fee"); n != 0 {
		t.Errorf("walking child was billed the bus: %d lines", n)
	}
	if n, total := w.lines(t, bus, "Tuition"); n != 1 || total != 1000000 {
		t.Errorf("tuition line disturbed: %d lines worth %d", n, total)
	}

	// The whole year at once bills the bus for every instalment, not once.
	w.exec(t, `DELETE FROM invoices WHERE student_id = $1`, bus)
	code, out = w.raise(t, structure, `{"fee_structure_id":"`+structure.String()+`","instalment_no":1,"student_id":"`+bus.String()+`","all_instalments":true}`)
	if code != http.StatusCreated || out["created"] != float64(1) {
		t.Fatalf("raise year: %d %v", code, out)
	}
	if _, total := w.lines(t, bus, "Transport fee"); total != 360000 {
		t.Errorf("year bill carries %d of transport, want 360000 for three instalments", total)
	}

	// Taken off the bus: the charge ends with the allocation, so the next
	// demand raised does not carry it.
	w.exec(t, `UPDATE transport_allocations SET valid_to = current_date - 1 WHERE student_id = $1`, bus)
	err := w.db.InTenant(context.Background(), database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		return syncTransportFeeComponent(context.Background(), tx, w.inst, bus)
	})
	if err != nil {
		t.Fatalf("sync after leaving the bus: %v", err)
	}
	var live int
	w.scan(t, `SELECT count(*)::int FROM student_fee_components
	            WHERE student_id = $1 AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`, []any{&live}, bus)
	if live != 0 {
		t.Errorf("%d transport charges still live after the allocation ended", live)
	}
}

var _ = time.Now

// withURLParam plants a chi route parameter on a request built by hand, so a
// handler that reads {id} can be called without a router.
func withURLParam(r *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

/*
TestArrearsFollowTheChildIntoTheNewYear is the April gap: a family that owed
two terms in March was billed in June as though March were settled.

	The balance must land on the new bill once, name the invoice it came
	from, close the old bill, and leave the ledger's own arithmetic -- charged
	less paid -- exactly where it was.
*/
func TestArrearsFollowTheChildIntoTheNewYear(t *testing.T) {
	db := testDB(t)
	requirePolicyBoundConnection(t, db)
	w := seedFeesWorld(t, db)

	lastYear := uuid.New()
	w.exec(t, `INSERT INTO academic_years (id, institution_id, name, starts_on, ends_on, is_current)
	           VALUES ($1,$2,'Last year', CURRENT_DATE - 395, CURRENT_DATE - 31, false)`, lastYear, w.inst)

	child := w.student(t, "Defaulter")
	// Last year's enrolment is over, and last year's bill is still open.
	w.exec(t, `INSERT INTO enrollments (institution_id, student_id, academic_year_id, class_id, section_id, status)
	           VALUES ($1,$2,$3,$4,$5,'promoted')`, w.inst, child, lastYear, w.class, w.section)
	oldInvoice, oldNo := uuid.New(), "INV/OLD/00001"
	w.exec(t, `INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no,
	                                 instalment_no, issued_on, due_on, gross_paise, status)
	           VALUES ($1,$2,$3,$4,$5,$6,1,CURRENT_DATE - 300,CURRENT_DATE - 286,1000000,'unpaid')`,
		oldInvoice, w.inst, w.campus, child, lastYear, oldNo)
	w.exec(t, `INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id, description, amount_paise)
	           VALUES ($1,$2,$3,'Tuition',1000000)`, w.inst, oldInvoice, w.tuition)
	// They paid ₹3,000 of the ₹10,000 last year.
	w.exec(t, `INSERT INTO payments (id, institution_id, campus_id, student_id, amount_paise, mode, status)
	           VALUES ($1,$2,$3,$4,300000,'cash','success')`, uuid.New(), w.inst, w.campus, child)
	w.exec(t, `INSERT INTO payment_allocations (institution_id, payment_id, invoice_id, amount_paise)
	           SELECT $1, id, $2, 300000 FROM payments WHERE student_id = $3 AND mode = 'cash'`, w.inst, oldInvoice, child)

	var chargedBefore, paidBefore int64
	w.scan(t, `SELECT (SELECT COALESCE(sum(net_paise),0) FROM invoices WHERE student_id = $1 AND status <> 'cancelled'),
	                  (SELECT COALESCE(sum(amount_paise),0) FROM payments WHERE student_id = $1 AND status = 'success')`,
		[]any{&chargedBefore, &paidBefore}, child)
	if chargedBefore-paidBefore != 700000 {
		t.Fatalf("fixture: balance before is %d, want 700000", chargedBefore-paidBefore)
	}

	// The new year's demand.
	structure := w.structure(t, w.year, 1200000, 1)
	code, out := w.raise(t, structure, "")
	if code != http.StatusCreated || out["created"] != float64(1) {
		t.Fatalf("raise this year: %d %v", code, out)
	}
	if out["arrears_paise"] != float64(700000) || out["arrears_children"] != float64(1) {
		t.Errorf("run reported arrears %v for %v children, want 700000 for 1", out["arrears_paise"], out["arrears_children"])
	}

	n, total := w.lines(t, child, "Arrears brought forward")
	if n != 1 || total != 700000 {
		t.Errorf("arrears line: %d worth %d, want one worth 700000", n, total)
	}
	var descr string
	var newNet int64
	w.scan(t, `SELECT il.description, i.net_paise FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
	            JOIN fee_heads fh ON fh.id = il.fee_head_id
	           WHERE i.student_id = $1 AND fh.code = 'ARREARS'`, []any{&descr, &newNet}, child)
	if !strings.Contains(descr, oldNo) || !strings.Contains(descr, "Last year") {
		t.Errorf("arrears line %q does not name the invoice and year it came from", descr)
	}
	if newNet != 1900000 {
		t.Errorf("new bill is %d, want 1900000 (12,000 tuition + 7,000 arrears)", newNet)
	}

	// The old bill is closed by the carry, and the ledger's balance is what
	// it was: the debt moved, it did not double.
	var oldStatus string
	var oldPaid int64
	w.scan(t, `SELECT status, paid_paise FROM invoices WHERE id = $1`, []any{&oldStatus, &oldPaid}, oldInvoice)
	if oldStatus != "paid" || oldPaid != 1000000 {
		t.Errorf("old invoice after carry: %s with %d paid, want paid in full by the adjustment", oldStatus, oldPaid)
	}
	var chargedAfter, paidAfter, collected int64
	w.scan(t, `SELECT (SELECT COALESCE(sum(net_paise),0) FROM invoices WHERE student_id = $1 AND status <> 'cancelled'),
	                  (SELECT COALESCE(sum(amount_paise),0) FROM payments WHERE student_id = $1 AND status = 'success'),
	                  (SELECT COALESCE(sum(amount_paise),0) FROM payments WHERE student_id = $1 AND status = 'success' AND mode <> 'adjustment')`,
		[]any{&chargedAfter, &paidAfter, &collected}, child)
	if chargedAfter-paidAfter != 700000+1200000 {
		t.Errorf("ledger balance after carry is %d, want 1900000", chargedAfter-paidAfter)
	}
	if collected != 300000 {
		t.Errorf("collection reads %d after the carry, want the 300000 actually received", collected)
	}
	var carries int
	w.scan(t, `SELECT count(*)::int FROM invoice_carry_forwards WHERE from_invoice_id = $1`, []any{&carries}, oldInvoice)
	if carries != 1 {
		t.Errorf("%d carry rows for the old invoice, want exactly one", carries)
	}

	// Raising instalment 2 finds nothing left to carry: once.
	w.exec(t, `INSERT INTO fee_structure_items (institution_id, fee_structure_id, fee_head_id, instalment_no, amount_paise)
	           VALUES ($1,$2,$3,2,1200000)`, w.inst, structure, w.tuition)
	code, out = w.raise(t, structure, `{"fee_structure_id":"`+structure.String()+`","instalment_no":2}`)
	if code != http.StatusCreated || out["arrears_paise"] != float64(0) {
		t.Errorf("second raise: %d %v — arrears carried again", code, out)
	}
	if n, _ := w.lines(t, child, "Arrears brought forward"); n != 1 {
		t.Errorf("%d arrears lines after the second raise, want still one", n)
	}
}
