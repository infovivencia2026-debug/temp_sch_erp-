-- +goose Up
-- THE DIGITAL LIBRARY'S AUDIENCE AND ITS READERS.
--
-- study_materials could be shared with a section or with a subject's class,
-- and a row with neither was read as the whole school's. Teachers asked for
-- the third width of audience a message has always had: these five children,
-- by name, for a remedial worksheet or a certificate that is one family's
-- business and not the class's. And for the other half of sharing a picture
-- the way a phone shares one: knowing who has opened it.
--
-- audience says which arm a row belongs to, so a targeted row is never
-- mistaken for a school-wide one by the feed. expires_at lets a teacher post
-- something for a day or a week, the way a status disappears; NULL is the
-- library's default of "until withdrawn".

ALTER TABLE study_materials
    ADD COLUMN audience   text NOT NULL DEFAULT 'class'
        CHECK (audience IN ('class', 'school', 'students')),
    ADD COLUMN expires_at timestamptz;

-- Who a 'students' row is for. One row per child; the material cascades.
CREATE TABLE study_material_targets (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    material_id    uuid NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
    student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (material_id, student_id)
);
CREATE INDEX study_material_targets_student ON study_material_targets (student_id);

ALTER TABLE study_material_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_material_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY study_material_targets_tenant ON study_material_targets
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON study_material_targets TO app_user;

-- Who has opened what. One row per reader per material, first opening kept:
-- "seen" is a fact about the first time, and a second opening is not news.
-- student_id names the child a guardian was reading as, for the teacher's
-- "seen by" list; a student reading their own is both.
CREATE TABLE study_material_views (
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    material_id    uuid NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    student_id     uuid REFERENCES students(id) ON DELETE SET NULL,
    viewed_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (material_id, user_id)
);

ALTER TABLE study_material_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_material_views FORCE ROW LEVEL SECURITY;
CREATE POLICY study_material_views_tenant ON study_material_views
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON study_material_views TO app_user;

-- +goose Down
DROP TABLE IF EXISTS study_material_views;
DROP TABLE IF EXISTS study_material_targets;
ALTER TABLE study_materials
    DROP COLUMN IF EXISTS expires_at,
    DROP COLUMN IF EXISTS audience;
