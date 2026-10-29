-- 0119_employee_school_email (tenant: every school database).
-- A member of staff's school (official) email beside their personal one
-- (owner, 2026-10-27). employees.email stays as it is: it is the personal
-- address, the one logins and messages already use. Nothing is moved.
--
-- Forward-only: once applied anywhere this file must not change.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

ALTER TABLE employees ADD COLUMN school_email TEXT COLLATE NOCASE;
