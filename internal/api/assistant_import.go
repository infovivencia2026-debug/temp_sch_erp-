package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* THE ASSISTANT CAN IMPORT A SPREADSHEET -- BUT NOT ANY SPREADSHEET.

   The chat protocol in assistant_actions.go carries a small JSON action and
   cannot carry a file, so importing has its own pair of multipart endpoints.
   They do NOT reimplement importing: they drive the exact same validated,
   undoable pipeline the /setup/import screens use (runBulkImportCSV for the
   shared importers, importStudents for the one that predates them), so an
   in-chat import behaves identically to one done from the setup screen -- same
   dry run, same per-row errors, same import_runs record that Undo reads.

   Two guards, re-checked on the server on every call and never trusted from the
   client:
     1. The entity must be on the allowlist below -- the assistant red line. Pay
        and login/security imports are deliberately absent, so the bot can never
        be talked into loading a salary sheet or a table of passwords.
     2. The caller must hold the SAME permission the equivalent setup import
        requires for that entity. Importing staff attendance costs what marking
        staff attendance costs; the assistant grants nothing extra.
   Every write runs under InTenant(tenantScope(id)), so RLS confines it to the
   caller's own school exactly as the setup screen's import does. */

/* assistantImportableEntities is the assistant's red line, in one place.

   Presence here = the bot may import it, and the value is the human label shown
   on the confirm card. The excluded entities are as important as the included
   ones: staff_payroll and payslips (pay), and staff / staff_history (which
   create staff records and their logins) are NOT here and can never be imported
   through the assistant, no matter how a request is phrased. Everything a school
   office legitimately loads in bulk is. */
var assistantImportableEntities = map[string]string{
	"classes":          "Classes and sections",
	"sections":         "Sections",
	"subjects":         "Subjects",
	"periods":          "Periods",
	"holidays":         "Holidays and calendar",
	"timetable":        "Timetable",
	"class_subjects":   "Class subjects",
	"allocations":      "Teacher allocations",
	"marks":            "Marks",
	"marks_grid":       "Marks (grid)",
	"attendance":       "Student attendance",
	"staff_attendance": "Staff attendance",
	"students":         "Students",
	"student_history":  "Student history",
	"fee_heads":        "Fee heads",
	"fee_structures":   "Fee structures",
	"fee_payments":     "Fee payments",
	"punches":          "Biometric punches",
	// student_exits is deliberately NOT here. Marking students as having left is
	// the one bulk lifecycle change close enough to a deletion that a bot
	// misreading "remove these students" should never be able to run it, even
	// with a confirm card. It stays available on the setup screen, to a person.
}

// assistantImportPerm is the permission this entity's setup import requires,
// re-checked server-side. Students predates the shared importSpecs and carries
// its own permission (the same one its /students/import route is gated on).
func assistantImportPerm(entity string) string {
	if entity == "students" {
		return rbac.StudentsWrite
	}
	if spec, ok := importSpecs[entity]; ok {
		return spec.Perm
	}
	return ""
}

// assistantImportResponse is the confirm-card payload for both preview and
// commit. On preview it is a dry run (nothing written); on commit Imported and
// RunID are set and DryRun is false.
type assistantImportResponse struct {
	Entity   string      `json:"entity"`
	Label    string      `json:"label"`
	Total    int         `json:"total"`
	Ok       int         `json:"ok"`
	Rejected int         `json:"rejected"`
	Imported int         `json:"imported"`
	DryRun   bool        `json:"dry_run"`
	Summary  string      `json:"summary"`
	Problems []importRow `json:"problems"`
	RunID    string      `json:"run_id,omitempty"`
}

// The most rows worth of problems to hand the chat panel: a confirm card is not
// a spreadsheet, and a person with two hundred bad rows needs the count and a
// sample, not two hundred lines in a corner panel.
const assistantImportMaxProblems = 20

func (s *Server) assistantImportPreview(w http.ResponseWriter, r *http.Request) {
	s.assistantImport(w, r, false)
}

func (s *Server) assistantImportCommit(w http.ResponseWriter, r *http.Request) {
	s.assistantImport(w, r, true)
}

// assistantImport gates identity, the allowlist and the per-entity permission,
// reads the uploaded CSV, and runs the shared importer's dry-run (preview) or
// dry-run-then-commit (commit) path.
func (s *Server) assistantImport(w http.ResponseWriter, r *http.Request, commit bool) {
	if !requireInstitution(w, r) {
		return
	}
	id := httpx.IdentityFrom(r.Context())

	// 9 MB of form to hold the 8 MB the importers cap a file at, plus the small
	// `entity` field beside it.
	if err := r.ParseMultipartForm(9 << 20); err != nil {
		httpx.BadRequest(w, r,
			"send the spreadsheet as multipart form data, with the file in `file` and the kind in `entity`.")
		return
	}

	entity := strings.TrimSpace(r.FormValue("entity"))
	label, ok := assistantImportableEntities[entity]
	if !ok {
		/* The red line, stated plainly rather than as a generic refusal, so the
		   bot can relay a reason a person can act on. A pay or login sheet lands
		   here on purpose. */
		httpx.Error(w, r, http.StatusForbidden, "forbidden",
			"the assistant cannot import "+quoteEntity(entity)+". "+
				"It can import class lists, subjects, timetables, marks, attendance, "+
				"students, fees and similar, but never pay, payslips or staff logins. "+
				"Those must be done by someone with the right access on the setup screen.")
		return
	}

	perm := assistantImportPerm(entity)
	if perm == "" || !id.Can(perm) {
		httpx.Forbidden(w, r, perm)
		return
	}

	file, hdr, err := r.FormFile("file")
	if err != nil {
		httpx.BadRequest(w, r, "attach the spreadsheet as a CSV in the `file` field.")
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 8<<20))
	if err != nil || len(raw) == 0 {
		httpx.BadRequest(w, r, "that file was empty or could not be read. Save it as CSV and try again.")
		return
	}
	filename := ""
	if hdr != nil {
		filename = hdr.Filename
	}

	out, clientMsg, serverErr := s.assistantRunImport(r, id, entity, raw, filename, commit)
	if serverErr != nil {
		httpx.Internal(w, r, serverErr)
		return
	}
	if clientMsg != "" {
		httpx.BadRequest(w, r, clientMsg)
		return
	}

	resp := assistantImportResponse{
		Entity:   entity,
		Label:    label,
		Total:    out.Total,
		Ok:       out.Valid,
		Rejected: out.Rejected,
		Imported: out.Imported,
		DryRun:   out.DryRun,
		Problems: out.Problems,
		RunID:    out.RunID,
	}
	// On a commit the good rows have already been written, so what is "ok" is
	// what landed rather than what merely validated.
	if commit {
		resp.Ok = out.Imported
	}
	if len(resp.Problems) > assistantImportMaxProblems {
		resp.Problems = resp.Problems[:assistantImportMaxProblems]
	}
	if resp.Problems == nil {
		resp.Problems = []importRow{}
	}
	resp.Summary = assistantImportSummary(resp, commit)

	httpx.JSON(w, http.StatusOK, resp)
}

// assistantRunImport dispatches to the right existing pipeline: the shared
// engine for importSpecs entities, and the standalone students importer for
// "students", which predates importSpecs and has its own handler. Both produce
// the same importResult and the same undoable import_runs record.
func (s *Server) assistantRunImport(r *http.Request, id *httpx.Identity, entity string, raw []byte, filename string, commit bool) (importResult, string, error) {
	if entity == "students" {
		return s.assistantRunStudents(r, raw, filename, commit)
	}
	// runBulkImportCSV reads the filename off the query, the way the setup route
	// passes it; set it so the kept upload is named in the history.
	q := r.URL.Query()
	q.Set("filename", filename)
	r.URL.RawQuery = q.Encode()
	return s.runBulkImportCSV(r, id, entity, importSpecs[entity], raw, commit)
}

/* assistantRunStudents drives the standalone students importer.

   importStudents is a whole HTTP handler with its own parsing and its own undo
   record, and factoring it apart the way the shared importer was is a larger
   change than this feature needs. Instead the raw CSV is handed to it through an
   internal request that carries the caller's own context -- so IdentityFrom and
   the tenant scope inside it are the caller's -- and its JSON reply is read back
   into the same importResult shape. Nothing about the write changes: it is the
   exact code the /students/import route runs. */
func (s *Server) assistantRunStudents(r *http.Request, raw []byte, filename string, commit bool) (importResult, string, error) {
	req := r.Clone(r.Context())
	req.Method = http.MethodPost
	req.Body = io.NopCloser(bytes.NewReader(raw))
	req.ContentLength = int64(len(raw))
	// A clean header set: importStudents reads the body directly and never the
	// multipart Content-Type, and a stray X-Column-Map must not be carried in.
	req.Header = http.Header{}
	q := url.Values{}
	q.Set("commit", strconv.FormatBool(commit))
	q.Set("filename", filename)
	req.URL.RawQuery = q.Encode()

	rec := httptest.NewRecorder()
	s.importStudents(rec, req)
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)

	if res.StatusCode == http.StatusOK {
		var out importResult
		if err := json.Unmarshal(body, &out); err != nil {
			return importResult{}, "", err
		}
		return out, "", nil
	}
	// A client-facing refusal from importStudents (bad header, bad file) is
	// relayed as the same kind of message the shared path returns.
	var e struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &e)
	msg := strings.TrimSpace(e.Error.Message)
	if msg == "" {
		msg = "that students file could not be read. Save it as CSV from the template and try again."
	}
	return importResult{}, msg, nil
}

// assistantImportSummary is the one-line, human summary the confirm card leads
// with -- a dry run says what is ready, a commit says what landed.
func assistantImportSummary(resp assistantImportResponse, commit bool) string {
	if commit {
		s := "Imported " + plural(resp.Imported, "row", "rows") + "."
		if resp.Rejected > 0 {
			s += " " + plural(resp.Rejected, "row", "rows") + " had problems and were skipped."
		}
		s += " You can undo this from Setup > Import history if it was not what you meant."
		return s
	}
	if resp.Total == 0 {
		return "That file has no rows to import. Check it was saved as CSV from the template."
	}
	if resp.Rejected == 0 {
		return fmt.Sprintf("Ready to import %s as %s. Nothing has been changed yet.",
			plural(resp.Ok, "row", "rows"), resp.Label)
	}
	return fmt.Sprintf("%d of %s are ready to import as %s; %d have problems (shown below). "+
		"Nothing has been changed yet.",
		resp.Ok, plural(resp.Total, "row", "rows"), resp.Label, resp.Rejected)
}

func quoteEntity(e string) string {
	if e == "" {
		return "that"
	}
	return `"` + e + `"`
}
