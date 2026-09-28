package pdf

import (
	"bytes"
	"embed"
	"fmt"
	"html/template"
)

//go:embed templates/*.html
var templateFS embed.FS

var receiptTmpl = template.Must(
	template.New("receipt.html").
		Funcs(template.FuncMap{"inc": func(i int) int { return i + 1 }}).
		ParseFS(templateFS, "templates/receipt.html"))

// Receipt is everything printed on a fee receipt, already formatted for
// reading. Amounts are strings because the template never does arithmetic:
// the numbers are the ledger's, formatted once, in Go, with tests.
type Receipt struct {
	// Letterhead.
	SchoolName  string
	Address     string
	Contact     string
	Affiliation string
	// Logo is a data: URI of the school's logo, or empty. Built only by
	// LogoDataURI from bytes the school uploaded, never from free text.
	Logo template.URL

	ReceiptNo     string
	Date          string
	FinancialYear string
	StudentName   string
	AdmissionNo   string
	ClassSection  string

	Lines       []ReceiptLine
	Total       string
	AmountWords string

	Mode        string
	Reference   string
	CollectedBy string

	// Duplicate marks a reprint from the office.
	Duplicate bool
	// Stamp is printed across the copy when the payment is not a completed
	// one (pending cheque, refund, cancellation); Note says what it means.
	Stamp string
	Note  string

	PrintedAt string
}

// ReceiptLine is one row of the particulars table.
type ReceiptLine struct {
	Particulars string
	InvoiceNo   string
	Amount      string
}

// density is one of the four layouts, roomiest first. Sizes in points and
// millimetres. The tightest is still comfortably legible on paper.
type density struct {
	Font, Small, Name, Title float64
	Pad, PadX, Gap, Cell     float64
	Logo                     float64
}

var densities = [Densities]density{
	{Font: 10, Small: 8.5, Name: 15, Title: 12, Pad: 8, PadX: 11, Gap: 2.6, Cell: 1.5, Logo: 18},
	{Font: 9.2, Small: 7.8, Name: 13.5, Title: 11, Pad: 6.5, PadX: 10, Gap: 2, Cell: 1.1, Logo: 16},
	{Font: 8.4, Small: 7.2, Name: 12, Title: 10, Pad: 5, PadX: 9, Gap: 1.5, Cell: 0.8, Logo: 14},
	{Font: 7.6, Small: 6.6, Name: 11, Title: 9.5, Pad: 4, PadX: 8, Gap: 1.1, Cell: 0.5, Logo: 12},
}

// ReceiptLayout says how a receipt is laid on paper.
type ReceiptLayout struct {
	Paper Paper
	// Copies is one label per copy on the sheet, e.g. {"Office copy",
	// "Parent copy"}; "" prints a copy with no label.
	Copies []string
}

var (
	// CounterReceipt is the office's: two copies on one A4 sheet, the office
	// keeps the top half and the family takes the bottom.
	CounterReceipt = ReceiptLayout{Paper: A4, Copies: []string{"Office copy", "Parent copy"}}
	// FamilyReceipt is the family's own download: one copy on A5 landscape.
	FamilyReceipt = ReceiptLayout{Paper: A5Landscape, Copies: []string{""}}
)

// ReceiptHTML fills the receipt template for one density level.
func ReceiptHTML(r Receipt, layout ReceiptLayout, level int) ([]byte, error) {
	if level < 0 || level >= Densities {
		return nil, fmt.Errorf("pdf: density %d out of range", level)
	}
	n := len(layout.Copies)
	if n == 0 {
		return nil, fmt.Errorf("pdf: a receipt needs at least one copy")
	}
	// Each copy gets an equal share of the sheet, less a millimetre so that
	// rounding can never push an exactly-full sheet onto a blank second page.
	copyH := (layout.Paper.HeightMM - 1) / float64(n)
	var buf bytes.Buffer
	err := receiptTmpl.Execute(&buf, map[string]any{
		"R":      r,
		"Copies": layout.Copies,
		"D":      densities[level],
		"PageW":  layout.Paper.WidthMM,
		"PageH":  layout.Paper.HeightMM,
		"CopyH":  copyH,
	})
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
