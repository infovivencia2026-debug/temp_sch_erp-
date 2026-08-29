-- Do the relationships between roles actually hold in the data?
--
-- The companion to relation_check.py. That one signs in and asks what each role
-- can REACH; this asks whether the links those answers depend on are there at
-- all. They fail differently and both are worth knowing: a scope rule that is
-- perfectly enforced over a link nobody created still shows an empty screen,
-- and the person looking at it cannot tell which of the two went wrong.
--
-- Read-only. Run against the live school:
--   psql -d temperp -f scripts/relation_check.sql
--
-- Every check states the school it is about, so a failure names the tenant
-- rather than the installation.

\set ON_ERROR_STOP on
SET app.is_platform_admin = 'on';

\echo ''
\echo 'Relations, checked in the data'
\echo ''

WITH
-- Every check returns (relation, question, verdict, detail). A relation with
-- nothing to test on says so rather than passing: a green line that is green
-- because the table is empty is the one that hides the fault.
inst AS (
  SELECT id, name FROM institutions WHERE status <> 'deleted'
),

-- 1. A teacher reaches a section, and only through a link somebody made.
teachers AS (
  SELECT i.name AS school,
         count(DISTINCT e.user_id) FILTER (WHERE e.user_id IS NOT NULL) AS with_login,
         count(DISTINCT t.teacher_user_id)                              AS timetabled
    FROM inst i
    JOIN employees e ON e.institution_id = i.id AND e.status = 'active'
    LEFT JOIN section_subject_teachers t ON t.institution_id = i.id
   GROUP BY i.name
),
r_teacher AS (
  SELECT school,
         'teacher -> section' AS relation,
         'somebody is allocated to teach' AS question,
         CASE WHEN timetabled > 0 THEN 'PASS' ELSE 'EMPTY' END AS verdict,
         timetabled || ' teachers allocated, ' || with_login || ' staff can sign in' AS detail
    FROM teachers
),

-- 2. A child reaches a family, and a family reaches a login.
families AS (
  SELECT i.name AS school,
         count(DISTINCT s.id)                                        AS children,
         count(DISTINCT sg.student_id)                               AS children_with_guardian,
         count(DISTINCT g.id) FILTER (WHERE g.user_id IS NOT NULL)   AS guardians_with_login
    FROM inst i
    JOIN students s ON s.institution_id = i.id AND s.status = 'active'
    LEFT JOIN student_guardians sg ON sg.student_id = s.id
    LEFT JOIN guardians g ON g.id = sg.guardian_id
   GROUP BY i.name
),
r_family AS (
  SELECT school, 'parent -> child',
         'every child has a guardian on file',
         CASE WHEN children = 0 THEN 'EMPTY'
              WHEN children_with_guardian = children THEN 'PASS'
              ELSE 'FAIL' END,
         children_with_guardian || ' of ' || children || ' children linked; '
           || guardians_with_login || ' guardians can sign in'
    FROM families
  UNION ALL
  SELECT school, 'parent -> child',
         'a guardian can actually open the portal',
         CASE WHEN children = 0 THEN 'EMPTY'
              WHEN guardians_with_login > 0 THEN 'PASS' ELSE 'FAIL' END,
         CASE WHEN guardians_with_login > 0
              THEN guardians_with_login || ' with a login'
              ELSE 'guardians exist and none has a user account, so the parent '
                   || 'portal is unreachable for this school' END
    FROM families
),

-- 3. A child reaches a section, or their teacher cannot see them.
enrol AS (
  SELECT i.name AS school,
         count(*) AS children,
         count(*) FILTER (WHERE e.section_id IS NOT NULL) AS placed
    FROM inst i
    JOIN students s ON s.institution_id = i.id AND s.status = 'active'
    LEFT JOIN enrollments e ON e.student_id = s.id AND e.status = 'active'
   GROUP BY i.name
),
r_enrol AS (
  SELECT school, 'student -> section',
         'every child marked active sits in a section',
         CASE WHEN children = 0 THEN 'EMPTY'
              WHEN placed = children THEN 'PASS' ELSE 'FAIL' END,
         placed || ' of ' || children || ' placed'
    FROM enrol
),

-- 4. An admission reaches the fee ledger.
admitted AS (
  SELECT i.name AS school,
         count(*) FILTER (WHERE a.status = 'accepted' AND a.student_id IS NOT NULL) AS enrolled,
         count(*) FILTER (WHERE a.status = 'accepted' AND a.student_id IS NOT NULL
                            AND EXISTS (SELECT 1 FROM invoices v
                                         WHERE v.student_id = a.student_id))        AS billed
    FROM inst i
    LEFT JOIN applications a ON a.institution_id = i.id
   GROUP BY i.name
),
r_admit AS (
  SELECT school, 'admissions -> finance',
         'an enrolled applicant has a fee account',
         CASE WHEN enrolled = 0 THEN 'EMPTY'
              WHEN billed = enrolled THEN 'PASS' ELSE 'FAIL' END,
         billed || ' of ' || enrolled || ' enrolled applicants have an invoice'
    FROM admitted
),

-- 5. A teacher's homework reaches a class that has children in it.
hw AS (
  SELECT i.name AS school,
         /* count(h.id), not count(*): a LEFT JOIN with no match still yields
            one row with nulls in it, so count(*) reported "0 of 1 tasks" for
            every school that has never set any homework — nine invented
            failures, each of them my arithmetic rather than their data. */
         count(h.id) AS tasks,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM enrollments e
            WHERE e.section_id = h.section_id AND e.status = 'active')) AS to_a_real_class
    FROM inst i
    /* This year's homework only.

       Tasks set for a class whose children have since been promoted reach
       nobody, and that is history rather than a fault — Vivencia has sixteen
       of them against a Grade 6-A whose thirty pupils are all marked promoted.
       Counting those as broken links buries the ones that are. */
    LEFT JOIN homework h ON h.institution_id = i.id AND h.is_published
                        AND h.assigned_on >= COALESCE(
                              (SELECT ay.starts_on FROM academic_years ay
                                WHERE ay.institution_id = i.id
                                ORDER BY ay.is_current DESC, ay.starts_on DESC
                                LIMIT 1),
                              CURRENT_DATE - 365)
   GROUP BY i.name
),
r_hw AS (
  SELECT school, 'teacher -> student',
         'published homework lands on a class with children',
         CASE WHEN tasks = 0 THEN 'EMPTY'
              WHEN to_a_real_class = tasks THEN 'PASS' ELSE 'FAIL' END,
         to_a_real_class || ' of ' || tasks || ' tasks reach a section that has pupils'
    FROM hw
),

-- 6. An appraisal reaches the person it is about.
appr AS (
  SELECT i.name AS school,
         count(a.id) AS raised,   -- same reason as tasks above
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM appraisal_ratings rt WHERE rt.appraisal_id = a.id)) AS with_kpis,
         count(*) FILTER (WHERE e.user_id IS NOT NULL)                       AS reachable
    FROM inst i
    LEFT JOIN appraisals a ON a.institution_id = i.id
    LEFT JOIN employees  e ON e.id = a.employee_id
   GROUP BY i.name
),
r_appr AS (
  SELECT school, 'HR -> employee',
         'a raised appraisal has KPIs and an owner who can sign in',
         CASE WHEN raised = 0 THEN 'EMPTY'
              WHEN with_kpis = raised AND reachable = raised THEN 'PASS' ELSE 'FAIL' END,
         with_kpis || ' of ' || raised || ' have KPIs; '
           || reachable || ' belong to somebody with a login'
    FROM appr
),

-- 7. A bus route reaches the children on it.
bus AS (
  SELECT i.name AS school,
         count(DISTINCT ta.student_id) AS riders,
         count(DISTINCT ta.route_id)   AS routes
    FROM inst i
    LEFT JOIN transport_allocations ta ON ta.institution_id = i.id
                                      AND (ta.valid_to IS NULL OR ta.valid_to >= CURRENT_DATE)
   GROUP BY i.name
),
r_bus AS (
  SELECT school, 'transport -> parent',
         'children are allocated to a route',
         CASE WHEN riders = 0 THEN 'EMPTY' ELSE 'PASS' END,
         riders || ' children across ' || routes || ' routes'
    FROM bus
),

all_checks AS (
  SELECT * FROM r_teacher UNION ALL SELECT * FROM r_family
  UNION ALL SELECT * FROM r_enrol   UNION ALL SELECT * FROM r_admit
  UNION ALL SELECT * FROM r_hw      UNION ALL SELECT * FROM r_appr
  UNION ALL SELECT * FROM r_bus
)
SELECT verdict,
       school,
       relation,
       question,
       detail
  FROM all_checks
 WHERE verdict <> 'EMPTY' OR school IN (SELECT name FROM inst)
 ORDER BY CASE verdict WHEN 'FAIL' THEN 0 WHEN 'EMPTY' THEN 1 ELSE 2 END,
          school, relation;
