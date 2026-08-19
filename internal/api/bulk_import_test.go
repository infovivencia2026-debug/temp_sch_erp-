package api

import (
	"strings"
	"testing"

	"github.com/school-erp/erp/internal/rbac"
)

// The sheet came out of somebody else's software, so its headers will not be
// ours. Matching them exactly is how an import fails on a file that is fine.
func TestNormaliseHeader(t *testing.T) {
	for raw, want := range map[string]string{
		"Employee Code": "employee_code",
		"employee_code": "employee_code",
		"EMPLOYEE CODE": "employee_code",
		"  Name  ":      "name",
		"Joined-On":     "joined_on",
		"_level_":       "level",
		"Class":         "class",
	} {
		if got := normaliseHeader(raw); got != want {
			t.Errorf("normaliseHeader(%q) = %q, want %q", raw, got, want)
		}
	}
}

// Spreadsheets add trailing blank lines. Reporting them as rejected rows
// teaches people that the report is noise, and then they stop reading the
// rejections that matter.
func TestAllBlank(t *testing.T) {
	if !allBlank(map[string]string{"a": "", "b": "", "c": ""}) {
		t.Error("a row of empty strings should count as blank")
	}
	if !allBlank(map[string]string{}) {
		t.Error("a row with no cells should count as blank")
	}
	if allBlank(map[string]string{"a": "", "b": "Grade 6"}) {
		t.Error("a row with one value is not blank")
	}
}

// Importing must cost exactly what the equivalent form costs. One route
// serves every entity, so the check is per spec, and a spec without a
// permission would import under whatever the route happened to allow.
func TestEveryImportSpecIsPermissioned(t *testing.T) {
	known := map[string]bool{}
	for _, p := range rbac.All {
		known[p.Key] = true
	}
	for name, spec := range importSpecs {
		if spec.Perm == "" {
			t.Errorf("%s can be imported without a permission", name)
			continue
		}
		if !known[spec.Perm] {
			t.Errorf("%s requires %q, which is not a permission this system defines", name, spec.Perm)
		}
	}
	// The one that matters most: staff are user accounts, and creating them
	// must not be reachable with academics rights.
	if importSpecs["staff"].Perm != rbac.EmployeesWrite {
		t.Errorf("staff import requires %q, want %q", importSpecs["staff"].Perm, rbac.EmployeesWrite)
	}
}

// The template is the only documentation most people will read, so it has to
// describe the file the importer actually accepts.
func TestImportTemplatesDescribeTheImporter(t *testing.T) {
	for name, spec := range importSpecs {
		if len(spec.Columns) == 0 {
			t.Errorf("%s has no columns", name)
			continue
		}
		if len(spec.Sample) != 0 && len(spec.Sample) != len(spec.Columns) {
			t.Errorf("%s: the example row has %d cells against %d columns — the template would not line up",
				name, len(spec.Sample), len(spec.Columns))
		}
		cols := map[string]bool{}
		for _, c := range spec.Columns {
			if c != normaliseHeader(c) {
				t.Errorf("%s: column %q is not in the normalised form headers are matched against", name, c)
			}
			cols[c] = true
		}
		for _, req := range spec.Required {
			if !cols[req] {
				t.Errorf("%s: %q is required but is not one of the template's columns, so the "+
					"template produces a file the importer rejects", name, req)
			}
		}
		if spec.Write == nil {
			t.Errorf("%s has no writer", name)
		}
	}
}

// A row whose required cell is only whitespace is a missing value, not a
// present one. Spreadsheets are full of stray spaces.
func TestImportSpecsRequireRealValues(t *testing.T) {
	for name, spec := range importSpecs {
		if len(spec.Required) == 0 {
			t.Errorf("%s accepts a row with nothing in it", name)
		}
		for _, req := range spec.Required {
			if strings.TrimSpace(req) != req {
				t.Errorf("%s: required column %q has whitespace in its name", name, req)
			}
		}
	}
}
