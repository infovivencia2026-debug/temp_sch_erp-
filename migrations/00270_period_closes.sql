-- +goose Up

-- The moment a school says "September is done".
--
-- Five freeze mechanisms already existed -- the accounting year, bank
-- reconciliation, MDM returns, regulatory filings, the service book -- and
-- not one of them touched the register, the fee counter, the payslip or the
-- mark sheet. An auditor asking to see last March could not be told it was
-- final, because it was not: any past month stayed editable until the
-- accounting year was signed, and the academic year never was.
--
-- One row per act of closing. A month is keyed 'YYYY-MM'; a year is keyed by
-- the academic_years id it seals. Reopening does not delete the row: the fact
-- that a month was closed, by whom, and then opened again is exactly what the
-- auditor wants to read, so the row keeps both halves and the guard reads
-- only rows whose reopened_at is still null.
--
-- via_year records a month closed as part of closing its year rather than on
-- its own, so reopening the year reopens what the year close shut and leaves
-- alone a month the principal had already closed by hand.
CREATE TABLE period_closes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,
    kind            text NOT NULL,
    period_key      text NOT NULL,
    via_year        uuid REFERENCES academic_years(id) ON DELETE SET NULL,
    closed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    closed_at       timestamptz NOT NULL DEFAULT now(),
    reopened_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    reopened_at     timestamptz,
    CONSTRAINT period_closes_kind CHECK (kind IN ('month', 'year')),
    CONSTRAINT period_closes_key  CHECK (
        (kind = 'month' AND period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
        OR (kind = 'year' AND length(period_key) = 36)),
    CONSTRAINT period_closes_reopen CHECK ((reopened_at IS NULL) = (reopened_by IS NULL))
);

-- One live close per period. The guard asks "is there a live row for this
-- month", so two of them would be a bookkeeping error rather than a stronger
-- lock.
CREATE UNIQUE INDEX period_closes_live ON period_closes (institution_id, kind, period_key)
    WHERE reopened_at IS NULL;

ALTER TABLE period_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_closes FORCE  ROW LEVEL SECURITY;
CREATE POLICY period_closes_tenant ON period_closes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON period_closes TO app_user;

-- The year's own seal, on the row every year-scoped table already joins to.
-- The period_closes row is the audit record; this column is what a query
-- that already has the year in hand reads without another join.
ALTER TABLE academic_years ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE academic_years ADD COLUMN IF NOT EXISTS closed_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- When the salary file left for the bank. A run whose figures have been
-- handed to a bank is a record of a transfer, and recomputing it -- which
-- deletes every payslip and writes new ones -- would leave the school's
-- books disagreeing with the bank's. The state machine's 'locked' was
-- supposed to stand in front of the bank file and did not: the file could
-- be drawn from a draft. This column is the fact itself.
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS bank_file_drawn_at timestamptz;

-- +goose Down

ALTER TABLE payroll_runs DROP COLUMN IF EXISTS bank_file_drawn_at;
ALTER TABLE academic_years DROP COLUMN IF EXISTS closed_by;
ALTER TABLE academic_years DROP COLUMN IF EXISTS closed_at;
DROP TABLE IF EXISTS period_closes;
