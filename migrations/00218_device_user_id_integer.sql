-- +goose Up

-- Put employees.device_user_id back to the integer it was declared as.
--
-- 00184 added this column as integer, with a positive check and a per-school
-- unique index, and every reader of it agrees: biometric_punches.device_user_id
-- is integer, the enrol lookup compares the two as integers, and the employee
-- editor writes it as *int. On this installation the column had drifted to
-- text -- altered by hand, not by any migration -- and rebuilt around that
-- text: a functional unique index on upper(btrim(device_user_id)) and a
-- _present check on btrim(device_user_id) <> ''. The mismatch was not
-- cosmetic: scanning text into *int failed and GET /hr/employees answered 500,
-- so the whole HR staff list went dark over one column's type.
--
-- The text-shaped guards have to go before the cast, or the ALTER re-checks
-- btrim(device_user_id) against an integer and fails. Dropped first, then the
-- column is cast -- safe, every value it holds is already numeric -- then
-- 00184's own integer guards are put back.

-- The text-era guards, if this installation grew them.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_device_user_id_present;
DROP INDEX IF EXISTS employees_device_user_id_per_institution;

ALTER TABLE employees
    ALTER COLUMN device_user_id TYPE integer USING device_user_id::integer;

-- 00184's positive check, re-added only when absent.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'employees_device_user_id_positive'
    ) THEN
        ALTER TABLE employees ADD CONSTRAINT employees_device_user_id_positive
            CHECK (device_user_id IS NULL OR device_user_id > 0);
    END IF;
END $$;
-- +goose StatementEnd

-- 00184's per-school unique index, in its integer shape.
CREATE UNIQUE INDEX IF NOT EXISTS employees_device_user_id_per_institution
    ON employees (institution_id, device_user_id)
    WHERE device_user_id IS NOT NULL;

-- +goose Down

-- No down: text was never the intended type, and reverting to it would
-- re-break the HR list. A rollback that reintroduces the outage is not one.
SELECT 1;
