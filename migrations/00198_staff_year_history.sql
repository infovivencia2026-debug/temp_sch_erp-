-- +goose Up
-- The same closed-year record, for the people who teach.
--
-- Split from 00197 rather than added to it, because 00197 was already applied.
-- goose parses only pending migrations, so an edit to an applied one is a file
-- that looks like it did something and never runs -- which is invisible here
-- and breaks only the next school to be provisioned.
--
-- A teacher of eleven years standing arrives with eleven years of service the
-- live tables cannot hold: their attendance is a total, not a register, and
-- writing invented days into the staff register would show them present on
-- dates the school can still be asked about.
--
-- A school reaches for exactly this when it writes an experience certificate,
-- settles seniority, or answers an inspector asking how long somebody has
-- taught a subject. Without it, an imported teacher has worked here since the
-- morning of the upload.
CREATE TABLE IF NOT EXISTS employee_year_history (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- The year as the school writes it. Not a foreign key: these are years
    -- that predate this system and have no row to point at.
    year_name      text NOT NULL,
    designation    text,
    days_present   integer,
    days_total     integer,
    leaves_taken   integer,
    notes          text,
    source         text NOT NULL DEFAULT 'import',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    -- One row per person per year, so a corrected re-upload edits a service
    -- record rather than doubling it.
    UNIQUE (employee_id, year_name)
);

CREATE INDEX IF NOT EXISTS employee_year_history_employee_idx
    ON employee_year_history (employee_id);

ALTER TABLE employee_year_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_year_history FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON employee_year_history
    USING (institution_id = current_setting('app.institution_id', true)::uuid);

-- +goose Down
DROP TABLE IF EXISTS employee_year_history;
