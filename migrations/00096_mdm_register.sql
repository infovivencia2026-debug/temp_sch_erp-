-- Numbered 00087 as instructed. THIS NUMBER MAY BE RENUMBERED AT INTEGRATION;
-- Renumbered at integration: the parent forum took 00093 while this was in
-- flight, and goose refuses a migration numbered below the current version.
-- nothing in the file depends on its own number.
--
-- Two subjects, one file, because the second is three additive columns rather
-- than a migration of its own:
--
--   1. the mid-day meal register  -- the daily record the monthly utilisation
--      return has been aggregating since 00053, over a table nothing ever
--      wrote. Completed here, and its nullable-UNIQUE defect repaired.
--   2. timetable_drafts           -- three columns marking a draft a human
--      hand-edited after the generator produced it.

-- +goose Up

-- ============================================ 1a. the register's broken key

/* mdm_registers (00008:128) declared UNIQUE (institution_id, campus_id, on_date)
   with campus_id NULLABLE.

   A NULL is distinct from every other NULL, so for a single-campus school --
   which is most schools, and every school that has never created a campus row
   -- that constraint enforces nothing at all and the same day can be entered
   twice. Two registers for 12 March, each with its own meal count, and the
   utilisation return sums both: the school reports twice the meals it served
   on a form the block office audits.

   00008 is not edited. The bare constraint is dropped and replaced with the
   COALESCE'd index this codebase uses everywhere else. */

-- Duplicates first, because the index cannot be built over them.
--
-- Nothing in the product has ever written this table -- no handler, no screen,
-- no import referenced it before this migration -- so a duplicate here can only
-- have come from a manual load. The newest row per (institution, campus, date)
-- survives; the older ones are removed. A DELETE in a migration is not
-- something to do casually, which is why the condition is this narrow.
-- FORCE ROW LEVEL SECURITY is lifted for the length of the delete and put
-- back immediately. Without that this statement deletes nothing: the migration
-- runs as the table's owner with no app.institution_id set, so every row is
-- invisible to it, while CREATE UNIQUE INDEX below reads the heap directly and
-- fails on the duplicates the DELETE could not see. That failure is how this
-- was found, and it is the sort of thing that only shows up on a database that
-- actually has rows in it.
-- +goose StatementBegin
DO $$
BEGIN
    ALTER TABLE mdm_registers NO FORCE ROW LEVEL SECURITY;
    DELETE FROM mdm_registers m
     WHERE EXISTS (
         SELECT 1 FROM mdm_registers k
          WHERE k.institution_id = m.institution_id
            AND COALESCE(k.campus_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE(m.campus_id, '00000000-0000-0000-0000-000000000000'::uuid)
            AND k.on_date = m.on_date
            AND (k.created_at, k.id) > (m.created_at, m.id));
    ALTER TABLE mdm_registers FORCE ROW LEVEL SECURITY;
END $$;
-- +goose StatementEnd

-- The constraint name Postgres generated for the inline UNIQUE in 00008. Named
-- defensively: a database restored from a dump taken before this migration may
-- carry it under the same generated name, and a school that never ran 00008's
-- table creation has nothing to drop.
ALTER TABLE mdm_registers
    DROP CONSTRAINT IF EXISTS mdm_registers_institution_id_campus_id_on_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS mdm_registers_one_per_day
    ON mdm_registers (
        institution_id,
        COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid),
        on_date);

-- ========================================= 1b. what a register day must hold

/* The register is a legal record, and 00008 gave it only the countable half.

   An inspector reading a mid-day meal register asks four things the columns
   above cannot answer: who cooked, why no meal was served on the days that
   have none, whether the day has been closed, and -- if a closed day was
   changed afterwards -- who changed it and why. The last is the whole reason
   the amendment table below exists. */

ALTER TABLE mdm_registers
    -- The cook-cum-helper on duty. A name, not a foreign key: a cook is very
    -- often not on the staff roll, and a register that could only name an
    -- employee would be left blank in the schools that most need it.
    ADD COLUMN IF NOT EXISTS cook_name text,
    -- Why nothing was served. A zero-meal day with no reason is the row an
    -- inspection stops on, so the API refuses to close one.
    ADD COLUMN IF NOT EXISTS not_served_reason text,
    ADD COLUMN IF NOT EXISTS menu_note text,
    -- open: still today's working sheet, editable freely.
    -- closed: the record as filed. Editable only through an amendment, which
    -- reopens it and leaves a row behind.
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open',
    ADD COLUMN IF NOT EXISTS closed_at timestamptz,
    ADD COLUMN IF NOT EXISTS closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- +goose StatementBegin
DO $$
BEGIN
    -- ADD CONSTRAINT has no IF NOT EXISTS, so each is guarded by name.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mdm_registers_status') THEN
        ALTER TABLE mdm_registers ADD CONSTRAINT mdm_registers_status
            CHECK (status = ANY (ARRAY['open', 'closed']));
    END IF;
    -- A closed day has a name and a moment against it, and an open one has
    -- neither. Both halves matter: the first is the audit trail, the second
    -- stops a reopened day from still looking signed off.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mdm_registers_closed_is_stamped') THEN
        ALTER TABLE mdm_registers ADD CONSTRAINT mdm_registers_closed_is_stamped
            CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL));
    END IF;
END $$;
-- +goose StatementEnd

CREATE INDEX IF NOT EXISTS mdm_registers_by_date
    ON mdm_registers (institution_id, on_date DESC);

COMMENT ON TABLE mdm_registers IS
    'One day of the cooked-meal register: children present, meals served, foodgrain and cooking cost, the cook on duty, and why no meal was served. Closed days are amended through mdm_register_amendments, never edited silently.';

-- ============================================== 1c. the day, broken by class

/* Meals served, by section.

   Optional, and deliberately so. A small school counts once at the kitchen
   door and the header row is the whole truth; a school with thirty sections
   is asked by the block office for the primary/upper-primary split and cannot
   produce it from one number. Both are the same register.

   The header stays the figure of record -- the utilisation return in
   admin_ops.go sums mdm_registers and knows nothing about this table -- and
   the API recomputes the header from the lines whenever lines are supplied,
   so the two cannot drift. */
CREATE TABLE IF NOT EXISTS mdm_register_lines (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    register_id    uuid NOT NULL REFERENCES mdm_registers(id) ON DELETE CASCADE,
    section_id     uuid NOT NULL REFERENCES sections(id) ON DELETE CASCADE,

    present      integer NOT NULL DEFAULT 0,
    meals_served integer NOT NULL DEFAULT 0,

    CONSTRAINT mdm_register_lines_counts
        CHECK (present >= 0 AND meals_served >= 0),
    -- The check the block office actually runs, stated per line so it cannot
    -- be hidden by a total that happens to balance.
    CONSTRAINT mdm_register_lines_not_more_meals_than_children
        CHECK (meals_served <= present)
);

-- section_id is NOT NULL, so this key is honest as written.
CREATE UNIQUE INDEX IF NOT EXISTS mdm_register_lines_one_per_section
    ON mdm_register_lines (register_id, section_id);

COMMENT ON TABLE mdm_register_lines IS
    'One section''s share of a register day. Optional; when present the register header is recomputed from these so the two can never disagree.';

-- ================================================ 1d. amending a closed day

/* What changed on a day that was already closed, and why.

   The reason the register can be trusted. Without this table the only way to
   correct a filed day is to overwrite it, and an overwritten register is one
   an inspector cannot audit and a head teacher cannot defend -- the figures
   simply differ from the ones sent to the block office, with nothing to say
   when or by whom.

   before/after are the whole row as jsonb rather than a column-per-field: the
   set of amendable fields will grow, and a trail that has to be migrated every
   time a column is added is a trail that eventually stops being written. */
CREATE TABLE IF NOT EXISTS mdm_register_amendments (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    register_id    uuid NOT NULL REFERENCES mdm_registers(id) ON DELETE CASCADE,

    -- reopen: the day was unlocked for correction.
    -- amend:  the corrected figures were saved.
    action  text NOT NULL,
    reason  text NOT NULL,
    before  jsonb,
    after   jsonb,

    amended_by uuid REFERENCES users(id) ON DELETE SET NULL,
    amended_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mdm_register_amendments_action
        CHECK (action = ANY (ARRAY['reopen', 'amend'])),
    -- An amendment with no reason is the amendment nobody can explain later.
    CONSTRAINT mdm_register_amendments_reason_said
        CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS mdm_register_amendments_by_register
    ON mdm_register_amendments (register_id, amended_at DESC);

COMMENT ON TABLE mdm_register_amendments IS
    'Every change made to a mid-day meal register day after it was closed: what it said, what it says now, who changed it and why.';

-- ========================================== 2. a hand-edited timetable draft

/* A draft the generator produced and a human then moved periods around in.

   00050 assumed a draft was exactly what the solver returned, and its summary
   columns are documented as describing the run. That stays true -- these three
   columns record the editing as a separate fact rather than rewriting the run
   -- but a reviewer about to publish needs to know the grid in front of them
   is no longer purely what was generated. */
ALTER TABLE timetable_drafts
    ADD COLUMN IF NOT EXISTS hand_edits     integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_edited_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_edited_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- ======================================================== row level security

ALTER TABLE mdm_register_lines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mdm_register_lines      FORCE  ROW LEVEL SECURITY;
ALTER TABLE mdm_register_amendments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mdm_register_amendments FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mdm_register_lines_tenant ON mdm_register_lines;
CREATE POLICY mdm_register_lines_tenant ON mdm_register_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

DROP POLICY IF EXISTS mdm_register_amendments_tenant ON mdm_register_amendments;
CREATE POLICY mdm_register_amendments_tenant ON mdm_register_amendments
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- 00042 sets ALTER DEFAULT PRIVILEGES so tables created after it are covered
-- whichever role creates them. Stated anyway, as 00046 and 00050 both do: a
-- database restored from a dump taken before that migration has the default
-- privileges but not necessarily the creating role.
GRANT SELECT, INSERT, UPDATE, DELETE ON mdm_register_lines      TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON mdm_register_amendments TO app_user;

-- +goose Down
ALTER TABLE timetable_drafts DROP COLUMN IF EXISTS last_edited_by;
ALTER TABLE timetable_drafts DROP COLUMN IF EXISTS last_edited_at;
ALTER TABLE timetable_drafts DROP COLUMN IF EXISTS hand_edits;

DROP TABLE IF EXISTS mdm_register_amendments;
DROP TABLE IF EXISTS mdm_register_lines;

ALTER TABLE mdm_registers DROP CONSTRAINT IF EXISTS mdm_registers_closed_is_stamped;
ALTER TABLE mdm_registers DROP CONSTRAINT IF EXISTS mdm_registers_status;
ALTER TABLE mdm_registers
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS closed_by,
    DROP COLUMN IF EXISTS closed_at,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS menu_note,
    DROP COLUMN IF EXISTS not_served_reason,
    DROP COLUMN IF EXISTS cook_name;

DROP INDEX IF EXISTS mdm_registers_by_date;
DROP INDEX IF EXISTS mdm_registers_one_per_day;
-- Restored as it was in 00008, nullable campus_id and all: a Down that leaves
-- a stricter constraint than the migration found is not a Down.
ALTER TABLE mdm_registers
    ADD CONSTRAINT mdm_registers_institution_id_campus_id_on_date_key
        UNIQUE (institution_id, campus_id, on_date);
