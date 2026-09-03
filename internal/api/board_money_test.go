package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The board sees every campus, and the totals are the campuses added up.

	A payroll run pays the whole school and has no campus of its own, so a
	payslip reaches a campus only through the employee it paid. The schema
	requires every employee, student and payment to carry a campus, so nothing
	can fall between the rows — the "Unassigned" row in the handler exists for
	invoices, which may predate a campus, and is hidden when empty.
*/
func TestBoardMoneyGroupsByCampusAndTotalsAddUp(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}

	var second uuid.UUID
	sc.tx(t, func(tx pgx.Tx) error {
		if err := tx.QueryRow(t.Context(), `
			INSERT INTO campuses (institution_id, name, code) VALUES ($1, 'North', 'N') RETURNING id`,
			sc.inst).Scan(&second); err != nil {
			return err
		}
		var run uuid.UUID
		if err := tx.QueryRow(t.Context(), `
			INSERT INTO payroll_runs (institution_id, period_month, period_year, status)
			VALUES ($1, extract(month from CURRENT_DATE)::int, extract(year from CURRENT_DATE)::int, 'paid')
			RETURNING id`, sc.inst).Scan(&run); err != nil {
			return err
		}
		for i, c := range []uuid.UUID{sc.campus, second} {
			var st, emp uuid.UUID
			if err := tx.QueryRow(t.Context(), `
				INSERT INTO students (institution_id, campus_id, admission_no, first_name, status)
				VALUES ($1, $2, $3, 'Child', 'active') RETURNING id`,
				sc.inst, c, "BM-"+uuid.NewString()[:6]).Scan(&st); err != nil {
				return err
			}
			if _, err := tx.Exec(t.Context(), `
				INSERT INTO payments (institution_id, campus_id, student_id, amount_paise, status, mode, paid_on)
				VALUES ($1, $2, $3, $4, 'success', 'cash', CURRENT_DATE)`, sc.inst, c, st, 100000*(i+1)); err != nil {
				return err
			}
			if err := tx.QueryRow(t.Context(), `
				INSERT INTO employees (institution_id, campus_id, employee_code, first_name, status)
				VALUES ($1, $2, $3, 'Staff', 'active') RETURNING id`,
				sc.inst, c, "E-"+uuid.NewString()[:6]).Scan(&emp); err != nil {
				return err
			}
			if _, err := tx.Exec(t.Context(), `
				INSERT INTO payslips (institution_id, payroll_run_id, employee_id, gross_paise, net_paise)
				VALUES ($1, $2, $3, $4, $4)`, sc.inst, run, emp, 5000000*(i+1)); err != nil {
				return err
			}
		}
		return nil
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/board/money?range=this_month", nil)
	req = req.WithContext(httpx.WithIdentity(req.Context(),
		sc.as(sc.teacher, rbac.InvoicesRead, rbac.PayrollRead)))
	w := httptest.NewRecorder()
	s.getBoardMoney(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var out boardMoney
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Campuses) != 2 {
		t.Fatalf("%d campus rows, want 2 (and no empty Unassigned row)", len(out.Campuses))
	}
	if out.Total.CollectedPaise != 300000 || out.Total.PayrollPaise != 15000000 {
		t.Errorf("totals collected=%d payroll=%d, want 300000 and 15000000", out.Total.CollectedPaise, out.Total.PayrollPaise)
	}
	var sumC, sumP int64
	for _, c := range out.Campuses {
		sumC += c.CollectedPaise
		sumP += c.PayrollPaise
	}
	if sumC != out.Total.CollectedPaise || sumP != out.Total.PayrollPaise {
		t.Errorf("rows do not add up to the total: %d/%d vs %d/%d", sumC, sumP, out.Total.CollectedPaise, out.Total.PayrollPaise)
	}
}

// Half the picture is refused: a finance clerk who may read invoices but not
// payroll does not get the board's sheet. Tested at the router, where the gate
// lives, not at the handler.
func TestBoardMoneyNeedsBothMoneyKeys(t *testing.T) {
	sc := newClassroomSchool(t)
	s := &Server{DB: sc.db}
	r := chi.NewRouter()
	s.mountBoard(r)

	req := httptest.NewRequest(http.MethodGet, "/board/money", nil)
	req = req.WithContext(httpx.WithIdentity(req.Context(), sc.as(sc.teacher, rbac.InvoicesRead)))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("invoices-only caller got %d, want 403", w.Code)
	}
}
