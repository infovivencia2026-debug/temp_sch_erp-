package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/fees"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/pdf"
)

/* THE FEE RECEIPT, AS A PDF AND NOTHING ELSE.

   Printing used to copy the screen onto paper: whatever the receipt card
   looked like in the browser, tidied by a print stylesheet, printed by
   whatever the device's browser made of it -- and in the parent app's
   WebView, nothing at all. A receipt is a document a family keeps and an
   auditor reads, so it is now made on the server from one standard
   template (internal/pdf/templates/receipt.html), printed to PDF by the
   private renderer, and handed over as a PDF file. Same file on every
   device, on one page, strictly (pdf.RenderOnePage).

   Two doors, two layouts:

     GET /fees/receipts/{id}/pdf     the counter: A4, office copy on top and
                                     parent copy below a cut line. Counted:
                                     the first print is the original and
                                     every reprint says DUPLICATE.
     GET /portal/receipts/{id}/pdf   the family's own: one copy on A5
                                     landscape, only for their own children
                                     and only for a completed payment. Not
                                     counted -- a download is not a reprint.

   The JSON receipt endpoints are untouched; the screens still use them. */

// receiptModeLabel is how the ledger's mode reads on paper.
var receiptModeLabel = map[string]string{
	"cash": "Cash", "cheque": "Cheque", "dd": "Demand Draft", "neft": "Bank transfer (NEFT/RTGS)",
	"upi": "UPI", "card": "Card", "netbanking": "Net banking", "gateway": "Online payment",
	"adjustment": "Adjustment",
}

// receiptStamp is what is printed across a receipt whose payment is not a
// completed one, and the sentence that says what that means. A completed
// payment has neither.
func receiptStamp(status, mode string) (stamp, note string) {
	switch status {
	case "success":
		return "", ""
	case "pending":
		what := "The payment"
		if mode == "cheque" || mode == "dd" {
			what = "The " + strings.ToLower(receiptModeLabel[mode])
		}
		return "SUBJECT TO REALISATION", what + " has been received and is not yet credited. This receipt is valid only after it is realised."
	case "refunded":
		return "REFUNDED", "This payment has been refunded. Not valid as a receipt."
	case "cancelled":
		return "CANCELLED", "This payment was cancelled. Not valid as a receipt."
	case "bounced":
		return "DISHONOURED", "The cheque was dishonoured. Not valid as a receipt."
	default:
		return "NOT PAID", "This payment did not complete. Not valid as a receipt."
	}
}

type receiptPrint struct {
	doc     pdf.Receipt
	prints  int
	logoKey *string
}

// loadReceiptPrint reads everything the printed receipt shows. students, when
// not nil, confines it to those children and to completed payments -- the
// family's door.
func loadReceiptPrint(ctx context.Context, tx pgx.Tx, paymentID uuid.UUID, students []uuid.UUID) (*receiptPrint, error) {
	var (
		receiptNo, mode, status, studentName, admissionNo, instName string
		amount                                                      int64
		paidOn                                                      time.Time
		prints                                                      int
		className, sectionName, reference, collectedBy              *string
		board, affiliationNo, udise, logoKey                        *string
		addr1, addr2, city, state, pincode, phone, email            *string
	)
	filter := ""
	args := []any{paymentID}
	if students != nil {
		filter = " AND p.student_id = ANY($2) AND p.status = 'success'"
		args = append(args, students)
	}
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(p.receipt_no,'-'), p.amount_paise, p.mode, p.status, p.paid_on,
		       p.reference_no, p.receipt_prints,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.admission_no, i.name, c.name, sec.name, u.full_name,
		       i.affiliation_board, i.affiliation_no, i.udise_code, i.logo_key,
		       cp.address_line1, cp.address_line2, cp.city, cp.state, cp.pincode,
		       cp.phone, cp.email::text
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
		  LEFT JOIN LATERAL (
		      SELECT address_line1, address_line2, city, state, pincode, phone, email
		        FROM campuses WHERE institution_id = i.id
		       ORDER BY created_at LIMIT 1
		  ) cp ON true
		 WHERE p.id = $1`+filter, args...).
		Scan(&receiptNo, &amount, &mode, &status, &paidOn, &reference, &prints,
			&studentName, &admissionNo, &instName, &className, &sectionName, &collectedBy,
			&board, &affiliationNo, &udise, &logoKey,
			&addr1, &addr2, &city, &state, &pincode, &phone, &email)
	if err != nil {
		return nil, err
	}

	lines := []pdf.ReceiptLine{}
	rows, err := tx.Query(ctx, `
		SELECT i.invoice_no, pa.amount_paise,
		       COALESCE(string_agg(DISTINCT fh.name, ', '), 'Fee')
		  FROM payment_allocations pa
		  JOIN invoices i ON i.id = pa.invoice_id
		  LEFT JOIN invoice_lines il ON il.invoice_id = i.id
		  LEFT JOIN fee_heads fh ON fh.id = il.fee_head_id
		 WHERE pa.payment_id = $1
		 GROUP BY i.invoice_no, pa.amount_paise
		 ORDER BY i.invoice_no`, paymentID)
	if err != nil {
		return nil, err
	}
	var allocated int64
	for rows.Next() {
		var inv, heads string
		var amt int64
		if err := rows.Scan(&inv, &amt, &heads); err != nil {
			rows.Close()
			return nil, err
		}
		allocated += amt
		lines = append(lines, pdf.ReceiptLine{Particulars: heads, InvoiceNo: inv, Amount: fees.RupeesGrouped(amt)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	/* Money received and not yet set against a bill -- an advance, or the
	   part of a payment larger than what was due -- is still money the
	   family paid, so it is a line of its own. The lines always add up to
	   the total printed beneath them. */
	if rest := amount - allocated; rest > 0 {
		lines = append(lines, pdf.ReceiptLine{Particulars: "Advance / unallocated", InvoiceNo: "-", Amount: fees.RupeesGrouped(rest)})
	}

	stamp, note := receiptStamp(status, mode)
	modeLabel := receiptModeLabel[mode]
	if modeLabel == "" {
		modeLabel = mode
	}
	doc := pdf.Receipt{
		SchoolName:    instName,
		Address:       joinNonEmpty(", ", addr1, addr2, city, state, pincode),
		Contact:       joinLabelled(" · ", "Phone: ", phone, "Email: ", email),
		Affiliation:   affiliationLine(board, affiliationNo, udise),
		ReceiptNo:     receiptNo,
		Date:          paidOn.Format("02 Jan 2006"),
		FinancialYear: fees.FinancialYear(paidOn),
		StudentName:   strings.TrimSpace(studentName),
		AdmissionNo:   admissionNo,
		ClassSection:  orDash(joinNonEmpty(" ", className, sectionName)),
		Lines:         lines,
		Total:         fees.RupeesGrouped(amount),
		AmountWords:   fees.RupeesInWords(amount),
		Mode:          modeLabel,
		Reference:     deref(reference),
		CollectedBy:   deref(collectedBy),
		Stamp:         stamp,
		Note:          note,
		PrintedAt:     nowInIndia().Format("02 Jan 2006, 03:04 PM"),
	}
	return &receiptPrint{doc: doc, prints: prints, logoKey: logoKey}, nil
}

// loadLogo reads the school's logo for embedding, or nothing. A logo that
// cannot be read never stops a receipt from printing: the letterhead simply
// has no picture.
func (s *Server) loadLogo(r *http.Request, logoKey *string) pdfLogo {
	id := httpx.IdentityFrom(r.Context())
	if logoKey == nil {
		return pdfLogo{}
	}
	fileID, err := uuid.Parse(strings.TrimSpace(*logoKey))
	if err != nil {
		return pdfLogo{}
	}
	var key, ct string
	if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT object_key, COALESCE(content_type, '')
			  FROM files WHERE id = $1 AND deleted_at IS NULL`, fileID).Scan(&key, &ct)
	}); err != nil {
		return pdfLogo{}
	}
	// Whole file: a Range header the caller sent is about the PDF, not the logo.
	whole := r.Clone(r.Context())
	whole.Header.Del("Range")
	body, err := s.openStoredFile(whole, key)
	if err != nil {
		return pdfLogo{}
	}
	defer body.Close() //nolint:errcheck
	var rd io.Reader
	if body.file != nil {
		rd = body.file
	} else {
		rd = body.obj.Body
	}
	b, err := io.ReadAll(io.LimitReader(rd, pdf.MaxLogoBytes+1))
	if err != nil {
		return pdfLogo{}
	}
	return pdfLogo{bytes: b, contentType: ct}
}

type pdfLogo struct {
	bytes       []byte
	contentType string
}

// getReceiptPDF is the counter's receipt: two copies on A4, counted.
func (s *Server) getReceiptPDF(w http.ResponseWriter, r *http.Request) {
	s.serveReceiptPDF(w, r, false)
}

// getPortalReceiptPDF is the family's own copy.
func (s *Server) getPortalReceiptPDF(w http.ResponseWriter, r *http.Request) {
	s.serveReceiptPDF(w, r, true)
}

func (s *Server) serveReceiptPDF(w http.ResponseWriter, r *http.Request, family bool) {
	id := httpx.IdentityFrom(r.Context())
	paymentID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid payment id")
		return
	}
	var students []uuid.UUID
	if family {
		res, err := s.resolveScope(r)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if len(res.StudentIDs) == 0 {
			httpx.NotFound(w, r)
			return
		}
		students = res.StudentIDs
	}

	var rp *receiptPrint
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var err error
		rp, err = loadReceiptPrint(r.Context(), tx, paymentID, students)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	doc := rp.doc
	if logo := s.loadLogo(r, rp.logoKey); len(logo.bytes) > 0 {
		doc.Logo = pdf.LogoDataURI(logo.bytes, logo.contentType)
	}
	layout := pdf.CounterReceipt
	if family {
		layout = pdf.FamilyReceipt
	} else {
		doc.Duplicate = rp.prints > 0
	}

	out, err := s.PDF.RenderOnePage(r.Context(), layout.Paper, func(level int) ([]byte, error) {
		return pdf.ReceiptHTML(doc, layout, level)
	})
	if !s.writePDFError(w, r, err, "receipt") {
		return
	}

	/* Counted only once the PDF exists, so a failed render never turns the
	   next good print into a duplicate. Best-effort: a count that fails to
	   write must not withhold a receipt the family is standing at the
	   counter waiting for. */
	if !family {
		if err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(),
				`UPDATE payments SET receipt_prints = receipt_prints + 1 WHERE id = $1`, paymentID)
			return err
		}); err != nil {
			httpx.LogError(r, err)
		}
	}
	writePDF(w, "Receipt-"+doc.ReceiptNo, out)
}

// writePDFError answers a failed render and reports whether to carry on.
func (s *Server) writePDFError(w http.ResponseWriter, r *http.Request, err error, what string) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, pdf.ErrNotConfigured):
		httpx.Error(w, r, http.StatusServiceUnavailable, "print_unavailable",
			"Printing is not available right now. Please try again in a few minutes.")
	case errors.Is(err, pdf.ErrTooLong):
		httpx.Error(w, r, http.StatusUnprocessableEntity, "too_long",
			"This "+what+" has too much on it to fit on one page. Please tell the school office.")
	default:
		httpx.LogError(r, err)
		httpx.Error(w, r, http.StatusBadGateway, "print_failed",
			"The "+what+" could not be made just now. Please try again.")
	}
	return false
}

var unsafeFileChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// writePDF sends a PDF to be shown, not saved: the browser or phone opens it
// in its own viewer, where it can be printed, saved or shared.
func writePDF(w http.ResponseWriter, name string, b []byte) {
	name = strings.Trim(unsafeFileChars.ReplaceAllString(name, "-"), "-")
	if name == "" {
		name = "document"
	}
	h := w.Header()
	h.Set("Content-Type", "application/pdf")
	h.Set("Content-Disposition", `inline; filename="`+name+`.pdf"`)
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}

func joinNonEmpty(sep string, parts ...*string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != nil && strings.TrimSpace(*p) != "" {
			out = append(out, strings.TrimSpace(*p))
		}
	}
	return strings.Join(out, sep)
}

// joinLabelled takes label, value pairs and joins the ones with a value.
func joinLabelled(sep string, pairs ...any) string {
	out := []string{}
	for i := 0; i+1 < len(pairs); i += 2 {
		label, _ := pairs[i].(string)
		v, _ := pairs[i+1].(*string)
		if v != nil && strings.TrimSpace(*v) != "" {
			out = append(out, label+strings.TrimSpace(*v))
		}
	}
	return strings.Join(out, sep)
}

func affiliationLine(board, no, udise *string) string {
	parts := []string{}
	if no != nil && strings.TrimSpace(*no) != "" {
		b := ""
		if board != nil && strings.TrimSpace(*board) != "" {
			b = strings.ToUpper(strings.TrimSpace(*board)) + " "
		}
		parts = append(parts, b+"Affiliation No. "+strings.TrimSpace(*no))
	}
	if udise != nil && strings.TrimSpace(*udise) != "" {
		parts = append(parts, "UDISE "+strings.TrimSpace(*udise))
	}
	return strings.Join(parts, " · ")
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}
