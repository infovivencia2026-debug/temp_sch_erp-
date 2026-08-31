-- Give a school a workable week: 6 periods a day, Monday to Saturday, for
-- every section of the current academic year.
--
-- WHY THIS EXISTS
--
-- A school can finish setup with classes, sections, subjects and teachers and
-- still have zero rows in timetable_entries, because the timetable is the one
-- thing the wizard never fills in. Everything downstream then looks broken
-- rather than empty: attendance per period has no period to mark, the
-- substitution board has no lesson to cover, the teacher's calendar is blank
-- and the duty roster has nobody scheduled. Yajur is in exactly that state:
-- 13 classes, 18 sections, no timetable at all. This script writes a plain
-- round-robin week so those screens have something true to show, and a
-- timetable the school can then edit period by period in the admin grid.
--
-- WHAT IT WRITES
--
--   periods            only the ones missing. Six teaching periods per campus
--                      at 09:00-09:45, 09:45-10:30, 10:45-11:30, 11:30-12:15,
--                      13:00-13:45, 13:45-14:30. An existing period at the
--                      same (campus, sequence) is left exactly as it is, so a
--                      school that already defined its bells keeps them.
--   timetable_entries  one row per section per weekday 1-6 per period, subject
--                      dealt round-robin from the class_subjects the class
--                      already has, teacher taken from section_subject_teachers
--                      where that mapping exists and LEFT NULL where it does
--                      not. It invents no teaching allocation: a subject nobody
--                      has been appointed to teach stays unstaffed, which is
--                      the truth the school needs to see.
--
-- WHAT IT NEVER DOES
--
-- It writes no subject, no section, no teacher, and it never overwrites or
-- deletes a timetable row. A section that already has an entry in a slot keeps
-- it, so this is safe to re-run after hand-editing and safe to run for a
-- school that is half timetabled.
--
-- IDEMPOTENT: the unique index timetable_section_slot (section, weekday,
-- period) carries the ON CONFLICT, so a second run inserts nothing and the
-- week is not doubled. The teacher side respects timetable_teacher_slot the
-- same way: a teacher already standing in front of another section in that
-- slot is dropped to NULL here rather than colliding, both against rows this
-- script just wrote and against rows that were already there.
--
-- RUN (never against production; take a backup first if you mean to):
--
--   psql "$DATABASE_URL" -v inst=a64a713c-83d7-4d7f-b956-2e0dc6270f2a \
--        -f scripts/seed_timetable.sql
--
-- The institution uuid is required and the script refuses to run without it,
-- because a timetable seeded across every tenant on the box is not something
-- anyone can undo by hand.

\set ON_ERROR_STOP on

BEGIN;

-- Migrations and this script run as the table owner, and every table here
-- FORCEs row level security, so without this the inserts are silently filtered
-- to nothing (or refused by the WITH CHECK on tenant_isolation).
SELECT set_config('app.is_platform_admin', 'on', true);

\if :{?inst}
\else
\echo 'ERROR: pass the institution, e.g. -v inst=a64a713c-...'
\quit
\endif

SELECT set_config('seed.inst', :'inst', true);

-- Fail loudly rather than write a week nobody asked for.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM institutions
                    WHERE id = current_setting('seed.inst')::uuid) THEN
        RAISE EXCEPTION 'no institution %', current_setting('seed.inst');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM academic_years
                    WHERE institution_id = current_setting('seed.inst')::uuid
                      AND is_current) THEN
        RAISE EXCEPTION 'institution % has no current academic year, so there is nothing to timetable',
              current_setting('seed.inst');
    END IF;
END
$$;

\echo '-- before'
SELECT (SELECT count(*) FROM sections s
          JOIN academic_years ay ON ay.id = s.academic_year_id AND ay.is_current
         WHERE s.institution_id = current_setting('seed.inst')::uuid) AS sections,
       (SELECT count(*) FROM periods
         WHERE institution_id = current_setting('seed.inst')::uuid
           AND NOT is_break)                                          AS teaching_periods,
       (SELECT count(*) FROM timetable_entries
         WHERE institution_id = current_setting('seed.inst')::uuid)   AS entries;

-- ============================================================ the bell times
--
-- Only campuses that actually run sections this year, so a dormant campus does
-- not collect six periods it will never use.
INSERT INTO periods (institution_id, campus_id, name, sequence, starts_at, ends_at, is_break)
SELECT c.institution_id, c.campus_id, p.name, p.sequence, p.starts_at, p.ends_at, false
  FROM (SELECT DISTINCT s.institution_id, s.campus_id
          FROM sections s
          JOIN academic_years ay ON ay.id = s.academic_year_id AND ay.is_current
         WHERE s.institution_id = current_setting('seed.inst')::uuid) c
  CROSS JOIN (VALUES
        ('Period 1', 1, time '09:00', time '09:45'),
        ('Period 2', 2, time '09:45', time '10:30'),
        ('Period 3', 3, time '10:45', time '11:30'),
        ('Period 4', 4, time '11:30', time '12:15'),
        ('Period 5', 5, time '13:00', time '13:45'),
        ('Period 6', 6, time '13:45', time '14:30')
      ) AS p(name, sequence, starts_at, ends_at)
ON CONFLICT (institution_id, campus_id, sequence) DO NOTHING;

-- ============================================================== the week
WITH inst AS (
    SELECT current_setting('seed.inst')::uuid AS id
),
-- The six teaching periods a campus runs, lowest sequences first. A break
-- period is skipped: nobody teaches through lunch, and student_attendance
-- would then ask for a register nobody takes.
slot_period AS (
    SELECT p.institution_id, p.campus_id, p.id AS period_id,
           row_number() OVER (PARTITION BY p.campus_id ORDER BY p.sequence) AS slot
      FROM periods p
     WHERE p.institution_id = (SELECT id FROM inst)
       AND NOT p.is_break
),
sec AS (
    SELECT s.id AS section_id, s.institution_id, s.campus_id, s.class_id,
           s.academic_year_id
      FROM sections s
      JOIN academic_years ay ON ay.id = s.academic_year_id AND ay.is_current
     WHERE s.institution_id = (SELECT id FROM inst)
),
-- The subjects the class already carries, in a stable order so two runs of
-- this script deal the same subject into the same slot.
subj AS (
    SELECT cs.class_id, cs.id AS class_subject_id,
           row_number() OVER (PARTITION BY cs.class_id
                              ORDER BY cs.is_elective, sub.name, cs.id) - 1 AS n
      FROM class_subjects cs
      JOIN subjects sub ON sub.id = cs.subject_id
     WHERE cs.institution_id = (SELECT id FROM inst)
),
subj_count AS (
    SELECT class_id, count(*) AS total FROM subj GROUP BY class_id
),
-- Monday to Saturday, six slots a day, round-robin over the class's subjects.
-- The stride counts across the whole week rather than restarting each morning,
-- so a subject does not land in the same period every day.
grid AS (
    SELECT sec.institution_id, sec.academic_year_id, sec.section_id,
           sec.class_id, d.weekday, sp.period_id,
           ((d.weekday - 1) * 6 + (sp.slot - 1)) % sc.total AS pick
      FROM sec
      JOIN slot_period sp ON sp.campus_id = sec.campus_id AND sp.slot <= 6
      JOIN generate_series(1, 6) AS d(weekday) ON true
      JOIN subj_count sc ON sc.class_id = sec.class_id AND sc.total > 0
),
lesson AS (
    SELECT g.institution_id, g.academic_year_id, g.section_id, g.weekday,
           g.period_id, subj.class_subject_id
      FROM grid g
      JOIN subj ON subj.class_id = g.class_id AND subj.n = g.pick
),
-- Who has actually been appointed to this subject in this section. No mapping
-- means no teacher: an invented one would put a name on a period the teacher
-- never agreed to and would break the moment somebody read the load report.
-- LATERAL and not a plain LEFT JOIN because a section can legitimately carry
-- two teachers for one subject (a lab split, a co-teacher). Joining both would
-- deal the same slot twice and half the week would be thrown away by the
-- ON CONFLICT instead of placed.
staffed AS (
    SELECT l.*, t.teacher_user_id
      FROM lesson l
      LEFT JOIN LATERAL (
            SELECT sst.teacher_user_id
              FROM section_subject_teachers sst
             WHERE sst.section_id = l.section_id
               AND sst.class_subject_id = l.class_subject_id
             ORDER BY sst.created_at, sst.id
             LIMIT 1
      ) t ON true
),
-- A teacher can only be in one room at a time, and timetable_teacher_slot says
-- so in SQL. Where the round-robin double-books somebody, the first section
-- (by id, so the choice is stable across runs) keeps them and the rest of that
-- slot goes unstaffed for a human to fix.
resolved AS (
    SELECT s.institution_id, s.academic_year_id, s.section_id, s.weekday,
           s.period_id, s.class_subject_id,
           CASE
             WHEN s.teacher_user_id IS NULL THEN NULL
             WHEN row_number() OVER (PARTITION BY s.teacher_user_id, s.weekday,
                                                  s.period_id, s.academic_year_id
                                     ORDER BY s.section_id) > 1 THEN NULL
             WHEN EXISTS (SELECT 1 FROM timetable_entries te
                           WHERE te.teacher_user_id = s.teacher_user_id
                             AND te.weekday = s.weekday
                             AND te.period_id = s.period_id
                             AND te.academic_year_id = s.academic_year_id) THEN NULL
             ELSE s.teacher_user_id
           END AS teacher_user_id
      FROM staffed s
)
INSERT INTO timetable_entries
    (institution_id, academic_year_id, section_id, period_id, weekday,
     class_subject_id, teacher_user_id)
SELECT institution_id, academic_year_id, section_id, period_id, weekday,
       class_subject_id, teacher_user_id
  FROM resolved
ON CONFLICT (section_id, weekday, period_id) DO NOTHING;

\echo '-- after'
SELECT count(*)                                     AS entries,
       count(teacher_user_id)                       AS staffed,
       count(*) - count(teacher_user_id)            AS unstaffed,
       count(DISTINCT section_id)                   AS sections_with_a_week
  FROM timetable_entries
 WHERE institution_id = current_setting('seed.inst')::uuid;

COMMIT;
