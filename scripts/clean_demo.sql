-- Repair the demo tenant after two known messes.
--
--  1. A duplicate campus. The demo seeder used to identify a school's campus
--     by the code 'MAIN', so a school that renamed its campus through the
--     setup wizard — the first thing the wizard invites — collected a second
--     campus on the next seed, and with it a duplicate of every class,
--     section, period and student. cmd/migrate/demo.go now finds the campus by
--     institution instead, so this cannot recur; these are the rows the old
--     behaviour already wrote.
--
--  2. Throwaway accounts from the role-grant tests. The tests now remove their
--     own rows; these are the ones earlier runs left behind.
--
-- The students the day-in-the-life run admitted are deliberately NOT removed.
-- They carry receipts and marks — the simulation collected a fee from them and
-- entered their papers — and deleting a student with money recorded against
-- them to tidy a demo is the wrong trade. They are indistinguishable from real
-- children now, which is the point of the simulation.
--
-- Run:  psql -d school_erp -f scripts/clean_demo.sql

BEGIN;

-- Migrations and this script run as the owner, and every table forces RLS.
SELECT set_config('app.is_platform_admin', 'on', true);

\echo '-- before'
SELECT (SELECT count(*) FROM campuses) AS campuses,
       (SELECT count(*) FROM classes)  AS classes,
       (SELECT count(*) FROM students) AS students,
       (SELECT count(*) FROM periods)  AS periods,
       (SELECT count(*) FROM users)    AS users;

-- 1. Duplicate campuses -------------------------------------------------------
--
-- A duplicate is not simply "has no data" — the bad seed wrote students,
-- invoices and a register onto it too. What separates it from a genuine second
-- campus is examination marks: the copy has none, while the campus it was
-- copied from carries the school's results.
--
-- Marks are the right test because they are the one thing the seeder never
-- fabricated. A real campus open long enough to enrol ninety-six children and
-- take a hundred payments has sat a paper; a campus conjured in one statement
-- has not. Both halves are required, so a school genuinely opening its second
-- site this term is never caught.
CREATE TEMP TABLE doomed_campus AS
SELECT c.id, c.name, c.institution_id
  FROM campuses c
 WHERE
   -- not the institution's original campus
   EXISTS (SELECT 1 FROM campuses o
            WHERE o.institution_id = c.institution_id
              AND o.id <> c.id
              AND o.created_at < c.created_at)
   -- no examination history of its own
   AND NOT EXISTS (SELECT 1 FROM marks m
                     JOIN students s ON s.id = m.student_id
                    WHERE s.campus_id = c.id)
   -- while a sibling campus has some, which is what it was copied from
   AND EXISTS (SELECT 1 FROM marks m
                 JOIN students s ON s.id = m.student_id
                 JOIN campuses o ON o.id = s.campus_id
                WHERE o.institution_id = c.institution_id AND o.id <> c.id);

\echo '-- campuses to remove (copies: no marks of their own)'
SELECT id, name FROM doomed_campus;

-- Three foreign keys into classes and sections are ON DELETE RESTRICT, on
-- purpose: losing a class silently would strand the enrolments that give a
-- child their place, and an application's chosen class must not vanish under
-- it. Removing a copied campus therefore means clearing those references
-- first, in dependency order, rather than relaxing the constraint.
DELETE FROM enrollments e
 WHERE e.class_id IN (SELECT k.id FROM classes k
                       WHERE k.campus_id IN (SELECT id FROM doomed_campus))
    OR e.section_id IN (SELECT sec.id FROM sections sec
                          JOIN classes k ON k.id = sec.class_id
                         WHERE k.campus_id IN (SELECT id FROM doomed_campus));

UPDATE applications SET class_sought = NULL
 WHERE class_sought IN (SELECT k.id FROM classes k
                         WHERE k.campus_id IN (SELECT id FROM doomed_campus));

DELETE FROM campuses WHERE id IN (SELECT id FROM doomed_campus);

-- 2. Test litter --------------------------------------------------------------
--
-- Throwaway accounts from the role-grant tests. The email pattern is the
-- test's own, and the never-signed-in check keeps a real person who happens to
-- match from being caught by it.
DELETE FROM users u
 WHERE u.email ~ '^(boundary|preset|boxes|audited)-[0-9a-f]{8}@'
   AND u.last_login_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id);

\echo '-- after'
SELECT (SELECT count(*) FROM campuses) AS campuses,
       (SELECT count(*) FROM classes)  AS classes,
       (SELECT count(*) FROM students) AS students,
       (SELECT count(*) FROM periods)  AS periods,
       (SELECT count(*) FROM users)    AS users;

\echo '-- the surviving schools'
SELECT i.short_name,
       c.name AS campus,
       (SELECT count(*) FROM students s WHERE s.campus_id = c.id) AS students,
       (SELECT count(*) FROM classes k WHERE k.campus_id = c.id)  AS classes,
       (SELECT count(*) FROM periods p WHERE p.campus_id = c.id)  AS periods
  FROM campuses c
  JOIN institutions i ON i.id = c.institution_id
 ORDER BY 1, 2;

COMMIT;
