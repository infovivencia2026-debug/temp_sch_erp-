package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The principal's office: the academic year, and the children in it.

   Ten screens, and eight of them read tables that were already here. The
   calendar is holidays, marks monitoring is marks, allocation is
   section_subject_teachers, the substitution board is substitutions and the
   timetable, the department roll is enrollments reached through the
   department's own teachers, and a print template is a certificate_type. Only
   outcomes, the council and the alumni programme needed anything new.

   Nothing in this file stores a percentage. Marks completion, syllabus-style
   coverage, outcome attainment and working days are all computed on read, for
   the reason syllabus.go states once and this file inherits: a stored
   percentage is wrong the moment a mark is amended and nobody recomputes it.

   Permissions are the ones that already exist. The group this mounts into
   already requires academics.read, which a subject teacher holds; every
   endpoint below therefore names a second permission that a subject teacher
   does not have — reports.read to look at the whole school, academics.write or
   exams.write to change the shape of the year, students.read.all for a roll no
   form teacher is entitled to, and institution.settings.write for a template
   that prints the school's name at the bottom.
*/

// mountAdminAcademics hangs the principal's academic and student screens off
// the existing /academics group. Paths are relative: the caller owns the
// prefix and the academics.read middleware already on the group.
func (s *Server) mountAdminAcademics(r chi.Router) {
	// Changing the shape of the academic year: the calendar, allocation, the
	// outcome framework. Held by the principal, the vice principal and a head
	// of department, and by no subject teacher.
	academics := httpx.RequirePermission(rbac.AcademicsWrite)
	// Deciding an exam result. Deliberately not marks.write, which every
	// teacher holds so they can enter their own paper — approving the paper is
	// the examination controller's signature, not the marker's.
	exams := httpx.RequirePermission(rbac.ExamsWrite)
	// Looking at the whole school rather than one's own classes.
	reports := httpx.RequirePermission(rbac.ReportsRead)
	// A roll of children the caller does not teach.
	allStudents := httpx.RequirePermission(rbac.StudentsReadAll)
	// Writing in a child's record: the council roll, the alumni directory, the
	// suspension dates on an incident.
	studentsWrite := httpx.RequirePermission(rbac.StudentsWrite)
	// The substitution board exists to act on. Gated on the permission that
	// the endpoint it feeds — POST /timetable-admin/substitutions — already
	// requires, so the board can never offer a button its reader cannot press.
	timetable := httpx.RequirePermission(rbac.TimetableWrite)

	// --- academic calendar -------------------------------------------------
	// The read is left on the group's academics.read: every member of staff is
	// entitled to know when the school is shut.
	r.Get("/admin/calendar", s.getAcademicCalendar)
	// One date, with its periods, their lesson plans and the almanac around it.
	r.Get("/admin/calendar/day", s.getCalendarDay)

	// --- the year plan ------------------------------------------------------
	// The chapter order and the calendar, poured into one another. Chapters are
	// edited through the syllabus endpoints; no month is stored.
	r.Get("/admin/year-plan", s.getYearPlan)
	r.With(academics).Post("/admin/calendar", s.saveCalendarEntry)
	r.With(academics).Delete("/admin/calendar/{id}", s.deleteCalendarEntry)

	// --- exams and marks monitoring ----------------------------------------
	r.With(reports).Get("/admin/exam-monitor", s.getExamMonitor)
	r.With(exams).Post("/admin/exam-monitor/approve", s.approveExamMarks)

	// --- faculty allocation -------------------------------------------------
	r.With(academics).Get("/admin/faculty-allocation", s.getFacultyAllocation)
	r.With(academics).Post("/admin/faculty-allocation", s.setFacultyAllocation)
	/* Make the published timetable agree with the allocation.

	   The two tables drift, the allocation screen has a flag saying so, and
	   nothing could act on it — leaving a teacher allocated three subjects but
	   invisible to the substitution board and the clash checker, both of which
	   read periods rather than allocations. */
	r.With(academics).Post("/admin/faculty-allocation/apply", s.applyAllocationToTimetable)

	// --- the substitution board ---------------------------------------------
	r.With(timetable).Get("/admin/substitution-board", s.getSubstitutionBoard)

	// --- OBE / outcomes -----------------------------------------------------
	r.With(reports).Get("/admin/outcomes", s.getOutcomes)
	r.With(reports).Get("/admin/outcomes/attainment", s.getOutcomeAttainment)
	r.With(academics).Post("/admin/outcomes/programme", s.saveProgrammeOutcome)
	r.With(academics).Post("/admin/outcomes/course", s.saveCourseOutcome)
	r.With(academics).Put("/admin/outcomes/mapping", s.setOutcomeMapping)

	// --- department students -------------------------------------------------
	r.With(allStudents).Get("/admin/department-students", s.getDepartmentStudents)

	// --- the disciplinary incident log ---------------------------------------
	r.With(allStudents).Get("/admin/incidents", s.listIncidents)
	r.With(studentsWrite).Post("/admin/incidents/{id}", s.updateIncident)

	// --- the student council --------------------------------------------------
	r.With(allStudents).Get("/admin/council", s.getCouncil)
	r.With(studentsWrite).Post("/admin/council/positions", s.saveCouncilPosition)
	r.With(studentsWrite).Post("/admin/council/members", s.saveCouncilMember)
	r.With(studentsWrite).Post("/admin/council/duties", s.saveCouncilDuty)

	// --- the alumni programme --------------------------------------------------
	r.With(allStudents).Get("/admin/alumni", s.getAlumni)
	r.With(allStudents).Get("/admin/alumni/events", s.listAlumniEvents)
	r.With(studentsWrite).Post("/admin/alumni/profiles", s.saveAlumniProfile)
	r.With(studentsWrite).Post("/admin/alumni/events", s.saveAlumniEvent)
	r.With(studentsWrite).Post("/admin/alumni/events/{id}/attendance", s.recordAlumniAttendance)
	r.With(studentsWrite).Post("/admin/alumni/contributions", s.recordAlumniContribution)

	// --- certificate and document templates -------------------------------------
	// A print template is a school setting, not a student record: it carries
	// the letterhead, the signatory and the serial the school's paper uses.
	r.With(httpx.RequirePermission(rbac.InstitutionRead)).
		Get("/admin/certificate-templates", s.listCertificateTemplates)
	r.With(httpx.RequirePermission(rbac.InstitutionRead)).
		Get("/admin/certificate-templates/{id}/preview", s.previewCertificateTemplate)
	r.With(httpx.RequirePermission(rbac.SettingsWrite)).
		Post("/admin/certificate-templates", s.saveCertificateTemplate)
}

/*
adminWindow is the date range an admin screen defaults to when asked for none.

	Every GET in this file has to answer usefully with no query string at all —
	a probe with no parameters that returns 400 is a screen that renders an
	error on first load. The academic year is the honest default for a
	principal's screen: a school year, not a calendar month.
*/
func adminWindow(r *http.Request) (string, string) {
	q := r.URL.Query()
	from, to := strings.TrimSpace(q.Get("from")), strings.TrimSpace(q.Get("to"))
	if from != "" && to != "" {
		if to < from {
			from, to = to, from
		}
		return from, to
	}
	start := academicYearStart(nowInIndia())
	return start.Format(time.DateOnly), start.AddDate(1, 0, -1).Format(time.DateOnly)
}

// --- academic calendar ---------------------------------------------------------

type schoolCalendarEntry struct {
	ID string `json:"id"`
	// Where the row came from. Only 'calendar' rows are editable: an exam and a
	// term are owned by their own module and shown here so the year reads as
	// one page rather than three.
	Source      string  `json:"source"`
	Name        string  `json:"name"`
	StartsOn    string  `json:"starts_on"`
	EndsOn      string  `json:"ends_on"`
	Kind        string  `json:"kind"`
	AppliesTo   string  `json:"applies_to"`
	Description *string `json:"description,omitempty"`
	Campus      *string `json:"campus,omitempty"`
	Days        int     `json:"days"`
}

func (s *Server) getAcademicCalendar(w http.ResponseWriter, r *http.Request) {
	from, to := adminWindow(r)
	kind := nullString(strings.TrimSpace(r.URL.Query().Get("kind")))
	yearID := nullString(strings.TrimSpace(r.URL.Query().Get("academic_year_id")))

	items, err := collect(s, r, `
		SELECT h.id::text, 'calendar', h.name,
		       to_char(h.on_date,'YYYY-MM-DD'),
		       to_char(COALESCE(h.to_date, h.on_date),'YYYY-MM-DD'),
		       h.kind, h.applies_to, h.description, c.name,
		       (COALESCE(h.to_date, h.on_date) - h.on_date + 1)::int
		  FROM holidays h
		  LEFT JOIN campuses c ON c.id = h.campus_id
		 WHERE h.on_date <= $2::date AND COALESCE(h.to_date, h.on_date) >= $1::date
		   AND ($3::text IS NULL OR h.kind = $3)
		   AND ($4::uuid IS NULL OR h.academic_year_id = $4)
		UNION ALL
		-- The exam board, read-only here. Shown because "when is the school
		-- shut" and "when are the exams" are the same question to a parent.
		SELECT e.id::text, 'exam', e.name,
		       to_char(e.starts_on,'YYYY-MM-DD'),
		       to_char(COALESCE(e.ends_on, e.starts_on),'YYYY-MM-DD'),
		       'exam', 'students', NULL, NULL,
		       (COALESCE(e.ends_on, e.starts_on) - e.starts_on + 1)::int
		  FROM exams e
		 WHERE e.starts_on IS NOT NULL
		   AND e.starts_on <= $2::date AND COALESCE(e.ends_on, e.starts_on) >= $1::date
		   AND ($3::text IS NULL OR $3 = 'exam')
		   AND ($4::uuid IS NULL OR e.academic_year_id = $4)
		UNION ALL
		SELECT t.id::text, 'term', t.name,
		       to_char(t.starts_on,'YYYY-MM-DD'), to_char(t.ends_on,'YYYY-MM-DD'),
		       'term', 'all', NULL, NULL, (t.ends_on - t.starts_on + 1)::int
		  FROM terms t
		 WHERE t.starts_on <= $2::date AND t.ends_on >= $1::date
		   AND ($3::text IS NULL OR $3 = 'term')
		   AND ($4::uuid IS NULL OR t.academic_year_id = $4)
		 ORDER BY 4, 3`,
		[]any{from, to, kind, yearID},
		func(rows pgx.Rows) (schoolCalendarEntry, error) {
			var v schoolCalendarEntry
			return v, rows.Scan(&v.ID, &v.Source, &v.Name, &v.StartsOn, &v.EndsOn,
				&v.Kind, &v.AppliesTo, &v.Description, &v.Campus, &v.Days)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	id := httpx.IdentityFrom(r.Context())
	var total, instructional, declared int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		/* Instructional days, counted rather than declared.

		   A day counts unless it is a Sunday or is covered by a holiday or
		   vacation that shuts the school for students. A day explicitly marked
		   'working_day' counts whatever else it is: that kind exists precisely
		   so a school can pull a Sunday back in to make up for a bandh. */
		return tx.QueryRow(r.Context(), `
			WITH days AS (
			  SELECT d::date AS on_date
			    FROM generate_series($1::date, $2::date, interval '1 day') d
			), marked AS (
			  SELECT d.on_date,
			         EXISTS (SELECT 1 FROM holidays h
			                  WHERE h.kind IN ('holiday','vacation')
			                    AND h.applies_to IN ('all','students')
			                    AND d.on_date BETWEEN h.on_date
			                                      AND COALESCE(h.to_date, h.on_date)) AS shut,
			         EXISTS (SELECT 1 FROM holidays h
			                  WHERE h.kind = 'working_day'
			                    AND d.on_date BETWEEN h.on_date
			                                      AND COALESCE(h.to_date, h.on_date)) AS working
			    FROM days d
			)
			SELECT count(*)::int,
			       count(*) FILTER (WHERE working
			                          OR (extract(isodow FROM on_date) <> 7 AND NOT shut))::int,
			       COALESCE((SELECT working_days FROM academic_years
			                  WHERE is_current ORDER BY starts_on DESC LIMIT 1), 0)::int
			  FROM marked`, from, to).Scan(&total, &instructional, &declared)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items,
		"from":  from,
		"to":    to,
		"summary": map[string]any{
			"days_in_range":       total,
			"instructional_days":  instructional,
			"declared_working":    declared,
			"has_declared_figure": declared > 0,
			"entries":             len(items),
		},
	})
}

type calendarRequest struct {
	ID             string `json:"id,omitempty"`
	Name           string `json:"name"`
	OnDate         string `json:"on_date"`
	ToDate         string `json:"to_date,omitempty"`
	Kind           string `json:"kind,omitempty"`
	AppliesTo      string `json:"applies_to,omitempty"`
	Description    string `json:"description,omitempty"`
	CampusID       string `json:"campus_id,omitempty"`
	AcademicYearID string `json:"academic_year_id,omitempty"`
}

var calendarKinds = map[string]bool{
	"holiday": true, "vacation": true, "exam": true,
	"event": true, "ptm": true, "working_day": true,
}

// saveCalendarEntry writes one row of the school's own calendar.
//
// Upserts on the entry key added in 00034 rather than always inserting: two
// people entering Diwali on the same day used to make two rows, and every
// working-day count downstream was then one short.
func (s *Server) saveCalendarEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req calendarRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httpx.BadRequest(w, r, "give the entry a name. A dated blank tells the next reader nothing")
		return
	}
	if strings.TrimSpace(req.OnDate) == "" {
		httpx.BadRequest(w, r, "on_date is required")
		return
	}
	if req.Kind == "" {
		req.Kind = "holiday"
	}
	if !calendarKinds[req.Kind] {
		httpx.BadRequest(w, r, "kind must be one of holiday, vacation, exam, event, ptm, working_day")
		return
	}
	if req.AppliesTo == "" {
		req.AppliesTo = "all"
	}
	switch req.AppliesTo {
	case "all", "students", "staff":
	default:
		httpx.BadRequest(w, r, "applies_to must be all, students or staff")
		return
	}
	if req.ToDate != "" && req.ToDate < req.OnDate {
		httpx.BadRequest(w, r, "to_date is before on_date")
		return
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			// Editing a known row: the key may itself be what is changing, so
			// this cannot go through the upsert.
			return tx.QueryRow(r.Context(), `
				UPDATE holidays
				   SET name = $2, on_date = $3::date, to_date = NULLIF($4,'')::date,
				       kind = $5, applies_to = $6, description = NULLIF($7,''),
				       campus_id = NULLIF($8,'')::uuid,
				       academic_year_id = COALESCE(NULLIF($9,'')::uuid, academic_year_id)
				 WHERE id = $1::uuid
				RETURNING id::text`,
				req.ID, req.Name, req.OnDate, req.ToDate, req.Kind, req.AppliesTo,
				req.Description, req.CampusID, req.AcademicYearID).Scan(&newID)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO holidays (institution_id, campus_id, academic_year_id, name,
			                      on_date, to_date, kind, applies_to, description)
			VALUES ($1, NULLIF($2,'')::uuid,
			        COALESCE(NULLIF($3,'')::uuid,
			                 (SELECT id FROM academic_years WHERE is_current
			                   ORDER BY starts_on DESC LIMIT 1)),
			        $4, $5::date, NULLIF($6,'')::date, $7, $8, NULLIF($9,''))
			ON CONFLICT (institution_id,
			             COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid),
			             on_date, kind, lower(name))
			DO UPDATE SET to_date     = EXCLUDED.to_date,
			              applies_to  = EXCLUDED.applies_to,
			              description = EXCLUDED.description,
			              academic_year_id = COALESCE(EXCLUDED.academic_year_id,
			                                          holidays.academic_year_id)
			RETURNING id::text`,
			id.InstitutionID, req.CampusID, req.AcademicYearID, req.Name,
			req.OnDate, req.ToDate, req.Kind, req.AppliesTo, req.Description).Scan(&newID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": newID})
}

func (s *Server) deleteCalendarEntry(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	entry, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid calendar entry id")
		return
	}
	var gone bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `DELETE FROM holidays WHERE id = $1`, entry)
		gone = err == nil && tag.RowsAffected() > 0
		return err
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if !gone {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": entry.String(), "deleted": true})
}

// --- exams and marks monitoring --------------------------------------------------

type examMonitorRow struct {
	ExamSubjectID string  `json:"exam_subject_id"`
	ExamID        string  `json:"exam_id"`
	ExamName      string  `json:"exam_name"`
	ExamKind      string  `json:"exam_kind"`
	ClassName     string  `json:"class_name"`
	Subject       string  `json:"subject"`
	ExamDate      *string `json:"exam_date,omitempty"`
	MaxMarks      float64 `json:"max_marks"`
	PassMarks     float64 `json:"pass_marks"`
	Teachers      *string `json:"teachers,omitempty"`
	Eligible      int     `json:"eligible"`
	Entered       int     `json:"entered"`
	Absent        int     `json:"absent"`
	Approved      int     `json:"approved"`
	Failed        int     `json:"failed"`
	AveragePct    float64 `json:"average_percent"`
	Published     bool    `json:"published"`
	// Computed here rather than in three screens: pending is the number a head
	// of department chases, and it is not stored anywhere.
	Pending    int  `json:"pending"`
	Complete   bool `json:"complete"`
	SignedOff  bool `json:"signed_off"`
	Percentage int  `json:"entry_percent"`
}

// getExamMonitor answers "who has not entered their marks yet".
//
// Eligibility is counted from active enrollments in the class the paper
// belongs to, not from the marks already entered — counting the entered rows
// against themselves would make every paper look finished.
func (s *Server) getExamMonitor(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT es.id::text, e.id::text, e.name, e.kind, c.name, sub.name,
		       to_char(es.exam_date,'YYYY-MM-DD'),
		       es.max_marks::float8, es.pass_marks::float8,
		       (SELECT string_agg(DISTINCT u.full_name, ', ')
		          FROM section_subject_teachers sst
		          JOIN users u ON u.id = sst.teacher_user_id
		         WHERE sst.class_subject_id = cs.id),
		       (SELECT count(*) FROM enrollments en
		         WHERE en.class_id = cs.class_id
		           AND en.academic_year_id = e.academic_year_id
		           AND en.status = 'active')::int,
		       count(m.id)::int,
		       count(m.id) FILTER (WHERE m.is_absent)::int,
		       count(m.id) FILTER (WHERE m.approved_at IS NOT NULL)::int,
		       count(m.id) FILTER (WHERE NOT m.is_absent
		                             AND m.marks_obtained IS NOT NULL
		                             AND m.marks_obtained < es.pass_marks)::int,
		       COALESCE(round(100.0 * avg(m.marks_obtained)
		                      FILTER (WHERE NOT m.is_absent AND m.marks_obtained IS NOT NULL)
		                      / NULLIF(es.max_marks, 0), 1), 0)::float8,
		       e.is_published
		  FROM exam_subjects es
		  JOIN exams e ON e.id = es.exam_id
		  JOIN class_subjects cs ON cs.id = es.class_subject_id
		  JOIN classes c ON c.id = cs.class_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN marks m ON m.exam_subject_id = es.id
		 WHERE ($1::uuid IS NULL OR e.id = $1)
		   AND ($2::uuid IS NULL OR cs.class_id = $2)
		   AND ($3::uuid IS NULL OR e.academic_year_id = $3)
		 GROUP BY es.id, e.id, e.name, e.kind, c.name, c.level, sub.name,
		          es.exam_date, es.max_marks, es.pass_marks, cs.id, cs.class_id,
		          e.academic_year_id, e.is_published
		 ORDER BY e.name, c.level, sub.name
		 LIMIT 500`,
		[]any{nullString(strings.TrimSpace(q.Get("exam_id"))),
			nullString(strings.TrimSpace(q.Get("class_id"))),
			nullString(strings.TrimSpace(q.Get("academic_year_id")))},
		func(rows pgx.Rows) (examMonitorRow, error) {
			var v examMonitorRow
			if err := rows.Scan(&v.ExamSubjectID, &v.ExamID, &v.ExamName, &v.ExamKind,
				&v.ClassName, &v.Subject, &v.ExamDate, &v.MaxMarks, &v.PassMarks,
				&v.Teachers, &v.Eligible, &v.Entered, &v.Absent, &v.Approved,
				&v.Failed, &v.AveragePct, &v.Published); err != nil {
				return v, err
			}
			v.Pending = max(v.Eligible-v.Entered, 0)
			v.Complete = v.Entered > 0 && v.Pending == 0
			v.SignedOff = v.Entered > 0 && v.Approved >= v.Entered
			if v.Eligible > 0 {
				v.Percentage = v.Entered * 100 / v.Eligible
			}
			return v, nil
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var papers, complete, signed, pending, backlogs int
	for _, it := range items {
		papers++
		if it.Complete {
			complete++
		}
		if it.SignedOff {
			signed++
		}
		pending += it.Pending
		backlogs += it.Failed
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items,
		"summary": map[string]any{
			"papers":        papers,
			"complete":      complete,
			"signed_off":    signed,
			"marks_pending": pending,
			"backlogs":      backlogs,
			"complete_percent": func() int {
				if papers == 0 {
					return 0
				}
				return complete * 100 / papers
			}(),
		},
	})
}

type approveMarksRequest struct {
	ExamSubjectID string `json:"exam_subject_id,omitempty"`
	ExamID        string `json:"exam_id,omitempty"`
}

var errNothingToApprove = errors.New("no paper here is finished")

/*
approveExamMarks signs off entered marks.

	Refuses a paper that is not fully entered. Approving a half-marked paper is
	how a result gets published with a class missing from it, and the office
	only discovers which class at the parents' meeting.
*/
func (s *Server) approveExamMarks(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req approveMarksRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.ExamSubjectID == "" && req.ExamID == "" {
		httpx.BadRequest(w, r, "give an exam_subject_id or an exam_id")
		return
	}

	var ready, incomplete, approved int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		const targets = `
			SELECT es.id,
			       (SELECT count(*) FROM enrollments en
			         WHERE en.class_id = cs.class_id
			           AND en.academic_year_id = e.academic_year_id
			           AND en.status = 'active') AS eligible,
			       (SELECT count(*) FROM marks m WHERE m.exam_subject_id = es.id) AS entered
			  FROM exam_subjects es
			  JOIN exams e ON e.id = es.exam_id
			  JOIN class_subjects cs ON cs.id = es.class_subject_id
			 WHERE (NULLIF($1,'')::uuid IS NULL OR es.id = NULLIF($1,'')::uuid)
			   AND (NULLIF($2,'')::uuid IS NULL OR es.exam_id = NULLIF($2,'')::uuid)`

		if err := tx.QueryRow(r.Context(), `
			WITH t AS (`+targets+`)
			SELECT count(*) FILTER (WHERE entered >= eligible AND entered > 0)::int,
			       count(*) FILTER (WHERE entered < eligible OR entered = 0)::int
			  FROM t`, req.ExamSubjectID, req.ExamID).Scan(&ready, &incomplete); err != nil {
			return err
		}
		if ready == 0 {
			return errNothingToApprove
		}
		tag, err := tx.Exec(r.Context(), `
			WITH t AS (`+targets+`)
			UPDATE marks m
			   SET approved_by = $3, approved_at = now()
			 WHERE m.approved_at IS NULL
			   AND m.exam_subject_id IN
			       (SELECT id FROM t WHERE entered >= eligible AND entered > 0)`,
			req.ExamSubjectID, req.ExamID, id.UserID)
		if err != nil {
			return err
		}
		approved = int(tag.RowsAffected())
		return nil
	})
	if errors.Is(err, errNothingToApprove) {
		httpx.Error(w, r, http.StatusConflict, "marks_incomplete",
			"every paper here still has marks missing. Chase the entry before signing it off")
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"papers_approved": ready, "papers_incomplete": incomplete, "marks_approved": approved,
	})
}

// --- faculty allocation ------------------------------------------------------------

type facultyAllocationRow struct {
	SectionID      string  `json:"section_id"`
	SectionName    string  `json:"section"`
	ClassID        string  `json:"class_id"`
	ClassName      string  `json:"class_name"`
	ClassSubjectID string  `json:"class_subject_id"`
	Subject        string  `json:"subject"`
	TeacherUserID  *string `json:"teacher_user_id,omitempty"`
	Teacher        *string `json:"teacher,omitempty"`
	WeeklyPeriods  int     `json:"weekly_periods"`
	// True when the timetable puts somebody else in front of this class. The
	// allocation and the timetable are two tables and drift apart quietly; the
	// only place anybody would notice is here.
	TimetableDiffers bool `json:"timetable_differs"`
}

func (s *Server) getFacultyAllocation(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	unassignedOnly := q.Get("unassigned") == "1" || q.Get("unassigned") == "true"

	items, err := collect(s, r, `
		SELECT sec.id::text, sec.name, c.id::text, c.name,
		       cs.id::text, sub.name,
		       sst.teacher_user_id::text, u.full_name,
		       (SELECT count(*) FROM timetable_entries te
		         WHERE te.section_id = sec.id AND te.class_subject_id = cs.id)::int,
		       EXISTS (SELECT 1 FROM timetable_entries te
		                WHERE te.section_id = sec.id AND te.class_subject_id = cs.id
		                  AND te.teacher_user_id IS NOT NULL
		                  AND te.teacher_user_id IS DISTINCT FROM sst.teacher_user_id)
		  FROM sections sec
		  JOIN classes c ON c.id = sec.class_id
		  JOIN class_subjects cs ON cs.class_id = sec.class_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN section_subject_teachers sst
		         ON sst.section_id = sec.id AND sst.class_subject_id = cs.id
		  LEFT JOIN users u ON u.id = sst.teacher_user_id
		 -- With no year asked for, the current one; with no current year set,
		 -- every year, which is better than an empty screen.
		 WHERE sec.academic_year_id = COALESCE($1::uuid,
		         (SELECT id FROM academic_years WHERE is_current
		           ORDER BY starts_on DESC LIMIT 1), sec.academic_year_id)
		   AND ($2::uuid IS NULL OR sec.class_id = $2)
		   AND ($3::uuid IS NULL OR sst.teacher_user_id = $3)
		   AND ($4::boolean IS NOT TRUE OR sst.id IS NULL)
		 ORDER BY c.level, c.name, sec.name, sub.name
		 LIMIT 1000`,
		[]any{nullString(strings.TrimSpace(q.Get("academic_year_id"))),
			nullString(strings.TrimSpace(q.Get("class_id"))),
			nullString(strings.TrimSpace(q.Get("teacher_user_id"))),
			unassignedOnly},
		func(rows pgx.Rows) (facultyAllocationRow, error) {
			var v facultyAllocationRow
			return v, rows.Scan(&v.SectionID, &v.SectionName, &v.ClassID, &v.ClassName,
				&v.ClassSubjectID, &v.Subject, &v.TeacherUserID, &v.Teacher,
				&v.WeeklyPeriods, &v.TimetableDiffers)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	assigned, conflicts := 0, 0
	teachers := map[string]struct{}{}
	for _, it := range items {
		if it.TeacherUserID != nil {
			assigned++
			teachers[*it.TeacherUserID] = struct{}{}
		}
		if it.TimetableDiffers {
			conflicts++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items,
		"summary": map[string]any{
			"slots":               len(items),
			"assigned":            assigned,
			"unassigned":          len(items) - assigned,
			"teachers_allocated":  len(teachers),
			"timetable_conflicts": conflicts,
		},
	})
}

type facultyAllocationRequest struct {
	Allocations []struct {
		SectionID      string `json:"section_id"`
		ClassSubjectID string `json:"class_subject_id"`
		// Empty clears the allocation. A separate delete endpoint would mean a
		// screen that saves a grid has to work out which cells were emptied and
		// send two different requests; this way it sends the grid.
		TeacherUserID string `json:"teacher_user_id"`
	} `json:"allocations"`
}

// setFacultyAllocation saves a grid of subject-to-teacher decisions.
//
// The single-cell version already exists as POST /setup/assign-teacher and is
// unchanged; this is the bulk path a whole-class allocation screen needs, and
// the only one that can clear a cell.
func (s *Server) setFacultyAllocation(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req facultyAllocationRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Allocations) == 0 {
		httpx.BadRequest(w, r, "send at least one allocation")
		return
	}

	var assigned, cleared int
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, a := range req.Allocations {
			sec, err := uuid.Parse(a.SectionID)
			if err != nil {
				return errors.New("section_id must be a uuid")
			}
			cs, err := uuid.Parse(a.ClassSubjectID)
			if err != nil {
				return errors.New("class_subject_id must be a uuid")
			}
			if strings.TrimSpace(a.TeacherUserID) == "" {
				tag, err := tx.Exec(r.Context(), `
					DELETE FROM section_subject_teachers
					 WHERE section_id = $1 AND class_subject_id = $2`, sec, cs)
				if err != nil {
					return err
				}
				cleared += int(tag.RowsAffected())
				continue
			}
			teacher, err := uuid.Parse(a.TeacherUserID)
			if err != nil {
				return errors.New("teacher_user_id must be a uuid")
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO section_subject_teachers (institution_id, section_id,
				                                      class_subject_id, teacher_user_id)
				VALUES ($1,$2,$3,$4)
				ON CONFLICT (section_id, class_subject_id)
				DO UPDATE SET teacher_user_id = EXCLUDED.teacher_user_id`,
				id.InstitutionID, sec, cs, teacher); err != nil {
				return err
			}
			assigned++
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"assigned": assigned, "cleared": cleared})
}

// --- the substitution board ----------------------------------------------------------

type proxyCandidate struct {
	UserID string `json:"user_id"`
	Name   string `json:"full_name"`
	// A free period is the minimum; a free period held by somebody who teaches
	// the subject elsewhere is a lesson rather than a supervised hour.
	TeachesSubject bool `json:"teaches_subject"`
	PeriodsToday   int  `json:"periods_today"`
}

type substitutionRow struct {
	TimetableEntryID string  `json:"timetable_entry_id"`
	AbsentUserID     string  `json:"absent_user_id"`
	AbsentTeacher    string  `json:"absent_teacher"`
	Reason           string  `json:"reason"`
	Period           string  `json:"period"`
	PeriodSeq        int     `json:"period_sequence"`
	StartsAt         string  `json:"starts_at"`
	ClassName        string  `json:"class_name"`
	SectionName      string  `json:"section"`
	Subject          string  `json:"subject"`
	CoveredBy        *string `json:"covered_by,omitempty"`
	CoveredByID      *string `json:"covered_by_user_id,omitempty"`
	/* Cover that has itself fallen through.

	   A substitution is settled once made — the board is a morning's decisions
	   and re-shuffling them under the office's feet would be worse than any
	   staleness. The one thing that must reopen it is the substitute going
	   absent: leave approved at 8:40 for somebody who was given a proxy at
	   8:20, or simply not turning up.

	   Nothing noticed. The period belongs to the absent teacher, and it had a
	   substitution against it, so it read as covered and dropped out of the
	   morning's work — a class with nobody in front of it, and a board saying
	   every period was handled. */
	CoverAbsent bool             `json:"cover_absent"`
	Candidates  []proxyCandidate `json:"candidates"`
}

/*
getSubstitutionBoard is the morning's first job in every Indian school.

	Who is not in today, which of their periods that leaves uncovered, and who
	is free in each of those periods. The candidate list is computed here
	rather than left to the person holding the timetable on paper: a proxy who
	is not actually free just moves the uncovered class somewhere else, and
	POST /timetable-admin/substitutions rejects it with a 409 after the fact.

	Absence is read from both registers a school keeps it in. staff_attendance
	is the mark somebody made this morning; an approved leave request is the
	one made three weeks ago that nobody has marked yet. Reading only one of
	them misses half the absences on any given day.
*/
func (s *Server) getSubstitutionBoard(w http.ResponseWriter, r *http.Request) {
	onDate := dayOrToday(r)

	items, err := collect(s, r, `
		WITH absent AS (
		  SELECT u.id AS user_id, u.full_name,
		         CASE WHEN sa.status IS NOT NULL THEN sa.status ELSE 'leave' END AS reason
		    FROM users u
		    JOIN employees e ON e.user_id = u.id
		    LEFT JOIN staff_attendance sa
		           ON sa.user_id = u.id AND sa.on_date = $1::date
		                              AND sa.status IN ('absent','leave')
		   WHERE e.status IN ('active','on_leave')
		     AND (sa.id IS NOT NULL
		          OR EXISTS (SELECT 1 FROM leave_requests lr
		                      WHERE lr.employee_id = e.id AND lr.status = 'approved'
		                        AND $1::date BETWEEN lr.from_date AND lr.to_date))
		)
		SELECT te.id::text, a.user_id::text, a.full_name, a.reason,
		       p.name, p.sequence, to_char(p.starts_at,'HH24:MI'),
		       c.name, sec.name, sub.name,
		       sb.substitute_user_id::text, su.full_name,
		       (sb.substitute_user_id IS NOT NULL
		        AND EXISTS (SELECT 1 FROM absent a3 WHERE a3.user_id = sb.substitute_user_id)),
		       COALESCE((
		         SELECT jsonb_agg(x)
		           FROM (SELECT u2.id::text AS user_id, u2.full_name,
		                        EXISTS (SELECT 1 FROM section_subject_teachers t2
		                                  JOIN class_subjects cs2 ON cs2.id = t2.class_subject_id
		                                 WHERE t2.teacher_user_id = u2.id
		                                   AND cs2.subject_id = cs.subject_id) AS teaches_subject,
		                        (SELECT count(*) FROM timetable_entries t3
		                          WHERE t3.teacher_user_id = u2.id
		                            AND t3.weekday = te.weekday)::int AS periods_today
		                   FROM users u2
		                   JOIN employees e2 ON e2.user_id = u2.id AND e2.status = 'active'
		                  WHERE u2.id <> a.user_id
		                    AND NOT EXISTS (SELECT 1 FROM absent a2 WHERE a2.user_id = u2.id)
		                    -- Free in this slot, and not already promised to
		                    -- another class in it by an earlier substitution.
		                    AND NOT EXISTS (SELECT 1 FROM timetable_entries t4
		                                     WHERE t4.teacher_user_id = u2.id
		                                       AND t4.weekday = te.weekday
		                                       AND t4.period_id = te.period_id)
		                    AND NOT EXISTS (SELECT 1 FROM substitutions s2
		                                      JOIN timetable_entries t5 ON t5.id = s2.timetable_entry_id
		                                     WHERE s2.substitute_user_id = u2.id
		                                       AND s2.on_date = $1::date
		                                       AND t5.period_id = te.period_id)
		                  ORDER BY teaches_subject DESC, periods_today
		                  LIMIT 8) x), '[]'::jsonb)
		  FROM absent a
		  JOIN timetable_entries te ON te.teacher_user_id = a.user_id
		                           AND te.weekday = extract(isodow FROM $1::date)::int
		  JOIN periods p ON p.id = te.period_id
		  JOIN sections sec ON sec.id = te.section_id
		  JOIN classes c ON c.id = sec.class_id
		  JOIN class_subjects cs ON cs.id = te.class_subject_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN substitutions sb ON sb.timetable_entry_id = te.id AND sb.on_date = $1::date
		  LEFT JOIN users su ON su.id = sb.substitute_user_id
		 ORDER BY p.sequence, c.level, sec.name`,
		[]any{onDate},
		func(rows pgx.Rows) (substitutionRow, error) {
			var v substitutionRow
			var raw []byte
			if err := rows.Scan(&v.TimetableEntryID, &v.AbsentUserID, &v.AbsentTeacher,
				&v.Reason, &v.Period, &v.PeriodSeq, &v.StartsAt, &v.ClassName,
				&v.SectionName, &v.Subject, &v.CoveredByID, &v.CoveredBy,
				&v.CoverAbsent, &raw); err != nil {
				return v, err
			}
			v.Candidates = []proxyCandidate{}
			if len(raw) > 0 {
				if err := json.Unmarshal(raw, &v.Candidates); err != nil {
					return v, err
				}
			}
			// jsonb_agg does not promise the subquery's order, and the first
			// name on the list is the one that gets clicked.
			sort.SliceStable(v.Candidates, func(i, j int) bool {
				if v.Candidates[i].TeachesSubject != v.Candidates[j].TeachesSubject {
					return v.Candidates[i].TeachesSubject
				}
				return v.Candidates[i].PeriodsToday < v.Candidates[j].PeriodsToday
			})
			return v, nil
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	covered, uncoverable := 0, 0
	absentees := map[string]struct{}{}
	for _, it := range items {
		absentees[it.AbsentUserID] = struct{}{}
		if it.CoveredByID != nil && !it.CoverAbsent {
			covered++
		} else if len(it.Candidates) == 0 {
			uncoverable++
		}
	}

	/* Who is away, counted from the leave register rather than from the
	   periods they were due to teach.

	   The board found absentees by walking the rows it had already built, and
	   those rows come from timetable_entries. A teacher with no timetabled
	   periods therefore produced no rows, and the screen said "nobody is
	   absent" on a day their leave had been approved. That is the worst
	   possible sentence to put in front of the person doing the morning cover:
	   it is not "nothing to arrange", it is "we have no idea".

	   It happens more than it sounds. A class teacher whose subjects were
	   never allocated, a new joiner, anybody the timetable generator skipped —
	   this school has six such teachers out of twelve. So the register is
	   asked directly, and anybody it names who produced no rows is reported as
	   away with nothing to cover, which is a true and useful thing to know. */
	away := []map[string]any{}
	_ = s.DB.InTenant(r.Context(), tenantScope(httpx.IdentityFrom(r.Context())),
		func(tx pgx.Tx) error {
			rows, err := tx.Query(r.Context(), `
				SELECT u.id::text, u.full_name,
				       CASE WHEN sa.id IS NOT NULL THEN sa.status ELSE 'on approved leave' END
				  FROM users u
				  JOIN employees e ON e.user_id = u.id
				  LEFT JOIN staff_attendance sa
				         ON sa.user_id = u.id AND sa.on_date = $1::date
				                            AND sa.status IN ('absent','leave')
				 WHERE e.status IN ('active','on_leave')
				   AND (sa.id IS NOT NULL
				        OR EXISTS (SELECT 1 FROM leave_requests lr
				                    WHERE lr.employee_id = e.id AND lr.status = 'approved'
				                      AND $1::date BETWEEN lr.from_date AND lr.to_date))
				 ORDER BY u.full_name`, onDate)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var uid, name, why string
				if err := rows.Scan(&uid, &name, &why); err != nil {
					return err
				}
				_, hasPeriods := absentees[uid]
				away = append(away, map[string]any{
					"user_id": uid, "full_name": name, "reason": why,
					// The distinction the screen has to draw: somebody away
					// with periods needs cover arranging; somebody away with
					// none needs nothing, and saying so is not the same as
					// saying nobody is away.
					"periods_today": hasPeriods,
				})
				absentees[uid] = struct{}{}
			}
			return rows.Err()
		})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":   items,
		"on_date": onDate,
		// Everybody the register says is away, including the ones with nothing
		// to cover.
		"away": away,
		"summary": map[string]any{
			"absent_teachers": len(absentees),
			"periods":         len(items),
			"covered":         covered,
			"uncovered":       len(items) - covered,
			// Periods with nobody free at all. The number that decides whether
			// a class is merged or sent to the library.
			"no_candidate": uncoverable,
		},
	})
}

// --- OBE / outcomes ------------------------------------------------------------------

type programmeOutcomeRow struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Statement string `json:"statement"`
	Kind      string `json:"kind"`
	Sequence  int    `json:"sequence"`
}

type courseOutcomeRow struct {
	ID             string  `json:"id"`
	ClassSubjectID string  `json:"class_subject_id"`
	ClassName      string  `json:"class_name"`
	Subject        string  `json:"subject"`
	Code           string  `json:"code"`
	Statement      string  `json:"statement"`
	Bloom          *string `json:"bloom_level,omitempty"`
	Threshold      int     `json:"threshold_percent"`
	Target         int     `json:"target_percent"`
	Sequence       int     `json:"sequence"`
	// The programme outcomes this one feeds, and the papers that measure it.
	MappedTo []string `json:"mapped_to"`
	Papers   int      `json:"papers"`
}

func (s *Server) getOutcomes(w http.ResponseWriter, r *http.Request) {
	csID := nullString(strings.TrimSpace(r.URL.Query().Get("class_subject_id")))

	pos, err := collect(s, r, `
		SELECT id::text, code, statement, kind, sequence
		  FROM programme_outcomes ORDER BY kind, sequence, upper(code)`, nil,
		func(rows pgx.Rows) (programmeOutcomeRow, error) {
			var v programmeOutcomeRow
			return v, rows.Scan(&v.ID, &v.Code, &v.Statement, &v.Kind, &v.Sequence)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	cos, err := collect(s, r, `
		SELECT co.id::text, cs.id::text, c.name, sub.name, co.code, co.statement,
		       co.bloom_level, co.threshold_percent, co.target_percent, co.sequence,
		       COALESCE((SELECT array_agg(po.code ORDER BY upper(po.code))
		                   FROM co_po_map m
		                   JOIN programme_outcomes po ON po.id = m.programme_outcome_id
		                  WHERE m.course_outcome_id = co.id), '{}'),
		       (SELECT count(*) FROM outcome_assessments oa
		         WHERE oa.course_outcome_id = co.id)::int
		  FROM course_outcomes co
		  JOIN class_subjects cs ON cs.id = co.class_subject_id
		  JOIN classes c ON c.id = cs.class_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		 WHERE ($1::uuid IS NULL OR co.class_subject_id = $1)
		 ORDER BY c.level, sub.name, co.sequence, upper(co.code)`,
		[]any{csID},
		func(rows pgx.Rows) (courseOutcomeRow, error) {
			var v courseOutcomeRow
			return v, rows.Scan(&v.ID, &v.ClassSubjectID, &v.ClassName, &v.Subject,
				&v.Code, &v.Statement, &v.Bloom, &v.Threshold, &v.Target,
				&v.Sequence, &v.MappedTo, &v.Papers)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"programme_outcomes": pos,
		"course_outcomes":    cos,
	})
}

type attainmentRow struct {
	CourseOutcomeID string   `json:"course_outcome_id"`
	Code            string   `json:"code"`
	Statement       string   `json:"statement"`
	ClassName       string   `json:"class_name"`
	Subject         string   `json:"subject"`
	ClassSubjectID  string   `json:"class_subject_id"`
	Threshold       int      `json:"threshold_percent"`
	Target          int      `json:"target_percent"`
	Papers          int      `json:"papers"`
	Assessed        int      `json:"students_assessed"`
	Cleared         int      `json:"students_cleared"`
	Attainment      int      `json:"attainment_percent"`
	Attained        bool     `json:"attained"`
	Gap             int      `json:"gap"`
	MappedTo        []string `json:"mapped_to"`
}

type poAttainment struct {
	Code       string `json:"code"`
	Statement  string `json:"statement"`
	Outcomes   int    `json:"course_outcomes"`
	Attainment int    `json:"attainment_percent"`
	Measured   bool   `json:"measured"`
}

/*
getOutcomeAttainment computes CO attainment from marks, and rolls it up to PO.

	Two bars, both held on the outcome rather than in this code: a child
	attains an outcome by scoring at least threshold_percent across the papers
	mapped to it, and the outcome is attained when target_percent of the class
	clear that bar. The programme figure is the strength-weighted mean of the
	course outcomes mapped to it, which is the arithmetic every accreditation
	form in India asks for.

	An outcome with no paper mapped to it reports zero assessed rather than
	nought per cent attained. The two are different facts and a gap analysis
	that confuses them sends a department to fix a subject that was never
	measured.
*/
func (s *Server) getOutcomeAttainment(w http.ResponseWriter, r *http.Request) {
	csID := nullString(strings.TrimSpace(r.URL.Query().Get("class_subject_id")))

	items, err := collect(s, r, `
		SELECT co.id::text, co.code, co.statement, c.name, sub.name, cs.id::text,
		       co.threshold_percent, co.target_percent,
		       (SELECT count(*) FROM outcome_assessments oa
		         WHERE oa.course_outcome_id = co.id)::int,
		       COALESCE(a.assessed, 0), COALESCE(a.cleared, 0),
		       COALESCE((SELECT array_agg(po.code ORDER BY upper(po.code))
		                   FROM co_po_map m
		                   JOIN programme_outcomes po ON po.id = m.programme_outcome_id
		                  WHERE m.course_outcome_id = co.id), '{}')
		  FROM course_outcomes co
		  JOIN class_subjects cs ON cs.id = co.class_subject_id
		  JOIN classes c ON c.id = cs.class_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN LATERAL (
		      SELECT count(*)::int AS assessed,
		             count(*) FILTER (WHERE pct >= co.threshold_percent)::int AS cleared
		        FROM (
		          -- One score per child across every paper mapped to the
		          -- outcome, weighted by how much of each paper tests it.
		          SELECT m.student_id,
		                 100.0 * sum(m.marks_obtained * oa.weight / 100.0)
		                       / NULLIF(sum(es.max_marks * oa.weight / 100.0), 0) AS pct
		            FROM outcome_assessments oa
		            JOIN exam_subjects es ON es.id = oa.exam_subject_id
		            JOIN marks m ON m.exam_subject_id = es.id
		                        AND NOT m.is_absent AND m.marks_obtained IS NOT NULL
		           WHERE oa.course_outcome_id = co.id
		           GROUP BY m.student_id) scores
		  ) a ON TRUE
		 WHERE ($1::uuid IS NULL OR co.class_subject_id = $1)
		 ORDER BY c.level, sub.name, co.sequence, upper(co.code)`,
		[]any{csID},
		func(rows pgx.Rows) (attainmentRow, error) {
			var v attainmentRow
			if err := rows.Scan(&v.CourseOutcomeID, &v.Code, &v.Statement, &v.ClassName,
				&v.Subject, &v.ClassSubjectID, &v.Threshold, &v.Target, &v.Papers,
				&v.Assessed, &v.Cleared, &v.MappedTo); err != nil {
				return v, err
			}
			if v.Assessed > 0 {
				v.Attainment = v.Cleared * 100 / v.Assessed
				v.Attained = v.Attainment >= v.Target
				if !v.Attained {
					v.Gap = v.Target - v.Attainment
				}
			}
			return v, nil
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// The programme roll-up. Strength is the 1-2-3 an accreditation form uses,
	// and an outcome mapped weakly to a PO must not move it as far as one
	// mapped strongly.
	type weighted struct {
		statement string
		sum, wgt  int
		outcomes  int
	}
	byCode := map[string]*weighted{}
	err = func() error {
		links, err := collect(s, r, `
			SELECT po.code, po.statement, m.course_outcome_id::text, m.strength
			  FROM co_po_map m
			  JOIN programme_outcomes po ON po.id = m.programme_outcome_id
			 ORDER BY upper(po.code)`, nil,
			func(rows pgx.Rows) ([4]string, error) {
				var code, statement, coID string
				var strength int
				err := rows.Scan(&code, &statement, &coID, &strength)
				return [4]string{code, statement, coID, string(rune('0' + strength))}, err
			})
		if err != nil {
			return err
		}
		attainment := map[string]attainmentRow{}
		for _, it := range items {
			attainment[it.CourseOutcomeID] = it
		}
		for _, l := range links {
			co, ok := attainment[l[2]]
			if !ok || co.Assessed == 0 {
				continue
			}
			strength := int(l[3][0] - '0')
			w := byCode[l[0]]
			if w == nil {
				w = &weighted{statement: l[1]}
				byCode[l[0]] = w
			}
			w.sum += co.Attainment * strength
			w.wgt += strength
			w.outcomes++
		}
		return nil
	}()
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	programme := []poAttainment{}
	for code, w := range byCode {
		p := poAttainment{Code: code, Statement: w.statement, Outcomes: w.outcomes}
		if w.wgt > 0 {
			p.Attainment = w.sum / w.wgt
			p.Measured = true
		}
		programme = append(programme, p)
	}
	sort.Slice(programme, func(i, j int) bool { return programme[i].Code < programme[j].Code })

	measured, attained := 0, 0
	for _, it := range items {
		if it.Assessed > 0 {
			measured++
			if it.Attained {
				attained++
			}
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":     items,
		"programme": programme,
		"summary": map[string]any{
			"course_outcomes": len(items),
			"measured":        measured,
			"attained":        attained,
			"not_measured":    len(items) - measured,
		},
	})
}

type programmeOutcomeRequest struct {
	ID        string `json:"id,omitempty"`
	Code      string `json:"code"`
	Statement string `json:"statement"`
	Kind      string `json:"kind,omitempty"`
	Sequence  int    `json:"sequence,omitempty"`
}

func (s *Server) saveProgrammeOutcome(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req programmeOutcomeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.TrimSpace(req.Code)
	req.Statement = strings.TrimSpace(req.Statement)
	if req.Code == "" || req.Statement == "" {
		httpx.BadRequest(w, r, "code and statement are both required")
		return
	}
	if req.Kind == "" {
		req.Kind = "po"
	}
	if req.Kind != "po" && req.Kind != "pso" {
		httpx.BadRequest(w, r, "kind must be po or pso")
		return
	}
	if req.Sequence <= 0 {
		req.Sequence = 1
	}

	var outID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			return tx.QueryRow(r.Context(), `
				UPDATE programme_outcomes
				   SET code = $2, statement = $3, kind = $4, sequence = $5
				 WHERE id = $1::uuid RETURNING id::text`,
				req.ID, req.Code, req.Statement, req.Kind, req.Sequence).Scan(&outID)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO programme_outcomes (institution_id, code, statement, kind, sequence)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (institution_id, upper(code))
			DO UPDATE SET statement = EXCLUDED.statement, kind = EXCLUDED.kind,
			              sequence = EXCLUDED.sequence
			RETURNING id::text`,
			id.InstitutionID, req.Code, req.Statement, req.Kind, req.Sequence).Scan(&outID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": outID})
}

type courseOutcomeRequest struct {
	ID             string `json:"id,omitempty"`
	ClassSubjectID string `json:"class_subject_id"`
	Code           string `json:"code"`
	Statement      string `json:"statement"`
	Bloom          string `json:"bloom_level,omitempty"`
	Threshold      int    `json:"threshold_percent,omitempty"`
	Target         int    `json:"target_percent,omitempty"`
	Sequence       int    `json:"sequence,omitempty"`
}

func (s *Server) saveCourseOutcome(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req courseOutcomeRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	csID, err := uuid.Parse(req.ClassSubjectID)
	if err != nil {
		httpx.BadRequest(w, r, "class_subject_id must be a uuid")
		return
	}
	req.Code = strings.TrimSpace(req.Code)
	req.Statement = strings.TrimSpace(req.Statement)
	if req.Code == "" || req.Statement == "" {
		httpx.BadRequest(w, r, "code and statement are both required")
		return
	}
	// The defaults a school that has never set a bar would have chosen anyway:
	// half marks to clear, three in five of the class to call it attained.
	if req.Threshold <= 0 || req.Threshold > 100 {
		req.Threshold = 50
	}
	if req.Target <= 0 || req.Target > 100 {
		req.Target = 60
	}
	if req.Sequence <= 0 {
		req.Sequence = 1
	}

	var outID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			return tx.QueryRow(r.Context(), `
				UPDATE course_outcomes
				   SET code = $2, statement = $3, bloom_level = NULLIF($4,''),
				       threshold_percent = $5, target_percent = $6, sequence = $7
				 WHERE id = $1::uuid RETURNING id::text`,
				req.ID, req.Code, req.Statement, req.Bloom, req.Threshold,
				req.Target, req.Sequence).Scan(&outID)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO course_outcomes (institution_id, class_subject_id, code, statement,
			                             bloom_level, threshold_percent, target_percent, sequence)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8)
			ON CONFLICT (class_subject_id, upper(code))
			DO UPDATE SET statement = EXCLUDED.statement,
			              bloom_level = EXCLUDED.bloom_level,
			              threshold_percent = EXCLUDED.threshold_percent,
			              target_percent = EXCLUDED.target_percent,
			              sequence = EXCLUDED.sequence
			RETURNING id::text`,
			id.InstitutionID, csID, req.Code, req.Statement, req.Bloom,
			req.Threshold, req.Target, req.Sequence).Scan(&outID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": outID})
}

type outcomeMappingRequest struct {
	CourseOutcomeID string `json:"course_outcome_id"`
	ProgrammeMap    []struct {
		ProgrammeOutcomeID string `json:"programme_outcome_id"`
		Strength           int    `json:"strength"`
	} `json:"programme_map"`
	Assessments []struct {
		ExamSubjectID string  `json:"exam_subject_id"`
		Weight        float64 `json:"weight,omitempty"`
	} `json:"assessments"`
}

// setOutcomeMapping replaces both of an outcome's maps in one call.
//
// Replace rather than merge, for the reason the syllabus chapter list is also
// replaced: a mapping matrix is edited as a grid, and a merge would leave last
// year's rows behind with nothing on screen to show they are still there.
func (s *Server) setOutcomeMapping(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req outcomeMappingRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	coID, err := uuid.Parse(req.CourseOutcomeID)
	if err != nil {
		httpx.BadRequest(w, r, "course_outcome_id must be a uuid")
		return
	}

	var mapped, assessed int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM course_outcomes WHERE id = $1)`, coID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return pgx.ErrNoRows
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM co_po_map WHERE course_outcome_id = $1`, coID); err != nil {
			return err
		}
		for _, m := range req.ProgrammeMap {
			po, err := uuid.Parse(m.ProgrammeOutcomeID)
			if err != nil {
				return errors.New("programme_outcome_id must be a uuid")
			}
			strength := m.Strength
			if strength < 1 || strength > 3 {
				strength = 1
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO co_po_map (institution_id, course_outcome_id,
				                       programme_outcome_id, strength)
				VALUES ($1,$2,$3,$4)`, id.InstitutionID, coID, po, strength); err != nil {
				return err
			}
			mapped++
		}
		if _, err := tx.Exec(r.Context(),
			`DELETE FROM outcome_assessments WHERE course_outcome_id = $1`, coID); err != nil {
			return err
		}
		for _, a := range req.Assessments {
			es, err := uuid.Parse(a.ExamSubjectID)
			if err != nil {
				return errors.New("exam_subject_id must be a uuid")
			}
			weight := a.Weight
			if weight <= 0 || weight > 100 {
				weight = 100
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO outcome_assessments (institution_id, course_outcome_id,
				                                 exam_subject_id, weight)
				VALUES ($1,$2,$3,$4)`, id.InstitutionID, coID, es, weight); err != nil {
				return err
			}
			assessed++
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"programme_outcomes_mapped": mapped, "papers_mapped": assessed,
	})
}

// --- department students ---------------------------------------------------------------

type departmentSummaryRow struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Head     *string `json:"head,omitempty"`
	Staff    int     `json:"staff"`
	Students int     `json:"students"`
	Sections int     `json:"sections"`
}

type departmentStudentRow struct {
	StudentID   string   `json:"student_id"`
	AdmissionNo string   `json:"admission_no"`
	Name        string   `json:"full_name"`
	ClassName   string   `json:"class_name"`
	SectionName string   `json:"section"`
	RollNo      *int     `json:"roll_no,omitempty"`
	Department  string   `json:"department"`
	Advisor     *string  `json:"advisor,omitempty"`
	AttendedPct *int     `json:"attendance_percent,omitempty"`
	MarksPct    *float64 `json:"marks_percent,omitempty"`
	Backlogs    int      `json:"backlogs"`
}

/*
getDepartmentStudents answers "which children is this department responsible for".

	A school department holds staff, not children — employees.department_id is
	the only edge that exists. The roll is therefore reached the way a head of
	department would reach it in conversation: their teachers, the sections
	those teachers take, and the children enrolled in them. Inventing a
	students.department_id would have been a second, wrong answer to the same
	question the moment a teacher moved department.

	With no department asked for, every department's roll, which is what a
	principal opening the screen wants.
*/
func (s *Server) getDepartmentStudents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	depts, err := collect(s, r, `
		SELECT d.id::text, d.name, u.full_name,
		       (SELECT count(*) FROM employees e
		         WHERE e.department_id = d.id AND e.status = 'active')::int,
		       (SELECT count(DISTINCT en.student_id)
		          FROM employees e
		          JOIN section_subject_teachers sst ON sst.teacher_user_id = e.user_id
		          JOIN enrollments en ON en.section_id = sst.section_id
		                             AND en.status = 'active'
		         WHERE e.department_id = d.id)::int,
		       (SELECT count(DISTINCT sst.section_id)
		          FROM employees e
		          JOIN section_subject_teachers sst ON sst.teacher_user_id = e.user_id
		         WHERE e.department_id = d.id)::int
		  FROM departments d
		  LEFT JOIN users u ON u.id = d.head_user_id
		 WHERE ($1::uuid IS NULL OR d.id = $1)
		 ORDER BY d.name`,
		[]any{nullString(strings.TrimSpace(q.Get("department_id")))},
		func(rows pgx.Rows) (departmentSummaryRow, error) {
			var v departmentSummaryRow
			return v, rows.Scan(&v.ID, &v.Name, &v.Head, &v.Staff, &v.Students, &v.Sections)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	items, err := collect(s, r, `
		WITH roll AS (
		  SELECT DISTINCT d.name AS department, en.id AS enrollment_id
		    FROM departments d
		    JOIN employees e ON e.department_id = d.id AND e.user_id IS NOT NULL
		    JOIN section_subject_teachers sst ON sst.teacher_user_id = e.user_id
		    JOIN enrollments en ON en.section_id = sst.section_id AND en.status = 'active'
		   WHERE ($1::uuid IS NULL OR d.id = $1)
		)
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       c.name, sec.name, en.roll_no, roll.department, ct.full_name,
		       att.pct, mk.pct, COALESCE(mk.backlogs, 0)
		  FROM roll
		  JOIN enrollments en ON en.id = roll.enrollment_id
		  JOIN students st ON st.id = en.student_id
		  JOIN sections sec ON sec.id = en.section_id
		  JOIN classes c ON c.id = en.class_id
		  LEFT JOIN users ct ON ct.id = sec.class_teacher_id
		  LEFT JOIN LATERAL (
		      SELECT round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late'))
		                   / NULLIF(count(*), 0))::int AS pct
		        FROM student_attendance sa WHERE sa.student_id = st.id
		  ) att ON TRUE
		  LEFT JOIN LATERAL (
		      -- Absences are excluded rather than scored nought: a child who
		      -- was ill on the day of the test has not failed it.
		      SELECT CASE WHEN sum(es.max_marks) > 0
		                  THEN round(100.0 * sum(m.marks_obtained) / sum(es.max_marks), 1)::float8
		             END AS pct,
		             count(*) FILTER (WHERE m.marks_obtained < es.pass_marks)::int AS backlogs
		        FROM marks m
		        JOIN exam_subjects es ON es.id = m.exam_subject_id
		       WHERE m.student_id = st.id AND NOT m.is_absent
		         AND m.marks_obtained IS NOT NULL
		  ) mk ON TRUE
		 WHERE st.status = 'active'
		   AND ($2::uuid IS NULL OR en.class_id = $2)
		   AND ($3::text IS NULL
		        OR st.admission_no ILIKE '%' || $3 || '%'
		        OR concat_ws(' ', st.first_name, st.middle_name, st.last_name)
		           ILIKE '%' || $3 || '%')
		 ORDER BY roll.department, c.level, sec.name, st.first_name
		 LIMIT 600`,
		[]any{nullString(strings.TrimSpace(q.Get("department_id"))),
			nullString(strings.TrimSpace(q.Get("class_id"))),
			nullString(strings.TrimSpace(q.Get("q")))},
		func(rows pgx.Rows) (departmentStudentRow, error) {
			var v departmentStudentRow
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.Name, &v.ClassName,
				&v.SectionName, &v.RollNo, &v.Department, &v.Advisor,
				&v.AttendedPct, &v.MarksPct, &v.Backlogs)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	withBacklogs := 0
	for _, it := range items {
		if it.Backlogs > 0 {
			withBacklogs++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":       items,
		"departments": depts,
		"summary": map[string]any{
			"departments":   len(depts),
			"students":      len(items),
			"with_backlogs": withBacklogs,
		},
	})
}

// --- the disciplinary incident log ----------------------------------------------------

type disciplineIncidentRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	ClassName   *string `json:"class_name,omitempty"`
	SectionName *string `json:"section,omitempty"`
	OccurredOn  string  `json:"occurred_on"`
	Category    string  `json:"category"`
	IsPositive  bool    `json:"is_positive"`
	Severity    string  `json:"severity"`
	Status      string  `json:"status"`
	Description string  `json:"description"`
	ActionTaken *string `json:"action_taken,omitempty"`
	FollowUpOn  *string `json:"follow_up_on,omitempty"`
	SuspFrom    *string `json:"suspension_from,omitempty"`
	SuspTo      *string `json:"suspension_to,omitempty"`
	SuspDays    int     `json:"suspension_days"`
	MeetingOn   *string `json:"parent_meeting_on,omitempty"`
	MeetingNote *string `json:"parent_meeting_note,omitempty"`
	Counselling *string `json:"counselling_note,omitempty"`
	ParentTold  bool    `json:"parent_notified"`
	ClosedOn    *string `json:"closed_on,omitempty"`
	RecordedBy  *string `json:"recorded_by,omitempty"`
	ClosedBy    *string `json:"closed_by,omitempty"`
	// Days an open incident has been sitting. What the queue is sorted by.
	AgeDays int `json:"age_days"`
	// Prior incidents for the same child. A third offence is a different
	// conversation from a first, and the log is the only place that shows it.
	PriorCount int `json:"prior_incidents"`
}

func (s *Server) listIncidents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	// A log asked for no window is a log of the term, not of all time.
	from, to := adminWindow(r)

	items, err := collect(s, r, `
		SELECT dr.id::text, dr.student_id::text,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.admission_no, c.name, sec.name,
		       to_char(dr.occurred_on,'YYYY-MM-DD'), dr.category, dr.is_positive,
		       dr.severity, dr.status, dr.description, dr.action_taken,
		       to_char(dr.follow_up_on,'YYYY-MM-DD'),
		       to_char(dr.suspension_from,'YYYY-MM-DD'),
		       to_char(dr.suspension_to,'YYYY-MM-DD'),
		       COALESCE(dr.suspension_to - dr.suspension_from + 1, 0)::int,
		       to_char(dr.parent_meeting_on,'YYYY-MM-DD'), dr.parent_meeting_note,
		       dr.counselling_note, dr.parent_notified,
		       to_char(dr.closed_on,'YYYY-MM-DD'),
		       ru.full_name, cu.full_name,
		       GREATEST(0, (CURRENT_DATE - dr.occurred_on))::int,
		       (SELECT count(*) FROM discipline_records p
		         WHERE p.student_id = dr.student_id AND NOT p.is_positive
		           AND p.occurred_on < dr.occurred_on)::int
		  FROM discipline_records dr
		  JOIN students st ON st.id = dr.student_id
		  LEFT JOIN LATERAL (
		      SELECT en.section_id, en.class_id FROM enrollments en
		       WHERE en.student_id = st.id AND en.status = 'active'
		       ORDER BY en.enrolled_on DESC LIMIT 1
		  ) cur ON TRUE
		  LEFT JOIN sections sec ON sec.id = cur.section_id
		  LEFT JOIN classes  c   ON c.id = cur.class_id
		  LEFT JOIN users   ru   ON ru.id = dr.recorded_by
		  LEFT JOIN users   cu   ON cu.id = dr.closed_by
		 WHERE dr.occurred_on BETWEEN $1::date AND $2::date
		   AND ($3::text IS NULL OR dr.status = $3)
		   AND ($4::text IS NULL OR dr.severity = $4)
		   AND ($5::uuid IS NULL OR dr.student_id = $5)
		   AND ($6::boolean IS NOT TRUE OR NOT dr.is_positive)
		 ORDER BY dr.occurred_on DESC, dr.created_at DESC
		 LIMIT 400`,
		[]any{from, to,
			nullString(strings.TrimSpace(q.Get("status"))),
			nullString(strings.TrimSpace(q.Get("severity"))),
			nullString(strings.TrimSpace(q.Get("student_id"))),
			q.Get("concerns_only") == "1"},
		func(rows pgx.Rows) (disciplineIncidentRow, error) {
			var v disciplineIncidentRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.StudentName, &v.AdmissionNo,
				&v.ClassName, &v.SectionName, &v.OccurredOn, &v.Category, &v.IsPositive,
				&v.Severity, &v.Status, &v.Description, &v.ActionTaken, &v.FollowUpOn,
				&v.SuspFrom, &v.SuspTo, &v.SuspDays, &v.MeetingOn, &v.MeetingNote,
				&v.Counselling, &v.ParentTold, &v.ClosedOn, &v.RecordedBy, &v.ClosedBy,
				&v.AgeDays, &v.PriorCount)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var open, serious, suspensions, meetings int
	for _, it := range items {
		if it.Status != "closed" && !it.IsPositive {
			open++
		}
		if it.Severity == "serious" {
			serious++
		}
		if it.SuspDays > 0 {
			suspensions++
		}
		if it.MeetingOn != nil {
			meetings++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "from": from, "to": to,
		"summary": map[string]any{
			"incidents": len(items), "open": open, "serious": serious,
			"suspensions": suspensions, "parent_meetings": meetings,
		},
	})
}

type disciplineIncidentUpdateRequest struct {
	Severity    string `json:"severity,omitempty"`
	Status      string `json:"status,omitempty"`
	ActionTaken string `json:"action_taken,omitempty"`
	FollowUpOn  string `json:"follow_up_on,omitempty"`
	SuspFrom    string `json:"suspension_from,omitempty"`
	SuspTo      string `json:"suspension_to,omitempty"`
	MeetingOn   string `json:"parent_meeting_on,omitempty"`
	MeetingNote string `json:"parent_meeting_note,omitempty"`
	Counselling string `json:"counselling_note,omitempty"`
	// Recording that the family was told is a separate act from recording the
	// incident, and often happens hours later.
	ParentNotified *bool `json:"parent_notified,omitempty"`
}

var incidentSeverities = map[string]bool{"minor": true, "major": true, "serious": true}
var incidentStatuses = map[string]bool{
	"open": true, "under_review": true, "action_taken": true, "closed": true,
}

/*
updateIncident escalates a conduct note into an incident, or closes one.

	Writes into discipline_records rather than a table of its own. The note a
	subject teacher wrote and the incident the office is now handling are the
	same event, and a second table would mean a suspension that the class
	teacher's own screen — which reads discipline_records — cannot see.

	Creating a record is not here on purpose: POST /students/notes already does
	it, and checks that the writer actually teaches the child.
*/
func (s *Server) updateIncident(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	incident, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid incident id")
		return
	}
	var req disciplineIncidentUpdateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if req.Severity != "" && !incidentSeverities[req.Severity] {
		httpx.BadRequest(w, r, "severity must be minor, major or serious")
		return
	}
	if req.Status != "" && !incidentStatuses[req.Status] {
		httpx.BadRequest(w, r, "status must be open, under_review, action_taken or closed")
		return
	}
	if req.SuspFrom != "" && req.SuspTo != "" && req.SuspTo < req.SuspFrom {
		httpx.BadRequest(w, r, "the suspension ends before it starts")
		return
	}
	if req.Status == "closed" && strings.TrimSpace(req.ActionTaken) == "" {
		// An incident closed with no action recorded is the row an inspection
		// asks about and the school cannot answer.
		var recorded bool
		err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(),
				`SELECT COALESCE(btrim(action_taken), '') <> ''
				   FROM discipline_records WHERE id = $1`, incident).Scan(&recorded)
		})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.NotFound(w, r)
			return
		}
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		if !recorded {
			httpx.BadRequest(w, r,
				"say what was done before closing it. A closed incident with no action recorded answers nothing later")
			return
		}
	}

	var found bool
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE discipline_records
			   SET severity            = COALESCE(NULLIF($2,''), severity),
			       status              = COALESCE(NULLIF($3,''), status),
			       action_taken        = COALESCE(NULLIF($4,''), action_taken),
			       follow_up_on        = COALESCE(NULLIF($5,'')::date, follow_up_on),
			       suspension_from     = COALESCE(NULLIF($6,'')::date, suspension_from),
			       suspension_to       = COALESCE(NULLIF($7,'')::date, suspension_to),
			       parent_meeting_on   = COALESCE(NULLIF($8,'')::date, parent_meeting_on),
			       parent_meeting_note = COALESCE(NULLIF($9,''), parent_meeting_note),
			       counselling_note    = COALESCE(NULLIF($10,''), counselling_note),
			       parent_notified     = COALESCE($11::boolean, parent_notified),
			       -- Stamped by the database rather than sent by the client, so
			       -- "closed" and "closed on" can never disagree.
			       closed_on = CASE WHEN $3 = 'closed' THEN COALESCE(closed_on, CURRENT_DATE)
			                        WHEN $3 <> '' THEN NULL ELSE closed_on END,
			       closed_by = CASE WHEN $3 = 'closed' THEN COALESCE(closed_by, $12)
			                        WHEN $3 <> '' THEN NULL ELSE closed_by END
			 WHERE id = $1`,
			incident, req.Severity, req.Status, req.ActionTaken, req.FollowUpOn,
			req.SuspFrom, req.SuspTo, req.MeetingOn, req.MeetingNote,
			req.Counselling, req.ParentNotified, id.UserID)
		found = err == nil && tag.RowsAffected() > 0
		return err
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	if !found {
		httpx.NotFound(w, r)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": incident.String()})
}

// --- the student council ------------------------------------------------------------

type councilPositionRow struct {
	ID          string  `json:"id"`
	YearID      string  `json:"academic_year_id"`
	YearName    string  `json:"academic_year"`
	Title       string  `json:"title"`
	Portfolio   *string `json:"portfolio,omitempty"`
	Seats       int     `json:"seats"`
	IsElected   bool    `json:"is_elected"`
	Sequence    int     `json:"sequence"`
	Description *string `json:"description,omitempty"`
	Filled      int     `json:"filled"`
	Vacancies   int     `json:"vacancies"`
}

type councilMemberRow struct {
	ID          string  `json:"id"`
	PositionID  string  `json:"position_id"`
	Position    string  `json:"position"`
	StudentID   string  `json:"student_id"`
	StudentName string  `json:"student_name"`
	AdmissionNo string  `json:"admission_no"`
	ClassName   *string `json:"class_name,omitempty"`
	SectionName *string `json:"section,omitempty"`
	ElectedOn   *string `json:"elected_on,omitempty"`
	TermFrom    string  `json:"term_from"`
	TermTo      *string `json:"term_to,omitempty"`
	Votes       *int    `json:"votes,omitempty"`
	Status      string  `json:"status"`
	Remarks     *string `json:"remarks,omitempty"`
	Duties      int     `json:"duties"`
	DutiesDone  int     `json:"duties_done"`
}

// getCouncil serves the year's council: the posts, and who holds them.
//
// With no year asked for, the current one, falling back to the most recent
// council a school has ever run — a screen that opens empty because nobody
// passed a year parameter reads as a broken feature.
func (s *Server) getCouncil(w http.ResponseWriter, r *http.Request) {
	yearID := nullString(strings.TrimSpace(r.URL.Query().Get("academic_year_id")))
	const resolveYear = `
		COALESCE($1::uuid,
		         (SELECT id FROM academic_years WHERE is_current ORDER BY starts_on DESC LIMIT 1),
		         (SELECT academic_year_id FROM council_positions
		           ORDER BY created_at DESC LIMIT 1))`

	positions, err := collect(s, r, `
		SELECT cp.id::text, cp.academic_year_id::text, ay.name, cp.title, cp.portfolio,
		       cp.seats, cp.is_elected, cp.sequence, cp.description,
		       (SELECT count(*) FROM council_members cm
		         WHERE cm.position_id = cp.id AND cm.status = 'serving')::int
		  FROM council_positions cp
		  JOIN academic_years ay ON ay.id = cp.academic_year_id
		 WHERE cp.academic_year_id = `+resolveYear+`
		 ORDER BY cp.sequence, lower(cp.title)`,
		[]any{yearID},
		func(rows pgx.Rows) (councilPositionRow, error) {
			var v councilPositionRow
			if err := rows.Scan(&v.ID, &v.YearID, &v.YearName, &v.Title, &v.Portfolio,
				&v.Seats, &v.IsElected, &v.Sequence, &v.Description, &v.Filled); err != nil {
				return v, err
			}
			v.Vacancies = max(v.Seats-v.Filled, 0)
			return v, nil
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	members, err := collect(s, r, `
		SELECT cm.id::text, cp.id::text, cp.title, st.id::text,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.admission_no, c.name, sec.name,
		       to_char(cm.elected_on,'YYYY-MM-DD'), to_char(cm.term_from,'YYYY-MM-DD'),
		       to_char(cm.term_to,'YYYY-MM-DD'), cm.votes, cm.status, cm.remarks,
		       (SELECT count(*) FROM council_duties cd WHERE cd.member_id = cm.id)::int,
		       (SELECT count(*) FROM council_duties cd
		         WHERE cd.member_id = cm.id AND cd.performed)::int
		  FROM council_members cm
		  JOIN council_positions cp ON cp.id = cm.position_id
		  JOIN students st ON st.id = cm.student_id
		  LEFT JOIN LATERAL (
		      SELECT en.section_id, en.class_id FROM enrollments en
		       WHERE en.student_id = st.id AND en.status = 'active'
		       ORDER BY en.enrolled_on DESC LIMIT 1
		  ) cur ON TRUE
		  LEFT JOIN sections sec ON sec.id = cur.section_id
		  LEFT JOIN classes  c   ON c.id = cur.class_id
		 WHERE cp.academic_year_id = `+resolveYear+`
		 ORDER BY cp.sequence, cm.status, st.first_name`,
		[]any{yearID},
		func(rows pgx.Rows) (councilMemberRow, error) {
			var v councilMemberRow
			return v, rows.Scan(&v.ID, &v.PositionID, &v.Position, &v.StudentID,
				&v.StudentName, &v.AdmissionNo, &v.ClassName, &v.SectionName,
				&v.ElectedOn, &v.TermFrom, &v.TermTo, &v.Votes, &v.Status,
				&v.Remarks, &v.Duties, &v.DutiesDone)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	seats, vacancies, duties, done := 0, 0, 0, 0
	for _, p := range positions {
		seats += p.Seats
		vacancies += p.Vacancies
	}
	for _, m := range members {
		duties += m.Duties
		done += m.DutiesDone
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"positions": positions,
		"members":   members,
		"summary": map[string]any{
			"positions": len(positions), "seats": seats, "vacancies": vacancies,
			"serving": len(members), "duties": duties, "duties_done": done,
		},
	})
}

type councilPositionRequest struct {
	ID             string `json:"id,omitempty"`
	AcademicYearID string `json:"academic_year_id,omitempty"`
	Title          string `json:"title"`
	Portfolio      string `json:"portfolio,omitempty"`
	Seats          int    `json:"seats,omitempty"`
	IsElected      *bool  `json:"is_elected,omitempty"`
	Sequence       int    `json:"sequence,omitempty"`
	Description    string `json:"description,omitempty"`
}

func (s *Server) saveCouncilPosition(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req councilPositionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		httpx.BadRequest(w, r, "give the post a title")
		return
	}
	if req.Seats <= 0 {
		req.Seats = 1
	}
	if req.Sequence <= 0 {
		req.Sequence = 1
	}
	elected := true
	if req.IsElected != nil {
		elected = *req.IsElected
	}

	var outID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			return tx.QueryRow(r.Context(), `
				UPDATE council_positions
				   SET title = $2, portfolio = NULLIF($3,''), seats = $4,
				       is_elected = $5, sequence = $6, description = NULLIF($7,'')
				 WHERE id = $1::uuid RETURNING id::text`,
				req.ID, req.Title, req.Portfolio, req.Seats, elected,
				req.Sequence, req.Description).Scan(&outID)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO council_positions (institution_id, academic_year_id, title,
			                               portfolio, seats, is_elected, sequence, description)
			VALUES ($1,
			        COALESCE(NULLIF($2,'')::uuid,
			                 (SELECT id FROM academic_years WHERE is_current
			                   ORDER BY starts_on DESC LIMIT 1)),
			        $3, NULLIF($4,''), $5, $6, $7, NULLIF($8,''))
			ON CONFLICT (academic_year_id, lower(title))
			DO UPDATE SET portfolio = EXCLUDED.portfolio, seats = EXCLUDED.seats,
			              is_elected = EXCLUDED.is_elected, sequence = EXCLUDED.sequence,
			              description = EXCLUDED.description
			RETURNING id::text`,
			id.InstitutionID, req.AcademicYearID, req.Title, req.Portfolio,
			req.Seats, elected, req.Sequence, req.Description).Scan(&outID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		// A school with no academic year set up at all trips the NOT NULL,
		// which is worth saying plainly rather than as a constraint name.
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": outID})
}

type councilMemberRequest struct {
	ID         string `json:"id,omitempty"`
	PositionID string `json:"position_id"`
	StudentID  string `json:"student_id"`
	ElectedOn  string `json:"elected_on,omitempty"`
	TermFrom   string `json:"term_from,omitempty"`
	TermTo     string `json:"term_to,omitempty"`
	Votes      *int   `json:"votes,omitempty"`
	Status     string `json:"status,omitempty"`
	Remarks    string `json:"remarks,omitempty"`
}

var errCouncilFull = errors.New("that post has no seat left")

// saveCouncilMember seats a child in a post, refusing to overfill it.
//
// The seat count is the whole point of the seats column: "four house captains"
// is one post with four seats, and a fifth arrives by accident far more often
// than on purpose.
func (s *Server) saveCouncilMember(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req councilMemberRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	position, err := uuid.Parse(req.PositionID)
	if err != nil {
		httpx.BadRequest(w, r, "position_id must be a uuid")
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.Status == "" {
		req.Status = "serving"
	}
	switch req.Status {
	case "serving", "completed", "resigned", "removed":
	default:
		httpx.BadRequest(w, r, "status must be serving, completed, resigned or removed")
		return
	}

	var outID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			return tx.QueryRow(r.Context(), `
				UPDATE council_members
				   SET elected_on = NULLIF($2,'')::date,
				       term_to = NULLIF($3,'')::date, votes = $4,
				       status = $5, remarks = NULLIF($6,'')
				 WHERE id = $1::uuid RETURNING id::text`,
				req.ID, req.ElectedOn, req.TermTo, req.Votes,
				req.Status, req.Remarks).Scan(&outID)
		}
		if req.Status == "serving" {
			var full bool
			if err := tx.QueryRow(r.Context(), `
				SELECT (SELECT count(*) FROM council_members cm
				         WHERE cm.position_id = $1 AND cm.status = 'serving')
				       >= (SELECT seats FROM council_positions WHERE id = $1)`,
				position).Scan(&full); err != nil {
				return err
			}
			if full {
				return errCouncilFull
			}
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO council_members (institution_id, position_id, student_id,
			                             elected_on, term_from, term_to, votes,
			                             status, remarks, recorded_by)
			VALUES ($1,$2,$3, NULLIF($4,'')::date,
			        COALESCE(NULLIF($5,'')::date, current_date),
			        NULLIF($6,'')::date, $7, $8, NULLIF($9,''), $10)
			ON CONFLICT (position_id, student_id, term_from)
			DO UPDATE SET elected_on = EXCLUDED.elected_on, term_to = EXCLUDED.term_to,
			              votes = EXCLUDED.votes, status = EXCLUDED.status,
			              remarks = EXCLUDED.remarks
			RETURNING id::text`,
			id.InstitutionID, position, student, req.ElectedOn, req.TermFrom,
			req.TermTo, req.Votes, req.Status, req.Remarks, id.UserID).Scan(&outID)
	})
	if errors.Is(err, errCouncilFull) {
		httpx.Error(w, r, http.StatusConflict, "position_full",
			"every seat on that post is taken. Raise the seat count or end somebody's term first")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": outID})
}

type councilDutyRequest struct {
	MemberID  string `json:"member_id"`
	OnDate    string `json:"on_date,omitempty"`
	Duty      string `json:"duty"`
	Notes     string `json:"notes,omitempty"`
	Performed bool   `json:"performed,omitempty"`
}

func (s *Server) saveCouncilDuty(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req councilDutyRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	member, err := uuid.Parse(req.MemberID)
	if err != nil {
		httpx.BadRequest(w, r, "member_id must be a uuid")
		return
	}
	req.Duty = strings.TrimSpace(req.Duty)
	if req.Duty == "" {
		httpx.BadRequest(w, r,
			"say what the duty was, \"she was head girl\" is worth nothing in a testimonial and \"she ran the assembly rota\" is")
		return
	}

	var outID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO council_duties (institution_id, member_id, on_date, duty,
			                            notes, performed, recorded_by)
			VALUES ($1,$2, COALESCE(NULLIF($3,'')::date, current_date), $4,
			        NULLIF($5,''), $6, $7)
			RETURNING id::text`,
			id.InstitutionID, member, req.OnDate, req.Duty,
			req.Notes, req.Performed, id.UserID).Scan(&outID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": outID})
}

// --- the alumni programme -------------------------------------------------------------

type alumniRow struct {
	ID          string  `json:"id"`
	StudentID   string  `json:"student_id"`
	AdmissionNo string  `json:"admission_no"`
	Name        string  `json:"full_name"`
	BatchYear   int     `json:"batch_year"`
	Occupation  *string `json:"occupation,omitempty"`
	Employer    *string `json:"employer,omitempty"`
	HigherStudy *string `json:"higher_study,omitempty"`
	City        *string `json:"city,omitempty"`
	Country     string  `json:"country"`
	Email       *string `json:"email,omitempty"`
	Phone       *string `json:"phone,omitempty"`
	Contactable bool    `json:"contactable"`
	Notes       *string `json:"notes,omitempty"`
	Events      int     `json:"events_attended"`
	GivenPaise  int64   `json:"contributed_paise"`
	LastContact *string `json:"last_contribution_on,omitempty"`
}

type alumniCandidateRow struct {
	StudentID   string  `json:"student_id"`
	AdmissionNo string  `json:"admission_no"`
	Name        string  `json:"full_name"`
	Status      string  `json:"status"`
	LeftOn      *string `json:"left_on,omitempty"`
	BatchYear   int     `json:"batch_year"`
}

/*
getAlumni serves the directory and the children who ought to be in it.

	students.status already carries 'graduated' and 'alumni', so the directory
	is not a second copy of the child: it is the handful of facts a school only
	learns after they leave. The candidates list is the gap between the two —
	every leaver with no profile yet — because an alumni programme dies of
	nobody ever getting round to entering last year's batch.
*/
func (s *Server) getAlumni(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	batch := nullInt(strings.TrimSpace(q.Get("batch_year")))
	search := nullString(strings.TrimSpace(q.Get("q")))

	items, err := collect(s, r, `
		SELECT ap.id::text, st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       ap.batch_year, ap.occupation, ap.employer, ap.higher_study,
		       ap.city, ap.country, ap.email::text, ap.phone, ap.contactable, ap.notes,
		       (SELECT count(*) FROM alumni_event_rsvps re
		         WHERE re.alumni_profile_id = ap.id AND re.attended)::int,
		       COALESCE((SELECT sum(ac.amount_paise) FROM alumni_contributions ac
		                  WHERE ac.alumni_profile_id = ap.id), 0)::bigint,
		       to_char((SELECT max(ac.received_on) FROM alumni_contributions ac
		                 WHERE ac.alumni_profile_id = ap.id), 'YYYY-MM-DD')
		  FROM alumni_profiles ap
		  JOIN students st ON st.id = ap.student_id
		 WHERE ($1::int IS NULL OR ap.batch_year = $1)
		   AND ($2::text IS NULL
		        OR st.admission_no ILIKE '%' || $2 || '%'
		        OR concat_ws(' ', st.first_name, st.middle_name, st.last_name)
		           ILIKE '%' || $2 || '%'
		        OR COALESCE(ap.employer,'') ILIKE '%' || $2 || '%'
		        OR COALESCE(ap.occupation,'') ILIKE '%' || $2 || '%')
		 ORDER BY ap.batch_year DESC, st.first_name
		 LIMIT 500`,
		[]any{batch, search},
		func(rows pgx.Rows) (alumniRow, error) {
			var v alumniRow
			return v, rows.Scan(&v.ID, &v.StudentID, &v.AdmissionNo, &v.Name,
				&v.BatchYear, &v.Occupation, &v.Employer, &v.HigherStudy, &v.City,
				&v.Country, &v.Email, &v.Phone, &v.Contactable, &v.Notes,
				&v.Events, &v.GivenPaise, &v.LastContact)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	candidates, err := collect(s, r, `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.status, to_char(st.exit_date,'YYYY-MM-DD'),
		       -- The leaving year. An Indian school year runs June to April, so
		       -- a child who left in March belongs to the year that started the
		       -- previous June.
		       CASE WHEN extract(month FROM COALESCE(st.exit_date, CURRENT_DATE)) < 6
		            THEN extract(year FROM COALESCE(st.exit_date, CURRENT_DATE))::int - 1
		            ELSE extract(year FROM COALESCE(st.exit_date, CURRENT_DATE))::int END
		  FROM students st
		 WHERE st.status IN ('graduated','alumni')
		   AND NOT EXISTS (SELECT 1 FROM alumni_profiles ap WHERE ap.student_id = st.id)
		 ORDER BY st.exit_date DESC NULLS LAST, st.first_name
		 LIMIT 200`, nil,
		func(rows pgx.Rows) (alumniCandidateRow, error) {
			var v alumniCandidateRow
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.Name, &v.Status,
				&v.LeftOn, &v.BatchYear)
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	var total int64
	contactable, batches := 0, map[int]struct{}{}
	for _, it := range items {
		total += it.GivenPaise
		if it.Contactable {
			contactable++
		}
		batches[it.BatchYear] = struct{}{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":      items,
		"candidates": candidates,
		"summary": map[string]any{
			"alumni": len(items), "batches": len(batches),
			"contactable": contactable, "not_yet_enrolled": len(candidates),
			"contributed_paise": total,
		},
	})
}

type alumniEventRow struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	OnDate       string  `json:"on_date"`
	Venue        *string `json:"venue,omitempty"`
	Description  *string `json:"description,omitempty"`
	Expected     *int    `json:"expected,omitempty"`
	Status       string  `json:"status"`
	Invited      int     `json:"invited"`
	Accepted     int     `json:"accepted"`
	Attended     int     `json:"attended"`
	Guests       int     `json:"guests"`
	RaisedPaise  int64   `json:"raised_paise"`
	AcademicYear *string `json:"academic_year,omitempty"`
}

func (s *Server) listAlumniEvents(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT ae.id::text, ae.title, to_char(ae.on_date,'YYYY-MM-DD'), ae.venue,
		       ae.description, ae.expected, ae.status,
		       (SELECT count(*) FROM alumni_event_rsvps re WHERE re.event_id = ae.id)::int,
		       (SELECT count(*) FROM alumni_event_rsvps re
		         WHERE re.event_id = ae.id AND re.rsvp = 'yes')::int,
		       (SELECT count(*) FROM alumni_event_rsvps re
		         WHERE re.event_id = ae.id AND re.attended)::int,
		       COALESCE((SELECT sum(re.guests) FROM alumni_event_rsvps re
		                  WHERE re.event_id = ae.id AND re.attended), 0)::int,
		       COALESCE((SELECT sum(ac.amount_paise) FROM alumni_contributions ac
		                  WHERE ac.event_id = ae.id), 0)::bigint,
		       ay.name
		  FROM alumni_events ae
		  LEFT JOIN academic_years ay ON ay.id = ae.academic_year_id
		 WHERE ($1::text IS NULL OR ae.status = $1)
		 ORDER BY ae.on_date DESC
		 LIMIT 200`,
		[]any{nullString(strings.TrimSpace(r.URL.Query().Get("status")))},
		func(rows pgx.Rows) (alumniEventRow, error) {
			var v alumniEventRow
			return v, rows.Scan(&v.ID, &v.Title, &v.OnDate, &v.Venue, &v.Description,
				&v.Expected, &v.Status, &v.Invited, &v.Accepted, &v.Attended,
				&v.Guests, &v.RaisedPaise, &v.AcademicYear)
		})
	respond(w, r, items, err)
}

type alumniProfileRequest struct {
	ID          string `json:"id,omitempty"`
	StudentID   string `json:"student_id"`
	BatchYear   int    `json:"batch_year,omitempty"`
	Occupation  string `json:"occupation,omitempty"`
	Employer    string `json:"employer,omitempty"`
	HigherStudy string `json:"higher_study,omitempty"`
	City        string `json:"city,omitempty"`
	Country     string `json:"country,omitempty"`
	Email       string `json:"email,omitempty"`
	Phone       string `json:"phone,omitempty"`
	Contactable *bool  `json:"contactable,omitempty"`
	Notes       string `json:"notes,omitempty"`
}

func (s *Server) saveAlumniProfile(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req alumniProfileRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	student, err := uuid.Parse(req.StudentID)
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}
	if req.BatchYear != 0 && (req.BatchYear < 1900 || req.BatchYear > 2200) {
		httpx.BadRequest(w, r, "batch_year is not a year this school could have run")
		return
	}
	if req.Country == "" {
		req.Country = "India"
	}
	contactable := true
	if req.Contactable != nil {
		contactable = *req.Contactable
	}

	var outID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO alumni_profiles (institution_id, student_id, batch_year,
			                             occupation, employer, higher_study, city,
			                             country, email, phone, contactable, notes)
			VALUES ($1,$2,
			        -- Taken from the leaving date when the caller does not say,
			        -- because "which batch" is the one field nobody remembers
			        -- and everybody sorts by.
			        COALESCE(NULLIF($3,0),
			                 (SELECT CASE WHEN extract(month FROM COALESCE(exit_date, CURRENT_DATE)) < 6
			                              THEN extract(year FROM COALESCE(exit_date, CURRENT_DATE))::int - 1
			                              ELSE extract(year FROM COALESCE(exit_date, CURRENT_DATE))::int END
			                    FROM students WHERE id = $2)),
			        NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), NULLIF($7,''),
			        $8, NULLIF($9,'')::citext, NULLIF($10,''), $11, NULLIF($12,''))
			ON CONFLICT (student_id) DO UPDATE SET
			    batch_year   = COALESCE(NULLIF($3,0), alumni_profiles.batch_year),
			    occupation   = EXCLUDED.occupation,
			    employer     = EXCLUDED.employer,
			    higher_study = EXCLUDED.higher_study,
			    city         = EXCLUDED.city,
			    country      = EXCLUDED.country,
			    email        = EXCLUDED.email,
			    phone        = EXCLUDED.phone,
			    contactable  = EXCLUDED.contactable,
			    notes        = EXCLUDED.notes,
			    updated_at   = now()
			RETURNING id::text`,
			id.InstitutionID, student, req.BatchYear, req.Occupation, req.Employer,
			req.HigherStudy, req.City, req.Country, req.Email, req.Phone,
			contactable, req.Notes).Scan(&outID)
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": outID})
}

type alumniEventRequest struct {
	ID             string `json:"id,omitempty"`
	AcademicYearID string `json:"academic_year_id,omitempty"`
	Title          string `json:"title"`
	OnDate         string `json:"on_date"`
	Venue          string `json:"venue,omitempty"`
	Description    string `json:"description,omitempty"`
	Expected       *int   `json:"expected,omitempty"`
	Status         string `json:"status,omitempty"`
}

func (s *Server) saveAlumniEvent(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req alumniEventRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || strings.TrimSpace(req.OnDate) == "" {
		httpx.BadRequest(w, r, "title and on_date are both required")
		return
	}
	if req.Status == "" {
		req.Status = "planned"
	}
	switch req.Status {
	case "planned", "open", "held", "cancelled":
	default:
		httpx.BadRequest(w, r, "status must be planned, open, held or cancelled")
		return
	}

	var outID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			return tx.QueryRow(r.Context(), `
				UPDATE alumni_events
				   SET title = $2, on_date = $3::date, venue = NULLIF($4,''),
				       description = NULLIF($5,''), expected = $6, status = $7
				 WHERE id = $1::uuid RETURNING id::text`,
				req.ID, req.Title, req.OnDate, req.Venue, req.Description,
				req.Expected, req.Status).Scan(&outID)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO alumni_events (institution_id, academic_year_id, title, on_date,
			                           venue, description, expected, status, created_by)
			VALUES ($1,
			        COALESCE(NULLIF($2,'')::uuid,
			                 (SELECT id FROM academic_years WHERE is_current
			                   ORDER BY starts_on DESC LIMIT 1)),
			        $3, $4::date, NULLIF($5,''), NULLIF($6,''), $7, $8, $9)
			ON CONFLICT (institution_id, on_date, lower(title))
			DO UPDATE SET venue = EXCLUDED.venue, description = EXCLUDED.description,
			              expected = EXCLUDED.expected, status = EXCLUDED.status
			RETURNING id::text`,
			id.InstitutionID, req.AcademicYearID, req.Title, req.OnDate, req.Venue,
			req.Description, req.Expected, req.Status, id.UserID).Scan(&outID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": outID})
}

type alumniAttendanceRequest struct {
	Entries []struct {
		AlumniProfileID string `json:"alumni_profile_id"`
		RSVP            string `json:"rsvp,omitempty"`
		Attended        *bool  `json:"attended,omitempty"`
		Guests          *int   `json:"guests,omitempty"`
	} `json:"entries"`
}

// recordAlumniAttendance takes the door list in one call.
//
// RSVP and attendance are separate columns rather than one status because the
// gap between them is the number next year's catering is ordered from.
func (s *Server) recordAlumniAttendance(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	event, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid event id")
		return
	}
	var req alumniAttendanceRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Entries) == 0 {
		httpx.BadRequest(w, r, "send at least one entry")
		return
	}

	var written int
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		for _, e := range req.Entries {
			profile, err := uuid.Parse(e.AlumniProfileID)
			if err != nil {
				return errors.New("alumni_profile_id must be a uuid")
			}
			rsvp := e.RSVP
			if rsvp == "" {
				rsvp = "invited"
			}
			switch rsvp {
			case "invited", "yes", "no", "maybe":
			default:
				return errors.New("rsvp must be invited, yes, no or maybe")
			}
			attended := false
			if e.Attended != nil {
				attended = *e.Attended
			}
			guests := 0
			if e.Guests != nil && *e.Guests > 0 {
				guests = *e.Guests
			}
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO alumni_event_rsvps (institution_id, event_id,
				                                alumni_profile_id, rsvp, attended, guests)
				VALUES ($1,$2,$3,$4,$5,$6)
				ON CONFLICT (event_id, alumni_profile_id)
				DO UPDATE SET rsvp = EXCLUDED.rsvp, attended = EXCLUDED.attended,
				              guests = EXCLUDED.guests`,
				id.InstitutionID, event, profile, rsvp, attended, guests); err != nil {
				return err
			}
			written++
		}
		return nil
	})
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"recorded": written})
}

type alumniContributionRequest struct {
	AlumniProfileID string `json:"alumni_profile_id"`
	EventID         string `json:"event_id,omitempty"`
	ReceivedOn      string `json:"received_on,omitempty"`
	AmountPaise     int64  `json:"amount_paise"`
	Kind            string `json:"kind,omitempty"`
	Purpose         string `json:"purpose,omitempty"`
	ReceiptNo       string `json:"receipt_no,omitempty"`
	Acknowledged    bool   `json:"acknowledged,omitempty"`
}

// recordAlumniContribution logs a gift.
//
// Deliberately not a payment or an invoice: those are the fee ledger, and a
// donation posted there shows up as school income against a student account.
// The accounting entry, when a school wants one, is a journal voucher raised
// from this row rather than this row pretending to be one.
func (s *Server) recordAlumniContribution(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req alumniContributionRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	profile, err := uuid.Parse(req.AlumniProfileID)
	if err != nil {
		httpx.BadRequest(w, r, "alumni_profile_id must be a uuid")
		return
	}
	if req.AmountPaise <= 0 {
		httpx.BadRequest(w, r, "amount_paise must be more than zero")
		return
	}
	if req.Kind == "" {
		req.Kind = "cash"
	}
	switch req.Kind {
	case "cash", "kind", "scholarship", "infrastructure":
	default:
		httpx.BadRequest(w, r, "kind must be cash, kind, scholarship or infrastructure")
		return
	}

	var outID string
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO alumni_contributions (institution_id, alumni_profile_id, event_id,
			                                  received_on, amount_paise, kind, purpose,
			                                  receipt_no, acknowledged, recorded_by)
			VALUES ($1,$2, NULLIF($3,'')::uuid,
			        COALESCE(NULLIF($4,'')::date, current_date),
			        $5,$6, NULLIF($7,''), NULLIF($8,''), $9, $10)
			RETURNING id::text`,
			id.InstitutionID, profile, req.EventID, req.ReceivedOn, req.AmountPaise,
			req.Kind, req.Purpose, req.ReceiptNo, req.Acknowledged, id.UserID).Scan(&outID)
	})
	if msg, ok := duplicateKey(err); ok {
		httpx.Error(w, r, http.StatusConflict, "duplicate_receipt", msg)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": outID})
}

/*
duplicateKey turns a unique violation into a sentence.

	The alumni receipt number is the one key in this file a clerk types by
	hand, so it is the one that clashes. Passing Postgres's own wording through
	as a 400 puts "duplicate key value violates unique constraint" on a
	school's screen, which tells the person holding the receipt book nothing.
*/
func duplicateKey(err error) (string, bool) {
	var pge *pgconn.PgError
	if !errors.As(err, &pge) || pge.Code != "23505" {
		return "", false
	}
	if pge.ConstraintName == "alumni_contributions_receipt" {
		return "that receipt number is already against another gift, check the counterfoil", true
	}
	return "that already exists: " + pge.ConstraintName, true
}

// --- certificate and document templates -------------------------------------------------

type certificateTemplateRow struct {
	ID               string  `json:"id"`
	Code             string  `json:"code"`
	Name             string  `json:"name"`
	SubjectKind      string  `json:"subject_kind"`
	IsActive         bool    `json:"is_active"`
	RequiresApproval bool    `json:"requires_approval"`
	Description      *string `json:"description,omitempty"`
	TemplateHTML     *string `json:"template_html,omitempty"`
	PageSize         string  `json:"page_size"`
	Orientation      string  `json:"orientation"`
	SerialPrefix     *string `json:"serial_prefix,omitempty"`
	Signatory        *string `json:"signatory,omitempty"`
	SignatoryRole    *string `json:"signatory_role,omitempty"`
	Issued           int     `json:"issued"`
	Pending          int     `json:"pending"`
	LastIssued       *string `json:"last_issued_on,omitempty"`
	// True when the template body is still empty. Without it a school thinks it
	// has configured a transfer certificate and discovers at the counter that
	// it prints a blank page.
	NeedsBody bool `json:"needs_body"`
}

/*
certificatePlaceholders is the vocabulary a template may use.

	Published by the GET so the person designing a template is not guessing at
	names. Kept in one place because the renderer below and the screen's help
	text must agree — a placeholder listed but not substituted prints as
	literal braces on a school's letterhead.
*/
var certificatePlaceholders = []map[string]string{
	{"token": "{{student_name}}", "means": "the child's full name"},
	{"token": "{{admission_no}}", "means": "admission number"},
	{"token": "{{class}}", "means": "current class"},
	{"token": "{{section}}", "means": "current section"},
	{"token": "{{date_of_birth}}", "means": "date of birth"},
	{"token": "{{guardian_name}}", "means": "the guardian on record"},
	{"token": "{{admission_date}}", "means": "date of admission"},
	{"token": "{{exit_date}}", "means": "date of leaving, where recorded"},
	{"token": "{{school_name}}", "means": "the institution's name"},
	{"token": "{{serial_no}}", "means": "the certificate serial"},
	{"token": "{{issued_on}}", "means": "today's date"},
	{"token": "{{signatory}}", "means": "the name configured on the template"},
	{"token": "{{signatory_role}}", "means": "the designation configured on the template"},
}

func (s *Server) listCertificateTemplates(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	items, err := collect(s, r, `
		SELECT ct.id::text, ct.code, ct.name, ct.subject_kind, ct.is_active,
		       ct.requires_approval, ct.description, ct.template_html,
		       ct.page_size, ct.orientation, ct.serial_prefix,
		       ct.signatory, ct.signatory_role,
		       (SELECT count(*) FROM issued_certificates ic
		         WHERE ic.certificate_type_id = ct.id AND ic.status = 'issued')::int,
		       (SELECT count(*) FROM issued_certificates ic
		         WHERE ic.certificate_type_id = ct.id
		           AND ic.status IN ('requested','approved'))::int,
		       to_char((SELECT max(ic.issued_on) FROM issued_certificates ic
		                 WHERE ic.certificate_type_id = ct.id), 'YYYY-MM-DD')
		  FROM certificate_types ct
		 WHERE ($1::text IS NULL OR ct.subject_kind = $1)
		   AND ($2::boolean IS NOT TRUE OR ct.is_active)
		 ORDER BY ct.subject_kind, ct.name`,
		[]any{nullString(strings.TrimSpace(q.Get("subject_kind"))),
			q.Get("active") == "1"},
		func(rows pgx.Rows) (certificateTemplateRow, error) {
			var v certificateTemplateRow
			if err := rows.Scan(&v.ID, &v.Code, &v.Name, &v.SubjectKind, &v.IsActive,
				&v.RequiresApproval, &v.Description, &v.TemplateHTML, &v.PageSize,
				&v.Orientation, &v.SerialPrefix, &v.Signatory, &v.SignatoryRole,
				&v.Issued, &v.Pending, &v.LastIssued); err != nil {
				return v, err
			}
			v.NeedsBody = v.TemplateHTML == nil || strings.TrimSpace(*v.TemplateHTML) == ""
			return v, nil
		})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	unconfigured := 0
	for _, it := range items {
		if it.NeedsBody && it.IsActive {
			unconfigured++
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items":        items,
		"placeholders": certificatePlaceholders,
		"summary": map[string]any{
			"templates": len(items), "unconfigured": unconfigured,
		},
	})
}

type certificateTemplateRequest struct {
	ID               string `json:"id,omitempty"`
	Code             string `json:"code"`
	Name             string `json:"name"`
	SubjectKind      string `json:"subject_kind,omitempty"`
	IsActive         *bool  `json:"is_active,omitempty"`
	RequiresApproval *bool  `json:"requires_approval,omitempty"`
	Description      string `json:"description,omitempty"`
	TemplateHTML     string `json:"template_html,omitempty"`
	PageSize         string `json:"page_size,omitempty"`
	Orientation      string `json:"orientation,omitempty"`
	SerialPrefix     string `json:"serial_prefix,omitempty"`
	Signatory        string `json:"signatory,omitempty"`
	SignatoryRole    string `json:"signatory_role,omitempty"`
}

func (s *Server) saveCertificateTemplate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req certificateTemplateRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Code = strings.ToUpper(strings.TrimSpace(req.Code))
	req.Name = strings.TrimSpace(req.Name)
	if req.ID == "" && req.Code == "" {
		httpx.BadRequest(w, r, "code is required for a new template")
		return
	}
	if req.Name == "" {
		httpx.BadRequest(w, r, "name is required")
		return
	}
	if req.SubjectKind == "" {
		req.SubjectKind = "student"
	}
	if req.SubjectKind != "student" && req.SubjectKind != "staff" {
		httpx.BadRequest(w, r, "subject_kind must be student or staff")
		return
	}
	if req.PageSize == "" {
		req.PageSize = "A4"
	}
	switch req.PageSize {
	case "A4", "A5", "Letter", "Legal":
	default:
		httpx.BadRequest(w, r, "page_size must be A4, A5, Letter or Legal")
		return
	}
	if req.Orientation == "" {
		req.Orientation = "portrait"
	}
	if req.Orientation != "portrait" && req.Orientation != "landscape" {
		httpx.BadRequest(w, r, "orientation must be portrait or landscape")
		return
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	approval := true
	if req.RequiresApproval != nil {
		approval = *req.RequiresApproval
	}

	var outID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if req.ID != "" {
			return tx.QueryRow(r.Context(), `
				UPDATE certificate_types
				   SET name = $2, subject_kind = $3, is_active = $4,
				       requires_approval = $5, description = NULLIF($6,''),
				       template_html = NULLIF($7,''), page_size = $8, orientation = $9,
				       serial_prefix = NULLIF($10,''), signatory = NULLIF($11,''),
				       signatory_role = NULLIF($12,''), updated_at = now()
				 WHERE id = $1::uuid RETURNING id::text`,
				req.ID, req.Name, req.SubjectKind, active, approval, req.Description,
				req.TemplateHTML, req.PageSize, req.Orientation, req.SerialPrefix,
				req.Signatory, req.SignatoryRole).Scan(&outID)
		}
		return tx.QueryRow(r.Context(), `
			INSERT INTO certificate_types (institution_id, code, name, subject_kind,
			                               is_active, requires_approval, description,
			                               template_html, page_size, orientation,
			                               serial_prefix, signatory, signatory_role)
			VALUES ($1,$2,$3,$4,$5,$6, NULLIF($7,''), NULLIF($8,''), $9, $10,
			        NULLIF($11,''), NULLIF($12,''), NULLIF($13,''))
			ON CONFLICT (institution_id, code) DO UPDATE SET
			    name = EXCLUDED.name, subject_kind = EXCLUDED.subject_kind,
			    is_active = EXCLUDED.is_active,
			    requires_approval = EXCLUDED.requires_approval,
			    description = EXCLUDED.description,
			    template_html = EXCLUDED.template_html,
			    page_size = EXCLUDED.page_size, orientation = EXCLUDED.orientation,
			    serial_prefix = EXCLUDED.serial_prefix, signatory = EXCLUDED.signatory,
			    signatory_role = EXCLUDED.signatory_role, updated_at = now()
			RETURNING id::text`,
			id.InstitutionID, req.Code, req.Name, req.SubjectKind, active, approval,
			req.Description, req.TemplateHTML, req.PageSize, req.Orientation,
			req.SerialPrefix, req.Signatory, req.SignatoryRole).Scan(&outID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.BadRequest(w, r, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": outID})
}

/*
previewCertificateTemplate fills a template with a real child's details.

	Returned as text rather than rendered markup, and the screen shows it in a
	preformatted block. A school's template is arbitrary HTML typed by a
	clerk; injecting it into the admin's own document would make the template
	editor a way to run script in the principal's session.

	With no student named, the first active child on the roll — a preview that
	demands a student id before it will show anything is a preview nobody uses.
*/
func (s *Server) previewCertificateTemplate(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	tmplID, err := uuid.Parse(chiURLParam(r, "id"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid template id")
		return
	}
	student, err := optionalUUID(r.URL.Query().Get("student_id"))
	if err != nil {
		httpx.BadRequest(w, r, "student_id must be a uuid")
		return
	}

	var body, name, prefix, signatory, signatoryRole string
	fields := map[string]string{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(template_html,''), name, COALESCE(serial_prefix,''),
			       COALESCE(signatory,''), COALESCE(signatory_role,'')
			  FROM certificate_types WHERE id = $1`, tmplID).
			Scan(&body, &name, &prefix, &signatory, &signatoryRole); err != nil {
			return err
		}
		var studentName, admissionNo, className, sectionName, dob, guardian string
		var admitted, exited, school string
		if err := tx.QueryRow(r.Context(), `
			SELECT COALESCE(concat_ws(' ', st.first_name, st.middle_name, st.last_name),''),
			       COALESCE(st.admission_no,''), COALESCE(c.name,''), COALESCE(sec.name,''),
			       COALESCE(to_char(st.date_of_birth,'DD-MM-YYYY'),''),
			       COALESCE((SELECT g.full_name FROM student_guardians sg
			                   JOIN guardians g ON g.id = sg.guardian_id
			                  WHERE sg.student_id = st.id
			                  ORDER BY sg.is_primary DESC LIMIT 1), ''),
			       COALESCE(to_char(st.admission_date,'DD-MM-YYYY'),''),
			       COALESCE(to_char(st.exit_date,'DD-MM-YYYY'),''),
			       COALESCE((SELECT i.name FROM institutions i WHERE i.id = st.institution_id),'')
			  FROM students st
			  LEFT JOIN LATERAL (
			      SELECT en.section_id, en.class_id FROM enrollments en
			       WHERE en.student_id = st.id AND en.status = 'active'
			       ORDER BY en.enrolled_on DESC LIMIT 1
			  ) cur ON TRUE
			  LEFT JOIN sections sec ON sec.id = cur.section_id
			  LEFT JOIN classes  c   ON c.id = cur.class_id
			 WHERE ($1::uuid IS NULL OR st.id = $1)
			 ORDER BY (st.id = $1) DESC NULLS LAST, st.admission_no
			 LIMIT 1`, student).
			Scan(&studentName, &admissionNo, &className, &sectionName, &dob,
				&guardian, &admitted, &exited, &school); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		fields["{{student_name}}"] = studentName
		fields["{{admission_no}}"] = admissionNo
		fields["{{class}}"] = className
		fields["{{section}}"] = sectionName
		fields["{{date_of_birth}}"] = dob
		fields["{{guardian_name}}"] = guardian
		fields["{{admission_date}}"] = admitted
		fields["{{exit_date}}"] = exited
		fields["{{school_name}}"] = school
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	today := nowInIndia()
	fields["{{serial_no}}"] = prefix + "PREVIEW"
	fields["{{issued_on}}"] = today.Format("02-01-2006")
	fields["{{signatory}}"] = signatory
	fields["{{signatory_role}}"] = signatoryRole

	rendered := body
	var unfilled []string
	for token, value := range fields {
		if value == "" && strings.Contains(rendered, token) {
			unfilled = append(unfilled, token)
		}
		rendered = strings.ReplaceAll(rendered, token, value)
	}
	sort.Strings(unfilled)
	if unfilled == nil {
		unfilled = []string{}
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"template":  name,
		"rendered":  rendered,
		"empty":     strings.TrimSpace(body) == "",
		"unfilled":  unfilled,
		"issued_on": fields["{{issued_on}}"],
	})
}
