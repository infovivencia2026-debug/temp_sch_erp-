-- +goose Up
-- The seed in 00242 planted nothing.
--
-- institutions is itself under FORCE ROW LEVEL SECURITY, so the loop that was
-- meant to visit every school selected from it with no tenant set and visited
-- none. The migration reported success over an empty table, which is the same
-- silent shape as the backfill that once matched nought of twenty-one rows.
--
-- Two different privileges are needed and 00242 could only hold one at a time:
-- platform admin to see the list of schools at all, and each school's own
-- tenant to be allowed to insert its row. So the ids are read once under the
-- first and the rows written under the second.
-- +goose StatementBegin
DO $$
DECLARE ids uuid[]; inst uuid; opens time; closes time;
BEGIN
    PERFORM set_config('app.is_platform_admin', 'on', true);
    SELECT array_agg(id) INTO ids FROM institutions;

    FOREACH inst IN ARRAY COALESCE(ids, ARRAY[]::uuid[]) LOOP
        SELECT min(starts_at), max(ends_at) INTO opens, closes
          FROM periods WHERE institution_id = inst;

        -- The school day it already keeps, opened a little before the first
        -- bell and closed a little after the last, so the feature has a
        -- sensible answer on the day it appears rather than an empty screen.
        PERFORM set_config('app.institution_id', inst::text, true);
        INSERT INTO work_patterns (institution_id, name, starts_at, ends_at, is_default)
        VALUES (inst, 'School hours',
                COALESCE(opens, TIME '09:00') - INTERVAL '30 minutes',
                COALESCE(closes, TIME '15:30') + INTERVAL '15 minutes',
                true)
        ON CONFLICT (institution_id, name) DO NOTHING;
    END LOOP;

    -- Left set, either of these would follow this transaction into whatever
    -- migration runs next.
    PERFORM set_config('app.institution_id', '', true);
    PERFORM set_config('app.is_platform_admin', 'off', true);
END $$;
-- +goose StatementEnd

-- +goose Down
-- The rows go with the table in 00242's down.
SELECT 1;
