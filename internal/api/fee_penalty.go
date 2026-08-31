package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* A penalty somebody decided on, rather than one a rule worked out.

   The fine engine handles the ordinary case: a rule says what a late payment
   costs and after how long, and it applies itself. What it cannot do is the
   afternoon a school decides this family owes ₹250 for a specific reason — a
   cheque that bounced twice, a term paid three months late by arrangement, a
   fine the committee agreed. Until now the only way to record that was to
   raise a second invoice, which puts one term's money in two places and makes
   the family's ledger read as two debts.

   So: a charge on the invoice that already exists, with the reason written on
   it, and the family told.

   WHY fine_paise AND NOT ANOTHER LINE

   invoices.net_paise is generated as gross - discount + fine, so fine_paise is
   the column the schema already keeps for exactly this and the total looks
   after itself. A line in invoice_lines would be counted in gross_paise, which
   is what the fee structure charges — and a penalty is not part of what the
   school charges for teaching. The line is written too, so the family can see
   what the money is for; only the arithmetic lives in fine_paise.
*/

type invoicePenaltyRequest struct {
	// In rupees, as typed. A finance screen that asks for paise is a screen
	// where somebody eventually types 250 and levies two rupees fifty.
	Amount float64 `json:"amount"`
	// Why. Required, and shown to the family: a charge a parent cannot account
	// for is a charge they ring the school about.
	Reason string `json:"reason"`
}

func (s *Server) addInvoicePenalty(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	invoiceID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid invoice id")
		return
	}
	var req invoicePenaltyRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		httpx.BadRequest(w, r,
			"say what the penalty is for — the family sees this, and a charge "+
				"they cannot account for is a charge they ring the school about")
		return
	}
	if req.Amount <= 0 {
		httpx.BadRequest(w, r, "a penalty has to be more than nothing")
		return
	}
	/* A cap, because a typed figure is a typed figure.

	   Somebody entering 25000 meaning ₹250 is a mistake that reaches a parent
	   as a demand, and the school hears about it before finance does. */
	if req.Amount > 100000 {
		httpx.BadRequest(w, r,
			"that is over ₹1,00,000 — if it is right, raise it as its own invoice "+
				"so it is on the record as a charge rather than a late fee")
		return
	}
	paise := int64(req.Amount*100 + 0.5)

	var out map[string]any
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var student uuid.UUID
		var status string
		var netBefore int64
		if err := tx.QueryRow(r.Context(), `
			SELECT student_id, status, net_paise FROM invoices WHERE id = $1`,
			invoiceID).Scan(&student, &status, &netBefore); err != nil {
			return err
		}
		if status == "cancelled" {
			return errStr("this invoice has been cancelled")
		}

		/* The penalty needs a head to sit under, and every school has one for
		   fines or will accept the first one named "fine" or "penalty". Where
		   there is none, the line records the reason and points at whichever
		   head the invoice already uses — the arithmetic is in fine_paise
		   either way, so the total is right regardless. */
		var head *uuid.UUID
		_ = tx.QueryRow(r.Context(), `
			SELECT id FROM fee_heads
			 WHERE lower(name) LIKE '%fine%' OR lower(name) LIKE '%penalt%'
			 ORDER BY name LIMIT 1`).Scan(&head)
		if head == nil {
			_ = tx.QueryRow(r.Context(), `
				SELECT fee_head_id FROM invoice_lines WHERE invoice_id = $1 LIMIT 1`,
				invoiceID).Scan(&head)
		}
		if head != nil {
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO invoice_lines
				    (institution_id, invoice_id, fee_head_id, description, amount_paise)
				VALUES ($1,$2,$3,$4,0)`,
				id.InstitutionID, invoiceID, *head, "Penalty — "+reason); err != nil {
				return err
			}
		}

		var netAfter, paid int64
		if err := tx.QueryRow(r.Context(), `
			UPDATE invoices
			   SET fine_paise = fine_paise + $2,
			       -- A settled invoice with a penalty on it is owed again.
			       status = CASE WHEN paid_paise >= (gross_paise - discount_paise + fine_paise + $2)
			                     THEN status ELSE 'unpaid' END
			 WHERE id = $1
			 RETURNING net_paise, paid_paise`, invoiceID, paise).Scan(&netAfter, &paid); err != nil {
			return err
		}

		/* The family hears it from the school, not from the total.

		   A parent who opens the app and finds they owe more than yesterday,
		   with nothing saying why, telephones — and the person who answers has
		   to reconstruct it. The alert carries the amount and the reason. */
		people, err := tx.Query(r.Context(), `
			SELECT g.user_id FROM student_guardians sg
			  JOIN guardians g ON g.id = sg.guardian_id
			 WHERE sg.student_id = $1 AND g.user_id IS NOT NULL
			UNION
			SELECT st.user_id FROM students st
			 WHERE st.id = $1 AND st.user_id IS NOT NULL`, student)
		if err != nil {
			return err
		}
		var to []uuid.UUID
		for people.Next() {
			var u uuid.UUID
			if err := people.Scan(&u); err != nil {
				people.Close()
				return err
			}
			to = append(to, u)
		}
		people.Close()
		if err := people.Err(); err != nil {
			return err
		}
		amount := "₹" + strconv.FormatFloat(float64(paise)/100, 'f', 2, 64)
		for _, u := range to {
			st := student
			if err := notify(r, tx, id.InstitutionID, u, &st, "fee_penalty",
				amount+" added to a fee bill", reason+". The bill now shows the new total.",
				"/go/fees_payments", "invoice", &invoiceID); err != nil {
				return err
			}
		}

		out = map[string]any{
			"fine_added_paise": paise,
			"net_paise":        netAfter,
			"due_paise":        netAfter - paid,
			"told":             len(to),
		}
		return nil
	})
	if err != nil {
		if strings.Contains(err.Error(), "cancelled") {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
