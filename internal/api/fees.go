package api

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
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
		return err
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
		return fees.BounceCheque(r.Context(), tx, paymentID, req.FinePaise)
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
		   AND i.due_on IS NOT NULL AND i.due_on < CURRENT_DATE
		 GROUP BY st.id, c.name, sec.name, g.full_name, g.phone
		 HAVING sum(i.net_paise - i.paid_paise) > 0
		 ORDER BY 10 DESC
		 LIMIT 500`, nil,
		func(rows pgx.Rows) (defaulterRow, error) {
			var v defaulterRow
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.FullName, &v.ClassName,
				&v.SectionName, &v.GuardianName, &v.Phone, &v.BalancePaise,
				&v.OldestDue, &v.DaysOverdue, &v.Bucket)
		})
	respond(w, r, items, err)
}

type generateInvoicesRequest struct {
	FeeStructureID string `json:"fee_structure_id"`
	InstalmentNo   int    `json:"instalment_no"`
	DueOn          string `json:"due_on"`
}

// generateInvoices raises one invoice per enrolled student from a fee
// structure, applying each student's concessions.
//
// Runs inline rather than on the queue: a term run for one class is a few
// hundred rows and the cashier is waiting to see the count. A whole-school run
// across every class belongs on the bulk queue via /api/v1/jobs.
func (s *Server) generateInvoices(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())

	var req generateInvoicesRequest
	if !httpx.Decode(w, r, &req) {
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
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var instID, campusID, yearID uuid.UUID
		var classID *uuid.UUID
		if err := tx.QueryRow(r.Context(), `
			SELECT institution_id, campus_id, academic_year_id, class_id
			  FROM fee_structures WHERE id = $1 AND is_active`, structureID).
			Scan(&instID, &campusID, &yearID, &classID); err != nil {
			return err
		}

		// Students enrolled in this year, optionally limited to the structure's
		// class. Skipping those already invoiced for this instalment makes the
		// whole operation safe to re-run after a partial failure.
		rows, err := tx.Query(r.Context(), `
			SELECT e.student_id
			  FROM enrollments e
			 WHERE e.academic_year_id = $1
			   AND e.status = 'active'
			   AND ($2::uuid IS NULL OR e.class_id = $2)
			   AND NOT EXISTS (
			       SELECT 1 FROM invoices i
			        WHERE i.student_id = e.student_id
			          AND i.academic_year_id = $1
			          AND i.instalment_no = $3)`, yearID, classID, req.InstalmentNo)
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
				 WHERE fsi.fee_structure_id = $5 AND fsi.instalment_no = $6`,
				instID, invoiceID, sid, yearID, structureID, req.InstalmentNo); err != nil {
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
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"created": created, "skipped": skipped,
		"instalment_no": req.InstalmentNo, "due_on": dueOn.Format(time.DateOnly),
	})
}
