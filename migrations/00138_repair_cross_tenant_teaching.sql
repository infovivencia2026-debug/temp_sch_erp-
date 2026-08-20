-- +goose Up
-- Rows belonging to one school and pointing at another school's sections.
--
-- The bulk importers resolved "the class called Grade 6" and "the section
-- called B" with no institution predicate, relying entirely on row level
-- security to scope them. That is correct for an ordinary session and wrong
-- for the sessions that matter here: RLS is bypassed for a platform
-- administrator, and an operator acting inside a school is exactly such a
-- session. Run that way, "the class called Grade 6" means "the first Grade 6
-- on the installation", and the import writes one school's rows against
-- another school's sections.
--
-- The importers now name the institution in the SQL as well as relying on the
-- policy. This removes what they wrote before that.
--
-- Two symptoms, one cause:
--
--   section_subject_teachers rows whose institution_id is not the institution
--   that owns the section they point at. These are unreachable by the school
--   that owns the section — RLS hides them — while still occupying the unique
--   (section_id, class_subject_id) slot, so that school cannot assign a
--   teacher to that subject at all. It fails with a row level security error
--   naming a row it is not allowed to know exists.
--
--   teacher_subjects rows derived from them. 00136 backfilled "who teaches
--   what" from section_subject_teachers and inherited the same wrong owner.
--
-- Deleted rather than reassigned. Reassigning would guess which school meant
-- to make the assignment, and the answer is neither: the row records a
-- teacher from one school teaching a class in another, which no one intended
-- and no one can act on.

-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd

DELETE FROM teacher_subjects ts
 USING subjects s
 WHERE s.id = ts.subject_id
   AND ts.institution_id <> s.institution_id;

DELETE FROM section_subject_teachers t
 USING sections s
 WHERE s.id = t.section_id
   AND t.institution_id <> s.institution_id;

-- A teacher from one school cannot teach a section in another, and the same
-- goes for the subject the assignment is about. Enforced here so the next
-- careless query fails loudly at the point of insert rather than silently
-- becoming another eighty-four rows nobody can see.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION assert_teaching_row_is_one_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    section_inst uuid;
    subject_inst uuid;
BEGIN
    SELECT institution_id INTO section_inst FROM sections WHERE id = NEW.section_id;
    IF section_inst IS NOT NULL AND section_inst <> NEW.institution_id THEN
        RAISE EXCEPTION
            'section % belongs to a different institution than this assignment',
            NEW.section_id;
    END IF;
    SELECT institution_id INTO subject_inst FROM class_subjects WHERE id = NEW.class_subject_id;
    IF subject_inst IS NOT NULL AND subject_inst <> NEW.institution_id THEN
        RAISE EXCEPTION
            'class subject % belongs to a different institution than this assignment',
            NEW.class_subject_id;
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS section_subject_teachers_one_tenant ON section_subject_teachers;
CREATE TRIGGER section_subject_teachers_one_tenant
    BEFORE INSERT OR UPDATE ON section_subject_teachers
    FOR EACH ROW EXECUTE FUNCTION assert_teaching_row_is_one_tenant();

-- +goose Down
DROP TRIGGER IF EXISTS section_subject_teachers_one_tenant ON section_subject_teachers;
DROP FUNCTION IF EXISTS assert_teaching_row_is_one_tenant();
