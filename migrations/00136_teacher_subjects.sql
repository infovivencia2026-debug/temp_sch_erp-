-- +goose Up
-- Which subjects a teacher teaches, as a fact about the teacher.
--
-- The only existing link between a person and a subject is
-- section_subject_teachers, which is a fact about one section: "Priya takes
-- 6-B maths". There was nowhere to record "Priya is a maths teacher", and the
-- two are not the same thing — the first is this term's timetable, the second
-- is why she was appointed and survives every timetable she is ever on.
--
-- Two things depended on the missing fact and did the wrong thing without it.
-- The subject-teacher dropdown offered every member of staff for every
-- subject, so the Telugu row listed the accountant. And the staff import had
-- no column for it, so a school that knows exactly who teaches what had to
-- throw that away and rebuild it section by section afterwards.
--
-- Deliberately not a constraint on assignment. A school short of a physics
-- teacher puts the chemistry teacher in front of the class in June, and a
-- system that refuses is a system they route around. This narrows what is
-- offered first; it does not forbid the rest.

CREATE TABLE IF NOT EXISTS teacher_subjects (
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
    subject_id     uuid NOT NULL REFERENCES subjects(id)     ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, subject_id)
);

CREATE INDEX IF NOT EXISTS teacher_subjects_subject
    ON teacher_subjects (institution_id, subject_id);

ALTER TABLE teacher_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_subjects FORCE ROW LEVEL SECURITY;

CREATE POLICY teacher_subjects_tenant ON teacher_subjects
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- Backfill from what the timetable already knows. A school that has been
-- running for a term has the answer sitting in section_subject_teachers, and
-- asking them to type it again would be asking them for something they have
-- already told us.
-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd

INSERT INTO teacher_subjects (institution_id, user_id, subject_id)
SELECT DISTINCT sst.institution_id, sst.teacher_user_id, cs.subject_id
  FROM section_subject_teachers sst
  JOIN class_subjects cs ON cs.id = sst.class_subject_id
ON CONFLICT DO NOTHING;

-- +goose Down
DROP TABLE IF EXISTS teacher_subjects;
