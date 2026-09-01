package api

import (
	"encoding/csv"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Reading a school's own year-plan workbook.

   Every school arriving here has one already, and it is always the same
   document: a sheet per subject per grade, a row per month, and chapters
   poured into the months with a period count each. Retyping sixty sheets is
   how a migration fails, so this reads the sheet.

   What it takes is the CSV export of that workbook — one row per spreadsheet
   row, carrying the subject, the sheet name, and the columns the sheet
   already has. What it produces is a chapter list per class-subject: title,
   planned periods, in the order the year runs. No month is imported, because
   no month is stored — the months are poured on read, so importing them would
   be importing an answer instead of the question.

   It refuses to guess. A sheet whose grade cannot be resolved to a class this
   school runs, or whose subject is not one it teaches, comes back named in
   `unmatched` rather than being dropped or half-applied. Previewing is the
   default and applying is the explicit act, because the apply replaces a
   subject's chapter list and a school should see what it is about to replace.
*/

// planImportRequest carries the workbook as text. A file upload would be the
// same bytes with a multipart envelope around them; text keeps the endpoint
// testable and lets a browser paste as well as upload.
type planImportRequest struct {
	CSV string `json:"csv"`
	// Nothing is written unless this is set. The preview is the default
	// because the apply replaces a chapter list.
	Apply bool `json:"apply,omitempty"`
}

type planSheet struct {
	Subject string `json:"subject"`
	Sheet   string `json:"sheet"`
	Grade   string `json:"grade,omitempty"`

	// Resolved against what the school actually runs. Empty when it could not
	// be, which is what puts the sheet in `unmatched`.
	ClassSubjectID string `json:"class_subject_id,omitempty"`
	ClassName      string `json:"class_name,omitempty"`
	SubjectName    string `json:"subject_name,omitempty"`
	Why            string `json:"why,omitempty"`

	Units   []planUnit `json:"units"`
	Periods int        `json:"planned_periods"`
	Applied bool       `json:"applied,omitempty"`
}

type planUnit struct {
	Title   string `json:"title"`
	Periods int    `json:"planned_periods"`
}

// "(10P)", "(10 P)", "10 (p )", "( 7 )" — one workbook, six spellings. The
// count is optional: a chapter with no number is still a chapter, and
// defaulting it to one period is honest about not knowing rather than
// inventing a plausible eight.
var periodPat = regexp.MustCompile(`\(\s*(\d+)\s*[Pp]?\s*\)|(\d+)\s*\(\s*[Pp]\s*\)`)

// Roman and arabic both appear, sometimes in one workbook: "G-1", "I", "1",
// "grade4", "VIII".
var roman = map[string]int{
	"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6,
	"vii": 7, "viii": 8, "ix": 9, "x": 10, "xi": 11, "xii": 12,
}

var gradeDigits = regexp.MustCompile(`(\d+)`)

// gradeOf reads a grade out of a sheet name or a Grade: cell. Returns 0 when
// it cannot, which is a refusal rather than a guess.
func gradeOf(s string) int {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" || s == "master" {
		return 0
	}
	// Strip a leading "g-", "grade", "class".
	for _, p := range []string{"grade", "class", "g-", "g "} {
		s = strings.TrimSpace(strings.TrimPrefix(s, p))
	}
	// A sheet is often "G-8 (BIO)" or "G-9 SL": the qualifier is the stream,
	// not the grade, so only the leading token is read.
	head := strings.FieldsFunc(s, func(r rune) bool {
		return r == ' ' || r == '(' || r == '-'
	})
	if len(head) == 0 {
		return 0
	}
	first := head[0]
	if n, ok := roman[first]; ok {
		return n
	}
	if m := gradeDigits.FindString(first); m != "" {
		if n, err := strconv.Atoi(m); err == nil && n >= 1 && n <= 12 {
			return n
		}
	}
	return 0
}

// cleanTitle strips the period marker and the run of padding spaces the
// workbook uses to right-align it.
func cleanTitle(s string) string {
	s = periodPat.ReplaceAllString(s, " ")
	return strings.Join(strings.Fields(s), " ")
}

func periodsIn(s string) int {
	m := periodPat.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	for _, g := range m[1:] {
		if g == "" {
			continue
		}
		if n, err := strconv.Atoi(g); err == nil && n > 0 {
			return n
		}
	}
	return 0
}

/*
importYearPlan reads a year-plan workbook and, on request, applies it.

	Gated on academics.write: this replaces the chapter list of every subject
	it matches, which is the same authority setSyllabusUnits requires.
*/
func (s *Server) importYearPlan(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req planImportRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.CSV) == "" {
		httpx.BadRequest(w, r, "csv is required — export the workbook and send its text")
		return
	}

	rd := csv.NewReader(strings.NewReader(req.CSV))
	rd.FieldsPerRecord = -1
	records, err := rd.ReadAll()
	if err != nil {
		httpx.BadRequest(w, r, "could not read that as CSV: "+err.Error())
		return
	}
	if len(records) < 2 {
		httpx.BadRequest(w, r, "that file has no rows under its header")
		return
	}

	head := records[0]
	col := func(name string) int {
		for i, h := range head {
			if strings.EqualFold(strings.TrimSpace(h), name) {
				return i
			}
		}
		return -1
	}
	iSubject, iSheet := col("Subject"), col("Sheet_Name")
	if iSubject < 0 || iSheet < 0 {
		httpx.BadRequest(w, r,
			"expected a Subject and a Sheet_Name column — this is the flattened export, one row per spreadsheet row")
		return
	}

	/* The topic column is not at a fixed index: one workbook writes the
	   period count into the topic text and another gives it its own column,
	   which shifts everything after it. So the topic is found by its header
	   wherever it landed, and a sheet whose own header row is shifted — the
	   English G-8 sheet is — still reads, because the search is by name. */
	iTopic, iPeriods := col("TOPICS"), -1
	for i, h := range head {
		if strings.Contains(strings.ToUpper(strings.TrimSpace(h)), "NUMBER") &&
			strings.Contains(strings.ToUpper(h), "PERIOD") {
			iPeriods = i
		}
	}
	if iTopic < 0 {
		// The flattened export carries the sheet's own header in a data row,
		// so the topic column is one of the unnamed ones. Fall back to the
		// column that the header row inside the data names TOPICS.
		for _, rec := range records[1:] {
			for i, cell := range rec {
				if strings.EqualFold(strings.TrimSpace(cell), "TOPICS") {
					iTopic = i
					break
				}
			}
			if iTopic >= 0 {
				break
			}
		}
	}
	if iTopic < 0 {
		httpx.BadRequest(w, r, "could not find the TOPICS column in that file")
		return
	}

	at := func(rec []string, i int) string {
		if i < 0 || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}

	// Group into sheets, in the order they appear, keeping chapter order.
	order := []string{}
	sheets := map[string]*planSheet{}
	seen := map[string]map[string]bool{}
	for _, rec := range records[1:] {
		subject, sheet := at(rec, iSubject), at(rec, iSheet)
		if subject == "" || sheet == "" || strings.EqualFold(sheet, "MASTER") {
			continue
		}
		key := subject + "\x00" + sheet
		ps, ok := sheets[key]
		if !ok {
			ps = &planSheet{Subject: subject, Sheet: sheet}
			sheets[key] = ps
			seen[key] = map[string]bool{}
			order = append(order, key)
		}

		topic := at(rec, iTopic)
		if topic == "" || strings.EqualFold(topic, "TOPICS") {
			continue
		}
		title := cleanTitle(topic)
		low := strings.ToLower(title)
		// Structural rows and non-chapters. A bridge course is real teaching
		// but it is not a chapter of the book, and importing it as one puts a
		// unit in the syllabus that no exam can ever be set on.
		if title == "" || strings.HasPrefix(low, "y e a r") || strings.HasPrefix(low, "grade:") ||
			strings.HasPrefix(low, "teacher") || low == "bridge course" ||
			strings.HasPrefix(low, "bridge cours") || strings.HasPrefix(low, "bridge - cours") ||
			low == "revision" {
			continue
		}

		periods := periodsIn(topic)
		if periods == 0 && iPeriods >= 0 {
			if n, err := strconv.Atoi(at(rec, iPeriods)); err == nil && n > 0 {
				periods = n
			}
		}

		/* A chapter split across two months appears twice, with the periods
		   split between them — "L5: Plants (5P)" in July and "(3P)" in August.
		   The two are one chapter costing eight, so a repeat adds its periods
		   rather than making a second unit. This is the single most important
		   thing the importer does: without it a 17-chapter syllabus arrives as
		   26 units, half of them duplicates with wrong period counts. */
		if seen[key][low] {
			for i := range ps.Units {
				if strings.EqualFold(ps.Units[i].Title, title) {
					ps.Units[i].Periods += periods
					ps.Periods += periods
					break
				}
			}
			continue
		}
		seen[key][low] = true
		if periods == 0 {
			periods = 1
		}
		ps.Units = append(ps.Units, planUnit{Title: title, Periods: periods})
		ps.Periods += periods
	}

	// Resolve each sheet against the classes and subjects this school runs.
	type csRow struct{ id, class, subject string }
	var catalogue []csRow
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT cs.id::text, c.name, sub.name
			  FROM class_subjects cs
			  JOIN classes c  ON c.id = cs.class_id
			  JOIN subjects sub ON sub.id = cs.subject_id
			 ORDER BY c.level, sub.name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v csRow
			if err := rows.Scan(&v.id, &v.class, &v.subject); err != nil {
				return err
			}
			catalogue = append(catalogue, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var matched, unmatched []*planSheet
	for _, key := range order {
		ps := sheets[key]
		if len(ps.Units) == 0 {
			ps.Why = "no chapters on this sheet"
			unmatched = append(unmatched, ps)
			continue
		}
		g := gradeOf(ps.Sheet)
		if g == 0 {
			ps.Why = "could not read a grade from the sheet name"
			unmatched = append(unmatched, ps)
			continue
		}
		ps.Grade = strconv.Itoa(g)
		want := strings.ToLower(ps.Subject)
		var hit *csRow
		for i := range catalogue {
			c := &catalogue[i]
			if gradeOf(c.class) != g {
				continue
			}
			cs := strings.ToLower(c.subject)
			if cs == want || strings.Contains(cs, want) || strings.Contains(want, cs) {
				hit = c
				break
			}
		}
		if hit == nil {
			ps.Why = "this school has no " + ps.Subject + " in class " + ps.Grade
			unmatched = append(unmatched, ps)
			continue
		}
		ps.ClassSubjectID, ps.ClassName, ps.SubjectName = hit.id, hit.class, hit.subject
		matched = append(matched, ps)
	}

	applied := 0
	if req.Apply && len(matched) > 0 {
		// Through the same write the syllabus screen uses, so an imported
		// chapter list and a typed one cannot drift apart — and so the rule
		// that a chapter already taught is never deleted holds here too.
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			for _, ps := range matched {
				if err := replaceSyllabusUnits(r, tx, ps.ClassSubjectID, ps.Units); err != nil {
					return err
				}
				ps.Applied = true
				applied++
			}
			return nil
		})
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
	}

	units := 0
	for _, ps := range matched {
		units += len(ps.Units)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"applied":   req.Apply,
		"matched":   matched,
		"unmatched": unmatched,
		"summary": map[string]any{
			"sheets_matched":   len(matched),
			"sheets_unmatched": len(unmatched),
			"chapters":         units,
			"subjects_written": applied,
		},
	})
}
