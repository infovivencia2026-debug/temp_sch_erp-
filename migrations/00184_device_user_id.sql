-- +goose Up

-- Which number the fingerprint reader knows somebody by.
--
-- staff_number is ours: assigned in employee_code order, four digits, unique
-- inside the school. The reader has its own idea, because a ZK device stores a
-- numeric user id per enrolled finger and that id was decided by whoever stood
-- at the machine enrolling people — often long before this product existed.
--
-- The two are the same number only if somebody makes them the same, and the
-- best way to make them the same is to enrol using staff_number. That is what
-- this column defaults to, and a school starting from an empty reader never
-- has to think about it again: one namespace, nothing to keep in sync,
-- nothing to drift.
--
-- The column exists for the other school — the one whose reader already holds
-- four hundred fingers against ids nobody wants to re-enrol. There, the device
-- id is what it is and this records it, so a punch arriving as user 217 can be
-- resolved to a member of staff without renumbering anybody.
--
-- Kept separate from staff_number rather than overloading it, because they
-- answer different questions: one is who this is to us, the other is who this
-- is to that machine. A school with two readers that disagree is a real thing,
-- and the honest fix is a mapping, not a pretence that the numbers match.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS device_user_id integer;

ALTER TABLE employees ADD CONSTRAINT employees_device_user_id_positive
    CHECK (device_user_id IS NULL OR device_user_id > 0);

-- Unique inside a school: two people cannot be the same finger.
CREATE UNIQUE INDEX IF NOT EXISTS employees_device_user_id_per_institution
    ON employees (institution_id, device_user_id)
    WHERE device_user_id IS NOT NULL;

-- Default to our own number, which is the answer for any school enrolling from
-- scratch. Platform admin because employees is FORCE ROW LEVEL SECURITY and a
-- migration carries no institution.
SET LOCAL app.is_platform_admin = 'on';

UPDATE employees
   SET device_user_id = staff_number
 WHERE device_user_id IS NULL AND staff_number IS NOT NULL;

-- +goose Down

DROP INDEX IF EXISTS employees_device_user_id_per_institution;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_device_user_id_positive;
ALTER TABLE employees DROP COLUMN IF EXISTS device_user_id;
