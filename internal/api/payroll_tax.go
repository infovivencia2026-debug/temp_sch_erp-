package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Income tax, advances and the contractor's bill.

   Three things a payroll office does that are not the payslip: work out how
   much tax to withhold from each salary, lend people money against it, and
   check that the security agency billed for guards who actually turned up. */

// --- income tax -----------------------------------------------------------

/*
Slabs for the two regimes, as annual rupees in paise.

	Held as data rather than branches because they change most years and the
	shape does not. The old regime's numbers have been fixed since 2014-15; the
	new regime's are the ones a school will be editing, which is why both are
	one table each rather than a chain of ifs.
*/
type taxSlab struct {
	UpTo    int64 // 0 means no upper bound
	Percent float64
}

var newRegimeSlabs = []taxSlab{
	{30000000, 0},   // up to ₹3,00,000
	{70000000, 5},   // ₹3,00,001 – ₹7,00,000
	{100000000, 10}, // ₹7,00,001 – ₹10,00,000
	{120000000, 15}, // ₹10,00,001 – ₹12,00,000
	{150000000, 20}, // ₹12,00,001 – ₹15,00,000
	{0, 30},         // above ₹15,00,000
}

var oldRegimeSlabs = []taxSlab{
	{25000000, 0},   // up to ₹2,50,000
	{50000000, 5},   // ₹2,50,001 – ₹5,00,000
	{100000000, 20}, // ₹5,00,001 – ₹10,00,000
	{0, 30},         // above ₹10,00,000
}

const (
	// Standard deduction differs by regime and is the commonest thing a
	// hand-rolled spreadsheet gets wrong.
	stdDeductionNew = 7500000 // ₹75,000
	stdDeductionOld = 5000000 // ₹50,000
	// Section 87A rebate: tax falls to nil below these taxable incomes.
	rebateLimitNew = 70000000 // ₹7,00,000
	rebateLimitOld = 50000000 // ₹5,00,000
	rebateCapNew   = 2500000  // ₹25,000
	rebateCapOld   = 1250000  // ₹12,500
	cessPercent    = 4.0
	// The old regime's ceiling on section 80C.
	section80CCap = 15000000 // ₹1,50,000
)

type taxComputation struct {
	EmployeeID  string  `json:"employee_id"`
	Name        string  `json:"full_name"`
	PAN         *string `json:"pan,omitempty"`
	FYStartYear int     `json:"fy_start_year"`
	Regime      string  `json:"regime"`
	Elected     bool    `json:"elected"`
	GrossAnnual int64   `json:"gross_annual_paise"`
	// Months actually paid so far, and the projection to a full year. A school
	// running payroll in August must withhold against the whole year, not
	// against the four months it has issued.
	MonthsPaid      int              `json:"months_paid"`
	Projected       bool             `json:"projected"`
	StandardDed     int64            `json:"standard_deduction_paise"`
	Chapter6A       int64            `json:"chapter_via_paise"`
	ProfTax         int64            `json:"professional_tax_paise"`
	Taxable         int64            `json:"taxable_income_paise"`
	TaxBeforeRebate int64            `json:"tax_before_rebate_paise"`
	Rebate          int64            `json:"rebate_paise"`
	Cess            int64            `json:"cess_paise"`
	TaxPayable      int64            `json:"tax_payable_paise"`
	MonthlyTDS      int64            `json:"monthly_tds_paise"`
	Declarations    []declarationRow `json:"declarations"`
}

/*
slabTax applies a slab table to a taxable income.

	Marginal throughout: each band taxes only the part of the income inside it.
	Written as a loop over the table rather than a formula per regime so that
	editing a rate is editing one number.
*/
func slabTax(income int64, slabs []taxSlab) int64 {
	var tax int64
	var floor int64
	for _, sl := range slabs {
		if income <= floor {
			break
		}
		top := sl.UpTo
		if top == 0 || income < top {
			top = income
		}
		tax += pct(top-floor, sl.Percent)
		floor = sl.UpTo
		if sl.UpTo == 0 {
			break
		}
	}
	return tax
}

/*
getTaxComputation is one employee's TDS working, and the basis of their Form 16.

	Deliberately shows every intermediate number. A payroll office is asked
	"why was this much deducted" every February, and an answer that is only a
	total cannot be defended.
*/
func (s *Server) getTaxComputation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	// Without an employee named, answer the question the screen opens on: where
	// does the whole staff stand. Refusing with a 400 would be defensible and
	// useless — the office wants the list before it wants one person's working.
	if r.URL.Query().Get("employee_id") == "" {
		s.listTaxPositions(w, r)
		return
	}
	employee, err := uuid.Parse(r.URL.Query().Get("employee_id"))
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	fy := fyFrom(r)

	out := taxComputation{EmployeeID: employee.String(), FYStartYear: fy,
		Regime: "new", Declarations: []declarationRow{}}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(),
			`SELECT concat_ws(' ', first_name, last_name), pan FROM employees WHERE id = $1`,
			employee).Scan(&out.Name, &out.PAN); err != nil {
			return err
		}
		var electedOn *string
		err := tx.QueryRow(r.Context(), `
			SELECT regime, to_char(elected_on,'YYYY-MM-DD')
			  FROM employee_tax_elections
			 WHERE employee_id = $1 AND fy_start_year = $2`, employee, fy).
			Scan(&out.Regime, &electedOn)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		out.Elected = electedOn != nil

		/* Earnings actually paid inside the financial year, which runs April
		   to March and therefore straddles two calendar years. Getting this
		   boundary wrong is the classic Indian payroll bug: a January payslip
		   belongs to the year that started the previous April. */
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(sum(ps.gross_paise), 0),
			       COALESCE(sum(COALESCE((ps.breakup->>'PT')::bigint, 0)), 0) * -1,
			       count(*)::int
			  FROM payslips ps
			  JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
			 WHERE ps.employee_id = $1
			   AND make_date(pr.period_year, pr.period_month, 1)
			       BETWEEN make_date($2, 4, 1) AND make_date($2 + 1, 3, 1)`,
			employee, fy).Scan(&out.GrossAnnual, &out.ProfTax, &out.MonthsPaid); err != nil {
			return err
		}
		// Project the rest of the year from what has been paid so far. A school
		// running payroll in August withholds against twelve months, not four.
		if out.MonthsPaid > 0 && out.MonthsPaid < 12 {
			monthly := out.GrossAnnual / int64(out.MonthsPaid)
			out.GrossAnnual = monthly * 12
			out.ProfTax = out.ProfTax / int64(out.MonthsPaid) * 12
			out.Projected = true
		}

		rows, err := tx.Query(r.Context(), `
			SELECT id::text, section, particulars, declared_paise, verified_paise, status
			  FROM investment_declarations
			 WHERE employee_id = $1 AND fy_start_year = $2
			 ORDER BY section, particulars`, employee, fy)
		if err != nil {
			return err
		}
		defer rows.Close()
		var c80, other int64
		for rows.Next() {
			var d declarationRow
			if err := rows.Scan(&d.ID, &d.Section, &d.Particulars, &d.Declared,
				&d.Verified, &d.Status); err != nil {
				return err
			}
			if d.Status == "rejected" {
				d.Counted = 0
			} else if d.Verified != nil {
				// Once a proof is in, the proof is the number. Before that the
				// declaration is, which is exactly what makes TDS an estimate
				// corrected in February rather than a fact.
				d.Counted = *d.Verified
			} else {
				d.Counted = d.Declared
			}
			out.Declarations = append(out.Declarations, d)
			if strings.HasPrefix(d.Section, "80C") {
				c80 += d.Counted
			} else {
				other += d.Counted
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if c80 > section80CCap {
			c80 = section80CCap
		}
		out.Chapter6A = c80 + other
		return nil
	})
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* The new regime allows the standard deduction and almost nothing else.
	   Applying Chapter VI-A under it is the single most common error in
	   hand-built payroll sheets, and it always under-withholds. */
	slabs := newRegimeSlabs
	out.StandardDed = stdDeductionNew
	rebateLimit, rebateCap := int64(rebateLimitNew), int64(rebateCapNew)
	deductions := out.StandardDed
	if out.Regime == "old" {
		slabs = oldRegimeSlabs
		out.StandardDed = stdDeductionOld
		rebateLimit, rebateCap = rebateLimitOld, rebateCapOld
		deductions = out.StandardDed + out.Chapter6A + out.ProfTax
	}

	out.Taxable = out.GrossAnnual - deductions
	if out.Taxable < 0 {
		out.Taxable = 0
	}
	out.TaxBeforeRebate = slabTax(out.Taxable, slabs)
	if out.Taxable <= rebateLimit {
		out.Rebate = out.TaxBeforeRebate
		if out.Rebate > rebateCap {
			out.Rebate = rebateCap
		}
	}
	afterRebate := out.TaxBeforeRebate - out.Rebate
	if afterRebate < 0 {
		afterRebate = 0
	}
	out.Cess = pct(afterRebate, cessPercent)
	out.TaxPayable = afterRebate + out.Cess
	// Spread over whatever months of the year remain, so a mid-year joiner is
	// not asked for twelve months of tax in four payslips.
	remaining := int64(12 - out.MonthsPaid)
	if remaining < 1 {
		remaining = 1
	}
	out.MonthlyTDS = out.TaxPayable / remaining

	httpx.JSON(w, http.StatusOK, out)
}

type taxPositionRow struct {
	EmployeeID    string  `json:"employee_id"`
	Name          string  `json:"full_name"`
	PAN           *string `json:"pan,omitempty"`
	Regime        string  `json:"regime"`
	Elected       bool    `json:"elected"`
	GrossPaid     int64   `json:"gross_paid_paise"`
	MonthsPaid    int     `json:"months_paid"`
	Declarations  int     `json:"declarations"`
	DeclaredPaise int64   `json:"declared_paise"`
	Unverified    int     `json:"unverified_proofs"`
}

/*
listTaxPositions is where the staff stand, one row each.

	Deliberately not a tax figure per person: computing twelve projections on a
	list view would be slow and, worse, would invite someone to read a
	projection as a decision. What the office needs here is who has not chosen
	a regime and whose proofs are still outstanding in January.
*/
func (s *Server) listTaxPositions(w http.ResponseWriter, r *http.Request) {
	fy := fyFrom(r)
	items, err := collect(s, r, `
		SELECT e.id::text, concat_ws(' ', e.first_name, e.last_name), e.pan,
		       COALESCE(el.regime, 'new'), el.elected_on IS NOT NULL,
		       COALESCE(paid.gross, 0), COALESCE(paid.months, 0),
		       COALESCE(d.n, 0), COALESCE(d.declared, 0), COALESCE(d.unverified, 0)
		  FROM employees e
		  LEFT JOIN employee_tax_elections el
		         ON el.employee_id = e.id AND el.fy_start_year = $1
		  LEFT JOIN LATERAL (
		      SELECT sum(ps.gross_paise) AS gross, count(*)::int AS months
		        FROM payslips ps
		        JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
		       WHERE ps.employee_id = e.id
		         AND make_date(pr.period_year, pr.period_month, 1)
		             BETWEEN make_date($1, 4, 1) AND make_date($1 + 1, 3, 1)
		  ) paid ON TRUE
		  LEFT JOIN LATERAL (
		      SELECT count(*)::int AS n,
		             sum(CASE WHEN status = 'rejected' THEN 0
		                      ELSE COALESCE(verified_paise, declared_paise) END) AS declared,
		             count(*) FILTER (WHERE status IN ('declared','proof_submitted'))::int AS unverified
		        FROM investment_declarations idl
		       WHERE idl.employee_id = e.id AND idl.fy_start_year = $1
		  ) d ON TRUE
		 WHERE e.status = 'active'
		 ORDER BY e.first_name`, []any{fy},
		func(rows pgx.Rows) (taxPositionRow, error) {
			var v taxPositionRow
			return v, rows.Scan(&v.EmployeeID, &v.Name, &v.PAN, &v.Regime, &v.Elected,
				&v.GrossPaid, &v.MonthsPaid, &v.Declarations, &v.DeclaredPaise, &v.Unverified)
		})
	respond(w, r, items, err)
}

// --- declarations ---------------------------------------------------------

type declarationRow struct {
	ID          string  `json:"id"`
	EmployeeID  string  `json:"employee_id,omitempty"`
	Name        string  `json:"full_name,omitempty"`
	Section     string  `json:"section"`
	Particulars string  `json:"particulars"`
	Declared    int64   `json:"declared_paise"`
	Verified    *int64  `json:"verified_paise,omitempty"`
	Status      string  `json:"status"`
	Remarks     *string `json:"remarks,omitempty"`
	// What the tax working will actually use: the proof if there is one, the
	// promise if not, nothing if it was rejected.
	Counted int64 `json:"counted_paise"`
}

func (s *Server) listDeclarations(w http.ResponseWriter, r *http.Request) {
	fy := fyFrom(r)
	items, err := collect(s, r, `
		SELECT d.id::text, d.employee_id::text,
		       concat_ws(' ', e.first_name, e.last_name),
		       d.section, d.particulars, d.declared_paise, d.verified_paise,
		       d.status, d.remarks,
		       CASE WHEN d.status = 'rejected' THEN 0
		            ELSE COALESCE(d.verified_paise, d.declared_paise) END
		  FROM investment_declarations d
		  JOIN employees e ON e.id = d.employee_id
		 WHERE d.fy_start_year = $1
		   AND ($2::uuid IS NULL OR d.employee_id = $2::uuid)
		 ORDER BY e.first_name, d.section`,
		[]any{fy, nullString(r.URL.Query().Get("employee_id"))},
		func(rows pgx.Rows) (declarationRow, error) {
			var v declarationRow
			return v, rows.Scan(&v.ID, &v.EmployeeID, &v.Name, &v.Section,
				&v.Particulars, &v.Declared, &v.Verified, &v.Status, &v.Remarks, &v.Counted)
		})
	respond(w, r, items, err)
}

type declarationRequest struct {
	ID          string `json:"id,omitempty"`
	EmployeeID  string `json:"employee_id"`
	FYStartYear int    `json:"fy_start_year,omitempty"`
	Section     string `json:"section"`
	Particulars string `json:"particulars"`
	Declared    int64  `json:"declared_paise"`
	Verified    *int64 `json:"verified_paise,omitempty"`
	Status      string `json:"status,omitempty"`
	Remarks     string `json:"remarks,omitempty"`
	Regime      string `json:"regime,omitempty"`
}

func (s *Server) saveDeclaration(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req declarationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.FYStartYear == 0 {
		req.FYStartYear = currentFY()
	}

	// Verifying an amount and rejecting a claim are the two updates.
	if req.ID != "" {
		if req.Status == "rejected" && strings.TrimSpace(req.Remarks) == "" {
			httpx.BadRequest(w, r,
				"say why it was rejected — an employee cannot fix a proof nobody explained")
			return
		}
		if req.Status == "verified" && req.Verified == nil {
			httpx.BadRequest(w, r, "verifying needs the amount actually accepted")
			return
		}
		declID, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "id must be a uuid")
			return
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
				UPDATE investment_declarations
				   SET status = COALESCE(NULLIF($2,''), status),
				       verified_paise = COALESCE($3, verified_paise),
				       remarks = COALESCE(NULLIF($4,''), remarks),
				       updated_at = now()
				 WHERE id = $1`, declID, req.Status, req.Verified, req.Remarks)
			return err
		})
		if err != nil {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"id": req.ID})
		return
	}

	employee, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Section) == "" || strings.TrimSpace(req.Particulars) == "" {
		httpx.BadRequest(w, r, "a declaration needs a section and what was invested in")
		return
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.Regime != "" {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO employee_tax_elections
				    (institution_id, employee_id, fy_start_year, regime, elected_on)
				VALUES ($1,$2,$3,$4,current_date)
				ON CONFLICT (employee_id, fy_start_year)
				DO UPDATE SET regime = EXCLUDED.regime, elected_on = current_date`,
				id.InstitutionID, employee, req.FYStartYear, req.Regime); err != nil {
				return err
			}
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO investment_declarations
			    (institution_id, employee_id, fy_start_year, section, particulars,
			     declared_paise, status)
			VALUES ($1,$2,$3,$4,$5,$6,'declared')
			RETURNING id::text`,
			id.InstitutionID, employee, req.FYStartYear, req.Section,
			req.Particulars, req.Declared).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- advances and loans ---------------------------------------------------

type staffLoanRow struct {
	ID          string  `json:"id"`
	EmployeeID  string  `json:"employee_id"`
	Name        string  `json:"full_name"`
	Kind        string  `json:"kind"`
	Principal   int64   `json:"principal_paise"`
	Instalment  int64   `json:"instalment_paise"`
	StartYear   int     `json:"start_year"`
	StartMonth  int     `json:"start_month"`
	Reason      *string `json:"reason,omitempty"`
	Status      string  `json:"status"`
	Recovered   int64   `json:"recovered_paise"`
	Outstanding int64   `json:"outstanding_paise"`
	// How many more payslips it has to run for, at the current instalment.
	MonthsLeft int `json:"months_left"`
}

func (s *Server) listStaffLoans(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT l.id::text, l.employee_id::text,
		       concat_ws(' ', e.first_name, e.last_name),
		       l.kind, l.principal_paise, l.instalment_paise,
		       l.start_year, l.start_month, l.reason, l.status,
		       COALESCE(d.taken, 0),
		       GREATEST(0, l.principal_paise - COALESCE(d.taken, 0)),
		       CASE WHEN l.instalment_paise > 0
		            THEN CEIL(GREATEST(0, l.principal_paise - COALESCE(d.taken,0))::numeric
		                      / l.instalment_paise)::int
		            ELSE 0 END
		  FROM staff_loans l
		  JOIN employees e ON e.id = l.employee_id
		  -- Recovered is summed from the instalments actually taken. A stored
		  -- balance that disagrees with the payslips is how these end up in a
		  -- labour court.
		  LEFT JOIN LATERAL (
		      SELECT sum(ld.amount_paise) AS taken
		        FROM loan_deductions ld WHERE ld.loan_id = l.id
		  ) d ON TRUE
		 WHERE ($1::text IS NULL OR l.status = $1)
		 ORDER BY (l.status = 'active') DESC, e.first_name`,
		[]any{nullString(r.URL.Query().Get("status"))},
		func(rows pgx.Rows) (staffLoanRow, error) {
			var v staffLoanRow
			return v, rows.Scan(&v.ID, &v.EmployeeID, &v.Name, &v.Kind,
				&v.Principal, &v.Instalment, &v.StartYear, &v.StartMonth,
				&v.Reason, &v.Status, &v.Recovered, &v.Outstanding, &v.MonthsLeft)
		})
	respond(w, r, items, err)
}

type loanRequest struct {
	ID         string `json:"id,omitempty"`
	EmployeeID string `json:"employee_id"`
	Kind       string `json:"kind,omitempty"`
	Principal  int64  `json:"principal_paise"`
	Instalment int64  `json:"instalment_paise"`
	StartYear  int    `json:"start_year,omitempty"`
	StartMonth int    `json:"start_month,omitempty"`
	Reason     string `json:"reason,omitempty"`
	Status     string `json:"status,omitempty"`
}

func (s *Server) saveStaffLoan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req loanRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	if req.ID != "" {
		loanID, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "id must be a uuid")
			return
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
				UPDATE staff_loans
				   SET status = COALESCE(NULLIF($2,''), status),
				       closed_on = CASE WHEN $2 IN ('closed','cancelled')
				                        THEN current_date ELSE closed_on END
				 WHERE id = $1`, loanID, req.Status)
			return err
		})
		if err != nil {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"id": req.ID})
		return
	}

	employee, err := uuid.Parse(req.EmployeeID)
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}
	if req.Principal <= 0 || req.Instalment <= 0 {
		httpx.BadRequest(w, r, "an advance needs an amount and an instalment")
		return
	}
	if req.Instalment > req.Principal {
		httpx.BadRequest(w, r, "the instalment cannot be larger than the advance itself")
		return
	}
	if req.Kind == "" {
		req.Kind = "advance"
	}
	if req.StartYear == 0 {
		now := nowInIndia()
		req.StartYear, req.StartMonth = now.Year(), int(now.Month())
	}

	var newID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO staff_loans
			    (institution_id, employee_id, kind, principal_paise, instalment_paise,
			     start_year, start_month, reason, approved_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9)
			RETURNING id::text`,
			id.InstitutionID, employee, req.Kind, req.Principal, req.Instalment,
			req.StartYear, req.StartMonth, req.Reason, id.UserID).Scan(&newID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

// --- contractor bills -----------------------------------------------------

type contractorBillRow struct {
	ID           string  `json:"id"`
	Vendor       string  `json:"vendor"`
	Service      string  `json:"service"`
	Year         int     `json:"period_year"`
	Month        int     `json:"period_month"`
	InvoiceNo    *string `json:"invoice_no,omitempty"`
	ClaimedDays  int     `json:"claimed_days"`
	VerifiedDays *int    `json:"verified_days,omitempty"`
	RatePaise    int64   `json:"rate_paise"`
	Claimed      int64   `json:"claimed_paise"`
	Approved     *int64  `json:"approved_paise,omitempty"`
	Status       string  `json:"status"`
	Remarks      *string `json:"remarks,omitempty"`
	// The gap, in money. The only number on this screen anybody argues about.
	Shortfall int64 `json:"shortfall_paise"`
}

func (s *Server) listContractorBills(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT id::text, vendor, service, period_year, period_month, invoice_no,
		       claimed_days, verified_days, rate_paise, claimed_paise,
		       approved_paise, status, remarks,
		       GREATEST(0, claimed_paise - COALESCE(approved_paise, claimed_paise))
		  FROM contractor_bills
		 ORDER BY period_year DESC, period_month DESC, vendor
		 LIMIT 200`, nil,
		func(rows pgx.Rows) (contractorBillRow, error) {
			var v contractorBillRow
			return v, rows.Scan(&v.ID, &v.Vendor, &v.Service, &v.Year, &v.Month,
				&v.InvoiceNo, &v.ClaimedDays, &v.VerifiedDays, &v.RatePaise,
				&v.Claimed, &v.Approved, &v.Status, &v.Remarks, &v.Shortfall)
		})
	respond(w, r, items, err)
}

type contractorBillRequest struct {
	ID           string `json:"id,omitempty"`
	Vendor       string `json:"vendor"`
	Service      string `json:"service,omitempty"`
	Year         int    `json:"period_year,omitempty"`
	Month        int    `json:"period_month,omitempty"`
	InvoiceNo    string `json:"invoice_no,omitempty"`
	ClaimedDays  int    `json:"claimed_days"`
	VerifiedDays *int   `json:"verified_days,omitempty"`
	RatePaise    int64  `json:"rate_paise"`
	Status       string `json:"status,omitempty"`
	Remarks      string `json:"remarks,omitempty"`
}

/*
saveContractorBill records or verifies an outsourced-staff invoice.

	The approved amount is computed from the verified days rather than typed,
	so a bill can only be short-paid by disagreeing about attendance — which is
	the conversation the school should actually be having with the vendor.
*/
func (s *Server) saveContractorBill(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req contractorBillRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	if req.ID != "" {
		if req.VerifiedDays == nil {
			httpx.BadRequest(w, r, "verifying a bill means saying how many days were actually worked")
			return
		}
		billID, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "id must be a uuid")
			return
		}
		status := req.Status
		if status == "" {
			status = "verified"
		}
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(), `
				UPDATE contractor_bills
				   SET verified_days = $2,
				       -- Derived from the days, never typed: a bill can only be
				       -- short-paid by disagreeing about attendance, which is
				       -- the conversation the school should be having.
				       approved_paise = $2::int::bigint * rate_paise,
				       status = $3,
				       remarks = NULLIF($4,''),
				       verified_by = $5
				 WHERE id = $1`, billID, *req.VerifiedDays, status, req.Remarks, id.UserID)
			return err
		})
		if err != nil {
			if strings.Contains(err.Error(), "shortfall_explained") {
				httpx.BadRequest(w, r,
					"approving less than the vendor billed needs a reason on the record")
				return
			}
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"id": req.ID})
		return
	}

	if strings.TrimSpace(req.Vendor) == "" || req.ClaimedDays <= 0 || req.RatePaise <= 0 {
		httpx.BadRequest(w, r, "a bill needs a vendor, the days claimed and a day rate")
		return
	}
	if req.Service == "" {
		req.Service = "security"
	}
	if req.Year == 0 {
		y, m := periodFrom(r)
		req.Year, req.Month = y, m
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO contractor_bills
			    (institution_id, vendor, service, period_year, period_month,
			     invoice_no, claimed_days, rate_paise, claimed_paise)
			VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9)
			RETURNING id::text`,
			id.InstitutionID, req.Vendor, req.Service, req.Year, req.Month,
			req.InvoiceNo, req.ClaimedDays, req.RatePaise,
			int64(req.ClaimedDays)*req.RatePaise).Scan(&newID)
	})
	if err != nil {
		if isUniqueViolation(err) {
			httpx.Error(w, r, http.StatusConflict, "already_billed",
				"that vendor has already billed for this service this month")
			return
		}
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID})
}

/*
currentFY is the Indian financial year now running, as its starting year.

	April to March, so anything before April belongs to the year that started
	the previous April. The off-by-one here is the single most common date bug
	in Indian payroll code.
*/
func currentFY() int {
	now := nowInIndia()
	if now.Month() < 4 {
		return now.Year() - 1
	}
	return now.Year()
}

func fyFrom(r *http.Request) int {
	if v, err := strconv.Atoi(r.URL.Query().Get("fy")); err == nil && v > 2000 {
		return v
	}
	return currentFY()
}
