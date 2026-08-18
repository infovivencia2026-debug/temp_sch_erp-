package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Banking: the statement, the payout, and the account number.

   Three screens that share two nouns, which is why they share a file.

   ---- Bank reconciliation ------------------------------------------------

   The feature is the matching, and the matching is three passes, not one:

     exact      amount, date and the bank's own reference all agree. Applied
                without asking, because there is nothing to ask.
     candidate  amount agrees and the date is close, but the reference does
                not — or is absent, which is most of the time. Offered to a
                person, never applied. A fuzzy match applied automatically is
                how a school's books acquire a receipt nobody ever took.
     residue    what is left on both sides. Bank lines with no book entry, and
                book entries with no bank line.

   The residue IS the reconciliation statement. Everything above it exists to
   make it small.

   Finalising freezes it. A period an auditor has signed must not quietly
   change because somebody backdated a receipt into it last Tuesday, so the
   figures are stored on bank_reconciliations rather than recomputed, and a
   database trigger — not this file — refuses to let a finalised period's lines
   move. Reopening is supported, recorded, and never silent.

   ---- Connected banking payouts ------------------------------------------

   Maker/checker, enforced on the backend twice: a CHECK constraint that the
   approver is not the creator, and the same test in decidePayoutBatch so the
   caller gets 403 with a sentence rather than a constraint violation.

   There is NO live bank integration here and this file never pretends there
   is. PayoutProvider has one implementation, fileExportProvider, which renders
   the batch as the CSV every Indian bank's bulk-transfer upload accepts. The
   live path exists as a method that refuses, naming what it would need. A
   status ladder that stopped at 'paid' would be a lie told by a state machine.

   ---- Student bank account register --------------------------------------

   Sensitive PII under the DPDP Act. The masking is server-side: a list
   response carries only the last four digits, so a screen that forgets to mask
   has nothing to leak. Revealing the full number needs finance.export and
   writes an audit_log row naming the student — and it fails closed, refusing
   to return the number if the audit write fails, because an unaudited reveal
   is the thing the control exists to prevent.

   ---- What this file deliberately does not touch --------------------------

   payments, invoices, refunds, vendor_bills and payslips are read, never
   altered. Fee structures and receipts are being edited elsewhere this round.
   Where a link was needed it went on a table in this migration pointing at
   theirs — bank_statement_lines.match_kind/match_id — rather than a column on
   payments. payments.reconciled_at exists from 00001 and is left alone: the
   match on the line is the record, and two places to look would eventually be
   two different answers. */

// --- errors ------------------------------------------------------------------

// ErrPayoutTransmissionUnavailable is what the live path returns, always.
// Named rather than stringly typed so a caller can tell "this deployment
// cannot transmit" from "the bank refused us" — which would be an incident,
// and which nothing here can currently produce.
var ErrPayoutTransmissionUnavailable = errors.New(
	"live bank transmission is not configured: this deployment holds no bank API credentials")

var errAmountUnparseable = errors.New("amount is not a decimal number")
var errAmountTooPrecise = errors.New("amount has more than two decimal places")

// --- money -------------------------------------------------------------------

/*
paiseFromDecimal turns a bank's decimal string into integer paise.

	Never float. 1234.35 has no exact binary representation, and a statement of
	four hundred lines summed through float64 lands a few paise away from the
	bank's own total — which is exactly the difference a reconciliation is
	trying to explain, arriving from the arithmetic rather than the books.

	Handles what actually turns up in Indian bank exports: thousands
	separators in the Indian grouping, a rupee symbol, a trailing Dr/Cr, and
	parenthesised negatives from anything that has been through Excel.

	A third decimal place is refused rather than rounded. Silently rounding is
	how a mis-parsed column becomes a reconciliation that nearly ties.
*/
func paiseFromDecimal(raw string) (int64, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, errAmountUnparseable
	}

	neg := false
	if strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		neg = true
		s = strings.TrimSpace(s[1 : len(s)-1])
	}

	// A trailing Dr/Cr is the bank telling you the sign in words.
	switch up := strings.ToUpper(s); {
	case strings.HasSuffix(up, "DR"):
		neg = true
		s = strings.TrimSpace(s[:len(s)-2])
	case strings.HasSuffix(up, "CR"):
		s = strings.TrimSpace(s[:len(s)-2])
	}

	s = strings.NewReplacer(",", "", " ", "", " ", "", "₹", "").Replace(s)
	for _, prefix := range []string{"INR", "inr", "Rs.", "RS.", "rs.", "Rs", "RS", "rs"} {
		s = strings.TrimPrefix(s, prefix)
	}
	switch {
	case strings.HasPrefix(s, "-"):
		neg = !neg
		s = s[1:]
	case strings.HasPrefix(s, "+"):
		s = s[1:]
	}
	if s == "" {
		return 0, errAmountUnparseable
	}

	whole, frac := s, ""
	if i := strings.Index(s, "."); i >= 0 {
		whole, frac = s[:i], s[i+1:]
	}
	// A bare "." carries no digits at all. Without this it would parse as
	// zero, and a zero from a garbage cell is indistinguishable from a zero
	// the bank meant.
	if whole == "" && frac == "" {
		return 0, errAmountUnparseable
	}
	if whole == "" {
		whole = "0"
	}
	if !allDigits(whole) || (frac != "" && !allDigits(frac)) {
		return 0, errAmountUnparseable
	}

	switch {
	case len(frac) == 0:
		frac = "00"
	case len(frac) == 1:
		frac += "0"
	case len(frac) > 2:
		if strings.Trim(frac[2:], "0") != "" {
			return 0, errAmountTooPrecise
		}
		frac = frac[:2]
	}

	rupees, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, errAmountUnparseable
	}
	// Well inside int64 at any school's scale, but a garbage column of
	// twenty digits must fail rather than wrap.
	if rupees > (1<<62)/100 {
		return 0, errAmountUnparseable
	}
	sub, err := strconv.ParseInt(frac, 10, 64)
	if err != nil {
		return 0, errAmountUnparseable
	}

	v := rupees*100 + sub
	if neg {
		v = -v
	}
	return v, nil
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// --- account numbers ---------------------------------------------------------

// ifscShape is the eleven-character IFSC: four letters of bank code, a
// reserved zero, six alphanumeric of branch. The same expression is a CHECK
// constraint in 00046 — validated here to give a sentence rather than a
// constraint violation, and there because the handler is not the only writer.
var ifscShape = regexp.MustCompile(`^[A-Z]{4}0[A-Z0-9]{6}$`)

var accountNumberShape = regexp.MustCompile(`^[A-Za-z0-9]{6,20}$`)

func validIFSC(s string) bool {
	return ifscShape.MatchString(strings.ToUpper(strings.TrimSpace(s)))
}

/*
maskAccountNumber is what a list response carries instead of the number.

	Last four digits only, which is the convention every Indian bank statement
	and passbook already uses, so it is recognisable to the person checking it
	against a cancelled cheque without being enough to pay into.

	Applied in the SQL projection, not in the client. A masking rule that lives
	in a React component is a masking rule that the next screen forgets.
*/
func maskAccountNumber(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if len(s) <= 4 {
		// Too short to mask meaningfully. Nothing usable is disclosed by four
		// digits with no bank behind them, and returning the raw value would
		// be worse than returning a row that says so.
		return strings.Repeat("•", len(s))
	}
	return strings.Repeat("•", len(s)-4) + s[len(s)-4:]
}

// --- the payout provider -----------------------------------------------------

// PayoutBatchHeader and PayoutLine are what a provider is handed: post-render,
// post-authorisation, and carrying no database handle. A provider knows about
// file formats and wires, never about tenancy or approval.
type PayoutBatchHeader struct {
	BatchNo       string
	Purpose       string
	ValueDate     string
	DebitAccount  string
	DebitIFSC     string
	DebitBankName string
}

type PayoutLine struct {
	BeneficiaryName string
	AccountNumber   string
	IFSC            string
	AmountPaise     int64
	Mode            string
	Narration       string
}

/*
PayoutProvider is one way money leaves the school.

	Two methods and they are not the same thing. Prepare renders a file the
	school uploads itself, which works today and needs no credentials. Transmit
	is the live path — a bank API that moves the money without a human at a
	net-banking portal — and there is no implementation of it, because this
	deployment holds no bank credentials and inventing one would mean a screen
	that reports a transfer that never happened.

	Kept as an interface rather than a function so that adding a real provider
	is a struct and a case in payoutProviderFor, and no caller changes.
*/
type PayoutProvider interface {
	// Name is the payout_batches.provider value this serves.
	Name() string
	// Label is what the screen calls it.
	Label() string
	// CanTransmit reports whether Transmit would attempt anything at all.
	CanTransmit() bool
	// Why explains a provider that cannot transmit, in a sentence an
	// administrator can act on.
	Why() string
	// Prepare renders the batch into a file for upload.
	Prepare(h PayoutBatchHeader, lines []PayoutLine) (filename, contentType string, body []byte, err error)
	// Transmit sends the batch to the bank and returns its reference.
	Transmit(ctx context.Context, h PayoutBatchHeader, lines []PayoutLine) (string, error)
}

/*
fileExportProvider writes the CSV an Indian bank's bulk-transfer upload wants.

	The column set and order are the ones payroll_statutory.go getBankFile
	already uses for the salary file, deliberately: a school that has taught
	its bank's portal to accept one of our files should not have to teach it a
	second shape for vendor payments.
*/
type fileExportProvider struct{}

func (fileExportProvider) Name() string      { return "file_export" }
func (fileExportProvider) Label() string     { return "Bank file (CSV upload)" }
func (fileExportProvider) CanTransmit() bool { return false }
func (fileExportProvider) Why() string {
	return "This provider prepares a file for you to upload to your bank's own portal. " +
		"Moving money directly from the ERP needs a corporate banking API agreement and " +
		"credentials from your bank, which this installation does not hold."
}

func (fileExportProvider) Prepare(h PayoutBatchHeader, lines []PayoutLine) (string, string, []byte, error) {
	var b strings.Builder
	b.WriteString("Beneficiary Name,Account Number,IFSC,Amount,Mode,Narration\n")
	for _, l := range lines {
		// Amount is written as rupees with two decimals, formed from the
		// integer paise by division and remainder rather than by float
		// division — the file the bank debits from must not carry a rounding
		// artefact.
		b.WriteString(fmt.Sprintf("%s,%s,%s,%s,%s,%s\n",
			csvSafe(l.BeneficiaryName),
			csvSafe(l.AccountNumber),
			csvSafe(strings.ToUpper(l.IFSC)),
			rupeeString(l.AmountPaise),
			csvSafe(strings.ToUpper(l.Mode)),
			csvSafe(l.Narration)))
	}
	name := fmt.Sprintf("payout-%s.csv", strings.NewReplacer("/", "-", " ", "-").Replace(h.BatchNo))
	return name, "text/csv; charset=utf-8", []byte(b.String()), nil
}

func (p fileExportProvider) Transmit(context.Context, PayoutBatchHeader, []PayoutLine) (string, error) {
	return "", ErrPayoutTransmissionUnavailable
}

// rupeeString renders integer paise as a plain decimal, without grouping,
// because a bank upload parser is famously literal about its amount column.
func rupeeString(paise int64) string {
	neg := paise < 0
	if neg {
		paise = -paise
	}
	s := fmt.Sprintf("%d.%02d", paise/100, paise%100)
	if neg {
		return "-" + s
	}
	return s
}

func payoutProviderFor(name string) (PayoutProvider, bool) {
	if name == "" || name == "file_export" {
		return fileExportProvider{}, true
	}
	return nil, false
}

// --- routes ------------------------------------------------------------------

/*
mountBanking registers the banking subtree.

	Mounted by the integrator inside the /finance route group in api.go, giving
	/api/v1/finance/banking/... — the same shape mountLedgers uses. That group
	already requires finance.invoices.read, so every route here sits behind it
	and then narrows further.

	The four permissions are the four rungs the RBAC grid already publishes for
	the "Fees & payments" group, reused rather than invented:

	  PaymentsRead   view — the statement, the batch list, the masked register
	  PaymentsWrite  manage — import, match, assemble a batch, edit an account
	  RefundsWrite   approve — the CHECKER. Releases a payout, finalises and
	                 reopens a reconciled period.
	  FinanceExport  export — produces the bank file, and reveals a full
	                 account number.

	Splitting approve from manage is the whole maker/checker control: a role
	with Manage can assemble a payout and cannot release it.
*/
func (s *Server) mountBanking(r chi.Router) {
	read := httpx.RequirePermission(rbac.PaymentsRead)
	write := httpx.RequirePermission(rbac.PaymentsWrite)
	// The checker. Deliberately a different rung from write.
	approve := httpx.RequirePermission(rbac.RefundsWrite)
	// Producing a file that moves money, and unmasking a account number.
	export := httpx.RequirePermission(rbac.FinanceExport)

	// --- the school's own bank accounts ------------------------------------
	r.With(read).Get("/banking/accounts", s.listBankAccounts)
	r.With(write).Post("/banking/accounts", s.saveBankAccount)

	// --- bank reconciliation statement -------------------------------------
	r.With(read).Get("/banking/reconciliations", s.listBankReconciliations)
	r.With(write).Post("/banking/reconciliations", s.saveBankReconciliation)
	r.With(read).Get("/banking/reconciliations/{id}", s.getBankReconciliation)
	r.With(write).Post("/banking/reconciliations/{id}/import", s.importBankStatement)
	r.With(write).Post("/banking/reconciliations/{id}/auto-match", s.autoMatchStatement)
	r.With(read).Get("/banking/reconciliations/{id}/candidates/{lineID}", s.getMatchCandidates)
	r.With(write).Post("/banking/lines/{id}/match", s.matchStatementLine)
	r.With(write).Post("/banking/lines/{id}/unmatch", s.unmatchStatementLine)
	// Finalising and reopening are the checker's, not the clerk's: they are
	// what makes a period evidence.
	r.With(approve).Post("/banking/reconciliations/{id}/finalise", s.finaliseBankReconciliation)
	r.With(approve).Post("/banking/reconciliations/{id}/reopen", s.reopenBankReconciliation)

	// --- connected banking payouts -----------------------------------------
	r.With(read).Get("/banking/payouts", s.listPayoutBatches)
	r.With(read).Get("/banking/payouts/providers", s.listPayoutProviders)
	r.With(read).Get("/banking/payouts/candidates", s.listPayoutCandidates)
	r.With(read).Get("/banking/payouts/{id}", s.getPayoutBatch)
	r.With(write).Post("/banking/payouts", s.createPayoutBatch)
	r.With(write).Post("/banking/payouts/{id}/items", s.addPayoutItems)
	r.With(write).Delete("/banking/payouts/{id}/items/{itemID}", s.removePayoutItem)
	r.With(write).Post("/banking/payouts/{id}/submit", s.submitPayoutBatch)
	// The checker's verb. The handler re-tests maker != checker regardless of
	// the permission, because holding the approve rung does not make you a
	// different person from the one who assembled it.
	r.With(approve).Post("/banking/payouts/{id}/decide", s.decidePayoutBatch)
	r.With(export).Get("/banking/payouts/{id}/file", s.exportPayoutFile)

	// --- student bank account register --------------------------------------
	r.With(read).Get("/banking/student-accounts", s.listStudentBankAccounts)
	r.With(write).Post("/banking/student-accounts", s.saveStudentBankAccount)
	r.With(write).Post("/banking/student-accounts/{id}/primary", s.makeStudentAccountPrimary)
	r.With(write).Post("/banking/student-accounts/{id}/verify", s.verifyStudentBankAccount)
	// A reveal is a GET on purpose. AuditMiddleware records the request and
	// response body of every mutation, so a POST here would write the full
	// account number into audit_log — turning the control into a second copy
	// of the thing it protects. This writes its own audit row instead, with
	// the last four digits only.
	r.With(export).Get("/banking/student-accounts/{id}/reveal", s.revealStudentBankAccount)
}

// --- the school's bank accounts ----------------------------------------------

type bankAccountView struct {
	ID            string  `json:"id"`
	Label         string  `json:"label"`
	BankName      string  `json:"bank_name"`
	Branch        *string `json:"branch,omitempty"`
	AccountMasked string  `json:"account_masked"`
	IFSC          string  `json:"ifsc"`
	AccountType   string  `json:"account_type"`
	AllowsPayouts bool    `json:"allows_payouts"`
	IsActive      bool    `json:"is_active"`
	LedgerAccount *string `json:"ledger_account,omitempty"`
	LastImportAt  *string `json:"last_import_at,omitempty"`
	OpenPeriods   int     `json:"open_periods"`
}

// listBankAccounts is the picker every other screen here depends on. The
// school's own account number is masked too: it is not a child's, but it is
// still an account number on a screen a clerk leaves open.
func (s *Server) listBankAccounts(w http.ResponseWriter, r *http.Request) {
	type row struct {
		bankAccountView
		account string
	}
	items, err := collect(s, r, `
		SELECT b.id::text, b.label, b.bank_name, b.branch, b.account_number, b.ifsc,
		       b.account_type, b.allows_payouts, b.is_active,
		       CASE WHEN la.id IS NULL THEN NULL ELSE la.code || ' ' || la.name END,
		       to_char(mx.last_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       COALESCE(op.n, 0)::int
		  FROM bank_accounts b
		  LEFT JOIN ledger_accounts la ON la.id = b.ledger_account_id
		  LEFT JOIN LATERAL (
		      SELECT max(i.imported_at) AS last_at FROM bank_statement_imports i
		       WHERE i.bank_account_id = b.id
		  ) mx ON true
		  LEFT JOIN LATERAL (
		      SELECT count(*) AS n FROM bank_reconciliations rc
		       WHERE rc.bank_account_id = b.id AND rc.status = 'open'
		  ) op ON true
		 ORDER BY b.is_active DESC, b.label`, nil,
		func(rows pgx.Rows) (bankAccountView, error) {
			var v row
			err := rows.Scan(&v.ID, &v.Label, &v.BankName, &v.Branch, &v.account, &v.IFSC,
				&v.AccountType, &v.AllowsPayouts, &v.IsActive, &v.LedgerAccount,
				&v.LastImportAt, &v.OpenPeriods)
			v.AccountMasked = maskAccountNumber(v.account)
			return v.bankAccountView, err
		})
	respond(w, r, items, err)
}

type bankAccountRequest struct {
	ID              string `json:"id"`
	Label           string `json:"label"`
	BankName        string `json:"bank_name"`
	Branch          string `json:"branch"`
	AccountNumber   string `json:"account_number"`
	IFSC            string `json:"ifsc"`
	AccountType     string `json:"account_type"`
	AllowsPayouts   bool   `json:"allows_payouts"`
	IsActive        *bool  `json:"is_active"`
	LedgerAccountID string `json:"ledger_account_id"`
}

func (s *Server) saveBankAccount(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req bankAccountRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Label = strings.TrimSpace(req.Label)
	req.BankName = strings.TrimSpace(req.BankName)
	req.AccountNumber = strings.TrimSpace(req.AccountNumber)
	req.IFSC = strings.ToUpper(strings.TrimSpace(req.IFSC))
	if req.AccountType == "" {
		req.AccountType = "current"
	}

	switch {
	case req.Label == "":
		httpx.BadRequest(w, r, "give the account a name the school will recognise, like \"SBI main collection\"")
		return
	case req.BankName == "":
		httpx.BadRequest(w, r, "which bank is this account with?")
		return
	case !accountNumberShape.MatchString(req.AccountNumber):
		httpx.BadRequest(w, r, "an account number is 6 to 20 letters or digits, with no spaces")
		return
	case !validIFSC(req.IFSC):
		httpx.BadRequest(w, r, "IFSC must be eleven characters: four letters, a zero, then six more — SBIN0001234")
		return
	}

	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	var ledger any
	if req.LedgerAccountID != "" {
		parsed, err := uuid.Parse(req.LedgerAccountID)
		if err != nil {
			httpx.BadRequest(w, r, "malformed ledger account id")
			return
		}
		ledger = parsed
	}

	var acctID uuid.UUID
	if req.ID != "" {
		parsed, err := uuid.Parse(req.ID)
		if err != nil {
			httpx.BadRequest(w, r, "malformed account id")
			return
		}
		acctID = parsed
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if acctID != uuid.Nil {
			tag, err := tx.Exec(r.Context(), `
				UPDATE bank_accounts
				   SET label = $3, bank_name = $4, branch = NULLIF($5,''),
				       account_number = $6, ifsc = $7, account_type = $8,
				       allows_payouts = $9, is_active = $10, ledger_account_id = $11,
				       updated_at = now()
				 WHERE id = $1 AND institution_id = $2`,
				acctID, id.InstitutionID, req.Label, req.BankName, req.Branch,
				req.AccountNumber, req.IFSC, req.AccountType, req.AllowsPayouts,
				active, ledger)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return pgx.ErrNoRows
			}
			return nil
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO bank_accounts (institution_id, label, bank_name, branch,
			                           account_number, ifsc, account_type,
			                           allows_payouts, is_active, ledger_account_id)
			VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10)
			RETURNING id`,
			id.InstitutionID, req.Label, req.BankName, req.Branch, req.AccountNumber,
			req.IFSC, req.AccountType, req.AllowsPayouts, active, ledger).Scan(&acctID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil && strings.Contains(err.Error(), "bank_accounts_number_once"):
		httpx.BadRequest(w, r, "that account number is already registered at that IFSC")
	case err != nil && strings.Contains(err.Error(), "bank_accounts_label_once"):
		httpx.BadRequest(w, r, "another account already uses that name")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": acctID.String()})
	}
}

// --- reconciliation: the period ----------------------------------------------

type reconciliationView struct {
	ID           string  `json:"id"`
	BankAccount  string  `json:"bank_account_id"`
	AccountLabel string  `json:"account_label"`
	PeriodStart  string  `json:"period_start"`
	PeriodEnd    string  `json:"period_end"`
	Opening      int64   `json:"opening_balance_paise"`
	Closing      int64   `json:"closing_balance_paise"`
	Status       string  `json:"status"`
	Lines        int     `json:"line_count"`
	Matched      int     `json:"matched_count"`
	Unmatched    int     `json:"unmatched_count"`
	FinalisedAt  *string `json:"finalised_at,omitempty"`
	FinalisedBy  *string `json:"finalised_by,omitempty"`
	Difference   *int64  `json:"difference_paise,omitempty"`
	Notes        *string `json:"notes,omitempty"`
}

func (s *Server) listBankReconciliations(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT rc.id::text, rc.bank_account_id::text, b.label,
		       to_char(rc.period_start,'YYYY-MM-DD'), to_char(rc.period_end,'YYYY-MM-DD'),
		       rc.opening_balance_paise, rc.closing_balance_paise, rc.status,
		       COALESCE(c.total,0)::int, COALESCE(c.matched,0)::int, COALESCE(c.unmatched,0)::int,
		       to_char(rc.finalised_at,'YYYY-MM-DD"T"HH24:MI:SSOF'), u.full_name,
		       rc.difference_paise, rc.notes
		  FROM bank_reconciliations rc
		  JOIN bank_accounts b ON b.id = rc.bank_account_id
		  LEFT JOIN users u ON u.id = rc.finalised_by
		  LEFT JOIN LATERAL (
		      SELECT count(*) AS total,
		             count(*) FILTER (WHERE l.match_kind IS NOT NULL) AS matched,
		             count(*) FILTER (WHERE l.match_kind IS NULL AND l.explained_as IS NULL) AS unmatched
		        FROM bank_statement_lines l WHERE l.reconciliation_id = rc.id
		  ) c ON true
		 WHERE ($1::uuid IS NULL OR rc.bank_account_id = $1)
		 ORDER BY rc.period_start DESC, b.label`,
		[]any{nullUUIDText(q.Get("bank_account_id"))},
		func(rows pgx.Rows) (reconciliationView, error) {
			var v reconciliationView
			return v, rows.Scan(&v.ID, &v.BankAccount, &v.AccountLabel, &v.PeriodStart,
				&v.PeriodEnd, &v.Opening, &v.Closing, &v.Status, &v.Lines, &v.Matched,
				&v.Unmatched, &v.FinalisedAt, &v.FinalisedBy, &v.Difference, &v.Notes)
		})
	respond(w, r, items, err)
}

type reconciliationRequest struct {
	ID            string `json:"id"`
	BankAccountID string `json:"bank_account_id"`
	PeriodStart   string `json:"period_start"`
	PeriodEnd     string `json:"period_end"`
	OpeningPaise  int64  `json:"opening_balance_paise"`
	ClosingPaise  int64  `json:"closing_balance_paise"`
	Notes         string `json:"notes"`
}

/*
saveBankReconciliation opens a period, or amends an open one.

	It will not amend a finalised one. That is checked here and, for the lines,
	by the trigger in 00046 — the handler gives the accountant a sentence, and
	the trigger is what stops anything else in the system.
*/
func (s *Server) saveBankReconciliation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req reconciliationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	acct, err := uuid.Parse(strings.TrimSpace(req.BankAccountID))
	if err != nil {
		httpx.BadRequest(w, r, "choose the bank account this statement belongs to")
		return
	}
	start, err := time.Parse("2006-01-02", strings.TrimSpace(req.PeriodStart))
	if err != nil {
		httpx.BadRequest(w, r, "period start must be a date, as YYYY-MM-DD")
		return
	}
	end, err := time.Parse("2006-01-02", strings.TrimSpace(req.PeriodEnd))
	if err != nil {
		httpx.BadRequest(w, r, "period end must be a date, as YYYY-MM-DD")
		return
	}
	if end.Before(start) {
		httpx.BadRequest(w, r, "the period ends before it starts")
		return
	}

	var recID uuid.UUID
	if req.ID != "" {
		parsed, perr := uuid.Parse(req.ID)
		if perr != nil {
			httpx.BadRequest(w, r, "malformed reconciliation id")
			return
		}
		recID = parsed
	}

	var locked bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if recID != uuid.Nil {
			var status string
			if err := tx.QueryRow(r.Context(),
				`SELECT status FROM bank_reconciliations WHERE id=$1 AND institution_id=$2`,
				recID, id.InstitutionID).Scan(&status); err != nil {
				return err
			}
			if status == "finalised" {
				locked = true
				return nil
			}
			_, err := tx.Exec(r.Context(), `
				UPDATE bank_reconciliations
				   SET period_start = $3, period_end = $4,
				       opening_balance_paise = $5, closing_balance_paise = $6,
				       notes = NULLIF($7,'')
				 WHERE id = $1 AND institution_id = $2`,
				recID, id.InstitutionID, start, end, req.OpeningPaise, req.ClosingPaise, req.Notes)
			return err
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO bank_reconciliations (institution_id, bank_account_id, period_start,
			                                  period_end, opening_balance_paise,
			                                  closing_balance_paise, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8)
			RETURNING id`,
			id.InstitutionID, acct, start, end, req.OpeningPaise, req.ClosingPaise,
			req.Notes, id.UserID).Scan(&recID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case locked:
		httpx.Error(w, r, http.StatusConflict, "finalised",
			"this period is finalised. Reopen it, with a reason, before changing it.")
	case err != nil && strings.Contains(err.Error(), "bank_reconciliations_one_per_period"):
		httpx.BadRequest(w, r, "that account already has a reconciliation for exactly this period")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": recID.String()})
	}
}

// --- reconciliation: the statement itself ------------------------------------

type statementLine struct {
	ID          string  `json:"id"`
	TxnDate     string  `json:"txn_date"`
	Narration   string  `json:"narration"`
	Reference   *string `json:"reference_no,omitempty"`
	AmountPaise int64   `json:"amount_paise"`
	Direction   string  `json:"direction"`
	Balance     *int64  `json:"balance_paise,omitempty"`
	Raw         string  `json:"raw_line"`
	MatchKind   *string `json:"match_kind,omitempty"`
	MatchID     *string `json:"match_id,omitempty"`
	Confidence  *string `json:"match_confidence,omitempty"`
	MatchedBy   *string `json:"matched_by,omitempty"`
	MatchLabel  *string `json:"match_label,omitempty"`
	Explained   *string `json:"explained_as,omitempty"`
}

type bookEntry struct {
	Kind        string  `json:"kind"`
	ID          string  `json:"id"`
	EntryDate   string  `json:"entry_date"`
	AmountPaise int64   `json:"amount_paise"`
	Reference   *string `json:"reference,omitempty"`
	Party       string  `json:"party"`
}

type reconciliationStatement struct {
	reconciliationView
	BankLines []statementLine `json:"bank_lines"`
	// The two halves of the residue. This is the reconciliation statement:
	// everything above exists to make these two lists short.
	UnmatchedBank []statementLine `json:"unmatched_bank"`
	UnmatchedBook []bookEntry     `json:"unmatched_book"`

	BankClosing        int64 `json:"bank_closing_paise"`
	BookClosing        int64 `json:"book_closing_paise"`
	UnmatchedBankPaise int64 `json:"unmatched_bank_paise"`
	UnmatchedBookPaise int64 `json:"unmatched_book_paise"`
	DifferencePaise    int64 `json:"difference_paise"`
	// True when the difference is entirely explained by the residue. False is
	// not an error — it is the number the accountant has to go and find.
	Explained bool `json:"difference_explained"`

	Imports []statementImport `json:"imports"`
}

type statementImport struct {
	ID        string  `json:"id"`
	Filename  string  `json:"filename"`
	At        string  `json:"imported_at"`
	By        *string `json:"imported_by,omitempty"`
	Read      int     `json:"rows_read"`
	Inserted  int     `json:"rows_inserted"`
	Duplicate int     `json:"rows_duplicate"`
	Rejected  int     `json:"rows_rejected"`
	Rejects   any     `json:"rejects,omitempty"`
}

/*
bookEntriesSQL is the book side of the reconciliation, as one relation.

	Four sources, one shape, because the residue has to be a single list an
	accountant reads top to bottom. Signed the same way the bank signs it:
	money in positive, money out negative.

	The mode filters matter. Cash never appears on a bank statement, so
	including cash receipts would put every counter collection into the
	unmatched-book list and make the residue useless on day one. Adjustments
	are book-only by definition.

	Note what is NOT filtered: payments carry no bank account, because the
	schema has never recorded which account a receipt was banked into. So the
	book side of a school with two accounts is over-inclusive, and the screen
	says so rather than the query pretending otherwise. vendor_payments and
	payout_items do know their account and are filtered properly.
*/
const bookEntriesSQL = `
	SELECT 'payment'::text, p.id::text, to_char(p.paid_on,'YYYY-MM-DD'),
	       p.amount_paise,
	       NULLIF(btrim(COALESCE(NULLIF(p.reference_no,''), NULLIF(p.gateway_txn_id,''),
	                             COALESCE(p.receipt_no,''))),''),
	       concat_ws(' ', st.first_name, st.last_name)
	  FROM payments p
	  JOIN students st ON st.id = p.student_id
	 WHERE p.institution_id = $1
	   AND p.status = 'success'
	   AND p.mode NOT IN ('cash','adjustment')
	   AND p.paid_on BETWEEN $2 AND $3
	UNION ALL
	SELECT 'vendor_payment', vp.id::text, to_char(vp.paid_on,'YYYY-MM-DD'),
	       -(vp.amount_paise - vp.tds_paise),
	       NULLIF(btrim(COALESCE(vp.reference_no,'')),''), v.name
	  FROM vendor_payments vp
	  JOIN vendor_bills vb ON vb.id = vp.bill_id
	  JOIN vendors v ON v.id = vb.vendor_id
	  JOIN bank_accounts ba ON ba.id = $4
	 WHERE vp.institution_id = $1
	   AND vp.mode NOT IN ('cash','adjustment')
	   AND vp.paid_on BETWEEN $2 AND $3
	   AND (ba.ledger_account_id IS NULL OR vp.paid_from_account_id = ba.ledger_account_id)
	UNION ALL
	SELECT 'payout_item', pi.id::text, to_char(pb.value_date,'YYYY-MM-DD'),
	       -pi.amount_paise, NULLIF(btrim(COALESCE(pi.utr,'')),''), pi.beneficiary_name
	  FROM payout_items pi
	  JOIN payout_batches pb ON pb.id = pi.batch_id
	 WHERE pi.institution_id = $1
	   AND pb.bank_account_id = $4
	   AND pb.status = 'exported'
	   AND pi.status IN ('exported','paid')
	   AND pb.value_date BETWEEN $2 AND $3
	UNION ALL
	SELECT 'refund', rf.id::text, to_char(rf.processed_on,'YYYY-MM-DD'),
	       -rf.amount_paise, NULL, concat_ws(' ', st2.first_name, st2.last_name)
	  FROM refunds rf
	  JOIN students st2 ON st2.id = rf.student_id
	 WHERE rf.institution_id = $1
	   AND rf.status = 'processed'
	   AND rf.processed_on BETWEEN $2 AND $3`

// loadBookEntries reads the book side for one account and period.
func (s *Server) loadBookEntries(ctx context.Context, tx pgx.Tx, inst, acct uuid.UUID,
	start, end string) ([]bookEntry, error) {
	rows, err := tx.Query(ctx, bookEntriesSQL, inst, start, end, acct)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []bookEntry{}
	for rows.Next() {
		var v bookEntry
		if err := rows.Scan(&v.Kind, &v.ID, &v.EntryDate, &v.AmountPaise, &v.Reference, &v.Party); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

/*
getBankReconciliation is the BRS screen in one response.

	Deliberately one call rather than four. The statement is a comparison, and
	a client that fetched the bank side and the book side separately would
	render them a few hundred milliseconds apart and, on a slow link, briefly
	show a residue that does not exist.
*/
func (s *Server) getBankReconciliation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	recID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed reconciliation id")
		return
	}

	out := reconciliationStatement{
		BankLines:     []statementLine{},
		UnmatchedBank: []statementLine{},
		UnmatchedBook: []bookEntry{},
		Imports:       []statementImport{},
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var acct uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT rc.id::text, rc.bank_account_id, b.label,
			       to_char(rc.period_start,'YYYY-MM-DD'), to_char(rc.period_end,'YYYY-MM-DD'),
			       rc.opening_balance_paise, rc.closing_balance_paise, rc.status,
			       to_char(rc.finalised_at,'YYYY-MM-DD"T"HH24:MI:SSOF'), u.full_name, rc.notes
			  FROM bank_reconciliations rc
			  JOIN bank_accounts b ON b.id = rc.bank_account_id
			  LEFT JOIN users u ON u.id = rc.finalised_by
			 WHERE rc.id = $1 AND rc.institution_id = $2`,
			recID, id.InstitutionID).Scan(&out.ID, &acct, &out.AccountLabel,
			&out.PeriodStart, &out.PeriodEnd, &out.Opening, &out.Closing, &out.Status,
			&out.FinalisedAt, &out.FinalisedBy, &out.Notes); err != nil {
			return err
		}
		out.BankAccount = acct.String()

		lines, err := s.loadStatementLines(r.Context(), tx, recID)
		if err != nil {
			return err
		}
		out.BankLines = lines

		book, err := s.loadBookEntries(r.Context(), tx, id.InstitutionID, acct,
			out.PeriodStart, out.PeriodEnd)
		if err != nil {
			return err
		}

		// Which book entries a line already claims. Read from the lines rather
		// than re-queried, so the two halves of the screen cannot disagree.
		claimed := map[string]bool{}
		for _, l := range lines {
			if l.MatchKind != nil && l.MatchID != nil {
				claimed[*l.MatchKind+":"+*l.MatchID] = true
			}
			if l.MatchKind == nil && l.Explained == nil {
				out.UnmatchedBank = append(out.UnmatchedBank, l)
				out.UnmatchedBankPaise += l.AmountPaise
			}
		}
		var bookTotal int64
		for _, e := range book {
			bookTotal += e.AmountPaise
			if !claimed[e.Kind+":"+e.ID] {
				out.UnmatchedBook = append(out.UnmatchedBook, e)
				out.UnmatchedBookPaise += e.AmountPaise
			}
		}

		out.Lines = len(lines)
		out.Unmatched = len(out.UnmatchedBank)
		out.Matched = out.Lines - out.Unmatched
		out.BankClosing = out.Closing
		out.BookClosing = out.Opening + bookTotal
		out.DifferencePaise = out.BankClosing - out.BookClosing
		// The residue explains the difference when the items on each side
		// account for it exactly. Anything else is a real gap.
		out.Explained = out.DifferencePaise == out.UnmatchedBankPaise-out.UnmatchedBookPaise

		imps, err := tx.Query(r.Context(), `
			SELECT i.id::text, i.filename,
			       to_char(i.imported_at,'YYYY-MM-DD"T"HH24:MI:SSOF'), u.full_name,
			       i.rows_read, i.rows_inserted, i.rows_duplicate, i.rows_rejected, i.rejects
			  FROM bank_statement_imports i
			  LEFT JOIN users u ON u.id = i.imported_by
			 WHERE i.bank_account_id = $1 AND i.institution_id = $2
			 ORDER BY i.imported_at DESC LIMIT 20`, acct, id.InstitutionID)
		if err != nil {
			return err
		}
		defer imps.Close()
		for imps.Next() {
			var v statementImport
			if err := imps.Scan(&v.ID, &v.Filename, &v.At, &v.By, &v.Read, &v.Inserted,
				&v.Duplicate, &v.Rejected, &v.Rejects); err != nil {
				return err
			}
			out.Imports = append(out.Imports, v)
		}
		return imps.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

func (s *Server) loadStatementLines(ctx context.Context, tx pgx.Tx, recID uuid.UUID) ([]statementLine, error) {
	rows, err := tx.Query(ctx, `
		SELECT l.id::text, to_char(l.txn_date,'YYYY-MM-DD'), l.narration, l.reference_no,
		       l.amount_paise, l.direction, l.balance_paise, l.raw_line,
		       l.match_kind, l.match_id::text, l.match_confidence, u.full_name, l.explained_as
		  FROM bank_statement_lines l
		  LEFT JOIN users u ON u.id = l.matched_by
		 WHERE l.reconciliation_id = $1
		 ORDER BY l.txn_date, l.line_no`, recID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []statementLine{}
	for rows.Next() {
		var v statementLine
		if err := rows.Scan(&v.ID, &v.TxnDate, &v.Narration, &v.Reference, &v.AmountPaise,
			&v.Direction, &v.Balance, &v.Raw, &v.MatchKind, &v.MatchID, &v.Confidence,
			&v.MatchedBy, &v.Explained); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// --- reconciliation: the import ----------------------------------------------

// statementDateLayouts are what actually turns up. Ordered most specific
// first: "02/01/2006" must be tried before "2/1/2006" or a zero-padded date
// would parse under the loose layout and silently transpose day and month.
var statementDateLayouts = []string{
	"2006-01-02", "02/01/2006", "02-01-2006", "02.01.2006",
	"02/01/06", "02-01-06", "02-Jan-2006", "02 Jan 2006", "02-Jan-06",
	"2006/01/02", "20060102",
}

func parseStatementDate(raw string) (time.Time, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return time.Time{}, false
	}
	// Some exports carry a time component; the date is all a statement needs.
	if i := strings.IndexAny(s, " T"); i > 0 && len(s) > 10 {
		if t, ok := parseStatementDate(s[:i]); ok {
			return t, true
		}
	}
	for _, layout := range statementDateLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// headerAliases maps the columns a bank might use onto the fields this needs.
// An allowlist rather than positional parsing: every bank orders its columns
// differently, and a positional reader silently reads the balance as the
// amount the first time a school changes bank.
var headerAliases = map[string][]string{
	"date":      {"date", "txn date", "transaction date", "tran date", "txndate", "posting date", "date of transaction"},
	"valuedate": {"value date", "value dt", "valuedate"},
	"narration": {"narration", "description", "particulars", "details", "remarks", "transaction remarks"},
	"reference": {"ref", "reference", "reference no", "ref no", "chq no", "cheque no", "chq/ref no", "cheque/reference no", "utr", "transaction id", "txn id"},
	"debit":     {"debit", "withdrawal", "withdrawal amt", "withdrawal amount", "withdrawal amt.", "dr", "debit amount", "paid out"},
	"credit":    {"credit", "deposit", "deposit amt", "deposit amount", "deposit amt.", "cr", "credit amount", "paid in"},
	"amount":    {"amount", "txn amount", "transaction amount"},
	"balance":   {"balance", "closing balance", "running balance", "balance amt"},
}

type importedLine struct {
	txnDate   time.Time
	valueDate *time.Time
	narration string
	reference string
	amount    int64
	balance   *int64
	raw       string
	lineNo    int
	hash      string
}

type importReject struct {
	Line   int    `json:"line"`
	Reason string `json:"reason"`
	Raw    string `json:"raw"`
}

/*
statementLineHash is the idempotency key.

	sha256 over the line's normalised business content plus an occurrence
	ordinal. The ordinal is what makes this correct rather than merely
	plausible:

	  Hash the content alone, and two genuinely distinct transactions on the
	  same day for the same amount with the same narration — which happens on
	  every fee-collection day of the year — collapse into one row, and the
	  school is silently short a receipt.

	  Include the file's line number instead, and re-importing a statement that
	  gained or lost a header row shifts every hash, so the entire statement
	  imports a second time.

	Counting identical *preceding* lines within the same file is stable under
	re-import and still separates true duplicates.
*/
func statementLineHash(txnDate time.Time, amount int64, narration, reference string, ordinal int) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s|%d|%s|%s|%d",
		txnDate.Format("2006-01-02"), amount,
		strings.ToLower(strings.Join(strings.Fields(narration), " ")),
		strings.ToUpper(strings.TrimSpace(reference)), ordinal)
	return hex.EncodeToString(h.Sum(nil))
}

/*
importBankStatement reads a bank's CSV into statement lines, idempotently.

	The body is the raw CSV, matching importStudents. Each line is kept
	verbatim as well as parsed, because the first import from any new bank
	parses something wrong and the original text is the difference between a
	diagnosis and an argument.

	Re-importing the same file inserts nothing and says so. That is enforced by
	a unique index on the line hash, not by this handler checking first — a
	handler that checks first still double-inserts when two accountants upload
	the same file at the same moment.
*/
func (s *Server) importBankStatement(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	recID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed reconciliation id")
		return
	}
	filename := strings.TrimSpace(r.URL.Query().Get("filename"))
	if filename == "" {
		filename = "statement.csv"
	}

	// 8 MB is a few tens of thousands of statement lines. Beyond that it is a
	// data migration, not a month's statement.
	body := http.MaxBytesReader(w, r.Body, 8<<20)
	defer body.Close()
	raw, err := io.ReadAll(body)
	if err != nil {
		httpx.BadRequest(w, r, "could not read the uploaded file")
		return
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		httpx.BadRequest(w, r, "the uploaded file is empty")
		return
	}
	sum := sha256.Sum256(raw)
	fileHash := hex.EncodeToString(sum[:])

	// Split into physical lines first so raw_line can be kept verbatim; each
	// line is then parsed on its own. csv.Reader over the whole file would
	// give records with the original text already discarded.
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	physical := strings.Split(text, "\n")

	var headerCols map[string]int
	var rejects []importReject
	parsed := []importedLine{}
	seen := map[string]int{}
	rowsRead := 0

	for i, line := range physical {
		if strings.TrimSpace(line) == "" {
			continue
		}
		rec, rerr := csv.NewReader(strings.NewReader(line)).Read()
		if rerr != nil {
			rejects = append(rejects, importReject{Line: i + 1,
				Reason: "could not be read as a CSV row", Raw: clipRaw(line, 500)})
			continue
		}
		if headerCols == nil {
			if cols, ok := mapStatementHeader(rec); ok {
				headerCols = cols
				continue
			}
			// Preamble is normal — banks put the account holder's name and
			// address above the table. Skipped silently until the header is
			// found; only then does a bad row count as a reject.
			continue
		}
		rowsRead++

		pl, perr := parseStatementRow(rec, headerCols, i+1, line)
		if perr != nil {
			rejects = append(rejects, importReject{Line: i + 1,
				Reason: perr.Error(), Raw: clipRaw(line, 500)})
			continue
		}
		key := statementLineHash(pl.txnDate, pl.amount, pl.narration, pl.reference, 0)
		ordinal := seen[key]
		seen[key] = ordinal + 1
		pl.hash = statementLineHash(pl.txnDate, pl.amount, pl.narration, pl.reference, ordinal)
		parsed = append(parsed, pl)
	}

	if headerCols == nil {
		httpx.BadRequest(w, r,
			"no recognisable header row: the file needs a date column, a narration column, "+
				"and either an amount column or separate debit and credit columns")
		return
	}

	type result struct {
		ImportID  string         `json:"import_id"`
		Read      int            `json:"rows_read"`
		Inserted  int            `json:"rows_inserted"`
		Duplicate int            `json:"rows_duplicate"`
		Rejected  int            `json:"rows_rejected"`
		Outside   int            `json:"rows_outside_period"`
		Rejects   []importReject `json:"rejects"`
	}
	out := result{Read: rowsRead, Rejected: len(rejects), Rejects: rejects}
	if out.Rejects == nil {
		out.Rejects = []importReject{}
	}

	var locked bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var acct uuid.UUID
		var start, end time.Time
		var status string
		if err := tx.QueryRow(r.Context(), `
			SELECT bank_account_id, period_start, period_end, status
			  FROM bank_reconciliations WHERE id=$1 AND institution_id=$2`,
			recID, id.InstitutionID).Scan(&acct, &start, &end, &status); err != nil {
			return err
		}
		if status == "finalised" {
			locked = true
			return nil
		}

		rejectJSON, _ := json.Marshal(out.Rejects)
		var importID uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO bank_statement_imports (institution_id, bank_account_id, filename,
			                                    file_hash, rows_read, rows_rejected,
			                                    rejects, imported_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
			id.InstitutionID, acct, filename, fileHash, rowsRead, len(rejects),
			rejectJSON, id.UserID).Scan(&importID); err != nil {
			return err
		}
		out.ImportID = importID.String()

		for _, pl := range parsed {
			// A line whose date falls outside the period is imported anyway —
			// banks routinely include a carried-forward row — but it belongs
			// to no reconciliation until one covers it.
			var recRef any
			if !pl.txnDate.Before(start) && !pl.txnDate.After(end) {
				recRef = recID
			} else {
				out.Outside++
			}

			var valueDate any
			if pl.valueDate != nil {
				valueDate = *pl.valueDate
			}
			var balance any
			if pl.balance != nil {
				balance = *pl.balance
			}

			tag, err := tx.Exec(r.Context(), `
				INSERT INTO bank_statement_lines
				    (institution_id, bank_account_id, import_id, reconciliation_id,
				     txn_date, value_date, narration, reference_no, amount_paise,
				     balance_paise, raw_line, line_no, line_hash)
				VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9,$10,$11,$12,$13)
				ON CONFLICT (institution_id, bank_account_id, line_hash) DO NOTHING`,
				id.InstitutionID, acct, importID, recRef, pl.txnDate, valueDate,
				pl.narration, pl.reference, pl.amount, balance, pl.raw, pl.lineNo, pl.hash)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 1 {
				out.Inserted++
			} else {
				out.Duplicate++
			}
		}

		_, err := tx.Exec(r.Context(), `
			UPDATE bank_statement_imports
			   SET rows_inserted = $2, rows_duplicate = $3 WHERE id = $1`,
			importID, out.Inserted, out.Duplicate)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case locked:
		httpx.Error(w, r, http.StatusConflict, "finalised",
			"this period is finalised. Reopen it, with a reason, before importing into it.")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

// mapStatementHeader recognises a header row, or reports that this is not one.
func mapStatementHeader(rec []string) (map[string]int, bool) {
	cols := map[string]int{}
	for i, cell := range rec {
		norm := strings.ToLower(strings.TrimSpace(cell))
		norm = strings.Trim(norm, ".:")
		norm = strings.Join(strings.Fields(norm), " ")
		if norm == "" {
			continue
		}
		for field, aliases := range headerAliases {
			for _, a := range aliases {
				if norm == a {
					if _, taken := cols[field]; !taken {
						cols[field] = i
					}
				}
			}
		}
	}
	// A header needs a date and some way of expressing an amount. Narration is
	// wanted but not required: a few banks label it in a way nothing predicts,
	// and refusing the whole file over a column that is only used for matching
	// hints would be worse than importing with an empty narration.
	_, hasDate := cols["date"]
	_, hasAmount := cols["amount"]
	_, hasDebit := cols["debit"]
	_, hasCredit := cols["credit"]
	return cols, hasDate && (hasAmount || hasDebit || hasCredit)
}

func parseStatementRow(rec []string, cols map[string]int, lineNo int, raw string) (importedLine, error) {
	at := func(field string) string {
		i, ok := cols[field]
		if !ok || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}

	txn, ok := parseStatementDate(at("date"))
	if !ok {
		return importedLine{}, fmt.Errorf("date %q is not a date this reader recognises", at("date"))
	}

	pl := importedLine{
		txnDate:   txn,
		narration: at("narration"),
		reference: at("reference"),
		raw:       clipRaw(raw, 4000),
		lineNo:    lineNo,
	}
	if v, ok := parseStatementDate(at("valuedate")); ok {
		pl.valueDate = &v
	}

	/* The amount, from whichever shape the bank used.

	   Debit and credit as separate columns is the commonest Indian layout and
	   is handled first. A row with both filled is not a transaction this
	   reader understands — it is a total line or a mis-aligned column — and is
	   rejected rather than guessed at. */
	debitRaw, creditRaw := at("debit"), at("credit")
	switch {
	case debitRaw != "" && creditRaw != "":
		return importedLine{}, errors.New("row has both a debit and a credit amount")
	case debitRaw != "":
		v, err := paiseFromDecimal(debitRaw)
		if err != nil {
			return importedLine{}, fmt.Errorf("debit %q: %w", debitRaw, err)
		}
		if v < 0 {
			v = -v
		}
		pl.amount = -v
	case creditRaw != "":
		v, err := paiseFromDecimal(creditRaw)
		if err != nil {
			return importedLine{}, fmt.Errorf("credit %q: %w", creditRaw, err)
		}
		if v < 0 {
			v = -v
		}
		pl.amount = v
	default:
		amountRaw := at("amount")
		if amountRaw == "" {
			return importedLine{}, errors.New("row has no amount")
		}
		v, err := paiseFromDecimal(amountRaw)
		if err != nil {
			return importedLine{}, fmt.Errorf("amount %q: %w", amountRaw, err)
		}
		pl.amount = v
	}
	if pl.amount == 0 {
		// Refused rather than stored. A zero-value statement line is a parse
		// failure wearing a transaction's clothes, and the CHECK constraint
		// would reject it anyway — this gives the operator the row number.
		return importedLine{}, errors.New("amount parsed as zero")
	}

	if b := at("balance"); b != "" {
		if v, err := paiseFromDecimal(b); err == nil {
			pl.balance = &v
		}
	}
	return pl, nil
}

// clipRaw bounds a stored raw line without trimming it. Distinct from the
// package's truncate, which trims whitespace first — raw_line exists to be
// verbatim, and leading whitespace is sometimes the very thing that broke a
// column alignment.
func clipRaw(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// --- reconciliation: matching ------------------------------------------------

type matchCandidate struct {
	bookEntry
	// Why this is a candidate, in the words the screen shows next to it.
	Reason string `json:"reason"`
	// exact when amount, date and reference all agree.
	Exact bool `json:"exact"`
	// Whole days between the bank line and the book entry.
	DayGap int `json:"day_gap"`
}

// fuzzyWindowDays is how far apart a bank line and a book entry may sit and
// still be offered as the same transaction. Three days covers a Friday cheque
// clearing on Monday, which is the case this exists for; a wider window offers
// the previous week's identical fee instalment and makes the list useless.
const fuzzyWindowDays = 3

/*
candidatesFor ranks book entries against one bank line.

	Exact means the amount matches to the paise, the dates agree, and the
	references agree — at which point there is nothing to ask a human.
	Everything else is offered, never applied.

	Amount equality is required in all cases. A "candidate" that differs in
	amount is not a candidate, it is a different transaction, and offering it
	is how a clerk clicking through a hundred lines confirms one.
*/
func candidatesFor(line statementLine, book []bookEntry, claimed map[string]bool) []matchCandidate {
	lineDate, _ := time.Parse("2006-01-02", line.TxnDate)
	lineRef := normaliseReference(deref(line.Reference))

	out := []matchCandidate{}
	for _, e := range book {
		if claimed[e.Kind+":"+e.ID] {
			continue
		}
		if e.AmountPaise != line.AmountPaise {
			continue
		}
		entryDate, err := time.Parse("2006-01-02", e.EntryDate)
		if err != nil {
			continue
		}
		gap := int(lineDate.Sub(entryDate).Hours() / 24)
		if gap < 0 {
			gap = -gap
		}
		if gap > fuzzyWindowDays {
			continue
		}

		entryRef := normaliseReference(deref(e.Reference))
		exact := gap == 0 && lineRef != "" && entryRef != "" && lineRef == entryRef

		c := matchCandidate{bookEntry: e, Exact: exact, DayGap: gap}
		switch {
		case exact:
			c.Reason = "amount, date and reference all agree"
		case gap == 0 && lineRef != "" && entryRef != "":
			c.Reason = "amount and date agree, but the references differ"
		case gap == 0:
			c.Reason = "amount and date agree; no reference to compare"
		default:
			c.Reason = fmt.Sprintf("amount agrees, %d day(s) apart", gap)
		}
		out = append(out, c)
	}
	return out
}

// normaliseReference strips what banks add and schools do not: spaces, dashes,
// slashes, and a leading UTR/NEFT/IMPS marker. Two references that differ only
// in punctuation are the same reference, and treating them as different is
// what leaves an exact match sitting in the fuzzy list.
func normaliseReference(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	s = strings.NewReplacer(" ", "", "-", "", "/", "", "_", "", "#", "").Replace(s)
	for _, prefix := range []string{"UTR", "NEFT", "RTGS", "IMPS", "UPI", "REF", "CHQ", "TXN"} {
		s = strings.TrimPrefix(s, prefix)
	}
	return s
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// getMatchCandidates answers "what could this line be?" for one line.
func (s *Server) getMatchCandidates(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	recID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed reconciliation id")
		return
	}
	lineID, err := uuid.Parse(chi.URLParam(r, "lineID"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed line id")
		return
	}

	out := []matchCandidate{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var acct uuid.UUID
		var start, end string
		if err := tx.QueryRow(r.Context(), `
			SELECT bank_account_id, to_char(period_start,'YYYY-MM-DD'),
			       to_char(period_end,'YYYY-MM-DD')
			  FROM bank_reconciliations WHERE id=$1 AND institution_id=$2`,
			recID, id.InstitutionID).Scan(&acct, &start, &end); err != nil {
			return err
		}
		lines, err := s.loadStatementLines(r.Context(), tx, recID)
		if err != nil {
			return err
		}
		var target *statementLine
		claimed := map[string]bool{}
		for i := range lines {
			if lines[i].ID == lineID.String() {
				target = &lines[i]
			}
			if lines[i].MatchKind != nil && lines[i].MatchID != nil {
				claimed[*lines[i].MatchKind+":"+*lines[i].MatchID] = true
			}
		}
		if target == nil {
			return pgx.ErrNoRows
		}
		// Widen the book window by the fuzzy tolerance, or a cheque banked on
		// the first of the month can never match the payment recorded on the
		// last of the previous one.
		wideStart, wideEnd := widen(start, end, fuzzyWindowDays)
		book, err := s.loadBookEntries(r.Context(), tx, id.InstitutionID, acct, wideStart, wideEnd)
		if err != nil {
			return err
		}
		out = candidatesFor(*target, book, claimed)
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
	}
}

func widen(start, end string, days int) (string, string) {
	s, err1 := time.Parse("2006-01-02", start)
	e, err2 := time.Parse("2006-01-02", end)
	if err1 != nil || err2 != nil {
		return start, end
	}
	return s.AddDate(0, 0, -days).Format("2006-01-02"), e.AddDate(0, 0, days).Format("2006-01-02")
}

/*
autoMatchStatement applies every unambiguous match and stops.

	"Unambiguous" is doing real work: an exact candidate is only applied when it
	is the ONLY exact candidate for that line and that line is the only one
	claiming it. Two identical NEFT credits on the same day with the same UTR
	prefix would otherwise be assigned arbitrarily, and an arbitrary match in a
	reconciliation is worse than no match — it is wrong and it looks finished.
*/
func (s *Server) autoMatchStatement(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	recID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed reconciliation id")
		return
	}

	type result struct {
		Matched   int `json:"matched"`
		Ambiguous int `json:"ambiguous"`
		Remaining int `json:"remaining"`
	}
	var out result
	var locked bool

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var acct uuid.UUID
		var start, end, status string
		if err := tx.QueryRow(r.Context(), `
			SELECT bank_account_id, to_char(period_start,'YYYY-MM-DD'),
			       to_char(period_end,'YYYY-MM-DD'), status
			  FROM bank_reconciliations WHERE id=$1 AND institution_id=$2`,
			recID, id.InstitutionID).Scan(&acct, &start, &end, &status); err != nil {
			return err
		}
		if status == "finalised" {
			locked = true
			return nil
		}

		lines, err := s.loadStatementLines(r.Context(), tx, recID)
		if err != nil {
			return err
		}
		wideStart, wideEnd := widen(start, end, fuzzyWindowDays)
		book, err := s.loadBookEntries(r.Context(), tx, id.InstitutionID, acct, wideStart, wideEnd)
		if err != nil {
			return err
		}

		claimed := map[string]bool{}
		for _, l := range lines {
			if l.MatchKind != nil && l.MatchID != nil {
				claimed[*l.MatchKind+":"+*l.MatchID] = true
			}
		}

		// First pass: collect the exact candidates for every open line, so
		// that a book entry wanted by two lines can be spotted and left alone.
		type proposal struct {
			line  statementLine
			entry bookEntry
		}
		var proposals []proposal
		wanted := map[string]int{}
		for _, l := range lines {
			if l.MatchKind != nil || l.Explained != nil {
				continue
			}
			var exacts []bookEntry
			for _, c := range candidatesFor(l, book, claimed) {
				if c.Exact {
					exacts = append(exacts, c.bookEntry)
				}
			}
			if len(exacts) != 1 {
				if len(exacts) > 1 {
					out.Ambiguous++
				}
				continue
			}
			proposals = append(proposals, proposal{line: l, entry: exacts[0]})
			wanted[exacts[0].Kind+":"+exacts[0].ID]++
		}

		for _, p := range proposals {
			if wanted[p.entry.Kind+":"+p.entry.ID] > 1 {
				out.Ambiguous++
				continue
			}
			entryID, err := uuid.Parse(p.entry.ID)
			if err != nil {
				continue
			}
			tag, err := tx.Exec(r.Context(), `
				UPDATE bank_statement_lines
				   SET match_kind = $3, match_id = $4, match_confidence = 'exact',
				       matched_by = $5, matched_at = now()
				 WHERE id = $1 AND institution_id = $2
				   AND match_kind IS NULL AND explained_as IS NULL`,
				uuid.MustParse(p.line.ID), id.InstitutionID, p.entry.Kind, entryID, id.UserID)
			if err != nil {
				// A unique-violation here means another session claimed the
				// same book entry between the read and the write. That is the
				// index doing its job; skip and carry on rather than failing
				// the whole sweep.
				if strings.Contains(err.Error(), "bank_statement_lines_one_claim_per_entry") {
					out.Ambiguous++
					continue
				}
				return err
			}
			if tag.RowsAffected() == 1 {
				out.Matched++
			}
		}

		return tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM bank_statement_lines
			 WHERE reconciliation_id = $1 AND match_kind IS NULL AND explained_as IS NULL`,
			recID).Scan(&out.Remaining)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case locked:
		httpx.Error(w, r, http.StatusConflict, "finalised",
			"this period is finalised. Reopen it, with a reason, before matching.")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

type bankMatchRequest struct {
	Kind string `json:"match_kind"`
	ID   string `json:"match_id"`
	// Set instead of kind/id to record that the line is not a book entry at
	// all — bank charges, interest credited.
	ExplainedAs string `json:"explained_as"`
}

// matchStatementLine records a human's decision about one line.
func (s *Server) matchStatementLine(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	lineID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed line id")
		return
	}
	var req bankMatchRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Kind = strings.TrimSpace(req.Kind)
	req.ExplainedAs = strings.TrimSpace(req.ExplainedAs)

	if req.ExplainedAs == "" {
		switch req.Kind {
		case "payment", "vendor_payment", "payout_item", "refund":
		default:
			httpx.BadRequest(w, r,
				"say what this line is: a payment, vendor_payment, payout_item or refund — or explain it instead")
			return
		}
	}

	var entryID any
	if req.ExplainedAs == "" {
		parsed, perr := uuid.Parse(strings.TrimSpace(req.ID))
		if perr != nil {
			httpx.BadRequest(w, r, "malformed book entry id")
			return
		}
		entryID = parsed
	}

	var clash, missing bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var tag interface{ RowsAffected() int64 }
		var err error
		if req.ExplainedAs != "" {
			tag, err = tx.Exec(r.Context(), `
				UPDATE bank_statement_lines
				   SET explained_as = $3, match_kind = NULL, match_id = NULL,
				       match_confidence = NULL, matched_by = $4, matched_at = now()
				 WHERE id = $1 AND institution_id = $2`,
				lineID, id.InstitutionID, req.ExplainedAs, id.UserID)
		} else {
			tag, err = tx.Exec(r.Context(), `
				UPDATE bank_statement_lines
				   SET match_kind = $3, match_id = $4, match_confidence = 'manual',
				       explained_as = NULL, matched_by = $5, matched_at = now()
				 WHERE id = $1 AND institution_id = $2`,
				lineID, id.InstitutionID, req.Kind, entryID, id.UserID)
		}
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			missing = true
		}
		return nil
	})
	switch {
	case err != nil && strings.Contains(err.Error(), "bank_statement_lines_one_claim_per_entry"):
		clash = true
	case err != nil && strings.Contains(err.Error(), "is finalised"):
		httpx.Error(w, r, http.StatusConflict, "finalised",
			"this period is finalised. Reopen it, with a reason, before changing it.")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	case missing:
		httpx.NotFound(w, r)
		return
	}
	if clash {
		httpx.BadRequest(w, r,
			"another statement line is already matched to that book entry — unmatch it first")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) unmatchStatementLine(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	lineID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed line id")
		return
	}
	var missing bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE bank_statement_lines
			   SET match_kind = NULL, match_id = NULL, match_confidence = NULL,
			       explained_as = NULL, matched_by = NULL, matched_at = NULL
			 WHERE id = $1 AND institution_id = $2`, lineID, id.InstitutionID)
		if err != nil {
			return err
		}
		missing = tag.RowsAffected() == 0
		return nil
	})
	switch {
	case err != nil && strings.Contains(err.Error(), "is finalised"):
		httpx.Error(w, r, http.StatusConflict, "finalised",
			"this period is finalised. Reopen it, with a reason, before changing it.")
	case err != nil:
		httpx.Internal(w, r, err)
	case missing:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// --- reconciliation: finalise and reopen -------------------------------------

type finaliseRequest struct {
	Notes string `json:"notes"`
	// The residue is normally expected to be zero-sum. Finalising with an
	// unexplained difference is allowed, because sometimes it genuinely is a
	// bank error being chased — but only deliberately.
	AcknowledgeDifference bool `json:"acknowledge_difference"`
}

/*
finaliseBankReconciliation freezes the period.

	The residue is computed once, here, and stored. From this moment the
	trigger in 00046 refuses to let the period's lines change, so the numbers
	on this row and the lines behind them cannot drift apart.

	Refuses when the difference is unexplained unless the caller says so
	explicitly, for the same reason importBoardResults refuses an unreconciled
	file: the person clicking has to have seen the gap.
*/
func (s *Server) finaliseBankReconciliation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	recID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed reconciliation id")
		return
	}
	var req finaliseRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var already, unexplained bool
	var diff int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var acct uuid.UUID
		var start, end, status string
		var opening, closing int64
		if err := tx.QueryRow(r.Context(), `
			SELECT bank_account_id, to_char(period_start,'YYYY-MM-DD'),
			       to_char(period_end,'YYYY-MM-DD'), status,
			       opening_balance_paise, closing_balance_paise
			  FROM bank_reconciliations WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			recID, id.InstitutionID).Scan(&acct, &start, &end, &status, &opening, &closing); err != nil {
			return err
		}
		if status == "finalised" {
			already = true
			return nil
		}

		lines, err := s.loadStatementLines(r.Context(), tx, recID)
		if err != nil {
			return err
		}
		book, err := s.loadBookEntries(r.Context(), tx, id.InstitutionID, acct, start, end)
		if err != nil {
			return err
		}

		claimed := map[string]bool{}
		var unbankCount int
		var unbankPaise int64
		for _, l := range lines {
			if l.MatchKind != nil && l.MatchID != nil {
				claimed[*l.MatchKind+":"+*l.MatchID] = true
			}
			if l.MatchKind == nil && l.Explained == nil {
				unbankCount++
				unbankPaise += l.AmountPaise
			}
		}
		var bookTotal, unbookPaise int64
		var unbookCount int
		unmatchedBook := []bookEntry{}
		for _, e := range book {
			bookTotal += e.AmountPaise
			if !claimed[e.Kind+":"+e.ID] {
				unbookCount++
				unbookPaise += e.AmountPaise
				unmatchedBook = append(unmatchedBook, e)
			}
		}

		bookClosing := opening + bookTotal
		diff = closing - bookClosing
		if diff != unbankPaise-unbookPaise && !req.AcknowledgeDifference {
			unexplained = true
			return nil
		}

		snapshot, _ := json.Marshal(map[string]any{
			"frozen_at":            nowInIndia().Format(time.RFC3339),
			"bank_closing_paise":   closing,
			"book_closing_paise":   bookClosing,
			"line_count":           len(lines),
			"matched_count":        len(lines) - unbankCount,
			"unmatched_bank_lines": lines,
			"unmatched_book":       unmatchedBook,
		})

		_, err = tx.Exec(r.Context(), `
			UPDATE bank_reconciliations
			   SET status = 'finalised', finalised_by = $2, finalised_at = now(),
			       book_closing_paise = $3, unmatched_bank_count = $4,
			       unmatched_bank_paise = $5, unmatched_book_count = $6,
			       unmatched_book_paise = $7, difference_paise = $8,
			       snapshot = $9, notes = COALESCE(NULLIF($10,''), notes)
			 WHERE id = $1`,
			recID, id.UserID, bookClosing, unbankCount, unbankPaise, unbookCount,
			unbookPaise, diff, snapshot, req.Notes)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	case already:
		httpx.Error(w, r, http.StatusConflict, "finalised", "this period is already finalised")
	case unexplained:
		httpx.Error(w, r, http.StatusConflict, "unexplained_difference",
			fmt.Sprintf("the residue does not account for the difference of %s. "+
				"Match or explain the remaining lines, or finalise again acknowledging the gap.",
				rupeeString(diff)))
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "difference_paise": diff})
	}
}

type reopenRequest struct {
	Reason string `json:"reason"`
}

// reopenBankReconciliation is the supported way to change a closed period, and
// the only one. It demands a reason because "the closed period changed" with
// no name and no sentence against it is the finding an auditor writes up.
func (s *Server) reopenBankReconciliation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	recID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed reconciliation id")
		return
	}
	var req reopenRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "reopening a finalised period needs a reason")
		return
	}

	var missing bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE bank_reconciliations
			   SET status = 'open', reopened_by = $3, reopened_at = now(), reopen_reason = $4
			 WHERE id = $1 AND institution_id = $2 AND status = 'finalised'`,
			recID, id.InstitutionID, id.UserID, strings.TrimSpace(req.Reason))
		if err != nil {
			return err
		}
		missing = tag.RowsAffected() == 0
		return nil
	})
	switch {
	case err != nil:
		httpx.Internal(w, r, err)
	case missing:
		httpx.Error(w, r, http.StatusConflict, "not_finalised",
			"that period is not finalised, so there is nothing to reopen")
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// --- payouts -----------------------------------------------------------------

// listPayoutProviders is the honesty endpoint. The screen calls it to learn
// that this installation prepares files and does not transmit, and says so
// before anybody assembles a batch expecting the money to move by itself.
func (s *Server) listPayoutProviders(w http.ResponseWriter, r *http.Request) {
	type view struct {
		Name        string `json:"name"`
		Label       string `json:"label"`
		CanTransmit bool   `json:"can_transmit"`
		Why         string `json:"why,omitempty"`
	}
	out := []view{}
	for _, p := range []PayoutProvider{fileExportProvider{}} {
		out = append(out, view{Name: p.Name(), Label: p.Label(),
			CanTransmit: p.CanTransmit(), Why: p.Why()})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": out})
}

type payoutBatchView struct {
	ID           string  `json:"id"`
	BatchNo      string  `json:"batch_no"`
	Purpose      string  `json:"purpose"`
	ValueDate    string  `json:"value_date"`
	Status       string  `json:"status"`
	Provider     string  `json:"provider"`
	AccountLabel string  `json:"account_label"`
	BankAccount  string  `json:"bank_account_id"`
	ItemCount    int     `json:"item_count"`
	TotalPaise   int64   `json:"total_paise"`
	CreatedBy    string  `json:"created_by"`
	CreatedByID  string  `json:"created_by_id"`
	CreatedAt    string  `json:"created_at"`
	ApprovedBy   *string `json:"approved_by,omitempty"`
	RejectedBy   *string `json:"rejected_by,omitempty"`
	Reason       *string `json:"decision_reason,omitempty"`
	ExportedAt   *string `json:"exported_at,omitempty"`
	// Whether the caller may release this one. Computed on the server from the
	// same rule the write path enforces, so the button and the handler cannot
	// disagree — the UI hiding it is a courtesy, not the control.
	CallerMayApprove bool   `json:"caller_may_approve"`
	ApprovalBlocked  string `json:"approval_blocked,omitempty"`
	// The same refusal as a stable token. The sentence above is written for a
	// person and will be reworded; a screen that needs to count "batches
	// waiting on somebody else" was matching on its words, which fails silently
	// and reads zero the day it is edited.
	ApprovalBlockedCode string `json:"approval_blocked_code,omitempty"`
}

func (s *Server) listPayoutBatches(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	mayApprove := id.Can(rbac.RefundsWrite)
	q := r.URL.Query()

	items, err := collect(s, r, `
		SELECT pb.id::text, pb.batch_no, pb.purpose, to_char(pb.value_date,'YYYY-MM-DD'),
		       pb.status, pb.provider, b.label, pb.bank_account_id::text,
		       COALESCE(t.n,0)::int, COALESCE(t.total,0)::bigint,
		       cu.full_name, pb.created_by::text,
		       to_char(pb.created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       au.full_name, ru.full_name, pb.decision_reason,
		       to_char(pb.exported_at,'YYYY-MM-DD"T"HH24:MI:SSOF')
		  FROM payout_batches pb
		  JOIN bank_accounts b ON b.id = pb.bank_account_id
		  JOIN users cu ON cu.id = pb.created_by
		  LEFT JOIN users au ON au.id = pb.approved_by
		  LEFT JOIN users ru ON ru.id = pb.rejected_by
		  LEFT JOIN LATERAL (
		      SELECT count(*) AS n, sum(pi.amount_paise) AS total
		        FROM payout_items pi WHERE pi.batch_id = pb.id
		  ) t ON true
		 WHERE ($1::text IS NULL OR pb.status = $1)
		 ORDER BY pb.created_at DESC LIMIT $2`,
		[]any{nullString(q.Get("status")), clampInt(q.Get("limit"), 100, 1, 500)},
		func(rows pgx.Rows) (payoutBatchView, error) {
			var v payoutBatchView
			err := rows.Scan(&v.ID, &v.BatchNo, &v.Purpose, &v.ValueDate, &v.Status,
				&v.Provider, &v.AccountLabel, &v.BankAccount, &v.ItemCount, &v.TotalPaise,
				&v.CreatedBy, &v.CreatedByID, &v.CreatedAt, &v.ApprovedBy, &v.RejectedBy,
				&v.Reason, &v.ExportedAt)
			v.CallerMayApprove, v.ApprovalBlockedCode, v.ApprovalBlocked = approvalStanding(
				v.Status, v.CreatedByID, id.UserID.String(), mayApprove)
			return v, err
		})
	respond(w, r, items, err)
}

/*
approvalStanding is the maker/checker rule, in one place.

	Used by the list projection and by decidePayoutBatch, so what the screen
	shows and what the server enforces are the same sentence rather than two
	implementations that drift. The handler calls it again on the write path
	regardless of what the client believed.
*/
// The codes approvalStanding returns. Stable: a client may branch on these,
// which is what the sentences beside them must never be used for.
const (
	blockedNotSubmitted = "not_submitted"
	blockedNoPermission = "no_permission"
	blockedIsMaker      = "assembled_by_caller"
)

func approvalStanding(status, createdBy, caller string, mayApprove bool) (ok bool, code, why string) {
	switch {
	case status != "submitted":
		return false, blockedNotSubmitted, "only a submitted batch can be released"
	case !mayApprove:
		return false, blockedNoPermission,
			"releasing a payout needs the finance approve permission"
	case createdBy == caller:
		return false, blockedIsMaker,
			"you assembled this batch, so somebody else must release it"
	default:
		return true, "", ""
	}
}

type payoutItemView struct {
	ID            string  `json:"id"`
	Kind          string  `json:"beneficiary_kind"`
	Name          string  `json:"beneficiary_name"`
	AccountMasked string  `json:"account_masked"`
	IFSC          string  `json:"ifsc"`
	AmountPaise   int64   `json:"amount_paise"`
	Mode          string  `json:"mode"`
	Narration     *string `json:"narration,omitempty"`
	SourceKind    *string `json:"source_kind,omitempty"`
	SourceID      *string `json:"source_id,omitempty"`
	Status        string  `json:"status"`
	UTR           *string `json:"utr,omitempty"`
}

func (s *Server) getPayoutBatch(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	batchID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed batch id")
		return
	}
	mayApprove := id.Can(rbac.RefundsWrite)

	type payload struct {
		payoutBatchView
		Items []payoutItemView `json:"items"`
	}
	out := payload{Items: []payoutItemView{}}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT pb.id::text, pb.batch_no, pb.purpose, to_char(pb.value_date,'YYYY-MM-DD'),
			       pb.status, pb.provider, b.label, pb.bank_account_id::text,
			       cu.full_name, pb.created_by::text,
			       to_char(pb.created_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),
			       au.full_name, ru.full_name, pb.decision_reason,
			       to_char(pb.exported_at,'YYYY-MM-DD"T"HH24:MI:SSOF')
			  FROM payout_batches pb
			  JOIN bank_accounts b ON b.id = pb.bank_account_id
			  JOIN users cu ON cu.id = pb.created_by
			  LEFT JOIN users au ON au.id = pb.approved_by
			  LEFT JOIN users ru ON ru.id = pb.rejected_by
			 WHERE pb.id = $1 AND pb.institution_id = $2`,
			batchID, id.InstitutionID).Scan(&out.ID, &out.BatchNo, &out.Purpose,
			&out.ValueDate, &out.Status, &out.Provider, &out.AccountLabel,
			&out.BankAccount, &out.CreatedBy, &out.CreatedByID, &out.CreatedAt,
			&out.ApprovedBy, &out.RejectedBy, &out.Reason, &out.ExportedAt); err != nil {
			return err
		}
		out.CallerMayApprove, out.ApprovalBlockedCode, out.ApprovalBlocked = approvalStanding(
			out.Status, out.CreatedByID, id.UserID.String(), mayApprove)

		rows, err := tx.Query(r.Context(), `
			SELECT id::text, beneficiary_kind, beneficiary_name, account_number, ifsc,
			       amount_paise, mode, narration, source_kind, source_id::text, status, utr
			  FROM payout_items WHERE batch_id = $1 AND institution_id = $2
			 ORDER BY beneficiary_name`, batchID, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v payoutItemView
			var acct string
			if err := rows.Scan(&v.ID, &v.Kind, &v.Name, &acct, &v.IFSC, &v.AmountPaise,
				&v.Mode, &v.Narration, &v.SourceKind, &v.SourceID, &v.Status, &v.UTR); err != nil {
				return err
			}
			// Masked here too. A payout batch is a list of other people's
			// account numbers on a screen that stays open all afternoon.
			v.AccountMasked = maskAccountNumber(acct)
			out.Items = append(out.Items, v)
			out.TotalPaise += v.AmountPaise
		}
		out.ItemCount = len(out.Items)
		return rows.Err()
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

type payoutBatchRequest struct {
	BankAccountID string `json:"bank_account_id"`
	BatchNo       string `json:"batch_no"`
	Purpose       string `json:"purpose"`
	ValueDate     string `json:"value_date"`
	Provider      string `json:"provider"`
	Notes         string `json:"notes"`
}

func (s *Server) createPayoutBatch(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req payoutBatchRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	acct, err := uuid.Parse(strings.TrimSpace(req.BankAccountID))
	if err != nil {
		httpx.BadRequest(w, r, "choose the account the money leaves from")
		return
	}
	switch req.Purpose {
	case "vendor", "salary", "refund", "scholarship", "mixed":
	default:
		httpx.BadRequest(w, r, "purpose must be vendor, salary, refund, scholarship or mixed")
		return
	}
	if _, ok := payoutProviderFor(req.Provider); !ok {
		httpx.BadRequest(w, r, "unknown payout provider")
		return
	}
	provider := req.Provider
	if provider == "" {
		provider = "file_export"
	}
	valueDate := strings.TrimSpace(req.ValueDate)
	if valueDate == "" {
		valueDate = nowInIndia().Format("2006-01-02")
	}
	if _, err := time.Parse("2006-01-02", valueDate); err != nil {
		httpx.BadRequest(w, r, "value date must be a date, as YYYY-MM-DD")
		return
	}
	batchNo := strings.TrimSpace(req.BatchNo)
	if batchNo == "" {
		batchNo = fmt.Sprintf("PO/%s/%s", fyLabelForDate(valueDate),
			nowInIndia().Format("20060102-150405"))
	}

	var notPayable bool
	var batchID uuid.UUID
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var allows, active bool
		if err := tx.QueryRow(r.Context(), `
			SELECT allows_payouts, is_active FROM bank_accounts
			 WHERE id=$1 AND institution_id=$2`, acct, id.InstitutionID).Scan(&allows, &active); err != nil {
			return err
		}
		if !allows || !active {
			notPayable = true
			return nil
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO payout_batches (institution_id, bank_account_id, batch_no, purpose,
			                            value_date, provider, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8) RETURNING id`,
			id.InstitutionID, acct, batchNo, req.Purpose, valueDate, provider,
			req.Notes, id.UserID).Scan(&batchID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case notPayable:
		httpx.BadRequest(w, r,
			"that account is not marked for payouts. Enable payouts on it first — "+
				"it stops a collection account being debited by accident.")
	case err != nil && strings.Contains(err.Error(), "payout_batches_no_once"):
		httpx.BadRequest(w, r, "a batch with that number already exists")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": batchID.String(), "batch_no": batchNo})
	}
}

// fyLabelForDate gives the Indian financial year a date falls in, as 2026-27.
func fyLabelForDate(iso string) string {
	t, err := time.Parse("2006-01-02", iso)
	if err != nil {
		t = nowInIndia()
	}
	y := t.Year()
	if t.Month() < time.April {
		y--
	}
	return fmt.Sprintf("%d-%02d", y, (y+1)%100)
}

type payoutItemRequest struct {
	Kind          string `json:"beneficiary_kind"`
	VendorID      string `json:"vendor_id"`
	EmployeeID    string `json:"employee_id"`
	StudentID     string `json:"student_id"`
	Name          string `json:"beneficiary_name"`
	AccountNumber string `json:"account_number"`
	IFSC          string `json:"ifsc"`
	AmountPaise   int64  `json:"amount_paise"`
	Mode          string `json:"mode"`
	Narration     string `json:"narration"`
	SourceKind    string `json:"source_kind"`
	SourceID      string `json:"source_id"`
}

/*
addPayoutItems adds beneficiaries to a draft batch.

	Takes a list rather than one at a time: the realistic gesture is "pay these
	forty approved bills", and forty round trips is forty chances to half-finish.

	A batch that has been submitted is closed to edits. Otherwise the maker
	could add a line after the checker read the list, which is precisely the
	control being circumvented.
*/
func (s *Server) addPayoutItems(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	batchID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed batch id")
		return
	}
	var req struct {
		Items []payoutItemRequest `json:"items"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Items) == 0 {
		httpx.BadRequest(w, r, "no beneficiaries given")
		return
	}

	for i, it := range req.Items {
		switch it.Kind {
		case "vendor", "employee", "student", "other":
		default:
			httpx.BadRequest(w, r, fmt.Sprintf(
				"row %d: beneficiary kind must be vendor, employee, student or other", i+1))
			return
		}
		if strings.TrimSpace(it.Name) == "" {
			httpx.BadRequest(w, r, fmt.Sprintf("row %d: the beneficiary needs a name", i+1))
			return
		}
		if it.AmountPaise <= 0 {
			httpx.BadRequest(w, r, fmt.Sprintf("row %d (%s): amount must be positive", i+1, it.Name))
			return
		}
		/* Account number and IFSC may be omitted, and normally are.

		   The screen that assembles a batch lists beneficiaries with their
		   account numbers masked — that is the whole point of the register —
		   so it has no full number to send back. Leaving them empty asks the
		   server to read them from the beneficiary's own record, which means
		   the number never makes a round trip out to a browser in order to be
		   paid. A caller that does supply them is validated as before, for the
		   ad-hoc transfer to somebody who is not on file at all. */
		if strings.TrimSpace(it.AccountNumber) != "" || strings.TrimSpace(it.IFSC) != "" {
			if !accountNumberShape.MatchString(strings.TrimSpace(it.AccountNumber)) {
				httpx.BadRequest(w, r, fmt.Sprintf(
					"row %d (%s): account number must be 6 to 20 letters or digits",
					i+1, it.Name))
				return
			}
			if !validIFSC(it.IFSC) {
				httpx.BadRequest(w, r, fmt.Sprintf(
					"row %d (%s): IFSC must look like SBIN0001234", i+1, it.Name))
				return
			}
			continue
		}
		if it.Kind == "other" {
			httpx.BadRequest(w, r, fmt.Sprintf(
				"row %d (%s): an ad-hoc beneficiary is not on file, so the account number and IFSC must be given",
				i+1, it.Name))
			return
		}
	}

	var notDraft, duplicate bool
	var noBank []string
	inserted := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM payout_batches WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			batchID, id.InstitutionID).Scan(&status); err != nil {
			return err
		}
		if status != "draft" {
			notDraft = true
			return nil
		}

		for _, it := range req.Items {
			mode := it.Mode
			if mode == "" {
				mode = "neft"
			}

			acctNo := strings.TrimSpace(it.AccountNumber)
			ifsc := strings.ToUpper(strings.TrimSpace(it.IFSC))
			if acctNo == "" {
				resolvedAcct, resolvedIFSC, rerr := s.beneficiaryBank(r.Context(), tx,
					id.InstitutionID, it)
				if rerr != nil {
					return rerr
				}
				if !accountNumberShape.MatchString(resolvedAcct) || !ifscShape.MatchString(resolvedIFSC) {
					// Named rather than skipped silently. A beneficiary dropped
					// from a payout without a word is somebody who does not get
					// paid, and nobody finds out until they say so.
					noBank = append(noBank, it.Name)
					continue
				}
				acctNo, ifsc = resolvedAcct, resolvedIFSC
			}

			_, err := tx.Exec(r.Context(), `
				INSERT INTO payout_items (institution_id, batch_id, beneficiary_kind,
				    vendor_id, employee_id, student_id, beneficiary_name, account_number,
				    ifsc, amount_paise, mode, narration, source_kind, source_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULLIF($12,''),
				        NULLIF($13,''),$14)`,
				id.InstitutionID, batchID, it.Kind,
				nullUUIDText(it.VendorID), nullUUIDText(it.EmployeeID), nullUUIDText(it.StudentID),
				strings.TrimSpace(it.Name), acctNo, ifsc, it.AmountPaise, mode,
				it.Narration, it.SourceKind, nullUUIDText(it.SourceID))
			if err != nil {
				if strings.Contains(err.Error(), "payout_items_one_live_per_source") {
					duplicate = true
					return errors.New("duplicate source")
				}
				return err
			}
			inserted++
		}
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case duplicate:
		httpx.BadRequest(w, r,
			"one of those documents is already in a live payout batch. "+
				"Paying it twice is the failure this refuses — remove it, or cancel the other batch.")
	case notDraft:
		httpx.Error(w, r, http.StatusConflict, "not_draft",
			"this batch has already been submitted. A batch cannot change after a checker has seen it.")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		if noBank == nil {
			noBank = []string{}
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"added": inserted, "skipped_no_bank": noBank})
	}
}

/*
beneficiaryBank reads a beneficiary's account details from their own record.

	So that a full account number never travels out to a browser and back in
	order to be paid. The register masks what it shows, so the screen that
	assembles a batch has no unmasked number to send — this is how the real
	value reaches the payout file without anybody having to unmask it first.

	A student is paid into their primary account, which is the one the DBT
	register marks — never an arbitrary one, because "whichever row came first"
	is how a scholarship lands in a closed account.
*/
func (s *Server) beneficiaryBank(ctx context.Context, tx pgx.Tx, inst uuid.UUID,
	it payoutItemRequest) (string, string, error) {
	var q string
	var arg any
	switch it.Kind {
	case "vendor":
		q = `SELECT COALESCE(bank_account,''), COALESCE(bank_ifsc,'')
		       FROM vendors WHERE id=$1 AND institution_id=$2`
		arg = nullUUIDText(it.VendorID)
	case "employee":
		q = `SELECT COALESCE(bank_account,''), COALESCE(bank_ifsc,'')
		       FROM employees WHERE id=$1 AND institution_id=$2`
		arg = nullUUIDText(it.EmployeeID)
	case "student":
		q = `SELECT COALESCE(account_number,''), COALESCE(ifsc,'')
		       FROM student_bank_accounts
		      WHERE student_id=$1 AND institution_id=$2 AND is_primary AND is_active
		      LIMIT 1`
		arg = nullUUIDText(it.StudentID)
	default:
		return "", "", nil
	}
	if arg == nil {
		return "", "", nil
	}
	var acct, ifsc string
	err := tx.QueryRow(ctx, q, arg, inst).Scan(&acct, &ifsc)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	return strings.TrimSpace(acct), strings.ToUpper(strings.TrimSpace(ifsc)), nil
}

func (s *Server) removePayoutItem(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	batchID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed batch id")
		return
	}
	itemID, err := uuid.Parse(chi.URLParam(r, "itemID"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed item id")
		return
	}
	var notDraft, missing bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(),
			`SELECT status FROM payout_batches WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			batchID, id.InstitutionID).Scan(&status); err != nil {
			return err
		}
		if status != "draft" {
			notDraft = true
			return nil
		}
		tag, err := tx.Exec(r.Context(),
			`DELETE FROM payout_items WHERE id=$1 AND batch_id=$2 AND institution_id=$3`,
			itemID, batchID, id.InstitutionID)
		if err != nil {
			return err
		}
		missing = tag.RowsAffected() == 0
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows) || missing:
		httpx.NotFound(w, r)
	case notDraft:
		httpx.Error(w, r, http.StatusConflict, "not_draft",
			"this batch has already been submitted and cannot change")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// submitPayoutBatch is the maker saying they are done. It refuses an empty
// batch, which would otherwise be a checker approving nothing and a file with
// a header and no rows.
func (s *Server) submitPayoutBatch(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	batchID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed batch id")
		return
	}
	var empty, notDraft bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var n int
		if err := tx.QueryRow(r.Context(), `
			SELECT pb.status, (SELECT count(*) FROM payout_items pi WHERE pi.batch_id = pb.id)::int
			  FROM payout_batches pb WHERE pb.id=$1 AND pb.institution_id=$2 FOR UPDATE`,
			batchID, id.InstitutionID).Scan(&status, &n); err != nil {
			return err
		}
		if status != "draft" {
			notDraft = true
			return nil
		}
		if n == 0 {
			empty = true
			return nil
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE payout_batches SET status='submitted', submitted_at=now() WHERE id=$1`, batchID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case notDraft:
		httpx.Error(w, r, http.StatusConflict, "not_draft", "only a draft batch can be submitted")
	case empty:
		httpx.BadRequest(w, r, "this batch has no beneficiaries in it")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

type payoutDecisionRequest struct {
	Approve bool   `json:"approve"`
	Reason  string `json:"reason"`
}

/*
decidePayoutBatch is the checker's verb, and the maker/checker control.

	The permission gate on the route says the caller may release payouts in
	general. This says they may release THIS one, which is a different question
	and the only one that matters: the person who assembled the list must not
	be the person who releases it.

	Enforced three times over, deliberately. Here, so the caller gets 403 and a
	sentence. In the UPDATE's WHERE clause, so a concurrent request that raced
	past the check still cannot land it. And by a CHECK constraint in 00046, so
	nothing outside this handler can either.
*/
func (s *Server) decidePayoutBatch(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	batchID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed batch id")
		return
	}
	var req payoutDecisionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if !req.Approve && strings.TrimSpace(req.Reason) == "" {
		httpx.BadRequest(w, r, "refusing a batch needs a reason the maker can act on")
		return
	}

	var blocked string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var status string
		var createdBy uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT status, created_by FROM payout_batches
			  WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			batchID, id.InstitutionID).Scan(&status, &createdBy); err != nil {
			return err
		}
		ok, _, why := approvalStanding(status, createdBy.String(), id.UserID.String(),
			id.Can(rbac.RefundsWrite))
		if !ok {
			blocked = why
			return nil
		}

		if req.Approve {
			_, err := tx.Exec(r.Context(), `
				UPDATE payout_batches
				   SET status='approved', approved_by=$2, approved_at=now(),
				       decision_reason=NULLIF($3,'')
				 WHERE id=$1 AND status='submitted' AND created_by <> $2`,
				batchID, id.UserID, req.Reason)
			return err
		}
		_, err := tx.Exec(r.Context(), `
			UPDATE payout_batches
			   SET status='rejected', rejected_by=$2, rejected_at=now(), decision_reason=$3
			 WHERE id=$1 AND status='submitted' AND created_by <> $2`,
			batchID, id.UserID, strings.TrimSpace(req.Reason))
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case blocked != "":
		// 403 rather than 400: this is an authorization decision about who the
		// caller is, not a complaint about what they sent.
		httpx.Denied(w, r, blocked)
	case err != nil && strings.Contains(err.Error(), "maker_is_not_checker"):
		httpx.Denied(w, r, "you assembled this batch, so somebody else must release it")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

/*
exportPayoutFile renders an approved batch through its provider.

	Only an approved batch. Exporting a draft would be the bank file bypassing
	the checker entirely, which is the whole control — so the status test is in
	the WHERE clause of the UPDATE that marks it exported, not merely in an if.

	Marking the batch exported and its items exported is what makes the payout
	visible to the reconciliation later: an exported item is a book entry the
	BRS expects to find on the statement.
*/
func (s *Server) exportPayoutFile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	batchID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed batch id")
		return
	}

	var header PayoutBatchHeader
	var lines []PayoutLine
	var provider PayoutProvider
	var notApproved bool

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var providerName, status string
		if err := tx.QueryRow(r.Context(), `
			SELECT pb.batch_no, pb.purpose, to_char(pb.value_date,'YYYY-MM-DD'),
			       pb.provider, pb.status, b.account_number, b.ifsc, b.bank_name
			  FROM payout_batches pb
			  JOIN bank_accounts b ON b.id = pb.bank_account_id
			 WHERE pb.id=$1 AND pb.institution_id=$2 FOR UPDATE OF pb`,
			batchID, id.InstitutionID).Scan(&header.BatchNo, &header.Purpose,
			&header.ValueDate, &providerName, &status, &header.DebitAccount,
			&header.DebitIFSC, &header.DebitBankName); err != nil {
			return err
		}
		if status != "approved" && status != "exported" {
			notApproved = true
			return nil
		}
		p, ok := payoutProviderFor(providerName)
		if !ok {
			return fmt.Errorf("batch names an unknown provider %q", providerName)
		}
		provider = p

		rows, err := tx.Query(r.Context(), `
			SELECT beneficiary_name, account_number, ifsc, amount_paise, mode,
			       COALESCE(narration,'')
			  FROM payout_items WHERE batch_id=$1 AND institution_id=$2
			 ORDER BY beneficiary_name`, batchID, id.InstitutionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var l PayoutLine
			if err := rows.Scan(&l.BeneficiaryName, &l.AccountNumber, &l.IFSC,
				&l.AmountPaise, &l.Mode, &l.Narration); err != nil {
				return err
			}
			lines = append(lines, l)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		if _, err := tx.Exec(r.Context(), `
			UPDATE payout_batches
			   SET status='exported', exported_by=$2, exported_at=COALESCE(exported_at, now())
			 WHERE id=$1 AND status IN ('approved','exported')`, batchID, id.UserID); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `
			UPDATE payout_items SET status='exported'
			 WHERE batch_id=$1 AND status='pending'`, batchID)
		return err
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
		return
	case notApproved:
		httpx.Error(w, r, http.StatusConflict, "not_approved",
			"this batch has not been released by a checker, so there is no file to produce")
		return
	case err != nil:
		httpx.Internal(w, r, err)
		return
	}

	filename, contentType, body, err := provider.Prepare(header, lines)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, filename))
	// Says plainly what this file is and is not, for anyone reading the
	// response rather than the screen.
	w.Header().Set("X-Payout-Transmission", "not-attempted: upload this file to your bank's portal")
	_, _ = w.Write(body)
}

/*
listPayoutCandidates is what a batch is assembled from.

	Three sources, each already approved by its own workflow — this screen does
	not approve anything, it only gathers what is owed and has a bank account
	to send it to. Anything already sitting in a live batch is excluded here as
	well as being refused by the unique index, so the maker never sees a row
	that will bounce when they add it.
*/
func (s *Server) listPayoutCandidates(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "vendor_bill"
	}

	type candidate struct {
		SourceKind    string  `json:"source_kind"`
		SourceID      string  `json:"source_id"`
		Kind          string  `json:"beneficiary_kind"`
		BeneficiaryID string  `json:"beneficiary_id"`
		Name          string  `json:"beneficiary_name"`
		AccountMasked string  `json:"account_masked"`
		HasBank       bool    `json:"has_bank"`
		IFSC          *string `json:"ifsc,omitempty"`
		AmountPaise   int64   `json:"amount_paise"`
		Reference     string  `json:"reference"`
		DueOn         *string `json:"due_on,omitempty"`
	}

	var sql string
	var args []any
	switch kind {
	case "vendor_bill":
		sql = `
			SELECT 'vendor_bill'::text, vb.id::text, 'vendor'::text, v.id::text, v.name,
			       COALESCE(v.bank_account,''), COALESCE(v.bank_ifsc,''),
			       vb.total_paise - COALESCE(paid.total,0),
			       vb.bill_no, to_char(vb.due_on,'YYYY-MM-DD')
			  FROM vendor_bills vb
			  JOIN vendors v ON v.id = vb.vendor_id
			  LEFT JOIN LATERAL (
			      SELECT sum(vp.amount_paise) AS total FROM vendor_payments vp
			       WHERE vp.bill_id = vb.id
			  ) paid ON true
			 WHERE vb.status = 'approved'
			   AND vb.total_paise - COALESCE(paid.total,0) > 0
			   AND NOT EXISTS (
			       SELECT 1 FROM payout_items pi
			        WHERE pi.source_kind = 'vendor_bill' AND pi.source_id = vb.id
			          AND pi.status IN ('pending','exported','paid'))
			 ORDER BY vb.due_on NULLS LAST, v.name`
	case "payslip":
		sql = `
			SELECT 'payslip'::text, ps.id::text, 'employee'::text, e.id::text,
			       concat_ws(' ', e.first_name, e.last_name),
			       COALESCE(e.bank_account,''), COALESCE(e.bank_ifsc,''),
			       ps.net_paise,
			       to_char(make_date(pr.period_year, pr.period_month, 1),'Mon YYYY'),
			       NULL::text
			  FROM payslips ps
			  JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
			  JOIN employees e ON e.id = ps.employee_id
			 WHERE pr.status IN ('processed','locked')
			   AND ps.net_paise > 0
			   AND NOT EXISTS (
			       SELECT 1 FROM payout_items pi
			        WHERE pi.source_kind = 'payslip' AND pi.source_id = ps.id
			          AND pi.status IN ('pending','exported','paid'))
			 ORDER BY pr.period_year DESC, pr.period_month DESC, e.first_name`
	case "refund":
		sql = `
			SELECT 'refund'::text, rf.id::text, 'student'::text, st.id::text,
			       concat_ws(' ', st.first_name, st.last_name),
			       COALESCE(sba.account_number,''), COALESCE(sba.ifsc,''),
			       rf.amount_paise, COALESCE(rf.reason,''), NULL::text
			  FROM refunds rf
			  JOIN students st ON st.id = rf.student_id
			  LEFT JOIN LATERAL (
			      SELECT b.account_number, b.ifsc FROM student_bank_accounts b
			       WHERE b.student_id = rf.student_id AND b.is_active AND b.is_primary
			       LIMIT 1
			  ) sba ON true
			 WHERE rf.status = 'approved'
			   AND NOT EXISTS (
			       SELECT 1 FROM payout_items pi
			        WHERE pi.source_kind = 'refund' AND pi.source_id = rf.id
			          AND pi.status IN ('pending','exported','paid'))
			 ORDER BY rf.created_at DESC`
	default:
		httpx.BadRequest(w, r, "kind must be vendor_bill, payslip or refund")
		return
	}

	items, err := collect(s, r, sql, args, func(rows pgx.Rows) (candidate, error) {
		var v candidate
		var acct, ifsc string
		if err := rows.Scan(&v.SourceKind, &v.SourceID, &v.Kind, &v.BeneficiaryID,
			&v.Name, &acct, &ifsc, &v.AmountPaise, &v.Reference, &v.DueOn); err != nil {
			return v, err
		}
		// Masked in the candidate list too, and a flag saying whether there is
		// anything to pay into. "No bank details on file" is the reason a
		// beneficiary silently goes unpaid, so it is a column, not an absence.
		v.AccountMasked = maskAccountNumber(acct)
		v.HasBank = acct != "" && ifsc != ""
		if ifsc != "" {
			v.IFSC = &ifsc
		}
		return v, nil
	})
	respond(w, r, items, err)
}

// --- student bank account register -------------------------------------------

type studentBankAccountView struct {
	ID            string  `json:"id"`
	StudentID     string  `json:"student_id"`
	StudentName   string  `json:"student_name"`
	AdmissionNo   string  `json:"admission_no"`
	ClassSection  *string `json:"class_section,omitempty"`
	HolderName    string  `json:"account_holder_name"`
	Relationship  string  `json:"relationship"`
	GuardianName  *string `json:"guardian_name,omitempty"`
	BankName      string  `json:"bank_name"`
	Branch        *string `json:"branch,omitempty"`
	AccountMasked string  `json:"account_masked"`
	IFSC          string  `json:"ifsc"`
	AccountType   string  `json:"account_type"`
	AadhaarSeeded bool    `json:"is_aadhaar_seeded"`
	DBTConsentOn  *string `json:"dbt_consent_on,omitempty"`
	IsPrimary     bool    `json:"is_primary"`
	IsActive      bool    `json:"is_active"`
	VerifiedAt    *string `json:"verified_at,omitempty"`
	VerifiedBy    *string `json:"verified_by,omitempty"`
	Notes         *string `json:"notes,omitempty"`
	// Whether the caller could unmask this row, so the screen knows whether to
	// offer the button at all. Never a substitute for the check on the reveal
	// route, which is what actually decides.
	CanReveal bool `json:"can_reveal"`
}

/*
listStudentBankAccounts is the register, masked.

	The masking happens in the SQL projection: the full number is never in the
	response body, never in a log of it, and never in the browser's memory. A
	list endpoint that returned the number and trusted the client to hide it
	would leak it to anybody who opened the network tab, which is everybody.
*/
func (s *Server) listStudentBankAccounts(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	canReveal := id.Can(rbac.FinanceExport)
	q := r.URL.Query()

	items, err := collect(s, r, `
		SELECT b.id::text, b.student_id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       NULLIF(concat_ws('-', c.name, sec.name),''),
		       b.account_holder_name, b.relationship, g.full_name,
		       b.bank_name, b.branch,
		       -- Masked in the database, not the client.
		       repeat('•', greatest(length(b.account_number) - 4, 0)) ||
		           right(b.account_number, 4),
		       b.ifsc, b.account_type, b.is_aadhaar_seeded,
		       to_char(b.dbt_consent_on,'YYYY-MM-DD'), b.is_primary, b.is_active,
		       to_char(b.verified_at,'YYYY-MM-DD"T"HH24:MI:SSOF'), vu.full_name, b.notes
		  FROM student_bank_accounts b
		  JOIN students st ON st.id = b.student_id
		  LEFT JOIN guardians g ON g.id = b.guardian_id
		  LEFT JOIN users vu ON vu.id = b.verified_by
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) en ON true
		  LEFT JOIN classes c ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE ($1::uuid IS NULL OR b.student_id = $1)
		   AND ($2::text IS NULL
		        OR st.admission_no ILIKE '%' || $2 || '%'
		        OR concat_ws(' ', st.first_name, st.last_name) ILIKE '%' || $2 || '%')
		   AND ($3::bool IS NULL OR b.is_active = $3)
		 ORDER BY st.first_name, b.is_primary DESC
		 LIMIT $4`,
		[]any{nullUUIDText(q.Get("student_id")), nullString(q.Get("q")),
			nullBool(q.Get("active")), clampInt(q.Get("limit"), 200, 1, 1000)},
		func(rows pgx.Rows) (studentBankAccountView, error) {
			var v studentBankAccountView
			err := rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.ClassSection, &v.HolderName, &v.Relationship, &v.GuardianName,
				&v.BankName, &v.Branch, &v.AccountMasked, &v.IFSC, &v.AccountType,
				&v.AadhaarSeeded, &v.DBTConsentOn, &v.IsPrimary, &v.IsActive,
				&v.VerifiedAt, &v.VerifiedBy, &v.Notes)
			v.CanReveal = canReveal
			return v, err
		})
	respond(w, r, items, err)
}

type studentBankAccountRequest struct {
	ID            string `json:"id"`
	StudentID     string `json:"student_id"`
	GuardianID    string `json:"guardian_id"`
	HolderName    string `json:"account_holder_name"`
	Relationship  string `json:"relationship"`
	BankName      string `json:"bank_name"`
	Branch        string `json:"branch"`
	AccountNumber string `json:"account_number"`
	IFSC          string `json:"ifsc"`
	AccountType   string `json:"account_type"`
	AadhaarSeeded bool   `json:"is_aadhaar_seeded"`
	DBTConsentOn  string `json:"dbt_consent_on"`
	MakePrimary   bool   `json:"make_primary"`
	IsActive      *bool  `json:"is_active"`
	Notes         string `json:"notes"`
}

func (s *Server) saveStudentBankAccount(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req studentBankAccountRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.HolderName = strings.TrimSpace(req.HolderName)
	req.BankName = strings.TrimSpace(req.BankName)
	req.AccountNumber = strings.TrimSpace(req.AccountNumber)
	req.IFSC = strings.ToUpper(strings.TrimSpace(req.IFSC))
	if req.Relationship == "" {
		req.Relationship = "self"
	}
	if req.AccountType == "" {
		req.AccountType = "savings"
	}

	student, err := uuid.Parse(strings.TrimSpace(req.StudentID))
	if err != nil {
		httpx.BadRequest(w, r, "which student is this account for?")
		return
	}
	switch {
	case req.HolderName == "":
		httpx.BadRequest(w, r, "whose name is on the account?")
		return
	case req.BankName == "":
		httpx.BadRequest(w, r, "which bank is the account with?")
		return
	case !accountNumberShape.MatchString(req.AccountNumber):
		httpx.BadRequest(w, r, "an account number is 6 to 20 letters or digits, with no spaces")
		return
	case !validIFSC(req.IFSC):
		httpx.BadRequest(w, r,
			"IFSC must be eleven characters: four letters, a zero, then six more — SBIN0001234")
		return
	}
	// The database says the same thing; said here so the message names the two
	// fields rather than the constraint.
	if (req.Relationship == "self") != (strings.TrimSpace(req.GuardianID) == "") {
		httpx.BadRequest(w, r,
			"an account held by the child is relationship \"self\" and names no guardian; "+
				"any other relationship must name the guardian who holds it")
		return
	}

	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	if !active && req.MakePrimary {
		httpx.BadRequest(w, r, "an inactive account cannot be the primary one")
		return
	}

	var acctID uuid.UUID
	if req.ID != "" {
		parsed, perr := uuid.Parse(req.ID)
		if perr != nil {
			httpx.BadRequest(w, r, "malformed account id")
			return
		}
		acctID = parsed
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Demoting the incumbent before promoting the new one.

		   The partial unique index enforces one primary per student, so
		   inserting a second primary without this fails. Doing it in the same
		   transaction is what makes "make this the primary account" a single
		   idea rather than two writes a crash can land between. */
		if req.MakePrimary {
			if _, err := tx.Exec(r.Context(), `
				UPDATE student_bank_accounts SET is_primary = false, updated_at = now()
				 WHERE institution_id=$1 AND student_id=$2 AND is_primary
				   AND ($3::uuid IS NULL OR id <> $3)`,
				id.InstitutionID, student, nullUUIDArg(acctID)); err != nil {
				return err
			}
		}

		if acctID != uuid.Nil {
			tag, err := tx.Exec(r.Context(), `
				UPDATE student_bank_accounts
				   SET guardian_id = $3, account_holder_name = $4, relationship = $5,
				       bank_name = $6, branch = NULLIF($7,''), account_number = $8,
				       ifsc = $9, account_type = $10, is_aadhaar_seeded = $11,
				       dbt_consent_on = NULLIF($12,'')::date, is_active = $13,
				       is_primary = CASE WHEN $14 THEN true ELSE is_primary END,
				       notes = NULLIF($15,''), updated_at = now()
				 WHERE id = $1 AND institution_id = $2`,
				acctID, id.InstitutionID, nullUUIDText(req.GuardianID), req.HolderName,
				req.Relationship, req.BankName, req.Branch, req.AccountNumber, req.IFSC,
				req.AccountType, req.AadhaarSeeded, req.DBTConsentOn, active,
				req.MakePrimary, req.Notes)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return pgx.ErrNoRows
			}
			return nil
		}

		return tx.QueryRow(r.Context(), `
			INSERT INTO student_bank_accounts (institution_id, student_id, guardian_id,
			    account_holder_name, relationship, bank_name, branch, account_number,
			    ifsc, account_type, is_aadhaar_seeded, dbt_consent_on, is_primary,
			    is_active, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8,$9,$10,$11,NULLIF($12,'')::date,
			        $13,$14,NULLIF($15,''),$16)
			RETURNING id`,
			id.InstitutionID, student, nullUUIDText(req.GuardianID), req.HolderName,
			req.Relationship, req.BankName, req.Branch, req.AccountNumber, req.IFSC,
			req.AccountType, req.AadhaarSeeded, req.DBTConsentOn, req.MakePrimary,
			active, req.Notes, id.UserID).Scan(&acctID)
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil && strings.Contains(err.Error(), "student_bank_accounts_no_duplicate"):
		httpx.BadRequest(w, r, "that account is already on file for this student")
	case err != nil && strings.Contains(err.Error(), "student_bank_accounts_one_primary"):
		httpx.BadRequest(w, r, "this student already has a primary account")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"id": acctID.String()})
	}
}

// makeStudentAccountPrimary moves the flag, demoting the incumbent in the same
// transaction so the partial unique index is never momentarily violated.
func (s *Server) makeStudentAccountPrimary(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	acctID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed account id")
		return
	}
	var missing, inactive bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var student uuid.UUID
		var active bool
		if err := tx.QueryRow(r.Context(),
			`SELECT student_id, is_active FROM student_bank_accounts
			  WHERE id=$1 AND institution_id=$2 FOR UPDATE`,
			acctID, id.InstitutionID).Scan(&student, &active); err != nil {
			return err
		}
		if !active {
			inactive = true
			return nil
		}
		if _, err := tx.Exec(r.Context(), `
			UPDATE student_bank_accounts SET is_primary = false, updated_at = now()
			 WHERE institution_id=$1 AND student_id=$2 AND is_primary AND id <> $3`,
			id.InstitutionID, student, acctID); err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(), `
			UPDATE student_bank_accounts SET is_primary = true, updated_at = now()
			 WHERE id=$1 AND institution_id=$2`, acctID, id.InstitutionID)
		if err != nil {
			return err
		}
		missing = tag.RowsAffected() == 0
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows) || missing:
		httpx.NotFound(w, r)
	case inactive:
		httpx.BadRequest(w, r, "an inactive account cannot be the primary one")
	case err != nil:
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// verifyStudentBankAccount records that somebody checked the details against a
// passbook or a cancelled cheque. Not a bank verification — the column and this
// comment both say so — but it is the control that stops a typo becoming a
// scholarship credited to a stranger.
func (s *Server) verifyStudentBankAccount(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	acctID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed account id")
		return
	}
	var missing bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE student_bank_accounts
			   SET verified_by = $3, verified_at = now(), updated_at = now()
			 WHERE id = $1 AND institution_id = $2`, acctID, id.InstitutionID, id.UserID)
		if err != nil {
			return err
		}
		missing = tag.RowsAffected() == 0
		return nil
	})
	switch {
	case err != nil:
		httpx.Internal(w, r, err)
	case missing:
		httpx.NotFound(w, r)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

/*
revealStudentBankAccount returns the full account number, and records that it did.

	Three deliberate choices:

	A GET, not a POST. AuditMiddleware records the response body of every
	mutation, so a POST would write the full account number into audit_log and
	the audit trail would become a second, less protected copy of the thing
	being protected. A GET is skipped by the middleware and audited here
	instead, with the last four digits only.

	Fails closed. If the audit row cannot be written, the number is not
	returned. An unaudited reveal is exactly what this control exists to
	prevent, and a system that quietly degrades to "disclosed but unrecorded"
	under database pressure has the control in name only.

	Both in one transaction, so there is no window in which the number has been
	read and the record has not been made.
*/
func (s *Server) revealStudentBankAccount(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	acctID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "malformed account id")
		return
	}

	type revealed struct {
		ID            string `json:"id"`
		StudentID     string `json:"student_id"`
		StudentName   string `json:"student_name"`
		HolderName    string `json:"account_holder_name"`
		BankName      string `json:"bank_name"`
		AccountNumber string `json:"account_number"`
		IFSC          string `json:"ifsc"`
		// Echoed so the screen can say "this reveal was recorded" honestly.
		Audited bool `json:"audited"`
	}
	var out revealed

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var student uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT b.id::text, b.student_id, concat_ws(' ', st.first_name, st.last_name),
			       b.account_holder_name, b.bank_name, b.account_number, b.ifsc
			  FROM student_bank_accounts b
			  JOIN students st ON st.id = b.student_id
			 WHERE b.id = $1 AND b.institution_id = $2`,
			acctID, id.InstitutionID).Scan(&out.ID, &student, &out.StudentName,
			&out.HolderName, &out.BankName, &out.AccountNumber, &out.IFSC); err != nil {
			return err
		}
		out.StudentID = student.String()

		// The audit record names the student and the last four digits. Writing
		// the whole number here would defeat the purpose.
		after, _ := json.Marshal(map[string]any{
			"student_id":    student.String(),
			"account_id":    out.ID,
			"account_last4": lastFour(out.AccountNumber),
			"ifsc":          out.IFSC,
			"revealed_to":   id.FullName,
			"revealed_at":   nowInIndia().Format(time.RFC3339),
		})
		var ip *string
		if host, _, err := splitHostPortSafe(r.RemoteAddr); err == nil {
			ip = &host
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO audit_log (institution_id, actor_user_id, action, entity_type,
			                       entity_id, after, ip)
			VALUES ($1,$2,$3,$4,$5,$6,$7::inet)`,
			id.InstitutionID, id.UserID, "REVEAL student_bank_account",
			"banking.student-accounts", acctID, after, ip); err != nil {
			return err
		}
		out.Audited = true
		return nil
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.NotFound(w, r)
	case err != nil:
		// Fails closed: no number in the response when the record failed.
		httpx.Internal(w, r, err)
	default:
		httpx.JSON(w, http.StatusOK, out)
	}
}

func lastFour(s string) string {
	if len(s) <= 4 {
		return s
	}
	return s[len(s)-4:]
}

// --- small shared helpers ----------------------------------------------------

// nullUUIDText turns an optional uuid from a query string or JSON field into a
// SQL argument, so a filter that was not supplied compares IS NULL rather than
// failing to parse. Malformed input is treated as absent on purpose: these are
// filters, and a filter nobody set should not 400 a whole list.
func nullUUIDText(s string) any {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	u, err := uuid.Parse(s)
	if err != nil {
		return nil
	}
	return u
}

func nullBool(s string) any {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	default:
		return nil
	}
}

func splitHostPortSafe(addr string) (string, string, error) {
	i := strings.LastIndex(addr, ":")
	if i < 0 {
		return addr, "", nil
	}
	return addr[:i], addr[i+1:], nil
}
