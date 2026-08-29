-- +goose Up
-- +goose StatementBegin

/* THE BACKFILL BELOW READS `periods`, WHICH FORCES ROW-LEVEL SECURITY.
 *
 * A migration runs with no tenant set, so every RLS-forced table reads as
 * empty. The INSERT that creates one schedule per campus selects FROM periods
 * — it saw nothing, created nothing, the UPDATE that follows matched nothing,
 * and SET NOT NULL then failed on the forty-two rows it had left null. The
 * error names the column and says nothing about the cause, and the whole
 * deploy stops on it.
 *
 * app_is_platform_admin is the switch every one of these policies already
 * reads, so this asks for the standing the platform has rather than lifting
 * policies off tables and putting them back. LOCAL: it lasts this transaction
 * and no longer.
 *
 * Migration 00150 was fixed for exactly this and left a comment saying so;
 * this is the second time, which is what makes it worth repeating here rather
 * than in a note somewhere else.
 */
SET LOCAL app.is_platform_admin = 'on';

/* PRIMARY DOES NOT GO HOME WHEN CLASS TEN DOES.

   `periods` has been scoped to (institution_id, campus_id) since the baseline:
   one bell schedule for a whole campus. Every Indian school this product is
   sold into breaks that assumption on day one. Primary runs six periods and is
   out by half past three; the high school runs eight and finishes at half past
   four; a school with a pre-primary wing has a third, shorter day again.

   Until now the only way to express that was to define the longest day and let
   the primary timetable simply not use the last two periods -- which makes the
   attendance register show two unmarked periods for every primary section
   every day, makes a teacher look free when they have gone home, and puts a
   bell on the screen that does not ring.

   So: a campus may have several named schedules, and a class points at one.

   ---------------------------------------------------------------------------
   WHY NULL MEANS THE DEFAULT

   classes.bell_schedule_id is nullable and NULL means "the campus default".
   The alternative -- backfilling every class with the id of its campus's
   default -- looks tidier and is worse: a school that later changes which
   schedule is the default would have to have every class rewritten, and any
   class created in the meantime by a code path that forgot the column would
   point at nothing. NULL delegates the decision instead of copying it, so
   there is exactly one place the default lives.

   Read it with the resolver in internal/api/bell_schedules.go, never by
   joining bell_schedule_id directly.
*/

CREATE TABLE IF NOT EXISTS bell_schedules (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
    name           text NOT NULL,
    -- The one a class falls back to when it names none. Exactly one per campus,
    -- enforced by the partial unique index below rather than by a trigger.
    is_default     boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bell_schedules_name_per_campus UNIQUE (campus_id, name)
);

-- One default per campus, and the index says so. A partial unique index is the
-- right shape here: it constrains only the rows where is_default is true and
-- says nothing about the rest, which is precisely the rule.
CREATE UNIQUE INDEX IF NOT EXISTS bell_schedules_one_default
    ON bell_schedules (campus_id) WHERE is_default;

ALTER TABLE bell_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE bell_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bell_schedules;
CREATE POLICY tenant_isolation ON bell_schedules
    USING (app_is_platform_admin() OR institution_id = app_current_institution());

/* EVERY EXISTING CAMPUS KEEPS THE DAY IT HAS.

   One schedule per campus that already has periods, named for what it is, and
   marked default -- so nothing a school has set up changes, and every class
   that names no schedule resolves to exactly the periods it resolved to
   yesterday. A campus with no periods yet gets no schedule: the setup panel
   creates one when the day is first defined, and a row named "Standard day"
   with nothing in it would be a schedule that lies about being configured. */
INSERT INTO bell_schedules (institution_id, campus_id, name, is_default)
SELECT DISTINCT p.institution_id, p.campus_id, 'Standard day', true
  FROM periods p
 WHERE NOT EXISTS (
        SELECT 1 FROM bell_schedules b WHERE b.campus_id = p.campus_id AND b.is_default);

ALTER TABLE periods ADD COLUMN IF NOT EXISTS bell_schedule_id uuid
    REFERENCES bell_schedules(id) ON DELETE CASCADE;

UPDATE periods p
   SET bell_schedule_id = b.id
  FROM bell_schedules b
 WHERE b.campus_id = p.campus_id AND b.is_default
   AND p.bell_schedule_id IS NULL;

-- NOT NULL only after the backfill, so the migration is safe on a populated
-- database and the column can never afterwards hold a period belonging to no
-- schedule.
ALTER TABLE periods ALTER COLUMN bell_schedule_id SET NOT NULL;

/* THE OLD CONSTRAINT WOULD HAVE BLOCKED THE WHOLE FEATURE.

   The baseline carries UNIQUE (institution_id, campus_id, sequence) on
   periods. One campus, one period numbered 1 -- which is exactly the rule this
   migration exists to lift. Left in place, creating a primary schedule on a
   campus that already has a high-school one fails on its first row with a
   duplicate key, and the error names a constraint nobody would connect to the
   screen they were using.

   Dropped and re-stated one level down: unique within a SCHEDULE. Two
   schedules both having a Period 1 is the point; one schedule having two is a
   bug, and the database should still refuse that. */
ALTER TABLE periods DROP CONSTRAINT IF EXISTS periods_institution_id_campus_id_sequence_key;
CREATE UNIQUE INDEX IF NOT EXISTS periods_schedule_sequence
    ON periods (bell_schedule_id, sequence);

ALTER TABLE classes ADD COLUMN IF NOT EXISTS bell_schedule_id uuid
    REFERENCES bell_schedules(id) ON DELETE SET NULL;

COMMENT ON COLUMN classes.bell_schedule_id IS
    'Which bell schedule this class follows. NULL means the campus default; '
    'resolve with internal/api/bell_schedules.go rather than joining directly.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE classes DROP COLUMN IF EXISTS bell_schedule_id;
DROP INDEX IF EXISTS periods_schedule;
DROP INDEX IF EXISTS periods_schedule_sequence;
ALTER TABLE periods DROP COLUMN IF EXISTS bell_schedule_id;
-- Restored, so a rollback leaves periods constrained exactly as the baseline
-- had them rather than looser than it found them.
ALTER TABLE periods ADD CONSTRAINT periods_institution_id_campus_id_sequence_key
    UNIQUE (institution_id, campus_id, sequence);
DROP TABLE IF EXISTS bell_schedules;
-- +goose StatementEnd
