package api

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/go-pdf/fpdf"
)

/*
renderDigestPDF turns the same report blocks SendReportDigest already builds
into a clean A4 PDF for the email attachment.

	It owns no aggregate and asks no question of the database: it is handed the
	school name, the period word, the range and the map of text blocks the
	builder assembled once, and lays them out. The email carries this as a
	summary a board member can open on a phone; the CSV attachments beside it
	carry the same numbers as data. Arial and the core fonts only, so there is
	no font file to ship and nothing to go missing on a box.
*/
func renderDigestPDF(school, periodWord string, rng digestRange, reports []string, blocks map[string]string) ([]byte, error) {
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(18, 18, 18)
	pdf.SetAutoPageBreak(true, 18)
	pdf.AddPage()

	// Title: the school and what this is.
	pdf.SetFont("Arial", "B", 18)
	pdf.MultiCell(0, 9, pdfSafe(school+" · Report digest"), "", "L", false)

	// The period and the range it covers.
	pdf.SetFont("Arial", "", 11)
	pdf.SetTextColor(90, 90, 90)
	pdf.MultiCell(0, 6, pdfSafe(fmt.Sprintf("%s digest for %s", periodWord, rng.Label)), "", "L", false)
	pdf.SetTextColor(0, 0, 0)
	pdf.Ln(4)

	for _, k := range reports {
		label := digestReportLabels[k]
		if label == "" {
			label = k
		}
		pdf.SetFont("Arial", "B", 13)
		pdf.MultiCell(0, 7, pdfSafe(label), "", "L", false)
		pdf.SetFont("Arial", "", 11)
		body := blocks[k]
		if strings.TrimSpace(body) == "" {
			body = "Nothing to report for this period."
		}
		pdf.MultiCell(0, 6, pdfSafe(body), "", "L", false)
		pdf.Ln(4)
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// pdfSafe keeps text inside the cp1252 range the core fonts render. The digest
// blocks carry ₹ from rupeesText, which is not a core-font glyph; spell it Rs
// rather than let it become a stray box. Any other rune above the Latin-1 range
// is dropped rather than rendered as a question mark.
func pdfSafe(s string) string {
	s = strings.ReplaceAll(s, "₹", "Rs ")
	s = strings.ReplaceAll(s, "-", "-")
	var b strings.Builder
	for _, r := range s {
		if r <= 0xFF {
			b.WriteRune(r)
		}
	}
	return b.String()
}
