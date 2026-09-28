package pdf

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// skiaPDF is the shape Chromium's PDF writer produces for n pages: a page
// tree with a /Count and one /Type /Page object per page.
func skiaPDF(n int) []byte {
	var b strings.Builder
	b.WriteString("%PDF-1.4\n%\xd3\xeb\xe9\xe1\n1 0 obj\n<</Type /Catalog\n/Pages 2 0 R>>\nendobj\n")
	b.WriteString("2 0 obj\n<</Type /Pages\n/Count ")
	b.WriteString(itoa(n))
	b.WriteString("\n/Kids [")
	for i := 0; i < n; i++ {
		b.WriteString(itoa(3+i) + " 0 R ")
	}
	b.WriteString("]>>\nendobj\n")
	for i := 0; i < n; i++ {
		b.WriteString(itoa(3+i) + " 0 obj\n<</Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 595 842]>>\nendobj\n")
	}
	b.WriteString("%%EOF\n")
	return []byte(b.String())
}

func itoa(n int) string { return strconv.Itoa(n) }

func TestPageCount(t *testing.T) {
	for _, n := range []int{1, 2, 7} {
		if got := PageCount(skiaPDF(n)); got != n {
			t.Errorf("PageCount(%d-page pdf) = %d", n, got)
		}
	}
	if got := PageCount([]byte("<html>not a pdf</html>")); got != 0 {
		t.Errorf("PageCount(html) = %d, want 0", got)
	}
	// No page tree count: falls back to counting page objects, and "/Pages"
	// must not be counted as a page.
	noCount := []byte("%PDF-1.7\n<</Type /Pages /Kids [3 0 R 4 0 R]>>\n<</Type /Page>>\n<</Type/Page>>\n")
	if got := PageCount(noCount); got != 2 {
		t.Errorf("PageCount(no /Count) = %d, want 2", got)
	}
}

func sample() Receipt {
	return Receipt{
		SchoolName: "Yajur Public School", Address: "Plot 12, Road 3, Hyderabad 500001",
		Contact: "Phone 8886663636", Affiliation: "CBSE Affiliation No. 3630000",
		ReceiptNo: "YPS/2026-27/000123", Date: "28 Sep 2026", FinancialYear: "2026-27",
		StudentName: "గిరగాని భవ్య శ్రుతి", AdmissionNo: "YPS59100030", ClassSection: "Grade 4 B",
		Lines: []ReceiptLine{{Particulars: "Tuition Fee, Term 2", InvoiceNo: "INV-0042", Amount: "12,500.00"}},
		Total: "12,500.00", AmountWords: "Twelve Thousand Five Hundred Rupees Only",
		Mode: "UPI", Reference: "412345678901", CollectedBy: "Front Office",
		PrintedAt: "28 Sep 2026, 10:42 AM",
	}
}

func TestReceiptHTMLEscapesAndFills(t *testing.T) {
	r := sample()
	r.StudentName = `<script>alert(1)</script>Asha`
	out, err := ReceiptHTML(r, CounterReceipt, 0)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Contains(s, "<script>alert") {
		t.Fatal("student name was not escaped")
	}
	for _, want := range []string{"FEE RECEIPT", "YPS/2026-27/000123", "Office copy", "Parent copy",
		"Twelve Thousand Five Hundred Rupees Only", "12,500.00", "Authorised Signatory", "cut here"} {
		if !strings.Contains(s, want) {
			t.Errorf("receipt html missing %q", want)
		}
	}
	if strings.Contains(s, "DUPLICATE") {
		t.Error("first print must not say DUPLICATE")
	}
	if strings.Count(s, `class="copy"`) != 2 {
		t.Error("counter receipt must carry two copies")
	}
}

func TestReceiptHTMLFamilyCopyAndMarks(t *testing.T) {
	r := sample()
	r.Duplicate = true
	r.Stamp = "REFUNDED"
	r.Note = "Not valid as a receipt."
	out, err := ReceiptHTML(r, FamilyReceipt, 3)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Count(s, `class="copy"`) != 1 || strings.Contains(s, "cut here") {
		t.Error("family receipt is one copy with no cut line")
	}
	for _, want := range []string{"DUPLICATE", "REFUNDED", "Not valid as a receipt."} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q", want)
		}
	}
	if _, err := ReceiptHTML(r, FamilyReceipt, Densities); err == nil {
		t.Error("density out of range must fail")
	}
}

func TestLogoDataURI(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	if got := string(LogoDataURI(png, "")); !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Errorf("png logo = %q", got)
	}
	if got := LogoDataURI([]byte("<html><script>x</script></html>"), "image/png"); got != "" {
		t.Error("html claiming to be png must be refused")
	}
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	if got := string(LogoDataURI(svg, "image/svg+xml")); !strings.HasPrefix(got, "data:image/svg+xml;base64,") {
		t.Errorf("svg logo = %q", got)
	}
	if got := LogoDataURI(svg, "text/plain"); got != "" {
		t.Error("undeclared svg must be refused")
	}
	if got := LogoDataURI(make([]byte, MaxLogoBytes+1), "image/png"); got != "" {
		t.Error("oversized logo must be refused")
	}
}

// The renderer is asked for the tightest layout only when the roomier ones
// spill onto a second page, and the request carries what Gotenberg needs.
func TestRenderOnePageTightensUntilItFits(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/forms/chromium/convert/html" {
			t.Errorf("path %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("authorization %q", got)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		if r.FormValue("paperWidth") != "8.2677" || r.FormValue("marginTop") != "0" {
			t.Errorf("paper %s margin %s", r.FormValue("paperWidth"), r.FormValue("marginTop"))
		}
		f, _, err := r.FormFile("files")
		if err != nil {
			t.Fatal(err)
		}
		html, _ := io.ReadAll(f)
		n := calls.Add(1)
		if !strings.Contains(string(html), "level-"+itoa(int(n)-1)) {
			t.Errorf("call %d got %q", n, html)
		}
		if n < 3 {
			_, _ = w.Write(skiaPDF(2))
			return
		}
		_, _ = w.Write(skiaPDF(1))
	}))
	defer srv.Close()

	c := New(srv.URL)
	c.Token = func(context.Context, string) (string, error) { return "tok", nil }
	out, err := c.RenderOnePage(context.Background(), A4, func(d int) ([]byte, error) {
		return []byte("level-" + itoa(d)), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if PageCount(out) != 1 || calls.Load() != 3 {
		t.Fatalf("pages %d after %d calls", PageCount(out), calls.Load())
	}
}

func TestRenderOnePageRefusesWhatNeverFits(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(skiaPDF(2))
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.Token = func(context.Context, string) (string, error) { return "", nil }
	_, err := c.RenderOnePage(context.Background(), A4, func(int) ([]byte, error) { return []byte("x"), nil })
	if !errors.Is(err, ErrTooLong) {
		t.Fatalf("err = %v, want ErrTooLong", err)
	}
}

func TestRenderNotConfigured(t *testing.T) {
	_, err := New("").RenderOnePage(context.Background(), A4, func(int) ([]byte, error) { return nil, nil })
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v", err)
	}
}

func TestRendererErrorIsReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "chromium crashed", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	c := New(srv.URL)
	c.Token = func(context.Context, string) (string, error) { return "", nil }
	_, err := c.RenderOnePage(context.Background(), A4, func(int) ([]byte, error) { return []byte("x"), nil })
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("err = %v", err)
	}
}
