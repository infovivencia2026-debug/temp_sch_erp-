-- +goose Up
-- What a school knows about the years before it had this system.
--
-- A roll imported mid-life carries three kinds of history, and only one of
-- them has anywhere to go.
--
-- Marks do: an exam is scoped to an academic year, so a past year's exam is an
-- ordinary exam and its marks are ordinary marks. Those are imported into the
-- real tables and a past report card renders from them like any other.
--
-- Attendance and fees do not, and must not be forced into the live ones.
--
--   Attendance is a row per child per day. A school hands over totals -- "187
--   of 210" -- not four years of registers, and there was no table that could
--   hold a total. Inventing 187 present days on invented dates would corrupt
--   every register the school ever prints for those dates.
--
--   Fees are worse. Writing historic receipts into payments would make money
--   collected in 2023 appear in this year's collection figures, in the daily
--   cash reconciliation and in the accountant's day book. The school would be
--   looking at a number it has to explain to an auditor.
--
-- So both are recorded as what they are: a summary of a closed year, held
-- apart from the live ledgers, readable on the child's page and on a transfer
-- certificate, and never counted as this year's activity.

CREATE TABLE IF NOT EXISTS student_year_history (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id       uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- The year as the school writes it. Not a foreign key: the whole point is
    -- years that predate this system, which have no row here to point at.
    year_name        text NOT NULL,
    class_name       text,
    -- Attendance as a fraction of the days the school actually ran.
    days_present     integer,
    days_total       integer,
    -- Money, in paise, for the year as a whole.
    fee_billed_paise  bigint,
    fee_paid_paise    bigint,
    fee_waived_paise  bigint,
    -- Whatever the school wants to keep that these columns do not name:
    -- a result, a remark, a house, a prize.
    notes            text,
    source           text NOT NULL DEFAULT 'import',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    -- One row per child per year, so a corrected re-upload edits rather than
    -- doubling a child's history.
    UNIQUE (student_id, year_name)
);

CREATE INDEX IF NOT EXISTS student_year_history_student_idx
    ON student_year_history (student_id);

ALTER TABLE student_year_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_year_history FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON student_year_history
    USING (institution_id = current_setting('app.institution_id', true)::uuid);

-- +goose Down
DROP TABLE IF EXISTS student_year_history;
