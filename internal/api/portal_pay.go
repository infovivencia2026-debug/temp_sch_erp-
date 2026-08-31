package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
)

/* Paying from the app, with no money moving.

   THIS IS A SIMULATION AND SAYS SO EVERYWHERE.

   There is no payment gateway in this product yet. Until there is, a school
   testing the family's side of the fee flow has nothing to press: the parent's
   screen can show a balance and cannot settle one, so the receipt, the ledger,
   the balance falling to zero and the notification that follows are all
   untested until the day a real gateway is wired in — which is the worst day
   to find a fault in them.

   So the button records the payment the way the fee counter does, through the
   same fees.Collect that allocates across invoices and issues the receipt, and
   marks it unmistakably:

     mode          "online"
     reference_no  "SIMULATED-<time>"
     remarks       says in words that no money was taken

   Nothing here pretends to be a gateway. When Razorpay is added it replaces
   this handler's middle — verify the signature, then call the same Collect —
   and everything downstream is already exercised.

   WHY IT IS STILL SAFE TO EXPOSE

   A parent can only pay against their own children (the scope check below),
   never more than is outstanding, and every row it writes is stamped
   SIMULATED. A school that finds these in its ledger can tell at a glance what
   they are, which is not true of a test payment recorded as cash.
*/

type portalPayRequest struct {
	// Blank means the whole outstanding balance, which is what the button on
	// the summary card sends; an instalment's own button names its invoice.
	InvoiceNo string `json:"invoice_no,omitempty"`
	// In rupees, as shown. Blank or zero means everything owed on that scope.
	Amount float64 `json:"amount,omitempty"`
}

func (s *Server) portalSimulatedPay(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}
	var req portalPayRequest
	if !httpx.Decode(w, r, &req) {
		return
	}

	var out map[string]any
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* What is actually owed, read now rather than trusted from the client.

		   A balance shown on a screen is a balance as it was when the page
		   loaded, and the office may have taken a cheque since. */
		var campus uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT campus_id FROM students WHERE id = $1`, student).Scan(&campus); err != nil {
			return err
		}

		var invoiceIDs []uuid.UUID
		var owed int64
		if no := strings.TrimSpace(req.InvoiceNo); no != "" {
			var iid uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				SELECT id, net_paise - paid_paise FROM invoices
				 WHERE student_id = $1 AND invoice_no = $2
				   AND status <> 'cancelled'`, student, no).Scan(&iid, &owed); err != nil {
				return err
			}
			invoiceIDs = []uuid.UUID{iid}
		} else {
			if err := tx.QueryRow(r.Context(), `
				SELECT COALESCE(sum(net_paise - paid_paise), 0) FROM invoices
				 WHERE student_id = $1 AND status NOT IN ('cancelled','paid')`,
				student).Scan(&owed); err != nil {
				return err
			}
		}
		if owed <= 0 {
			return errStr("there is nothing outstanding to pay")
		}

		amount := owed
		if req.Amount > 0 {
			amount = int64(req.Amount*100 + 0.5)
		}
		if amount > owed {
			// Overpayment is a real thing a school handles at the counter, with
			// a decision about what to do with the excess. It is not something
			// a simulated button should invent.
			return errStr("that is more than is outstanding")
		}

		now := time.Now().In(indiaTZ())
		receipt, err := fees.Collect(r.Context(), tx, fees.CollectRequest{
			InstitutionID: id.InstitutionID,
			CampusID:      campus,
			StudentID:     student,
			AmountPaise:   amount,
			Mode:          "online",
			PaidOn:        now,
			ReferenceNo:   "SIMULATED-" + now.Format("20060102-150405"),
			Remarks: "Simulated payment made from the family portal. " +
				"No money was taken; this exists so the fee flow can be tested " +
				"before a payment gateway is connected.",
			CollectedBy: id.UserID,
			InvoiceIDs:  invoiceIDs,
		})
		if err != nil {
			return err
		}

		/* The family is told, as they would be for a counter payment.

		   Same wording as the real receipt notification, so the day a gateway
		   replaces this nothing about the family's experience changes. */
		amountText := "₹" + strconv.FormatFloat(float64(amount)/100, 'f', 2, 64)
		st := student
		if err := notify(r, tx, id.InstitutionID, id.UserID, &st, "fee_receipt",
			amountText+" paid",
			"Receipt "+receipt.ReceiptNo+". This was a test payment — no money was taken.",
			"/go/fee_receipts", "receipt", &receipt.PaymentID); err != nil {
			return err
		}

		out = map[string]any{
			"receipt_no":   receipt.ReceiptNo,
			"amount_paise": amount,
			"simulated":    true,
		}
		return nil
	})
	if err != nil {
		if strings.Contains(err.Error(), "outstanding") {
			httpx.BadRequest(w, r, err.Error())
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
