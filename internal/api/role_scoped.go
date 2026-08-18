package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/httpx"
)

/* HOD, Faculty, Student and Parent — the scope-narrowed roles.
   Each handler resolves the caller's boundary and applies it as an explicit
   predicate. RLS cannot do this: every row involved belongs to the same
   institution, so the tenant policy admits all of them. */

// scoped runs a query with the caller's scope filter spliced in.
//
// The filter occupies the last bind parameter, so callers write their own
// placeholders from $1 and mark the predicate's position with a single %s —
// which is usually mid-query, ahead of an ORDER BY.
func scoped[T any](
	s *Server, r *http.Request, sc catalog.Scope, column, sqlFmt string,
	args []any, scan func(pgx.Rows) (T, error),
) ([]T, error) {
	res, err := s.resolveScope(r)
	if err != nil {
		return nil, err
	}
	pred, arg := res.Filter(sc, column, len(args)+1)
	if arg != nil {
		args = append(args, arg)
	}
	// Replace, not truncate: %s is rarely the final token.
	sql := strings.Replace(sqlFmt, "%s", pred, 1)
	return collect(s, r, sql, args, scan)
}

// --- HOD / Department Head ---------------------------------------------------

type deptKPIs struct {
	Departments int `json:"departments"`
	Faculty     int `json:"faculty"`
	Students    int `json:"students"`
	Sections    int `json:"sections"`
	Pending     int `json:"pending_approvals"`
}

// getDeptDashboard powers hod.dashboard.department_kpis.
func (s *Server) getDeptDashboard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	k := deptKPIs{Departments: len(res.DepartmentIDs)}
	if len(res.DepartmentIDs) == 0 {
		httpx.JSON(w, http.StatusOK, k)
		return
	}

	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT
			  (SELECT count(*) FROM employees WHERE department_id = ANY($1) AND status='active'),
			  -- Students reached through the department's timetabled sections.
			  (SELECT count(DISTINCT e.student_id)
			     FROM enrollments e
			    WHERE e.section_id IN (
			        SELECT DISTINCT te.section_id FROM timetable_entries te
			          JOIN employees emp ON emp.user_id = te.teacher_user_id
			         WHERE emp.department_id = ANY($1))),
			  (SELECT count(DISTINCT te.section_id) FROM timetable_entries te
			     JOIN employees emp ON emp.user_id = te.teacher_user_id
			    WHERE emp.department_id = ANY($1)),
			  (SELECT count(*) FROM leave_requests lr
			     JOIN employees emp ON emp.id = lr.employee_id
			    WHERE lr.status='pending' AND emp.department_id = ANY($1))`,
			res.DepartmentIDs).Scan(&k.Faculty, &k.Students, &k.Sections, &k.Pending)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, k)
}

type deptFaculty struct {
	UserID      string  `json:"user_id"`
	FullName    string  `json:"full_name"`
	Code        string  `json:"employee_code"`
	Department  *string `json:"department,omitempty"`
	Designation *string `json:"designation,omitempty"`
	Periods     int     `json:"weekly_periods"`
}

// listDeptFaculty powers hod.department_workspace.faculty_directory.
func (s *Server) listDeptFaculty(w http.ResponseWriter, r *http.Request) {
	items, err := scoped(s, r, catalog.ScopeDepartment, "e.department_id", `
		SELECT u.id::text, u.full_name, e.employee_code, d.name, dg.name,
		       (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = u.id)
		  FROM employees e
		  JOIN users u ON u.id = e.user_id
		  LEFT JOIN departments  d  ON d.id = e.department_id
		  LEFT JOIN designations dg ON dg.id = e.designation_id
		 WHERE e.status = 'active' AND %s`, nil,
		func(rows pgx.Rows) (deptFaculty, error) {
			var v deptFaculty
			return v, rows.Scan(&v.UserID, &v.FullName, &v.Code, &v.Department,
				&v.Designation, &v.Periods)
		})
	respond(w, r, items, err)
}

// --- Faculty / Teacher -------------------------------------------------------

type facultyClass struct {
	SectionID   string  `json:"section_id"`
	SectionName string  `json:"section_name"`
	ClassName   string  `json:"class_name"`
	Room        *string `json:"room,omitempty"`
	Enrolled    int     `json:"enrolled"`
	MarkedToday bool    `json:"marked_today"`
}

// listMyClasses powers faculty.teaching_workspace.my_classes — the sections
// this teacher actually teaches, not every section in the school.
func (s *Server) listMyClasses(w http.ResponseWriter, r *http.Request) {
	items, err := scoped(s, r, catalog.ScopeAssignedClasses, "sec.id", `
		SELECT sec.id::text, sec.name, c.name, sec.room,
		       (SELECT count(*) FROM enrollments e
		         WHERE e.section_id = sec.id AND e.status='active'),
		       EXISTS (SELECT 1 FROM student_attendance sa
		                WHERE sa.section_id = sec.id AND sa.on_date = CURRENT_DATE)
		  FROM sections sec
		  JOIN classes c ON c.id = sec.class_id
		 WHERE %s
		 ORDER BY c.level, sec.name`, nil,
		func(rows pgx.Rows) (facultyClass, error) {
			var v facultyClass
			return v, rows.Scan(&v.SectionID, &v.SectionName, &v.ClassName, &v.Room,
				&v.Enrolled, &v.MarkedToday)
		})
	respond(w, r, items, err)
}

type todayClass struct {
	EntryID     string  `json:"entry_id"`
	SectionID   string  `json:"section_id"`
	SectionName string  `json:"section_name"`
	ClassName   string  `json:"class_name"`
	SubjectName string  `json:"subject_name"`
	PeriodName  string  `json:"period_name"`
	StartsAt    string  `json:"starts_at"`
	EndsAt      string  `json:"ends_at"`
	Room        *string `json:"room,omitempty"`
	Marked      bool    `json:"attendance_marked"`
}

// listTodaysClasses powers faculty.dashboard.todays_classes.
//
// Ordered by period so the next class is simply the first row whose end time
// has not passed — the client does not have to re-derive the schedule.
func (s *Server) listTodaysClasses(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	// Weekday and "today" are computed in the institution's timezone inside the
	// query. Using the Go process clock meant a UTC-hosted server rolled over to
	// the next day at 05:30 IST, so a 06:00 first period looked like tomorrow.
	items, err := collect(s, r, `
		WITH local_today AS (
		  SELECT (now() AT TIME ZONE COALESCE(
		            (SELECT timezone FROM institutions LIMIT 1), 'UTC'))::date AS d
		)
		SELECT te.id::text, te.section_id::text, sec.name, c.name, sub.name,
		       p.name, to_char(p.starts_at,'HH24:MI'), to_char(p.ends_at,'HH24:MI'), te.room,
		       EXISTS (SELECT 1 FROM student_attendance sa
		                WHERE sa.section_id = te.section_id
		                  AND sa.on_date = (SELECT d FROM local_today)
		                  AND (sa.period_id = te.period_id OR sa.period_id IS NULL))
		  FROM timetable_entries te
		  JOIN sections sec      ON sec.id = te.section_id
		  JOIN classes  c        ON c.id = sec.class_id
		  JOIN periods  p        ON p.id = te.period_id
		  JOIN class_subjects cs ON cs.id = te.class_subject_id
		  JOIN subjects sub      ON sub.id = cs.subject_id
		 WHERE te.teacher_user_id = $1
		   AND te.weekday = extract(isodow FROM (SELECT d FROM local_today))::int
		 ORDER BY p.sequence`, []any{id.UserID},
		func(rows pgx.Rows) (todayClass, error) {
			var v todayClass
			return v, rows.Scan(&v.EntryID, &v.SectionID, &v.SectionName, &v.ClassName,
				&v.SubjectName, &v.PeriodName, &v.StartsAt, &v.EndsAt, &v.Room, &v.Marked)
		})
	respond(w, r, items, err)
}

// --- Student / Parent portals ------------------------------------------------

type portalChild struct {
	StudentID   string  `json:"student_id"`
	AdmissionNo string  `json:"admission_no"`
	FullName    string  `json:"full_name"`
	ClassName   *string `json:"class_name,omitempty"`
	SectionName *string `json:"section_name,omitempty"`
	Relation    *string `json:"relation,omitempty"`
}

// listMyStudents powers parent.dashboard.child_switcher and the student's own
// record. Both roles share it: the scope resolver already decided whether the
// set is "me" or "my children".
func (s *Server) listMyStudents(w http.ResponseWriter, r *http.Request) {
	items, err := scoped(s, r, catalog.ScopeChildren, "st.id", `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       c.name, sec.name,
		       (SELECT g.relation FROM student_guardians sg
		          JOIN guardians g ON g.id = sg.guardian_id
		         WHERE sg.student_id = st.id LIMIT 1)
		  FROM students st
		  LEFT JOIN LATERAL (
		      SELECT e.class_id, e.section_id FROM enrollments e
		       WHERE e.student_id = st.id ORDER BY e.enrolled_on DESC LIMIT 1
		  ) en ON true
		  LEFT JOIN classes  c   ON c.id = en.class_id
		  LEFT JOIN sections sec ON sec.id = en.section_id
		 WHERE %s
		 ORDER BY st.first_name`, nil,
		func(rows pgx.Rows) (portalChild, error) {
			var v portalChild
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.FullName,
				&v.ClassName, &v.SectionName, &v.Relation)
		})
	respond(w, r, items, err)
}

type portalSummary struct {
	StudentID     string `json:"student_id"`
	FullName      string `json:"full_name"`
	AttendancePct int    `json:"attendance_pct"`
	PresentDays   int    `json:"present_days"`
	TotalDays     int    `json:"total_days"`
	// Counted, not derived. Total minus present would swallow leave and half
	// days, which are neither present nor absent, and a family reading
	// "2 absent" is entitled to have that mean two days the child missed.
	AbsentDays int `json:"absent_days"`
	// Homework still owed, and when the soonest of it is due. A bare count
	// answers "how much" and not "how soon", and those are different
	// questions: five pieces due next fortnight is a quiet week, one due
	// tomorrow morning is tonight's problem.
	HomeworkDue     int     `json:"homework_due"`
	NextHomeworkDue *string `json:"next_homework_due,omitempty"`
	NextHomework    *string `json:"next_homework_title,omitempty"`
	OutstandingPais int64   `json:"outstanding_paise"`
	NextExam        *string `json:"next_exam,omitempty"`
	// Today's timetable, so the dashboard can answer "what have I got now"
	// without the child navigating to a week grid and finding the column.
	Today []portalPeriod `json:"today"`
}

type portalPeriod struct {
	Period   string  `json:"period"`
	StartsAt *string `json:"starts_at,omitempty"`
	EndsAt   *string `json:"ends_at,omitempty"`
	Subject  string  `json:"subject"`
	Teacher  *string `json:"teacher,omitempty"`
	Room     *string `json:"room,omitempty"`
}

// getPortalSummary powers student.dashboard.my_day and parent.dashboard.child_summary.
//
// The student id comes from the query string but is validated against the
// caller's resolved set — a parent cannot summarise a child that is not theirs
// by editing the URL.
func (s *Server) getPortalSummary(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		httpx.NotFound(w, r)
		return
	}

	target := res.StudentIDs[0]
	if q := r.URL.Query().Get("student_id"); q != "" {
		ok := false
		for _, sid := range res.StudentIDs {
			if sid.String() == q {
				target, ok = sid, true
				break
			}
		}
		if !ok {
			// Indistinguishable from "no such student", so the endpoint cannot
			// be used to probe which ids exist.
			httpx.NotFound(w, r)
			return
		}
	}

	var out portalSummary
	out.StudentID = target.String()
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT concat_ws(' ', st.first_name, st.middle_name, st.last_name),
			  COALESCE((SELECT round(100.0 * count(*) FILTER (WHERE status IN ('present','late'))
			                         / NULLIF(count(*),0))
			              FROM student_attendance WHERE student_id = st.id), 0),
			  (SELECT count(*) FROM student_attendance
			    WHERE student_id = st.id AND status IN ('present','late')),
			  (SELECT count(*) FROM student_attendance WHERE student_id = st.id),
			  (SELECT count(*) FROM student_attendance
			    WHERE student_id = st.id AND status = 'absent'),
			  /* Still owed, not merely set: a piece the child has already
			     turned in is not due from them, and counting it makes the
			     dashboard nag about finished work. */
			  (SELECT count(*) FROM homework h
			     JOIN enrollments e ON e.section_id = h.section_id AND e.student_id = st.id
			    WHERE h.is_published AND h.due_on >= CURRENT_DATE
			      AND NOT EXISTS (SELECT 1 FROM homework_submissions sub
			                       WHERE sub.homework_id = h.id AND sub.student_id = st.id)),
			  (SELECT to_char(min(h.due_on),'YYYY-MM-DD') FROM homework h
			     JOIN enrollments e ON e.section_id = h.section_id AND e.student_id = st.id
			    WHERE h.is_published AND h.due_on >= CURRENT_DATE
			      AND NOT EXISTS (SELECT 1 FROM homework_submissions sub
			                       WHERE sub.homework_id = h.id AND sub.student_id = st.id)),
			  (SELECT h.title FROM homework h
			     JOIN enrollments e ON e.section_id = h.section_id AND e.student_id = st.id
			    WHERE h.is_published AND h.due_on >= CURRENT_DATE
			      AND NOT EXISTS (SELECT 1 FROM homework_submissions sub
			                       WHERE sub.homework_id = h.id AND sub.student_id = st.id)
			    ORDER BY h.due_on, h.title LIMIT 1),
			  COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices
			             WHERE student_id = st.id
			               AND status IN ('unpaid','partial','overdue')), 0),
			  (SELECT ex.name FROM exams ex
			    WHERE ex.starts_on >= CURRENT_DATE
			    ORDER BY ex.starts_on LIMIT 1)
			  FROM students st WHERE st.id = $1`, target).
			Scan(&out.FullName, &out.AttendancePct, &out.PresentDays, &out.TotalDays,
				&out.AbsentDays, &out.HomeworkDue, &out.NextHomeworkDue, &out.NextHomework,
				&out.OutstandingPais, &out.NextExam)
	})
	if err == pgx.ErrNoRows {
		httpx.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}

	/* Today's periods for this child's section.

	   A second query rather than more columns on the first: this returns a
	   row per period, and folding a list into a single-row SELECT means either
	   an array of composites or a join that multiplies every other count by
	   the number of lessons. Weekday is Postgres's own, so a Sunday simply
	   returns nothing rather than the week's first column. */
	out.Today = []portalPeriod{}
	err = s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			SELECT p.name,
			       to_char(p.starts_at,'HH24:MI'), to_char(p.ends_at,'HH24:MI'),
			       COALESCE(sub.name, 'Free'), u.full_name, te.room
			  FROM enrollments e
			  JOIN timetable_entries te ON te.section_id = e.section_id
			  JOIN periods p ON p.id = te.period_id
			  LEFT JOIN class_subjects cs ON cs.id = te.class_subject_id
			  LEFT JOIN subjects sub ON sub.id = cs.subject_id
			  LEFT JOIN users u ON u.id = te.teacher_user_id
			 WHERE e.student_id = $1 AND e.status = 'active'
			   AND te.weekday = EXTRACT(isodow FROM CURRENT_DATE)
			 ORDER BY p.starts_at, p.name`, target)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v portalPeriod
			if err := rows.Scan(&v.Period, &v.StartsAt, &v.EndsAt, &v.Subject,
				&v.Teacher, &v.Room); err != nil {
				return err
			}
			out.Today = append(out.Today, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

type portalAttendanceDay struct {
	Date   string `json:"date"`
	Status string `json:"status"`
}

// listPortalAttendance powers student.student_self_service.attendance and
// parent.parent_self_service.attendance.
//
// A guardian with several children must be able to pick one. Returning every
// child's rows merged made the switcher decorative and the calendar wrong —
// two children's marks for the same day collided.
func (s *Server) listPortalAttendance(w http.ResponseWriter, r *http.Request) {
	res, err := s.resolveScope(r)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if len(res.StudentIDs) == 0 {
		respond(w, r, []portalAttendanceDay{}, nil)
		return
	}

	target := res.StudentIDs[0]
	if q := r.URL.Query().Get("student_id"); q != "" {
		sid, err := uuid.Parse(q)
		// Validated against the caller's own set, so editing the URL cannot
		// reach another family's child.
		if err != nil || !res.OwnsStudent(sid) {
			httpx.NotFound(w, r)
			return
		}
		target = sid
	}

	items, err := collect(s, r, `
		SELECT to_char(sa.on_date,'YYYY-MM-DD'), sa.status
		  FROM student_attendance sa
		 WHERE sa.student_id = $1
		   AND sa.on_date >= CURRENT_DATE - INTERVAL '120 days'
		 ORDER BY sa.on_date DESC`, []any{target},
		func(rows pgx.Rows) (portalAttendanceDay, error) {
			var v portalAttendanceDay
			return v, rows.Scan(&v.Date, &v.Status)
		})
	respond(w, r, items, err)
}
