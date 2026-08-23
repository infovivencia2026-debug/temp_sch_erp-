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
	// YearInvoices is how many invoice rows the trio above was summed over.
	// It exists because zero and "no answer" print identically: on a database
	// where no invoice carries an academic year, all three come back 0 and a
	// cell reading "₹0 billed" is a lie told confidently. Zero here is the
	// signal, so it is always sent rather than omitted — the trio is empty
	// because there is nothing to sum, not because the school billed nothing.
	// Loosening the year predicate to "fix" the zeros would silently redefine
	// billed to mean all years, which is the mistake the comment above records.
	YearInvoices int `json:"year_invoice_count"`

	PendingLeave     int `json:"pending_leave"`
	OpenApplications int `json:"open_applications"`
	UnassignedSubj   int `json:"unassigned_subjects"`

	/* Denominators and breakdowns for the cells above.

	   Every one of these is drawn from exactly the rows its headline scalar is
	   drawn from, so a cell can show a proportion without the client inventing
	   the bottom half of it. Each is omitted rather than sent as zero when
	   there is nothing to say: an absent field makes a client fall back to the
	   bare count, whereas a zero that looks real is how the last one got past
	   review. */

	// ClassSubjectsTotal is every class-subject pairing, of which
	// UnassignedSubj is the part with nobody timetabled to teach it — so the
	// cell can say "9 of 140". Omitted when it is zero: a school that has
	// offered no subjects has no denominator, and "9 of 0" is worse than "9".
	ClassSubjectsTotal *int `json:"class_subjects_total,omitempty"`

	// OpenApplicationsByStatus splits OpenApplications by the status column
	// itself, ordered along the admission stages. Deliberately NOT the
	// enquiries/applied/offered/admitted shape of admissions_funnel: that
	// funnel counts every application ever and its "admitted" is
	// status = 'accepted', which this set excludes by definition — reusing the
	// word here would print admitted = 0 forever. Same word, same meaning is
	// the rule, so this uses different words.
	OpenApplicationsByStatus []appStatusCount `json:"open_applications_by_status,omitempty"`

	// PendingLeaveByType is what PendingLeave is waiting on and for whom. The
	// requests column sums back to PendingLeave exactly, students included —
	// which is why subject_kind is carried rather than assumed to be staff.
	PendingLeaveByType []pendingLeaveGroup `json:"pending_leave_by_type,omitempty"`

	// StudentsByClass distributes Students over the class each is enrolled in.
	// Sums to Students, with the not-yet-enrolled in their own bucket rather
	// than dropped. Sections is not the denominator of a roll and this is not
	// a per-section figure.
	StudentsByClass []classRollGroup `json:"students_by_class,omitempty"`

	// OutstandingAgeing splits OutstandingPaise by how long each unpaid
	// invoice has been due. The six buckets add back to OutstandingPaise
	// exactly, which is why undated and not-yet-due are buckets rather than
	// omissions. Nil when nothing is outstanding at all.
	OutstandingAgeing *outstandingAgeing `json:"outstanding_ageing,omitempty"`

	// Range is the period the flow metrics cover; AsOf names the level
	// metrics, which are always current whatever the range.
	Range dateRange `json:"range"`
	AsOf  []string  `json:"as_of_now"`
}

type appStatusCount struct {
	Status       string `json:"status"`
	Applications int    `json:"applications"`
}

type pendingLeaveGroup struct {
	LeaveType string `json:"leave_type"`
	// 'staff' or 'student' — leave_requests holds both and pending_leave
	// counts both, so a breakdown that assumed staff would not add up.
	SubjectKind string `json:"subject_kind"`
	// Absent for student leave and for staff with no department on file;
	// null rather than "None", because they are different facts.
	Department *string `json:"department,omitempty"`
	Requests   int     `json:"requests"`
	// Working days asked for, summed from leave_requests.days — the half-day
	// flag is already priced into that column.
	Days float64 `json:"days"`
}

type classRollGroup struct {
	// Null for the not-yet-enrolled bucket, which is a real group of children
	// rather than a class.
	ClassID   *string `json:"class_id,omitempty"`
	ClassName string  `json:"class_name"`
	Students  int     `json:"students"`
}

type outstandingAgeing struct {
	NotDuePaise    int64 `json:"not_due_paise"`
	Days0To30      int64 `json:"days_0_30_paise"`
	Days31To60     int64 `json:"days_31_60_paise"`
	Days61To90     int64 `json:"days_61_90_paise"`
	Days90PlusPais int64 `json:"days_90_plus_paise"`
	// Unpaid invoices with no due date. They cannot be aged and are not zero,
	// so they get their own bucket instead of quietly leaving the buckets
	// short of outstanding_paise.
	UndatedPaise int64 `json:"undated_paise"`
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
		"open_applications", "unassigned_subjects", "students", "staff", "sections",
		// The breakdowns are levels too: they are cut from the same rows as the
		// scalars above and carry the same as-of-now label.
		"class_subjects_total", "open_applications_by_status",
		"pending_leave_by_type", "students_by_class", "outstanding_ageing"}

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
			                 ORDER BY is_current DESC, starts_on DESC LIMIT 1)), 0),
			  -- How many rows the trio was summed over. Same rows, same
			  -- predicate; only the aggregate differs. Zero says the trio has
			  -- nothing to sum, which is not the claim that nothing was billed.
			  (SELECT count(*) FROM invoices i
			    WHERE i.status <> 'cancelled' AND i.academic_year_id =
			      (SELECT id FROM academic_years
			        ORDER BY is_current DESC, starts_on DESC LIMIT 1)),

			  -- The denominator unassigned_subjects is a part of: every subject a
			  -- class offers, taught or not. NULL rather than 0 so a school with no
			  -- class-subjects at all is not handed "9 of 0".
			  (SELECT NULLIF(count(*), 0) FROM class_subjects),

			  -- open_applications, split by the status column itself. Same predicate
			  -- as the scalar, so the parts sum to it. Ordered along the admission
			  -- stages rather than by size: a funnel sorted by count is not a funnel.
			  (SELECT json_agg(t) FROM (
			      SELECT a.status AS status, count(*)::int AS applications
			        FROM applications a
			       WHERE a.status NOT IN ('accepted','rejected','withdrawn')
			       GROUP BY a.status
			       ORDER BY array_position(
			                  ARRAY['draft','submitted','under_review',
			                        'documents_pending','test_scheduled',
			                        'interviewed','waitlisted','offered'], a.status),
			                a.status
			   ) t),

			  -- pending_leave, split by leave type and the applicant's department.
			  -- LEFT JOINed throughout so a request with no type, no department, or a
			  -- student rather than an employee behind it still appears and the parts
			  -- still add up to the scalar.
			  (SELECT json_agg(t) FROM (
			      SELECT COALESCE(lt.name, 'Not recorded') AS leave_type,
			             lr.subject_kind                   AS subject_kind,
			             d.name                            AS department,
			             count(*)::int                     AS requests,
			             sum(lr.days)::float8              AS days
			        FROM leave_requests lr
			        LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
			        LEFT JOIN employees e    ON e.id  = lr.employee_id
			        LEFT JOIN departments d  ON d.id  = e.department_id
			       WHERE lr.status = 'pending'
			       GROUP BY lt.name, lr.subject_kind, d.name
			       ORDER BY count(*) DESC, 1
			   ) t),

			  -- students, distributed over classes. Same population as the scalar --
			  -- active students -- with the not-yet-enrolled kept as their own bucket
			  -- so the distribution sums to the roll. The LATERAL picks one enrollment
			  -- per child: the unique key is per academic year, so a stale 'active'
			  -- row from last year would otherwise count the same child twice.
			  (SELECT json_agg(t) FROM (
			      SELECT c.id::text                       AS class_id,
			             COALESCE(c.name, 'Not enrolled') AS class_name,
			             count(*)::int                    AS students
			        FROM students st
			        LEFT JOIN LATERAL (
			            SELECT en.class_id FROM enrollments en
			             WHERE en.student_id = st.id AND en.status = 'active'
			             ORDER BY en.enrolled_on DESC LIMIT 1
			        ) en ON TRUE
			        LEFT JOIN classes c ON c.id = en.class_id
			       WHERE st.status = 'active'
			       GROUP BY c.id, c.name, c.level
			       ORDER BY c.level NULLS LAST, c.name
			   ) t),

			  -- outstanding_paise, aged by how long each invoice has been due. Same
			  -- rows and same predicate as the scalar, so the six buckets add back to
			  -- it exactly. Days run from due_on, so an invoice due today sits at the
			  -- bottom of 0-30; defaulters above is strictly past due and counts
			  -- children rather than rupees, so the two answer different questions
			  -- and are not expected to agree.
			  (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE json_build_object(
			       'not_due_paise', COALESCE(sum(i.net_paise - i.paid_paise)
			           FILTER (WHERE i.due_on > CURRENT_DATE), 0)::bigint,
			       'days_0_30_paise', COALESCE(sum(i.net_paise - i.paid_paise)
			           FILTER (WHERE CURRENT_DATE - i.due_on BETWEEN 0 AND 30), 0)::bigint,
			       'days_31_60_paise', COALESCE(sum(i.net_paise - i.paid_paise)
			           FILTER (WHERE CURRENT_DATE - i.due_on BETWEEN 31 AND 60), 0)::bigint,
			       'days_61_90_paise', COALESCE(sum(i.net_paise - i.paid_paise)
			           FILTER (WHERE CURRENT_DATE - i.due_on BETWEEN 61 AND 90), 0)::bigint,
			       'days_90_plus_paise', COALESCE(sum(i.net_paise - i.paid_paise)
			           FILTER (WHERE CURRENT_DATE - i.due_on > 90), 0)::bigint,
			       'undated_paise', COALESCE(sum(i.net_paise - i.paid_paise)
			           FILTER (WHERE i.due_on IS NULL), 0)::bigint
			   ) END
			     FROM invoices i
			    WHERE i.status IN ('unpaid','partial','overdue'))
		`, rng.FromS, rng.ToS).Scan(&k.Students, &k.Staff, &k.Sections, &k.AttendanceToday, &k.MarkedToday,
			&k.CollectedPaise, &k.OutstandingPaise, &k.Defaulters,
			&k.PendingLeave, &k.OpenApplications, &k.UnassignedSubj,
			&k.BilledPaise, &k.CollectedYearPais, &k.OutstandingYearP, &k.YearInvoices,
			&k.ClassSubjectsTotal, &k.OpenApplicationsByStatus, &k.PendingLeaveByType,
			&k.StudentsByClass, &k.OutstandingAgeing)
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
