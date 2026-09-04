-- +goose Up
-- The hours a member of staff is expected to keep.
--
-- staff_attendance records check_in and check_out and compares them to
-- nothing. So nobody can be late, a half day has no meaning, and payroll has
-- no basis on which to deduct: the times are collected daily and used for
-- nothing at all.
--
-- And one set of hours would not do even if there were one. A school's
-- teaching staff, its office and its drivers do not start at the same time --
-- the bus leaves before the gate opens and the office closes after the last
-- child has gone -- so the pattern is named, defined by the school, and
-- assigned.
--
-- Resolved most specific first: the person's own, then their department's,
-- then the school's default. A driver on his own hours needs no new category
-- invented for him.
CREATE TABLE IF NOT EXISTS work_patterns (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    name           text NOT NULL,

    starts_at      time NOT NULL,
    ends_at        time NOT NULL,

    -- Late after this many minutes. A school that does not count lateness at
    -- all sets it high rather than being forced into a policy it does not have.
    grace_minutes  integer NOT NULL DEFAULT 10,

    -- What counts as a full day and what counts as a half. Hours rather than a
    -- clock time, because somebody who came in late and stayed late worked the
    -- day, and a rule written in clock times says they did not.
    full_day_minutes integer NOT NULL DEFAULT 420,
    half_day_minutes integer NOT NULL DEFAULT 210,

    /* Which days this pattern runs. ISO: 1 is Monday.
    
       An array rather than seven columns, because a school with alternate
       Saturdays has a rule that seven booleans cannot hold, and the ones that
       work every Saturday should not carry six unused columns for the ones
       that do not. */
    working_days   integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6],

    /* HOW THE SCHOOL CUTS PAY, in the school's own terms.

       A flat rupee figure per day is one rule and not the common one. Most
       schools divide the monthly salary -- by thirty, or by the days they
       actually expected -- and some deduct nothing at all for permanent staff.
       Writing only the flat amount would have made every school describe its
       policy as a number it does not use.

         none     absence is recorded and never costs anything
         fixed    lop_per_day_paise, the same for everyone on this pattern
         salary   the person's own monthly pay divided by salary_divisor,
                  so one rule covers a school where everybody earns
                  differently

       Thirty is the default divisor because that is what most Indian schools
       write in a contract, but a school that divides by the days it actually
       expected sets it to zero and gets that instead. */
    lop_basis      text NOT NULL DEFAULT 'none'
                   CHECK (lop_basis IN ('none','fixed','salary')),
    lop_per_day_paise bigint,
    salary_divisor integer NOT NULL DEFAULT 30,

    /* Lateness that turns into money.

       "Three lates make a half day" is a rule half the schools in the country
       keep and none of them could express here. Zero means lateness is
       reported and never deducted, which is the other half. */
    lates_for_half_day integer NOT NULL DEFAULT 0,

    is_default     boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (institution_id, name)
);

-- Assigned at either level. Null at both means the school's default, so a
-- school that keeps one set of hours never sees any of this.
ALTER TABLE employees   ADD COLUMN IF NOT EXISTS work_pattern_id uuid
    REFERENCES work_patterns(id) ON DELETE SET NULL;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS work_pattern_id uuid
    REFERENCES work_patterns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS work_patterns_institution_idx ON work_patterns (institution_id);
CREATE INDEX IF NOT EXISTS employees_work_pattern_idx    ON employees (work_pattern_id);

ALTER TABLE work_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_patterns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_patterns
    USING (institution_id = current_setting('app.institution_id', true)::uuid);

-- A first pattern per school, from the school day it already keeps, so the
-- feature has a sensible answer on the day it appears rather than an empty
-- screen. Named for what it is; a school renames it or adds others.
-- +goose StatementBegin
DO $$
DECLARE inst uuid; opens time; closes time;
BEGIN
    FOR inst IN SELECT id FROM institutions LOOP
        -- FORCE ROW LEVEL SECURITY applies to this block too, and the policy
        -- on work_patterns knows only app.institution_id -- there is no
        -- platform-admin escape in it. So the seed becomes each school in
        -- turn rather than one privileged pass over all of them.
        PERFORM set_config('app.institution_id', inst::text, true);
        SELECT min(starts_at), max(ends_at) INTO opens, closes
          FROM periods WHERE institution_id = inst;

        INSERT INTO work_patterns (institution_id, name, starts_at, ends_at, is_default)
        VALUES (inst, 'School hours',
                COALESCE(opens, TIME '09:00') - INTERVAL '30 minutes',
                COALESCE(closes, TIME '15:30') + INTERVAL '15 minutes',
                true)
        ON CONFLICT (institution_id, name) DO NOTHING;
    END LOOP;
    -- Left set, it would follow this transaction into whatever migration runs
    -- next and scope it to the last school in the list.
    PERFORM set_config('app.institution_id', '', true);
END $$;
-- +goose StatementEnd

-- +goose Down
ALTER TABLE employees   DROP COLUMN IF EXISTS work_pattern_id;
ALTER TABLE departments DROP COLUMN IF EXISTS work_pattern_id;
DROP TABLE IF EXISTS work_patterns;
