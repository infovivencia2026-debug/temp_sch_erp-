-- +goose Up

-- A four-digit number every member of staff can be identified by.
--
-- employee_code is what a school already calls somebody on paper — T005, N022,
-- ADM/2019/14 — and it is the right thing to keep. It is the wrong thing to
-- sign in with and the wrong thing to enrol on a fingerprint reader. A ZK
-- device stores a numeric user id and nothing else; an employee code cannot be
-- pushed to it at all, which is why sixty-nine imported staff at this school
-- have no way onto the attendance device and no way into the product.
--
-- So: a small number, unique inside the school, that a person can remember and
-- a device can hold. Four digits is deliberate — it fits every biometric
-- reader's id field, it is short enough to type at a wall-mounted terminal,
-- and 1000..9999 is nine thousand staff, which is more than any single school
-- on this product will ever have.
--
-- It is a second identifier, not a replacement. employee_code keeps its
-- meaning on the service record and the payslip; this is what the reader and
-- the login screen use.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS staff_number integer;

ALTER TABLE employees ADD CONSTRAINT employees_staff_number_four_digits
    CHECK (staff_number IS NULL OR (staff_number BETWEEN 1000 AND 9999));

-- Unique inside a school, not globally: two schools on this deployment may
-- both have a 1001, and the reader at each only ever sees its own.
CREATE UNIQUE INDEX IF NOT EXISTS employees_staff_number_per_institution
    ON employees (institution_id, staff_number)
    WHERE staff_number IS NOT NULL;

-- Backfill in employee_code order, so the numbers line up with the roll a
-- school already has rather than with insertion order, which is arbitrary.
-- Platform admin because employees is FORCE ROW LEVEL SECURITY and a migration
-- carries no institution: migration 181 skipped its own UPDATE this way and
-- reported success.
SET LOCAL app.is_platform_admin = 'on';

WITH numbered AS (
    SELECT id,
           999 + row_number() OVER (PARTITION BY institution_id ORDER BY employee_code, id)
             AS n
      FROM employees
     WHERE staff_number IS NULL
)
UPDATE employees e SET staff_number = numbered.n
  FROM numbered
 WHERE e.id = numbered.id AND numbered.n <= 9999;

-- The number is a login identifier too, so a teacher signs in as 1042 rather
-- than as an employee code they have never been told. Only where the account
-- has no username of its own: one that was set deliberately is left alone.
UPDATE users u
   SET username = e.staff_number::text
  FROM employees e
 WHERE e.user_id = u.id
   AND e.staff_number IS NOT NULL
   AND (u.username IS NULL OR u.username = lower(e.employee_code));

-- +goose Down

DROP INDEX IF EXISTS employees_staff_number_per_institution;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_staff_number_four_digits;
ALTER TABLE employees DROP COLUMN IF EXISTS staff_number;
