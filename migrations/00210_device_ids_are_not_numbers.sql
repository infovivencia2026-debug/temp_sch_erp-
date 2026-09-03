-- +goose Up
-- A biometric reader's user id is a STRING, and ours could only hold a number.
--
-- The eSSL/ZKTeco reader on the school's own network enrols staff as T001,
-- N039, T045 -- a letter for the cadre and a number within it, which is how
-- every school that has ever used one of these labels its people. Both columns
-- were `integer`, and the ADMS push parsed the field with strconv.Atoi and
-- `continue`d when it failed. So every punch from that reader was skipped
-- silently: the device uploaded, the server answered 200, and not one row
-- appeared. Registering the device would not have helped, because the id never
-- survived parsing.
--
-- text, not a wider integer. The id is an identifier and not a quantity: never
-- summed, never compared for magnitude, and the leading zero in T001 is part
-- of it rather than noise. Numbers-only readers keep working, because every
-- integer is also a string.
--
-- THE CHECK HAS TO GO FIRST. `device_user_id > 0` is an integer comparison,
-- and Postgres re-checks every constraint against the NEW type: the first
-- attempt at this migration failed with "operator does not exist: text >
-- integer" and rolled back whole, which is the behaviour worth having. The
-- replacement says what the rule actually is now, which is that an id has to
-- be something rather than that it has to be positive.

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_device_user_id_positive;

ALTER TABLE biometric_punches ALTER COLUMN device_user_id TYPE text USING device_user_id::text;
ALTER TABLE employees         ALTER COLUMN device_user_id TYPE text USING device_user_id::text;

ALTER TABLE employees
    ADD CONSTRAINT employees_device_user_id_present
    CHECK (device_user_id IS NULL OR btrim(device_user_id) <> '');

-- Case and space folded, because a clerk typing t001 into a staff record and a
-- device sending T001 are naming one person, and a mapping that fails on case
-- is one nobody can debug from the screen. This replaces the plain unique
-- index, which would have let both spellings exist side by side.
DROP INDEX IF EXISTS employees_device_user_id_per_institution;
CREATE UNIQUE INDEX employees_device_user_id_per_institution
    ON employees (institution_id, upper(btrim(device_user_id)))
 WHERE device_user_id IS NOT NULL AND btrim(device_user_id) <> '';

-- +goose Down
DROP INDEX IF EXISTS employees_device_user_id_per_institution;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_device_user_id_present;
ALTER TABLE employees         ALTER COLUMN device_user_id TYPE integer USING NULLIF(regexp_replace(device_user_id,'\D','','g'),'')::integer;
ALTER TABLE biometric_punches ALTER COLUMN device_user_id TYPE integer USING NULLIF(regexp_replace(device_user_id,'\D','','g'),'')::integer;
ALTER TABLE employees
    ADD CONSTRAINT employees_device_user_id_positive
    CHECK (device_user_id IS NULL OR device_user_id > 0);
CREATE UNIQUE INDEX employees_device_user_id_per_institution
    ON employees (institution_id, device_user_id) WHERE device_user_id IS NOT NULL;
