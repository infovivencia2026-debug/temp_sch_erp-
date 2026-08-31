-- The 2026-27 school calendar for a Telangana school: state and national
-- holidays, vacations, exams, PTMs and the term markers.
--
-- WHY THIS EXISTS
--
-- Yajur has zero rows in holidays. Every screen that reads the calendar is
-- therefore not just empty but wrong: the month calendar renders a year with
-- no colour in it, the working-days compliance count in statutory.go counts
-- every non-Sunday as taught (so a school that shut for Dasara looks like it
-- ran 300 days), the staff calendar shows a teacher nothing between duties,
-- and timetable_ops generates lessons on Sankranti because nothing tells it
-- the school is closed. One holiday row is worth more to those screens than
-- any amount of handler code, and there is no seeder anywhere that writes one.
--
-- WHAT IT WRITES
--
--   holidays   about 60 rows for 2026-06-01 .. 2027-04-30, all trust-wide
--              (campus_id NULL) and attached to the academic year that covers
--              June 2026 where one exists. kind is one of holiday, vacation,
--              exam, event, ptm; nothing is written as working_day, because a
--              working_day row is a school's own answer to a bandh and
--              inventing one would silently add days to the compliance count.
--
-- It writes nothing else. No exams rows, no school_events, no academic_year:
-- the exam board and the events board are separate tables with their own
-- owners, and a seeded exam would collide with the ones the school enters.
--
-- WHICH DATES ARE FIRM AND WHICH ARE NOT
--
-- FIRM (fixed by the Gregorian calendar or by statute):
--   Telangana Formation Day 2 Jun, Independence Day 15 Aug, Gandhi Jayanti
--   2 Oct, Christmas 25 Dec, Republic Day 26 Jan, Ambedkar Jayanti 14 Apr.
--   Bhogi/Sankranti/Kanuma are solar and move at most a day: 14/15/16 Jan 2027.
--   Good Friday is fixed by the Easter computus: 26 Mar 2027.
--
-- APPROXIMATE, because they are lunar and the state fixes them by gazette only
-- a few months ahead. Every one of these is marked in its description and MUST
-- be checked against the Telangana General Holidays gazette for 2026 and 2027
-- before a parent is told the school is shut:
--   Muharram (26 Jun 2026), Bonalu / Ashada Jatara (27 Jul 2026),
--   Milad-un-Nabi (26 Aug 2026), Vinayaka Chavithi (14 Sep 2026) and
--   Nimajjanam, the whole Bathukamma sequence and Dasara (Oct 2026),
--   Deepavali (8 Nov 2026), Maha Shivaratri (6 Mar 2027),
--   Ramzan / Eid-ul-Fitr (9 Mar 2027), Holi (22 Mar 2027),
--   Ugadi (7 Apr 2027) and Sri Rama Navami (15 Apr 2027).
-- The lunar dates can slip by a day in either direction on the moon sighting;
-- Ramzan and Milad-un-Nabi routinely slip by two.
--
-- BAKRID IS DELIBERATELY ABSENT. Eid-ul-Adha falls around 27 May 2026 and
-- again around 17 May 2027, so in this academic year it lands in the summer
-- vacation on both sides and there is no school day to close. Adding a row for
-- it would put a holiday marker in a month the school is already shut.
--
-- Deepavali 8 Nov 2026 is a Sunday, so 9 Nov carries the school holiday; the
-- 8th is still written because the calendar should name the festival on the
-- day it happens.
--
-- IDEMPOTENT: holidays_one_entry (00036) is the unique key and carries the
-- ON CONFLICT. Because campus_id is nullable and a NULL would disable that
-- index for exactly these trust-wide rows, the index folds the campus to the
-- nil uuid, and the conflict target below must repeat that expression exactly
-- or a second run doubles every holiday. Re-running updates to_date,
-- applies_to and description in place, so a corrected date range here is
-- picked up without a delete.
--
-- RUN (never against production; this is seed data for a test school):
--
--   psql "$DATABASE_URL" -v inst=a64a713c-83d7-4d7f-b956-2e0dc6270f2a \
--        -f scripts/seed_calendar_telangana.sql
--
-- The institution uuid is required and the script refuses to run without it,
-- because a calendar written across every tenant on the box is not something
-- anyone can undo by hand.

\set ON_ERROR_STOP on

BEGIN;

-- Migrations and this script run as the table owner, and holidays FORCEs row
-- level security, so without this the insert is refused by the WITH CHECK on
-- tenant_isolation rather than filtered quietly.
SELECT set_config('app.is_platform_admin', 'on', true);

\if :{?inst}
\else
\echo 'ERROR: pass the institution, e.g. -v inst=a64a713c-...'
\quit
\endif

SELECT set_config('seed.inst', :'inst', true);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM institutions
                    WHERE id = current_setting('seed.inst')::uuid) THEN
        RAISE EXCEPTION 'no institution %', current_setting('seed.inst');
    END IF;
END
$$;

\echo '-- before'
SELECT count(*) AS calendar_rows,
       count(*) FILTER (WHERE on_date >= date '2026-06-01'
                          AND on_date <= date '2027-04-30') AS rows_in_2026_27
  FROM holidays
 WHERE institution_id = current_setting('seed.inst')::uuid;

-- The year these entries belong to. academic_year_id is nullable and the
-- calendar handler only filters on it when the caller passes one, so a school
-- with no 2026-27 year row still gets a usable calendar instead of an error.
-- The year that contains June 2026 wins over is_current, because a school
-- seeded mid-2025 has is_current pointing at the wrong year.
WITH ay AS (
    SELECT id FROM academic_years
     WHERE institution_id = current_setting('seed.inst')::uuid
     ORDER BY (date '2026-06-01' BETWEEN starts_on AND ends_on) DESC,
              is_current DESC, starts_on DESC
     LIMIT 1
),
entry(name, on_date, to_date, kind, applies_to, description) AS (VALUES
    -- ============================================ term one, June to September
    ('School Reopens',            date '2026-06-01', NULL::date,        'event',   'all',      'First working day of the 2026-27 academic year.'),
    ('Telangana Formation Day',   date '2026-06-02', NULL::date,        'holiday', 'all',      'State holiday. Fixed date.'),
    ('Muharram',                  date '2026-06-26', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar, confirm against the Telangana gazette.'),
    ('Class Teacher Meet',        date '2026-06-20', NULL::date,        'ptm',     'all',      'Introductory meeting, new parents.'),
    ('Bonalu (Ashada Jatara)',    date '2026-07-27', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar, and the Golconda and Ujjaini dates differ by district.'),
    ('Unit Test I',               date '2026-07-20', date '2026-07-24', 'exam',    'students', 'First formative assessment.'),
    ('Independence Day',          date '2026-08-15', NULL::date,        'holiday', 'all',      'National holiday. Fixed date. Flag hoisting at 08:00, staff attend.'),
    ('Milad-un-Nabi',             date '2026-08-26', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar, commonly slips by up to two days.'),
    ('Quarterly Examinations',    date '2026-09-01', date '2026-09-09', 'exam',    'students', 'First summative examination.'),
    ('Teachers Day',              date '2026-09-05', NULL::date,        'event',   'all',      'Celebrated in school; a working day.'),
    ('Vinayaka Chavithi',         date '2026-09-14', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar, confirm against the Telangana gazette.'),
    ('Ganesh Nimajjanam',         date '2026-09-24', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar. Local processions usually close schools in the city.'),
    ('Parent Teacher Meeting',    date '2026-09-19', NULL::date,        'ptm',     'all',      'Quarterly results handed over.'),
    -- ==================================== Bathukamma and Dasara, October 2026
    -- Bathukamma runs the nine days from Mahalaya Amavasya to Saddula
    -- Bathukamma, which is why it is one span and not nine holidays: the
    -- school works through the first days and shuts for the Dasara break.
    ('Bathukamma',                date '2026-10-11', date '2026-10-18', 'event',   'all',      'APPROXIMATE: lunar. State festival, celebrated in school on the working days it covers.'),
    ('Gandhi Jayanti',            date '2026-10-02', NULL::date,        'holiday', 'all',      'National holiday. Fixed date.'),
    ('Saddula Bathukamma',        date '2026-10-18', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar. Falls on a Sunday in 2026.'),
    ('Durgashtami',               date '2026-10-19', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar.'),
    ('Vijayadashami (Dasara)',    date '2026-10-20', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar.'),
    ('Dasara Vacation',           date '2026-10-15', date '2026-10-24', 'vacation','all',      'APPROXIMATE: anchored on Vijayadashami, which is lunar.'),
    -- ============================================ term two, November to March
    ('Deepavali',                 date '2026-11-08', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar. Falls on a Sunday in 2026.'),
    ('Deepavali Holiday',         date '2026-11-09', NULL::date,        'holiday', 'all',      'APPROXIMATE: the Monday given because Deepavali itself is a Sunday.'),
    ('Childrens Day',             date '2026-11-14', NULL::date,        'event',   'students', 'Celebrated in school; a working day.'),
    ('Unit Test II',              date '2026-11-16', date '2026-11-20', 'exam',    'students', 'Second formative assessment.'),
    ('Annual Sports Day',         date '2026-12-05', NULL::date,        'event',   'all',      'Whole school on the ground; no regular periods.'),
    ('Half Yearly Examinations',  date '2026-12-07', date '2026-12-16', 'exam',    'students', 'Second summative examination.'),
    ('Parent Teacher Meeting',    date '2026-12-19', NULL::date,        'ptm',     'all',      'Half yearly results handed over.'),
    ('Christmas',                 date '2026-12-25', NULL::date,        'holiday', 'all',      'National holiday. Fixed date.'),
    ('Christmas Break',           date '2026-12-24', date '2026-12-26', 'vacation','students', 'Short break; office and staff work on 24 and 26 December.'),
    ('New Year Day',              date '2027-01-01', NULL::date,        'holiday', 'all',      'Fixed date.'),
    ('Sankranti Vacation',        date '2027-01-12', date '2027-01-17', 'vacation','all',      'The harvest break. Anchored on Makara Sankranti, which is solar and firm.'),
    ('Bhogi',                     date '2027-01-14', NULL::date,        'holiday', 'all',      'State holiday. Solar, firm to within a day.'),
    ('Makara Sankranti',          date '2027-01-15', NULL::date,        'holiday', 'all',      'State holiday. Solar, firm to within a day.'),
    ('Kanuma',                    date '2027-01-16', NULL::date,        'holiday', 'all',      'State holiday. Solar, firm to within a day.'),
    ('Republic Day',              date '2027-01-26', NULL::date,        'holiday', 'all',      'National holiday. Fixed date. Flag hoisting at 08:00, staff attend.'),
    ('Annual Day',                date '2027-02-06', NULL::date,        'event',   'all',      'Evening function; a working day.'),
    ('Unit Test III',             date '2027-02-08', date '2027-02-12', 'exam',    'students', 'Third formative assessment.'),
    ('Maha Shivaratri',           date '2027-03-06', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar, confirm against the Telangana gazette.'),
    ('Ramzan (Eid-ul-Fitr)',      date '2027-03-09', NULL::date,        'holiday', 'all',      'APPROXIMATE: declared on the moon sighting, routinely moves by a day either way.'),
    ('Pre Final Examinations',    date '2027-03-15', date '2027-03-20', 'exam',    'students', 'Board pattern practice for the exit classes.'),
    ('Holi',                      date '2027-03-22', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar.'),
    ('Good Friday',               date '2027-03-26', NULL::date,        'holiday', 'all',      'Fixed by the Easter computus: firm.'),
    -- ============================================== term three and year close
    ('Annual Examinations',       date '2027-03-29', date '2027-04-10', 'exam',    'students', 'Final summative examination. Ugadi falls inside this window; the papers on that day move.'),
    ('Ugadi',                     date '2027-04-07', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar. Telugu new year, state holiday.'),
    ('Ambedkar Jayanti',          date '2027-04-14', NULL::date,        'holiday', 'all',      'National holiday. Fixed date.'),
    ('Sri Rama Navami',           date '2027-04-15', NULL::date,        'holiday', 'all',      'APPROXIMATE: lunar.'),
    ('Result Day and PTM',        date '2027-04-22', NULL::date,        'ptm',     'all',      'Annual results handed over.'),
    ('Last Working Day',          date '2027-04-23', NULL::date,        'event',   'all',      'Close of the 2026-27 academic year.'),
    ('Summer Vacation',           date '2027-04-24', date '2027-06-06', 'vacation','students', 'Students only: office and admissions work through May.')
)
INSERT INTO holidays
    (institution_id, campus_id, academic_year_id, name, on_date, to_date, kind, applies_to, description)
SELECT current_setting('seed.inst')::uuid,
       NULL,
       (SELECT id FROM ay),
       e.name, e.on_date, e.to_date, e.kind, e.applies_to, e.description
  FROM entry e
-- Repeats holidays_one_entry from 00036 expression for expression. The
-- COALESCE is not decoration: campus_id is NULL on every row above, and a
-- plain (institution_id, campus_id, on_date, kind, name) target does not match
-- the index and the statement fails outright.
ON CONFLICT (institution_id,
             COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid),
             on_date, kind, lower(name))
DO UPDATE SET to_date          = EXCLUDED.to_date,
              applies_to       = EXCLUDED.applies_to,
              description      = EXCLUDED.description,
              academic_year_id = COALESCE(EXCLUDED.academic_year_id, holidays.academic_year_id);

\echo '-- after'
SELECT kind, count(*) AS rows
  FROM holidays
 WHERE institution_id = current_setting('seed.inst')::uuid
   AND on_date BETWEEN date '2026-06-01' AND date '2027-04-30'
 GROUP BY kind
 ORDER BY kind;

-- What the compliance count will now see: the days the school is actually open
-- under the same rule statutory.go applies, so a wrong vacation span shows up
-- here rather than three screens later.
SELECT count(*)::int AS open_days_2026_27
  FROM generate_series(date '2026-06-01', date '2027-04-23', interval '1 day') d
 WHERE extract(isodow FROM d) <> 7
   AND NOT EXISTS (SELECT 1 FROM holidays h
                    WHERE h.institution_id = current_setting('seed.inst')::uuid
                      AND h.kind IN ('holiday','vacation')
                      AND h.applies_to IN ('all','students')
                      AND d::date BETWEEN h.on_date AND COALESCE(h.to_date, h.on_date));

COMMIT;
