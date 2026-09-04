package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/*
What the check-in times finally add up to.

	Every piece of this existed and none of it was joined: the reader wrote a
	check_in, the school knew its hours, and payroll knew what a day was worth.
	Nothing put the three together, so a month of attendance answered no
	question anybody actually asks -- who was late, who left early, who was
	away, and what that comes to.

	Computed at read time rather than stamped onto the attendance rows. A school
	that corrects its hours in March must not thereby make somebody retroactively
	late every day since June; the rows record what happened, and the rule is
	applied to them when the question is asked.
*/

type staffMonth struct {
	EmployeeID string `json:"employee_id"`
	Code       string `json:"employee_code"`
	Name       string `json:"name"`
	Department string `json:"department"`
	Pattern    string `json:"pattern"`
	Expected   int    `json:"expected_days"`
	Present    int    `json:"present_days"`
	HalfDays   int    `json:"half_days"`
	// Days nobody marked at all. Reported rather than absorbed: it is the
	// difference between a person who was away and a register nobody kept, and
	// a school reading this needs to know which it is looking at.
	Unmarked    int `json:"unmarked_days"`
	Absent      int `json:"absent_days"`
	Late        int `json:"late_days"`
	EarlyLeaves int `json:"early_leaves"`
	// Loss of pay, in days and in money. Days always; money only where the
	// school has said what a day costs, because inventing that figure is
	// inventing a deduction.
	LOPDays  float64 `json:"lop_days"`
	LOPPaise *int64  `json:"lop_paise,omitempty"`
	// Which of the school's rules produced the figure, so a person disputing a
	// deduction is told the rule and not just the number.
	LOPRule string `json:"lop_rule"`
}

/*
getStaffHours reports one month against each person's own expected hours.

	The whole calculation is one statement, deliberately. Doing it per employee
	in Go would be eighty round trips for a school of eighty, and the arithmetic
	-- minutes present, lateness past the grace, a half day -- is the database's
	own work on rows it already holds.
*/
func (s *Server) getStaffHours(w http.ResponseWriter, r *http.Request) {
	month := r.URL.Query().Get("month") // YYYY-MM
	if month == "" {
		month = nowInIndia().Format("2006-01")
	}
	if _, err := time.Parse("2006-01", month); err != nil {
		httpx.BadRequest(w, r, "month must be written as 2026-09")
		return
	}

	items, err := collect(s, r, `
		WITH bounds AS (
		  SELECT date_trunc('month', ($1 || '-01')::date)::date AS from_day,
		         (date_trunc('month', ($1 || '-01')::date)
		            + INTERVAL '1 month - 1 day')::date AS to_day
		),
		/* Each person's hours, most specific first: their own, then their
		   department's, then the school's default. */
		staff AS (
		  SELECT e.id, e.employee_code,
		         btrim(concat_ws(' ', e.first_name, e.last_name)) AS name,
		         COALESCE(d.name, '') AS department,
		         COALESCE(p1.id, p2.id, p3.id)                       AS pattern_id,
		         COALESCE(p1.name, p2.name, p3.name, 'None')         AS pattern,
		         COALESCE(p1.starts_at, p2.starts_at, p3.starts_at)  AS starts_at,
		         COALESCE(p1.ends_at, p2.ends_at, p3.ends_at)        AS ends_at,
		         COALESCE(p1.grace_minutes, p2.grace_minutes, p3.grace_minutes, 10) AS grace,
		         COALESCE(p1.full_day_minutes, p2.full_day_minutes, p3.full_day_minutes, 420) AS full_min,
		         COALESCE(p1.half_day_minutes, p2.half_day_minutes, p3.half_day_minutes, 210) AS half_min,
		         COALESCE(p1.working_days, p2.working_days, p3.working_days,
		                  ARRAY[1,2,3,4,5,6]) AS working_days,
		         COALESCE(p1.lop_basis, p2.lop_basis, p3.lop_basis, 'none') AS lop_basis,
		         COALESCE(p1.lop_per_day_paise, p2.lop_per_day_paise, p3.lop_per_day_paise) AS lop_paise,
		         COALESCE(p1.salary_divisor, p2.salary_divisor, p3.salary_divisor, 30) AS divisor,
		         COALESCE(p1.lates_for_half_day, p2.lates_for_half_day,
		                  p3.lates_for_half_day, 0) AS lates_for_half,
		         /* What this person is paid a month, for the schools that cut
		            pay as a fraction of it rather than a flat figure. Null
		            where no salary is on record, and the deduction is then
		            reported in days only -- a money figure invented from a
		            salary nobody entered is the worst thing this screen could
		            print. */
		         (SELECT ss.ctc_paise FROM salary_structures ss
		           WHERE ss.employee_id = e.id
		             AND ss.effective_from <= (($1 || '-01')::date)
		             AND (ss.effective_to IS NULL
		                  OR ss.effective_to >= (($1 || '-01')::date))
		           ORDER BY ss.effective_from DESC LIMIT 1) AS monthly_paise
		    FROM employees e
		    LEFT JOIN departments   d  ON d.id  = e.department_id
		    LEFT JOIN work_patterns p1 ON p1.id = e.work_pattern_id
		    LEFT JOIN work_patterns p2 ON p2.id = d.work_pattern_id
		    LEFT JOIN work_patterns p3 ON p3.institution_id = e.institution_id
		                              AND p3.is_default
		   WHERE e.status = 'active'
		),
		/* The days the school expected them, which is not every day in the
		   month: a pattern that does not run on Sunday must not make everybody
		   absent on Sundays, which is the commonest way a report like this is
		   wrong and the reason nobody trusts it afterwards. */
		expected AS (
		  SELECT s.id,
		         count(*)::int AS days
		    FROM staff s, bounds b,
		         generate_series(b.from_day, b.to_day, INTERVAL '1 day') AS g(day)
		   WHERE EXTRACT(ISODOW FROM g.day)::int = ANY(s.working_days)
		     AND NOT EXISTS (SELECT 1 FROM holidays h
                             WHERE h.institution_id = (SELECT institution_id FROM employees WHERE id = s.id)
                               AND h.kind IN ('holiday','vacation')
                               AND h.applies_to IN ('all','staff')
                               AND g.day::date BETWEEN h.on_date
                                          AND COALESCE(h.to_date, h.on_date))
		   GROUP BY s.id
		),
		marked AS (
		  SELECT s.id,
		/* THE PUNCHES ARE UTC INSTANTS; THE HOURS ARE SCHOOL TIME.

		            A reader in Hyderabad writes 03:15Z for a quarter past nine,
		            and comparing that to a 08:45 start would make the whole
		            school five and a half hours early every morning. So each
		            punch is brought into Asia/Kolkata first and only then read
		            as a clock time, exactly as the grace screen already does. */
		         /* A DAY IS ALSO WORKED WHEN THE OFFICE SAID SO.

		            Not every school runs a reader, and the ones that do still
		            mark by hand on the day it is down. Counting only punches
		            made a hand-marked register look like an empty one. */
		         count(*) FILTER (
		           WHERE (a.check_in IS NOT NULL
		                  AND EXTRACT(EPOCH FROM (
		                        COALESCE((a.check_out AT TIME ZONE 'Asia/Kolkata')::time, s.ends_at)
		                          - (a.check_in AT TIME ZONE 'Asia/Kolkata')::time))/60
		                      >= s.full_min)
		              OR (a.check_in IS NULL
		                  AND a.status IN ('present','late')))::int AS present,
		         count(*) FILTER (
		           WHERE (a.check_in IS NOT NULL
		                  AND EXTRACT(EPOCH FROM (
		                        COALESCE((a.check_out AT TIME ZONE 'Asia/Kolkata')::time, s.ends_at)
		                          - (a.check_in AT TIME ZONE 'Asia/Kolkata')::time))/60
		                      BETWEEN s.half_min AND s.full_min - 1)
		              OR (a.check_in IS NULL AND a.status = 'half_day'))::int AS halves,
		         /* Approved leave is not absence. It is settled by the leave
		            policy, which has its own balances and its own approvals,
		            and docking it here would deduct for it twice. */
		         count(*) FILTER (WHERE a.status IN ('leave','holiday','week_off'))::int AS excused,
		         /* Days the register actually speaks about. The difference
		            between this and the days expected is not absence -- it is
		            silence, and silence must never be charged as absence. */
		         count(a.id)::int AS marked,
		         /* Late is measured past the grace, not past the hour. A school
		            that allows ten minutes has said so; reporting somebody late
		            at one minute past makes the report an argument. */
		         count(*) FILTER (
		           WHERE a.check_in IS NOT NULL
		             AND (a.check_in AT TIME ZONE 'Asia/Kolkata')::time
		                 > s.starts_at + (s.grace || ' minutes')::interval)::int AS late,
		         count(*) FILTER (
		           WHERE a.check_out IS NOT NULL
		             AND (a.check_out AT TIME ZONE 'Asia/Kolkata')::time < s.ends_at)::int AS early
		    FROM staff s
		    LEFT JOIN staff_attendance a
		           ON a.user_id = (SELECT user_id FROM employees WHERE id = s.id)
		          AND a.on_date BETWEEN (SELECT from_day FROM bounds)
		                            AND (SELECT to_day FROM bounds)
		   GROUP BY s.id
		)
		SELECT s.id::text, s.employee_code, s.name, s.department, s.pattern,
		       COALESCE(e.days, 0),
		       COALESCE(m.present, 0), COALESCE(m.halves, 0),
		       /* Days nobody marked at all, reported rather than absorbed. */
		       GREATEST(0, COALESCE(e.days,0) - LEAST(COALESCE(m.marked,0), COALESCE(e.days,0))),
		       /* Absent is what the register says, not what it fails to say.

		          Counting every unmarked day as an absence made a school that
		          had not begun marking look like one where fourteen people
		          missed the whole month, and would have deducted a full salary
		          from each of them. */
		       GREATEST(0, LEAST(COALESCE(m.marked,0), COALESCE(e.days,0))
		                     - COALESCE(m.present,0) - COALESCE(m.halves,0)
		                     - COALESCE(m.excused,0)),
		       COALESCE(m.late, 0), COALESCE(m.early, 0),
		       /* A half day is half a day of loss, which is what a school means
		          by half day and the only reason it distinguishes one. */
		       /* Days lost: whole days away, half a day for each half day, and
		          the school's lateness rule turned into half days on top --
		          "three lates make a half day" is a policy half the schools in
		          the country keep and none of them could express here before. */
		       GREATEST(0, LEAST(COALESCE(m.marked,0), COALESCE(e.days,0))
		                     - COALESCE(m.present,0) - COALESCE(m.halves,0)
		                     - COALESCE(m.excused,0))
		         + COALESCE(m.halves,0) * 0.5
		         + CASE WHEN s.lates_for_half > 0
		                THEN floor(COALESCE(m.late,0)::numeric / s.lates_for_half) * 0.5
		                ELSE 0 END,
		       s.lop_basis, s.lop_paise, s.divisor, s.monthly_paise
		  FROM staff s
		  LEFT JOIN expected e ON e.id = s.id
		  LEFT JOIN marked   m ON m.id = s.id
		 ORDER BY s.department, s.name`, []any{month},
		func(rows pgx.Rows) (staffMonth, error) {
			var v staffMonth
			var basis string
			var perDay, monthly *int64
			var divisor int
			if err := rows.Scan(&v.EmployeeID, &v.Code, &v.Name, &v.Department,
				&v.Pattern, &v.Expected, &v.Present, &v.HalfDays, &v.Unmarked, &v.Absent,
				&v.Late, &v.EarlyLeaves, &v.LOPDays,
				&basis, &perDay, &divisor, &monthly); err != nil {
				return v, err
			}

			/* The school's own rule, applied and then named.

			   Money only where the school has actually said how it cuts. A
			   figure on this screen is a figure somebody acts on, and inventing
			   a deduction the school never set -- from a salary nobody entered,
			   or a default rate chosen here -- would be this product deciding
			   what a teacher is paid. */
			switch {
			case v.LOPDays <= 0:
				v.LOPRule = "Nothing lost"
			case basis == "fixed" && perDay != nil:
				amount := int64(float64(*perDay) * v.LOPDays)
				v.LOPPaise = &amount
				v.LOPRule = "A fixed amount for each day lost"
			case basis == "salary" && monthly != nil:
				// Divisor 0 means the school divides by the days it actually
				// expected that month, which is a real policy and a fairer one
				// in a short month.
				per := divisor
				if per == 0 {
					per = v.Expected
				}
				if per > 0 {
					amount := int64(float64(*monthly) / float64(per) * v.LOPDays)
					v.LOPPaise = &amount
					v.LOPRule = "Monthly pay divided by " + strconv.Itoa(per) + " days"
				} else {
					v.LOPRule = "No days were expected this month"
				}
			case basis == "salary":
				v.LOPRule = "No salary on record, so days only"
			default:
				v.LOPRule = "This school does not deduct"
			}
			return v, nil
		})
	respond(w, r, items, err)
}
