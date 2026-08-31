package api

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* What a family can see of their own fees and results.

   The catalogue lists "Fees" for a student and "Fees & payments" for a parent,
   and both were wired to the cashier's counter screen — the one that searches
   every student in the school and takes money. A parent opening it got 403 on
   its first request and a blank page; there was no family-facing view of a
   fee at all. Same for results, which pointed at the staff report-card
   generator.

   These two endpoints are the family's side of the same data: their own
   invoices and receipts, and their own published results. Everything is
   filtered through the caller's resolved student set, so the URL cannot be
   edited into someone else's child.

   Unpublished results are excluded on purpose. A report card exists from the
   moment marks are entered and is wrong until the exam controller has checked
   it; showing a parent a provisional rank is how a school ends up defending
   a number it never meant to publish. */

// whichChild resolves the student the caller is asking about, refusing
// anything outside their own set. A parent with several children may name one;
// a student is always themselves.
func (s *Server) whichChild(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return uuid.Nil, false
	}
	if len(res.StudentIDs) == 0 {
		httpx.NotFound(w, r)
		return uuid.Nil, false
	}
	target := res.StudentIDs[0]
	if q := r.URL.Query().Get("student_id"); q != "" {
		for _, sid := range res.StudentIDs {
			if sid.String() == q {
				return sid, true
			}
		}
		// Deliberately the same answer as a student who does not exist, so the
		// endpoint cannot be used to discover which ids are real.
		httpx.NotFound(w, r)
		return uuid.Nil, false
	}
	return target, true
}

type familyInvoice struct {
	InvoiceNo   string  `json:"invoice_no"`
	Instalment  *int    `json:"instalment_no,omitempty"`
	IssuedOn    string  `json:"issued_on"`
	DueOn       *string `json:"due_on,omitempty"`
	NetPaise    int64   `json:"net_paise"`
	PaidPaise   int64   `json:"paid_paise"`
	DuePaise    int64   `json:"due_paise"`
	FinePaise   int64   `json:"fine_paise"`
	Status      string  `json:"status"`
	DaysOverdue int     `json:"days_overdue"`
	/* What the money is for.

	   The row said "Instalment 1 — ₹11,833" and nothing else, so a parent
	   asking what they are paying for had to telephone the office to be read
	   the same list the school already holds. Tuition, laboratory, transport,
	   and any penalty, each with its amount. */
	Lines []familyInvoiceLine `json:"lines"`
}

type familyInvoiceLine struct {
	Head   string `json:"head"`
	Paise  int64  `json:"amount_paise"`
	IsFine bool   `json:"is_fine"`
}

type familyReceipt struct {
	ReceiptNo string  `json:"receipt_no"`
	PaidOn    string  `json:"paid_on"`
	Amount    int64   `json:"amount_paise"`
	Mode      string  `json:"mode"`
	Reference *string `json:"reference_no,omitempty"`
	Status    string  `json:"status"`
}

// getFamilyFees is the parent's own bill: what is owed, by when, and what has
// already been paid.
func (s *Server) getFamilyFees(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}

	var (
		name     string
		invoices = []familyInvoice{}
		receipts = []familyReceipt{}
		due      int64
	)
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT concat_ws(' ', first_name, middle_name, last_name)
			  FROM students WHERE id = $1`, student).Scan(&name); err != nil {
			return err
		}

		// Cancelled invoices are excluded: a bill the school withdrew is not
		// something a parent should still see themselves owing.
		rows, err := tx.Query(r.Context(), `
			SELECT id, invoice_no, instalment_no,
			       to_char(issued_on,'YYYY-MM-DD'), to_char(due_on,'YYYY-MM-DD'),
			       net_paise, paid_paise, fine_paise, status,
			       GREATEST(0, CURRENT_DATE - due_on)::int
			  FROM invoices
			 WHERE student_id = $1 AND status <> 'cancelled'
			 ORDER BY due_on NULLS LAST, invoice_no`, student)
		if err != nil {
			return err
		}
		ids := []uuid.UUID{}
		for rows.Next() {
			var v familyInvoice
			var id uuid.UUID
			if err := rows.Scan(&id, &v.InvoiceNo, &v.Instalment, &v.IssuedOn, &v.DueOn,
				&v.NetPaise, &v.PaidPaise, &v.FinePaise, &v.Status,
				&v.DaysOverdue); err != nil {
				rows.Close()
				return err
			}
			v.DuePaise = v.NetPaise - v.PaidPaise
			if v.DuePaise > 0 {
				due += v.DuePaise
			}
			ids = append(ids, id)
			invoices = append(invoices, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		/* What each instalment is made of, in one query rather than one per
		   invoice: a family with four terms would otherwise be five round
		   trips to answer a question the first one nearly answered. */
		if len(ids) > 0 {
			at := map[string]int{}
			for i, id := range ids {
				at[id.String()] = i
			}
			lr, err := tx.Query(r.Context(), `
				SELECT il.invoice_id::text,
				       COALESCE(NULLIF(il.description, ''), fh.name),
				       il.amount_paise - il.discount_paise
				  FROM invoice_lines il
				  JOIN fee_heads fh ON fh.id = il.fee_head_id
				 WHERE il.invoice_id = ANY($1)
				   /* A penalty writes a zero-amount line to carry its reason —
				      the money itself lives in fine_paise — and the family's
				      breakdown showed it as "Penalty — late fee ₹0" beside the
				      real "Late fee / penalty ₹2,000". One charge, printed
				      twice, one of them for nothing. */
				   AND il.amount_paise - il.discount_paise <> 0
				 ORDER BY il.amount_paise DESC`, ids)
			if err != nil {
				return err
			}
			for lr.Next() {
				var invID, head string
				var paise int64
				if err := lr.Scan(&invID, &head, &paise); err != nil {
					lr.Close()
					return err
				}
				if i, ok := at[invID]; ok {
					invoices[i].Lines = append(invoices[i].Lines,
						familyInvoiceLine{Head: head, Paise: paise})
				}
			}
			lr.Close()
			if err := lr.Err(); err != nil {
				return err
			}
			/* The penalty is not a line — it lives in fine_paise, because
			   net_paise is generated from it — so it is added here or the
			   breakdown would not add up to the total the family is shown. */
			for i := range invoices {
				if invoices[i].FinePaise > 0 {
					invoices[i].Lines = append(invoices[i].Lines,
						familyInvoiceLine{Head: "Late fee / penalty",
							Paise: invoices[i].FinePaise, IsFine: true})
				}
			}
		}

		// A bounced cheque is shown rather than hidden. The family needs to
		// know the payment did not stand, and finding out from a defaulter
		// notice instead is how a school loses an afternoon on the phone.
		rows, err = tx.Query(r.Context(), `
			SELECT receipt_no, to_char(paid_on,'YYYY-MM-DD'), amount_paise,
			       mode, reference_no, status
			  FROM payments
			 WHERE student_id = $1
			 ORDER BY paid_on DESC, receipt_no DESC
			 LIMIT 50`, student)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v familyReceipt
			if err := rows.Scan(&v.ReceiptNo, &v.PaidOn, &v.Amount, &v.Mode,
				&v.Reference, &v.Status); err != nil {
				return err
			}
			receipts = append(receipts, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": student.String(), "student_name": name,
		"outstanding_paise": due, "invoices": invoices, "receipts": receipts,
	})
}

type familyResult struct {
	// The card itself, so the family can open the school's own design rather
	// than only the figures this row carries.
	ID          string   `json:"id"`
	Exam        string   `json:"exam"`
	Term        *string  `json:"term,omitempty"`
	Total       *float64 `json:"total_marks,omitempty"`
	Max         *float64 `json:"max_marks,omitempty"`
	Percentage  *float64 `json:"percentage,omitempty"`
	Grade       *string  `json:"grade,omitempty"`
	GPA         *float64 `json:"gpa,omitempty"`
	RankSection *int     `json:"rank_in_section,omitempty"`
	Attendance  *float64 `json:"attendance_percent,omitempty"`
	Remarks     *string  `json:"class_teacher_remarks,omitempty"`
	PublishedAt *string  `json:"published_at,omitempty"`
}

type familySubjectMark struct {
	Exam     string   `json:"exam"`
	Subject  string   `json:"subject"`
	Obtained *float64 `json:"marks_obtained,omitempty"`
	Max      *float64 `json:"max_marks,omitempty"`
	Grade    *string  `json:"grade,omitempty"`
	Absent   bool     `json:"is_absent"`
}

// getFamilyResults returns published report cards and the subject marks
// behind them.
func (s *Server) getFamilyResults(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	student, ok := s.whichChild(w, r)
	if !ok {
		return
	}

	cards := []familyResult{}
	subjects := []familySubjectMark{}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT rc.id::text, COALESCE(t.name, ay.name, 'Result'), t.name,
			       rc.total_marks, rc.max_marks, rc.percentage, rc.grade, rc.gpa,
			       rc.rank_in_section, rc.attendance_percent, rc.class_teacher_remarks,
			       to_char(rc.published_at,'YYYY-MM-DD')
			  FROM report_cards rc
			  LEFT JOIN terms t           ON t.id = rc.term_id
			  LEFT JOIN academic_years ay ON ay.id = rc.academic_year_id
			 WHERE rc.student_id = $1 AND rc.is_published
			 ORDER BY rc.published_at DESC NULLS LAST`, student)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v familyResult
			if err := rows.Scan(&v.ID, &v.Exam, &v.Term, &v.Total, &v.Max, &v.Percentage,
				&v.Grade, &v.GPA, &v.RankSection, &v.Attendance, &v.Remarks,
				&v.PublishedAt); err != nil {
				rows.Close()
				return err
			}
			cards = append(cards, v)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// Marks are shown only for exams whose results have been published for
		// this child, so a parent cannot read a paper back before the school
		// has released it.
		rows, err = tx.Query(r.Context(), `
			SELECT ex.name, sub.name, m.marks_obtained, es.max_marks,
			       m.grade, COALESCE(m.is_absent, false)
			  FROM marks m
			  JOIN exam_subjects  es ON es.id = m.exam_subject_id
			  JOIN exams          ex ON ex.id = es.exam_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			  JOIN subjects      sub ON sub.id = cs.subject_id
			 WHERE m.student_id = $1
			   AND EXISTS (SELECT 1 FROM report_cards rc
			                WHERE rc.student_id = m.student_id AND rc.is_published)
			 ORDER BY ex.starts_on NULLS LAST, sub.name`, student)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v familySubjectMark
			if err := rows.Scan(&v.Exam, &v.Subject, &v.Obtained, &v.Max,
				&v.Grade, &v.Absent); err != nil {
				return err
			}
			subjects = append(subjects, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"student_id": student.String(),
		"cards":      cards, "subjects": subjects,
		// Said plainly rather than left as an empty list: "nothing here yet"
		// and "your school has not released results" are different messages,
		// and a parent reading the first one telephones the office.
		"published": len(cards) > 0,
	})
}
