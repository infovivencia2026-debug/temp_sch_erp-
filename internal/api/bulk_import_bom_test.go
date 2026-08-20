package api

import "testing"

// A CSV saved by Excel begins with a byte order mark. It is not whitespace, so
// the header trimming that was here left it attached to the first column, and
// that column silently stopped matching its own name -- which meant a class
// list imported from a spreadsheet lost its admission numbers.
func TestNormaliseHeaderStripsExcelByteOrderMark(t *testing.T) {
	const bom = "\ufeff"
	if got := normaliseHeader(bom + "admission_no"); got != "admission_no" {
		t.Errorf("BOM survived the header: %q", got)
	}
	if got := normaliseHeader(bom + "Employee Code"); got != "employee_code" {
		t.Errorf("BOM plus spacing and capitals: %q", got)
	}
	if got := normaliseHeader("first_name"); got != "first_name" {
		t.Errorf("an ordinary header was changed: %q", got)
	}
}
