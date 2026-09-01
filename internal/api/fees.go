package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Fee collection — the counter workflow.
   Search a student, see what they owe, take the money, hand over a receipt. */

type ledgerEntry struct {
	Date        string  `json:"date"`
	Kind        string  `json:"kind"` // invoice | payment | refund
	Reference   string  `json:"reference"`
	Description string  `json:"description"`
	DebitPaise  int64   `json:"debit_paise"`
	CreditPaise int64   `json:"credit_paise"`
	Status      string  `json:"status"`
	Mode        *string `json:"mode,omitempty"`
}

type studentLedger struct {
	StudentID    string        `json:"student_id"`
	AdmissionNo  string        `json:"admission_no"`
	FullName     string        `json:"full_name"`
	ClassName    *string       `json:"class_name,omitempty"`
	SectionName  *string       `json:"section_name,omitempty"`
	ChargedPaise int64         `json:"charged_paise"`
	PaidPaise    int64         `json:"paid_paise"`
	BalancePaise int64         `json:"balance_paise"`
	PendingPaise int64         `json:"pending_paise"` // held cheques, not yet cleared
	Concessions  []concession  `json:"concessions"`
	Dues         []dueRow      `json:"dues"`
	Entries      []ledgerEntry `json:"entries"`
}

type dueRow struct {
	InvoiceID    string  `json:"invoice_id"`
	InvoiceNo    string  `json:"invoice_no"`
	IssuedOn     string  `json:"issued_on"`
	DueOn        *string `json:"due_on,omitempty"`
	NetPaise     int64   `json:"net_paise"`
	PaidPaise    int64   `json:"paid_paise"`
	BalancePaise int64   `json:"balance_paise"`
	FinePaise    int64   `json:"fine_paise"`
	Status       string  `json:"status"`
	DaysOverdue  int     `json:"days_overdue"`
}

type concession struct {
	Kind        string  `json:"kind"`
	Percent     *string `json:"percent,omitempty"`
	AmountPaise *int64  `json:"amount_paise,omitempty"`
	Reason      *string `json:"reason,omitempty"`
	FeeHead     *string `json:"fee_head,omitempty"`
}

// getStudentLedger is the Student Ledger 360 view: every charge, payment,
// credit and refund in one chronological account, plus what is still owed.
func (s *Server) getStudentLedger(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	studentID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid student id")
		return
	}

	// A cashier holds students.read.all; a parent viewing their own child does
	// not. Both reach this endpoint, so narrow it the same way as everywhere.
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	scopePred, scopeArgs := res.StudentPredicate("st", 2)

	out := studentLedger{
		StudentID:   studentID.String(),
		Concessions: []concession{},
		Dues:        []dueRow{},
		Entries:     []ledgerEntry{},
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT st.admission_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       c.name, sec.name
			  FROM students st
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id FROM enrollments e
			       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
			  ) en ON true
			  LEFT JOIN classes  c   ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			 WHERE st.id = $1 AND `+scopePred,
			append([]any{studentID}, scopeArgs...)...).
			Scan(&out.AdmissionNo, &out.FullName, &out.ClassName, &out.SectionName); err != nil {
			return err
		}

		// Totals. Only cleared payments count as paid; held cheques are
		// reported separately so the cashier can see promised money without it
		// inflating collection.
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE((SELECT sum(net_paise) FROM invoices
			                  WHERE student_id = $1 AND status <> 'cancelled'), 0),
			       COALESCE((SELECT sum(amount_paise) FROM payments
			                  WHERE student_id = $1 AND status = 'success'), 0),
			       COALESCE((SELECT sum(amount_paise) FROM payments
			                  WHERE student_id = $1 AND status = 'pending'), 0)`,
			studentID).Scan(&out.ChargedPaise, &out.PaidPaise, &out.PendingPaise); err != nil {
			return err
		}
		out.BalancePaise = out.ChargedPaise - out.PaidPaise

		dues, err := fees.Outstanding(r.Context(), tx, studentID)
		if err != nil {
			return err
		}
		today := time.Now()
		for _, d := range dues {
			row := dueRow{
				InvoiceID: d.InvoiceID.String(), InvoiceNo: d.InvoiceNo,
				IssuedOn: d.IssuedOn.Format(time.DateOnly),
				NetPaise: d.NetPaise, PaidPaise: d.PaidPaise,
				BalancePaise: d.BalancePaise, FinePaise: d.FinePaise, Status: d.Status,
			}
			if d.DueOn != nil {
				s := d.DueOn.Format(time.DateOnly)
				row.DueOn = &s
				if today.After(*d.DueOn) {
					row.DaysOverdue = int(today.Sub(*d.DueOn).Hours() / 24)
				}
			}
			out.Dues = append(out.Dues, row)
		}

		if err := scanInto(r.Context(), tx, `
			SELECT fc.kind, fc.percent::text, fc.amount_paise, fc.reason, fh.name
			  FROM fee_concessions fc
			  LEFT JOIN fee_heads fh ON fh.id = fc.fee_head_id
			 WHERE fc.student_id = '`+studentID.String()+`'::uuid
			 ORDER BY fc.created_at DESC`,
			func(rows pgx.Rows) error {
				var c concession
				if err := rows.Scan(&c.Kind, &c.Percent, &c.AmountPaise, &c.Reason, &c.FeeHead); err != nil {
					return err
				}
				out.Concessions = append(out.Concessions, c)
				return nil
			}); err != nil {
			return err
		}

		// Chronological account: invoices are debits, payments credits,
		// refunds debits again. UNION ALL then order, so the parent sees one
		// running story rather than three lists.
		return scanInto(r.Context(), tx, `
			SELECT * FROM (
			  SELECT to_char(i.issued_on,'YYYY-MM-DD') AS d, 'invoice' AS kind,
			         i.invoice_no AS ref,
			         COALESCE(string_agg(DISTINCT fh.name, ', '), 'Fee invoice') AS descr,
			         i.net_paise AS debit, 0::bigint AS credit, i.status, NULL::text AS mode
			    FROM invoices i
			    LEFT JOIN invoice_lines il ON il.invoice_id = i.id
			    LEFT JOIN fee_heads fh ON fh.id = il.fee_head_id
			   WHERE i.student_id = '`+studentID.String()+`'::uuid
			   GROUP BY i.id
			  UNION ALL
			  SELECT to_char(p.paid_on,'YYYY-MM-DD'), 'payment',
			         COALESCE(p.receipt_no,'—'),
			         CASE WHEN p.status = 'pending' THEN 'Cheque held (post-dated)'
			              WHEN p.status = 'bounced' THEN 'Cheque dishonoured'
			              ELSE 'Payment received' END,
			         0::bigint, p.amount_paise, p.status, p.mode
			    FROM payments p
			   WHERE p.student_id = '`+studentID.String()+`'::uuid
			  UNION ALL
			  SELECT to_char(rf.created_at,'YYYY-MM-DD'), 'refund', 'REF',
			         rf.reason, rf.amount_paise, 0::bigint, rf.status, rf.mode
			    FROM refunds rf
			   WHERE rf.student_id = '`+studentID.String()+`'::uuid
			     AND rf.status IN ('approved', 'processed')
			) x ORDER BY d DESC, kind`,
			func(rows pgx.Rows) error {
				var e ledgerEntry
				if err := rows.Scan(&e.Date, &e.Kind, &e.Reference, &e.Description,
					&e.DebitPaise, &e.CreditPaise, &e.Status, &e.Mode); err != nil {
					return err
				}
				out.Entries = append(out.Entries, e)
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
	httpx.JSON(w, http.StatusOK, out)
}

type collectRequest struct {
	StudentID   string   `json:"student_id"`
	AmountPaise int64    `json:"amount_paise"`
	Mode        string   `json:"mode"`
	PaidOn      string   `json:"paid_on,omitempty"`
	ReferenceNo string   `json:"reference_no,omitempty"`
	BankName    string   `json:"bank_name,omitempty"`
	ChequeDate  string   `json:"cheque_date,omitempty"`
	Remarks     string   `json:"remarks,omitempty"`
	InvoiceIDs  []string `json:"invoice_ids,omitempty"`
}

var validModes = map[string]bool{
	"cash": true, "cheque": true, "dd": true, "neft": true,
	"upi": true, "card": true, "netbanking": true, "adjustment": true,
}

// collectFee is the counter transaction: take money, allocate it, issue a
// numbered receipt — all inside one transaction.
func (s *Server) collectFee(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req collectRequest
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
	if !validModes[req.Mode] {
		httpx.BadRequest(w, r, "unsupported payment mode: "+req.Mode)
		return
	}

	paidOn := time.Now()
	if req.PaidOn != "" {
		if paidOn, err = time.Parse(time.DateOnly, req.PaidOn); err != nil {
			httpx.BadRequest(w, r, "paid_on must be YYYY-MM-DD")
			return
		}
	}
	var chequeDate *time.Time
	if req.ChequeDate != "" {
		d, err := time.Parse(time.DateOnly, req.ChequeDate)
		if err != nil {
			httpx.BadRequest(w, r, "cheque_date must be YYYY-MM-DD")
			return
		}
		chequeDate = &d
	}
	if (req.Mode == "cheque" || req.Mode == "dd") && req.ReferenceNo == "" {
		httpx.BadRequest(w, r, "reference_no (instrument number) is required for cheque or DD")
		return
	}

	invoiceIDs := make([]uuid.UUID, 0, len(req.InvoiceIDs))
	for _, raw := range req.InvoiceIDs {
		v, err := uuid.Parse(raw)
		if err != nil {
			httpx.BadRequest(w, r, "invoice_ids must be uuids")
			return
		}
		invoiceIDs = append(invoiceIDs, v)
	}

	var receipt *fees.Receipt
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		// Institution and campus come from the student record, not the caller:
		// a platform operator has no institution of their own, and both columns
		// are NOT NULL.
		var instID, campusID uuid.UUID
		if err := tx.QueryRow(r.Context(),
			`SELECT institution_id, campus_id FROM students WHERE id = $1`,
			studentID).Scan(&instID, &campusID); err != nil {
			return err
		}

		receipt, err = fees.Collect(r.Context(), tx, fees.CollectRequest{
			InstitutionID: instID, CampusID: campusID, StudentID: studentID,
			AmountPaise: req.AmountPaise, Mode: req.Mode, PaidOn: paidOn,
			ReferenceNo: req.ReferenceNo, BankName: req.BankName,
			ChequeDate: chequeDate, Remarks: req.Remarks,
			CollectedBy: id.UserID, InvoiceIDs: invoiceIDs,
		})
		if err != nil {
			return err
		}

		/* And tell the family it arrived.

		   A receipt is the one thing a parent wants confirmation of, and this
		   recorded the payment in silence: the counter handed over a slip and
		   the app the family is told to use said nothing. A parent unsure
		   whether a cheque cleared rings the office, which is the call the
		   software was bought to stop.

		   The child as well as the guardians — a boarder or a sixth-former
		   often pays their own and is the one asking.

		   Inside the transaction, so a payment that rolls back cannot leave a
		   family told about money the ledger never took. */
		rows, qerr := tx.Query(r.Context(), `
			SELECT g.user_id FROM student_guardians sg
			  JOIN guardians g ON g.id = sg.guardian_id
			 WHERE sg.student_id = $1 AND g.user_id IS NOT NULL
			UNION
			SELECT st.user_id FROM students st
			 WHERE st.id = $1 AND st.user_id IS NOT NULL`, studentID)
		if qerr != nil {
			return qerr
		}
		var tell []uuid.UUID
		for rows.Next() {
			var u uuid.UUID
			if serr := rows.Scan(&u); serr != nil {
				rows.Close()
				return serr
			}
			tell = append(tell, u)
		}
		rows.Close()
		if rerr := rows.Err(); rerr != nil {
			return rerr
		}

		/* The exact figure, not the dashboard's abbreviation.

		   rupees() renders ₹1.20L, which is right on a tile summarising a
		   term's collection and wrong on a receipt: a parent checks the number
		   against what they handed over, and 1.20L is not a number anybody
		   handed over. */
		amount := "₹" + strconv.FormatFloat(float64(receipt.AmountPaise)/100, 'f', 2, 64)
		body := amount + " received, receipt " + receipt.ReceiptNo + "."
		if !receipt.Cleared {
			// A cheque is not money yet, and saying "received" alone would
			// have a family believe the fee is settled a week before it is.
			body = amount + " taken by " + req.Mode + ", receipt " +
				receipt.ReceiptNo + ". It counts once it clears."
		}
		for _, u := range tell {
			if nerr := notify(r, tx, instID, u, &studentID, "fee_receipt",
				"Fee received", body,
				"/go/fee_receipts", "payment", &receipt.PaymentID); nerr != nil {
				return nerr
			}
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if errors.Is(err, fees.ErrInvoiceNotFound) {
		httpx.BadRequest(w, r, "none of the selected invoices are outstanding for this student")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	allocs := make([]map[string]any, 0, len(receipt.Allocated))
	for _, a := range receipt.Allocated {
		allocs = append(allocs, map[string]any{
			"invoice_id": a.InvoiceID.String(), "invoice_no": a.InvoiceNo,
			"amount_paise": a.AmountPaise,
		})
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"payment_id":        receipt.PaymentID.String(),
		"receipt_no":        receipt.ReceiptNo,
		"amount_paise":      receipt.AmountPaise,
		"allocated":         allocs,
		"unallocated_paise": receipt.Unallocated,
		"cleared":           receipt.Cleared,
		"receipt_url":       "/api/v1/fees/receipts/" + receipt.PaymentID.String(),
	})
}

// getReceipt returns everything needed to print a receipt.
func (s *Server) getReceipt(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	paymentID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid payment id")
		return
	}

	out := map[string]any{}
	lines := []map[string]any{}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var (
			receiptNo, mode, status, studentName, admissionNo, instName string
			amount                                                      int64
			paidOn                                                      time.Time
			className, sectionName, reference, collectedBy              *string
		)
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(p.receipt_no,'—'), p.amount_paise, p.mode, p.status, p.paid_on,
			       p.reference_no,
			       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			       st.admission_no, i.name, c.name, sec.name, u.full_name
			  FROM payments p
			  JOIN students st     ON st.id = p.student_id
			  JOIN institutions i  ON i.id = p.institution_id
			  LEFT JOIN LATERAL (
			      SELECT e.class_id, e.section_id FROM enrollments e
			       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
			  ) en ON true
			  LEFT JOIN classes  c   ON c.id = en.class_id
			  LEFT JOIN sections sec ON sec.id = en.section_id
			  LEFT JOIN users u      ON u.id = p.collected_by
			 WHERE p.id = $1`, paymentID).
			Scan(&receiptNo, &amount, &mode, &status, &paidOn, &reference,
				&studentName, &admissionNo, &instName, &className, &sectionName, &collectedBy); err != nil {
			return err
		}

		out["receipt_no"] = receiptNo
		out["amount_paise"] = amount
		out["amount_words"] = fees.RupeesInWords(amount)
		out["mode"] = mode
		out["status"] = status
		out["paid_on"] = paidOn.Format(time.DateOnly)
		out["reference_no"] = reference
		out["student_name"] = studentName
		out["admission_no"] = admissionNo
		out["institution"] = instName
		out["class_name"] = className
		out["section_name"] = sectionName
		out["collected_by"] = collectedBy
		out["financial_year"] = fees.FinancialYear(paidOn)

		return scanInto(r.Context(), tx, `
			SELECT i.invoice_no, pa.amount_paise,
			       COALESCE(string_agg(DISTINCT fh.name, ', '), 'Fee')
			  FROM payment_allocations pa
			  JOIN invoices i ON i.id = pa.invoice_id
			  LEFT JOIN invoice_lines il ON il.invoice_id = i.id
			  LEFT JOIN fee_heads fh ON fh.id = il.fee_head_id
			 WHERE pa.payment_id = '`+paymentID.String()+`'::uuid
			 GROUP BY i.invoice_no, pa.amount_paise`,
			func(rows pgx.Rows) error {
				var invoiceNo, heads string
				var amt int64
				if err := rows.Scan(&invoiceNo, &amt, &heads); err != nil {
					return err
				}
				lines = append(lines, map[string]any{
					"invoice_no": invoiceNo, "amount_paise": amt, "particulars": heads,
				})
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
	out["lines"] = lines
	httpx.JSON(w, http.StatusOK, out)
}

type chequeActionRequest struct {
	FinePaise int64 `json:"fine_paise,omitempty"`
}

// clearCheque marks a held cheque as realised and allocates it.
func (s *Server) clearCheque(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	paymentID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid payment id")
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return fees.ClearCheque(r.Context(), tx, paymentID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": paymentID.String(), "status": "success"})
}

// bounceCheque records a dishonour, reopens the invoice and levies the penalty.
func (s *Server) bounceCheque(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	paymentID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid payment id")
		return
	}
	var req chequeActionRequest
	if r.ContentLength > 0 && !httpx.Decode(w, r, &req) {
		return
	}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		fine := req.FinePaise
		if fine <= 0 {
			/* The school's standing amount, where it has set one.

			   Typed at the counter, the figure drifts: two people remember it
			   differently and the second is not wrong, only later — so a
			   family that argues gets a different answer from one that does
			   not. Nothing is charged when the school has set nothing, which
			   is the behaviour before this. */
			var v *string
			_ = tx.QueryRow(r.Context(),
				`SELECT config->>'`+chequeBounceFineKey+`' FROM module_settings
				  WHERE module = 'finance'`).Scan(&v)
			if v != nil {
				if n, err := strconv.ParseInt(*v, 10, 64); err == nil {
					fine = n
				}
			}
		}
		return fees.BounceCheque(r.Context(), tx, paymentID, fine)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": paymentID.String(), "status": "bounced", "fine_paise": req.FinePaise,
	})
}

type pdcRow struct {
	PaymentID   string  `json:"payment_id"`
	ReceiptNo   *string `json:"receipt_no,omitempty"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	AmountPaise int64   `json:"amount_paise"`
	BankName    *string `json:"bank_name,omitempty"`
	Instrument  *string `json:"instrument_no,omitempty"`
	ChequeDate  *string `json:"cheque_date,omitempty"`
	DueToday    bool    `json:"due_today"`
}

// listPDC is the post-dated cheque register: money promised but not banked.
func (s *Server) listPDC(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT p.id::text, p.receipt_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.admission_no, p.amount_paise, p.bank_name, p.reference_no,
		       to_char(p.cheque_date,'YYYY-MM-DD'),
		       p.cheque_date IS NOT NULL AND p.cheque_date <= CURRENT_DATE
		  FROM payments p
		  JOIN students st ON st.id = p.student_id
		 WHERE p.status = 'pending' AND p.mode IN ('cheque','dd')
		 ORDER BY p.cheque_date NULLS LAST`, nil,
		func(rows pgx.Rows) (pdcRow, error) {
			var v pdcRow
			return v, rows.Scan(&v.PaymentID, &v.ReceiptNo, &v.StudentName, &v.AdmissionNo,
				&v.AmountPaise, &v.BankName, &v.Instrument, &v.ChequeDate, &v.DueToday)
		})
	respond(w, r, items, err)
}

type defaulterRow struct {
	StudentID    string  `json:"student_id"`
	AdmissionNo  string  `json:"admission_no"`
	FullName     string  `json:"full_name"`
	ClassName    *string `json:"class_name,omitempty"`
	SectionName  *string `json:"section_name,omitempty"`
	GuardianName *string `json:"guardian_name,omitempty"`
	Phone        *string `json:"phone,omitempty"`
	BalancePaise int64   `json:"balance_paise"`
	OldestDue    *string `json:"oldest_due,omitempty"`
	// When this family was last chased, so nobody sends a fourth reminder in a
	// week to the family who has been reading all of them.
	LastReminded *string `json:"last_reminded,omitempty"`
	DaysOverdue  int     `json:"days_overdue"`
	Bucket       string  `json:"bucket"`
}

// listDefaulters is the aging report: who owes what, bucketed 0-30/31-60/61-90/90+.
//
// The guardian's phone comes along because the only useful next action from
// this screen is to contact them.
func (s *Server) listDefaulters(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       c.name, sec.name, g.full_name, g.phone,
		       sum(i.net_paise - i.paid_paise),
		       to_char(min(i.due_on),'YYYY-MM-DD'),
		       /* When this child's family was last chased, on any channel.

		          Read from the column the send writes rather than from
		          notifications: a notification exists only for somebody with an
		          app account, and most families a school texts have none — so
		          this read "never" for every family it had just written to. */
		       to_char(st.last_fee_reminder_at, 'YYYY-MM-DD"T"HH24:MI'),
		       COALESCE(GREATEST(0, (CURRENT_DATE - min(i.due_on))), 0),
		       CASE
		         WHEN CURRENT_DATE - min(i.due_on) > 90 THEN '90+'
		         WHEN CURRENT_DATE - min(i.due_on) > 60 THEN '61-90'
		         WHEN CURRENT_DATE - min(i.due_on) > 30 THEN '31-60'
		         ELSE '0-30'
		       END
		  FROM invoices i
		  JOIN students st ON st.id = i.student_id
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  c   ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		  LEFT JOIN LATERAL (
		      SELECT gg.full_name, gg.phone FROM student_guardians sg
		        JOIN guardians gg ON gg.id = sg.guardian_id
		       WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC LIMIT 1
		  ) g ON true
		 WHERE i.status IN ('unpaid','partial','overdue')
		   /* ?all=1 widens this to everybody who owes anything.

		      The screen is an ageing report, so it has always been invoices
		      PAST their due date — which is right for "who is late" and wrong
		      for "who do I chase". A school sending the September reminder
		      wants the family whose instalment falls due next week as much as
		      the one already a fortnight over, and that family was invisible
		      here: two names on a screen while eleven owed money. */
		   AND ($1::boolean OR (i.due_on IS NOT NULL AND i.due_on < CURRENT_DATE))
		 GROUP BY st.id, c.name, sec.name, g.full_name, g.phone
		 HAVING sum(i.net_paise - i.paid_paise) > 0
		 -- Named, not numbered: a positional ORDER BY silently means a
		 -- different column the moment somebody adds one to the SELECT, and
		 -- adding last_reminded above did exactly that.
		 ORDER BY sum(i.net_paise - i.paid_paise) DESC
		 LIMIT 500`, []any{r.URL.Query().Get("all") == "1"},
		func(rows pgx.Rows) (defaulterRow, error) {
			var v defaulterRow
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.FullName, &v.ClassName,
				&v.SectionName, &v.GuardianName, &v.Phone, &v.BalancePaise,
				&v.OldestDue, &v.LastReminded, &v.DaysOverdue, &v.Bucket)
		})
	respond(w, r, items, err)
}

type generateInvoicesRequest struct {
	FeeStructureID string `json:"fee_structure_id"`
	InstalmentNo   int    `json:"instalment_no"`
	DueOn          string `json:"due_on"`
	/* ONE CHILD, when that is what is wanted.

	   The run was class-wide only, which is right in June and wrong every
	   other month of the year. A child admitted in November, or one whose
	   concession has only just been approved, needs their own bill — and
	   raising the whole class again to get it does nothing, because everybody
	   else is skipped as already invoiced, so it looks like a button that
	   failed.

	   Everything else is unchanged: the same structure, the same lines, the
	   same concession arithmetic, the same guard against billing twice. This
	   only narrows who is considered. */
	StudentID string `json:"student_id,omitempty"`
	/* ALL THE TERMS IN ONE BILL.

	   A family that pays the whole year up front is common and worth having:
	   no chasing, no reminders, no late fine to argue about in February.
	   Raising instalment 1 and telling them to pay three times is exactly what
	   they were trying to avoid, and raising all three separately leaves them
	   three invoices to pay one at a time.

	   One invoice carrying every instalment's lines. The concession applies
	   the same way, per head, so a full-payment discount comes off the whole
	   year rather than off a third of it. */
	AllInstalments bool `json:"all_instalments,omitempty"`
}

// generateInvoices raises one invoice per enrolled student from a fee
// structure, applying each student's concessions.
//
// Runs inline rather than on the queue: a term run for one class is a few
// hundred rows and the cashier is waiting to see the count. A whole-school run
// across every class belongs on the bulk queue via /api/v1/jobs.
// A draft fee structure must not bill anybody: the gate was drawn on the screen,
// read by the person using it, and enforced nowhere.
var errNoSuchInstalment = errors.New("no lines under that instalment")

// errStructureWorthNothing refuses a structure whose heads are all zero, which
// would otherwise raise a bill for nought that reads as "nothing due".
var errStructureWorthNothing = errors.New("that fee structure prices nothing")

var errNoLiveFeeVersion = errors.New("no live fee structure version")

func (s *Server) generateInvoices(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req generateInvoicesRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	/* THE SPLIT THE ROUTE CANNOT MAKE.

	   Raising one child's bill is part of admitting them, and the admissions
	   desk already causes an invoice when it accepts an application — so being
	   refused for the same act on the child's own record was the product
	   contradicting itself.

	   A whole class is a different thing: it is the term's billing run, it
	   moves every family's money at once, and it belongs to accounts. The
	   route lets both roles in; the difference is enforced here, where the
	   request can actually be read. */
	if strings.TrimSpace(req.StudentID) == "" &&
		!httpx.IdentityFrom(r.Context()).Can(rbac.InvoicesWrite) {
		httpx.Forbidden(w, r,
			"raising a whole class's demand needs the invoices permission. One "+
				"child's fee can be raised from their own record")
		return
	}
	structureID, err := uuid.Parse(req.FeeStructureID)
	if err != nil {
		httpx.BadRequest(w, r, "fee_structure_id must be a uuid")
		return
	}
	if req.InstalmentNo <= 0 {
		req.InstalmentNo = 1
	}
	dueOn := time.Now().AddDate(0, 0, 14)
	if req.DueOn != "" {
		if dueOn, err = time.Parse(time.DateOnly, req.DueOn); err != nil {
			httpx.BadRequest(w, r, "due_on must be YYYY-MM-DD")
			return
		}
	}

	created, skipped := 0, 0
	pendingConcessions := 0
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var instID, campusID, yearID uuid.UUID
		var classID *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT institution_id, campus_id, academic_year_id, class_id
			  FROM fee_structures WHERE id = $1 AND is_active`, structureID).
			Scan(&instID, &campusID, &yearID, &classID); err != nil {
			return err
		}

		/* A draft must not bill anybody.

		   The structure's own is_active flag was checked and the version's
		   status was not, so a structure showing "No live version" on its own
		   screen could still raise sixty invoices. That is the worst kind of
		   gate: it is drawn, it is read, and it does nothing. A parent who
		   receives a demand built from a draft has been asked for a figure the
		   school had not agreed, and the school finds out when they pay it.

		   Only enforced where versioning is in use. A school that has never
		   opened that screen has no version rows at all, and refusing to bill
		   them would break every school that bills the simple way. */
		var versions, live int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int,
			       count(*) FILTER (
			         WHERE status = 'active'
			           AND effective_from <= CURRENT_DATE
			           AND (effective_to IS NULL OR effective_to >= CURRENT_DATE))::int
			  FROM fee_structure_versions WHERE fee_structure_id = $1`,
			structureID).Scan(&versions, &live); err != nil {
			return err
		}
		if versions > 0 && live == 0 {
			return errNoLiveFeeVersion
		}

		/* An instalment the structure does not have.

		   Most schools price the year in one instalment and collect it in one
		   go; some split it into three. Nothing stopped a clerk asking for
		   instalment 2 of a structure whose lines are all instalment 1 — and
		   because the lines are copied by instalment number, every child got
		   an invoice with no lines on it. Sixty demands for zero rupees,
		   numbered, dated, and indistinguishable from real ones in the ledger,
		   with the school's own invoice sequence spent on them.

		   The clerk's mistake is a typo in one field. The remedy is to say so
		   before anything is written, not to hand back "created: 60". */
		var lines int
		if err := tx.QueryRow(r.Context(), `
			SELECT count(*)::int FROM fee_structure_items
			 WHERE fee_structure_id = $1 AND instalment_no = $2`,
			structureID, req.InstalmentNo).Scan(&lines); err != nil {
			return err
		}
		/* A STRUCTURE WORTH NOTHING RAISES NOTHING, and says so.

		   A structure whose heads are all zero is a stub somebody began and
		   abandoned. Billing from it created an invoice for nought, which the
		   child's record then reported as "nothing due" — a silent failure
		   that looks exactly like a family who owes nothing, and is only found
		   when somebody asks why a fee never appeared.

		   Refused with the reason. Creating the zero invoice and warning
		   afterwards would leave the row behind, and the guard against billing
		   twice would then skip the child on the retry. */
		var worth int64
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(sum(amount_paise), 0) FROM fee_structure_items
			 WHERE fee_structure_id = $1 AND instalment_no = $2`,
			structureID, req.InstalmentNo).Scan(&worth); err != nil {
			return err
		}
		if lines > 0 && worth == 0 {
			return errStructureWorthNothing
		}
		/* Paying the year at once bills every instalment, so the count and the
		   value are the whole structure rather than one term of it. */
		if req.AllInstalments {
			if err := tx.QueryRow(r.Context(), `
				SELECT count(*)::int, COALESCE(sum(amount_paise), 0)
				  FROM fee_structure_items WHERE fee_structure_id = $1`,
				structureID).Scan(&lines, &worth); err != nil {
				return err
			}
			if lines == 0 || worth == 0 {
				return errStructureWorthNothing
			}
		}
		if lines == 0 {
			return errNoSuchInstalment
		}

		/* CONCESSIONS STILL WAITING ON A DECISION.

		   The engine applies a concession when it builds the lines, and reads
		   only approved ones — correctly, since an unapproved waiver is a
		   request and not a discount. The consequence is an ordering rule
		   nobody was told: approve after the demand is raised and the invoice
		   already sent keeps the full amount.

		   That is the wrong way round to discover. A family agrees a staff-ward
		   rate at admission, the accountant raises the term's demand the same
		   afternoon, and the bill goes out at full price while the concession
		   sits approved and inert. Counted here and returned so the screen can
		   say so BEFORE the invoices exist. */
		if err := tx.QueryRow(r.Context(), `
			SELECT count(DISTINCT fc.student_id)::int
			  FROM fee_concessions fc
			  JOIN enrollments e ON e.student_id = fc.student_id
			 WHERE fc.status = 'pending'
			   AND e.academic_year_id = $1
			   AND e.status = 'active'
			   AND ($2::uuid IS NULL OR e.class_id = $2)`,
			yearID, classID).Scan(&pendingConcessions); err != nil {
			return err
		}

		// Students enrolled in this year, optionally limited to the structure's
		// class. Skipping those already invoiced for this instalment makes the
		// whole operation safe to re-run after a partial failure.
		/* The most specific structure wins.

		   A school charges Grade 8 more than Grade 6, so it writes a Grade 8
		   structure and keeps a general one for the rest. Billing from the
		   general one then billed Grade 8 as well — every child got the
		   all-classes figure, and the Grade 8 structure sat there looking
		   authoritative while charging nobody. Worse, running both left Grade 8
		   families with two demands for the same instalment.

		   So a general structure skips any class that has one of its own, and a
		   class structure bills only its class. Nobody has to remember the
		   order to run them in, which is the kind of rule a school discovers it
		   got wrong when a parent brings in two bills. */
		rows, err := tx.Query(r.Context(), `
			SELECT e.student_id
			  FROM enrollments e
			 WHERE e.academic_year_id = $1
			   AND e.status = 'active'
			   AND ($4::uuid IS NULL OR e.student_id = $4)
			   AND ($2::uuid IS NULL OR e.class_id = $2)
			   AND ($2::uuid IS NOT NULL OR NOT EXISTS (
			       SELECT 1 FROM fee_structures fs
			        WHERE fs.class_id = e.class_id
			          AND fs.is_active
			          AND fs.academic_year_id = e.academic_year_id))
			   /* A CANCELLED INVOICE IS NOT A BILL, so it must not block the
			      one that replaces it.
			
			      The guard against billing twice looked for any invoice at
			      this instalment whatever its state, so cancelling a wrong
			      one — the whole remedy for a bill raised in error — left the
			      child permanently unbillable: the raise reported "skipped"
			      for ever and nobody could see why. Cancelling is the ONLY
			      way to undo a bad invoice, and it must therefore also be the
			      way to get a good one. */
			   AND NOT EXISTS (
			       SELECT 1 FROM invoices i
			        WHERE i.student_id = e.student_id
			          AND i.academic_year_id = $1
			          AND i.instalment_no = $3
			          AND i.status <> 'cancelled')`,
			yearID, classID, req.InstalmentNo, nullString(req.StudentID))
		if err != nil {
			return err
		}
		var students []uuid.UUID
		for rows.Next() {
			var sid uuid.UUID
			if err := rows.Scan(&sid); err != nil {
				rows.Close()
				return err
			}
			students = append(students, sid)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		for _, sid := range students {
			invoiceNo, err := fees.NextNumber(r.Context(), tx, instID, "invoice")
			if err != nil {
				return err
			}

			var invoiceID uuid.UUID
			if err := tx.QueryRow(r.Context(), `
				INSERT INTO invoices (institution_id, campus_id, student_id, academic_year_id,
				                      invoice_no, instalment_no, issued_on, due_on,
				                      gross_paise, discount_paise, status)
				VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,0,0,'unpaid')
				RETURNING id`,
				instID, campusID, sid, yearID, invoiceNo, req.InstalmentNo, dueOn).Scan(&invoiceID); err != nil {
				return fmt.Errorf("create invoice for %s: %w", sid, err)
			}

			// Lines from the structure, with the student's concession applied
			// per head. A percentage concession is computed on that head's
			// amount, which is why the discount lives on the line and not on
			// the invoice header.
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id,
				                           description, amount_paise, discount_paise)
				SELECT $1, $2, fsi.fee_head_id, fh.name, fsi.amount_paise,
				       LEAST(
				         fsi.amount_paise,
				         COALESCE((
				           SELECT COALESCE(max(fc.amount_paise),
				                           max(round(fsi.amount_paise * fc.percent / 100.0))::bigint)
				             FROM fee_concessions fc
				            WHERE fc.student_id = $3
				              AND fc.academic_year_id = $4
				              AND fc.approved_at IS NOT NULL
				              AND (fc.fee_head_id IS NULL OR fc.fee_head_id = fsi.fee_head_id)
				         ), 0)
				       )
				  FROM fee_structure_items fsi
				  JOIN fee_heads fh ON fh.id = fsi.fee_head_id
				 WHERE fsi.fee_structure_id = $5
			   AND ($7::bool OR fsi.instalment_no = $6)`,
				instID, invoiceID, sid, yearID, structureID, req.InstalmentNo,
				req.AllInstalments); err != nil {
				return fmt.Errorf("create invoice lines: %w", err)
			}

			// Roll the lines up into the header. net_paise is generated from
			// gross/discount/fine, so only the inputs are written.
			if _, err := tx.Exec(r.Context(), `
				UPDATE invoices SET
				    gross_paise    = COALESCE((SELECT sum(amount_paise)   FROM invoice_lines WHERE invoice_id = $1), 0),
				    discount_paise = COALESCE((SELECT sum(discount_paise) FROM invoice_lines WHERE invoice_id = $1), 0)
				 WHERE id = $1`, invoiceID); err != nil {
				return err
			}
			created++
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.BadRequest(w, r, "no active fee structure with that id")
		return
	}
	if errors.Is(err, errStructureWorthNothing) {
		httpx.BadRequest(w, r,
			"every head in that structure is priced at nought, so raising it "+
				"would bill the family nothing. Price the heads under Fees → "+
				"Class & transport fee setup, or pick the structure that does")
		return
	}
	if errors.Is(err, errNoSuchInstalment) {
		httpx.Error(w, r, http.StatusConflict, "no_such_instalment",
			fmt.Sprintf("this fee structure has nothing priced under instalment %d, so every invoice would come to zero. Check the instalment number, or add the lines to the structure first.", req.InstalmentNo))
		return
	}
	if errors.Is(err, errNoLiveFeeVersion) {
		httpx.Error(w, r, http.StatusConflict, "no_live_fee_version",
			"cannot generate invoices: this fee structure has no live version. Activate a version first, or a parent will be billed a figure the school has not agreed.")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"created": created, "skipped": skipped,
		"instalment_no": req.InstalmentNo, "due_on": dueOn.Format(time.DateOnly),
		/* Children billed in full whose waiver was still waiting. Reported
		   rather than refused: the demand is usually right and a school that
		   cannot bill until every concession is decided cannot bill. */
		"pending_concessions": pendingConcessions,
	})
}

// --- concessions and refunds --------------------------------------------------

type concessionRow struct {
	ID          string  `json:"id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	FeeHead     *string `json:"fee_head,omitempty"`
	Kind        string  `json:"kind"`
	Percent     *string `json:"percent,omitempty"`
	AmountPaise *int64  `json:"amount_paise,omitempty"`
	Reason      *string `json:"reason,omitempty"`
	ApprovedBy  *string `json:"approved_by,omitempty"`
	Status      string  `json:"status"`
	/* The record of the decision, which is why refusals are kept at all. A
	   table of approvals alone reads as a school that approves everything. */
	DecisionNote string `json:"decision_note"`
	RequestedBy  string `json:"requested_by"`
	DecidedOn    string `json:"decided_on"`
	RaisedOn     string `json:"raised_on"`
}

/*
listConcessions is the discount book.

	Status is derived rather than stored: fee_concessions has approved_by and
	approved_at and no status column, so "pending" means nobody has signed it
	off yet. Deriving it here keeps the one definition in one place — a client
	computing it from a null check would be a second answer to the same
	question, and the attention panel already counts these.
*/
func (s *Server) listConcessions(w http.ResponseWriter, r *http.Request) {
	only := r.URL.Query().Get("status")
	items, err := collect(s, r, `
		SELECT fc.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       fh.name, fc.kind, fc.percent::text, fc.amount_paise, fc.reason,
		       u.full_name, fc.status,
		       /* THE WHOLE HISTORY, which is the point of keeping refusals.
		          Who asked, who decided, when, and what they wrote — a table
		          of approvals alone reads as a school that approves
		          everything, and the same request comes back next term and is
		          decided from nothing. */
		       COALESCE(fc.decision_note,''),
		       COALESCE(ru.full_name,''),
		       COALESCE(to_char(fc.decided_at,'YYYY-MM-DD'),''),
		       to_char(fc.created_at,'YYYY-MM-DD')
		  FROM fee_concessions fc
		  JOIN students st ON st.id = fc.student_id
		  LEFT JOIN fee_heads fh ON fh.id = fc.fee_head_id
		  LEFT JOIN users u ON u.id = fc.approved_by
		  LEFT JOIN users ru ON ru.id = fc.requested_by
		 WHERE $1 = '' OR fc.status = $1
		 ORDER BY fc.status <> 'pending', fc.created_at DESC
		 LIMIT 300`, []any{only},
		func(rows pgx.Rows) (concessionRow, error) {
			var v concessionRow
			return v, rows.Scan(&v.ID, &v.StudentName, &v.AdmissionNo, &v.FeeHead,
				&v.Kind, &v.Percent, &v.AmountPaise, &v.Reason, &v.ApprovedBy,
				&v.Status, &v.DecisionNote, &v.RequestedBy, &v.DecidedOn, &v.RaisedOn)
		})
	respond(w, r, items, err)
}

type refundRow struct {
	ID          string  `json:"id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	AmountPaise int64   `json:"amount_paise"`
	Reason      *string `json:"reason,omitempty"`
	Mode        *string `json:"mode,omitempty"`
	Status      string  `json:"status"`
	ProcessedOn *string `json:"processed_on,omitempty"`
	CreatedAt   string  `json:"created_at"`
}

// listRefunds shows money going back out, which is the half of a fee ledger
// nobody builds until an auditor asks for it.
func (s *Server) listRefunds(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT rf.id::text,
		       concat_ws(' ', st.first_name, st.last_name), st.admission_no,
		       rf.amount_paise, rf.reason, rf.mode, rf.status,
		       to_char(rf.processed_on,'YYYY-MM-DD'),
		       to_char(rf.created_at,'YYYY-MM-DD')
		  FROM refunds rf
		  JOIN students st ON st.id = rf.student_id
		 ORDER BY rf.created_at DESC
		 LIMIT 200`, nil,
		func(rows pgx.Rows) (refundRow, error) {
			var v refundRow
			return v, rows.Scan(&v.ID, &v.StudentName, &v.AdmissionNo, &v.AmountPaise,
				&v.Reason, &v.Mode, &v.Status, &v.ProcessedOn, &v.CreatedAt)
		})
	respond(w, r, items, err)
}
