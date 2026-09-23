package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* DIGITAL MONEY, PHASE 1: the ledger, a top-up, and a balance to read.

   A wallet is a prepaid balance the school holds for a student. The office
   records money it has ALREADY received — cash at the desk, a UPI transfer it
   has matched on the statement — as a top-up, and the balance is what is left
   after the wallet has been spent against fees, the canteen or the bus. No
   real money moves in this file: exactly as the UPI feature records a fee the
   family already paid, a top-up records a credit the school already banked.

   The balance is never written by hand. wallet_accounts.balance_paise is kept
   by a trigger as the sum of wallet_transactions, so it can always be
   re-derived, and the same trigger refuses to let it go below zero — which is
   what makes a wallet a prepaid balance and not a line of credit.

   Reading and writing are gated differently on purpose. Recording money needs
   finance.wallet.manage. Reading is one endpoint for two readers: the office
   (finance.wallet.read, reaching any student) and a family (self.wallet.read,
   reaching only their own child), told apart by the same scope narrowing the
   fee ledger uses rather than by two copies of the query. */

type walletTxn struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	DeltaPaise  int64   `json:"delta_paise"`
	SourceMode  *string `json:"source_mode"`
	ReferenceNo *string `json:"reference_no"`
	PaymentID   *string `json:"payment_id"`
	Note        *string `json:"note"`
	RecordedBy  *string `json:"recorded_by"`
	CreatedAt   string  `json:"created_at"`
}

type studentWallet struct {
	StudentID    string      `json:"student_id"`
	AdmissionNo  string      `json:"admission_no"`
	FullName     string      `json:"full_name"`
	WalletID     *string     `json:"wallet_id"`
	Status       string      `json:"status"`
	BalancePaise int64       `json:"balance_paise"`
	Transactions []walletTxn `json:"transactions"`
}

// getStudentWallet is GET /fees/students/{id}/wallet: the balance and the
// recent ledger, for the office or for the child's own family.
func (s *Server) getStudentWallet(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	if !id.Can(rbac.WalletRead) && !id.Can(rbac.SelfWalletRead) {
		httpx.Forbidden(w, r, rbac.WalletRead)
		return
	}
	studentID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}

	// The office reaches any student; a parent reaches only their own child.
	// Same narrowing as the fee ledger, so the two never disagree.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	scopePred, scopeArgs := res.StudentPredicate("st", 2)

	out := studentWallet{
		StudentID:    studentID.String(),
		Status:       "none",
		Transactions: []walletTxn{},
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT st.admission_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name)
			  FROM students st
			 WHERE st.id = $1 AND `+scopePred,
			append([]any{studentID}, scopeArgs...)...).
			Scan(&out.AdmissionNo, &out.FullName); err != nil {
			return err
		}

		// No wallet yet is not an error: it is a balance of zero that nobody
		// has opened. The first top-up creates it.
		var walletID uuid.UUID
		err := tx.QueryRow(r.Context(), `
			SELECT id, status, balance_paise FROM wallet_accounts
			 WHERE student_id = $1`, studentID).
			Scan(&walletID, &out.Status, &out.BalancePaise)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		wid := walletID.String()
		out.WalletID = &wid

		rows, err := tx.Query(r.Context(), `
			SELECT t.id, t.kind, t.delta_paise, t.source_mode, t.reference_no,
			       t.payment_id, t.note, u.full_name, t.created_at
			  FROM wallet_transactions t
			  LEFT JOIN users u ON u.id = t.created_by
			 WHERE t.wallet_id = $1
			 ORDER BY t.created_at DESC
			 LIMIT 200`, walletID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var (
				t         walletTxn
				tid       uuid.UUID
				paymentID *uuid.UUID
				createdAt time.Time
			)
			if err := rows.Scan(&tid, &t.Kind, &t.DeltaPaise, &t.SourceMode, &t.ReferenceNo,
				&paymentID, &t.Note, &t.RecordedBy, &createdAt); err != nil {
				return err
			}
			t.ID = tid.String()
			if paymentID != nil {
				p := paymentID.String()
				t.PaymentID = &p
			}
			t.CreatedAt = createdAt.Format(time.RFC3339)
			out.Transactions = append(out.Transactions, t)
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
	httpx.JSON(w, http.StatusOK, out)
}

// How a top-up reached the school. Mirrors the payment modes the fee counter
// accepts, minus the ones that are not money in hand yet.
var walletSourceModes = map[string]bool{
	"cash": true, "upi": true, "neft": true, "card": true, "gateway": true,
	"cheque": true, "dd": true,
}

type walletTopUpRequest struct {
	StudentID   string `json:"student_id"`
	AmountPaise int64  `json:"amount_paise"`
	SourceMode  string `json:"source_mode"`
	ReferenceNo string `json:"reference_no"`
	Note        string `json:"note"`
}

// walletTopUp is POST /fees/wallet/topups: the office records money already
// received into a student's wallet, opening the wallet on first use.
func (s *Server) walletTopUp(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req walletTopUpRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	studentID, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.AmountPaise <= 0 {
		httpx.BadRequest(w, r, "amount_paise must be greater than zero")
		return
	}
	mode := strings.ToLower(strings.TrimSpace(req.SourceMode))
	if !walletSourceModes[mode] {
		httpx.BadRequest(w, r, "unsupported source_mode: "+req.SourceMode)
		return
	}
	// A bank transfer with no reference cannot be matched to the statement,
	// and an unmatched credit is exactly the kind that gets recorded twice.
	if (mode == "upi" || mode == "neft" || mode == "cheque" || mode == "dd") &&
		strings.TrimSpace(req.ReferenceNo) == "" {
		httpx.BadRequest(w, r, "reference_no (UTR or instrument number) is required for "+mode)
		return
	}

	var (
		txnID    uuid.UUID
		walletID uuid.UUID
		balance  int64
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Institution and campus come from the student, not the caller (a
		// platform operator has no institution of their own).
		var instID uuid.UUID
		var campusID *uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id, campus_id FROM students WHERE id = $1`,
			studentID).Scan(&instID, &campusID); err != nil {
			return err
		}
		// Money credited into a closed month changes a figure the school has
		// already tied out — the same rule the fee counter follows.
		if err := s.requireOpenPeriod(r.Context(), tx, instID, "month", time.Now()); err != nil {
			return err
		}
		wid, status, err := openWallet(r, tx, instID, campusID, studentID)
		if err != nil {
			return err
		}
		if status != "active" {
			return walletInputError{"this wallet is " + status + " and cannot be topped up"}
		}
		walletID = wid
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO wallet_transactions
			       (institution_id, campus_id, wallet_id, student_id, kind, delta_paise,
			        source_mode, reference_no, note, created_by)
			VALUES ($1, $2, $3, $4, 'top_up', $5, $6, NULLIF($7, ''), NULLIF($8, ''), $9)
			RETURNING id`,
			instID, campusID, walletID, studentID, req.AmountPaise,
			mode, strings.TrimSpace(req.ReferenceNo), strings.TrimSpace(req.Note), id.UserID).
			Scan(&txnID); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(),
			`SELECT balance_paise FROM wallet_accounts WHERE id = $1`, walletID).Scan(&balance)
	})
	if walletFailed(w, r, err) {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"transaction_id": txnID.String(),
		"wallet_id":      walletID.String(),
		"balance_paise":  balance,
	})
}

type walletAdjustRequest struct {
	StudentID  string `json:"student_id"`
	DeltaPaise int64  `json:"delta_paise"`
	Note       string `json:"note"`
}

// walletAdjust is POST /fees/wallet/adjustments: a signed correction with a
// reason. Corrections are new rows, never edits — the ledger stays a history.
func (s *Server) walletAdjust(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req walletAdjustRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	studentID, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.DeltaPaise == 0 {
		httpx.BadRequest(w, r, "delta_paise must not be zero")
		return
	}
	// An adjustment with no reason is an unexplained change to somebody's
	// money, which is the one thing an auditor will ask about.
	if strings.TrimSpace(req.Note) == "" {
		httpx.BadRequest(w, r, "note is required: say why the balance is being adjusted")
		return
	}

	var (
		txnID    uuid.UUID
		walletID uuid.UUID
		balance  int64
	)
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var instID uuid.UUID
		var campusID *uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id, campus_id FROM students WHERE id = $1`,
			studentID).Scan(&instID, &campusID); err != nil {
			return err
		}
		if err := s.requireOpenPeriod(r.Context(), tx, instID, "month", time.Now()); err != nil {
			return err
		}
		wid, _, err := openWallet(r, tx, instID, campusID, studentID)
		if err != nil {
			return err
		}
		walletID = wid
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO wallet_transactions
			       (institution_id, campus_id, wallet_id, student_id, kind, delta_paise,
			        source_mode, note, created_by)
			VALUES ($1, $2, $3, $4, 'adjustment', $5, 'adjustment', $6, $7)
			RETURNING id`,
			instID, campusID, walletID, studentID, req.DeltaPaise,
			strings.TrimSpace(req.Note), id.UserID).
			Scan(&txnID); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(),
			`SELECT balance_paise FROM wallet_accounts WHERE id = $1`, walletID).Scan(&balance)
	})
	if walletFailed(w, r, err) {
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"transaction_id": txnID.String(),
		"wallet_id":      walletID.String(),
		"balance_paise":  balance,
	})
}

// openWallet returns the student's wallet, creating it on first use. One row
// per student is enforced by UNIQUE (institution_id, student_id), so a race
// between two first top-ups resolves to the same wallet rather than two.
func openWallet(r *http.Request, tx pgx.Tx, instID uuid.UUID, campusID *uuid.UUID,
	studentID uuid.UUID) (uuid.UUID, string, error) {
	var (
		id     uuid.UUID
		status string
	)
	err := tx.QueryRow(r.Context(), `
		INSERT INTO wallet_accounts (institution_id, campus_id, student_id)
		VALUES ($1, $2, $3)
		ON CONFLICT (institution_id, student_id)
		DO UPDATE SET updated_at = now()
		RETURNING id, status`, instID, campusID, studentID).Scan(&id, &status)
	return id, status, err
}

type walletInputError struct{ msg string }

func (e walletInputError) Error() string { return e.msg }

/*
SPENDING THE WALLET — shared by the counter and the fee desk.

	A spend is written inside the caller's transaction, beside the sale or the
	payment it pays for, and the ledger row points back at it (pos_sale_id or
	payment_id). One event, two rows, linked: neither the till nor the ledger
	counts it twice, and a sale that fails after the debit rolls the debit back.

	The account row is locked FOR UPDATE first, so two tills cannot both spend
	the same balance; the check here gives the clerk a sentence with the numbers
	in it, and the trigger's refusal to go negative is the backstop if anything
	slips past. walletSpendError is the family of refusals a spend can meet —
	no wallet, a frozen one, not enough in it — for callers to map onto their
	own 400 type (refusal at the counter, feeInputError at the fee desk).
*/
type walletSpendError struct{ msg string }

func (e walletSpendError) Error() string { return e.msg }

func walletDebit(ctx context.Context, tx pgx.Tx, instID uuid.UUID, campusID *uuid.UUID,
	studentID uuid.UUID, amount int64, reference, note string, by uuid.UUID,
	paymentID, posSaleID *uuid.UUID) (int64, error) {
	var (
		walletID uuid.UUID
		status   string
		balance  int64
	)
	err := tx.QueryRow(ctx, `
		SELECT id, status, balance_paise FROM wallet_accounts
		 WHERE student_id = $1 FOR UPDATE`, studentID).Scan(&walletID, &status, &balance)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, walletSpendError{"this child has no wallet yet -- top it up at the fee office first, or take another mode"}
	}
	if err != nil {
		return 0, err
	}
	if status != "active" {
		return 0, walletSpendError{"this wallet is " + status + " and cannot be spent from"}
	}
	if balance < amount {
		return 0, walletSpendError{fmt.Sprintf("not enough in the wallet: %s left, %s needed",
			indianRupees(balance), indianRupees(amount))}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO wallet_transactions
		       (institution_id, campus_id, wallet_id, student_id, kind, delta_paise,
		        source_mode, reference_no, payment_id, pos_sale_id, note, created_by)
		VALUES ($1, $2, $3, $4, 'spend', $5, 'wallet', NULLIF($6, ''), $7, $8, NULLIF($9, ''), $10)`,
		instID, campusID, walletID, studentID, -amount, reference, paymentID, posSaleID, note, by); err != nil {
		if strings.Contains(err.Error(), "cannot go negative") {
			return 0, walletSpendError{"not enough in the wallet"}
		}
		return 0, err
	}
	return balance - amount, nil
}

// walletCredit puts money back — the refund of a wallet-paid sale. Only into
// an active wallet: a frozen or closed one is refunded in cash at the counter,
// which is what actually happens, and the caller says so.
func walletCredit(ctx context.Context, tx pgx.Tx, instID uuid.UUID, campusID *uuid.UUID,
	studentID uuid.UUID, amount int64, reference, note string, by uuid.UUID,
	posSaleID *uuid.UUID) (int64, error) {
	var (
		walletID uuid.UUID
		status   string
		balance  int64
	)
	err := tx.QueryRow(ctx, `
		SELECT id, status, balance_paise FROM wallet_accounts
		 WHERE student_id = $1 FOR UPDATE`, studentID).Scan(&walletID, &status, &balance)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, walletSpendError{"this child's wallet no longer exists -- refund in cash"}
	}
	if err != nil {
		return 0, err
	}
	if status != "active" {
		return 0, walletSpendError{"this wallet is " + status + " -- refund in cash rather than crediting it"}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO wallet_transactions
		       (institution_id, campus_id, wallet_id, student_id, kind, delta_paise,
		        source_mode, reference_no, pos_sale_id, note, created_by)
		VALUES ($1, $2, $3, $4, 'refund', $5, 'wallet', NULLIF($6, ''), $7, NULLIF($8, ''), $9)`,
		instID, campusID, walletID, studentID, amount, reference, posSaleID, note, by); err != nil {
		return 0, err
	}
	return balance + amount, nil
}

// walletFailed maps the ways a wallet write can go wrong onto responses, and
// reports whether it wrote one. The trigger's refusal to overdraw arrives as a
// database error whose message names the rule; it is the caller's mistake,
// not the server's, so it is a 400 and not a 500.
func walletFailed(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	var ie walletInputError
	if errors.As(err, &ie) {
		httpx.BadRequest(w, r, ie.msg)
		return true
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return true
	}
	if strings.Contains(err.Error(), "cannot go negative") {
		httpx.BadRequest(w, r, "insufficient wallet balance for this adjustment")
		return true
	}
	if periodClosed(w, r, err) {
		return true
	}
	httpx.Internal(w, r, err)
	return true
}
