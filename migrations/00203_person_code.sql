-- +goose Up
-- The app's own identifier for a person, alongside the school's.
--
-- A school's admission number is theirs: 2026-27/00001 at one, ADM0001 at the
-- next, "VII-B-14" at a third, and at a fourth the same number reissued when a
-- child leaves. Staff often have no number at all. So the value a school types
-- is not a value this product can rely on to mean one person forever, and an
-- import that arrives with a column nobody recognised has nothing stable to
-- hang the row on.
--
-- Every person now gets a code this app owns and never changes: six digits
-- behind a letter that says what kind of person it is. It is not a replacement
-- for the admission number, which stays exactly as the school wrote it and
-- goes on every certificate. It is what the app points at internally, what an
-- import can be re-run against without creating duplicates, and what somebody
-- at a counter can read out when the school's own number is ambiguous.
--
-- Digits after the prefix because they are typed on a phone, and six of them
-- for the same reason the bus sticker and the staff PIN are six.
ALTER TABLE students  ADD COLUMN IF NOT EXISTS person_code text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS person_code text;

SELECT set_config('app.is_platform_admin', 'on', true);

-- +goose StatementBegin
DO $$
DECLARE
  r record;
  candidate text;
BEGIN
  FOR r IN SELECT id, institution_id FROM students WHERE person_code IS NULL LOOP
    LOOP
      candidate := 'S' || lpad((floor(random() * 1000000))::int::text, 6, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM students
         WHERE institution_id = r.institution_id AND person_code = candidate);
    END LOOP;
    UPDATE students SET person_code = candidate WHERE id = r.id;
  END LOOP;

  FOR r IN SELECT id, institution_id FROM employees WHERE person_code IS NULL LOOP
    LOOP
      candidate := 'E' || lpad((floor(random() * 1000000))::int::text, 6, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM employees
         WHERE institution_id = r.institution_id AND person_code = candidate);
    END LOOP;
    UPDATE employees SET person_code = candidate WHERE id = r.id;
  END LOOP;
END $$;
-- +goose StatementEnd

/* ASSIGNED BY THE DATABASE, not by whichever writer created the row.

   There are nine paths that create a student and five that create a member of
   staff -- the importer, the admission form, the hire form, the demo seeder,
   the setup wizard -- and a rule enforced in nine places is a rule that holds
   in eight. A trigger is the one place that cannot be gone round: an import
   written next year gets codes without knowing this column exists.

   Retried until the index is satisfied. A collision is one draw in a million
   per person and the loop is what makes that a non-event rather than a failed
   import at row four hundred. */
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.assign_person_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  candidate text;
  prefix text := CASE TG_TABLE_NAME WHEN 'students' THEN 'S' ELSE 'E' END;
BEGIN
  IF NEW.person_code IS NOT NULL AND NEW.person_code <> '' THEN
    RETURN NEW;
  END IF;
  LOOP
    candidate := prefix || lpad((floor(random() * 1000000))::int::text, 6, '0');
    IF TG_TABLE_NAME = 'students' THEN
      EXIT WHEN NOT EXISTS (SELECT 1 FROM students
                             WHERE institution_id = NEW.institution_id
                               AND person_code = candidate);
    ELSE
      EXIT WHEN NOT EXISTS (SELECT 1 FROM employees
                             WHERE institution_id = NEW.institution_id
                               AND person_code = candidate);
    END IF;
  END LOOP;
  NEW.person_code := candidate;
  RETURN NEW;
END $$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS students_person_code ON students;
CREATE TRIGGER students_person_code BEFORE INSERT ON students
  FOR EACH ROW EXECUTE FUNCTION public.assign_person_code();

DROP TRIGGER IF EXISTS employees_person_code ON employees;
CREATE TRIGGER employees_person_code BEFORE INSERT ON employees
  FOR EACH ROW EXECUTE FUNCTION public.assign_person_code();

-- Unique per school. Two schools on one installation may each hold S123456 and
-- neither will ever see the other's.
CREATE UNIQUE INDEX IF NOT EXISTS students_institution_person_code
  ON students (institution_id, person_code) WHERE person_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS employees_institution_person_code
  ON employees (institution_id, person_code) WHERE person_code IS NOT NULL;

COMMENT ON COLUMN students.person_code IS
  'This app''s own permanent identifier for the child, independent of whatever '
  'the school uses as an admission number. Never reissued, never edited.';
COMMENT ON COLUMN employees.person_code IS
  'This app''s own permanent identifier for the member of staff.';

-- +goose Down
DROP TRIGGER IF EXISTS students_person_code ON students;
DROP TRIGGER IF EXISTS employees_person_code ON employees;
DROP FUNCTION IF EXISTS public.assign_person_code();
DROP INDEX IF EXISTS students_institution_person_code;
DROP INDEX IF EXISTS employees_institution_person_code;
ALTER TABLE students  DROP COLUMN IF EXISTS person_code;
ALTER TABLE employees DROP COLUMN IF EXISTS person_code;
