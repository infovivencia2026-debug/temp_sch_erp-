package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The books.

   A chart of accounts, double-entry vouchers, the payables and asset registers
   that feed them, and the reports a trustee and an auditor each ask for.

   Every write in this file ends in a balanced voucher. Nothing here trusts
   itself to keep the books straight: the balance rule, the closed-year rule
   and the group-account rule are all constraint triggers in
   00033_ledgers.sql, and the checks below exist only to turn a database
   refusal into a sentence a clerk can act on. If a handler in this file is
   ever wrong, the database still refuses the write.

   Money is int64 paise throughout. */

// mountLedgers registers the accounting endpoints inside the existing /finance
// group, which already carries RequirePermission(InvoicesRead). Reads inherit
// that; writes name their own permission.
//
// Only permissions the Accounts & Finance role already holds are used. The
// fixed asset register is gated on PaymentsWrite rather than the
// operations.assets.write that its name suggests, because depreciation is an
// accounting entry and the operations role — which holds AssetsWrite — has no
// business posting to the general ledger. See PROBLEMS in the handover.
func (s *Server) mountLedgers(r chi.Router) {
	// Posting money, and anything that ends in a voucher.
	post := httpx.RequirePermission(rbac.PaymentsWrite)
	// Finance master data: the chart of accounts, the vendor directory, budgets.
	masters := httpx.RequirePermission(rbac.FeesWrite)

	// --- chart of accounts -------------------------------------------------
	r.Get("/ledgers/accounts", s.listLedgerAccounts)
	r.With(masters).Post("/ledgers/accounts", s.saveLedgerAccount)
	r.Get("/ledgers/settings", s.getLedgerSettings)
	r.With(masters).Post("/ledgers/settings", s.saveLedgerSettings)

	// --- general ledger ----------------------------------------------------
	r.Get("/ledgers/vouchers", s.listVouchers)
	r.Get("/ledgers/vouchers/{id}", s.getVoucher)
	r.With(post).Post("/ledgers/vouchers", s.postJournalVoucher)
	r.Get("/ledgers/trial-balance", s.getTrialBalance)
	r.Get("/ledgers/account-ledger", s.getAccountLedger)
	r.Get("/ledgers/statements", s.getStatements)

	// --- expenses ----------------------------------------------------------
	r.Get("/ledgers/expenses", s.getExpenseAnalysis)
	r.With(post).Post("/ledgers/expenses", s.recordDirectExpense)

	// --- the year ----------------------------------------------------------
	r.Get("/ledgers/years", s.listAccountingYears)
	r.With(post).Post("/ledgers/years/close", s.closeAccountingYear)

	// --- payables ----------------------------------------------------------
	r.Get("/ledgers/vendors", s.listVendors)
	r.With(masters).Post("/ledgers/vendors", s.saveVendor)
	r.Get("/ledgers/bills", s.listVendorBills)
	r.With(post).Post("/ledgers/bills", s.saveVendorBill)
	r.With(post).Post("/ledgers/bills/{id}/approve", s.approveVendorBill)
	r.With(post).Post("/ledgers/bills/{id}/pay", s.payVendorBill)

	// --- petty cash --------------------------------------------------------
	r.Get("/ledgers/petty-cash", s.listPettyCash)
	r.With(post).Post("/ledgers/petty-cash", s.raisePettyCash)
	r.With(post).Post("/ledgers/petty-cash/{id}/decide", s.decidePettyCash)

	// --- assets ------------------------------------------------------------
	r.Get("/ledgers/assets", s.listFixedAssets)
	r.With(post).Post("/ledgers/assets", s.saveFixedAsset)
	r.With(post).Post("/ledgers/assets/depreciate", s.runDepreciation)

	// --- budgets -----------------------------------------------------------
	r.Get("/ledgers/budgets", s.getBudgetVariance)
	r.With(masters).Post("/ledgers/budgets", s.saveBudget)
	r.With(masters).Post("/ledgers/budgets/lines", s.saveBudgetLine)

	// --- reports -----------------------------------------------------------
	r.Get("/ledgers/daybook", s.getDaybook)
	r.Get("/ledgers/cashbook", s.getCashbook)
	r.Get("/ledgers/tax-report", s.getTaxReport)
	r.Get("/ledgers/audit-report", s.getAuditReport)

	// --- the fee posting contract -------------------------------------------
	r.Get("/ledgers/fee-posting", s.previewFeePosting)
	r.With(post).Post("/ledgers/fee-posting", s.runFeePosting)
}

// --- shared plumbing ---------------------------------------------------------

/*
fyRange is the Indian financial year as dates: April the first to March the
thirty-first.

	Stated once. Every handler below that needs a period asks for it here rather
	than assembling the dates itself, because a January entry filed under the
	wrong year is the defining bug of Indian accounting software and it only
	ever arrives through a second, slightly different, copy of this arithmetic.
*/
func fyRange(fy int) (time.Time, time.Time) {
	return time.Date(fy, time.April, 1, 0, 0, 0, 0, time.UTC),
		time.Date(fy+1, time.March, 31, 0, 0, 0, 0, time.UTC)
}

// fyLabel renders 2026 as "2026-27", which is how every Indian financial
// document names the year.
func fyLabel(fy int) string {
	return fmt.Sprintf("%d-%02d", fy, (fy+1)%100)
}

// voucherLine is one side of one posting.
type voucherLine struct {
	AccountID uuid.UUID
	Debit     int64
	Credit    int64
	Memo      string
}

/*
postVoucher writes a balanced voucher and returns its number.

	The balance check here is a courtesy, not the guarantee. The guarantee is
	the deferred constraint trigger in the migration, which fires at COMMIT and
	cannot be talked out of it. Checking first simply means the clerk is told
	"debits 5,000 credits 4,900" at the point of saving rather than receiving a
	transaction failure from somewhere deeper.

	sourceKind and sourceID tie the voucher to the business fact that caused it.
	A unique index on the pair makes posting the same fact twice impossible, so
	a retried request cannot double-count.
*/
func postVoucher(ctx context.Context, tx pgx.Tx, instID, userID uuid.UUID,
	voucherType, prefix string, date time.Time, narration string,
	sourceKind string, sourceID *uuid.UUID, lines []voucherLine) (uuid.UUID, string, error) {

	if len(lines) < 2 {
		return uuid.Nil, "", refusef("a voucher needs at least two lines, got %d", len(lines))
	}
	var dr, cr int64
	for _, l := range lines {
		if l.Debit < 0 || l.Credit < 0 {
			return uuid.Nil, "", refusal("a voucher line cannot be negative: use the other side")
		}
		if l.Debit > 0 && l.Credit > 0 {
			return uuid.Nil, "", refusal("a voucher line carries a debit or a credit, never both")
		}
		dr += l.Debit
		cr += l.Credit
	}
	if dr != cr {
		return uuid.Nil, "", refusef(
			"voucher does not balance: debits %s, credits %s",
			indianRupees(dr), indianRupees(cr))
	}

	fy := date.Year()
	if date.Month() < time.April {
		fy--
	}
	series := fmt.Sprintf("%s/%s/", prefix, fyLabel(fy))

	/* Serialise this series for the rest of the transaction.

	   Without it two clerks saving in the same millisecond read the same
	   maximum and the second insert fails on the unique index — correct, but a
	   voucher somebody has to enter twice. The lock is released at commit and
	   is scoped to this school's series, so it never blocks anything else. */
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtext($1))`, instID.String()+series); err != nil {
		return uuid.Nil, "", err
	}

	/* Make sure the year this entry falls in is on record.

	   Without this a backdated voucher lands in a financial year that has no
	   accounting_years row, and that year can then never be closed — the
	   closing handler has nothing to lock or mark. The row is what makes a year
	   closeable, so it is created by the first entry to fall in it rather than
	   by a setup step somebody has to remember. A year already on record, open
	   or closed, is left exactly as it is. */
	if _, err := tx.Exec(ctx, `
		INSERT INTO accounting_years (institution_id, fy_start_year)
		VALUES ($1, $2) ON CONFLICT (institution_id, fy_start_year) DO NOTHING`,
		instID, fy); err != nil {
		return uuid.Nil, "", err
	}

	var entryID uuid.UUID
	var voucherNo string
	// Gapless within the series, allocated inside the transaction: a numbered
	// book with a hole in it is a book somebody has to explain.
	if err := tx.QueryRow(ctx, `
		INSERT INTO journal_entries
		    (institution_id, voucher_no, voucher_type, entry_date, narration,
		     source_kind, source_id, posted_by)
		SELECT $1,
		       $2 || lpad((COALESCE(max(substring(e.voucher_no from '[0-9]+$')::int), 0) + 1)::text, 4, '0'),
		       $3, $4, $5, NULLIF($6,''), $7, $8
		  FROM journal_entries e
		 WHERE e.institution_id = $1 AND e.voucher_no LIKE $2 || '%'
		RETURNING id, voucher_no`,
		instID, series, voucherType, date, narration,
		sourceKind, sourceID, nullUUIDArg(userID)).Scan(&entryID, &voucherNo); err != nil {
		return uuid.Nil, "", err
	}

	for i, l := range lines {
		if _, err := tx.Exec(ctx, `
			INSERT INTO journal_lines
			    (institution_id, entry_id, account_id, line_no, debit_paise, credit_paise, memo)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''))`,
			instID, entryID, l.AccountID, i+1, l.Debit, l.Credit, l.Memo); err != nil {
			return uuid.Nil, "", err
		}
	}
	return entryID, voucherNo, nil
}

/*
refusal is a rule this domain enforced itself, rather than a failure.

	"The books for 2026-27 are already closed" and "the bill is already
	approved" are answers, not faults, and both were being returned as 500s
	because a plain error raised inside a transaction closure is
	indistinguishable from a dropped connection. A distinct type is what lets
	ledgerFail tell the clerk something useful instead of "something went
	wrong".
*/
type refusal string

func (e refusal) Error() string { return string(e) }

func refusef(format string, a ...any) error { return refusal(fmt.Sprintf(format, a...)) }

/*
ledgerRefusal recognises a rule the database enforced.

	The balance trigger, the closed-year trigger and the overpayment trigger all
	raise check_violation with a message written for a human. Passing that
	message straight through as a 400 is far better than swallowing it into a
	500: "the books for 2025-26 are closed" tells the clerk what to do, and
	"internal error" does not.
*/
func ledgerRefusal(err error) (string, bool) {
	var pge *pgconn.PgError
	if !errors.As(err, &pge) {
		return "", false
	}
	switch pge.Code {
	case "23514": // check_violation, including every RAISE in the triggers
		if pge.Message != "" && !strings.HasPrefix(pge.Message, "new row for relation") {
			return pge.Message, true
		}
		return "that entry breaks an accounting rule: " + pge.ConstraintName, true
	case "23505": // unique_violation
		return "that already exists: " + pge.ConstraintName, true
	case "23503": // foreign_key_violation
		return "that refers to something which does not exist", true
	}
	return "", false
}

// ledgerFail maps a write failure to the most honest status code available.
func ledgerFail(w http.ResponseWriter, r *http.Request, err error) {
	var ref refusal
	if errors.As(err, &ref) {
		httpx.BadRequest(w, r, string(ref))
		return
	}
	if msg, ok := ledgerRefusal(err); ok {
		httpx.BadRequest(w, r, msg)
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	httpx.Internal(w, r, err)
}

// controlAccounts is the set of accounts the automatic postings need.
type controlAccounts struct {
	Cash, Bank, PettyCash             uuid.UUID
	FeeReceivable, FeeIncome, Payable uuid.UUID
	Depreciation, Accumulated         uuid.UUID
	Surplus                           uuid.UUID
}

/*
loadControls reads the school's control accounts.

	Every one is required by the caller that asks for it, and a missing one is
	reported by name rather than defaulted. Guessing "they probably meant Cash
	in Hand" is how a school's receipts end up in an account nobody reconciles.
*/
func loadControls(ctx context.Context, tx pgx.Tx, instID uuid.UUID) (controlAccounts, error) {
	var c controlAccounts
	var cash, bank, petty, recv, income, payable, dep, accum, surplus *uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT cash_account_id, bank_account_id, petty_cash_account_id,
		       fee_receivable_account_id, fee_income_account_id, payable_account_id,
		       depreciation_expense_account_id, accumulated_depreciation_account_id,
		       surplus_account_id
		  FROM ledger_settings WHERE institution_id = $1`, instID).
		Scan(&cash, &bank, &petty, &recv, &income, &payable, &dep, &accum, &surplus)
	if err != nil {
		return c, err
	}
	deref := func(p *uuid.UUID) uuid.UUID {
		if p == nil {
			return uuid.Nil
		}
		return *p
	}
	c.Cash, c.Bank, c.PettyCash = deref(cash), deref(bank), deref(petty)
	c.FeeReceivable, c.FeeIncome, c.Payable = deref(recv), deref(income), deref(payable)
	c.Depreciation, c.Accumulated, c.Surplus = deref(dep), deref(accum), deref(surplus)
	return c, nil
}

// require names the first unset control account, so the error says which one.
func (c controlAccounts) require(pairs ...any) error {
	for i := 0; i+1 < len(pairs); i += 2 {
		id, _ := pairs[i].(uuid.UUID)
		name, _ := pairs[i+1].(string)
		if id == uuid.Nil {
			return refusef("no %s account is set: choose one on the chart of accounts screen", name)
		}
	}
	return nil
}

// parseDate reads a YYYY-MM-DD, falling back to today.
func parseDate(v string, fallback time.Time) (time.Time, error) {
	if strings.TrimSpace(v) == "" {
		return fallback, nil
	}
	return time.Parse(time.DateOnly, v)
}

// --- chart of accounts -------------------------------------------------------

type ledgerAccountRow struct {
	ID         string  `json:"id"`
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	NormalSide string  `json:"normal_side"`
	ParentID   *string `json:"parent_id,omitempty"`
	ParentCode *string `json:"parent_code,omitempty"`
	IsGroup    bool    `json:"is_group"`
	IsCash     bool    `json:"is_cash"`
	IsContra   bool    `json:"is_contra"`
	IsActive   bool    `json:"is_active"`
	IsSystem   bool    `json:"is_system"`
	Depth      int     `json:"depth"`
	// The balance to date, so the setup screen is also a statement of position
	// rather than a list of names.
	BalancePaise int64 `json:"balance_paise"`
	Postings     int   `json:"postings"`
}

/*
listLedgerAccounts returns the whole chart, ordered as a tree.

	Depth comes from a recursive walk rather than from the code's shape: a
	school that adds "5115 Bus Staff Salaries" under Employee Costs must nest
	correctly, and inferring depth from the number of trailing zeros would put
	it at the top level.
*/
func (s *Server) listLedgerAccounts(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		WITH RECURSIVE tree AS (
		    SELECT a.id, 0 AS depth, a.code AS path
		      FROM ledger_accounts a WHERE a.parent_id IS NULL
		    UNION ALL
		    SELECT c.id, t.depth + 1, t.path || '/' || c.code
		      FROM ledger_accounts c JOIN tree t ON c.parent_id = t.id
		),
		bal AS (
		    SELECT l.account_id,
		           sum(l.debit_paise) - sum(l.credit_paise) AS net,
		           count(*) AS n
		      FROM journal_lines l GROUP BY l.account_id
		)
		SELECT a.id::text, a.code, a.name, a.type, a.normal_side,
		       a.parent_id::text, p.code, a.is_group, a.is_cash, a.is_contra,
		       a.is_active, a.is_system, t.depth,
		       COALESCE(bal.net, 0), COALESCE(bal.n, 0)::int
		  FROM ledger_accounts a
		  JOIN tree t ON t.id = a.id
		  LEFT JOIN ledger_accounts p ON p.id = a.parent_id
		  LEFT JOIN bal ON bal.account_id = a.id
		 ORDER BY t.path`, nil,
		func(rows pgx.Rows) (ledgerAccountRow, error) {
			var v ledgerAccountRow
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.Type, &v.NormalSide,
				&v.ParentID, &v.ParentCode, &v.IsGroup, &v.IsCash, &v.IsContra,
				&v.IsActive, &v.IsSystem, &v.Depth, &v.BalancePaise, &v.Postings)
		})
	respond(w, r, items, err)
}

type saveAccountRequest struct {
	ID       string `json:"id,omitempty"`
	Code     string `json:"code"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	ParentID string `json:"parent_id,omitempty"`
	IsGroup  bool   `json:"is_group,omitempty"`
	IsCash   bool   `json:"is_cash,omitempty"`
	IsActive *bool  `json:"is_active,omitempty"`
}

// saveLedgerAccount creates or amends one account.
func (s *Server) saveLedgerAccount(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req saveAccountRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.TrimSpace(req.Code)
	req.Name = strings.TrimSpace(req.Name)
	if req.Code == "" || req.Name == "" {
		httpx.BadRequest(w, r, "an account needs a code and a name")
		return
	}
	switch req.Type {
	case "asset", "liability", "income", "expense", "equity":
	default:
		httpx.BadRequest(w, r, "type must be asset, liability, income, expense or equity")
		return
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			accID, err := uuid.Parse(req.ID)
			if err != nil {
				return refusal("id must be a uuid")
			}
			/* A code or a type change on an account that already carries
			   postings would silently restate history: every entry ever made
			   against it moves to a different line of the balance sheet. The
			   name and the active flag stay editable because neither changes
			   what the figure means. */
			return tx.QueryRow(r.Context(), `
				UPDATE ledger_accounts
				   SET name = $2, is_active = COALESCE($3, is_active)
				 WHERE id = $1
				RETURNING id::text`, accID, req.Name, req.IsActive).Scan(&out)
		}
		var parent any
		if req.ParentID != "" {
			p, err := uuid.Parse(req.ParentID)
			if err != nil {
				return refusal("parent_id must be a uuid")
			}
			parent = p
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO ledger_accounts
			    (institution_id, code, name, type, parent_id, is_group, is_cash)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING id::text`,
			id.InstitutionID, req.Code, req.Name, req.Type, parent,
			req.IsGroup, req.IsCash).Scan(&out)
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out, "code": req.Code})
}

type ledgerSettingsPayload struct {
	CashAccountID          *string `json:"cash_account_id,omitempty"`
	BankAccountID          *string `json:"bank_account_id,omitempty"`
	PettyCashAccountID     *string `json:"petty_cash_account_id,omitempty"`
	FeeReceivableAccountID *string `json:"fee_receivable_account_id,omitempty"`
	FeeIncomeAccountID     *string `json:"fee_income_account_id,omitempty"`
	PayableAccountID       *string `json:"payable_account_id,omitempty"`
	DepreciationAccountID  *string `json:"depreciation_expense_account_id,omitempty"`
	AccumulatedAccountID   *string `json:"accumulated_depreciation_account_id,omitempty"`
	SurplusAccountID       *string `json:"surplus_account_id,omitempty"`
	PettyCashLimitPaise    int64   `json:"petty_cash_limit_paise"`
	DefaultMethod          string  `json:"default_depreciation_method"`
}

func (s *Server) getLedgerSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var out ledgerSettingsPayload
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT cash_account_id::text, bank_account_id::text, petty_cash_account_id::text,
			       fee_receivable_account_id::text, fee_income_account_id::text,
			       payable_account_id::text, depreciation_expense_account_id::text,
			       accumulated_depreciation_account_id::text, surplus_account_id::text,
			       petty_cash_limit_paise, default_depreciation_method
			  FROM ledger_settings WHERE institution_id = $1`, id.InstitutionID).
			Scan(&out.CashAccountID, &out.BankAccountID, &out.PettyCashAccountID,
				&out.FeeReceivableAccountID, &out.FeeIncomeAccountID, &out.PayableAccountID,
				&out.DepreciationAccountID, &out.AccumulatedAccountID, &out.SurplusAccountID,
				&out.PettyCashLimitPaise, &out.DefaultMethod)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// A school provisioned before this migration ran has no settings row.
		// An empty shape is a truer answer than a 404 the screen cannot use.
		httpx.JSON(w, http.StatusOK, ledgerSettingsPayload{DefaultMethod: "straight_line"})
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) saveLedgerSettings(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req ledgerSettingsPayload
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.DefaultMethod == "" {
		req.DefaultMethod = "straight_line"
	}
	if req.DefaultMethod != "straight_line" && req.DefaultMethod != "wdv" {
		httpx.BadRequest(w, r, "depreciation method must be straight_line or wdv")
		return
	}
	acc := func(p *string) any {
		if p == nil || *p == "" {
			return nil
		}
		v, err := uuid.Parse(*p)
		if err != nil {
			return nil
		}
		return v
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO ledger_settings (institution_id, cash_account_id, bank_account_id,
			    petty_cash_account_id, fee_receivable_account_id, fee_income_account_id,
			    payable_account_id, depreciation_expense_account_id,
			    accumulated_depreciation_account_id, surplus_account_id,
			    petty_cash_limit_paise, default_depreciation_method)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
			ON CONFLICT (institution_id) DO UPDATE SET
			    cash_account_id = EXCLUDED.cash_account_id,
			    bank_account_id = EXCLUDED.bank_account_id,
			    petty_cash_account_id = EXCLUDED.petty_cash_account_id,
			    fee_receivable_account_id = EXCLUDED.fee_receivable_account_id,
			    fee_income_account_id = EXCLUDED.fee_income_account_id,
			    payable_account_id = EXCLUDED.payable_account_id,
			    depreciation_expense_account_id = EXCLUDED.depreciation_expense_account_id,
			    accumulated_depreciation_account_id = EXCLUDED.accumulated_depreciation_account_id,
			    surplus_account_id = EXCLUDED.surplus_account_id,
			    petty_cash_limit_paise = EXCLUDED.petty_cash_limit_paise,
			    default_depreciation_method = EXCLUDED.default_depreciation_method,
			    updated_at = now()`,
			id.InstitutionID, acc(req.CashAccountID), acc(req.BankAccountID),
			acc(req.PettyCashAccountID), acc(req.FeeReceivableAccountID),
			acc(req.FeeIncomeAccountID), acc(req.PayableAccountID),
			acc(req.DepreciationAccountID), acc(req.AccumulatedAccountID),
			acc(req.SurplusAccountID), req.PettyCashLimitPaise, req.DefaultMethod)
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

// --- vouchers ----------------------------------------------------------------

type voucherRow struct {
	ID          string  `json:"id"`
	VoucherNo   string  `json:"voucher_no"`
	VoucherType string  `json:"voucher_type"`
	EntryDate   string  `json:"entry_date"`
	FY          int     `json:"fy_start_year"`
	Narration   string  `json:"narration"`
	SourceKind  *string `json:"source_kind,omitempty"`
	AmountPaise int64   `json:"amount_paise"`
	Lines       int     `json:"lines"`
	PostedBy    *string `json:"posted_by,omitempty"`
	Accounts    string  `json:"accounts"`
	YearClosed  bool    `json:"year_closed"`
}

/*
listVouchers is the voucher register.

	amount is the debit total, which for a balanced voucher is the value of the
	transaction. Summing both sides would report every voucher at twice its
	worth, which is the classic first bug of a voucher list.
*/
func (s *Server) listVouchers(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, to := fyRange(fyFrom(r))
	if v, err := parseDate(q.Get("from"), from); err == nil {
		from = v
	}
	if v, err := parseDate(q.Get("to"), to); err == nil {
		to = v
	}
	items, err := collect(s, r, `
		SELECT e.id::text, e.voucher_no, e.voucher_type,
		       to_char(e.entry_date,'YYYY-MM-DD'), e.fy_start_year, e.narration,
		       e.source_kind,
		       COALESCE((SELECT sum(l.debit_paise) FROM journal_lines l WHERE l.entry_id = e.id), 0),
		       COALESCE((SELECT count(*) FROM journal_lines l WHERE l.entry_id = e.id), 0)::int,
		       u.full_name,
		       COALESCE((SELECT string_agg(DISTINCT a.name, ', ')
		                   FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
		                  WHERE l.entry_id = e.id), ''),
		       EXISTS (SELECT 1 FROM accounting_years y
		                WHERE y.institution_id = e.institution_id
		                  AND y.fy_start_year = e.fy_start_year AND y.status = 'closed')
		  FROM journal_entries e
		  LEFT JOIN users u ON u.id = e.posted_by
		 WHERE e.entry_date BETWEEN $1 AND $2
		   AND ($3 = '' OR e.voucher_type = $3)
		 ORDER BY e.entry_date DESC, e.voucher_no DESC
		 LIMIT 500`,
		[]any{from, to, q.Get("type")},
		func(rows pgx.Rows) (voucherRow, error) {
			var v voucherRow
			return v, rows.Scan(&v.ID, &v.VoucherNo, &v.VoucherType, &v.EntryDate, &v.FY,
				&v.Narration, &v.SourceKind, &v.AmountPaise, &v.Lines, &v.PostedBy,
				&v.Accounts, &v.YearClosed)
		})
	respond(w, r, items, err)
}

type voucherLineRow struct {
	AccountID   string  `json:"account_id"`
	Code        string  `json:"code"`
	Name        string  `json:"name"`
	DebitPaise  int64   `json:"debit_paise"`
	CreditPaise int64   `json:"credit_paise"`
	Memo        *string `json:"memo,omitempty"`
}

// getVoucher returns one voucher with its lines, which is what "drill down"
// means on every screen in this domain.
func (s *Server) getVoucher(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entryID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid voucher id")
		return
	}
	var head voucherRow
	lines := []voucherLineRow{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT e.id::text, e.voucher_no, e.voucher_type,
			       to_char(e.entry_date,'YYYY-MM-DD'), e.fy_start_year, e.narration,
			       e.source_kind, u.full_name,
			       EXISTS (SELECT 1 FROM accounting_years y
			                WHERE y.institution_id = e.institution_id
			                  AND y.fy_start_year = e.fy_start_year AND y.status = 'closed')
			  FROM journal_entries e
			  LEFT JOIN users u ON u.id = e.posted_by
			 WHERE e.id = $1`, entryID).
			Scan(&head.ID, &head.VoucherNo, &head.VoucherType, &head.EntryDate,
				&head.FY, &head.Narration, &head.SourceKind, &head.PostedBy,
				&head.YearClosed); err != nil {
			return err
		}
		return scanInto(r.Context(), tx, `
			SELECT a.id::text, a.code, a.name, l.debit_paise, l.credit_paise, l.memo
			  FROM journal_lines l
			  JOIN ledger_accounts a ON a.id = l.account_id
			 WHERE l.entry_id = '`+entryID.String()+`'::uuid
			 ORDER BY l.line_no`,
			func(rows pgx.Rows) error {
				var v voucherLineRow
				if err := rows.Scan(&v.AccountID, &v.Code, &v.Name,
					&v.DebitPaise, &v.CreditPaise, &v.Memo); err != nil {
					return err
				}
				head.AmountPaise += v.DebitPaise
				lines = append(lines, v)
				return nil
			})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	head.Lines = len(lines)
	httpx.JSON(w, http.StatusOK, map[string]any{"voucher": head, "lines": lines})
}

type postVoucherRequest struct {
	VoucherType string `json:"voucher_type,omitempty"`
	EntryDate   string `json:"entry_date,omitempty"`
	Narration   string `json:"narration"`
	Lines       []struct {
		AccountID   string `json:"account_id"`
		DebitPaise  int64  `json:"debit_paise,omitempty"`
		CreditPaise int64  `json:"credit_paise,omitempty"`
		Memo        string `json:"memo,omitempty"`
	} `json:"lines"`
}

// postJournalVoucher is manual double entry: the screen an accountant uses for
// everything the automatic postings do not cover.
func (s *Server) postJournalVoucher(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req postVoucherRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Narration) == "" {
		httpx.BadRequest(w, r, "say what this voucher is for")
		return
	}
	if req.VoucherType == "" {
		req.VoucherType = "journal"
	}
	date, err := parseDate(req.EntryDate, time.Now())
	if err != nil {
		httpx.BadRequest(w, r, "entry_date must be YYYY-MM-DD")
		return
	}

	lines := make([]voucherLine, 0, len(req.Lines))
	for _, l := range req.Lines {
		accID, err := uuid.Parse(l.AccountID)
		if err != nil {
			httpx.BadRequest(w, r, "every line needs an account_id")
			return
		}
		lines = append(lines, voucherLine{
			AccountID: accID, Debit: l.DebitPaise, Credit: l.CreditPaise, Memo: l.Memo,
		})
	}

	prefix := map[string]string{
		"receipt": "RV", "payment": "PV", "contra": "CV",
		"purchase": "PJ", "sales": "SV", "journal": "JV",
	}[req.VoucherType]
	if prefix == "" {
		httpx.BadRequest(w, r, "voucher_type must be journal, receipt, payment, contra, purchase or sales")
		return
	}

	var entryID uuid.UUID
	var voucherNo string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		entryID, voucherNo, err = postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
			req.VoucherType, prefix, date, strings.TrimSpace(req.Narration), "", nil, lines)
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": entryID.String(), "voucher_no": voucherNo,
	})
}

// --- trial balance and statements --------------------------------------------

type trialRow struct {
	AccountID     string `json:"account_id"`
	Code          string `json:"code"`
	Name          string `json:"name"`
	Type          string `json:"type"`
	OpeningDebit  int64  `json:"opening_debit_paise"`
	OpeningCredit int64  `json:"opening_credit_paise"`
	PeriodDebit   int64  `json:"period_debit_paise"`
	PeriodCredit  int64  `json:"period_credit_paise"`
	ClosingDebit  int64  `json:"closing_debit_paise"`
	ClosingCredit int64  `json:"closing_credit_paise"`
}

/*
getTrialBalance is the report the whole domain exists to produce.

	Four columns, not two: opening, the period's movement, and the closing
	position. Each column balances on its own and for a different reason —
	opening because every voucher before the period balanced, movement because
	every voucher inside it balanced, closing because it is the sum of two
	balanced columns. That is why this report cannot fail to balance unless the
	data itself is broken, and why the totals are returned rather than left for
	the client to add up: the check belongs next to the figures.

	Balances are split into a debit and a credit column rather than reported as
	one signed number, because that is what a trial balance is. A reader
	scanning for the account that is on the wrong side finds it instantly.
*/
func (s *Server) getTrialBalance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	fy := fyFrom(r)
	start, end := fyRange(fy)
	if v, err := parseDate(r.URL.Query().Get("as_on"), end); err == nil && !v.Before(start) {
		end = v
	}

	rowsOut := []trialRow{}
	var openDr, openCr, perDr, perCr, closeDr, closeCr int64

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT a.id::text, a.code, a.name, a.type,
			       COALESCE(sum(l.debit_paise)  FILTER (WHERE e.entry_date < $1), 0)
			     - COALESCE(sum(l.credit_paise) FILTER (WHERE e.entry_date < $1), 0),
			       COALESCE(sum(l.debit_paise)  FILTER (WHERE e.entry_date BETWEEN $1 AND $2), 0),
			       COALESCE(sum(l.credit_paise) FILTER (WHERE e.entry_date BETWEEN $1 AND $2), 0)
			  FROM ledger_accounts a
			  LEFT JOIN journal_lines l ON l.account_id = a.id
			  LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.entry_date <= $2
			 WHERE NOT a.is_group
			 GROUP BY a.id, a.code, a.name, a.type
			 ORDER BY a.code`, start, end)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v trialRow
			var opening, dr, cr int64
			if err := rows.Scan(&v.AccountID, &v.Code, &v.Name, &v.Type, &opening, &dr, &cr); err != nil {
				return err
			}
			// An account that has never been touched and holds nothing is
			// noise on a report somebody has to read line by line.
			if opening == 0 && dr == 0 && cr == 0 {
				continue
			}
			closing := opening + dr - cr
			if opening >= 0 {
				v.OpeningDebit = opening
			} else {
				v.OpeningCredit = -opening
			}
			v.PeriodDebit, v.PeriodCredit = dr, cr
			if closing >= 0 {
				v.ClosingDebit = closing
			} else {
				v.ClosingCredit = -closing
			}
			openDr += v.OpeningDebit
			openCr += v.OpeningCredit
			perDr += v.PeriodDebit
			perCr += v.PeriodCredit
			closeDr += v.ClosingDebit
			closeCr += v.ClosingCredit
			rowsOut = append(rowsOut, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"fy_start_year": fy,
		"fy_label":      fyLabel(fy),
		"from":          start.Format(time.DateOnly),
		"to":            end.Format(time.DateOnly),
		"rows":          rowsOut,
		"totals": map[string]any{
			"opening_debit_paise":  openDr,
			"opening_credit_paise": openCr,
			"period_debit_paise":   perDr,
			"period_credit_paise":  perCr,
			"closing_debit_paise":  closeDr,
			"closing_credit_paise": closeCr,
		},
		// Stated rather than implied. A screen that only shows two totals
		// leaves the reader to compare them; a report that says "balanced" and
		// is wrong is caught by the difference beside it.
		"balanced":         openDr == openCr && perDr == perCr && closeDr == closeCr,
		"difference_paise": closeDr - closeCr,
	})
}

type accountLedgerRow struct {
	Date         string  `json:"date"`
	VoucherNo    string  `json:"voucher_no"`
	VoucherType  string  `json:"voucher_type"`
	Narration    string  `json:"narration"`
	Contra       string  `json:"contra"`
	DebitPaise   int64   `json:"debit_paise"`
	CreditPaise  int64   `json:"credit_paise"`
	RunningPaise int64   `json:"running_paise"`
	Memo         *string `json:"memo,omitempty"`
}

/*
getAccountLedger is one account's own statement, with a running balance.

	Contra is the other side of the same voucher — for a two-line entry it is
	the single account the money came from or went to, which is the column that
	makes a ledger readable. A ledger listing only amounts forces the reader to
	open every voucher.
*/
func (s *Server) getAccountLedger(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	accID, err := uuid.Parse(r.URL.Query().Get("account_id"))
	if err != nil {
		httpx.BadRequest(w, r, "account_id must be a uuid")
		return
	}
	fy := fyFrom(r)
	start, end := fyRange(fy)

	var code, name, accType string
	var opening int64
	entries := []accountLedgerRow{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT a.code, a.name, a.type,
			       COALESCE((SELECT sum(l.debit_paise) - sum(l.credit_paise)
			                   FROM journal_lines l
			                   JOIN journal_entries e ON e.id = l.entry_id
			                  WHERE l.account_id = a.id AND e.entry_date < $2), 0)
			  FROM ledger_accounts a WHERE a.id = $1`, accID, start).
			Scan(&code, &name, &accType, &opening); err != nil {
			return err
		}
		running := opening
		rows, err := tx.Query(r.Context(), `
			SELECT to_char(e.entry_date,'YYYY-MM-DD'), e.voucher_no, e.voucher_type,
			       e.narration,
			       COALESCE((SELECT string_agg(DISTINCT a2.name, ', ')
			                   FROM journal_lines l2
			                   JOIN ledger_accounts a2 ON a2.id = l2.account_id
			                  WHERE l2.entry_id = e.id AND l2.account_id <> $1), ''),
			       l.debit_paise, l.credit_paise, l.memo
			  FROM journal_lines l
			  JOIN journal_entries e ON e.id = l.entry_id
			 WHERE l.account_id = $1 AND e.entry_date BETWEEN $2 AND $3
			 ORDER BY e.entry_date, e.voucher_no, l.line_no`, accID, start, end)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v accountLedgerRow
			if err := rows.Scan(&v.Date, &v.VoucherNo, &v.VoucherType, &v.Narration,
				&v.Contra, &v.DebitPaise, &v.CreditPaise, &v.Memo); err != nil {
				return err
			}
			running += v.DebitPaise - v.CreditPaise
			v.RunningPaise = running
			entries = append(entries, v)
		}
		return rows.Err()
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	closing := opening
	var dr, cr int64
	for _, e := range entries {
		dr += e.DebitPaise
		cr += e.CreditPaise
	}
	closing += dr - cr

	httpx.JSON(w, http.StatusOK, map[string]any{
		"account_id": accID.String(), "code": code, "name": name, "type": accType,
		"fy_start_year": fy, "fy_label": fyLabel(fy),
		"opening_paise": opening, "debit_paise": dr, "credit_paise": cr,
		"closing_paise": closing, "entries": entries,
	})
}

type statementRow struct {
	Code    string `json:"code"`
	Name    string `json:"name"`
	Group   string `json:"group"`
	Paise   int64  `json:"paise"`
	IsGroup bool   `json:"is_group"`
}

/*
getStatements is the income and expenditure account and the balance sheet.

	Two things here are easy to get wrong and both are deliberate.

	The income and expenditure account excludes closing vouchers. A close sweeps
	every income and expense account to nil, so a statement that counted the
	closing entry would report a closed year as having earned and spent exactly
	nothing — technically true of the balances, useless as an answer.

	The balance sheet carries an explicit "surplus not yet closed" line, computed
	as all-time income less all-time expenditure. Without it the statement
	cannot tie: assets equal liabilities plus corpus only once the current
	year's result is somewhere on the page. Once a year is closed that amount
	has moved into the corpus account, so it is never counted twice.
*/
func (s *Server) getStatements(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	fy := fyFrom(r)
	start, end := fyRange(fy)

	income := []statementRow{}
	expense := []statementRow{}
	assets := []statementRow{}
	liabilities := []statementRow{}
	var incomeTotal, expenseTotal, assetTotal, liabilityTotal, unclosed int64

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Income and expenditure: this year's movement, closing vouchers left out.
		rows, err := tx.Query(r.Context(), `
			SELECT a.code, a.name, a.type, COALESCE(p.name, '—'),
			       sum(l.credit_paise) - sum(l.debit_paise)
			  FROM journal_lines l
			  JOIN journal_entries e ON e.id = l.entry_id
			  JOIN ledger_accounts a ON a.id = l.account_id
			  LEFT JOIN ledger_accounts p ON p.id = a.parent_id
			 WHERE a.type IN ('income','expense')
			   AND e.entry_date BETWEEN $1 AND $2
			   AND e.voucher_type <> 'closing'
			 GROUP BY a.id, a.code, a.name, a.type, p.name
			HAVING sum(l.credit_paise) - sum(l.debit_paise) <> 0
			 ORDER BY a.code`, start, end)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var code, name, accType, group string
			var net int64
			if err := rows.Scan(&code, &name, &accType, &group, &net); err != nil {
				return err
			}
			if accType == "income" {
				income = append(income, statementRow{Code: code, Name: name, Group: group, Paise: net})
				incomeTotal += net
			} else {
				// Expenses carry a debit balance, so the net above is negative.
				expense = append(expense, statementRow{Code: code, Name: name, Group: group, Paise: -net})
				expenseTotal += -net
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}

		// Balance sheet: everything ever posted, up to the year end.
		bs, err := tx.Query(r.Context(), `
			SELECT a.code, a.name, a.type, COALESCE(p.name, '—'),
			       sum(l.debit_paise) - sum(l.credit_paise)
			  FROM journal_lines l
			  JOIN journal_entries e ON e.id = l.entry_id
			  JOIN ledger_accounts a ON a.id = l.account_id
			  LEFT JOIN ledger_accounts p ON p.id = a.parent_id
			 WHERE a.type IN ('asset','liability','equity')
			   AND e.entry_date <= $1
			 GROUP BY a.id, a.code, a.name, a.type, p.name
			HAVING sum(l.debit_paise) - sum(l.credit_paise) <> 0
			 ORDER BY a.code`, end)
		if err != nil {
			return err
		}
		defer bs.Close()
		for bs.Next() {
			var code, name, accType, group string
			var net int64
			if err := bs.Scan(&code, &name, &accType, &group, &net); err != nil {
				return err
			}
			if accType == "asset" {
				assets = append(assets, statementRow{Code: code, Name: name, Group: group, Paise: net})
				assetTotal += net
			} else {
				liabilities = append(liabilities, statementRow{Code: code, Name: name, Group: group, Paise: -net})
				liabilityTotal += -net
			}
		}
		if err := bs.Err(); err != nil {
			return err
		}

		/* The result that has not yet been swept into the corpus.

		   Credits less debits across income and expenditure together, which is
		   income minus expenditure because expense accounts carry debit
		   balances. Adding the two magnitudes instead — the obvious-looking
		   CASE with debit minus credit on the expense arm — reports turnover
		   rather than surplus, and the balance sheet then misses by the whole
		   of expenditure twice over. */
		return tx.QueryRow(r.Context(), `
			SELECT COALESCE(sum(l.credit_paise - l.debit_paise), 0)
			  FROM journal_lines l
			  JOIN journal_entries e ON e.id = l.entry_id
			  JOIN ledger_accounts a ON a.id = l.account_id
			 WHERE a.type IN ('income','expense') AND e.entry_date <= $1`, end).Scan(&unclosed)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Income less expenditure, as reported by the two lists above.
	surplus := incomeTotal - expenseTotal
	// A deficit is a negative surplus and belongs on the same side; showing it
	// as a positive "liability" would be a lie the balance sheet still ties to.
	liabilitySide := liabilityTotal + unclosed

	httpx.JSON(w, http.StatusOK, map[string]any{
		"fy_start_year": fy, "fy_label": fyLabel(fy),
		"from": start.Format(time.DateOnly), "to": end.Format(time.DateOnly),
		"income_expenditure": map[string]any{
			"income": income, "expenditure": expense,
			"income_paise": incomeTotal, "expenditure_paise": expenseTotal,
			"surplus_paise": surplus,
		},
		"balance_sheet": map[string]any{
			"assets": assets, "liabilities": liabilities,
			"assets_paise":            assetTotal,
			"liabilities_paise":       liabilityTotal,
			"surplus_not_yet_closed":  unclosed,
			"liabilities_total_paise": liabilitySide,
			"balanced":                assetTotal == liabilitySide,
			"difference_paise":        assetTotal - liabilitySide,
		},
	})
}

// --- expenses ----------------------------------------------------------------

type expenseRow struct {
	AccountID string `json:"account_id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	Group     string `json:"group"`
	Paise     int64  `json:"paise"`
	Vouchers  int    `json:"vouchers"`
	// Where the charge came from, so a reader can tell a paid bill from an
	// accrual nobody has settled.
	FromBills     int64 `json:"from_bills_paise"`
	FromPettyCash int64 `json:"from_petty_cash_paise"`
	FromOther     int64 `json:"from_other_paise"`
}

// getExpenseAnalysis is what the school spent this year, by head.
func (s *Server) getExpenseAnalysis(w http.ResponseWriter, r *http.Request) {
	fy := fyFrom(r)
	start, end := fyRange(fy)
	items, err := collect(s, r, `
		SELECT a.id::text, a.code, a.name, COALESCE(p.name,'—'),
		       sum(l.debit_paise) - sum(l.credit_paise),
		       count(DISTINCT e.id)::int,
		       COALESCE(sum(l.debit_paise) FILTER (WHERE e.voucher_type = 'purchase'), 0),
		       COALESCE(sum(l.debit_paise) FILTER (WHERE e.source_kind = 'petty_cash'), 0),
		       COALESCE(sum(l.debit_paise) FILTER (
		           WHERE e.voucher_type <> 'purchase'
		             AND (e.source_kind IS NULL OR e.source_kind <> 'petty_cash')), 0)
		  FROM journal_lines l
		  JOIN journal_entries e ON e.id = l.entry_id
		  JOIN ledger_accounts a ON a.id = l.account_id
		  LEFT JOIN ledger_accounts p ON p.id = a.parent_id
		 WHERE a.type = 'expense'
		   AND e.entry_date BETWEEN $1 AND $2
		   AND e.voucher_type <> 'closing'
		 GROUP BY a.id, a.code, a.name, p.name
		HAVING sum(l.debit_paise) - sum(l.credit_paise) <> 0
		 ORDER BY 5 DESC`, []any{start, end},
		func(rows pgx.Rows) (expenseRow, error) {
			var v expenseRow
			return v, rows.Scan(&v.AccountID, &v.Code, &v.Name, &v.Group, &v.Paise,
				&v.Vouchers, &v.FromBills, &v.FromPettyCash, &v.FromOther)
		})
	respond(w, r, items, err)
}

type directExpenseRequest struct {
	ExpenseAccountID string `json:"expense_account_id"`
	PaidFromID       string `json:"paid_from_account_id,omitempty"`
	AmountPaise      int64  `json:"amount_paise"`
	SpentOn          string `json:"spent_on,omitempty"`
	Narration        string `json:"narration"`
}

/*
recordDirectExpense is the cash payment that never became a bill: the plumber
paid at the gate, the courier charge, the sweets for a prize day.

	Posts Dr expense, Cr cash or bank. It is a full voucher like any other,
	because an expense recorded outside the ledger is an expense that never
	appears in the income and expenditure account.
*/
func (s *Server) recordDirectExpense(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req directExpenseRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	expenseID, err := uuid.Parse(req.ExpenseAccountID)
	if err != nil {
		httpx.BadRequest(w, r, "expense_account_id must be a uuid")
		return
	}
	if req.AmountPaise <= 0 {
		httpx.BadRequest(w, r, "amount_paise must be greater than zero")
		return
	}
	if strings.TrimSpace(req.Narration) == "" {
		httpx.BadRequest(w, r, "say what the money was spent on")
		return
	}
	date, err := parseDate(req.SpentOn, time.Now())
	if err != nil {
		httpx.BadRequest(w, r, "spent_on must be YYYY-MM-DD")
		return
	}

	var voucherNo string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		paidFrom := uuid.Nil
		if req.PaidFromID != "" {
			if paidFrom, err = uuid.Parse(req.PaidFromID); err != nil {
				return refusal("paid_from_account_id must be a uuid")
			}
		} else {
			c, err := loadControls(r.Context(), tx, id.InstitutionID)
			if err != nil {
				return err
			}
			if err := c.require(c.Cash, "cash"); err != nil {
				return err
			}
			paidFrom = c.Cash
		}
		_, voucherNo, err = postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
			"payment", "PV", date, strings.TrimSpace(req.Narration), "", nil,
			[]voucherLine{
				{AccountID: expenseID, Debit: req.AmountPaise},
				{AccountID: paidFrom, Credit: req.AmountPaise},
			})
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"voucher_no": voucherNo, "amount_paise": req.AmountPaise,
	})
}

// --- the financial year ------------------------------------------------------

type yearRow struct {
	ID           string  `json:"id"`
	FY           int     `json:"fy_start_year"`
	Label        string  `json:"fy_label"`
	Status       string  `json:"status"`
	ClosedOn     *string `json:"closed_on,omitempty"`
	ClosedBy     *string `json:"closed_by,omitempty"`
	ClosingVno   *string `json:"closing_voucher_no,omitempty"`
	SurplusPaise *int64  `json:"surplus_paise,omitempty"`
	Vouchers     int     `json:"vouchers"`
	// What a close would compute today, for a year still open.
	LiveIncome  int64  `json:"live_income_paise"`
	LiveExpense int64  `json:"live_expense_paise"`
	LiveSurplus int64  `json:"live_surplus_paise"`
	CanClose    bool   `json:"can_close"`
	Blocker     string `json:"blocker,omitempty"`
}

/*
listAccountingYears is the closing screen's whole state.

	Each open year carries what the close would compute if it ran now, so the
	person about to make an irreversible change can see the number first. A
	close that reveals its result only afterwards is a close nobody dares run.
*/
func (s *Server) listAccountingYears(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	out := []yearRow{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT y.id::text, y.fy_start_year, y.status,
			       to_char(y.closed_on,'YYYY-MM-DD'), u.full_name, ce.voucher_no,
			       y.surplus_paise,
			       COALESCE((SELECT count(*) FROM journal_entries e
			                  WHERE e.institution_id = y.institution_id
			                    AND e.fy_start_year = y.fy_start_year), 0)::int,
			       COALESCE((SELECT sum(l.credit_paise) - sum(l.debit_paise)
			                   FROM journal_lines l
			                   JOIN journal_entries e ON e.id = l.entry_id
			                   JOIN ledger_accounts a ON a.id = l.account_id
			                  WHERE e.institution_id = y.institution_id
			                    AND e.fy_start_year = y.fy_start_year
			                    AND e.voucher_type <> 'closing'
			                    AND a.type = 'income'), 0),
			       COALESCE((SELECT sum(l.debit_paise) - sum(l.credit_paise)
			                   FROM journal_lines l
			                   JOIN journal_entries e ON e.id = l.entry_id
			                   JOIN ledger_accounts a ON a.id = l.account_id
			                  WHERE e.institution_id = y.institution_id
			                    AND e.fy_start_year = y.fy_start_year
			                    AND e.voucher_type <> 'closing'
			                    AND a.type = 'expense'), 0),
			       -- An earlier year still open is the one blocker that matters:
			       -- closing out of order strands its result outside the corpus.
			       COALESCE((SELECT min(y2.fy_start_year) FROM accounting_years y2
			                  WHERE y2.institution_id = y.institution_id
			                    AND y2.status = 'open'
			                    AND y2.fy_start_year < y.fy_start_year), 0)
			  FROM accounting_years y
			  LEFT JOIN users u ON u.id = y.closed_by
			  LEFT JOIN journal_entries ce ON ce.id = y.closing_entry_id
			 ORDER BY y.fy_start_year DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v yearRow
			var earlierOpen int
			if err := rows.Scan(&v.ID, &v.FY, &v.Status, &v.ClosedOn, &v.ClosedBy,
				&v.ClosingVno, &v.SurplusPaise, &v.Vouchers,
				&v.LiveIncome, &v.LiveExpense, &earlierOpen); err != nil {
				return err
			}
			v.Label = fyLabel(v.FY)
			v.LiveSurplus = v.LiveIncome - v.LiveExpense
			switch {
			case v.Status == "closed":
				v.Blocker = "already closed"
			case earlierOpen > 0:
				v.Blocker = "close " + fyLabel(earlierOpen) + " first"
			case v.Vouchers == 0:
				v.Blocker = "no entries to close"
			default:
				v.CanClose = true
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	respond(w, r, out, err)
}

type closeYearRequest struct {
	FY      int  `json:"fy_start_year"`
	Confirm bool `json:"confirm"`
}

/*
closeAccountingYear signs the books.

	Three things happen, in this order and inside one transaction:

	  1. Every income and expenditure account with a balance is written back to
	     nil by a closing voucher dated the last day of the year.
	  2. The difference — the surplus or deficit — lands in the corpus.
	  3. The year is marked closed, which arms the trigger that refuses any
	     further entry dated inside it.

	The order is the point. The closing voucher must be posted while the year is
	still open, because the moment it is closed the database will not accept it
	either. And the close cannot be undone: there is no reopen endpoint and the
	schema refuses the transition, so a correction to a signed year goes where
	it goes in real accounting — a dated entry in the current year.
*/
func (s *Server) closeAccountingYear(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req closeYearRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.FY < 2000 {
		httpx.BadRequest(w, r, "fy_start_year is required, as the April year: 2026 means 2026-27")
		return
	}
	if !req.Confirm {
		httpx.BadRequest(w, r, "closing a year cannot be undone: send confirm=true")
		return
	}
	_, end := fyRange(req.FY)

	var voucherNo string
	var surplus int64
	var swept int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(), `
			SELECT status FROM accounting_years
			 WHERE institution_id = $1 AND fy_start_year = $2
			 FOR UPDATE`, id.InstitutionID, req.FY).Scan(&status); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// Years are created by the first entry that falls in them, so
				// no row means no entries — which is a sentence, not a 404.
				return refusef("%s has nothing in it to close", fyLabel(req.FY))
			}
			return err
		}
		if status == "closed" {
			return refusef("the books for %s are already closed", fyLabel(req.FY))
		}

		var earlier *int
		if err := tx.QueryRow(r.Context(), `
			SELECT min(fy_start_year) FROM accounting_years
			 WHERE institution_id = $1 AND status = 'open' AND fy_start_year < $2
			   AND EXISTS (SELECT 1 FROM journal_entries e
			                WHERE e.institution_id = $1
			                  AND e.fy_start_year = accounting_years.fy_start_year)`,
			id.InstitutionID, req.FY).Scan(&earlier); err != nil {
			return err
		}
		if earlier != nil {
			return refusef("close %s first: closing out of order strands its result outside the corpus",
				fyLabel(*earlier))
		}

		c, err := loadControls(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if err := c.require(c.Surplus, "surplus carried forward"); err != nil {
			return err
		}

		// Every income and expense account carrying a balance for the year.
		rows, err := tx.Query(r.Context(), `
			SELECT a.id, a.type, sum(l.debit_paise) - sum(l.credit_paise)
			  FROM journal_lines l
			  JOIN journal_entries e ON e.id = l.entry_id
			  JOIN ledger_accounts a ON a.id = l.account_id
			 WHERE e.institution_id = $1 AND e.fy_start_year = $2
			   AND a.type IN ('income','expense')
			 GROUP BY a.id, a.type
			HAVING sum(l.debit_paise) - sum(l.credit_paise) <> 0`,
			id.InstitutionID, req.FY)
		if err != nil {
			return err
		}
		lines := []voucherLine{}
		var net int64
		for rows.Next() {
			var accID uuid.UUID
			var accType string
			var bal int64
			if err := rows.Scan(&accID, &accType, &bal); err != nil {
				rows.Close()
				return err
			}
			// Reverse whatever the account holds, so it ends the year at nil.
			if bal < 0 {
				lines = append(lines, voucherLine{AccountID: accID, Debit: -bal, Memo: "year end close"})
			} else {
				lines = append(lines, voucherLine{AccountID: accID, Credit: bal, Memo: "year end close"})
			}
			net += bal
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(lines) == 0 {
			return refusef("%s has no income or expenditure to close", fyLabel(req.FY))
		}
		swept = len(lines)

		/* net is debits minus credits across income and expenditure, so a
		   surplus — income exceeding expenditure — comes out negative. Flipping
		   it here once is clearer than carrying the sign through the report. */
		surplus = -net
		if surplus >= 0 {
			lines = append(lines, voucherLine{
				AccountID: c.Surplus, Credit: surplus, Memo: "surplus for " + fyLabel(req.FY)})
		} else {
			lines = append(lines, voucherLine{
				AccountID: c.Surplus, Debit: -surplus, Memo: "deficit for " + fyLabel(req.FY)})
		}

		entryID, no, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
			"closing", "CL", end,
			fmt.Sprintf("Closing the books for %s", fyLabel(req.FY)), "", nil, lines)
		if err != nil {
			return err
		}
		voucherNo = no

		_, err = tx.Exec(r.Context(), `
			UPDATE accounting_years
			   SET status = 'closed', closed_on = CURRENT_DATE, closed_by = $3,
			       closing_entry_id = $4, surplus_paise = $5
			 WHERE institution_id = $1 AND fy_start_year = $2`,
			id.InstitutionID, req.FY, nullUUIDArg(id.UserID), entryID, surplus)
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"fy_start_year": req.FY, "fy_label": fyLabel(req.FY),
		"status": "closed", "closing_voucher_no": voucherNo,
		"surplus_paise": surplus, "accounts_closed": swept,
	})
}

// --- vendors and payables ----------------------------------------------------

type vendorRow struct {
	ID            string  `json:"id"`
	Code          string  `json:"code"`
	Name          string  `json:"name"`
	Contact       *string `json:"contact_person,omitempty"`
	Phone         *string `json:"phone,omitempty"`
	Email         *string `json:"email,omitempty"`
	GSTIN         *string `json:"gstin,omitempty"`
	PAN           *string `json:"pan,omitempty"`
	Category      *string `json:"category,omitempty"`
	TermsDays     int     `json:"payment_terms_days"`
	IsActive      bool    `json:"is_active"`
	Bills         int     `json:"bills"`
	BilledPaise   int64   `json:"billed_paise"`
	PaidPaise     int64   `json:"paid_paise"`
	OutstandPaise int64   `json:"outstanding_paise"`
	OverduePaise  int64   `json:"overdue_paise"`
}

// listVendors is the creditor directory, each with what is still owed.
func (s *Server) listVendors(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT v.id::text, v.code, v.name, v.contact_person, v.phone, v.email,
		       v.gstin, v.pan, v.category, v.payment_terms_days, v.is_active,
		       COALESCE(b.n, 0)::int, COALESCE(b.billed, 0),
		       COALESCE(b.paid, 0), COALESCE(b.billed, 0) - COALESCE(b.paid, 0),
		       COALESCE(b.overdue, 0)
		  FROM vendors v
		  LEFT JOIN LATERAL (
		      SELECT count(*) AS n,
		             sum(bl.total_paise) AS billed,
		             sum(COALESCE(p.paid, 0)) AS paid,
		             sum(CASE WHEN COALESCE(bl.due_on, bl.bill_date + bl.institution_terms)
		                           < CURRENT_DATE
		                      THEN bl.total_paise - COALESCE(p.paid, 0) ELSE 0 END) AS overdue
		        FROM (SELECT b2.*, (v.payment_terms_days || ' days')::interval AS institution_terms
		                FROM vendor_bills b2
		               WHERE b2.vendor_id = v.id AND b2.status = 'approved') bl
		        LEFT JOIN LATERAL (
		            SELECT COALESCE(sum(vp.amount_paise), 0) AS paid
		              FROM vendor_payments vp WHERE vp.bill_id = bl.id
		        ) p ON true
		  ) b ON true
		 ORDER BY v.is_active DESC, v.name`, nil,
		func(rows pgx.Rows) (vendorRow, error) {
			var v vendorRow
			return v, rows.Scan(&v.ID, &v.Code, &v.Name, &v.Contact, &v.Phone, &v.Email,
				&v.GSTIN, &v.PAN, &v.Category, &v.TermsDays, &v.IsActive,
				&v.Bills, &v.BilledPaise, &v.PaidPaise, &v.OutstandPaise, &v.OverduePaise)
		})
	respond(w, r, items, err)
}

type saveVendorRequest struct {
	ID        string `json:"id,omitempty"`
	Code      string `json:"code,omitempty"`
	Name      string `json:"name"`
	Contact   string `json:"contact_person,omitempty"`
	Phone     string `json:"phone,omitempty"`
	Email     string `json:"email,omitempty"`
	Address   string `json:"address,omitempty"`
	GSTIN     string `json:"gstin,omitempty"`
	PAN       string `json:"pan,omitempty"`
	Bank      string `json:"bank_account,omitempty"`
	IFSC      string `json:"bank_ifsc,omitempty"`
	Category  string `json:"category,omitempty"`
	TermsDays int    `json:"payment_terms_days,omitempty"`
	IsActive  *bool  `json:"is_active,omitempty"`
}

func (s *Server) saveVendor(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req saveVendorRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "a vendor needs a name")
		return
	}
	if req.TermsDays <= 0 {
		req.TermsDays = 30
	}
	// A GSTIN or PAN in lower case fails the filing it was collected for, and
	// nobody finds out until the return is rejected.
	req.GSTIN = strings.ToUpper(strings.TrimSpace(req.GSTIN))
	req.PAN = strings.ToUpper(strings.TrimSpace(req.PAN))

	var out, code string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			vID, err := uuid.Parse(req.ID)
			if err != nil {
				return refusal("id must be a uuid")
			}
			return tx.QueryRow(r.Context(), `
				UPDATE vendors SET name = $2, contact_person = NULLIF($3,''),
				    phone = NULLIF($4,''), email = NULLIF($5,''), address = NULLIF($6,''),
				    gstin = NULLIF($7,''), pan = NULLIF($8,''), bank_account = NULLIF($9,''),
				    bank_ifsc = NULLIF($10,''), category = NULLIF($11,''),
				    payment_terms_days = $12, is_active = COALESCE($13, is_active)
				 WHERE id = $1
				RETURNING id::text, code`,
				vID, req.Name, req.Contact, req.Phone, req.Email, req.Address,
				req.GSTIN, req.PAN, req.Bank, req.IFSC, req.Category,
				req.TermsDays, req.IsActive).Scan(&out, &code)
		}
		// A code nobody supplied is allocated in sequence, inside the
		// transaction, so the directory never has two vendors called V0007.
		if _, err := tx.Exec(r.Context(),
			`SELECT pg_advisory_xact_lock(hashtext($1))`,
			id.InstitutionID.String()+"vendor"); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO vendors (institution_id, code, name, contact_person, phone,
			    email, address, gstin, pan, bank_account, bank_ifsc, category,
			    payment_terms_days)
			SELECT $1,
			       COALESCE(NULLIF($2,''),
			         'V' || lpad((COALESCE(max(substring(v.code from '[0-9]+$')::int), 0) + 1)::text, 4, '0')),
			       $3, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), NULLIF($7,''),
			       NULLIF($8,''), NULLIF($9,''), NULLIF($10,''), NULLIF($11,''),
			       NULLIF($12,''), $13
			  FROM vendors v
			 WHERE v.institution_id = $1 AND v.code ~ '^V[0-9]+$'
			RETURNING id::text, code`,
			id.InstitutionID, req.Code, req.Name, req.Contact, req.Phone, req.Email,
			req.Address, req.GSTIN, req.PAN, req.Bank, req.IFSC, req.Category,
			req.TermsDays).Scan(&out, &code)
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out, "code": code})
}

type billRow struct {
	ID            string  `json:"id"`
	VendorID      string  `json:"vendor_id"`
	VendorName    string  `json:"vendor_name"`
	BillNo        string  `json:"bill_no"`
	BillDate      string  `json:"bill_date"`
	DueOn         *string `json:"due_on,omitempty"`
	ExpenseCode   string  `json:"expense_code"`
	ExpenseName   string  `json:"expense_name"`
	TaxablePaise  int64   `json:"taxable_paise"`
	TaxPaise      int64   `json:"tax_paise"`
	TotalPaise    int64   `json:"total_paise"`
	PaidPaise     int64   `json:"paid_paise"`
	OutstandPaise int64   `json:"outstanding_paise"`
	Status        string  `json:"status"`
	PaymentState  string  `json:"payment_state"`
	DaysOverdue   int     `json:"days_overdue"`
	Bucket        string  `json:"bucket"`
	VoucherNo     *string `json:"voucher_no,omitempty"`
	Narration     *string `json:"narration,omitempty"`
}

/*
listVendorBills is the payables ledger, aged.

	What has been paid is summed from the payment history rather than read from
	a column, so the outstanding figure and the receipts can never disagree.
	payment_state is derived from the same arithmetic for the same reason.
*/
func (s *Server) listVendorBills(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT b.id::text, v.id::text, v.name, b.bill_no,
		       to_char(b.bill_date,'YYYY-MM-DD'), to_char(b.due_on,'YYYY-MM-DD'),
		       a.code, a.name, b.taxable_paise, b.tax_paise, b.total_paise,
		       COALESCE(p.paid, 0), b.total_paise - COALESCE(p.paid, 0),
		       b.status,
		       CASE WHEN b.status <> 'approved' THEN b.status
		            WHEN COALESCE(p.paid,0) = 0 THEN 'unpaid'
		            WHEN COALESCE(p.paid,0) >= b.total_paise THEN 'paid'
		            ELSE 'part paid' END,
		       CASE WHEN b.status = 'approved' AND COALESCE(p.paid,0) < b.total_paise
		                 AND COALESCE(b.due_on, b.bill_date) < CURRENT_DATE
		            THEN (CURRENT_DATE - COALESCE(b.due_on, b.bill_date))
		            ELSE 0 END,
		       CASE WHEN b.status <> 'approved' OR COALESCE(p.paid,0) >= b.total_paise THEN '—'
		            WHEN CURRENT_DATE - COALESCE(b.due_on, b.bill_date) > 90 THEN '90+'
		            WHEN CURRENT_DATE - COALESCE(b.due_on, b.bill_date) > 60 THEN '61-90'
		            WHEN CURRENT_DATE - COALESCE(b.due_on, b.bill_date) > 30 THEN '31-60'
		            WHEN CURRENT_DATE - COALESCE(b.due_on, b.bill_date) > 0  THEN '0-30'
		            ELSE 'not due' END,
		       e.voucher_no, b.narration
		  FROM vendor_bills b
		  JOIN vendors v ON v.id = b.vendor_id
		  JOIN ledger_accounts a ON a.id = b.expense_account_id
		  LEFT JOIN journal_entries e ON e.id = b.journal_entry_id
		  LEFT JOIN LATERAL (
		      SELECT COALESCE(sum(vp.amount_paise), 0) AS paid
		        FROM vendor_payments vp WHERE vp.bill_id = b.id
		  ) p ON true
		 ORDER BY b.status = 'approved' DESC,
		          b.total_paise - COALESCE(p.paid,0) > 0 DESC,
		          COALESCE(b.due_on, b.bill_date)
		 LIMIT 400`, nil,
		func(rows pgx.Rows) (billRow, error) {
			var v billRow
			return v, rows.Scan(&v.ID, &v.VendorID, &v.VendorName, &v.BillNo, &v.BillDate,
				&v.DueOn, &v.ExpenseCode, &v.ExpenseName, &v.TaxablePaise, &v.TaxPaise,
				&v.TotalPaise, &v.PaidPaise, &v.OutstandPaise, &v.Status,
				&v.PaymentState, &v.DaysOverdue, &v.Bucket, &v.VoucherNo, &v.Narration)
		})
	respond(w, r, items, err)
}

type saveBillRequest struct {
	VendorID         string `json:"vendor_id"`
	BillNo           string `json:"bill_no"`
	BillDate         string `json:"bill_date,omitempty"`
	DueOn            string `json:"due_on,omitempty"`
	ExpenseAccountID string `json:"expense_account_id"`
	TaxablePaise     int64  `json:"taxable_paise"`
	TaxPaise         int64  `json:"tax_paise,omitempty"`
	Narration        string `json:"narration,omitempty"`
}

// saveVendorBill records a purchase bill as a draft. Nothing is posted until
// somebody approves it — a bill in the tray is not yet a liability the school
// has accepted.
func (s *Server) saveVendorBill(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req saveBillRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	vendorID, err := uuid.Parse(req.VendorID)
	if err != nil {
		httpx.BadRequest(w, r, "vendor_id must be a uuid")
		return
	}
	expenseID, err := uuid.Parse(req.ExpenseAccountID)
	if err != nil {
		httpx.BadRequest(w, r, "expense_account_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.BillNo) == "" {
		httpx.BadRequest(w, r, "a bill needs its number: it is the duplicate-payment control")
		return
	}
	if req.TaxablePaise+req.TaxPaise <= 0 {
		httpx.BadRequest(w, r, "a bill must be for more than nothing")
		return
	}
	billDate, err := parseDate(req.BillDate, time.Now())
	if err != nil {
		httpx.BadRequest(w, r, "bill_date must be YYYY-MM-DD")
		return
	}
	var dueOn any
	if req.DueOn != "" {
		d, err := time.Parse(time.DateOnly, req.DueOn)
		if err != nil {
			httpx.BadRequest(w, r, "due_on must be YYYY-MM-DD")
			return
		}
		dueOn = d
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// A missing due date falls back to the vendor's terms, so the ageing
		// report has something honest to age against.
		return tx.QueryRow(r.Context(), `
			INSERT INTO vendor_bills (institution_id, vendor_id, bill_no, bill_date,
			    due_on, expense_account_id, taxable_paise, tax_paise, narration, created_by)
			SELECT $1, $2, $3, $4,
			       COALESCE($5::date, $4::date + (v.payment_terms_days || ' days')::interval),
			       $6, $7, $8, NULLIF($9,''), $10
			  FROM vendors v WHERE v.id = $2
			RETURNING id::text`,
			id.InstitutionID, vendorID, strings.TrimSpace(req.BillNo), billDate, dueOn,
			expenseID, req.TaxablePaise, req.TaxPaise, req.Narration,
			nullUUIDArg(id.UserID)).Scan(&out)
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out, "status": "draft"})
}

/*
approveVendorBill accepts the liability and posts it.

	Dr the expense head, Dr GST if any, Cr sundry creditors. This is the accrual:
	the expense belongs to the year the school received the goods, not the year
	it got round to paying. Posting only on payment would move expenditure
	between years at the convenience of the cash flow, which is the practice
	accrual accounting exists to prevent.
*/
func (s *Server) approveVendorBill(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	billID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid bill id")
		return
	}

	var voucherNo string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status, vendorName, billNo string
		var expenseID uuid.UUID
		var taxable, tax int64
		var billDate time.Time
		if err := tx.QueryRow(r.Context(), `
			SELECT b.status, b.expense_account_id, b.taxable_paise, b.tax_paise,
			       b.bill_date, v.name, b.bill_no
			  FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id
			 WHERE b.id = $1 FOR UPDATE OF b`, billID).
			Scan(&status, &expenseID, &taxable, &tax, &billDate, &vendorName, &billNo); err != nil {
			return err
		}
		if status != "draft" {
			return refusef("the bill is already %s", status)
		}

		c, err := loadControls(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if err := c.require(c.Payable, "sundry creditors"); err != nil {
			return err
		}

		lines := []voucherLine{{AccountID: expenseID, Debit: taxable}}
		if tax > 0 {
			/* Input GST is a receivable from the government, not a cost, for a
			   school that can claim it. Most schools cannot — education is
			   largely exempt — so it is charged to the same expense head and
			   the tax column survives for the return. Splitting it to an input
			   credit account a school cannot use would overstate assets. */
			lines[0].Debit += tax
			lines[0].Memo = fmt.Sprintf("includes %s tax", indianRupees(tax))
		}
		lines = append(lines, voucherLine{AccountID: c.Payable, Credit: taxable + tax})

		entryID, no, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
			"purchase", "PJ", billDate,
			fmt.Sprintf("%s — bill %s", vendorName, billNo), "vendor_bill", &billID, lines)
		if err != nil {
			return err
		}
		voucherNo = no

		_, err = tx.Exec(r.Context(), `
			UPDATE vendor_bills
			   SET status = 'approved', approved_by = $2, approved_at = now(),
			       journal_entry_id = $3
			 WHERE id = $1`, billID, nullUUIDArg(id.UserID), entryID)
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": billID.String(), "status": "approved", "voucher_no": voucherNo,
	})
}

type payBillRequest struct {
	AmountPaise int64  `json:"amount_paise"`
	PaidOn      string `json:"paid_on,omitempty"`
	Mode        string `json:"mode,omitempty"`
	ReferenceNo string `json:"reference_no,omitempty"`
	FromAccount string `json:"paid_from_account_id,omitempty"`
	TDSPaise    int64  `json:"tds_paise,omitempty"`
	Remarks     string `json:"remarks,omitempty"`
}

/*
payVendorBill pays a creditor.

	Dr sundry creditors with the gross, Cr the bank with what actually left, and
	Cr TDS payable with what was withheld. The vendor's account is relieved of
	the whole amount because that is what the bill was for; the tax withheld is
	a liability to the government until it is deposited, and a school that
	credited only the net would carry a payable it does not owe for ever.

	The database refuses an overpayment and refuses payment against an
	unapproved bill, so the arithmetic here cannot be the only guard.
*/
func (s *Server) payVendorBill(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	billID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid bill id")
		return
	}
	var req payBillRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.AmountPaise <= 0 {
		httpx.BadRequest(w, r, "amount_paise must be greater than zero")
		return
	}
	if req.TDSPaise < 0 || req.TDSPaise >= req.AmountPaise {
		httpx.BadRequest(w, r, "tds_paise must be less than the amount")
		return
	}
	if req.Mode == "" {
		req.Mode = "neft"
	}
	paidOn, err := parseDate(req.PaidOn, time.Now())
	if err != nil {
		httpx.BadRequest(w, r, "paid_on must be YYYY-MM-DD")
		return
	}

	var voucherNo string
	var outstanding int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		c, err := loadControls(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if err := c.require(c.Payable, "sundry creditors"); err != nil {
			return err
		}
		from := c.Bank
		if req.FromAccount != "" {
			if from, err = uuid.Parse(req.FromAccount); err != nil {
				return refusal("paid_from_account_id must be a uuid")
			}
		} else if req.Mode == "cash" {
			from = c.Cash
		}
		if from == uuid.Nil {
			return refusal("no bank account is set: choose one on the chart of accounts screen")
		}

		var vendorName, billNo string
		var total int64
		if err := tx.QueryRow(r.Context(), `
			SELECT v.name, b.bill_no, b.total_paise
			  FROM vendor_bills b JOIN vendors v ON v.id = b.vendor_id
			 WHERE b.id = $1 FOR UPDATE OF b`, billID).
			Scan(&vendorName, &billNo, &total); err != nil {
			return err
		}

		// The voucher first, so the payment row can point at it.
		lines := []voucherLine{
			{AccountID: c.Payable, Debit: req.AmountPaise, Memo: vendorName},
			{AccountID: from, Credit: req.AmountPaise - req.TDSPaise},
		}
		if req.TDSPaise > 0 {
			tds := uuid.Nil
			if err := tx.QueryRow(r.Context(), `
				SELECT id FROM ledger_accounts
				 WHERE institution_id = $1 AND code = '2160' AND NOT is_group`,
				id.InstitutionID).Scan(&tds); err != nil {
				return refusal("no TDS payable account (2160) in the chart of accounts")
			}
			lines = append(lines, voucherLine{
				AccountID: tds, Credit: req.TDSPaise, Memo: "TDS on " + vendorName})
		}

		entryID, no, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
			"payment", "PV", paidOn,
			fmt.Sprintf("Paid %s against bill %s", vendorName, billNo), "", nil, lines)
		if err != nil {
			return err
		}
		voucherNo = no

		// The overpayment and unapproved-bill guards live on this insert.
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO vendor_payments (institution_id, bill_id, voucher_no, paid_on,
			    amount_paise, mode, reference_no, paid_from_account_id, tds_paise,
			    journal_entry_id, remarks, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8,$9,$10,NULLIF($11,''),$12)`,
			id.InstitutionID, billID, no, paidOn, req.AmountPaise, req.Mode,
			req.ReferenceNo, from, req.TDSPaise, entryID, req.Remarks,
			nullUUIDArg(id.UserID)); err != nil {
			return err
		}

		return tx.QueryRow(r.Context(), `
			SELECT b.total_paise - COALESCE((SELECT sum(amount_paise) FROM vendor_payments
			                                  WHERE bill_id = b.id), 0)
			  FROM vendor_bills b WHERE b.id = $1`, billID).Scan(&outstanding)
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"voucher_no": voucherNo, "amount_paise": req.AmountPaise,
		"tds_paise": req.TDSPaise, "outstanding_paise": outstanding,
	})
}

// --- petty cash --------------------------------------------------------------

type pettyCashRow struct {
	ID            string  `json:"id"`
	VoucherNo     string  `json:"voucher_no"`
	VoucherDate   string  `json:"voucher_date"`
	Payee         string  `json:"payee"`
	Particulars   string  `json:"particulars"`
	AmountPaise   int64   `json:"amount_paise"`
	ExpenseCode   string  `json:"expense_code"`
	ExpenseName   string  `json:"expense_name"`
	Status        string  `json:"status"`
	NeedsApproval bool    `json:"needs_approval"`
	ApprovedBy    *string `json:"approved_by,omitempty"`
	RaisedBy      *string `json:"raised_by,omitempty"`
	Reason        *string `json:"rejected_reason,omitempty"`
	JournalVno    *string `json:"journal_voucher_no,omitempty"`
	HasReceipt    bool    `json:"has_receipt"`
}

// listPettyCash is the tin's own register, plus what is left in it.
func (s *Server) listPettyCash(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	items := []pettyCashRow{}
	var limit, balance int64

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT s.petty_cash_limit_paise,
			       COALESCE((SELECT sum(l.debit_paise) - sum(l.credit_paise)
			                   FROM journal_lines l
			                  WHERE l.account_id = s.petty_cash_account_id), 0)
			  FROM ledger_settings s WHERE s.institution_id = $1`,
			id.InstitutionID).Scan(&limit, &balance); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return scanInto(r.Context(), tx, `
			SELECT p.id::text, p.voucher_no, to_char(p.voucher_date,'YYYY-MM-DD'),
			       p.payee, p.particulars, p.amount_paise, a.code, a.name, p.status,
			       p.amount_paise > COALESCE(s.petty_cash_limit_paise, 0),
			       ap.full_name, cr.full_name, p.rejected_reason, e.voucher_no,
			       p.file_id IS NOT NULL
			  FROM petty_cash_vouchers p
			  JOIN ledger_accounts a ON a.id = p.expense_account_id
			  LEFT JOIN ledger_settings s ON s.institution_id = p.institution_id
			  LEFT JOIN users ap ON ap.id = p.approved_by
			  LEFT JOIN users cr ON cr.id = p.created_by
			  LEFT JOIN journal_entries e ON e.id = p.journal_entry_id
			 ORDER BY p.status = 'pending' DESC, p.voucher_date DESC, p.voucher_no DESC
			 LIMIT 300`,
			func(rows pgx.Rows) error {
				var v pettyCashRow
				if err := rows.Scan(&v.ID, &v.VoucherNo, &v.VoucherDate, &v.Payee,
					&v.Particulars, &v.AmountPaise, &v.ExpenseCode, &v.ExpenseName,
					&v.Status, &v.NeedsApproval, &v.ApprovedBy, &v.RaisedBy,
					&v.Reason, &v.JournalVno, &v.HasReceipt); err != nil {
					return err
				}
				items = append(items, v)
				return nil
			})
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":       items,
		"limit_paise": limit,
		// What the ledger says is in the tin. A float above zero that nobody
		// can find in the drawer is the point of counting it.
		"balance_paise": balance,
	})
}

type pettyCashRequest struct {
	Payee            string `json:"payee"`
	Particulars      string `json:"particulars"`
	AmountPaise      int64  `json:"amount_paise"`
	ExpenseAccountID string `json:"expense_account_id"`
	VoucherDate      string `json:"voucher_date,omitempty"`
	FileID           string `json:"file_id,omitempty"`
}

// raisePettyCash writes a slip. Nothing is posted yet: the money leaves the tin
// when somebody with authority says it may.
func (s *Server) raisePettyCash(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req pettyCashRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	expenseID, err := uuid.Parse(req.ExpenseAccountID)
	if err != nil {
		httpx.BadRequest(w, r, "expense_account_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Payee) == "" || strings.TrimSpace(req.Particulars) == "" {
		httpx.BadRequest(w, r, "a voucher needs a payee and what it was for")
		return
	}
	if req.AmountPaise <= 0 {
		httpx.BadRequest(w, r, "amount_paise must be greater than zero")
		return
	}
	date, err := parseDate(req.VoucherDate, time.Now())
	if err != nil {
		httpx.BadRequest(w, r, "voucher_date must be YYYY-MM-DD")
		return
	}

	var out, voucherNo string
	var needsApproval bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		c, err := loadControls(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if err := c.require(c.PettyCash, "petty cash"); err != nil {
			return err
		}
		var limit int64
		if err := tx.QueryRow(r.Context(),
			`SELECT petty_cash_limit_paise FROM ledger_settings WHERE institution_id = $1`,
			id.InstitutionID).Scan(&limit); err != nil {
			return err
		}
		needsApproval = req.AmountPaise > limit

		if _, err := tx.Exec(r.Context(),
			`SELECT pg_advisory_xact_lock(hashtext($1))`,
			id.InstitutionID.String()+"petty"); err != nil {
			return err
		}
		fy := date.Year()
		if date.Month() < time.April {
			fy--
		}
		series := "PC/" + fyLabel(fy) + "/"
		var fileID any
		if req.FileID != "" {
			f, err := uuid.Parse(req.FileID)
			if err != nil {
				return refusal("file_id must be a uuid")
			}
			fileID = f
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO petty_cash_vouchers (institution_id, voucher_no, voucher_date,
			    payee, particulars, amount_paise, expense_account_id,
			    paid_from_account_id, file_id, created_by)
			SELECT $1,
			       $2 || lpad((COALESCE(max(substring(p.voucher_no from '[0-9]+$')::int), 0) + 1)::text, 4, '0'),
			       $3, $4, $5, $6, $7, $8, $9, $10
			  FROM petty_cash_vouchers p
			 WHERE p.institution_id = $1 AND p.voucher_no LIKE $2 || '%'
			RETURNING id::text, voucher_no`,
			id.InstitutionID, series, date, strings.TrimSpace(req.Payee),
			strings.TrimSpace(req.Particulars), req.AmountPaise, expenseID,
			c.PettyCash, fileID, nullUUIDArg(id.UserID)).Scan(&out, &voucherNo)
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": out, "voucher_no": voucherNo, "status": "pending",
		"needs_approval": needsApproval,
	})
}

type pettyDecisionRequest struct {
	Approve bool   `json:"approve"`
	Reason  string `json:"reason,omitempty"`
}

/*
decidePettyCash approves or refuses a slip, and posts it if approved.

	The limit is what makes this two steps rather than one. Below it a clerk may
	sign their own slip; above it somebody else must, and the record shows who.
	Both paths end in a voucher or in a refusal with a reason — a slip that sits
	in neither state is the one that goes missing.
*/
func (s *Server) decidePettyCash(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	voucherID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid voucher id")
		return
	}
	var req pettyDecisionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if !req.Approve && strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "say why the claim is refused")
		return
	}

	var journalNo string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status, payee, particulars string
		var amount int64
		var expenseID, pettyID uuid.UUID
		var date time.Time
		if err := tx.QueryRow(r.Context(), `
			SELECT status, payee, particulars, amount_paise, expense_account_id,
			       paid_from_account_id, voucher_date
			  FROM petty_cash_vouchers WHERE id = $1 FOR UPDATE`, voucherID).
			Scan(&status, &payee, &particulars, &amount, &expenseID, &pettyID, &date); err != nil {
			return err
		}
		if status != "pending" {
			return refusef("the voucher is already %s", status)
		}

		if !req.Approve {
			_, err := tx.Exec(r.Context(), `
				UPDATE petty_cash_vouchers
				   SET status = 'rejected', rejected_reason = $2, approved_by = $3,
				       approved_at = now()
				 WHERE id = $1`, voucherID, strings.TrimSpace(req.Reason), nullUUIDArg(id.UserID))
			return err
		}

		entryID, no, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
			"payment", "PV", date,
			fmt.Sprintf("Petty cash — %s (%s)", particulars, payee),
			"petty_cash", &voucherID,
			[]voucherLine{
				{AccountID: expenseID, Debit: amount, Memo: payee},
				{AccountID: pettyID, Credit: amount},
			})
		if err != nil {
			return err
		}
		journalNo = no

		_, err = tx.Exec(r.Context(), `
			UPDATE petty_cash_vouchers
			   SET status = 'approved', approved_by = $2, approved_at = now(),
			       journal_entry_id = $3
			 WHERE id = $1`, voucherID, nullUUIDArg(id.UserID), entryID)
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	out := map[string]any{"id": voucherID.String(), "status": "rejected"}
	if req.Approve {
		out["status"] = "approved"
		out["journal_voucher_no"] = journalNo
	}
	httpx.JSON(w, http.StatusOK, out)
}

// --- fixed assets ------------------------------------------------------------

type assetRow struct {
	ID           string  `json:"id"`
	TagNo        string  `json:"tag_no"`
	Name         string  `json:"name"`
	Category     string  `json:"category"`
	AccountCode  string  `json:"account_code"`
	AccountName  string  `json:"account_name"`
	PurchasedOn  string  `json:"purchased_on"`
	CostPaise    int64   `json:"cost_paise"`
	SalvagePaise int64   `json:"salvage_paise"`
	Method       string  `json:"method"`
	LifeYears    *int    `json:"useful_life_years,omitempty"`
	RatePercent  *string `json:"wdv_rate_percent,omitempty"`
	Location     *string `json:"location,omitempty"`
	VendorName   *string `json:"vendor_name,omitempty"`
	Status       string  `json:"status"`
	DisposedOn   *string `json:"disposed_on,omitempty"`
	ChargedPaise int64   `json:"accumulated_depreciation_paise"`
	WDVPaise     int64   `json:"written_down_value_paise"`
	YearsCharged int     `json:"years_charged"`
	AgeYears     int     `json:"age_years"`
}

// listFixedAssets is the register, each asset at its written-down value.
func (s *Server) listFixedAssets(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT f.id::text, f.tag_no, f.name, f.category, a.code, a.name,
		       to_char(f.purchased_on,'YYYY-MM-DD'), f.cost_paise, f.salvage_paise,
		       f.method, f.useful_life_years, f.wdv_rate_percent::text,
		       f.location, v.name, f.status, to_char(f.disposed_on,'YYYY-MM-DD'),
		       COALESCE(d.charged, 0), f.cost_paise - COALESCE(d.charged, 0),
		       COALESCE(d.years, 0)::int,
		       GREATEST(0, extract(year FROM age(CURRENT_DATE, f.purchased_on))::int)
		  FROM fixed_assets f
		  JOIN ledger_accounts a ON a.id = f.asset_account_id
		  LEFT JOIN vendors v ON v.id = f.vendor_id
		  LEFT JOIN LATERAL (
		      SELECT COALESCE(sum(dc.charge_paise), 0) AS charged, count(*) AS years
		        FROM depreciation_charges dc WHERE dc.asset_id = f.id
		  ) d ON true
		 ORDER BY f.status, f.purchased_on DESC
		 LIMIT 500`, nil,
		func(rows pgx.Rows) (assetRow, error) {
			var v assetRow
			return v, rows.Scan(&v.ID, &v.TagNo, &v.Name, &v.Category, &v.AccountCode,
				&v.AccountName, &v.PurchasedOn, &v.CostPaise, &v.SalvagePaise, &v.Method,
				&v.LifeYears, &v.RatePercent, &v.Location, &v.VendorName, &v.Status,
				&v.DisposedOn, &v.ChargedPaise, &v.WDVPaise, &v.YearsCharged, &v.AgeYears)
		})
	respond(w, r, items, err)
}

type saveAssetRequest struct {
	TagNo          string `json:"tag_no,omitempty"`
	Name           string `json:"name"`
	Category       string `json:"category,omitempty"`
	AssetAccountID string `json:"asset_account_id"`
	PurchasedOn    string `json:"purchased_on"`
	CostPaise      int64  `json:"cost_paise"`
	SalvagePaise   int64  `json:"salvage_paise,omitempty"`
	Method         string `json:"method,omitempty"`
	LifeYears      int    `json:"useful_life_years,omitempty"`
	RatePercent    string `json:"wdv_rate_percent,omitempty"`
	Location       string `json:"location,omitempty"`
	VendorID       string `json:"vendor_id,omitempty"`
	InvoiceRef     string `json:"invoice_ref,omitempty"`
	Quantity       int    `json:"quantity,omitempty"`
	/* Whether to post the purchase as well as record it.

	   Off by default, and that default is the careful one. Most assets reach
	   the register after the purchase has already been booked — through a
	   vendor bill charged to the asset account, or as an opening balance when
	   the school first loads its register — and capitalising again would
	   record the same computer twice. Turn it on for an asset the ledger has
	   not otherwise seen. The audit report reconciles the two either way. */
	Capitalise   bool   `json:"capitalise,omitempty"`
	FundedFromID string `json:"funded_from_account_id,omitempty"`
}

// saveFixedAsset adds an asset to the register, and optionally capitalises it.
func (s *Server) saveFixedAsset(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req saveAssetRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	accountID, err := uuid.Parse(req.AssetAccountID)
	if err != nil {
		httpx.BadRequest(w, r, "asset_account_id must be a uuid")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		httpx.BadRequest(w, r, "an asset needs a name")
		return
	}
	if req.CostPaise <= 0 {
		httpx.BadRequest(w, r, "cost_paise must be greater than zero")
		return
	}
	purchased, err := time.Parse(time.DateOnly, req.PurchasedOn)
	if err != nil {
		httpx.BadRequest(w, r, "purchased_on must be YYYY-MM-DD")
		return
	}
	if req.Category == "" {
		req.Category = "equipment"
	}
	if req.Quantity <= 0 {
		req.Quantity = 1
	}

	var out, tag, voucherNo string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		method := req.Method
		if method == "" {
			if err := tx.QueryRow(r.Context(),
				`SELECT default_depreciation_method FROM ledger_settings WHERE institution_id = $1`,
				id.InstitutionID).Scan(&method); err != nil {
				method = "straight_line"
			}
		}
		// Each method needs its own input and neither can be inferred from the
		// other; the schema refuses an asset that has neither, so supply the
		// conventional default rather than failing on a form the clerk filled
		// in honestly.
		var life any
		var rate any
		switch method {
		case "wdv":
			if req.RatePercent == "" {
				req.RatePercent = "15.00"
			}
			rate = req.RatePercent
		default:
			method = "straight_line"
			if req.LifeYears <= 0 {
				req.LifeYears = 10
			}
			life = req.LifeYears
		}
		var vendor any
		if req.VendorID != "" {
			v, err := uuid.Parse(req.VendorID)
			if err != nil {
				return refusal("vendor_id must be a uuid")
			}
			vendor = v
		}

		if _, err := tx.Exec(r.Context(),
			`SELECT pg_advisory_xact_lock(hashtext($1))`,
			id.InstitutionID.String()+"asset"); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO fixed_assets (institution_id, tag_no, name, category,
			    asset_account_id, purchased_on, cost_paise, salvage_paise, method,
			    useful_life_years, wdv_rate_percent, location, vendor_id,
			    invoice_ref, quantity)
			SELECT $1,
			       COALESCE(NULLIF($2,''),
			         'FA/' || lpad((COALESCE(max(substring(f.tag_no from '[0-9]+$')::int), 0) + 1)::text, 5, '0')),
			       $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, NULLIF($12,''),
			       $13, NULLIF($14,''), $15
			  FROM fixed_assets f
			 WHERE f.institution_id = $1 AND f.tag_no ~ '^FA/[0-9]+$'
			RETURNING id::text, tag_no`,
			id.InstitutionID, req.TagNo, strings.TrimSpace(req.Name), req.Category,
			accountID, purchased, req.CostPaise, req.SalvagePaise, method,
			life, rate, req.Location, vendor, req.InvoiceRef, req.Quantity).
			Scan(&out, &tag); err != nil {
			return err
		}

		if !req.Capitalise {
			return nil
		}
		c, err := loadControls(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		funded := c.Bank
		if req.FundedFromID != "" {
			if funded, err = uuid.Parse(req.FundedFromID); err != nil {
				return refusal("funded_from_account_id must be a uuid")
			}
		}
		if funded == uuid.Nil {
			return refusal("no bank account is set: choose one, or name funded_from_account_id")
		}
		assetID := uuid.MustParse(out)
		_, voucherNo, err = postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
			"purchase", "PJ", purchased,
			"Capitalised "+strings.TrimSpace(req.Name)+" ("+tag+")",
			"fixed_asset", &assetID,
			[]voucherLine{
				{AccountID: accountID, Debit: req.CostPaise, Memo: tag},
				{AccountID: funded, Credit: req.CostPaise},
			})
		return err
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	out2 := map[string]any{"id": out, "tag_no": tag, "capitalised": req.Capitalise}
	if voucherNo != "" {
		out2["voucher_no"] = voucherNo
	}
	httpx.JSON(w, http.StatusCreated, out2)
}

type depreciationLine struct {
	AssetID      string `json:"asset_id"`
	TagNo        string `json:"tag_no"`
	Name         string `json:"name"`
	Method       string `json:"method"`
	OpeningPaise int64  `json:"opening_wdv_paise"`
	ChargePaise  int64  `json:"charge_paise"`
	ClosingPaise int64  `json:"closing_wdv_paise"`
	Note         string `json:"note,omitempty"`
}

type runDepreciationRequest struct {
	FY     int  `json:"fy_start_year"`
	DryRun bool `json:"dry_run,omitempty"`
}

/*
runDepreciation charges a year's depreciation across the register.

	Both methods are implemented because an Indian school genuinely needs both,
	and the choice is per asset:

	  * Straight line — cost less salvage, spread evenly over useful life. This
	    is what the trust's own income and expenditure account uses and what an
	    auditor's working papers assume.
	  * Written-down value — the prescribed rate applied to the opening WDV.
	    This is what the Income Tax Act mandates and what goes on the return.

	The two disagree permanently and on purpose; that difference is a real
	reconciliation an accountant makes, not a bug to be flattened by choosing
	one. Picking either silently would leave half the schools using this
	recomputing the other by hand every March.

	Two conventions, both deliberate:

	  * The first year is apportioned. Straight line is pro-rated by days from
	    the date of purchase, which is what the Companies Act schedule requires.
	    WDV takes half the rate when the asset was in use for fewer than 180
	    days, which is the Income Tax rule. An asset bought in March otherwise
	    absorbs a full year's charge for a fortnight's use.
	  * A charge never takes an asset below its salvage value, and never below
	    nil. A register that depreciates past zero is one somebody has to unwind.

	The whole run is one voucher — Dr depreciation, Cr accumulated depreciation
	— which is how it is done in practice; the per-asset detail lives in
	depreciation_charges, where a unique index makes running the sweep twice in
	one year impossible.
*/
func (s *Server) runDepreciation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req runDepreciationRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	if req.FY == 0 {
		req.FY = currentFY()
	}
	start, end := fyRange(req.FY)

	lines := []depreciationLine{}
	var total int64
	var voucherNo string

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		c, err := loadControls(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if err := c.require(c.Depreciation, "depreciation", c.Accumulated, "accumulated depreciation"); err != nil {
			return err
		}

		rows, err := tx.Query(r.Context(), `
			SELECT f.id::text, f.tag_no, f.name, f.method, f.cost_paise,
			       f.salvage_paise, f.useful_life_years,
			       COALESCE(f.wdv_rate_percent, 0)::float8, f.purchased_on,
			       COALESCE((SELECT sum(dc.charge_paise) FROM depreciation_charges dc
			                  WHERE dc.asset_id = f.id AND dc.fy_start_year < $2), 0),
			       EXISTS (SELECT 1 FROM depreciation_charges dc
			                WHERE dc.asset_id = f.id AND dc.fy_start_year = $2)
			  FROM fixed_assets f
			 WHERE f.purchased_on <= $3
			   AND (f.status = 'in_use' OR f.disposed_on > $1)
			 ORDER BY f.tag_no`, start, req.FY, end)
		if err != nil {
			return err
		}
		type pending struct {
			id              uuid.UUID
			line            depreciationLine
			opening, charge int64
			closing         int64
		}
		queue := []pending{}
		for rows.Next() {
			var assetID, tag, name, method string
			var cost, salvage, priorCharged int64
			var life *int
			var rate float64
			var purchased time.Time
			var already bool
			if err := rows.Scan(&assetID, &tag, &name, &method, &cost, &salvage,
				&life, &rate, &purchased, &priorCharged, &already); err != nil {
				rows.Close()
				return err
			}
			l := depreciationLine{AssetID: assetID, TagNo: tag, Name: name, Method: method}
			opening := cost - priorCharged
			l.OpeningPaise = opening

			switch {
			case already:
				l.Note = "already charged for " + fyLabel(req.FY)
			case opening <= salvage:
				l.Note = "fully depreciated"
			default:
				charge := int64(0)
				firstYear := !purchased.Before(start) && !purchased.After(end)
				switch method {
				case "wdv":
					charge = opening * int64(rate*100) / 10000
					if firstYear {
						// The Income Tax half-rate rule: fewer than 180 days in
						// use in the year of acquisition.
						if int(end.Sub(purchased).Hours()/24) < 180 {
							charge /= 2
							l.Note = "half rate: in use under 180 days"
						}
					}
				default:
					annual := (cost - salvage)
					if life != nil && *life > 0 {
						annual /= int64(*life)
					} else {
						annual = 0
					}
					charge = annual
					if firstYear {
						// Pro-rata by days held, as the Companies Act schedule
						// requires.
						days := int64(end.Sub(purchased).Hours()/24) + 1
						if days < 365 {
							charge = annual * days / 365
							l.Note = fmt.Sprintf("pro-rated for %d days", days)
						}
					}
				}
				// Never below salvage, never below nil.
				if charge > opening-salvage {
					charge = opening - salvage
				}
				if charge < 0 {
					charge = 0
				}
				l.ChargePaise = charge
				l.ClosingPaise = opening - charge
				if charge > 0 {
					queue = append(queue, pending{
						id: uuid.MustParse(assetID), line: l,
						opening: opening, charge: charge, closing: opening - charge,
					})
					total += charge
				} else if l.Note == "" {
					l.Note = "nothing to charge"
				}
			}
			if l.ClosingPaise == 0 && l.ChargePaise == 0 {
				l.ClosingPaise = opening
			}
			lines = append(lines, l)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		if req.DryRun || total == 0 {
			return nil
		}

		entryID, no, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
			"depreciation", "DV", end,
			fmt.Sprintf("Depreciation for %s on %d asset(s)", fyLabel(req.FY), len(queue)),
			"", nil,
			[]voucherLine{
				{AccountID: c.Depreciation, Debit: total},
				{AccountID: c.Accumulated, Credit: total, Memo: "accumulated"},
			})
		if err != nil {
			return err
		}
		voucherNo = no

		for _, p := range queue {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO depreciation_charges (institution_id, asset_id, fy_start_year,
				    method, opening_wdv_paise, charge_paise, closing_wdv_paise,
				    journal_entry_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				id.InstitutionID, p.id, req.FY, p.line.Method,
				p.opening, p.charge, p.closing, entryID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"fy_start_year": req.FY, "fy_label": fyLabel(req.FY),
		"dry_run": req.DryRun, "charge_paise": total,
		"voucher_no": voucherNo, "assets": lines,
	})
}

// --- budgets -----------------------------------------------------------------

type budgetLineRow struct {
	ID             string  `json:"id"`
	AccountID      string  `json:"account_id"`
	Code           string  `json:"code"`
	Name           string  `json:"name"`
	Type           string  `json:"type"`
	Department     *string `json:"department,omitempty"`
	DepartmentID   *string `json:"department_id,omitempty"`
	AllocatedPaise int64   `json:"allocated_paise"`
	RevisedPaise   *int64  `json:"revised_paise,omitempty"`
	ActualPaise    int64   `json:"actual_paise"`
	VariancePaise  int64   `json:"variance_paise"`
	UsedPercent    int     `json:"used_percent"`
	State          string  `json:"state"`
	Notes          *string `json:"notes,omitempty"`
}

/*
getBudgetVariance is what was allowed against what was spent.

	The budget in force is the revision where there is one and the original
	otherwise, and both are reported so a board can see which question it is
	answering. Actuals come from the ledger, not from a parallel tally: a budget
	report that disagrees with the income and expenditure account is a budget
	report nobody trusts twice.
*/
func (s *Server) getBudgetVariance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	fy := fyFrom(r)
	start, end := fyRange(fy)

	var budgetID, name, status string
	lines := []budgetLineRow{}
	var allocated, actual int64

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `
			SELECT id::text, name, status FROM budgets
			 WHERE institution_id = $1 AND fy_start_year = $2
			 ORDER BY created_at DESC LIMIT 1`, id.InstitutionID, fy).
			Scan(&budgetID, &name, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			// No budget for the year is a real state, not a failure: the screen
			// offers to create one.
			return nil
		}
		if err != nil {
			return err
		}
		return scanInto(r.Context(), tx, `
			SELECT bl.id::text, a.id::text, a.code, a.name, a.type,
			       d.name, d.id::text,
			       bl.allocated_paise, bl.revised_paise,
			       COALESCE(act.spent, 0), bl.notes
			  FROM budget_lines bl
			  JOIN ledger_accounts a ON a.id = bl.account_id
			  LEFT JOIN departments d ON d.id = bl.department_id
			  LEFT JOIN LATERAL (
			      SELECT sum(CASE WHEN a.type = 'income'
			                      THEN l.credit_paise - l.debit_paise
			                      ELSE l.debit_paise - l.credit_paise END) AS spent
			        FROM journal_lines l
			        JOIN journal_entries e ON e.id = l.entry_id
			       WHERE l.account_id = bl.account_id
			         AND e.entry_date BETWEEN '`+start.Format(time.DateOnly)+`'
			                              AND '`+end.Format(time.DateOnly)+`'
			         AND e.voucher_type <> 'closing'
			  ) act ON true
			 WHERE bl.budget_id = '`+budgetID+`'::uuid
			 ORDER BY a.code`,
			func(rows pgx.Rows) error {
				var v budgetLineRow
				if err := rows.Scan(&v.ID, &v.AccountID, &v.Code, &v.Name, &v.Type,
					&v.Department, &v.DepartmentID, &v.AllocatedPaise, &v.RevisedPaise,
					&v.ActualPaise, &v.Notes); err != nil {
					return err
				}
				inForce := v.AllocatedPaise
				if v.RevisedPaise != nil {
					inForce = *v.RevisedPaise
				}
				v.VariancePaise = inForce - v.ActualPaise
				if inForce > 0 {
					v.UsedPercent = int(v.ActualPaise * 100 / inForce)
				}
				switch {
				case inForce == 0:
					v.State = "unbudgeted"
				case v.ActualPaise > inForce:
					v.State = "overspent"
				case v.UsedPercent >= 90:
					v.State = "at the limit"
				default:
					v.State = "within budget"
				}
				allocated += inForce
				actual += v.ActualPaise
				lines = append(lines, v)
				return nil
			})
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"fy_start_year": fy, "fy_label": fyLabel(fy),
		"budget_id": budgetID, "name": name, "status": status,
		"items":           lines,
		"allocated_paise": allocated,
		"actual_paise":    actual,
		"variance_paise":  allocated - actual,
	})
}

type saveBudgetRequest struct {
	FY     int    `json:"fy_start_year"`
	Name   string `json:"name,omitempty"`
	Status string `json:"status,omitempty"`
	Notes  string `json:"notes,omitempty"`
}

func (s *Server) saveBudget(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req saveBudgetRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.FY == 0 {
		req.FY = currentFY()
	}
	if req.Name == "" {
		req.Name = "Annual budget"
	}
	if req.Status == "" {
		req.Status = "draft"
	}

	var out string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO budgets (institution_id, fy_start_year, name, status, notes,
			    approved_by, approved_at)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),
			        CASE WHEN $4 <> 'draft' THEN $6::uuid END,
			        CASE WHEN $4 <> 'draft' THEN now() END)
			ON CONFLICT (institution_id, fy_start_year, name) DO UPDATE SET
			    status = EXCLUDED.status, notes = EXCLUDED.notes,
			    approved_by = COALESCE(EXCLUDED.approved_by, budgets.approved_by),
			    approved_at = COALESCE(EXCLUDED.approved_at, budgets.approved_at)
			RETURNING id::text`,
			id.InstitutionID, req.FY, req.Name, req.Status, req.Notes,
			nullUUIDArg(id.UserID)).Scan(&out)
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out, "fy_start_year": req.FY})
}

type saveBudgetLineRequest struct {
	BudgetID       string `json:"budget_id,omitempty"`
	FY             int    `json:"fy_start_year,omitempty"`
	AccountID      string `json:"account_id"`
	DepartmentID   string `json:"department_id,omitempty"`
	AllocatedPaise int64  `json:"allocated_paise"`
	RevisedPaise   *int64 `json:"revised_paise,omitempty"`
	Notes          string `json:"notes,omitempty"`
}

func (s *Server) saveBudgetLine(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req saveBudgetLineRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		httpx.BadRequest(w, r, "account_id must be a uuid")
		return
	}
	if req.AllocatedPaise < 0 {
		httpx.BadRequest(w, r, "an allocation cannot be negative")
		return
	}

	var out string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		budgetID := uuid.Nil
		if req.BudgetID != "" {
			if budgetID, err = uuid.Parse(req.BudgetID); err != nil {
				return refusal("budget_id must be a uuid")
			}
		} else {
			fy := req.FY
			if fy == 0 {
				fy = currentFY()
			}
			// The budget for the year, created on first use. Asking a clerk to
			// create a container before they can enter a figure is a step that
			// exists only because the schema needed one.
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO budgets (institution_id, fy_start_year)
				VALUES ($1,$2)
				ON CONFLICT (institution_id, fy_start_year, name) DO UPDATE
				    SET fy_start_year = EXCLUDED.fy_start_year
				RETURNING id`, id.InstitutionID, fy).Scan(&budgetID); err != nil {
				return err
			}
		}
		var dept any
		if req.DepartmentID != "" {
			d, err := uuid.Parse(req.DepartmentID)
			if err != nil {
				return refusal("department_id must be a uuid")
			}
			dept = d
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO budget_lines (institution_id, budget_id, account_id,
			    department_id, allocated_paise, revised_paise, notes)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''))
			ON CONFLICT (budget_id, account_id,
			             COALESCE(department_id,'00000000-0000-0000-0000-000000000000'::uuid))
			DO UPDATE SET allocated_paise = EXCLUDED.allocated_paise,
			              revised_paise = EXCLUDED.revised_paise,
			              notes = EXCLUDED.notes
			RETURNING id::text`,
			id.InstitutionID, budgetID, accountID, dept,
			req.AllocatedPaise, req.RevisedPaise, req.Notes).Scan(&out)
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": out})
}

// --- daybook and cashbook ----------------------------------------------------

/*
getDaybook is one day's vouchers, in the order they were written.

	The daybook is the first thing an inspector asks for and the last thing most
	school software has. It answers one question — what happened on the ninth —
	and it must answer it completely, which is why it lists every voucher type
	rather than only receipts.
*/
func (s *Server) getDaybook(w http.ResponseWriter, r *http.Request) {
	on, err := parseDate(r.URL.Query().Get("on"), time.Now())
	if err != nil {
		httpx.BadRequest(w, r, "on must be YYYY-MM-DD")
		return
	}
	items, err := collect(s, r, `
		SELECT e.id::text, e.voucher_no, e.voucher_type,
		       to_char(e.entry_date,'YYYY-MM-DD'), e.fy_start_year, e.narration,
		       e.source_kind,
		       COALESCE((SELECT sum(l.debit_paise) FROM journal_lines l WHERE l.entry_id = e.id), 0),
		       COALESCE((SELECT count(*) FROM journal_lines l WHERE l.entry_id = e.id), 0)::int,
		       u.full_name,
		       COALESCE((SELECT string_agg(a.code || ' ' || a.name, ' / ' ORDER BY l.line_no)
		                   FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
		                  WHERE l.entry_id = e.id), ''),
		       false
		  FROM journal_entries e
		  LEFT JOIN users u ON u.id = e.posted_by
		 WHERE e.entry_date = $1
		 ORDER BY e.voucher_type, e.voucher_no`, []any{on},
		func(rows pgx.Rows) (voucherRow, error) {
			var v voucherRow
			return v, rows.Scan(&v.ID, &v.VoucherNo, &v.VoucherType, &v.EntryDate,
				&v.FY, &v.Narration, &v.SourceKind, &v.AmountPaise, &v.Lines,
				&v.PostedBy, &v.Accounts, &v.YearClosed)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	var total int64
	for _, v := range items {
		total += v.AmountPaise
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"on": on.Format(time.DateOnly), "items": items,
		"vouchers": len(items), "total_paise": total,
	})
}

type cashbookRow struct {
	Date         string `json:"date"`
	VoucherNo    string `json:"voucher_no"`
	Narration    string `json:"narration"`
	Contra       string `json:"contra"`
	InPaise      int64  `json:"in_paise"`
	OutPaise     int64  `json:"out_paise"`
	BalancePaise int64  `json:"balance_paise"`
}

type cashbookAccount struct {
	AccountID    string        `json:"account_id"`
	Code         string        `json:"code"`
	Name         string        `json:"name"`
	OpeningPaise int64         `json:"opening_paise"`
	InPaise      int64         `json:"in_paise"`
	OutPaise     int64         `json:"out_paise"`
	ClosingPaise int64         `json:"closing_paise"`
	Entries      []cashbookRow `json:"entries"`
}

/*
getCashbook is the cash and bank book: what came in, what went out, what is left.

	One section per cash or bank account, each with its own opening and closing
	balance, because "the closing cash register" a school signs at the end of
	the day is per drawer. Merging them into one running total would produce a
	figure that matches nothing anybody can count.
*/
func (s *Server) getCashbook(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	q := r.URL.Query()
	today := time.Now()
	from, err := parseDate(q.Get("from"), time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		httpx.BadRequest(w, r, "from must be YYYY-MM-DD")
		return
	}
	to, err := parseDate(q.Get("to"), today)
	if err != nil {
		httpx.BadRequest(w, r, "to must be YYYY-MM-DD")
		return
	}

	accounts := []cashbookAccount{}
	byID := map[string]int{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := scanInto(r.Context(), tx, `
			SELECT a.id::text, a.code, a.name,
			       COALESCE((SELECT sum(l.debit_paise) - sum(l.credit_paise)
			                   FROM journal_lines l
			                   JOIN journal_entries e ON e.id = l.entry_id
			                  WHERE l.account_id = a.id
			                    AND e.entry_date < '`+from.Format(time.DateOnly)+`'), 0)
			  FROM ledger_accounts a
			 WHERE a.is_cash AND NOT a.is_group
			 ORDER BY a.code`,
			func(rows pgx.Rows) error {
				var v cashbookAccount
				if err := rows.Scan(&v.AccountID, &v.Code, &v.Name, &v.OpeningPaise); err != nil {
					return err
				}
				v.Entries = []cashbookRow{}
				byID[v.AccountID] = len(accounts)
				accounts = append(accounts, v)
				return nil
			}); err != nil {
			return err
		}

		return scanInto(r.Context(), tx, `
			SELECT l.account_id::text, to_char(e.entry_date,'YYYY-MM-DD'),
			       e.voucher_no, e.narration,
			       COALESCE((SELECT string_agg(DISTINCT a2.name, ', ')
			                   FROM journal_lines l2
			                   JOIN ledger_accounts a2 ON a2.id = l2.account_id
			                  WHERE l2.entry_id = e.id AND l2.account_id <> l.account_id), ''),
			       l.debit_paise, l.credit_paise
			  FROM journal_lines l
			  JOIN journal_entries e ON e.id = l.entry_id
			  JOIN ledger_accounts a ON a.id = l.account_id
			 WHERE a.is_cash AND NOT a.is_group
			   AND e.entry_date BETWEEN '`+from.Format(time.DateOnly)+`'
			                        AND '`+to.Format(time.DateOnly)+`'
			 ORDER BY e.entry_date, e.voucher_no, l.line_no`,
			func(rows pgx.Rows) error {
				var accID string
				var v cashbookRow
				if err := rows.Scan(&accID, &v.Date, &v.VoucherNo, &v.Narration,
					&v.Contra, &v.InPaise, &v.OutPaise); err != nil {
					return err
				}
				i, ok := byID[accID]
				if !ok {
					return nil
				}
				a := &accounts[i]
				a.InPaise += v.InPaise
				a.OutPaise += v.OutPaise
				v.BalancePaise = a.OpeningPaise + a.InPaise - a.OutPaise
				a.Entries = append(a.Entries, v)
				return nil
			})
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var openTotal, inTotal, outTotal, closeTotal int64
	for i := range accounts {
		accounts[i].ClosingPaise = accounts[i].OpeningPaise + accounts[i].InPaise - accounts[i].OutPaise
		openTotal += accounts[i].OpeningPaise
		inTotal += accounts[i].InPaise
		outTotal += accounts[i].OutPaise
		closeTotal += accounts[i].ClosingPaise
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"from": from.Format(time.DateOnly), "to": to.Format(time.DateOnly),
		"accounts": accounts,
		"totals": map[string]any{
			"opening_paise": openTotal, "in_paise": inTotal,
			"out_paise": outTotal, "closing_paise": closeTotal,
		},
	})
}

// --- taxation and audit ------------------------------------------------------

type taxVendorRow struct {
	VendorName   string  `json:"vendor_name"`
	GSTIN        *string `json:"gstin,omitempty"`
	PAN          *string `json:"pan,omitempty"`
	Bills        int     `json:"bills"`
	TaxablePaise int64   `json:"taxable_paise"`
	TaxPaise     int64   `json:"tax_paise"`
	TDSPaise     int64   `json:"tds_paise"`
}

/*
getTaxReport is what the school withheld and what it was charged.

	Two halves, both sourced from records that already exist rather than from a
	tax module nobody would maintain: GST from the tax column on purchase bills,
	and TDS from what was actually withheld on payment. A vendor with a GSTIN
	and no tax on their bills, or tax with no GSTIN, is exactly what a reviewer
	is looking for, so both are reported rather than filtered out.

	Statutory dues come from the ledger's own liability accounts, which is the
	only place they can be checked against what was paid over.
*/
func (s *Server) getTaxReport(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	fy := fyFrom(r)
	start, end := fyRange(fy)

	vendors := []taxVendorRow{}
	dues := []statementRow{}
	var taxable, tax, tds int64

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := scanInto(r.Context(), tx, `
			SELECT v.name, v.gstin, v.pan, count(b.id)::int,
			       COALESCE(sum(b.taxable_paise), 0), COALESCE(sum(b.tax_paise), 0),
			       COALESCE(sum(p.tds), 0)
			  FROM vendors v
			  JOIN vendor_bills b ON b.vendor_id = v.id AND b.status = 'approved'
			   AND b.bill_date BETWEEN '`+start.Format(time.DateOnly)+`'
			                       AND '`+end.Format(time.DateOnly)+`'
			  LEFT JOIN LATERAL (
			      SELECT COALESCE(sum(vp.tds_paise), 0) AS tds
			        FROM vendor_payments vp WHERE vp.bill_id = b.id
			  ) p ON true
			 GROUP BY v.id, v.name, v.gstin, v.pan
			 ORDER BY sum(b.taxable_paise) DESC`,
			func(rows pgx.Rows) error {
				var v taxVendorRow
				if err := rows.Scan(&v.VendorName, &v.GSTIN, &v.PAN, &v.Bills,
					&v.TaxablePaise, &v.TaxPaise, &v.TDSPaise); err != nil {
					return err
				}
				taxable += v.TaxablePaise
				tax += v.TaxPaise
				tds += v.TDSPaise
				vendors = append(vendors, v)
				return nil
			}); err != nil {
			return err
		}

		// The statutory liability accounts: what is owed to the government and
		// still sitting in the school's bank.
		return scanInto(r.Context(), tx, `
			SELECT a.code, a.name, COALESCE(p.name,'—'),
			       COALESCE(sum(l.credit_paise) - sum(l.debit_paise), 0), false
			  FROM ledger_accounts a
			  LEFT JOIN ledger_accounts p ON p.id = a.parent_id
			  LEFT JOIN journal_lines l ON l.account_id = a.id
			  LEFT JOIN journal_entries e ON e.id = l.entry_id
			   AND e.entry_date <= '`+end.Format(time.DateOnly)+`'
			 WHERE a.code IN ('2130','2140','2150','2160','2170')
			 GROUP BY a.id, a.code, a.name, p.name
			 ORDER BY a.code`,
			func(rows pgx.Rows) error {
				var v statementRow
				if err := rows.Scan(&v.Code, &v.Name, &v.Group, &v.Paise, &v.IsGroup); err != nil {
					return err
				}
				dues = append(dues, v)
				return nil
			})
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"fy_start_year": fy, "fy_label": fyLabel(fy),
		"from": start.Format(time.DateOnly), "to": end.Format(time.DateOnly),
		"vendors": vendors, "statutory_dues": dues,
		"taxable_paise": taxable, "tax_paise": tax, "tds_withheld_paise": tds,
	})
}

type auditCheck struct {
	Check   string `json:"check"`
	Detail  string `json:"detail"`
	Count   int    `json:"count"`
	Paise   int64  `json:"paise,omitempty"`
	Passing bool   `json:"passing"`
}

/*
getAuditReport is the set of questions an auditor opens with.

	Every check here is one somebody would otherwise run by hand against the
	database, and each is phrased so that passing is the boring answer. The
	first is the one that matters: if any voucher in the books does not balance,
	nothing else on this page is worth reading — and because the database
	refuses such a voucher at commit, a non-zero count here means something went
	round the schema rather than through it.
*/
func (s *Server) getAuditReport(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	fy := fyFrom(r)
	start, end := fyRange(fy)

	checks := []auditCheck{}
	years := []yearRow{}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		add := func(name, detail string, n int, paise int64, passing bool) {
			checks = append(checks, auditCheck{
				Check: name, Detail: detail, Count: n, Paise: paise, Passing: passing})
		}

		var n int
		var amt int64

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM (
			    SELECT l.entry_id FROM journal_lines l
			     GROUP BY l.entry_id
			    HAVING sum(l.debit_paise) <> sum(l.credit_paise)
			) x`).Scan(&n); err != nil {
			return err
		}
		add("Every voucher balances",
			"Debits equal credits on every entry in the books. Enforced by the database at commit; a failure here means a write went round the schema.",
			n, 0, n == 0)

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM journal_entries e
			 WHERE NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id)`).
			Scan(&n); err != nil {
			return err
		}
		add("No empty vouchers", "A voucher with no lines records nothing and hides a failed save.", n, 0, n == 0)

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int, COALESCE(sum(b.total_paise), 0)
			  FROM vendor_bills b
			 WHERE b.status = 'approved' AND b.journal_entry_id IS NULL`).
			Scan(&n, &amt); err != nil {
			return err
		}
		add("Approved bills are posted",
			"An approved bill that never reached the ledger is a liability the balance sheet does not show.",
			n, amt, n == 0)

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int, COALESCE(sum(p.amount_paise), 0)
			  FROM petty_cash_vouchers p
			 WHERE p.status = 'approved' AND p.journal_entry_id IS NULL`).
			Scan(&n, &amt); err != nil {
			return err
		}
		add("Approved petty cash is posted",
			"Cash out of the tin with nothing in the ledger against it.", n, amt, n == 0)

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int, COALESCE(sum(x.excess), 0) FROM (
			    SELECT b.id, COALESCE(sum(vp.amount_paise), 0) - b.total_paise AS excess
			      FROM vendor_bills b
			      LEFT JOIN vendor_payments vp ON vp.bill_id = b.id
			     GROUP BY b.id, b.total_paise
			    HAVING COALESCE(sum(vp.amount_paise), 0) > b.total_paise
			) x`).Scan(&n, &amt); err != nil {
			return err
		}
		add("No bill is overpaid",
			"Paying more than a bill was for. Refused by the database on every payment.",
			n, amt, n == 0)

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM (
			    SELECT asset_id, fy_start_year FROM depreciation_charges
			     GROUP BY asset_id, fy_start_year HAVING count(*) > 1
			) x`).Scan(&n); err != nil {
			return err
		}
		add("Depreciation charged once a year",
			"Running the annual sweep twice would halve the book value of the whole register.",
			n, 0, n == 0)

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM fixed_assets f
			 WHERE f.status = 'in_use'
			   AND NOT EXISTS (SELECT 1 FROM depreciation_charges dc
			                    WHERE dc.asset_id = f.id AND dc.fy_start_year = $1)
			   AND f.purchased_on <= $2`, fy, end).Scan(&n); err != nil {
			return err
		}
		add("Depreciation is up to date",
			"Assets in use that carry no charge for "+fyLabel(fy)+". Run the annual depreciation.",
			n, 0, n == 0)

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int, COALESCE(sum(l.debit_paise), 0)
			  FROM journal_lines l
			  JOIN journal_entries e ON e.id = l.entry_id
			  JOIN ledger_accounts a ON a.id = l.account_id
			 WHERE a.is_group AND e.entry_date BETWEEN $1 AND $2`, start, end).
			Scan(&n, &amt); err != nil {
			return err
		}
		add("Nothing posted to a group heading",
			"A posting against a heading rather than an account balances perfectly and reports nowhere useful.",
			n, amt, n == 0)

		/* The register is a subsidiary ledger and must agree with the account
		   it summarises. It drifts when an asset is entered in the register but
		   the purchase was never booked, or booked to the wrong head — and the
		   trial balance goes on balancing perfectly while the balance sheet
		   understates what the school owns. Only a reconciliation finds it. */
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int, COALESCE(sum(abs(x.gap)), 0) FROM (
			    SELECT a.id,
			           COALESCE((SELECT sum(f.cost_paise) FROM fixed_assets f
			                      WHERE f.asset_account_id = a.id AND f.status <> 'disposed'), 0)
			         - COALESCE((SELECT sum(l.debit_paise) - sum(l.credit_paise)
			                       FROM journal_lines l WHERE l.account_id = a.id), 0) AS gap
			      FROM ledger_accounts a
			     WHERE a.institution_id = $1 AND NOT a.is_group AND NOT a.is_contra
			       AND EXISTS (SELECT 1 FROM fixed_assets f WHERE f.asset_account_id = a.id)
			) x WHERE x.gap <> 0`, id.InstitutionID).Scan(&n, &amt); err != nil {
			return err
		}
		add("Asset register ties to the ledger",
			"Cost in the register against the balance on the asset account. A gap means a purchase was never capitalised, or was booked to another head.",
			n, amt, n == 0)

		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM ledger_settings
			 WHERE institution_id = $1
			   AND (cash_account_id IS NULL OR bank_account_id IS NULL
			        OR payable_account_id IS NULL OR surplus_account_id IS NULL)`,
			id.InstitutionID).Scan(&n); err != nil {
			return err
		}
		add("Control accounts are set",
			"Cash, bank, creditors and the surplus account. The automatic postings refuse to guess.",
			n, 0, n == 0)

		return scanInto(r.Context(), tx, `
			SELECT y.fy_start_year, y.status, to_char(y.closed_on,'YYYY-MM-DD'),
			       u.full_name, ce.voucher_no, y.surplus_paise,
			       COALESCE((SELECT count(*) FROM journal_entries e
			                  WHERE e.institution_id = y.institution_id
			                    AND e.fy_start_year = y.fy_start_year), 0)::int
			  FROM accounting_years y
			  LEFT JOIN users u ON u.id = y.closed_by
			  LEFT JOIN journal_entries ce ON ce.id = y.closing_entry_id
			 ORDER BY y.fy_start_year DESC`,
			func(rows pgx.Rows) error {
				var v yearRow
				if err := rows.Scan(&v.FY, &v.Status, &v.ClosedOn, &v.ClosedBy,
					&v.ClosingVno, &v.SurplusPaise, &v.Vouchers); err != nil {
					return err
				}
				v.Label = fyLabel(v.FY)
				years = append(years, v)
				return nil
			})
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	failing := 0
	for _, c := range checks {
		if !c.Passing {
			failing++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"fy_start_year": fy, "fy_label": fyLabel(fy),
		"checks": checks, "years": years,
		"failing": failing, "clean": failing == 0,
	})
}

// --- the fee posting contract ------------------------------------------------

/*
The contract between the fee tables and the books.

	The fee tables are live and authoritative for what a family owes. This
	domain does not touch them: fees.go, internal/fees and every table they own
	are read here and never written. What follows is the agreed mapping, and the
	sweep that applies it when the integration lead decides it should run.

	  invoice issued   Dr Fee Receivable      net
	                   Cr Fee Income          gross less discount
	                   Cr Late Fee and Fines  fine
	  payment cleared  Dr Cash or Bank        amount
	                   Cr Fee Receivable      amount
	  cheque bounced   the reverse of the payment, dated the dishonour
	  refund paid      Dr Fee Income          amount
	                   Cr Cash or Bank        amount

	Three rules keep revenue from being counted twice.

	Revenue is recognised once, on the invoice, and never again on the payment —
	a receipt moves money between two balance sheet accounts and touches no
	income account at all. Posting receipts to income instead would be cash
	accounting, and mixing the two is how a school reports its tuition twice.

	Concessions are already netted into the invoice, so the income posted is
	what was actually charged. Raising the gross and booking the discount as an
	expense would inflate both sides of the income and expenditure account.

	Held cheques are not posted. Only a payment the fee module has marked
	successful represents money the school has. A post-dated cheque in the
	drawer is a promise, and the fee module already reports it separately.

	Every entry carries source_kind and source_id, and a unique index on the
	pair means the sweep can be run as often as anybody likes without posting
	anything twice. That index, not this comment, is the guarantee.
*/
type feePostingItem struct {
	Kind        string `json:"kind"`
	SourceID    string `json:"source_id"`
	Reference   string `json:"reference"`
	Date        string `json:"date"`
	AmountPaise int64  `json:"amount_paise"`
	Debit       string `json:"debit"`
	Credit      string `json:"credit"`
	Posted      bool   `json:"posted"`
}

// previewFeePosting shows what the sweep would do, and changes nothing.
func (s *Server) previewFeePosting(w http.ResponseWriter, r *http.Request) {
	s.feePosting(w, r, true)
}

// runFeePosting applies the contract. Safe to run repeatedly.
func (s *Server) runFeePosting(w http.ResponseWriter, r *http.Request) {
	s.feePosting(w, r, false)
}

func (s *Server) feePosting(w http.ResponseWriter, r *http.Request, preview bool) {
	id := httpx.IdentityFrom(r.Context())
	fy := fyFrom(r)
	start, end := fyRange(fy)
	if v, err := parseDate(r.URL.Query().Get("from"), start); err == nil {
		start = v
	}
	if v, err := parseDate(r.URL.Query().Get("to"), end); err == nil {
		end = v
	}

	items := []feePostingItem{}
	var posted, skipped int
	var postedPaise int64

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		c, err := loadControls(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if err := c.require(
			c.FeeReceivable, "fee receivable",
			c.FeeIncome, "fee income",
			c.Cash, "cash", c.Bank, "bank"); err != nil {
			return err
		}
		var fineAcc uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT id FROM ledger_accounts
			 WHERE institution_id = $1 AND code = '4180' AND NOT is_group`,
			id.InstitutionID).Scan(&fineAcc); err != nil {
			fineAcc = c.FeeIncome
		}

		// --- invoices ----------------------------------------------------
		type inv struct {
			id                        uuid.UUID
			no                        string
			issued                    time.Time
			net, gross, discount, fin int64
			already                   bool
		}
		invoices := []inv{}
		rows, err := tx.Query(r.Context(), `
			SELECT i.id, i.invoice_no, i.issued_on, i.net_paise, i.gross_paise,
			       i.discount_paise, i.fine_paise,
			       EXISTS (SELECT 1 FROM journal_entries e
			                WHERE e.institution_id = i.institution_id
			                  AND e.source_kind = 'fee_invoice' AND e.source_id = i.id)
			  FROM invoices i
			 WHERE i.status NOT IN ('cancelled','draft')
			   AND i.issued_on BETWEEN $1 AND $2
			 ORDER BY i.issued_on, i.invoice_no`, start, end)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v inv
			if err := rows.Scan(&v.id, &v.no, &v.issued, &v.net, &v.gross,
				&v.discount, &v.fin, &v.already); err != nil {
				rows.Close()
				return err
			}
			invoices = append(invoices, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, v := range invoices {
			items = append(items, feePostingItem{
				Kind: "fee_invoice", SourceID: v.id.String(), Reference: v.no,
				Date: v.issued.Format(time.DateOnly), AmountPaise: v.net,
				Debit: "Fee Receivable", Credit: "Fee Income", Posted: v.already,
			})
			if v.already || v.net <= 0 {
				skipped++
				continue
			}
			if preview {
				continue
			}
			lines := []voucherLine{
				{AccountID: c.FeeReceivable, Debit: v.net, Memo: v.no},
			}
			// Income is the net charge, so a concession never becomes revenue
			// the school did not earn.
			if charged := v.gross - v.discount; charged > 0 {
				lines = append(lines, voucherLine{AccountID: c.FeeIncome, Credit: charged})
			}
			if v.fin > 0 {
				lines = append(lines, voucherLine{AccountID: fineAcc, Credit: v.fin, Memo: "late fee"})
			}
			src := v.id
			if _, _, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
				"sales", "SV", v.issued, "Fee invoice "+v.no,
				"fee_invoice", &src, lines); err != nil {
				return err
			}
			posted++
			postedPaise += v.net
		}

		// --- payments ----------------------------------------------------
		type pay struct {
			id      uuid.UUID
			receipt *string
			paidOn  time.Time
			amount  int64
			mode    string
			already bool
		}
		payments := []pay{}
		prows, err := tx.Query(r.Context(), `
			SELECT p.id, p.receipt_no, p.paid_on, p.amount_paise, p.mode,
			       EXISTS (SELECT 1 FROM journal_entries e
			                WHERE e.institution_id = p.institution_id
			                  AND e.source_kind = 'fee_payment' AND e.source_id = p.id)
			  FROM payments p
			 WHERE p.status = 'success'
			   AND p.paid_on BETWEEN $1 AND $2
			 ORDER BY p.paid_on, p.receipt_no`, start, end)
		if err != nil {
			return err
		}
		for prows.Next() {
			var v pay
			if err := prows.Scan(&v.id, &v.receipt, &v.paidOn, &v.amount,
				&v.mode, &v.already); err != nil {
				prows.Close()
				return err
			}
			payments = append(payments, v)
		}
		prows.Close()
		if err := prows.Err(); err != nil {
			return err
		}

		for _, v := range payments {
			ref := "—"
			if v.receipt != nil {
				ref = *v.receipt
			}
			/* Cash to the drawer, everything else to the bank. An adjustment is
			   not a receipt at all — it settles an invoice against a credit
			   note — so it relieves the receivable against the write-off head
			   rather than pretending money arrived. */
			into := c.Bank
			debitName := "Bank"
			switch v.mode {
			case "cash":
				into, debitName = c.Cash, "Cash in Hand"
			case "adjustment":
				var writeOff uuid.UUID
				if err := tx.QueryRow(r.Context(), `
					SELECT id FROM ledger_accounts
					 WHERE institution_id = $1 AND code = '5920' AND NOT is_group`,
					id.InstitutionID).Scan(&writeOff); err == nil {
					into, debitName = writeOff, "Fee Concessions and Write-offs"
				}
			}
			items = append(items, feePostingItem{
				Kind: "fee_payment", SourceID: v.id.String(), Reference: ref,
				Date: v.paidOn.Format(time.DateOnly), AmountPaise: v.amount,
				Debit: debitName, Credit: "Fee Receivable", Posted: v.already,
			})
			if v.already {
				skipped++
				continue
			}
			if preview {
				continue
			}
			src := v.id
			if _, _, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
				"receipt", "RV", v.paidOn, "Fee receipt "+ref,
				"fee_payment", &src, []voucherLine{
					{AccountID: into, Debit: v.amount, Memo: ref},
					{AccountID: c.FeeReceivable, Credit: v.amount},
				}); err != nil {
				return err
			}
			posted++
			postedPaise += v.amount
		}

		/* A cheque posted while it was good and dishonoured since.

		   The sweep is idempotent by source, so it will never revisit the
		   original receipt — which is correct, that receipt was true when it
		   was written. The reversal is its own voucher with its own source
		   key, which is both how accounting handles a dishonour and what keeps
		   the idempotence intact. */
		type bounce struct {
			id      uuid.UUID
			receipt *string
			amount  int64
			mode    string
		}
		bounces := []bounce{}
		brows, err := tx.Query(r.Context(), `
			SELECT p.id, p.receipt_no, p.amount_paise, p.mode
			  FROM payments p
			 WHERE p.status = 'bounced'
			   AND EXISTS (SELECT 1 FROM journal_entries e
			                WHERE e.institution_id = p.institution_id
			                  AND e.source_kind = 'fee_payment' AND e.source_id = p.id)
			   AND NOT EXISTS (SELECT 1 FROM journal_entries e
			                    WHERE e.institution_id = p.institution_id
			                      AND e.source_kind = 'fee_payment_reversal'
			                      AND e.source_id = p.id)`)
		if err != nil {
			return err
		}
		for brows.Next() {
			var v bounce
			if err := brows.Scan(&v.id, &v.receipt, &v.amount, &v.mode); err != nil {
				brows.Close()
				return err
			}
			bounces = append(bounces, v)
		}
		brows.Close()
		if err := brows.Err(); err != nil {
			return err
		}

		for _, v := range bounces {
			ref := "—"
			if v.receipt != nil {
				ref = *v.receipt
			}
			items = append(items, feePostingItem{
				Kind: "fee_payment_reversal", SourceID: v.id.String(), Reference: ref,
				Date: time.Now().Format(time.DateOnly), AmountPaise: v.amount,
				Debit: "Fee Receivable", Credit: "Bank", Posted: false,
			})
			if preview {
				continue
			}
			from := c.Bank
			if v.mode == "cash" {
				from = c.Cash
			}
			src := v.id
			if _, _, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
				"journal", "JV", time.Now(), "Cheque dishonoured — receipt "+ref,
				"fee_payment_reversal", &src, []voucherLine{
					{AccountID: c.FeeReceivable, Debit: v.amount, Memo: ref},
					{AccountID: from, Credit: v.amount},
				}); err != nil {
				return err
			}
			posted++
		}
		return nil
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}

	// Newest first is what a reviewer wants; the sweep itself runs oldest first
	// so the receivable is never relieved before it is raised.
	sort.SliceStable(items, func(i, j int) bool { return items[i].Date > items[j].Date })
	// The counts are taken before the list is trimmed. A preview that reported
	// "300 to post" because that is where the display stops would understate
	// the work every time a school had more than three hundred invoices.
	candidates := len(items)
	var pending int
	for _, it := range items {
		if !it.Posted {
			pending++
		}
	}
	if len(items) > 300 {
		items = items[:300]
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"fy_start_year": fy, "fy_label": fyLabel(fy),
		"from": start.Format(time.DateOnly), "to": end.Format(time.DateOnly),
		"preview": preview, "posted": posted, "already_posted": skipped,
		"candidates": candidates, "outstanding": pending,
		"shown":        len(items),
		"posted_paise": postedPaise, "items": items,
		"contract": []map[string]string{
			{"event": "Invoice issued", "debit": "1210 Fee Receivable", "credit": "4110 Fee Income + 4180 Late Fee", "amount": "net of concession"},
			{"event": "Payment cleared", "debit": "1310 Cash / 1330 Bank", "credit": "1210 Fee Receivable", "amount": "amount received"},
			{"event": "Cheque dishonoured", "debit": "1210 Fee Receivable", "credit": "1310 Cash / 1330 Bank", "amount": "the reversed receipt"},
			{"event": "Fee adjustment", "debit": "5920 Fee Concessions and Write-offs", "credit": "1210 Fee Receivable", "amount": "amount adjusted"},
		},
	})
}
