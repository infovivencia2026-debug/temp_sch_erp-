package api

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* THE PETTY-CASH FLOAT — the half of an imprest system the tin never had.

   Petty cash has always been a voucher register: a slip is raised, someone
   approves it, Dr expense / Cr petty cash lands in the books. What was missing
   was the float itself. There was no float amount, no way to put money INTO
   the tin except a hand-posted journal, and no drawer count — so "in the tin"
   started at zero and went negative as slips were approved, and the screen
   asked the clerk to "count the drawer and see if it agrees" with nowhere to
   write the count down.

   Three handlers, all on the existing petty-cash control account:

     topUpPettyCash  — replenishment. Money moves from the bank or the main
                       cash account into the tin, posted through the same
                       postVoucher as everything else, with its own source_kind
                       so a retried top-up cannot post twice.
     countPettyCash  — the drawer counted against the book. The book figure is
                       frozen on the row so the variance stays true after later
                       postings, and a variance needs a reason.
     setPettyCashFloat — how much the tin is meant to hold, and who holds it.
                       "Replenish to float" on the screen is float minus book.

   Gated on the same permission as raising and approving a slip. */

type pettyTopUpRequest struct {
	AmountPaise int64  `json:"amount_paise"`
	From        string `json:"from"` // "bank" or "cash"
	ReferenceNo string `json:"reference_no,omitempty"`
	Note        string `json:"note,omitempty"`
	TopupDate   string `json:"topup_date,omitempty"`
}

func (s *Server) topUpPettyCash(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req pettyTopUpRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.AmountPaise <= 0 {
		httpx.BadRequest(w, r, "amount_paise must be greater than zero")
		return
	}
	from := strings.ToLower(strings.TrimSpace(req.From))
	if from != "bank" && from != "cash" {
		httpx.BadRequest(w, r, "from must be 'bank' or 'cash'")
		return
	}
	// A bank withdrawal with no reference cannot be matched to the statement.
	if from == "bank" && strings.TrimSpace(req.ReferenceNo) == "" {
		httpx.BadRequest(w, r, "reference_no (cheque or withdrawal reference) is required for a bank top-up")
		return
	}
	date, err := parseDate(req.TopupDate, time.Now())
	if err != nil {
		httpx.BadRequest(w, r, "topup_date must be YYYY-MM-DD")
		return
	}

	var topupID uuid.UUID
	var journalNo string
	var balance int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		c, err := loadControls(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		source, sourceName := c.Bank, "bank"
		if from == "cash" {
			source, sourceName = c.Cash, "cash"
		}
		if err := c.require(c.PettyCash, "petty cash", source, sourceName); err != nil {
			return err
		}
		if err := s.requireOpenPeriod(r.Context(), tx, id.InstitutionID, "month", date); err != nil {
			return err
		}

		if err := tx.QueryRow(r.Context(), `
			INSERT INTO petty_cash_topups
			       (institution_id, topup_date, amount_paise, from_account_id,
			        reference_no, note, created_by)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7)
			RETURNING id`,
			id.InstitutionID, date, req.AmountPaise, source,
			strings.TrimSpace(req.ReferenceNo), strings.TrimSpace(req.Note),
			nullUUIDArg(id.UserID)).Scan(&topupID); err != nil {
			return err
		}

		narration := fmt.Sprintf("Petty cash top-up from %s", sourceName)
		if ref := strings.TrimSpace(req.ReferenceNo); ref != "" {
			narration += " (" + ref + ")"
		}
		entryID, no, err := postVoucher(r.Context(), tx, id.InstitutionID, id.UserID,
			"payment", "PV", date, narration,
			"petty_cash_topup", &topupID,
			[]voucherLine{
				{AccountID: c.PettyCash, Debit: req.AmountPaise, Memo: "Float replenished"},
				{AccountID: source, Credit: req.AmountPaise},
			})
		if err != nil {
			return err
		}
		journalNo = no
		if _, err := tx.Exec(r.Context(),
			`UPDATE petty_cash_topups SET journal_entry_id = $2 WHERE id = $1`,
			topupID, entryID); err != nil {
			return err
		}
		return tx.QueryRow(r.Context(), `
			SELECT COALESCE(sum(l.debit_paise) - sum(l.credit_paise), 0)
			  FROM journal_lines l WHERE l.account_id = $1`, c.PettyCash).Scan(&balance)
	})
	if err != nil {
		if periodClosed(w, r, err) {
			return
		}
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": topupID.String(), "journal_voucher_no": journalNo,
		"balance_paise": balance,
	})
}

type pettyCountRequest struct {
	CountedPaise   int64  `json:"counted_paise"`
	VarianceReason string `json:"variance_reason,omitempty"`
	CountedOn      string `json:"counted_on,omitempty"`
}

func (s *Server) countPettyCash(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req pettyCountRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.CountedPaise < 0 {
		httpx.BadRequest(w, r, "counted_paise cannot be negative")
		return
	}
	on, err := parseDate(req.CountedOn, time.Now())
	if err != nil {
		httpx.BadRequest(w, r, "counted_on must be YYYY-MM-DD")
		return
	}

	var countID uuid.UUID
	var book, variance int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		c, err := loadControls(r.Context(), tx, id.InstitutionID)
		if err != nil {
			return err
		}
		if err := c.require(c.PettyCash, "petty cash"); err != nil {
			return err
		}
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(sum(l.debit_paise) - sum(l.credit_paise), 0)
			  FROM journal_lines l WHERE l.account_id = $1`, c.PettyCash).Scan(&book); err != nil {
			return err
		}
		// The reason is checked here as well as by the constraint, so the
		// clerk reads a sentence rather than a constraint name.
		if req.CountedPaise != book && strings.TrimSpace(req.VarianceReason) == "" {
			return refusef("the drawer holds %s and the book says %s -- say why they differ",
				indianRupees(req.CountedPaise), indianRupees(book))
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO petty_cash_counts
			       (institution_id, counted_on, book_paise, counted_paise, variance_reason, counted_by)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6)
			RETURNING id, variance_paise`,
			id.InstitutionID, on, book, req.CountedPaise,
			strings.TrimSpace(req.VarianceReason), nullUUIDArg(id.UserID)).Scan(&countID, &variance)
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": countID.String(), "book_paise": book,
		"counted_paise": req.CountedPaise, "variance_paise": variance,
	})
}

type pettyFloatRequest struct {
	FloatPaise  int64  `json:"float_paise"`
	CustodianID string `json:"custodian_id,omitempty"`
}

func (s *Server) setPettyCashFloat(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req pettyFloatRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.FloatPaise < 0 {
		httpx.BadRequest(w, r, "float_paise cannot be negative")
		return
	}
	var custodian any
	if strings.TrimSpace(req.CustodianID) != "" {
		u, err := uuid.Parse(req.CustodianID)
		if err != nil {
			httpx.BadRequest(w, r, "custodian_id must be a uuid")
			return
		}
		custodian = u
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE ledger_settings
			   SET petty_cash_float_paise = $2, petty_cash_custodian_id = $3
			 WHERE institution_id = $1`, id.InstitutionID, req.FloatPaise, custodian)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return refusal("the ledger is not set up yet: open the chart of accounts screen first")
		}
		return nil
	})
	if err != nil {
		ledgerFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"float_paise": req.FloatPaise})
}
