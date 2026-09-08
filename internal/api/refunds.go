package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Refunds: request, decide, pay out.

   The table had the right shape from the first migration -- pending,
   approved, processed, rejected; requested_by, approved_by, processed_on --
   and no handler wrote it. The payout batch that consumes approved refunds
   was permanently empty and the dashboard's pending count always read nil.
   A child leaving in November with unused terms paid had no settlement path.

   The rungs follow concessions: a clerk raises on fees.write, the person
   accountable for the shortfall decides on refunds.write, and paying out is
   the same signature, because the money leaves on that word. */

func (s *Server) mountRefunds(r chi.Router) {
	r.With(httpx.RequirePermission(rbac.FeesWrite)).Post("/refunds", s.requestRefund)
	r.With(httpx.RequirePermission(rbac.RefundsWrite)).Post("/refunds/{id}/decide", s.decideRefund)
	r.With(httpx.RequirePermission(rbac.RefundsWrite)).Post("/refunds/{id}/process", s.processRefund)
}

type refundRequest struct {
	StudentID   string `json:"student_id"`
	AmountPaise int64  `json:"amount_paise"`
	Reason      string `json:"reason"`
	Mode        string `json:"mode,omitempty"`
	PaymentID   string `json:"payment_id,omitempty"`
}

var errRefundExceedsPaid = errors.New("refund exceeds what was paid")

// requestRefund raises a refund for somebody with refunds.write to decide.
//
// The one rule enforced here is the one a spreadsheet cannot: a family can
// only be refunded what it actually paid, less what has already been
// refunded or is waiting to be. Adjustments are not money received, so the
// year-turn carry does not inflate what may be given back.
func (s *Server) requestRefund(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req refundRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.AmountPaise <= 0 {
		httpx.BadRequest(w, r, "amount_paise must be positive")
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if req.Reason == "" {
		httpx.BadRequest(w, r, "say why the money is going back. It is what the family is told and what an auditor reads")
		return
	}
	var payment *uuid.UUID
	if strings.TrimSpace(req.PaymentID) != "" {
		p, err := uuid.Parse(req.PaymentID)
		if err != nil {
			httpx.BadRequest(w, r, "payment_id must be a uuid")
			return
		}
		payment = &p
	}

	var newID string
	var refundable int64
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE((SELECT sum(amount_paise) FROM payments
			                  WHERE student_id = $1 AND status = 'success' AND mode <> 'adjustment'), 0)
			     - COALESCE((SELECT sum(amount_paise) FROM refunds
			                  WHERE student_id = $1 AND status <> 'rejected'), 0)`,
			student).Scan(&refundable); err != nil {
			return err
		}
		if req.AmountPaise > refundable {
			return errRefundExceedsPaid
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO refunds (institution_id, student_id, payment_id, amount_paise, reason, mode,
			                     status, requested_by)
			VALUES ($1, $2, $3, $4, $5, NULLIF($6,''), 'pending', $7)
			RETURNING id::text`,
			id.InstitutionID, student, payment, req.AmountPaise, req.Reason,
			strings.TrimSpace(req.Mode), id.UserID).Scan(&newID)
	})
	if errors.Is(err, errRefundExceedsPaid) {
		httpx.Error(w, r, http.StatusConflict, "refund_exceeds_paid",
			"that is more than this family has paid and not already been refunded. At most "+
				"₹"+indianRupees(refundable/100)+" can go back")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": newID, "status": "pending"})
}

type refundDecision struct {
	Decision string `json:"decision"` // approved | rejected
	Note     string `json:"note,omitempty"`
}

// decideRefund is the signature. A refusal must say why, because it is the
// decision a parent rings the office about, and the person answering did
// not make it.
func (s *Server) decideRefund(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	refundID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "refund id must be a uuid")
		return
	}
	var req refundDecision
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Note = strings.TrimSpace(req.Note)
	if req.Decision != "approved" && req.Decision != "rejected" {
		httpx.BadRequest(w, r, "decision must be approved or rejected")
		return
	}
	if req.Decision == "rejected" && req.Note == "" {
		httpx.BadRequest(w, r, "a refusal needs a reason the family can be given")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE refunds
			   SET status = $2, approved_by = $3, approved_at = now(), decision_note = NULLIF($4,'')
			 WHERE id = $1 AND status = 'pending'`,
			refundID, req.Decision, id.UserID, req.Note)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return refusal("only a pending refund can be decided")
		}
		return nil
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": refundID.String(), "status": req.Decision})
}

type refundPayout struct {
	Mode        string `json:"mode"`
	ReferenceNo string `json:"reference_no,omitempty"`
	ProcessedOn string `json:"processed_on,omitempty"`
}

// processRefund records that the money left. Approved only: paying out a
// request nobody signed is the thing the two-step exists to prevent. The
// reference is what the family quotes when they say it never arrived.
func (s *Server) processRefund(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	refundID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "refund id must be a uuid")
		return
	}
	var req refundPayout
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Mode = strings.TrimSpace(strings.ToLower(req.Mode))
	if req.Mode == "" {
		httpx.BadRequest(w, r, "say how it was paid — cash, cheque, neft or upi")
		return
	}
	on := time.Now()
	if req.ProcessedOn != "" {
		if on, err = time.Parse(time.DateOnly, req.ProcessedOn); err != nil {
			httpx.BadRequest(w, r, "processed_on must be YYYY-MM-DD")
			return
		}
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ct, err := tx.Exec(r.Context(), `
			UPDATE refunds
			   SET status = 'processed', processed_on = $2, mode = $3,
			       reference_no = NULLIF($4,''), processed_by = $5
			 WHERE id = $1 AND status = 'approved'`,
			refundID, on, req.Mode, strings.TrimSpace(req.ReferenceNo), id.UserID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return refusal("only an approved refund can be paid out")
		}
		return nil
	})
	if err != nil {
		feeEngineFail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": refundID.String(), "status": "processed"})
}
