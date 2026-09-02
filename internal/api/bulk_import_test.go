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

// The dry run has to catch everything the writer would reject. A dry run that
// passes a row the commit then fails on is worse than none, because it is
// trusted: the clerk fixes what they were told about and the import still
// breaks, on a row the check had already seen.
func TestDryRunCatchesWhatTheWriterWouldReject(t *testing.T) {
	classes := importSpecs["classes"]
	if classes.Check == nil {
		t.Fatal("classes has no dry-run check, so a non-numeric level reports as valid")
	}
	/* Every value is put through both sides, because the invariant is that
	   they agree, not that some list of literals is refused. The two sides
	   were once two separate readings of the same cell -- the check parsed it
	   one way, the writer called strconv.Atoi and dropped the error -- and
	   that is exactly the shape of drift a list of literals stops catching the
	   day somebody edits one side.

	   -3 and a blank cell are good rows, not bad ones. -3 is Nursery: the
	   pre-school years are numbered below Class 1 and a school may type them.
	   Blank is the ordinary case -- "Grade 8" has already said eight, and the
	   template's own example row leaves the column empty, so a check that
	   refused it would refuse the file the product ships as the example. */
	for _, tc := range []struct {
		level string
		want  int
		ok    bool
	}{
		{"8", 8, true},
		{"", 8, true},    // taken from "Grade 8"
		{"-3", -3, true}, // Nursery
		{"15", 15, true},
		{"notanumber", 0, false},
		{"six", 0, false},
		{"0", 0, false},   // level is NOT NULL and zero is what an unparsed cell becomes
		{"16", 0, false},  // past any school year, so it is a room number read as a class
		{"-9", 0, false},  // below the pre-school years, so it is nothing
		{"8.5", 0, false}, // a class is a whole year
	} {
		checkErr := classes.Check(map[string]string{"name": "Grade 8", "level": tc.level})
		got, writeErr := classImportLevel(map[string]string{"name": "Grade 8", "level": tc.level})
		if tc.ok {
			if checkErr != nil {
				t.Errorf("level %q is a good row and the dry run rejected it: %v", tc.level, checkErr)
			}
			if got != tc.want {
				t.Errorf("level %q resolved to %d, want %d", tc.level, got, tc.want)
			}
		} else if checkErr == nil {
			t.Errorf("level %q passed the dry run but the writer would reject it", tc.level)
		}
		if (checkErr == nil) != (writeErr == nil) {
			t.Errorf("level %q: dry run says %v and the writer says %v, so a file that "+
				"passed the check would fail the commit", tc.level, checkErr, writeErr)
		}
	}

	// A name with no year in it cannot be derived from, and has to be reported
	// while the file can still be fixed rather than at the commit.
	if err := classes.Check(map[string]string{"name": "VI-A", "level": ""}); err == nil {
		t.Error("a name with no year in it passed the dry run")
	}

	// The template's example row is the file most schools upload first, so it
	// has to pass its own importer.
	if sample := importSpecs["classes"].Sample; len(sample) == 3 {
		if err := classes.Check(map[string]string{
			"name": sample[0], "level": sample[1], "stream": sample[2],
		}); err != nil {
			t.Errorf("the classes template's own example row fails the dry run: %v", err)
		}
	}

	sections := importSpecs["sections"]
	// Capacity is optional, so blank must pass and rubbish must not.
	if err := sections.Check(map[string]string{"class": "Grade 6", "name": "A", "capacity": ""}); err != nil {
		t.Errorf("a blank capacity should be allowed: %v", err)
	}
	for _, bad := range []string{"forty", "0", "-1"} {
		if err := sections.Check(map[string]string{"class": "Grade 6", "name": "A", "capacity": bad}); err == nil {
			t.Errorf("capacity %q passed the dry run", bad)
		}
	}

	staff := importSpecs["staff"]
	if err := staff.Check(map[string]string{"employee_code": "T-1", "first_name": "Priya", "joined_on": "01/06/2026"}); err == nil {
		t.Error("a date in the wrong format passed the dry run")
	}
	if err := staff.Check(map[string]string{"employee_code": "T-1", "first_name": "Priya", "joined_on": ""}); err != nil {
		t.Errorf("a blank joining date should be allowed: %v", err)
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
