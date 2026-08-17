package tests

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

// A school must be able to set itself up.
//
// Before the setup endpoints existed the application could operate a school
// beautifully but could not create one — every class, subject and fee head had
// to be inserted in SQL. This asserts the checklist an administrator follows
// actually completes.
func TestSchoolCanSetItselfUp(t *testing.T) {
	base := baseURL(t)
	admin := arrive(t, base, "institution_admin", "Setup admin")

	var status struct {
		Steps []struct {
			Key      string `json:"key"`
			Label    string `json:"label"`
			Done     bool   `json:"done"`
			Blocking bool   `json:"blocking"`
		} `json:"steps"`
		Completed int  `json:"completed"`
		Total     int  `json:"total"`
		Ready     bool `json:"ready"`
	}
	admin.does("reads the setup checklist", "GET", "/api/v1/setup/status", nil, &status)

	if status.Total == 0 {
		t.Fatal("the checklist is empty — a new school would see no guidance at all")
	}
	t.Logf("    %d/%d steps complete, ready=%v", status.Completed, status.Total, status.Ready)

	// The seeded demo tenant is fully configured, so every blocking step should
	// already be satisfied. A gap here means setup silently lost something.
	for _, s := range status.Steps {
		if s.Blocking && !s.Done {
			t.Errorf("required setup step %q is incomplete on a configured school", s.Label)
		}
	}
}

// Bulk import must reject a bad file before writing anything, and report the
// spreadsheet row numbers so a clerk can fix it in Excel.
func TestBulkImportValidatesBeforeWriting(t *testing.T) {
	base := baseURL(t)
	admin := arrive(t, base, "institution_admin", "Import clerk")

	csv := "first_name,last_name,date_of_birth,gender,medium\n" +
		"Valid,Child,14/06/2013,female,english\n" +
		",NoName,10/10/2013,male,telugu\n" +
		"Bad,Date,not-a-date,male,english\n" +
		"Bad,Medium,01/01/2013,male,klingon\n"

	post := func(query string, into any) int {
		req, _ := http.NewRequest(http.MethodPost,
			base+"/api/v1/students/import"+query, bytes.NewReader([]byte(csv)))
		req.Header.Set("Content-Type", "text/csv")
		resp, err := admin.client.Do(req)
		if err != nil {
			t.Fatalf("import: %v", err)
		}
		defer resp.Body.Close()
		if into != nil {
			_ = json.NewDecoder(resp.Body).Decode(into)
		}
		return resp.StatusCode
	}

	var dry struct {
		Total    int  `json:"total"`
		Valid    int  `json:"valid"`
		Rejected int  `json:"rejected"`
		Imported int  `json:"imported"`
		DryRun   bool `json:"dry_run"`
		Problems []struct {
			Row     int    `json:"row"`
			Problem string `json:"problem"`
		} `json:"problems"`
	}
	if code := post("", &dry); code != 200 {
		t.Fatalf("dry run returned %d", code)
	}
	if !dry.DryRun {
		t.Error("an import with no commit flag must be a dry run")
	}
	if dry.Imported != 0 {
		t.Errorf("a dry run wrote %d students", dry.Imported)
	}
	if dry.Rejected != 3 {
		t.Errorf("expected 3 bad rows to be caught, got %d", dry.Rejected)
	}
	// Row numbers must match the spreadsheet, counting the header as row 1.
	for _, p := range dry.Problems {
		if p.Row < 2 || p.Row > 5 {
			t.Errorf("problem reported for row %d, outside the file", p.Row)
		}
	}
	t.Logf("    %d rows: %d valid, %d rejected", dry.Total, dry.Valid, dry.Rejected)

	// Committing a file that still has errors must be refused outright rather
	// than importing the good half.
	if code := post("?commit=true", nil); code != http.StatusBadRequest {
		t.Errorf("commit with invalid rows returned %d, want 400", code)
	}
}

// Every export must be permission-gated and stream real rows.
func TestExportsRespectPermissions(t *testing.T) {
	base := baseURL(t)

	admin := arrive(t, base, "institution_admin", "Principal")
	var list struct {
		Items []struct {
			Name string `json:"name"`
		} `json:"items"`
	}
	admin.does("lists available exports", "GET", "/api/v1/export", nil, &list)
	if len(list.Items) == 0 {
		t.Fatal("a principal can export nothing at all")
	}

	resp, err := admin.client.Get(base + "/api/v1/export/students")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("student export returned %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/csv; charset=utf-8" {
		t.Errorf("export content type is %q", ct)
	}
	body := readAll(t, resp)
	// Excel reads a UTF-8 CSV as ANSI without a BOM, which mangles Telugu names.
	if len(body) < 3 || body[0] != '\xef' || body[1] != '\xbb' || body[2] != '\xbf' {
		t.Error("the CSV has no UTF-8 BOM; Excel will mis-render non-ASCII names")
	}

	// A parent must not be able to export the school roll.
	parent := arrive(t, base, "parent", "Mrs Nair")
	parent.cannot("export the student roll", "GET", "/api/v1/export/students", nil, http.StatusForbidden)
	parent.cannot("export collections", "GET", "/api/v1/export/collections", nil, http.StatusForbidden)
}

// The student profile is scope-narrowed like every other student read.
func TestStudentProfileIsScoped(t *testing.T) {
	base := baseURL(t)
	admin := arrive(t, base, "institution_admin", "Principal")

	var all struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	admin.does("lists students", "GET", "/api/v1/students?limit=5", nil, &all)
	if len(all.Items) == 0 {
		t.Skip("no students")
	}

	var p struct {
		FullName   string `json:"full_name"`
		Attendance struct {
			Percent int `json:"percent"`
		} `json:"attendance"`
		Guardians []struct {
			FullName string `json:"full_name"`
		} `json:"guardians"`
	}
	admin.does("opens a student profile", "GET",
		"/api/v1/students/"+all.Items[0].ID+"/profile", nil, &p)
	if p.FullName == "" {
		t.Error("the profile has no name")
	}

	// A parent may only open their own child.
	parent := arrive(t, base, "parent", "Mrs Nair")
	var mine struct {
		Items []struct {
			StudentID string `json:"student_id"`
		} `json:"items"`
	}
	getJSON(t, parent.client, base+"/api/v1/portal/students", &mine)
	own := map[string]bool{}
	for _, m := range mine.Items {
		own[m.StudentID] = true
	}
	for _, s := range all.Items {
		if !own[s.ID] {
			parent.cannot("open another family's child profile", "GET",
				"/api/v1/students/"+s.ID+"/profile", nil, http.StatusForbidden)
			break
		}
	}
}
