-- +goose Up

-- The days a child opened the app.
--
-- A streak is a count of consecutive days, and the only durable record of a
-- day is a row that says so. sessions would have done, except that a session
-- lasts weeks and a child who leaves the app signed in produces no new one --
-- their streak would read as a single day however often they came back. So
-- the streak endpoint writes today's row when it is read, and the sessions
-- table is unioned in only to backfill the days before this table existed.
--
-- One row per child per day, whatever the count of opens: a streak is about
-- showing up, not about how many times.
CREATE TABLE student_activity_days (
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id      uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    day             date NOT NULL,
    PRIMARY KEY (student_id, day)
);

CREATE INDEX student_activity_days_institution ON student_activity_days (institution_id);

ALTER TABLE student_activity_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_activity_days FORCE  ROW LEVEL SECURITY;
CREATE POLICY student_activity_days_tenant ON student_activity_days
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON student_activity_days TO app_user;

-- The school's hall of fame: the trophies in the cabinet and the names on the
-- board in the foyer.
--
-- Two kinds of entry share the board and only one lives here. A current
-- child's state or national placing is already a student_achievements row and
-- is read from there, so an office that records the award once does not have
-- to write it twice. What this table holds is what no achievement row can:
-- the 1994 cricket shield, the alumna who topped the state before the
-- product existed, the record nobody has beaten since. holder is free text for
-- exactly that reason -- most of the names on the board are not students any
-- more. student_id is kept where the holder is one, so the entry survives
-- them leaving without pointing at nobody.
CREATE TABLE hall_of_fame_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE SET NULL,
    category        text NOT NULL DEFAULT 'academic',
    title           text NOT NULL,
    holder          text NOT NULL,
    student_id      uuid REFERENCES students(id) ON DELETE SET NULL,
    year            integer,
    detail          text,
    added_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Taken down rather than deleted, so a record beaten this year is still a
    -- record that stood.
    retired_at      timestamptz,
    CONSTRAINT hall_of_fame_category CHECK (category IN ('academic', 'sports', 'arts', 'service', 'other')),
    CONSTRAINT hall_of_fame_title  CHECK (nullif(btrim(title), '') IS NOT NULL AND length(title) <= 160),
    CONSTRAINT hall_of_fame_holder CHECK (nullif(btrim(holder), '') IS NOT NULL AND length(holder) <= 160),
    CONSTRAINT hall_of_fame_detail CHECK (detail IS NULL OR length(detail) <= 1000),
    CONSTRAINT hall_of_fame_year   CHECK (year IS NULL OR year BETWEEN 1800 AND 2200)
);

CREATE INDEX hall_of_fame_entries_live ON hall_of_fame_entries (institution_id, category, year DESC)
    WHERE retired_at IS NULL;

ALTER TABLE hall_of_fame_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hall_of_fame_entries FORCE  ROW LEVEL SECURITY;
CREATE POLICY hall_of_fame_entries_tenant ON hall_of_fame_entries
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON hall_of_fame_entries TO app_user;

-- +goose Down

DROP TABLE IF EXISTS hall_of_fame_entries;
DROP TABLE IF EXISTS student_activity_days;
