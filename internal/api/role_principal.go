package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Institution Admin / Principal — institution-scoped oversight.
   Everything here is bounded by RLS alone: a principal legitimately sees the
   whole tenant, so no narrower scope filter applies. */

type principalKPIs struct {
	Students         int   `json:"students"`
	Staff            int   `json:"staff"`
	Sections         int   `json:"sections"`
	AttendanceToday  int   `json:"attendance_today_pct"`
	MarkedToday      int   `json:"attendance_marked_today"`
	CollectedPaise   int64 `json:"collected_paise"`
	OutstandingPaise int64 `json:"outstanding_paise"`
	Defaulters       int   `json:"defaulters"`

	/* The year trio, defined identically to institution_admin fee_overview so
	   the two screens cannot print different numbers under the same word.

	     BilledPaise       sum(invoices.net_paise)              current academic year, status <> 'cancelled'
	     CollectedYearPais sum(invoices.paid_paise)             same rows — money applied to this year's bills
	     OutstandingYearP  sum(net_paise - paid_paise)          same rows

	   CollectedPaise above is a different measure and keeps its own name: it
	   is receipts banked inside the requested range, whatever year's invoice
	   they settle and whether or not they have been applied to one at all.
	   OutstandingPaise is every unpaid invoice of every year — the arrears the
	   school is actually owed — and is therefore larger than
	   OutstandingYearPaise by exactly the debt carried in from earlier years. */
	BilledPaise       int64 `json:"billed_paise"`
	CollectedYearPais int64 `json:"collected_year_paise"`
	OutstandingYearP  int64 `json:"outstanding_year_paise"`
	PendingLeave     int   `json:"pending_leave"`
	OpenApplications int   `json:"open_applications"`
	UnassignedSubj   int   `json:"unassigned_subjects"`

	// Range is the period the flow metrics cover; AsOf names the level
	// metrics, which are always current whatever the range.
	Range dateRange `json:"range"`
	AsOf  []string  `json:"as_of_now"`
}

// getPrincipalDashboard powers institution_admin.dashboard.executive_kpis and
// campus_kpi_overview.
//
// One round trip with independent scalar subqueries rather than a dozen
// endpoints: the dashboard is the first paint after login, and on a 1 vCPU box
// twelve sequential API calls is the difference between snappy and sluggish.
func (s *Server) getPrincipalDashboard(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var k principalKPIs

	/* Flows take the range, levels do not.

	   Attendance and collection are flows and are reported for the period
	   asked for. Outstanding balance, defaulters, pending leave and open
	   applications are levels — true at an instant — and "outstanding between
	   June and August" is not a smaller number, it is a meaningless one. They
	   stay as-of-now and the response says so, so the client can label them. */
	rng := resolveRange(r)
	k.Range = rng
	k.AsOf = []string{"outstanding_paise", "defaulters", "pending_leave",
		"open_applications", "unassigned_subjects", "students", "staff", "sections"}

	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT
			  (SELECT count(*) FROM students  WHERE status = 'active'),
			  (SELECT count(*) FROM employees WHERE status = 'active'),
			  (SELECT count(*) FROM sections),
			  -- Percentage of today's marked register that is present-or-late.
			  COALESCE((SELECT round(100.0 * count(*) FILTER (WHERE status IN ('present','late'))
			                         / NULLIF(count(*), 0))
			              FROM student_attendance
			             WHERE on_date BETWEEN $1::date AND $2::date), 0),
			  (SELECT count(*) FROM student_attendance
			    WHERE on_date BETWEEN $1::date AND $2::date),
			  -- Adjustments are excluded: a write-off is an accounting entry,
			  -- not a rupee that arrived. The day book (getCollectionSummary)
			  -- has always excluded them; including them here is what made the
			  -- dashboard's "collected" exceed every other screen's.
			  COALESCE((SELECT sum(amount_paise) FROM payments
			             WHERE status = 'success' AND mode <> 'adjustment'
			               AND paid_on::date BETWEEN $1::date AND $2::date), 0),
			  COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices
			             WHERE status IN ('unpaid','partial','overdue')), 0),
			  (SELECT count(DISTINCT student_id) FROM invoices
			    WHERE status IN ('unpaid','partial','overdue')
			      AND due_on IS NOT NULL AND due_on < CURRENT_DATE),
			  (SELECT count(*) FROM leave_requests WHERE status = 'pending'),
			  (SELECT count(*) FROM applications
			    WHERE status NOT IN ('accepted','rejected','withdrawn')),
			  -- Subjects offered by a class with nobody timetabled to teach them.
			  (SELECT count(*) FROM class_subjects cs
			    WHERE NOT EXISTS (SELECT 1 FROM section_subject_teachers sst
			                       WHERE sst.class_subject_id = cs.id)),
			  -- The year trio. Same rows, same predicate, same current-year
			  -- pick as fee_overview; billed is never derived as collected +
			  -- outstanding, which added a period flow to an all-years level
			  -- and called the sum "billed".
			  COALESCE((SELECT sum(i.net_paise) FROM invoices i
			             WHERE i.status <> 'cancelled' AND i.academic_year_id =
			               (SELECT id FROM academic_years
			                 ORDER BY is_current DESC, starts_on DESC LIMIT 1)), 0),
			  COALESCE((SELECT sum(i.paid_paise) FROM invoices i
			             WHERE i.status <> 'cancelled' AND i.academic_year_id =
			               (SELECT id FROM academic_years
			                 ORDER BY is_current DESC, starts_on DESC LIMIT 1)), 0),
			  COALESCE((SELECT sum(i.net_paise - i.paid_paise) FROM invoices i
			             WHERE i.status <> 'cancelled' AND i.academic_year_id =
			               (SELECT id FROM academic_years
			                 ORDER BY is_current DESC, starts_on DESC LIMIT 1)), 0)
		`, rng.FromS, rng.ToS).Scan(&k.Students, &k.Staff, &k.Sections, &k.AttendanceToday, &k.MarkedToday,
			&k.CollectedPaise, &k.OutstandingPaise, &k.Defaulters,
			&k.PendingLeave, &k.OpenApplications, &k.UnassignedSubj,
			&k.BilledPaise, &k.CollectedYearPais, &k.OutstandingYearP)
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, k)
}

type attendanceTrendPoint struct {
	Date    string `json:"date"`
	Present int    `json:"present"`
	Absent  int    `json:"absent"`
	Total   int    `json:"total"`
	Pct     int    `json:"pct"`
}

// getAttendanceTrend powers institution_admin.academic_monitoring.attendance_monitoring.
func (s *Server) getAttendanceTrend(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT to_char(on_date,'YYYY-MM-DD'),
		       count(*) FILTER (WHERE status IN ('present','late')),
		       count(*) FILTER (WHERE status = 'absent'),
		       count(*),
		       COALESCE(round(100.0 * count(*) FILTER (WHERE status IN ('present','late'))
		                      / NULLIF(count(*),0)), 0)
		  FROM student_attendance
		 WHERE on_date >= CURRENT_DATE - INTERVAL '30 days'
		 GROUP BY on_date
		 ORDER BY on_date`, nil,
		func(rows pgx.Rows) (attendanceTrendPoint, error) {
			var v attendanceTrendPoint
			return v, rows.Scan(&v.Date, &v.Present, &v.Absent, &v.Total, &v.Pct)
		})
	respond(w, r, items, err)
}

type shortageRow struct {
	StudentID   string `json:"student_id"`
	AdmissionNo string `json:"admission_no"`
	FullName    string `json:"full_name"`
	ClassName   string `json:"class_name"`
	SectionName string `json:"section_name"`
	Present     int    `json:"present"`
	Total       int    `json:"total"`
	Pct         int    `json:"pct"`
}

// getAttendanceShortage lists students below the attendance threshold.
//
// 75% is the CBSE/most-boards default for exam eligibility, which is why it is
// the fallback rather than an arbitrary round number.
func (s *Server) getAttendanceShortage(w http.ResponseWriter, r *http.Request) {
	threshold := clampInt(r.URL.Query().Get("threshold"), 75, 1, 100)
	items, err := collect(s, r, `
		SELECT st.id::text, st.admission_no,
		       concat_ws(' ', st.first_name, st.middle_name, st.last_name),
		       COALESCE(c.name,'—'), COALESCE(sec.name,'—'),
		       count(*) FILTER (WHERE sa.status IN ('present','late')),
		       count(*),
		       round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late'))
		             / NULLIF(count(*),0))
		  FROM student_attendance sa
		  JOIN students st ON st.id = sa.student_id
		  LEFT JOIN sections sec ON sec.id = sa.section_id
		  LEFT JOIN classes  c   ON c.id = sec.class_id
		 GROUP BY st.id, c.name, sec.name
		HAVING round(100.0 * count(*) FILTER (WHERE sa.status IN ('present','late'))
		             / NULLIF(count(*),0)) < $1
		 ORDER BY 8
		 LIMIT 100`, []any{threshold},
		func(rows pgx.Rows) (shortageRow, error) {
			var v shortageRow
			return v, rows.Scan(&v.StudentID, &v.AdmissionNo, &v.FullName,
				&v.ClassName, &v.SectionName, &v.Present, &v.Total, &v.Pct)
		})
	respond(w, r, items, err)
}

type staffWorkloadRow struct {
	UserID     string  `json:"user_id"`
	FullName   string  `json:"full_name"`
	Code       string  `json:"employee_code"`
	Department *string `json:"department,omitempty"`
	Periods    int     `json:"weekly_periods"`
	Subjects   int     `json:"subjects"`
	Sections   int     `json:"sections"`
}

// getStaffWorkload powers institution_admin.administration.staff_allocation_workload.
func (s *Server) getStaffWorkload(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT u.id::text, u.full_name, e.employee_code, d.name,
		       (SELECT count(*) FROM timetable_entries te WHERE te.teacher_user_id = u.id),
		       (SELECT count(DISTINCT cs.subject_id)
		          FROM section_subject_teachers sst
		          JOIN class_subjects cs ON cs.id = sst.class_subject_id
		         WHERE sst.teacher_user_id = u.id),
		       (SELECT count(DISTINCT sst.section_id) FROM section_subject_teachers sst
		         WHERE sst.teacher_user_id = u.id)
		  FROM employees e
		  JOIN users u ON u.id = e.user_id
		  LEFT JOIN departments d ON d.id = e.department_id
		 WHERE e.status = 'active'
		 ORDER BY 5 DESC, u.full_name`, nil,
		func(rows pgx.Rows) (staffWorkloadRow, error) {
			var v staffWorkloadRow
			return v, rows.Scan(&v.UserID, &v.FullName, &v.Code, &v.Department,
				&v.Periods, &v.Subjects, &v.Sections)
		})
	respond(w, r, items, err)
}
