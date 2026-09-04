-- +goose Up
--
-- THE LOP ENGINE LEARNS TWO THINGS IT NEVER KNEW: WHOSE SHIFT, AND WHOSE QUOTA.
--
-- 1. One shift for the whole school.
--
--    leave_policy.shift_starts_at is a single time, so every member of staff
--    was judged against nine o'clock. The security guard who starts at six was
--    not late at 06:05 -- he was three hours early, and the register said
--    nothing about him at all; the kindergarten teacher who finishes at one
--    was never early. work_patterns has held each person's real hours since
--    00242 and this function did not look at them.
--
-- 2. Paid leave that has run out is still paid.
--
--    Only leave whose TYPE is unpaid was ever charged. A teacher with a quota
--    of six casual leaves who took her ninth was charged for none of them,
--    because casual leave is a paid type. Every school in the country turns
--    the excess into loss of pay, and this one could not.
--
-- Kept as one function on purpose. Payroll, the register screen and the hours
-- screen must not each hold their own arithmetic: three answers to "how many
-- days did she lose" is three numbers that will one day disagree in front of
-- the person whose salary it is.

-- A school that does not turn exhausted leave into loss of pay says so here,
-- rather than being unable to say it either way.
ALTER TABLE leave_policy ADD COLUMN IF NOT EXISTS
    lop_on_exhausted_quota boolean NOT NULL DEFAULT true;

-- The shape changes, so the dependants come down first and go back up after.
DROP FUNCTION IF EXISTS staff_lop_days(uuid, uuid, integer, integer);
DROP FUNCTION IF EXISTS staff_lop_register(integer, integer);
DROP FUNCTION IF EXISTS staff_lop_register(uuid, integer, integer);

-- +goose StatementBegin
CREATE FUNCTION staff_lop_register(p_institution uuid, p_year integer, p_month integer)
RETURNS TABLE (
    user_id           uuid,
    employee_id       uuid,
    absent_days       numeric,
    half_days         numeric,
    unpaid_leave_days numeric,
    late_marks        integer,
    lop_days          numeric,
    -- Paid leave taken past the quota. Reported apart from unpaid leave
    -- because they are different conversations to have with the employee.
    quota_lop_days    numeric,
    -- What the school expected of this person: their own pattern's working
    -- days, less the holidays. Payroll divides by this where the school has
    -- not named a divisor of its own.
    expected_days     numeric
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    pol        leave_policy%ROWTYPE;
    first_day  date := make_date(p_year, p_month, 1);
    last_day   date := (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date;
    year_from  date;
BEGIN
    SELECT * INTO pol FROM leave_policy p WHERE p.institution_id = p_institution;
    IF NOT FOUND THEN
        -- A school that has never opened the policy screen still runs payroll,
        -- and these are the same defaults the table carries.
        pol.half_day_fraction := 0.50;
        pol.shift_starts_at := TIME '09:00';
        pol.grace_minutes := 10;
        pol.late_marks_per_lop_day := 3;
        pol.late_half_day_after_minutes := NULL;
        pol.lop_on_absent := true;
        pol.lop_on_unpaid_leave := true;
        pol.lop_on_exhausted_quota := true;
        pol.lop_rounding := 'half';
        pol.max_lop_days_per_month := NULL;
    END IF;

    -- Quota is spent over a year, not a month, so the count has to start where
    -- the school's year starts. Falling back to the calendar year rather than
    -- to this month: a month-long quota would exhaust everybody by the 3rd.
    SELECT ay.starts_on INTO year_from
      FROM academic_years ay
     WHERE ay.institution_id = p_institution
       AND first_day BETWEEN ay.starts_on AND ay.ends_on
     ORDER BY ay.is_current DESC
     LIMIT 1;
    year_from := COALESCE(year_from, date_trunc('year', first_day)::date);

    RETURN QUERY
    WITH
    /* EACH PERSON'S OWN HOURS, most specific first: their own, then their
       department's, then the school's default, then the single time the
       policy screen holds -- which is all this function used to have. */
    shifts AS (
        SELECT e.id AS eid,
               e.user_id AS uid,
               COALESCE(p1.starts_at, p2.starts_at, p3.starts_at,
                        pol.shift_starts_at)                       AS starts_at,
               COALESCE(p1.grace_minutes, p2.grace_minutes, p3.grace_minutes,
                        pol.grace_minutes)                         AS grace,
               COALESCE(p1.working_days, p2.working_days, p3.working_days,
                        ARRAY[1,2,3,4,5,6])                        AS working_days
          FROM employees e
          LEFT JOIN departments   d  ON d.id  = e.department_id
          LEFT JOIN work_patterns p1 ON p1.id = e.work_pattern_id
          LEFT JOIN work_patterns p2 ON p2.id = d.work_pattern_id
          LEFT JOIN work_patterns p3 ON p3.institution_id = e.institution_id
                                    AND p3.is_default
         WHERE e.institution_id = p_institution
    ),
    /* The days the school actually expected each person. A pattern that does
       not run on Sunday must not make anybody absent on Sundays. */
    expected AS (
        SELECT s.eid, count(*)::numeric AS days
          FROM shifts s,
               generate_series(first_day, last_day, INTERVAL '1 day') AS g(day)
         WHERE EXTRACT(ISODOW FROM g.day)::int = ANY(s.working_days)
           AND NOT EXISTS (
                 SELECT 1 FROM holidays h
                  WHERE h.institution_id = p_institution
                    AND h.kind IN ('holiday','vacation')
                    AND h.applies_to IN ('all','staff')
                    AND g.day::date BETWEEN h.on_date
                                        AND COALESCE(h.to_date, h.on_date))
         GROUP BY s.eid
    ),
    /* EVERY LEAVE DAY OF THE YEAR SO FAR, so this month's leave can be told
       apart from the leave that had already used the quota up. */
    year_leave AS (
        SELECT e.id AS eid,
               lr.leave_type_id AS ltid,
               sa.on_date,
               CASE WHEN COALESCE(lr.is_half_day, false) THEN 0.5 ELSE 1.0 END::numeric AS d
          FROM staff_attendance sa
          JOIN employees e ON e.user_id = sa.user_id
                          AND e.institution_id = sa.institution_id
          JOIN LATERAL (
              SELECT r.is_half_day, r.leave_type_id
                FROM leave_requests r
               WHERE r.employee_id = e.id
                 AND r.subject_kind = 'staff'
                 AND r.status = 'approved'
                 AND sa.on_date BETWEEN r.from_date AND r.to_date
               ORDER BY r.from_date DESC
               LIMIT 1
          ) lr ON true
         WHERE sa.institution_id = p_institution
           AND sa.status = 'leave'
           AND lr.leave_type_id IS NOT NULL
           AND sa.on_date BETWEEN year_from AND last_day
    ),
    running AS (
        SELECT yl.*,
               sum(yl.d) OVER (PARTITION BY yl.eid, yl.ltid
                               ORDER BY yl.on_date
                               ROWS UNBOUNDED PRECEDING) AS cum
          FROM year_leave yl
    ),
    /* How much of each day fell past the entitlement. The employee's own
       balance where the school has set one, the type's annual quota
       otherwise; where neither exists the leave is unlimited and nothing is
       charged, because a quota nobody entered is not a quota of zero. */
    over_quota AS (
        SELECT r.eid, r.on_date,
               GREATEST(0, LEAST(r.d, r.cum - COALESCE(b.entitled, lt.annual_quota)))::numeric AS excess
          FROM running r
          LEFT JOIN leave_types lt ON lt.id = r.ltid
          LEFT JOIN LATERAL (
              SELECT lb.entitled FROM leave_balances lb
               WHERE lb.employee_id = r.eid AND lb.leave_type_id = r.ltid
               ORDER BY lb.academic_year_id LIMIT 1
          ) b ON true
         WHERE COALESCE(lt.is_paid, true)
           AND COALESCE(b.entitled, lt.annual_quota) IS NOT NULL
    ),
    marked AS (
        SELECT sa.user_id AS uid,
               e.id       AS eid,
               sa.status,
               COALESCE(lr.is_half_day, false) AS half_leave,
               COALESCE(lt.is_paid, false)     AS paid_leave,
               COALESCE(oq.excess, 0)          AS quota_excess,
               CASE WHEN sa.check_in IS NULL THEN NULL ELSE
                    GREATEST(0, (EXTRACT(epoch FROM
                        (sa.check_in AT TIME ZONE 'Asia/Kolkata')::time - sh.starts_at
                    ) / 60)::integer)
               END AS late_minutes,
               sh.grace AS grace
          FROM staff_attendance sa
          JOIN employees e ON e.user_id = sa.user_id
                          AND e.institution_id = sa.institution_id
          JOIN shifts sh ON sh.eid = e.id
          /* The approved leave covering the day, if any. staff_attendance
             records that somebody was on leave; only the request knows which
             type, and only the type knows whether it was paid. */
          LEFT JOIN LATERAL (
              SELECT r.is_half_day, r.leave_type_id
                FROM leave_requests r
               WHERE r.employee_id = e.id
                 AND r.subject_kind = 'staff'
                 AND r.status = 'approved'
                 AND sa.on_date BETWEEN r.from_date AND r.to_date
               ORDER BY r.from_date DESC
               LIMIT 1
          ) lr ON true
          LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
          LEFT JOIN over_quota oq ON oq.eid = e.id AND oq.on_date = sa.on_date
         WHERE sa.institution_id = p_institution
           AND sa.on_date BETWEEN first_day AND last_day
    ),
    priced AS (
        SELECT m.uid, m.eid, m.status,
               CASE
                 WHEN m.status = 'absent'
                      THEN CASE WHEN pol.lop_on_absent THEN 1.0 ELSE 0 END
                 WHEN m.status = 'half_day' THEN pol.half_day_fraction
                 WHEN m.status = 'leave' THEN
                      CASE WHEN pol.lop_on_unpaid_leave AND NOT m.paid_leave
                           THEN CASE WHEN m.half_leave THEN pol.half_day_fraction ELSE 1.0 END
                           /* Paid leave costs nothing until the quota is gone.
                              Past it the day is unfunded, and a school that
                              charged nothing was paying for leave it had never
                              granted. */
                           WHEN pol.lop_on_exhausted_quota THEN m.quota_excess
                           ELSE 0 END
                 WHEN pol.late_half_day_after_minutes IS NOT NULL
                      AND COALESCE(m.late_minutes, 0) >= pol.late_half_day_after_minutes
                      THEN pol.half_day_fraction
                 ELSE 0
               END::numeric AS charged,
               CASE
                 WHEN m.status IN ('absent','half_day','leave','holiday','week_off') THEN 0
                 WHEN pol.late_half_day_after_minutes IS NOT NULL
                      AND COALESCE(m.late_minutes, 0) >= pol.late_half_day_after_minutes THEN 0
                 WHEN m.status = 'late' OR COALESCE(m.late_minutes, 0) > m.grace THEN 1
                 ELSE 0
               END AS late_mark,
               CASE WHEN m.status = 'leave' AND NOT m.paid_leave
                    THEN CASE WHEN m.half_leave THEN 0.5 ELSE 1.0 END ELSE 0 END::numeric
                 AS unpaid_leave,
               CASE WHEN m.status = 'leave' AND m.paid_leave
                    THEN m.quota_excess ELSE 0 END::numeric AS quota_leave
          FROM marked m
    ),
    tallied AS (
        SELECT p.uid, p.eid,
               count(*) FILTER (WHERE p.status = 'absent')::numeric   AS absent,
               count(*) FILTER (WHERE p.status = 'half_day')::numeric AS halves,
               sum(p.unpaid_leave)                                    AS unpaid,
               sum(p.quota_leave)                                     AS quota_lop,
               sum(p.late_mark)::integer                              AS marks,
               sum(p.charged)                                         AS charged
          FROM priced p
         GROUP BY p.uid, p.eid
    ),
    raw AS (
        SELECT t.*,
               t.charged + floor(t.marks::numeric / pol.late_marks_per_lop_day) AS gross_lop
          FROM tallied t
    )
    -- Rounded to two places on the way out: numeric division carries twenty
    -- decimals that mean nothing to a payslip and read as noise in JSON.
    SELECT r.uid, r.eid, r.absent, r.halves, r.unpaid, r.marks,
           round(LEAST(
               CASE WHEN pol.max_lop_days_per_month IS NULL THEN rounded.v
                    ELSE LEAST(rounded.v, pol.max_lop_days_per_month) END,
               (last_day - first_day + 1)::numeric
           ), 2),
           round(r.quota_lop, 2),
           COALESCE(x.days, 0)
      FROM raw r
      LEFT JOIN expected x ON x.eid = r.eid
      CROSS JOIN LATERAL (
          SELECT CASE pol.lop_rounding
                   WHEN 'up'   THEN ceil(r.gross_lop)
                   WHEN 'half' THEN round(r.gross_lop * 2) / 2
                   ELSE r.gross_lop
                 END AS v
      ) rounded;
END $$;
-- +goose StatementEnd

-- +goose StatementBegin
/*
The same register for the caller's own school.

	Payroll already runs inside a tenant transaction, so making it name the
	institution again would be one more place for the two to disagree.
*/
CREATE FUNCTION staff_lop_register(p_year integer, p_month integer)
RETURNS TABLE (
    user_id           uuid,
    employee_id       uuid,
    absent_days       numeric,
    half_days         numeric,
    unpaid_leave_days numeric,
    late_marks        integer,
    lop_days          numeric,
    quota_lop_days    numeric,
    expected_days     numeric
)
LANGUAGE sql STABLE
AS $$
    SELECT * FROM staff_lop_register(app_current_institution(), p_year, p_month);
$$;
-- +goose StatementEnd

-- +goose StatementBegin
/*
staff_lop_days is one employee's loss of pay for one month.

	The scalar form exists for callers that already have a row in hand. Anything
	looping over staff should join the register instead: this re-runs the whole
	month per call.
*/
CREATE FUNCTION staff_lop_days(p_institution uuid, p_user uuid,
                               p_year integer, p_month integer)
RETURNS numeric
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE((SELECT r.lop_days
                       FROM staff_lop_register(p_institution, p_year, p_month) r
                      WHERE r.user_id = p_user), 0)::numeric;
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION IF EXISTS staff_lop_days(uuid, uuid, integer, integer);
DROP FUNCTION IF EXISTS staff_lop_register(integer, integer);
DROP FUNCTION IF EXISTS staff_lop_register(uuid, integer, integer);
ALTER TABLE leave_policy DROP COLUMN IF EXISTS lop_on_exhausted_quota;
