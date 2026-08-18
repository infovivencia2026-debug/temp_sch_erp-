package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What the government takes, and what the school owes.

   The product could compute a payslip from a salary structure, with PF and
   professional tax as fixed amounts somebody typed into a component. That is
   fine until a salary changes, at which point the deduction silently does not,
   and the return filed against it is wrong for the rest of the year.

   Everything here is computed from the wage and a stored rate. The rates are
   stored rather than compiled in because the EPF ceiling has moved twice in
   living memory and ESI's threshold three times, and a rate in Go is a rate
   that needs a deploy on the morning the gazette changes. */

// payrollSettings mirrors the table; every field is a number an auditor reads.
type payrollSettings struct {
	PFEnabled         bool     `json:"pf_enabled"`
	PFEmployeePct     float64  `json:"pf_employee_percent"`
	PFEmployerPct     float64  `json:"pf_employer_percent"`
	PFCeilingPaise    int64    `json:"pf_wage_ceiling_paise"`
	EPSPct            float64  `json:"eps_percent"`
	PFAdminPct        float64  `json:"pf_admin_percent"`
	PFCode            *string  `json:"pf_establishment_code,omitempty"`
	ESIEnabled        bool     `json:"esi_enabled"`
	ESIEmployeePct    float64  `json:"esi_employee_percent"`
	ESIEmployerPct    float64  `json:"esi_employer_percent"`
	ESIThresholdPaise int64    `json:"esi_wage_threshold_paise"`
	ESICode           *string  `json:"esi_code,omitempty"`
	PTState           string   `json:"pt_state"`
	PTEnabled         bool     `json:"pt_enabled"`
	SubstitutionPaise int64    `json:"substitution_rate_paise"`
	OvertimePaise     int64    `json:"overtime_hourly_paise"`
	OvertimeMultiple  float64  `json:"overtime_holiday_multiplier"`
	GratuityDays      int      `json:"gratuity_days"`
	GratuityMonthDays int      `json:"gratuity_month_days"`
	GratuityMinYears  int      `json:"gratuity_min_years"`
	GratuityCapPaise  int64    `json:"gratuity_cap_paise"`
	BankName          *string  `json:"bank_name,omitempty"`
	BankAccount       *string  `json:"bank_account,omitempty"`
	Slabs             []ptSlab `json:"pt_slabs"`
}

type ptSlab struct {
	ID       string `json:"id,omitempty"`
	State    string `json:"state"`
	From     int64  `json:"from_paise"`
	To       *int64 `json:"to_paise,omitempty"`
	Monthly  int64  `json:"monthly_paise"`
	February *int64 `json:"february_paise,omitempty"`
}

const settingsColumns = `pf_enabled, pf_employee_percent, pf_employer_percent,
	pf_wage_ceiling_paise, eps_percent, pf_admin_percent, pf_establishment_code,
	esi_enabled, esi_employee_percent, esi_employer_percent,
	esi_wage_threshold_paise, esi_code, pt_state, pt_enabled,
	substitution_rate_paise, overtime_hourly_paise, overtime_holiday_multiplier,
	gratuity_days, gratuity_month_days, gratuity_min_years, gratuity_cap_paise,
	bank_name, bank_account`

func scanSettings(row pgx.Row, v *payrollSettings) error {
	return row.Scan(&v.PFEnabled, &v.PFEmployeePct, &v.PFEmployerPct,
		&v.PFCeilingPaise, &v.EPSPct, &v.PFAdminPct, &v.PFCode,
		&v.ESIEnabled, &v.ESIEmployeePct, &v.ESIEmployerPct,
		&v.ESIThresholdPaise, &v.ESICode, &v.PTState, &v.PTEnabled,
		&v.SubstitutionPaise, &v.OvertimePaise, &v.OvertimeMultiple,
		&v.GratuityDays, &v.GratuityMonthDays, &v.GratuityMinYears,
		&v.GratuityCapPaise, &v.BankName, &v.BankAccount)
}

/*
loadPayrollSettings reads a school's rates, creating the statutory defaults if
it has none.

	Creating on read rather than refusing: a school that has never opened the
	payroll settings screen still has to be able to run payroll, and the
	defaults are the law's own numbers.
*/
func loadPayrollSettings(r *http.Request, tx pgx.Tx, inst uuid.UUID) (payrollSettings, error) {
	var v payrollSettings
	err := scanSettings(tx.QueryRow(r.Context(),
		`SELECT `+settingsColumns+` FROM payroll_settings WHERE institution_id = $1`, inst), &v)
	if err == pgx.ErrNoRows {
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO payroll_settings (institution_id) VALUES ($1)
			 ON CONFLICT DO NOTHING`, inst); err != nil {
			return v, err
		}
		err = scanSettings(tx.QueryRow(r.Context(),
			`SELECT `+settingsColumns+` FROM payroll_settings WHERE institution_id = $1`, inst), &v)
	}
	if err != nil {
		return v, err
	}
	rows, err := tx.Query(r.Context(), `
		SELECT id::text, state, from_paise, to_paise, monthly_paise, february_paise
		  FROM pt_slabs WHERE institution_id = $1 AND state = $2
		 ORDER BY from_paise`, inst, v.PTState)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	v.Slabs = []ptSlab{}
	for rows.Next() {
		var sl ptSlab
		if err := rows.Scan(&sl.ID, &sl.State, &sl.From, &sl.To, &sl.Monthly, &sl.February); err != nil {
			return v, err
		}
		v.Slabs = append(v.Slabs, sl)
	}
	return v, rows.Err()
}

func (s *Server) getPayrollSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var v payrollSettings
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		v, err = loadPayrollSettings(r, tx, id.InstitutionID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (s *Server) savePayrollSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req payrollSettings
	if !httpx.Decode(w, r, &req) {
		return
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO payroll_settings (institution_id, pf_enabled, pf_employee_percent,
			    pf_employer_percent, pf_wage_ceiling_paise, eps_percent, pf_admin_percent,
			    pf_establishment_code, esi_enabled, esi_employee_percent,
			    esi_employer_percent, esi_wage_threshold_paise, esi_code, pt_state,
			    pt_enabled, substitution_rate_paise, overtime_hourly_paise,
			    overtime_holiday_multiplier, gratuity_days, gratuity_month_days,
			    gratuity_min_years, gratuity_cap_paise, bank_name, bank_account, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
			        $21,$22,$23,$24, now())
			ON CONFLICT (institution_id) DO UPDATE SET
			    pf_enabled = EXCLUDED.pf_enabled,
			    pf_employee_percent = EXCLUDED.pf_employee_percent,
			    pf_employer_percent = EXCLUDED.pf_employer_percent,
			    pf_wage_ceiling_paise = EXCLUDED.pf_wage_ceiling_paise,
			    eps_percent = EXCLUDED.eps_percent,
			    pf_admin_percent = EXCLUDED.pf_admin_percent,
			    pf_establishment_code = EXCLUDED.pf_establishment_code,
			    esi_enabled = EXCLUDED.esi_enabled,
			    esi_employee_percent = EXCLUDED.esi_employee_percent,
			    esi_employer_percent = EXCLUDED.esi_employer_percent,
			    esi_wage_threshold_paise = EXCLUDED.esi_wage_threshold_paise,
			    esi_code = EXCLUDED.esi_code,
			    pt_state = EXCLUDED.pt_state,
			    pt_enabled = EXCLUDED.pt_enabled,
			    substitution_rate_paise = EXCLUDED.substitution_rate_paise,
			    overtime_hourly_paise = EXCLUDED.overtime_hourly_paise,
			    overtime_holiday_multiplier = EXCLUDED.overtime_holiday_multiplier,
			    gratuity_days = EXCLUDED.gratuity_days,
			    gratuity_month_days = EXCLUDED.gratuity_month_days,
			    gratuity_min_years = EXCLUDED.gratuity_min_years,
			    gratuity_cap_paise = EXCLUDED.gratuity_cap_paise,
			    bank_name = EXCLUDED.bank_name,
			    bank_account = EXCLUDED.bank_account,
			    updated_at = now()`,
			id.InstitutionID, req.PFEnabled, req.PFEmployeePct, req.PFEmployerPct,
			req.PFCeilingPaise, req.EPSPct, req.PFAdminPct, req.PFCode,
			req.ESIEnabled, req.ESIEmployeePct, req.ESIEmployerPct,
			req.ESIThresholdPaise, req.ESICode, req.PTState, req.PTEnabled,
			req.SubstitutionPaise, req.OvertimePaise, req.OvertimeMultiple,
			req.GratuityDays, req.GratuityMonthDays, req.GratuityMinYears,
			req.GratuityCapPaise, req.BankName, req.BankAccount); err != nil {
			return err
		}
		if req.Slabs == nil {
			return nil
		}
		// Slabs are replaced wholesale for the state being edited. Merging them
		// would leave an old top slab behind every time a state widens one.
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM pt_slabs WHERE institution_id = $1 AND state = $2`,
			id.InstitutionID, req.PTState); err != nil {
			return err
		}
		for _, sl := range req.Slabs {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO pt_slabs (institution_id, state, from_paise, to_paise,
				                      monthly_paise, february_paise)
				VALUES ($1,$2,$3,$4,$5,$6)`,
				id.InstitutionID, req.PTState, sl.From, sl.To, sl.Monthly, sl.February); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

// --- the computation itself -----------------------------------------------

// statutory is what the law takes from one month's wage, and what it costs the
// school on top.
type statutory struct {
	PFWage      int64 `json:"pf_wage_paise"`
	PFEmployee  int64 `json:"pf_employee_paise"`
	PFEmployer  int64 `json:"pf_employer_paise"`
	EPS         int64 `json:"eps_paise"`
	PFAdmin     int64 `json:"pf_admin_paise"`
	ESIEmployee int64 `json:"esi_employee_paise"`
	ESIEmployer int64 `json:"esi_employer_paise"`
	PT          int64 `json:"pt_paise"`
}

/*
computeStatutory works out PF, ESI and professional tax for one month.

	PF is on basic plus dearness allowance, not on gross: allowances are
	excluded by the Act, and a school computing it on gross over-deducts from
	every employee it has. The ceiling caps the wage the contribution is
	computed on rather than excluding the employee, because a school that pays
	above it still contributes — on the capped amount.

	ESI is on gross and stops entirely above the threshold. The pension share
	comes out of the employer's contribution rather than being added to it,
	which is the split an ECR file has to show.
*/
func computeStatutory(set payrollSettings, basicPlusDA, gross int64, month int) statutory {
	var out statutory
	if set.PFEnabled && basicPlusDA > 0 {
		wage := basicPlusDA
		if set.PFCeilingPaise > 0 && wage > set.PFCeilingPaise {
			wage = set.PFCeilingPaise
		}
		out.PFWage = wage
		out.PFEmployee = pct(wage, set.PFEmployeePct)
		employer := pct(wage, set.PFEmployerPct)
		out.EPS = pct(wage, set.EPSPct)
		if out.EPS > employer {
			out.EPS = employer
		}
		// The employer's share less the pension part is what reaches the PF
		// account; the two must add back to the employer's contribution.
		out.PFEmployer = employer - out.EPS
		out.PFAdmin = pct(wage, set.PFAdminPct)
	}
	if set.ESIEnabled && gross > 0 && gross <= set.ESIThresholdPaise {
		out.ESIEmployee = pct(gross, set.ESIEmployeePct)
		out.ESIEmployer = pct(gross, set.ESIEmployerPct)
	}
	if set.PTEnabled {
		out.PT = professionalTax(set.Slabs, gross, month)
	}
	return out
}

// pct is a percentage of a paise amount, rounded to the nearest paisa. Integer
// arithmetic throughout: a rupee that rounds differently in the register and
// the payslip is a reconciliation nobody can close.
func pct(amount int64, percent float64) int64 {
	return int64(float64(amount)*percent/100 + 0.5)
}

// professionalTax finds the slab a wage falls in. Slabs are half-open — from
// inclusive, to exclusive — so a wage exactly on a boundary lands in exactly
// one of them.
func professionalTax(slabs []ptSlab, gross int64, month int) int64 {
	for _, sl := range slabs {
		if gross < sl.From {
			continue
		}
		if sl.To != nil && gross >= *sl.To {
			continue
		}
		if month == 2 && sl.February != nil {
			return *sl.February
		}
		return sl.Monthly
	}
	return 0
}

// --- the statutory register -----------------------------------------------

type statutoryRow struct {
	EmployeeID   string  `json:"employee_id"`
	EmployeeCode string  `json:"employee_code"`
	Name         string  `json:"full_name"`
	UAN          *string `json:"uan,omitempty"`
	ESINumber    *string `json:"esi_number,omitempty"`
	PAN          *string `json:"pan,omitempty"`
	Gross        int64   `json:"gross_paise"`
	BasicDA      int64   `json:"basic_da_paise"`
	statutory
	// Whether the employee is missing the number their return needs. The
	// register is filed as a batch, so one absent UAN fails the whole upload.
	Missing []string `json:"missing"`
}

/*
getStatutoryRegister is the month's PF, ESI and PT in one table.

	Computed from the payslips actually issued rather than recomputed from
	structures, so the register and the payslips can never disagree — a school
	whose return says one thing and whose payslip says another is a school with
	an inspection problem.
*/
func (s *Server) getStatutoryRegister(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	year, month := periodFrom(r)

	type row struct {
		statutoryRow
	}
	var out []statutoryRow
	var set payrollSettings
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		if set, err = loadPayrollSettings(r, tx, id.InstitutionID); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT e.id::text, COALESCE(e.employee_code,''),
			       concat_ws(' ', e.first_name, e.last_name),
			       e.uan, e.esi_number, e.pan,
			       ps.gross_paise,
			       -- Basic and DA out of the stored breakup. Reading the payslip
			       -- rather than the structure is what keeps the register and
			       -- the payslip in agreement.
			       COALESCE((ps.breakup->>'BASIC')::bigint, 0)
			         + COALESCE((ps.breakup->>'DA')::bigint, 0)
			  FROM payslips ps
			  JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
			  JOIN employees e ON e.id = ps.employee_id
			 WHERE pr.period_year = $1 AND pr.period_month = $2
			 ORDER BY e.employee_code, e.first_name`, year, month)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v statutoryRow
			if err := rows.Scan(&v.EmployeeID, &v.EmployeeCode, &v.Name, &v.UAN,
				&v.ESINumber, &v.PAN, &v.Gross, &v.BasicDA); err != nil {
				return err
			}
			v.statutory = computeStatutory(set, v.BasicDA, v.Gross, month)
			v.Missing = []string{}
			if v.PFEmployee > 0 && (v.UAN == nil || *v.UAN == "") {
				v.Missing = append(v.Missing, "UAN")
			}
			if v.ESIEmployee > 0 && (v.ESINumber == nil || *v.ESINumber == "") {
				v.Missing = append(v.Missing, "ESI number")
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var t statutory
	for _, v := range out {
		t.PFEmployee += v.PFEmployee
		t.PFEmployer += v.PFEmployer
		t.EPS += v.EPS
		t.PFAdmin += v.PFAdmin
		t.ESIEmployee += v.ESIEmployee
		t.ESIEmployer += v.ESIEmployer
		t.PT += v.PT
	}
	if out == nil {
		out = []statutoryRow{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": out, "totals": t, "year": year, "month": month,
		"pf_establishment_code": set.PFCode, "esi_code": set.ESICode,
	})
}

/*
getECRFile writes the EPFO's Electronic Challan cum Return.

	The format is fixed by EPFO: 11 hash-separated fields per member, no header,
	one line each. Served as a download rather than JSON because the portal
	takes a file, and a clerk copying numbers off a screen into a text editor is
	how a return gets filed wrong.
*/
func (s *Server) getECRFile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	year, month := periodFrom(r)

	var b strings.Builder
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := loadPayrollSettings(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT COALESCE(e.uan,''), concat_ws(' ', e.first_name, e.last_name),
			       ps.gross_paise,
			       COALESCE((ps.breakup->>'BASIC')::bigint,0)
			         + COALESCE((ps.breakup->>'DA')::bigint,0),
			       ps.lop_days
			  FROM payslips ps
			  JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
			  JOIN employees e ON e.id = ps.employee_id
			 WHERE pr.period_year = $1 AND pr.period_month = $2
			 ORDER BY e.uan`, year, month)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var uan, name string
			var gross, basicDA int64
			var lop float64
			if err := rows.Scan(&uan, &name, &gross, &basicDA, &lop); err != nil {
				return err
			}
			st := computeStatutory(set, basicDA, gross, month)
			if st.PFEmployee == 0 {
				continue
			}
			// EPFO works in whole rupees, so every amount is divided here and
			// nowhere else — rounding twice is how a challan fails to tally.
			fmt.Fprintf(&b, "%s#~#%s#~#%d#~#%d#~#%d#~#%d#~#%d#~#%d#~#%d#~#%d#~#%.0f\n",
				uan, name,
				st.PFWage/100, st.PFWage/100, st.PFWage/100, 0,
				st.PFEmployee/100, st.PFEmployer/100, st.EPS/100, 0, lop)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="ecr-%d-%02d.txt"`, year, month))
	_, _ = w.Write([]byte(b.String()))
}

/*
getBankFile writes the salary transfer list.

	CSV with the columns every Indian bank's bulk-transfer upload wants, in the
	order they want them. An employee with no account number is written into
	the file with an empty column rather than skipped: a silently shorter file
	is how one person goes unpaid and nobody notices until they say so.
*/
func (s *Server) getBankFile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	year, month := periodFrom(r)

	var b strings.Builder
	b.WriteString("Beneficiary Name,Account Number,IFSC,Amount,Narration\n")
	var missing int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT concat_ws(' ', e.first_name, e.last_name),
			       COALESCE(e.bank_account,''), COALESCE(e.bank_ifsc,''), ps.net_paise
			  FROM payslips ps
			  JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
			  JOIN employees e ON e.id = ps.employee_id
			 WHERE pr.period_year = $1 AND pr.period_month = $2
			 ORDER BY e.employee_code, e.first_name`, year, month)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var name, acct, ifsc string
			var net int64
			if err := rows.Scan(&name, &acct, &ifsc, &net); err != nil {
				return err
			}
			if acct == "" || ifsc == "" {
				missing++
			}
			fmt.Fprintf(&b, "%s,%s,%s,%.2f,Salary %02d/%d\n",
				csvSafe(name), acct, ifsc, float64(net)/100, month, year)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="salary-%d-%02d.csv"`, year, month))
	// The count of unpayable rows travels in a header so the screen can warn
	// without having to parse the file it just downloaded.
	w.Header().Set("X-Missing-Bank-Details", strconv.Itoa(missing))
	_, _ = w.Write([]byte(b.String()))
}

// csvSafe strips the two characters that would break a row. Quoting would be
// more correct, but bank upload parsers are famously literal.
func csvSafe(s string) string {
	return strings.NewReplacer(",", " ", "\n", " ", "\r", " ").Replace(s)
}

// --- CTC ------------------------------------------------------------------

type ctcBreakup struct {
	EmployeeID   string    `json:"employee_id"`
	Name         string    `json:"full_name"`
	Earnings     []ctcLine `json:"earnings"`
	GrossMonthly int64     `json:"gross_monthly_paise"`
	Statutory    statutory `json:"statutory"`
	Deductions   int64     `json:"employee_deductions_paise"`
	NetMonthly   int64     `json:"net_monthly_paise"`
	// The employer's own cost on top of gross — PF, pension, ESI, admin
	// charges. This is the whole reason CTC and gross differ, and the number
	// an employee is most often surprised by.
	EmployerCost   int64 `json:"employer_cost_paise"`
	CTCMonthly     int64 `json:"ctc_monthly_paise"`
	CTCAnnual      int64 `json:"ctc_annual_paise"`
	GratuityAnnual int64 `json:"gratuity_accrual_annual_paise"`
}

type ctcLine struct {
	Code   string `json:"code"`
	Name   string `json:"name"`
	Amount int64  `json:"amount_paise"`
}

func (s *Server) getCTCBreakup(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	employee, err := uuid.Parse(r.URL.Query().Get("employee_id"))
	if err != nil {
		httpx.BadRequest(w, r, "employee_id must be a uuid")
		return
	}

	var out ctcBreakup
	out.EmployeeID = employee.String()
	out.Earnings = []ctcLine{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := loadPayrollSettings(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(),
			`SELECT concat_ws(' ', first_name, last_name) FROM employees WHERE id = $1`,
			employee).Scan(&out.Name); err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT sc.code, sc.name, sc.kind, ssi.amount_paise
			  FROM salary_structures ss
			  JOIN salary_structure_items ssi ON ssi.salary_structure_id = ss.id
			  JOIN salary_components sc ON sc.id = ssi.component_id
			 WHERE ss.employee_id = $1
			   AND ss.effective_from <= current_date
			   AND (ss.effective_to IS NULL OR ss.effective_to >= current_date)
			 ORDER BY sc.sequence`, employee)
		if err != nil {
			return err
		}
		defer rows.Close()
		var basicDA int64
		for rows.Next() {
			var code, name, kind string
			var amt int64
			if err := rows.Scan(&code, &name, &kind, &amt); err != nil {
				return err
			}
			if kind != "earning" {
				continue
			}
			out.Earnings = append(out.Earnings, ctcLine{code, name, amt})
			out.GrossMonthly += amt
			if code == "BASIC" || code == "DA" {
				basicDA += amt
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}

		out.Statutory = computeStatutory(set, basicDA, out.GrossMonthly, int(monthNow()))
		out.Deductions = out.Statutory.PFEmployee + out.Statutory.ESIEmployee + out.Statutory.PT
		out.NetMonthly = out.GrossMonthly - out.Deductions
		out.EmployerCost = out.Statutory.PFEmployer + out.Statutory.EPS +
			out.Statutory.PFAdmin + out.Statutory.ESIEmployer
		out.CTCMonthly = out.GrossMonthly + out.EmployerCost
		out.CTCAnnual = out.CTCMonthly * 12
		// A year's gratuity accrual, which a school owes whether or not it has
		// set money aside. Shown in CTC because it is a real cost of the year.
		if set.GratuityMonthDays > 0 {
			out.GratuityAnnual = basicDA * int64(set.GratuityDays) / int64(set.GratuityMonthDays)
		}
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
	httpx.JSON(w, http.StatusOK, out)
}

// --- gratuity -------------------------------------------------------------

type gratuityRow struct {
	EmployeeID string  `json:"employee_id"`
	Name       string  `json:"full_name"`
	JoinedOn   string  `json:"joined_on"`
	Years      float64 `json:"years_of_service"`
	// Rounded the way the Act does: a part-year over six months counts as a
	// whole one. Schools that floor it under-provide, which an actuary finds.
	CountedYears int   `json:"counted_years"`
	BasicDA      int64 `json:"basic_da_paise"`
	// What has built up, and what would actually be payable if they walked out
	// today. They differ for everyone under five years, and reporting the
	// first as though it were the second overstates what a school owes.
	Accrued  int64 `json:"accrued_paise"`
	Vested   int64 `json:"vested_paise"`
	Eligible bool  `json:"eligible"`
	// No salary structure means no wage to compute on, which reads as a zero
	// liability and is really an unanswerable question.
	NoStructure bool `json:"no_salary_structure"`
}

/*
getGratuityLiability estimates the school's gratuity exposure.

	Two totals, because they answer different questions. Vested is what would
	actually have to be paid if everybody resigned this afternoon — nothing at
	all for anyone under five years, however long they have been accruing.
	Accrued is what has built up regardless, which is the number a governing
	body provisions against, since most of those people will cross five years.

	Reporting accrual as liability overstates what a school owes; reporting
	only the vested part hides a bill that arrives all at once.
*/
func (s *Server) getGratuityLiability(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var out []gratuityRow
	var total, eligibleTotal int64
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		set, err := loadPayrollSettings(r, tx, id.InstitutionID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `
			SELECT e.id::text, concat_ws(' ', e.first_name, e.last_name),
			       to_char(e.joined_on,'YYYY-MM-DD'),
			       EXTRACT(epoch FROM age(current_date, e.joined_on)) / (365.25*86400),
			       COALESCE((
			           SELECT sum(ssi.amount_paise)
			             FROM salary_structures ss
			             JOIN salary_structure_items ssi ON ssi.salary_structure_id = ss.id
			             JOIN salary_components sc ON sc.id = ssi.component_id
			            WHERE ss.employee_id = e.id
			              AND sc.code IN ('BASIC','DA')
			              AND ss.effective_from <= current_date
			              AND (ss.effective_to IS NULL OR ss.effective_to >= current_date)
			       ), 0)
			  FROM employees e
			 WHERE e.status = 'active' AND e.joined_on IS NOT NULL
			 ORDER BY e.joined_on`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v gratuityRow
			if err := rows.Scan(&v.EmployeeID, &v.Name, &v.JoinedOn, &v.Years, &v.BasicDA); err != nil {
				return err
			}
			v.CountedYears = int(v.Years)
			if v.Years-float64(v.CountedYears) > 0.5 {
				v.CountedYears++
			}
			v.Eligible = v.Years >= float64(set.GratuityMinYears)
			v.NoStructure = v.BasicDA == 0
			if set.GratuityMonthDays > 0 {
				v.Accrued = v.BasicDA * int64(set.GratuityDays) *
					int64(v.CountedYears) / int64(set.GratuityMonthDays)
				if set.GratuityCapPaise > 0 && v.Accrued > set.GratuityCapPaise {
					v.Accrued = set.GratuityCapPaise
				}
			}
			if v.Eligible {
				v.Vested = v.Accrued
			}
			total += v.Accrued
			eligibleTotal += v.Vested
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if out == nil {
		out = []gratuityRow{}
	}
	var unknown int
	for _, v := range out {
		if v.NoStructure {
			unknown++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":               out,
		"total_accrued_paise": total,
		"vested_paise":        eligibleTotal,
		// Staff whose exposure cannot be computed at all, so a zero total is
		// never mistaken for a settled question.
		"staff_without_salary_structure": unknown,
	})
}

// periodFrom reads a year and month from the query, defaulting to last month —
// the one a payroll office is usually filing for.
func periodFrom(r *http.Request) (int, int) {
	y, _ := strconv.Atoi(r.URL.Query().Get("year"))
	m, _ := strconv.Atoi(r.URL.Query().Get("month"))
	if y == 0 || m < 1 || m > 12 {
		now := nowInIndia()
		y, m = now.Year(), int(now.Month())-1
		if m == 0 {
			y, m = y-1, 12
		}
	}
	return y, m
}

func monthNow() int { return int(nowInIndia().Month()) }
