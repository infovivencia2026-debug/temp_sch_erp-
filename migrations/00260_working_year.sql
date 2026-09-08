-- +goose Up

-- The academic year a person is working in, when it is not the current one.
--
-- academic_years_one_current admits one current year per campus, and that is
-- right: "current" is the year being taught, the one attendance and today's
-- meals are written against. But from November a school is also running next
-- year's admissions, drafting next year's sections, fee structure and
-- timetable, and every handler that resolved the year with WHERE is_current
-- answered those questions about the wrong year. Flipping the flag early was
-- the only workaround, and it moved fee collection and the register along
-- with it.
--
-- So the working year is a choice a person makes for themselves, kept here,
-- and read by handlers that a school uses across the year boundary. It is not
-- a school-wide setting: the admissions clerk works in 2027-28 while the
-- class teacher next to her marks 2026-27's register. No row means the
-- current year, which is what everybody sees today.
--
-- Keyed on user and institution rather than user alone: a platform operator
-- works inside several schools, and the year they chose for one must not
-- follow them into another.
CREATE TABLE user_working_years (
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    -- Cascade rather than restrict: deleting a year a few people had chosen
    -- must not be blocked by their preference, and with the row gone they
    -- fall back to the current year, which is the right answer.
    academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, institution_id)
);

CREATE INDEX user_working_years_year ON user_working_years (academic_year_id);

ALTER TABLE user_working_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_working_years FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_working_years_tenant ON user_working_years
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON user_working_years TO app_user;

-- +goose Down

DROP TABLE IF EXISTS user_working_years;
