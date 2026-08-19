-- +goose Up
-- A lesson plan that is a document.
--
-- lesson_plans has four prose columns — objectives, activities, resources,
-- homework — and teachers do not write lesson plans into four boxes. They
-- write them in Word, or on a school proforma, or on the state's template, and
-- what they wanted was somewhere to put that file. Until now the honest answer
-- was to paste a link, and only if the school had somewhere to host one.
--
-- The prose columns stay and are not deprecated: the weekly grid reads them,
-- and a head of department reviewing twenty plans wants the objectives on
-- screen rather than twenty attachments to open. The file is the plan as the
-- teacher actually wrote it, and the columns are the summary of it.

ALTER TABLE lesson_plans
    ADD COLUMN IF NOT EXISTS file_id uuid REFERENCES files(id) ON DELETE SET NULL;

-- Which day of the week this is taught, where the school runs a plan per
-- lesson rather than per week. Null means the plan covers the whole week,
-- which is what every existing row means and why the column is nullable
-- rather than defaulted: a default would assert that every plan already
-- written was for a Monday.
ALTER TABLE lesson_plans
    ADD COLUMN IF NOT EXISTS teaching_day smallint;

ALTER TABLE lesson_plans
    DROP CONSTRAINT IF EXISTS lesson_plans_teaching_day_check;
ALTER TABLE lesson_plans
    ADD CONSTRAINT lesson_plans_teaching_day_check
    CHECK (teaching_day IS NULL OR teaching_day BETWEEN 1 AND 7);

-- +goose Down
ALTER TABLE lesson_plans DROP COLUMN IF EXISTS file_id;
ALTER TABLE lesson_plans DROP COLUMN IF EXISTS teaching_day;
