-- +goose Up
-- Who rang the family, and what they said.
--
-- Marking a child absent already tells the household (see announceAbsences),
-- but a school still works the list by hand: the office rings round the
-- morning's absentees to find out why, and needs somewhere to write down that
-- they got through and what the parent said. This is that log — one row per
-- child per day, sitting alongside the register rather than inside it, so a
-- follow-up call never rewrites the attendance record itself.
CREATE TABLE student_absence_followup (
    institution_id uuid NOT NULL,
    student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    on_date        date NOT NULL,
    call_status    text NOT NULL DEFAULT 'not_called'
                   CHECK (call_status IN ('not_called','called','no_answer','reached')),
    parent_response text NOT NULL DEFAULT '',
    updated_by     uuid,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (student_id, on_date)
);
CREATE INDEX student_absence_followup_institution_id_idx
    ON student_absence_followup (institution_id);

ALTER TABLE student_absence_followup ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_absence_followup FORCE  ROW LEVEL SECURITY;
CREATE POLICY student_absence_followup_tenant ON student_absence_followup
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON student_absence_followup TO app_user;

-- +goose Down
DROP TABLE IF EXISTS student_absence_followup;
