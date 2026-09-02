-- +goose Up
-- Primary does not run to the same bell as the seniors.
--
-- bell_schedules and periods.bell_schedule_id have existed since the baseline
-- and no code has ever referenced either: every school got one unnamed
-- "Standard day", and every class in it ran to the same periods. That is not
-- how a school with a primary section works. The little ones start later,
-- finish earlier, and take a longer lunch, and a timetable that insists Grade
-- 1 changes lesson at 11:30 with Grade 10 is a timetable the primary staff
-- ignore -- at which point attendance is marked against periods nobody sat.
--
-- A class points at a schedule; a section may override its class for the case
-- schools actually have, which is one section on a different shift rather than
-- a whole grade. Null at both levels means the school's default, so nothing
-- changes for a school that runs one bell.
ALTER TABLE classes  ADD COLUMN IF NOT EXISTS bell_schedule_id uuid
    REFERENCES bell_schedules(id) ON DELETE SET NULL;
ALTER TABLE sections ADD COLUMN IF NOT EXISTS bell_schedule_id uuid
    REFERENCES bell_schedules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS classes_bell_idx  ON classes  (bell_schedule_id);
CREATE INDEX IF NOT EXISTS sections_bell_idx ON sections (bell_schedule_id);

-- Every school has exactly one schedule today and its periods point at it, so
-- there is nothing to migrate. What follows only guarantees the fallback is
-- real: a school whose periods were written before bell_schedules existed has
-- them hanging off no schedule at all, and "the default schedule's periods"
-- would then be empty for everybody.
-- +goose StatementBegin
DO $$
DECLARE inst uuid; sched uuid;
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);
    FOR inst IN SELECT id FROM institutions LOOP
        SELECT id INTO sched FROM bell_schedules
         WHERE institution_id = inst ORDER BY is_default DESC, created_at LIMIT 1;

        IF sched IS NULL THEN
            INSERT INTO bell_schedules (institution_id, campus_id, name, is_default)
            SELECT inst, (SELECT id FROM campuses WHERE institution_id = inst LIMIT 1),
                   'Standard day', true
            RETURNING id INTO sched;
        ELSE
            -- One default, so "the school's own bell" is never ambiguous.
            UPDATE bell_schedules SET is_default = (id = sched)
             WHERE institution_id = inst;
        END IF;

        UPDATE periods SET bell_schedule_id = sched
         WHERE institution_id = inst AND bell_schedule_id IS NULL;
    END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
ALTER TABLE classes  DROP COLUMN IF EXISTS bell_schedule_id;
ALTER TABLE sections DROP COLUMN IF EXISTS bell_schedule_id;
