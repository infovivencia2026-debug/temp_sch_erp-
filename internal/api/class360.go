package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Class 360 — a section-centric overview, the mirror of Student 360.

	Where staff_overview.go answers "how is this teacher's load doing", this
	answers "how is this whole section doing": who is in it, who teaches it, was
	the register marked this morning, how are the marks trending, what is the
	week's grid, and — only for someone allowed to see money — where the fees
	stand. It is read-only aggregation: every edit reuses the existing
	attendance / marks / student handlers, so there are no writes here.

	Scope is the security boundary. Every section id from the request is confined
	to the caller's reach the same way absence_followup and staff_overview do it:
	an admin holds AllStudents and sees every active section; a class / subject
	teacher sees only the sections in res.SectionIDs. The overview handler
	refuses (as a 404, so it cannot be used to probe which sections exist) any
	section outside that set.
*/

// errNoSection distinguishes "no such section in this tenant" so the handler
// can 404 rather than 500.
var errNoSection = errors.New("no such section")

type classContact struct {
	Name     string `json:"name"`
	Phone    string `json:"phone"`
	Relation string `json:"relation"`
}

type classStudent struct {
	StudentID   string         `json:"student_id"`
	Name        string         `json:"name"`
	AdmissionNo string         `json:"admission_no"`
	Roll        int            `json:"roll"`
	Contacts    []classContact `json:"contacts"`
}

type classSubjectTeacher struct {
	Subject string `json:"subject"`
	Teacher string `json:"teacher"`
	Phone   string `json:"phone"`
	Email   string `json:"email"`
}

type classAttendanceTrend struct {
	Date       string  `json:"date"`
	PresentPct float64 `json:"present_pct"`
}

type classAttendance struct {
	PresentPctToday float64                `json:"present_pct_today"`
	MarkedToday     int                    `json:"marked_today"`
	Trend           []classAttendanceTrend `json:"trend"`
}

type classMarksSubject struct {
	Subject string  `json:"subject"`
	AvgPct  float64 `json:"avg_pct"`
}

type classMarks struct {
	HasMarks  bool                `json:"has_marks"`
	BySubject []classMarksSubject `json:"by_subject"`
}

type classTimetableEntry struct {
	Weekday  int    `json:"weekday"`
	Period   string `json:"period"`
	Sequence int    `json:"sequence"`
	Starts   string `json:"starts"`
	Ends     string `json:"ends"`
	Subject  string `json:"subject"`
	Teacher  string `json:"teacher"`
}

type classFees struct {
	Visible          bool  `json:"visible"`
	CollectedPaise   int64 `json:"collected_paise"`
	OutstandingPaise int64 `json:"outstanding_paise"`
}

type classSectionHeader struct {
	ID            string `json:"id"`
	Class         string `json:"class"`
	Section       string `json:"section"`
	StudentsCount int    `json:"students_count"`
}

type classOverview struct {
	Section           classSectionHeader    `json:"section"`
	ClassTeacher      string                `json:"class_teacher"`
	ClassTeacherPhone string                `json:"class_teacher_phone"`
	ClassTeacherEmail string                `json:"class_teacher_email"`
	SubjectTeachers   []classSubjectTeacher `json:"subject_teachers"`
	Students        []classStudent        `json:"students"`
	Attendance      classAttendance       `json:"attendance"`
	Marks           classMarks            `json:"marks"`
	Timetable       []classTimetableEntry `json:"timetable"`
	Fees            classFees             `json:"fees"`
}

// computeClassOverview is the single source of truth behind the overview
// endpoint. It assumes the caller has already confirmed the section is in scope.
// Every slice comes back empty (never nil); the fee block is filled only when
// the caller may read money, and the fee query is skipped otherwise.
func (s *Server) computeClassOverview(ctx context.Context, tx pgx.Tx,
	sectionID uuid.UUID, id *httpx.Identity) (classOverview, error) {

	ov := classOverview{
		SubjectTeachers: []classSubjectTeacher{},
		Students:        []classStudent{},
		Attendance:      classAttendance{Trend: []classAttendanceTrend{}},
		Marks:           classMarks{BySubject: []classMarksSubject{}},
		Timetable:       []classTimetableEntry{},
		Fees:            classFees{},
	}

	// ---- Section header + class id (needed for the marks join) ----
	var classID uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT sec.id::text, c.name, sec.name, sec.class_id,
		       COALESCE((SELECT full_name FROM users WHERE id = sec.class_teacher_id), ''),
		       COALESCE((SELECT COALESCE(NULLIF(btrim(u.phone), ''), emp.phone)
		                   FROM users u LEFT JOIN employees emp ON emp.user_id = u.id
		                  WHERE u.id = sec.class_teacher_id), ''),
		       COALESCE((SELECT COALESCE(NULLIF(btrim(u.email::text), ''), emp.email::text)
		                   FROM users u LEFT JOIN employees emp ON emp.user_id = u.id
		                  WHERE u.id = sec.class_teacher_id), ''),
		       (SELECT count(*) FROM enrollments e
		         WHERE e.section_id = sec.id AND e.status = 'active')
		  FROM sections sec
		  JOIN classes c ON c.id = sec.class_id
		 WHERE sec.id = $1`, sectionID).Scan(
		&ov.Section.ID, &ov.Section.Class, &ov.Section.Section, &classID,
		&ov.ClassTeacher, &ov.ClassTeacherPhone, &ov.ClassTeacherEmail,
		&ov.Section.StudentsCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return classOverview{}, errNoSection
	}
	if err != nil {
		return classOverview{}, err
	}

	// ---- Subject teachers ----
	if err := scanInto(ctx, tx, `
		SELECT sub.name, COALESCE(u.full_name, ''),
		       COALESCE(NULLIF(btrim(u.phone), ''), emp.phone, ''),
		       COALESCE(NULLIF(btrim(u.email::text), ''), emp.email::text, '')
		  FROM section_subject_teachers sst
		  JOIN class_subjects cs ON cs.id = sst.class_subject_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN users u ON u.id = sst.teacher_user_id
		  LEFT JOIN employees emp ON emp.user_id = u.id
		 WHERE sst.section_id = $1
		 ORDER BY sub.name`,
		func(rows pgx.Rows) error {
			var st classSubjectTeacher
			if err := rows.Scan(&st.Subject, &st.Teacher, &st.Phone, &st.Email); err != nil {
				return err
			}
			ov.SubjectTeachers = append(ov.SubjectTeachers, st)
			return nil
		}, sectionID); err != nil {
		return classOverview{}, err
	}

	// ---- Students, each with the guardians who have a number on file
	// (father → mother → primary), reusing the absence_followup aggregate. ----
	if err := scanInto(ctx, tx, `
		SELECT st.id::text,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       st.admission_no,
		       COALESCE(e.roll_no, 0),
		       COALESCE((
		         SELECT json_agg(json_build_object(
		                  'name', g.full_name, 'phone', g.phone, 'relation', g.relation)
		                ORDER BY (g.relation = 'father') DESC,
		                         (g.relation = 'mother') DESC,
		                         sg.is_primary DESC, g.full_name)
		           FROM student_guardians sg
		           JOIN guardians g ON g.id = sg.guardian_id
		          WHERE sg.student_id = st.id
		            AND g.phone IS NOT NULL AND btrim(g.phone) <> ''
		       ), '[]')
		  FROM enrollments e
		  JOIN students st ON st.id = e.student_id
		 WHERE e.section_id = $1 AND e.status = 'active'
		 ORDER BY e.roll_no NULLS LAST, st.admission_no`,
		func(rows pgx.Rows) error {
			var st classStudent
			var contactsJSON []byte
			if err := rows.Scan(&st.StudentID, &st.Name, &st.AdmissionNo,
				&st.Roll, &contactsJSON); err != nil {
				return err
			}
			st.Contacts = []classContact{}
			if len(contactsJSON) > 0 {
				// A malformed aggregate leaves that child with no numbers rather
				// than failing the whole page.
				_ = json.Unmarshal(contactsJSON, &st.Contacts)
			}
			ov.Students = append(ov.Students, st)
			return nil
		}, sectionID); err != nil {
		return classOverview{}, err
	}

	// ---- Attendance: today's snapshot + a 14-school-day trend. A "school day"
	// is any date on which this section has a non-holiday register. ----
	var markedToday, presentToday int
	if err := tx.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE status = 'present')
		  FROM student_attendance
		 WHERE section_id = $1 AND on_date = CURRENT_DATE AND status <> 'holiday'`,
		sectionID).Scan(&markedToday, &presentToday); err != nil {
		return classOverview{}, err
	}
	ov.Attendance.MarkedToday = markedToday
	if markedToday > 0 {
		ov.Attendance.PresentPctToday = round1(float64(presentToday) / float64(markedToday) * 100)
	}

	type trendRow struct {
		date             string
		marked, presents int
	}
	var trend []trendRow
	if err := scanInto(ctx, tx, `
		SELECT to_char(on_date, 'YYYY-MM-DD'),
		       count(*),
		       count(*) FILTER (WHERE status = 'present')
		  FROM student_attendance
		 WHERE section_id = $1 AND status <> 'holiday'
		 GROUP BY on_date
		 ORDER BY on_date DESC
		 LIMIT 14`,
		func(rows pgx.Rows) error {
			var tr trendRow
			if err := rows.Scan(&tr.date, &tr.marked, &tr.presents); err != nil {
				return err
			}
			trend = append(trend, tr)
			return nil
		}, sectionID); err != nil {
		return classOverview{}, err
	}
	// The query returns newest first; the chart wants oldest first.
	for i := len(trend) - 1; i >= 0; i-- {
		tr := trend[i]
		pct := 0.0
		if tr.marked > 0 {
			pct = round1(float64(tr.presents) / float64(tr.marked) * 100)
		}
		ov.Attendance.Trend = append(ov.Attendance.Trend,
			classAttendanceTrend{Date: tr.date, PresentPct: pct})
	}

	// ---- Marks: published, non-absent marks for this section's students, by
	// subject. An absent row is not a zero — it is left out entirely. ----
	if err := scanInto(ctx, tx, `
		SELECT sub.name,
		       avg(m.marks_obtained / es.max_marks * 100)
		  FROM enrollments e
		  JOIN marks m ON m.student_id = e.student_id AND NOT m.is_absent
		  JOIN exam_subjects es ON es.id = m.exam_subject_id AND es.max_marks > 0
		  JOIN exams ex ON ex.id = es.exam_id AND ex.is_published
		  JOIN class_subjects cs ON cs.id = es.class_subject_id AND cs.class_id = $2
		  JOIN subjects sub ON sub.id = cs.subject_id
		 WHERE e.section_id = $1 AND e.status = 'active'
		 GROUP BY sub.name
		 ORDER BY sub.name`,
		func(rows pgx.Rows) error {
			var name string
			var avg float64
			if err := rows.Scan(&name, &avg); err != nil {
				return err
			}
			ov.Marks.BySubject = append(ov.Marks.BySubject,
				classMarksSubject{Subject: name, AvgPct: round1(avg)})
			return nil
		}, sectionID, classID); err != nil {
		return classOverview{}, err
	}
	ov.Marks.HasMarks = len(ov.Marks.BySubject) > 0

	// ---- Timetable: the week's grid for the section. ----
	if err := scanInto(ctx, tx, `
		SELECT te.weekday, p.name, p.sequence,
		       to_char(p.starts_at, 'HH24:MI'), to_char(p.ends_at, 'HH24:MI'),
		       sub.name, COALESCE(u.full_name, '')
		  FROM timetable_entries te
		  JOIN periods p ON p.id = te.period_id
		  JOIN class_subjects cs ON cs.id = te.class_subject_id
		  JOIN subjects sub ON sub.id = cs.subject_id
		  LEFT JOIN users u ON u.id = te.teacher_user_id
		 WHERE te.section_id = $1
		 ORDER BY te.weekday, p.sequence`,
		func(rows pgx.Rows) error {
			var e classTimetableEntry
			if err := rows.Scan(&e.Weekday, &e.Period, &e.Sequence,
				&e.Starts, &e.Ends, &e.Subject, &e.Teacher); err != nil {
				return err
			}
			ov.Timetable = append(ov.Timetable, e)
			return nil
		}, sectionID); err != nil {
		return classOverview{}, err
	}

	// ---- Fees: only for a caller allowed to read money. Otherwise the block
	// stays {visible:false, 0, 0} and the query never runs. ----
	if id.Can(rbac.FeesRead) {
		ov.Fees.Visible = true
		if err := tx.QueryRow(ctx, `
			SELECT
			  COALESCE((SELECT sum(p.amount_paise)
			              FROM payments p
			              JOIN enrollments e ON e.student_id = p.student_id
			             WHERE e.section_id = $1 AND e.status = 'active'
			               AND p.status = 'success'), 0),
			  COALESCE((SELECT sum(i.net_paise)
			              FROM invoices i
			              JOIN enrollments e ON e.student_id = i.student_id
			             WHERE e.section_id = $1 AND e.status = 'active'
			               AND i.status <> 'cancelled'), 0)`,
			sectionID).Scan(&ov.Fees.CollectedPaise, &ov.Fees.OutstandingPaise); err != nil {
			return classOverview{}, err
		}
		// Outstanding is what is charged less what has cleared.
		ov.Fees.OutstandingPaise -= ov.Fees.CollectedPaise
		if ov.Fees.OutstandingPaise < 0 {
			ov.Fees.OutstandingPaise = 0
		}
	}

	return ov, nil
}

// ------------------------------------------------------------------ handlers

type classSectionListItem struct {
	SectionID     string `json:"section_id"`
	Class         string `json:"class"`
	Section       string `json:"section"`
	StudentsCount int    `json:"students_count"`
	ClassTeacher  string `json:"class_teacher"`
}

// listClassSections — GET /api/v1/class/sections
// The sections the caller may open in Class 360: every active section for an
// admin (AllStudents), otherwise only the sections they teach or are class
// teacher of. Empty list when there are none, never an error.
func (s *Server) listClassSections(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	// Admins see every active section; a teacher only their scoped set. An empty
	// scoped set yields FALSE, so the query returns nothing rather than the whole
	// school — the same direction absence_followup relies on.
	args := []any{res.AllStudents, res.SectionIDs}
	items, err := collect(s, r, `
		SELECT sec.id::text, c.name, sec.name,
		       (SELECT count(*) FROM enrollments e
		         WHERE e.section_id = sec.id AND e.status = 'active'),
		       COALESCE((SELECT full_name FROM users WHERE id = sec.class_teacher_id), '')
		  FROM sections sec
		  JOIN classes c ON c.id = sec.class_id
		 WHERE ($1::bool OR sec.id = ANY($2))
		   AND EXISTS (SELECT 1 FROM enrollments e
		                WHERE e.section_id = sec.id AND e.status = 'active')
		 ORDER BY c.name, sec.name`, args,
		func(rows pgx.Rows) (classSectionListItem, error) {
			var v classSectionListItem
			return v, rows.Scan(&v.SectionID, &v.Class, &v.Section,
				&v.StudentsCount, &v.ClassTeacher)
		})
	respond(w, r, items, err)
}

// getClassOverview — GET /api/v1/class/{sectionId}/overview
// 404 unless the section exists and is inside the caller's scope
// (AllStudents, or the section is in res.SectionIDs).
func (s *Server) getClassOverview(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	sectionID, err := uuid.Parse(chiURLParam(r, "sectionId"))
	if err != nil {
		httpx.BadRequest(w, r, "invalid section id")
		return
	}

	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	// Confine the requested section to the caller's reach. A section outside it
	// is answered as 404, so the endpoint cannot be used to enumerate sections.
	if !res.AllStudents {
		inScope := false
		for _, sid := range res.SectionIDs {
			if sid == sectionID {
				inScope = true
				break
			}
		}
		if !inScope {
			httpx.NotFound(w, r)
			return
		}
	}

	var ov classOverview
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		ov, err = s.computeClassOverview(r.Context(), tx, sectionID, id)
		return err
	})
	if errors.Is(err, errNoSection) {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, ov)
}
