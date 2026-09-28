package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/school-erp/erp/internal/pdf"
)

func sp(s string) *string { return &s }

func TestReceiptStamp(t *testing.T) {
	if st, n := receiptStamp("success", "cash"); st != "" || n != "" {
		t.Errorf("a completed payment carries no stamp, got %q %q", st, n)
	}
	st, n := receiptStamp("pending", "cheque")
	if st != "SUBJECT TO REALISATION" || !strings.Contains(n, "The cheque") {
		t.Errorf("pending cheque: %q %q", st, n)
	}
	for status, want := range map[string]string{
		"refunded": "REFUNDED", "cancelled": "CANCELLED", "bounced": "DISHONOURED", "failed": "NOT PAID",
	} {
		st, n := receiptStamp(status, "cash")
		if st != want || !strings.Contains(n, "Not valid as a receipt") {
			t.Errorf("%s: %q %q", status, st, n)
		}
	}
}

func TestLetterheadLines(t *testing.T) {
	if got := joinNonEmpty(", ", sp("Plot 12"), nil, sp("  "), sp("Hyderabad"), sp("500001")); got != "Plot 12, Hyderabad, 500001" {
		t.Errorf("address = %q", got)
	}
	if got := joinLabelled(" · ", "Phone: ", sp("8886663636"), "Email: ", nil); got != "Phone: 8886663636" {
		t.Errorf("contact = %q", got)
	}
	if got := affiliationLine(sp("cbse"), sp("3630000"), sp("36220100101")); got != "CBSE Affiliation No. 3630000 · UDISE 36220100101" {
		t.Errorf("affiliation = %q", got)
	}
	if got := affiliationLine(nil, nil, nil); got != "" {
		t.Errorf("empty affiliation = %q", got)
	}
	if orDash(" ") != "-" || orDash("4 B") != "4 B" {
		t.Error("orDash")
	}
}

func TestWritePDFHeaders(t *testing.T) {
	w := httptest.NewRecorder()
	writePDF(w, `Receipt-YPS/2026-27/"000123"`, []byte("%PDF-1.4"))
	h := w.Header()
	if h.Get("Content-Type") != "application/pdf" {
		t.Errorf("content type %q", h.Get("Content-Type"))
	}
	if got := h.Get("Content-Disposition"); got != `inline; filename="Receipt-YPS-2026-27-000123.pdf"` {
		t.Errorf("disposition %q", got)
	}
	if !strings.Contains(h.Get("Cache-Control"), "no-store") {
		t.Error("a receipt must not be cached")
	}
}

func TestWritePDFError(t *testing.T) {
	s := &Server{}
	for err, code := range map[error]int{
		pdf.ErrNotConfigured: http.StatusServiceUnavailable,
		pdf.ErrTooLong:       http.StatusUnprocessableEntity,
		errors.New("boom"):   http.StatusBadGateway,
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/x", nil)
		if s.writePDFError(w, r, err, "receipt") {
			t.Errorf("%v: must not carry on", err)
		}
		if w.Code != code {
			t.Errorf("%v: code %d, want %d", err, w.Code, code)
		}
		if strings.Contains(w.Body.String(), "boom") {
			t.Error("internal error text must not reach the person")
		}
	}
	if !s.writePDFError(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil), nil, "receipt") {
		t.Error("nil error carries on")
	}
}
