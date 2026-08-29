package api

import (
	"fmt"
	"html"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The school's own report card.

   Every school has a design for this one document — the crest, the motto, the
   grade scale down the side, two signature lines — and until now this product
   printed its own. A school that cannot print its own report card keeps using
   the stationer's and types every mark in twice.

   So the layout is an HTML body with {{placeholders}}, imported from a file,
   stored per institution, and used by every card printed until somebody
   imports another. The same shape certificate_types already uses, because a
   school that has designed one has learnt the vocabulary for the other.

   The built-in design below is the default. It is served whenever a school has
   imported nothing, which means a school that never touches this still gets a
   proper card, and improvements to it reach every such school rather than only
   the ones set up after today.
*/

// reportCardPlaceholders is the vocabulary a template may use. Published by
// the GET, so somebody designing one is not guessing at names — a placeholder
// listed but not substituted prints as literal braces on a school's card.
var reportCardPlaceholders = []map[string]string{
	{"token": "{{school_name}}", "means": "the school's name"},
	{"token": "{{school_logo}}", "means": "the school's crest, where one is configured"},
	{"token": "{{school_motto}}", "means": "the school's tagline, where one is configured"},
	{"token": "{{academic_year}}", "means": "the academic year, e.g. 2024 - 2025"},
	{"token": "{{exam_name}}", "means": "which examination this card is for"},
	{"token": "{{photo}}", "means": "the child's photograph, where one is on file"},
	{"token": "{{student_name}}", "means": "the child's full name"},
	{"token": "{{father_name}}", "means": "father's name, where recorded"},
	{"token": "{{mother_name}}", "means": "mother's name, where recorded"},
	{"token": "{{guardian_name}}", "means": "the guardian on record"},
	{"token": "{{class}}", "means": "class"},
	{"token": "{{section}}", "means": "section"},
	{"token": "{{admission_no}}", "means": "admission number"},
	{"token": "{{roll_no}}", "means": "roll number"},
	{"token": "{{date_of_birth}}", "means": "date of birth"},
	{"token": "{{admission_date}}", "means": "date of admission"},
	{"token": "{{subject_rows}}", "means": "one table row per subject — marks, percentage and grade"},
	{"token": "{{total_marks}}", "means": "marks the exam was out of"},
	{"token": "{{marks_obtained}}", "means": "marks the child scored"},
	{"token": "{{percentage}}", "means": "overall percentage"},
	{"token": "{{grade}}", "means": "overall grade"},
	{"token": "{{result}}", "means": "PASS or FAIL, on the school's own pass mark"},
	{"token": "{{rank}}", "means": "rank in the section"},
	{"token": "{{attendance}}", "means": "attendance percentage"},
	{"token": "{{class_teacher}}", "means": "the class teacher who sent it for approval"},
	{"token": "{{class_teacher_sign}}", "means": "their signature, once they have sent it up"},
	{"token": "{{principal}}", "means": "the head who approved it"},
	{"token": "{{principal_sign}}", "means": "their signature, once they have approved it"},
	{"token": "{{issued_on}}", "means": "today's date"},
}

/*
defaultReportCardHTML is the card a school gets before it imports its own.

	Deliberately plain-CSS and self-contained: it is printed by the browser and
	emailed as a body, and neither honours a stylesheet fetched from anywhere.
	Sizes are in millimetres because the output is a sheet of A4, not a screen.
*/
const defaultReportCardHTML = `<div class="card">
  <header>
    <div class="crest">{{school_logo}}</div>
    <h1>{{school_name}}</h1>
    <div class="motto">{{school_motto}}</div>
    <div class="rule"></div>
    <h2>REPORT CARD</h2>
    <div class="meta">{{academic_year}} &nbsp;·&nbsp; {{exam_name}}</div>
  </header>

  <section class="who">
    <div class="photo">{{photo}}</div>
    <table class="facts">
      <tr><th>Student name</th><td>{{student_name}}</td></tr>
      <tr><th>Father's name</th><td>{{father_name}}</td></tr>
      <tr><th>Mother's name</th><td>{{mother_name}}</td></tr>
      <tr><th>Class &amp; section</th><td>{{class}} - {{section}}</td></tr>
      <tr><th>Admission no.</th><td>{{admission_no}}</td></tr>
      <tr><th>Roll no.</th><td>{{roll_no}}</td></tr>
      <tr><th>Date of birth</th><td>{{date_of_birth}}</td></tr>
    </table>
  </section>

  <table class="marks">
    <thead>
      <tr>
        <th>Subject</th><th>Maximum marks</th><th>Marks obtained</th>
        <th>Percentage</th><th>Grade</th>
      </tr>
    </thead>
    <tbody>
      {{subject_rows}}
    </tbody>
    <tfoot>
      <tr>
        <th>Total</th><th>{{total_marks}}</th><th>{{marks_obtained}}</th>
        <th>{{percentage}}</th><th>{{grade}}</th>
      </tr>
    </tfoot>
  </table>

  <section class="summary">
    <div><span>Result</span><strong>{{result}}</strong></div>
    <div><span>Rank in section</span><strong>{{rank}}</strong></div>
    <div><span>Attendance</span><strong>{{attendance}}</strong></div>
  </section>

  <footer>
    <div class="sign">
      <div class="ink">{{class_teacher_sign}}</div>
      <span></span>{{class_teacher}}<em>Class teacher</em>
    </div>
    <div class="issued">Issued {{issued_on}}</div>
    <div class="sign">
      <div class="ink">{{principal_sign}}</div>
      <span></span>{{principal}}<em>Principal</em>
    </div>
  </footer>
</div>`

// defaultReportCardCSS is served with the body and only with the built-in
// design. A school that imports its own brings its own styling; injecting this
// underneath would fight it.
const defaultReportCardCSS = `
.card { width: 190mm; margin: 0 auto; padding: 8mm; box-sizing: border-box;
        border: 2px solid #1e3a5f;
        /* Arial first, then Calibri, then Times New Roman. What a school
           already prints on: the fonts on every office machine in the country,
           and the three a head asked for by name. Georgia was a web font
           choice on a document that is read on paper. */
        font: 11pt/1.45 Arial, Calibri, 'Times New Roman', sans-serif;
        color: #14213d; background: #fff; }
.card header { text-align: center; }
/* The crest, where the school has one. The block collapses to nothing when it
   is empty, so a school that has not set one gets a title where the title
   belongs rather than a gap above it. */
.card .crest:empty { display: none; }
.card .crest img { height: 18mm; width: auto; margin-bottom: 2mm; }
.card .motto:empty { display: none; }
.card .motto { font-size: 9.5pt; font-style: italic; color: #4a5568; margin-top: 1mm; }
.card h1 { margin: 0; font-size: 20pt; letter-spacing: .5px; text-transform: uppercase; }
.card h2 { margin: 3mm 0 1mm; font-size: 12pt; letter-spacing: 3px;
           background: #1e3a5f; color: #fff; display: inline-block; padding: 1.5mm 8mm; }
.card .rule { height: 1px; background: #c9a227; margin: 2mm 0; }
.card .meta { font-size: 9.5pt; color: #4a5568; }
.card .who { display: flex; gap: 6mm; margin: 5mm 0; align-items: flex-start; }
.card .photo { width: 28mm; height: 34mm; border: 1px solid #cbd5e0; flex: 0 0 auto;
               display: flex; align-items: center; justify-content: center; overflow: hidden; }
.card .photo img { width: 100%; height: 100%; object-fit: cover; }
.card .facts { flex: 1; border-collapse: collapse; font-size: 10pt; }
.card .facts th { text-align: left; font-weight: normal; color: #4a5568;
                  padding: 1mm 4mm 1mm 0; white-space: nowrap; }
.card .facts td { font-weight: bold; padding: 1mm 0; }
.card table.marks { width: 100%; border-collapse: collapse; font-size: 10pt; }
.card table.marks th, .card table.marks td { border: 1px solid #99a; padding: 1.6mm 2mm; }
.card table.marks thead th, .card table.marks tfoot th {
        background: #1e3a5f; color: #fff; }
.card table.marks td:first-child, .card table.marks th:first-child { text-align: left; }
.card table.marks td { text-align: center; }
.card .summary { display: flex; gap: 4mm; margin: 5mm 0; }
.card .summary div { flex: 1; border: 1px solid #cbd5e0; padding: 2.5mm; text-align: center; }
.card .summary span { display: block; font-size: 8.5pt; color: #4a5568;
                      text-transform: uppercase; letter-spacing: .5px; }
.card .summary strong { font-size: 12pt; }
/* The signature sits ON the line, not above a gap. Fixed height so a tall
   scan and a wide one both land in the same place and the two feet of the card
   stay level. Empty until the person has actually signed — a card still with
   the class teacher shows one line signed and one blank, which is exactly what
   it is. */
.card footer .ink { height: 12mm; display: flex; align-items: flex-end;
                    justify-content: center; }
.card footer .ink img { max-height: 12mm; max-width: 45mm; }
.card footer { display: flex; align-items: flex-end; justify-content: space-between;
               margin-top: 10mm; font-size: 9.5pt; }
.card footer .sign { text-align: center; }
.card footer .sign span { display: block; width: 45mm; border-top: 1px solid #14213d;
                          margin-bottom: 1mm; }
.card footer .sign em { display: block; font-style: normal; font-size: 8.5pt; color: #4a5568; }
.card footer .issued { color: #4a5568; }
@media print { .card { border: none; padding: 0; } }
`

type reportCardTemplate struct {
	Name string `json:"name"`
	HTML string `json:"template_html"`
	// True while the school has imported nothing and is printing the built-in
	// design. The screen says so, because "we have a template" and "we are
	// using the one that came with it" are different answers.
	IsBuiltIn bool    `json:"is_built_in"`
	CSS       string  `json:"css,omitempty"`
	UpdatedAt *string `json:"updated_at,omitempty"`
	UpdatedBy *string `json:"updated_by,omitempty"`
}

// loadReportCardTemplate reads the school's design, or the built-in one.
func (s *Server) loadReportCardTemplate(r *http.Request) (reportCardTemplate, error) {
	id := httpx.IdentityFrom(r.Context())
	out := reportCardTemplate{
		Name: "Standard report card", HTML: defaultReportCardHTML,
		IsBuiltIn: true, CSS: defaultReportCardCSS,
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var name, body string
		var at string
		var by *string
		err := tx.QueryRow(r.Context(), `
			SELECT t.name, t.template_html,
			       to_char(t.updated_at, 'YYYY-MM-DD"T"HH24:MI'), u.full_name
			  FROM report_card_templates t
			  LEFT JOIN users u ON u.id = t.updated_by
			 WHERE t.institution_id = $1`, id.InstitutionID).Scan(&name, &body, &at, &by)
		if err != nil {
			if strings.Contains(err.Error(), "no rows") {
				return nil
			}
			return err
		}
		out = reportCardTemplate{Name: name, HTML: body, IsBuiltIn: false,
			UpdatedAt: &at, UpdatedBy: by}
		return nil
	})
	return out, err
}

func (s *Server) getReportCardTemplate(w http.ResponseWriter, r *http.Request) {
	t, err := s.loadReportCardTemplate(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"template":     t,
		"placeholders": reportCardPlaceholders,
		// The built-in body, always — so "start from the standard one and
		// change three things" is possible without anybody hunting for a file.
		"default_html": defaultReportCardHTML,
	})
}

type reportCardTemplateRequest struct {
	Name string `json:"name"`
	HTML string `json:"template_html"`
}

// saveReportCardTemplate takes the imported file and makes it the school's.
func (s *Server) saveReportCardTemplate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req reportCardTemplateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	body := strings.TrimSpace(req.HTML)
	if body == "" {
		httpx.BadRequest(w, r, "the file is empty — import the report card design itself")
		return
	}
	if len(body) > 400_000 {
		httpx.BadRequest(w, r,
			"that file is too large for a report card design — 400 KB is the limit, "+
				"and a card that big is usually an image pasted into a document")
		return
	}
	/* A design with no marks on it is not a report card.

	   The commonest import mistake is a PDF saved as .html, or a Word export
	   that dropped every placeholder — both produce a file that saves cleanly
	   and prints the same page for every child in the school. Refusing here
	   costs a moment; the alternative is discovering it at the front desk. */
	if !strings.Contains(body, "{{student_name}}") || !strings.Contains(body, "{{subject_rows}}") {
		httpx.BadRequest(w, r,
			"this design uses neither {{student_name}} nor {{subject_rows}}, so every "+
				"child would get the same page — check the placeholder list on this screen "+
				"and put them in the file")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "School report card"
	}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			INSERT INTO report_card_templates
			       (institution_id, name, template_html, updated_at, updated_by)
			VALUES ($1, $2, $3, now(), $4)
			ON CONFLICT (institution_id) DO UPDATE
			   SET name = EXCLUDED.name, template_html = EXCLUDED.template_html,
			       updated_at = now(), updated_by = EXCLUDED.updated_by`,
			id.InstitutionID, name, body, id.UserID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true, "name": name})
}

// resetReportCardTemplate goes back to the design this product ships.
func (s *Server) resetReportCardTemplate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(),
			`DELETE FROM report_card_templates WHERE institution_id = $1`, id.InstitutionID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// Deleting rather than writing the built-in body back: an empty table means
	// "the current default", which keeps following improvements to it.
	httpx.JSON(w, http.StatusOK, map[string]any{"reset": true})
}

// ------------------------------------------------------------------ rendering

type renderedCard struct {
	values   map[string]string
	subjects []map[string]string
}

// fillReportCard substitutes the vocabulary into a template body.
//
// Everything substituted is escaped, except {{photo}} and {{subject_rows}},
// which this function builds itself — a child named "R&D" must not break the
// page, and a remark somebody typed must not be able to carry markup onto a
// document the school signs.
func fillReportCard(tpl string, c renderedCard) string {
	var rows strings.Builder
	for _, sub := range c.subjects {
		rows.WriteString("<tr>")
		for _, k := range []string{"subject", "max_marks", "marks", "percent", "subject_grade"} {
			rows.WriteString("<td>" + html.EscapeString(sub[k]) + "</td>")
		}
		rows.WriteString("</tr>")
	}
	out := strings.ReplaceAll(tpl, "{{subject_rows}}", rows.String())

	/* The two values that are markup, and the only two.

	   Empty when there is nothing on file, so the frame prints blank rather
	   than showing a browser's broken-image icon on a document a family
	   keeps. */
	out = strings.ReplaceAll(out, "{{photo}}", imgTag(c.values["photo_file_id"]))
	out = strings.ReplaceAll(out, "{{school_logo}}", imgTag(c.values["logo_file_id"]))
	out = strings.ReplaceAll(out, "{{class_teacher_sign}}", imgTag(c.values["teacher_sign_file_id"]))
	out = strings.ReplaceAll(out, "{{principal_sign}}", imgTag(c.values["principal_sign_file_id"]))

	for k, v := range c.values {
		switch k {
		case "photo_file_id", "logo_file_id",
			"teacher_sign_file_id", "principal_sign_file_id":
			continue
		}
		out = strings.ReplaceAll(out, "{{"+k+"}}", html.EscapeString(v))
	}
	/* Anything left is a placeholder the school invented or misspelt.

	   Blanked rather than left showing: "{{fathers_name}}" printed on a card a
	   parent keeps is worse than a blank, and the misspelling is visible on the
	   preview either way. */
	return stripUnknownPlaceholders(out)
}

/*
imgTag renders a stored file as an image, or nothing at all.

	The id is checked for shape rather than trusted: logo_key is a free-text
	column an operator types into, and anything that is not a file id would
	otherwise become a request for a path of somebody's choosing.
*/
func imgTag(id string) string {
	if _, err := uuid.Parse(strings.TrimSpace(id)); err != nil {
		return ""
	}
	return `<img src="/api/v1/files/` + html.EscapeString(strings.TrimSpace(id)) + `" alt="">`
}

func stripUnknownPlaceholders(s string) string {
	for {
		i := strings.Index(s, "{{")
		if i < 0 {
			return s
		}
		j := strings.Index(s[i:], "}}")
		if j < 0 {
			return s
		}
		s = s[:i] + s[i+j+2:]
	}
}

// renderReportCard returns one child's card as HTML, for the preview, the
// printer and the email body.
func (s *Server) renderReportCard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	cardID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("id")))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	tpl, err := s.loadReportCardTemplate(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var body string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		c, err := s.gatherReportCard(r, tx, cardID)
		if err != nil {
			return err
		}
		body = fillReportCard(tpl.HTML, c)
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"html": body, "css": tpl.CSS, "is_built_in": tpl.IsBuiltIn,
	})
}

// gatherReportCard collects everything the vocabulary can name for one card.
func (s *Server) gatherReportCard(r *http.Request, tx pgx.Tx, cardID uuid.UUID) (renderedCard, error) {
	c := renderedCard{values: map[string]string{}}

	var (
		school, student, class, section, admissionNo                        string
		roll, dob, admitted, photo, father, mother, guardian                *string
		total, obtained, pct, attendance                                    *float64
		grade, remark, examName, year, classTeacher, principalName, rankStr *string
		logoKey, motto                                                      *string
		teacherSign, principalSign                                          *string
	)
	err := tx.QueryRow(r.Context(), `
		SELECT i.name, i.logo_key,
		       /* The school's own words under its own name. Read from the
		          institution-wide branding row rather than a campus one: a
		          report card carries the school's motto, and a campus that has
		          overridden its login banner has not changed the school. */
		       (SELECT b.tagline FROM branding_profiles b
		         WHERE b.campus_id IS NULL LIMIT 1),
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       COALESCE(c.name,''), COALESCE(sec.name,''), st.admission_no,
		       e.roll_no::text,
		       to_char(st.date_of_birth, 'DD/MM/YYYY'),
		       to_char(st.admission_date, 'DD/MM/YYYY'),
		       st.photo_file_id::text,
		       /* Father and mother are guardian rows with a relation, not
		          columns on the child: a family with two mothers, a child
		          raised by an uncle, and a single parent are all ordinary, and
		          two fixed columns cannot hold any of them. Read by relation
		          and left blank when there is none. */
		       (SELECT g.full_name FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id AND g.relation = 'father' LIMIT 1),
		       (SELECT g.full_name FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id AND g.relation = 'mother' LIMIT 1),
		       (SELECT g.full_name FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id ORDER BY sg.is_primary DESC NULLS LAST LIMIT 1),
		       rc.max_marks, rc.total_marks, rc.percentage, rc.attendance_percent,
		       rc.grade, NULL::text,
		       (SELECT ex.name FROM exams ex
		         WHERE ex.academic_year_id = rc.academic_year_id
		         ORDER BY ex.created_at DESC LIMIT 1),
		       ay.name,
		       /* Who actually signed, not who holds the post.

		          The class teacher line is the person who SENT IT UP, read from
		          submitted_by, falling back to whoever the section's class
		          teacher is while it is still a draft. The head's line is
		          decided_by and has no fallback: a card nobody has approved must
		          not carry a head's name, because the whole point of the
		          signature is that they read it. */
		       COALESCE(
		         (SELECT u.full_name FROM users u WHERE u.id = rc.submitted_by),
		         (SELECT u.full_name FROM users u WHERE u.id = sec.class_teacher_id)),
		       (SELECT u2.full_name FROM users u2 WHERE u2.id = rc.decided_by),
		       (SELECT u.signature_file_id::text FROM users u WHERE u.id = rc.submitted_by),
		       (SELECT u2.signature_file_id::text FROM users u2 WHERE u2.id = rc.decided_by),
		       rc.rank_in_section::text
		  FROM report_cards rc
		  JOIN students st       ON st.id = rc.student_id
		  JOIN institutions i    ON i.id = rc.institution_id
		  JOIN enrollments e     ON e.id = rc.enrollment_id
		  LEFT JOIN sections sec ON sec.id = e.section_id
		  LEFT JOIN classes c    ON c.id = sec.class_id
		  LEFT JOIN academic_years ay ON ay.id = rc.academic_year_id
		 WHERE rc.id = $1`, cardID).Scan(
		&school, &logoKey, &motto,
		&student, &class, &section, &admissionNo, &roll, &dob, &admitted,
		&photo, &father, &mother, &guardian,
		&total, &obtained, &pct, &attendance, &grade, &remark,
		&examName, &year, &classTeacher, &principalName,
		&teacherSign, &principalSign, &rankStr)
	if err != nil {
		return c, err
	}

	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	num := func(p *float64) string {
		if p == nil {
			return ""
		}
		return strconv.FormatFloat(*p, 'f', -1, 64)
	}

	c.values = map[string]string{
		"school_name": school, "student_name": student,
		"logo_file_id": str(logoKey), "school_motto": str(motto),
		"teacher_sign_file_id":   str(teacherSign),
		"principal_sign_file_id": str(principalSign),
		"class":                  class, "section": section, "admission_no": admissionNo,
		"roll_no": str(roll), "date_of_birth": str(dob), "admission_date": str(admitted),
		"photo_file_id": str(photo),
		"father_name":   str(father), "mother_name": str(mother),
		"guardian_name": str(guardian),
		"total_marks":   num(total), "marks_obtained": num(obtained),
		"grade": str(grade), "remarks": str(remark),
		"exam_name": str(examName), "academic_year": str(year),
		"class_teacher": str(classTeacher), "principal": str(principalName),
		"rank":       str(rankStr),
		"issued_on":  time.Now().In(indiaTZ()).Format("02/01/2006"),
		"percentage": "", "attendance": "", "result": "",
	}
	if pct != nil {
		c.values["percentage"] = strconv.FormatFloat(*pct, 'f', 2, 64) + "%"
		/* The pass mark is the school's, and 33% is the one every board in the
		   country uses as the floor. Read from the grading scale would be
		   better and is not available here without a second decision about
		   which scale — so it is stated plainly rather than guessed at. */
		if *pct >= 33 {
			c.values["result"] = "PASS"
		} else {
			c.values["result"] = "FAIL"
		}
	}
	if attendance != nil {
		c.values["attendance"] = strconv.FormatFloat(*attendance, 'f', 1, 64) + "%"
	}

	rows, err := tx.Query(r.Context(), `
		SELECT sub.name, es.max_marks, m.marks_obtained, m.grade
		  FROM report_cards rc
		  JOIN enrollments e     ON e.id = rc.enrollment_id
		  JOIN class_subjects cs ON cs.class_id = e.class_id
		  JOIN subjects sub      ON sub.id = cs.subject_id
		  JOIN exam_subjects es  ON es.class_subject_id = cs.id
		  LEFT JOIN marks m      ON m.exam_subject_id = es.id AND m.student_id = rc.student_id
		 WHERE rc.id = $1
		 ORDER BY sub.name`, cardID)
	if err != nil {
		return c, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var max float64
		var got *float64
		var g *string
		if err := rows.Scan(&name, &max, &got, &g); err != nil {
			return c, err
		}
		row := map[string]string{
			"subject": name, "max_marks": strconv.FormatFloat(max, 'f', -1, 64),
			"marks": "—", "percent": "—", "subject_grade": str(g),
		}
		if got != nil {
			row["marks"] = strconv.FormatFloat(*got, 'f', -1, 64)
			if max > 0 {
				row["percent"] = fmt.Sprintf("%.0f%%", 100**got/max)
			}
		}
		c.subjects = append(c.subjects, row)
	}
	return c, rows.Err()
}

/*
The family's copy, on the school's own design.

	The portal listed the figures — total, percentage, grade — and the card the
	school actually issued existed only on a member of staff's screen. A parent
	asking for "the report card" means the document with the crest on it, and a
	school that has designed one wants the family looking at that rather than at
	a table this product drew.

	Narrower than the staff renderer in two ways that matter: the card must be
	PUBLISHED, and it must belong to a child this caller is attached to. Neither
	is a property of the screen — a parent who edits the id in the address bar
	gets a 403 rather than somebody else's child.
*/
func (s *Server) renderFamilyReportCard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	cardID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("id")))
	if err != nil {
		httpx.BadRequest(w, r, "id must be a uuid")
		return
	}
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.Forbidden(w, r, "this is not a report card you can open")
		return
	}
	tpl, err := s.loadReportCardTemplate(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var body string
	var allowed bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (
			  SELECT 1 FROM report_cards rc
			   WHERE rc.id = $1 AND rc.is_published AND rc.student_id = ANY($2))`,
			cardID, res.StudentIDs).Scan(&allowed); err != nil {
			return err
		}
		if !allowed {
			return nil
		}
		c, err := s.gatherReportCard(r, tx, cardID)
		if err != nil {
			return err
		}
		body = fillReportCard(tpl.HTML, c)
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !allowed {
		httpx.Forbidden(w, r, "this is not a report card you can open")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"html": body, "css": tpl.CSS})
}

/*
Somebody's own signature.

	Their own, always: the endpoint takes no user id, so there is no shape of
	request that sets somebody else's. A signature that another person can
	attach is not a signature.

	Read back through submitted_by and decided_by on each report card rather
	than copied onto the document, so replacing a poor scan corrects every card
	rendered afterwards — and a card nobody has approved cannot show a head's
	signature, because there is no decided_by to read one from.
*/
func (s *Server) setMySignature(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req struct {
		FileID string `json:"file_id"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	var file *uuid.UUID
	if v := strings.TrimSpace(req.FileID); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			httpx.BadRequest(w, r, "file_id must be a uuid")
			return
		}
		file = &parsed
	}
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(),
			`UPDATE users SET signature_file_id = $1 WHERE id = $2`, file, id.UserID)
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"saved": true})
}

func (s *Server) getMySignature(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var file *string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT signature_file_id::text FROM users WHERE id = $1`,
			id.UserID).Scan(&file)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"file_id": file})
}
