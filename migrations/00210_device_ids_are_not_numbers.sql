-- +goose Up
-- A biometric reader's user id is a STRING, and ours could only hold a number.
--
-- The eSSL/ZKTeco reader on the school's own network enrols staff as T001,
-- N039, T045 -- a letter for the cadre and a number within it, which is how
-- every school that has ever used one of these labels its people. Both columns
-- here were `integer`, and the ADMS push parsed the field with strconv.Atoi and
-- `continue`d when it failed. So every punch from that reader was skipped
-- silently: the device uploaded, the server answered 200, and not one row
-- appeared. Registering the device would not have helped, because the id never
-- survived parsing.
--
-- text, not a wider integer. The id is an identifier and not a quantity: it is
-- never summed, never compared for magnitude, and a leading zero in T001 is
-- part of it rather than noise to be trimmed. Numbers-only readers keep
-- working, because every integer is also a string.
ALTER TABLE biometric_punches ALTER COLUMN device_user_id TYPE text USING device_user_id::text;
ALTER TABLE employees        ALTER COLUMN device_user_id TYPE text USING device_user_id::text;

-- Trimmed and case-folded on the way in, because a clerk typing t001 into the
-- staff record and a device sending T001 are naming the same person, and a
-- mapping that fails on case is a mapping nobody can debug from the screen.
CREATE INDEX IF NOT EXISTS employees_device_user_id
    ON employees (institution_id, upper(btrim(device_user_id)))
 WHERE device_user_id IS NOT NULL AND btrim(device_user_id) <> '';

-- +goose Down
DROP INDEX IF EXISTS employees_device_user_id;
ALTER TABLE employees        ALTER COLUMN device_user_id TYPE integer USING NULLIF(regexp_replace(device_user_id,'\D','','g'),'')::integer;
ALTER TABLE biometric_punches ALTER COLUMN device_user_id TYPE integer USING NULLIF(regexp_replace(device_user_id,'\D','','g'),'')::integer;
