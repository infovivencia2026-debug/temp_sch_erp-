package api

import (
	"testing"

	"github.com/school-erp/erp/internal/rbac"
)

/*
Every export names a permission the product actually has.

	Three of the seven registers added here were gated on strings that read
	plausibly — "finance.payroll.read", "ops.library.read" — and that rbac has
	never defined. Can() answers false for a permission nobody holds, so the
	principal, who holds everything, was refused their own payroll register. It
	surfaced as a 403 rather than an error, which is the kind of mistake that
	sits in a product for a year.

	A typo in an allowlist is invisible until somebody clicks the button. This
	makes it visible when somebody runs the tests.
*/
func TestExportPermissionsExist(t *testing.T) {
	known := map[string]bool{}
	for _, p := range rbac.All {
		known[p.Key] = true
	}
	for name, spec := range exportable {
		if !known[spec.perm] {
			t.Errorf("export %q is gated on %q, which is not a permission this product defines",
				name, spec.perm)
		}
	}
}
