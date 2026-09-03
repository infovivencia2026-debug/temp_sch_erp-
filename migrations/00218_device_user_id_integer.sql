-- +goose Up

-- Put employees.device_user_id back to the integer it was declared as.
--
-- 00184 added this column as integer, with a positive check and a per-school
-- unique index, and every reader of it agrees: biometric_punches.device_user_id
-- is integer, the enrol lookup compares the two as integers, and the employee
-- editor writes it as *int. On this installation the column had drifted to
-- text -- altered by hand, not by any migration -- and the mismatch was not
-- cosmetic: scanning a text column into *int failed, and GET /hr/employees
-- answered 500. The whole HR staff list went dark over one column's type.
--
-- Safe as a plain cast: every value the column holds is already numeric. The
-- USING clause makes the intent explicit rather than leaning on an implicit
-- coercion Postgres would refuse anyway.
--
-- Defensive about the constraint and the index too: whoever retyped the column
-- may have dropped and recreated it, taking 00184's guards with it. Re-added
-- only when absent, so a database that kept them is left untouched.

ALTER TABLE employees
    ALTER COLUMN device_user_id TYPE integer USING device_user_id::integer;

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

CREATE UNIQUE INDEX IF NOT EXISTS employees_device_user_id_per_institution
    ON employees (institution_id, device_user_id)
    WHERE device_user_id IS NOT NULL;

-- +goose Down

-- No down: text was never the intended type, and reverting to it would
-- re-break the HR list. A rollback that reintroduces the outage is not one.
SELECT 1;
