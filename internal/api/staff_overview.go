package api

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net/http"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* A teacher's workload and results on one page, and printable.

   getStaffDetail answers "what does she teach". This answers the next question
   a head of department asks — "and how are those classes doing" — by walking
   the same allocation into the marks the teacher's own exams produced. The JSON
   endpoint feeds the dashboard; the report endpoints render the identical
   figures as a printable HTML page with inline-SVG charts, the way report cards
   already print (server returns {html, css}, the browser prints it). Both the
   JSON and the charts are rendered from ONE computed struct so they can never
   disagree.

   Marks belong to the teacher's allocation: section_subject_teachers joins to
   exam_subjects on class_subject_id, and the students are pinned to the
   teacher's own sections through enrollments. Only published exams count, and
   an absent row is not a zero — it is left out of the average entirely. */

type overviewStaff struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Designation string `json:"designation"`
}

type overviewLoadSubject struct {
	Class    string `json:"class"`
	Section  string `json:"section"`
	Subject  string `json:"subject"`
	Students int    `json:"students"`
}

type overviewClassTeacher struct {
	Class   string `json:"class"`
	Section string `json:"section"`
}

type overviewLoad struct {
	SubjectsCount  int                    `json:"subjects_count"`
	SectionsCount  int                    `json:"sections_count"`
	StudentsCount  int                    `json:"students_count"`
	PeriodsPerWeek int                    `json:"periods_per_week"`
	ClassTeacherOf []overviewClassTeacher `json:"class_teacher_of"`
	Subjects       []overviewLoadSubject  `json:"subjects"`
}

type overviewBySubject struct {
	Subject  string  `json:"subject"`
	AvgPct   float64 `json:"avg_pct"`
	Students int     `json:"students"`
	Exams    int     `json:"exams"`
}

type overviewTrend struct {
	Exam   string  `json:"exam"`
	Date   string  `json:"date"`
	AvgPct float64 `json:"avg_pct"`
}

type overviewBySection struct {
	Class   string  `json:"class"`
	Section string  `json:"section"`
	AvgPct  float64 `json:"avg_pct"`
}

type overviewMarks struct {
	HasMarks           bool                `json:"has_marks"`
	OverallAvgPct      float64             `json:"overall_avg_pct"`
	PassRatePct        float64             `json:"pass_rate_pct"`
	DistinctionRatePct float64             `json:"distinction_rate_pct"`
	BySubject          []overviewBySubject `json:"by_subject"`
	Trend              []overviewTrend     `json:"trend"`
	BySection          []overviewBySection `json:"by_section"`
}

type staffOverview struct {
	Staff overviewStaff `json:"staff"`
	Load  overviewLoad  `json:"load"`
	Marks overviewMarks `json:"marks"`
}

// computeStaffOverview is the single source of truth behind both the JSON
// endpoint and the printed report. Given the resolved staff identity and login,
// it returns the fully computed struct with empty (never nil) slices. A member
// of staff with no login, or who teaches nothing, comes back with zeros and
// has_marks=false rather than an error.
func (s *Server) computeStaffOverview(ctx context.Context, tx pgx.Tx,
	staffID string, userID *uuid.UUID, name, designation string) (staffOverview, error) {

	ov := staffOverview{
		Staff: overviewStaff{ID: staffID, Name: name, Designation: designation},
		Load: overviewLoad{
			ClassTeacherOf: []overviewClassTeacher{},
			Subjects:       []overviewLoadSubject{},
		},
		Marks: overviewMarks{
			BySubject: []overviewBySubject{},
			Trend:     []overviewTrend{},
			BySection: []overviewBySection{},
		},
	}
	if userID == nil {
		return ov, nil
	}

	// ---- Load: what they teach, and how heavy it is ----
	subjectSet := map[string]bool{}
	sectionSet := map[string]bool{}
	if err := scanInto(ctx, tx, `
		SELECT c.name, sec.name, sub.name,
		       (SELECT count(*) FROM enrollments en
		         WHERE en.section_id = sec.id AND en.status = 'active')
		  FROM section_subject_teachers sst
		  JOIN sections sec ON sec.id = sst.section_id
		  JOIN classes c ON c.id = sec.class_id
		  JOIN class_subjects cs ON cs.id = sst.class_subject_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		 WHERE sst.teacher_user_id = $1
		 ORDER BY c.name, sec.name, sub.name`,
		func(rows pgx.Rows) error {
			var class, section, subject string
			var students int
			if err := rows.Scan(&class, &section, &subject, &students); err != nil {
				return err
			}
			ov.Load.Subjects = append(ov.Load.Subjects, overviewLoadSubject{
				Class: class, Section: section, Subject: subject, Students: students,
			})
			subjectSet[subject] = true
			sectionSet[class+"|"+section] = true
			return nil
		}, *userID); err != nil {
		return ov, err
	}
	ov.Load.SubjectsCount = len(subjectSet)
	ov.Load.SectionsCount = len(sectionSet)

	// Distinct heads in front of them, counted once even where they teach a
	// section more than one subject.
	if err := tx.QueryRow(ctx, `
		SELECT count(DISTINCT en.student_id)
		  FROM section_subject_teachers sst
		  JOIN enrollments en ON en.section_id = sst.section_id AND en.status = 'active'
		 WHERE sst.teacher_user_id = $1`, *userID).Scan(&ov.Load.StudentsCount); err != nil {
		return ov, err
	}

	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM timetable_entries WHERE teacher_user_id = $1`,
		*userID).Scan(&ov.Load.PeriodsPerWeek); err != nil {
		return ov, err
	}

	if err := scanInto(ctx, tx, `
		SELECT c.name, sec.name
		  FROM sections sec
		  JOIN classes c ON c.id = sec.class_id
		 WHERE sec.class_teacher_id = $1
		 ORDER BY c.name, sec.name`,
		func(rows pgx.Rows) error {
			var class, section string
			if err := rows.Scan(&class, &section); err != nil {
				return err
			}
			ov.Load.ClassTeacherOf = append(ov.Load.ClassTeacherOf,
				overviewClassTeacher{Class: class, Section: section})
			return nil
		}, *userID); err != nil {
		return ov, err
	}

	// ---- Marks: pull one row per published, non-absent mark in the teacher's
	// allocation, then aggregate in Go so subject / exam / section cuts share a
	// single query. ----
	type markRow struct {
		subject, class, section    string
		examID, examName, examDate string
		student                    string
		pct                        float64
		passed, distinction        bool
	}
	var mr []markRow
	if err := scanInto(ctx, tx, `
		SELECT sub.name, c.name, sec.name,
		       ex.id::text, ex.name,
		       COALESCE(to_char(es.exam_date,'YYYY-MM-DD'), ''),
		       m.student_id::text,
		       m.marks_obtained / NULLIF(es.max_marks, 0) * 100 AS pct,
		       (m.marks_obtained >= COALESCE(es.pass_marks, es.max_marks * 0.33)) AS passed
		  FROM section_subject_teachers sst
		  JOIN exam_subjects es ON es.class_subject_id = sst.class_subject_id
		  JOIN exams ex ON ex.id = es.exam_id AND ex.is_published
		  JOIN class_subjects cs ON cs.id = sst.class_subject_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		  JOIN sections sec ON sec.id = sst.section_id
		  JOIN classes c ON c.id = sec.class_id
		  JOIN enrollments en ON en.section_id = sst.section_id AND en.status = 'active'
		  JOIN marks m ON m.exam_subject_id = es.id AND m.student_id = en.student_id
		 WHERE sst.teacher_user_id = $1 AND NOT m.is_absent`,
		func(rows pgx.Rows) error {
			var row markRow
			var pct *float64
			if err := rows.Scan(&row.subject, &row.class, &row.section,
				&row.examID, &row.examName, &row.examDate, &row.student,
				&pct, &row.passed); err != nil {
				return err
			}
			if pct == nil {
				// max_marks was zero/NULL — no percentage is meaningful, so the
				// row is dropped from every average rather than counted as zero.
				return nil
			}
			row.pct = *pct
			row.distinction = *pct >= 75
			mr = append(mr, row)
			return nil
		}, *userID); err != nil {
		return ov, err
	}

	if len(mr) == 0 {
		return ov, nil
	}
	ov.Marks.HasMarks = true

	var sum float64
	var passed, distinctions int
	for _, r := range mr {
		sum += r.pct
		if r.passed {
			passed++
		}
		if r.distinction {
			distinctions++
		}
	}
	n := float64(len(mr))
	ov.Marks.OverallAvgPct = round1(sum / n)
	ov.Marks.PassRatePct = round1(float64(passed) / n * 100)
	ov.Marks.DistinctionRatePct = round1(float64(distinctions) / n * 100)

	// by_subject
	type subjAgg struct {
		sum      float64
		count    int
		students map[string]bool
		exams    map[string]bool
		order    int
	}
	subjMap := map[string]*subjAgg{}
	var subjOrder []string
	for _, r := range mr {
		a := subjMap[r.subject]
		if a == nil {
			a = &subjAgg{students: map[string]bool{}, exams: map[string]bool{}, order: len(subjOrder)}
			subjMap[r.subject] = a
			subjOrder = append(subjOrder, r.subject)
		}
		a.sum += r.pct
		a.count++
		a.students[r.student] = true
		a.exams[r.examID] = true
	}
	sort.SliceStable(subjOrder, func(i, j int) bool { return subjOrder[i] < subjOrder[j] })
	for _, name := range subjOrder {
		a := subjMap[name]
		ov.Marks.BySubject = append(ov.Marks.BySubject, overviewBySubject{
			Subject:  name,
			AvgPct:   round1(a.sum / float64(a.count)),
			Students: len(a.students),
			Exams:    len(a.exams),
		})
	}

	// trend — one point per exam, oldest first (undated exams sort last)
	type trendAgg struct {
		name, date string
		sum        float64
		count      int
	}
	trendMap := map[string]*trendAgg{}
	var trendKeys []string
	for _, r := range mr {
		a := trendMap[r.examID]
		if a == nil {
			a = &trendAgg{name: r.examName, date: r.examDate}
			trendMap[r.examID] = a
			trendKeys = append(trendKeys, r.examID)
		}
		a.sum += r.pct
		a.count++
	}
	sort.SliceStable(trendKeys, func(i, j int) bool {
		ai, aj := trendMap[trendKeys[i]], trendMap[trendKeys[j]]
		if ai.date == aj.date {
			return ai.name < aj.name
		}
		if ai.date == "" {
			return false
		}
		if aj.date == "" {
			return true
		}
		return ai.date < aj.date
	})
	for _, k := range trendKeys {
		a := trendMap[k]
		ov.Marks.Trend = append(ov.Marks.Trend, overviewTrend{
			Exam: a.name, Date: a.date, AvgPct: round1(a.sum / float64(a.count)),
		})
	}

	// by_section
	type secAgg struct {
		class, section string
		sum            float64
		count          int
	}
	secMap := map[string]*secAgg{}
	var secKeys []string
	for _, r := range mr {
		key := r.class + "|" + r.section
		a := secMap[key]
		if a == nil {
			a = &secAgg{class: r.class, section: r.section}
			secMap[key] = a
			secKeys = append(secKeys, key)
		}
		a.sum += r.pct
		a.count++
	}
	sort.SliceStable(secKeys, func(i, j int) bool { return secKeys[i] < secKeys[j] })
	for _, k := range secKeys {
		a := secMap[k]
		ov.Marks.BySection = append(ov.Marks.BySection, overviewBySection{
			Class: a.class, Section: a.section, AvgPct: round1(a.sum / float64(a.count)),
		})
	}

	return ov, nil
}

// resolveStaffOverview looks the employee up (login, name, designation) and
// runs the shared computation. errNoOverviewStaff distinguishes "no such
// employee" so the caller can 404.
var errNoOverviewStaff = errors.New("no such employee")

func (s *Server) resolveStaffOverview(ctx context.Context, tx pgx.Tx, eid uuid.UUID) (staffOverview, error) {
	var userID *uuid.UUID
	var name, designation string
	err := tx.QueryRow(ctx, `
		SELECT e.user_id,
		       TRIM(e.first_name || ' ' || COALESCE(e.last_name, '')),
		       COALESCE(dg.name, '')
		  FROM employees e
		  LEFT JOIN designations dg ON dg.id = e.designation_id
		 WHERE e.id = $1`, eid).Scan(&userID, &name, &designation)
	if errors.Is(err, pgx.ErrNoRows) {
		return staffOverview{}, errNoOverviewStaff
	}
	if err != nil {
		return staffOverview{}, err
	}
	return s.computeStaffOverview(ctx, tx, eid.String(), userID, name, designation)
}

// getStaffOverview — GET /api/v1/hr/employees/{id}/overview
func (s *Server) getStaffOverview(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}
	var ov staffOverview
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ov, err = s.resolveStaffOverview(r.Context(), tx, eid)
		return err
	})
	if errors.Is(err, errNoOverviewStaff) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, ov)
}

// ------------------------------------------------------------------ report

// getStaffOverviewReport — GET /api/v1/hr/employees/{id}/overview/report
// One staff member as a printable HTML page. Matches the report-card contract:
// the server returns {html, css, filename} and the browser prints it.
func (s *Server) getStaffOverviewReport(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	eid, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid employee id")
		return
	}
	var ov staffOverview
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ov, err = s.resolveStaffOverview(r.Context(), tx, eid)
		return err
	})
	if errors.Is(err, errNoOverviewStaff) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	body := staffOverviewSection(ov)
	page := fmt.Sprintf(
		`<div class="report"><h1>%s</h1>%s</div>`,
		html.EscapeString(staffReportTitle(ov)), body)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"html":     page,
		"css":      staffOverviewCSS,
		"filename": "staff-overview-" + eid.String() + ".pdf",
	})
}

// getAllStaffOverviewReport — GET /api/v1/hr/staff/overview/report
// Every teaching member of staff, one section each, page-broken between them.
func (s *Server) getAllStaffOverviewReport(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var sections []string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		type staffRef struct {
			eid, name, desig string
			userID           uuid.UUID
		}
		var refs []staffRef
		// Only staff with an allocation — printing a blank page for the office
		// clerk who teaches nothing helps nobody.
		if err := scanInto(r.Context(), tx, `
			SELECT DISTINCT e.id::text, e.user_id,
			       TRIM(e.first_name || ' ' || COALESCE(e.last_name, '')),
			       COALESCE(dg.name, '')
			  FROM section_subject_teachers sst
			  JOIN employees e ON e.user_id = sst.teacher_user_id
			  LEFT JOIN designations dg ON dg.id = e.designation_id
			 ORDER BY 3`,
			func(rows pgx.Rows) error {
				var ref staffRef
				if err := rows.Scan(&ref.eid, &ref.userID, &ref.name, &ref.desig); err != nil {
					return err
				}
				refs = append(refs, ref)
				return nil
			}); err != nil {
			return err
		}
		for _, ref := range refs {
			uid := ref.userID
			ov, err := s.computeStaffOverview(r.Context(), tx, ref.eid, &uid, ref.name, ref.desig)
			if err != nil {
				return err
			}
			sections = append(sections, fmt.Sprintf(
				`<div class="report page-break"><h1>%s</h1>%s</div>`,
				html.EscapeString(staffReportTitle(ov)), staffOverviewSection(ov)))
		}
		return nil
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	page := ""
	for _, sec := range sections {
		page += sec
	}
	if page == "" {
		page = `<div class="report"><p class="empty">No teaching staff to report on yet.</p></div>`
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"html":     page,
		"css":      staffOverviewCSS,
		"filename": "staff-overview-all.pdf",
	})
}

func staffReportTitle(ov staffOverview) string {
	if ov.Staff.Designation != "" {
		return ov.Staff.Name + " — " + ov.Staff.Designation
	}
	return ov.Staff.Name
}

// staffOverviewSection renders one staff member's stat summary and inline-SVG
// charts, the same self-contained-SVG technique the report card uses so it
// carries onto a printed page with no chart engine.
func staffOverviewSection(ov staffOverview) string {
	stat := func(label string, val any) string {
		return fmt.Sprintf(
			`<div class="stat"><div class="num">%v</div><div class="lbl">%s</div></div>`,
			val, html.EscapeString(label))
	}
	var b []byte
	out := func(s string) { b = append(b, s...) }

	out(`<div class="stats">`)
	out(stat("Subjects", ov.Load.SubjectsCount))
	out(stat("Sections", ov.Load.SectionsCount))
	out(stat("Students", ov.Load.StudentsCount))
	out(stat("Periods/week", ov.Load.PeriodsPerWeek))
	if ov.Marks.HasMarks {
		out(stat("Avg %", fmt.Sprintf("%.1f", ov.Marks.OverallAvgPct)))
		out(stat("Pass %", fmt.Sprintf("%.1f", ov.Marks.PassRatePct)))
		out(stat("Distinction %", fmt.Sprintf("%.1f", ov.Marks.DistinctionRatePct)))
	}
	out(`</div>`)

	if len(ov.Load.ClassTeacherOf) > 0 {
		out(`<p class="ct">Class teacher of: `)
		for i, ct := range ov.Load.ClassTeacherOf {
			if i > 0 {
				out(", ")
			}
			out(html.EscapeString(ct.Class + " " + ct.Section))
		}
		out(`</p>`)
	}

	if !ov.Marks.HasMarks {
		out(`<p class="empty">No published marks for this teacher's classes yet.</p>`)
		return string(b)
	}

	// Bar chart — average % per subject.
	out(`<h2>Average % by subject</h2>`)
	bars := make([]svgBar, 0, len(ov.Marks.BySubject))
	for _, s := range ov.Marks.BySubject {
		bars = append(bars, svgBar{label: s.Subject, value: s.AvgPct})
	}
	out(svgBarChart(bars))

	// Trend across exams.
	out(`<h2>Trend across exams</h2>`)
	pts := make([]svgBar, 0, len(ov.Marks.Trend))
	for _, t := range ov.Marks.Trend {
		lbl := t.Exam
		if t.Date != "" {
			lbl = t.Date
		}
		pts = append(pts, svgBar{label: lbl, value: t.AvgPct})
	}
	out(svgTrendChart(pts))

	return string(b)
}

type svgBar struct {
	label string
	value float64
}

func clampPct(p float64) float64 {
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// svgBarChart — one bar per entry, height the percentage. Built the
// {{performance_chart}} way: inline <svg>, no external JS.
func svgBarChart(bars []svgBar) string {
	if len(bars) == 0 {
		return `<p class="empty">No data.</p>`
	}
	const bw, gap, base, top = 46, 14, 150, 12
	n := len(bars)
	w := gap + n*(bw+gap)
	var ch []byte
	add := func(s string) { ch = append(ch, s...) }
	add(fmt.Sprintf(`<svg viewBox="0 0 %d 180" width="100%%" style="max-width:%dpx" font-family="sans-serif">`, w, w))
	add(fmt.Sprintf(`<line x1="0" y1="%d" x2="%d" y2="%d" stroke="#ccc"/>`, base, w, base))
	for i, bar := range bars {
		pct := clampPct(bar.value)
		bh := int(pct/100*float64(base-top)) + 2
		x := gap + i*(bw+gap)
		y := base - bh
		fill := "#6b8fd4"
		if pct >= 75 {
			fill = "#3f6bbf"
		} else if pct < 33 {
			fill = "#c76b6b"
		}
		add(fmt.Sprintf(`<rect x="%d" y="%d" width="%d" height="%d" fill="%s"/>`, x, y, bw, bh, fill))
		add(fmt.Sprintf(`<text x="%d" y="%d" text-anchor="middle" font-size="9">%.0f</text>`, x+bw/2, y-3, pct))
		label := bar.label
		if len(label) > 6 {
			label = label[:6]
		}
		add(fmt.Sprintf(`<text x="%d" y="168" text-anchor="middle" font-size="8">%s</text>`, x+bw/2, html.EscapeString(label)))
	}
	add(`</svg>`)
	return string(ch)
}

// svgTrendChart — a simple line across exams with a dot per point.
func svgTrendChart(pts []svgBar) string {
	if len(pts) == 0 {
		return `<p class="empty">No data.</p>`
	}
	const step, base, top, left = 70, 150, 12, 30
	n := len(pts)
	w := left + n*step
	px := func(i int) int { return left/2 + i*step + step/2 }
	py := func(v float64) int { return base - int(clampPct(v)/100*float64(base-top)) }
	var ch []byte
	add := func(s string) { ch = append(ch, s...) }
	add(fmt.Sprintf(`<svg viewBox="0 0 %d 180" width="100%%" style="max-width:%dpx" font-family="sans-serif">`, w, w))
	add(fmt.Sprintf(`<line x1="0" y1="%d" x2="%d" y2="%d" stroke="#ccc"/>`, base, w, base))
	// polyline
	line := ""
	for i, p := range pts {
		if i > 0 {
			line += " "
		}
		line += fmt.Sprintf("%d,%d", px(i), py(p.value))
	}
	add(fmt.Sprintf(`<polyline fill="none" stroke="#3f6bbf" stroke-width="2" points="%s"/>`, line))
	for i, p := range pts {
		cx, cy := px(i), py(p.value)
		add(fmt.Sprintf(`<circle cx="%d" cy="%d" r="3" fill="#3f6bbf"/>`, cx, cy))
		add(fmt.Sprintf(`<text x="%d" y="%d" text-anchor="middle" font-size="9">%.0f</text>`, cx, cy-6, clampPct(p.value)))
		label := p.label
		if len(label) > 8 {
			label = label[:8]
		}
		add(fmt.Sprintf(`<text x="%d" y="168" text-anchor="middle" font-size="8">%s</text>`, cx, html.EscapeString(label)))
	}
	add(`</svg>`)
	return string(ch)
}

const staffOverviewCSS = `
body { font-family: sans-serif; color: #222; margin: 0; }
.report { padding: 24px; }
.report h1 { font-size: 20px; margin: 0 0 12px; }
.report h2 { font-size: 14px; margin: 18px 0 6px; color: #3f6bbf; }
.stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.stat { border: 1px solid #e0e0e0; border-radius: 6px; padding: 8px 14px; min-width: 90px; }
.stat .num { font-size: 20px; font-weight: 700; }
.stat .lbl { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .04em; }
.ct { font-size: 12px; color: #444; margin: 4px 0 10px; }
.empty { font-style: italic; color: #888; }
.page-break { page-break-before: always; }
.page-break:first-child { page-break-before: avoid; }
@media print {
  body { margin: 0; }
  .report { padding: 12mm; }
  .page-break { page-break-before: always; }
  .stat { border: 1px solid #ccc; }
}
`
