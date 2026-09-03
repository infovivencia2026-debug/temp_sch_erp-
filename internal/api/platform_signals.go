package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* TWO SIGNALS THE CATALOGUE CALLS "AI", BUILT AS ARITHMETIC.

   The sheet promises a dropout risk engine and a cash flow predictor. There
   is no model here and nothing pretends there is: each is a rule a bursar or
   a class teacher already applies by hand, run across every school at once
   so the platform owner sees the same figure for thirty campuses that one
   principal sees for their own. Every threshold is stated in the response so
   the screen can say how a number was reached, and the response never
   carries a child's name — the platform view is aggregate; a name is read
   inside the school where the audit trail records who looked.

   Both read across tenants through AsPlatform and are gated twice: the vendor
   permission on the route, platformOnly in the handler. */

func (s *Server) mountPlatformSignals(r chi.Router) {
	vendor := httpx.RequirePermission(rbac.PlatformTenantsRW)
	r.With(vendor).Get("/signals/dropout-risk", s.getDropoutRisk)
	r.With(vendor).Get("/signals/cash-flow", s.getCashFlowOutlook)
}

// --- dropout risk -------------------------------------------------------------

/* The three rules, each a thing the school already watches.

   Attendance: under 75% present over the last 30 days, among children whose
   register was marked at least five times in that window. 75% is the figure
   every Indian board sets as the floor for sitting an exam, which makes it the
   one number nobody at a school will argue with. Fewer than five marked days
   is not evidence — a child admitted last week has not been absent, they
   have not been there long enough to be present.

   Fees: any invoice more than 30 days past due and not settled. A single late
   instalment is a bank holiday; a month is a household deciding.

   Marks: the child's average across the most recent exam they sat, below the
   pass mark of the papers they sat. Their own latest exam, not the school's,
   because a child who missed the term exam is already in the attendance rule.

   Two of three is "at risk". One is a bad month; two together is a pattern. */

type dropoutThresholds struct {
	AttendanceBelowPct int `json:"attendance_below_pct"`
	AttendanceMinDays  int `json:"attendance_min_days"`
	WindowDays         int `json:"window_days"`
	FeesOverdueDays    int `json:"fees_overdue_days"`
	SignalsForAtRisk   int `json:"signals_for_at_risk"`
}

type dropoutSchool struct {
	InstitutionID string `json:"institution_id"`
	School        string `json:"school"`
	Students      int    `json:"students"`
	Attendance    int    `json:"attendance"`
	Fees          int    `json:"fees"`
	Marks         int    `json:"marks"`
	AtRisk        int    `json:"at_risk"`
	AllThree      int    `json:"all_three"`
	// Coverage is how many of the school's active children had a register
	// marked in the window at all. A school with 900 children and a coverage
	// of 40 has not got 860 attentive children; it has a register nobody
	// takes, and the attendance rule is silent there rather than reassuring.
	Coverage int `json:"coverage"`
}

type dropoutRisk struct {
	AsOf       string            `json:"as_of"`
	Thresholds dropoutThresholds `json:"thresholds"`
	Schools    []dropoutSchool   `json:"schools"`
	Total      dropoutSchool     `json:"total"`
	Method     string            `json:"method"`
}

func (s *Server) getDropoutRisk(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	th := dropoutThresholds{
		AttendanceBelowPct: 75, AttendanceMinDays: 5, WindowDays: 30,
		FeesOverdueDays: 30, SignalsForAtRisk: 2,
	}
	out := dropoutRisk{
		AsOf:       time.Now().Format("2006-01-02"),
		Thresholds: th,
		Schools:    []dropoutSchool{},
		Method: "Rules, not a model. A child is counted once per rule they trip and " +
			"is at risk on two of three. Names are read inside the school.",
	}
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			WITH att AS (
			  SELECT sa.student_id,
			         count(*)::int AS marked,
			         count(*) FILTER (WHERE sa.status IN ('present','late'))::int AS present
			    FROM student_attendance sa
			   WHERE sa.on_date > CURRENT_DATE - $1::int
			     AND sa.status NOT IN ('holiday','leave')
			   GROUP BY sa.student_id
			),
			fee AS (
			  SELECT DISTINCT i.student_id
			    FROM invoices i
			   WHERE i.status IN ('unpaid','partial','overdue')
			     AND i.due_on IS NOT NULL
			     AND i.due_on < CURRENT_DATE - $2::int
			),
			latest_exam AS (
			  SELECT DISTINCT ON (m.student_id) m.student_id, e.id AS exam_id
			    FROM marks m
			    JOIN exam_subjects es ON es.id = m.exam_subject_id
			    JOIN exams e ON e.id = es.exam_id
			   WHERE NOT m.is_absent AND m.marks_obtained IS NOT NULL
			   ORDER BY m.student_id, COALESCE(e.ends_on, e.starts_on, e.created_at::date) DESC
			),
			mk AS (
			  SELECT m.student_id,
			         sum(m.marks_obtained + m.grace_marks) < sum(es.pass_marks) AS failing
			    FROM marks m
			    JOIN exam_subjects es ON es.id = m.exam_subject_id
			    JOIN latest_exam le ON le.student_id = m.student_id AND le.exam_id = es.exam_id
			   WHERE NOT m.is_absent AND m.marks_obtained IS NOT NULL
			   GROUP BY m.student_id
			),
			per_child AS (
			  SELECT st.institution_id, st.id,
			         (att.marked IS NOT NULL) AS covered,
			         (att.marked >= $3::int
			          AND 100.0 * att.present / att.marked < $4::int) AS a,
			         (fee.student_id IS NOT NULL) AS f,
			         COALESCE(mk.failing, false) AS k
			    FROM students st
			    LEFT JOIN att ON att.student_id = st.id
			    LEFT JOIN fee ON fee.student_id = st.id
			    LEFT JOIN mk  ON mk.student_id = st.id
			   WHERE st.status = 'active'
			)
			SELECT i.id::text, i.name,
			       count(pc.id)::int,
			       count(*) FILTER (WHERE pc.a)::int,
			       count(*) FILTER (WHERE pc.f)::int,
			       count(*) FILTER (WHERE pc.k)::int,
			       count(*) FILTER (WHERE (pc.a::int + pc.f::int + pc.k::int) >= $5::int)::int,
			       count(*) FILTER (WHERE pc.a AND pc.f AND pc.k)::int,
			       count(*) FILTER (WHERE pc.covered)::int
			  FROM institutions i
			  LEFT JOIN per_child pc ON pc.institution_id = i.id
			 WHERE i.status = 'active'
			 GROUP BY i.id, i.name
			 ORDER BY 7 DESC, i.name`,
			th.WindowDays, th.FeesOverdueDays, th.AttendanceMinDays,
			th.AttendanceBelowPct, th.SignalsForAtRisk)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v dropoutSchool
			if err := rows.Scan(&v.InstitutionID, &v.School, &v.Students, &v.Attendance,
				&v.Fees, &v.Marks, &v.AtRisk, &v.AllThree, &v.Coverage); err != nil {
				return err
			}
			out.Schools = append(out.Schools, v)
			out.Total.Students += v.Students
			out.Total.Attendance += v.Attendance
			out.Total.Fees += v.Fees
			out.Total.Marks += v.Marks
			out.Total.AtRisk += v.AtRisk
			out.Total.AllThree += v.AllThree
			out.Total.Coverage += v.Coverage
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out.Total.School = "All schools"
	httpx.JSON(w, http.StatusOK, out)
}

// --- cash flow ---------------------------------------------------------------

/* What is due, times how much of what was due actually came in.

   For each of the next three months: the instalments falling due in it that
   are not yet settled. Against that, the school's own recovery rate — of
   everything that fell due in the last twelve months, the share that has
   been paid by now. Expected is the product. A school that historically
   collects 82% of a month's demand will, absent a reason to think otherwise,
   collect about 82% of the next one; that is the whole of the "model", and
   the rate is on the row so anybody can check the multiplication.

   The backlog is what is already overdue, shown beside the outlook and not
   folded into it: money that did not come when it was due is not
   predictable by the month it was due in. */

type cashFlowMonth struct {
	Month         string `json:"month"`
	DuePaise      int64  `json:"due_paise"`
	ExpectedPaise int64  `json:"expected_paise"`
}

type cashFlowSchool struct {
	InstitutionID string          `json:"institution_id"`
	School        string          `json:"school"`
	RatePct       *int            `json:"rate_pct"`
	BasisPaise    int64           `json:"basis_paise"`
	BacklogPaise  int64           `json:"backlog_paise"`
	Months        []cashFlowMonth `json:"months"`
	DuePaise      int64           `json:"due_paise"`
	ExpectedPaise int64           `json:"expected_paise"`
}

type cashFlowOutlook struct {
	AsOf    string           `json:"as_of"`
	Months  []string         `json:"months"`
	Schools []cashFlowSchool `json:"schools"`
	Total   cashFlowSchool   `json:"total"`
	Method  string           `json:"method"`
}

func (s *Server) getCashFlowOutlook(w http.ResponseWriter, r *http.Request) {
	if !platformOnly(w, r) {
		return
	}
	now := time.Now()
	first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	months := []string{}
	for i := 1; i <= 3; i++ {
		months = append(months, first.AddDate(0, i, 0).Format("2006-01"))
	}
	out := cashFlowOutlook{
		AsOf:    now.Format("2006-01-02"),
		Months:  months,
		Schools: []cashFlowSchool{},
		Method: "Expected = what falls due in the month × the share of the last twelve " +
			"months' demand the school has actually collected. No model.",
	}
	from := first.AddDate(0, 1, 0)
	to := first.AddDate(0, 4, 0)
	basisFrom := first.AddDate(-1, 0, 0)
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), `
			WITH basis AS (
			  SELECT institution_id,
			         sum(net_paise) AS billed, sum(paid_paise) AS paid
			    FROM invoices
			   WHERE status NOT IN ('draft','cancelled')
			     AND due_on >= $1::date AND due_on < $2::date
			   GROUP BY institution_id
			),
			backlog AS (
			  SELECT institution_id, sum(net_paise - paid_paise) AS owed
			    FROM invoices
			   WHERE status IN ('unpaid','partial','overdue')
			     AND due_on IS NOT NULL AND due_on < CURRENT_DATE
			   GROUP BY institution_id
			),
			due AS (
			  SELECT institution_id, to_char(due_on, 'YYYY-MM') AS month,
			         sum(net_paise - paid_paise) AS owed
			    FROM invoices
			   WHERE status IN ('unpaid','partial','overdue')
			     AND due_on >= $2::date AND due_on < $3::date
			   GROUP BY institution_id, 2
			)
			SELECT i.id::text, i.name,
			       COALESCE(b.billed, 0), COALESCE(b.paid, 0), COALESCE(bl.owed, 0),
			       COALESCE((SELECT owed FROM due WHERE due.institution_id = i.id AND month = $4), 0),
			       COALESCE((SELECT owed FROM due WHERE due.institution_id = i.id AND month = $5), 0),
			       COALESCE((SELECT owed FROM due WHERE due.institution_id = i.id AND month = $6), 0)
			  FROM institutions i
			  LEFT JOIN basis b ON b.institution_id = i.id
			  LEFT JOIN backlog bl ON bl.institution_id = i.id
			 WHERE i.status = 'active'
			 ORDER BY i.name`,
			basisFrom, from, to, months[0], months[1], months[2])
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v cashFlowSchool
			var billed, paid int64
			var due [3]int64
			if err := rows.Scan(&v.InstitutionID, &v.School, &billed, &paid, &v.BacklogPaise,
				&due[0], &due[1], &due[2]); err != nil {
				return err
			}
			v.BasisPaise = billed
			rate := 0.0
			if billed > 0 {
				rate = float64(paid) / float64(billed)
				if rate > 1 {
					rate = 1
				}
				pct := int(rate*100 + 0.5)
				v.RatePct = &pct
			}
			v.Months = make([]cashFlowMonth, 0, 3)
			for k, m := range months {
				exp := int64(float64(due[k])*rate + 0.5)
				v.Months = append(v.Months, cashFlowMonth{Month: m, DuePaise: due[k], ExpectedPaise: exp})
				v.DuePaise += due[k]
				v.ExpectedPaise += exp
			}
			out.Schools = append(out.Schools, v)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out.Total = cashFlowSchool{School: "All schools", Months: make([]cashFlowMonth, 3)}
	for k, m := range months {
		out.Total.Months[k].Month = m
	}
	var billed, paid int64
	for _, sc := range out.Schools {
		out.Total.BacklogPaise += sc.BacklogPaise
		out.Total.DuePaise += sc.DuePaise
		out.Total.ExpectedPaise += sc.ExpectedPaise
		out.Total.BasisPaise += sc.BasisPaise
		billed += sc.BasisPaise
		if sc.RatePct != nil {
			paid += int64(float64(sc.BasisPaise) * float64(*sc.RatePct) / 100)
		}
		for k := range sc.Months {
			out.Total.Months[k].DuePaise += sc.Months[k].DuePaise
			out.Total.Months[k].ExpectedPaise += sc.Months[k].ExpectedPaise
		}
	}
	if billed > 0 {
		pct := int(float64(paid)/float64(billed)*100 + 0.5)
		out.Total.RatePct = &pct
	}
	httpx.JSON(w, http.StatusOK, out)
}
