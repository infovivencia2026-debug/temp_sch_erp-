-- +goose Up
-- A circular that reaches everybody.
--
-- The audience list allowed 'all', which means the families — parents and
-- students — and 'staff', which the compose screen never offered. There was no
-- value for the whole school at once, so "we are closed on Monday" had to be
-- published twice and the two copies then drifted: edited in one place,
-- acknowledged in the other, and counted separately in every report.
--
-- 'all' is left meaning what it has always meant. Renaming it would silently
-- change the audience of every circular already sent, which is the one thing a
-- record of what was announced must never do.
--
-- 'faculty' stays in the list. Nothing writes it today, but rows may carry it,
-- and dropping a value a row might hold turns this migration into a failure at
-- exactly the moment it is least welcome.

ALTER TABLE announcements
    DROP CONSTRAINT IF EXISTS announcements_audience_role_check;

ALTER TABLE announcements
    ADD CONSTRAINT announcements_audience_role_check
    CHECK (audience_role = ANY (ARRAY[
        'all'::text,       -- parents and students
        'parents'::text,
        'students'::text,
        'staff'::text,
        'faculty'::text,   -- historic; kept so existing rows stay valid
        'everyone'::text   -- families and staff together
    ]));

-- +goose Down
ALTER TABLE announcements
    DROP CONSTRAINT IF EXISTS announcements_audience_role_check;

-- Anything already addressed to everybody becomes a families circular rather
-- than failing the constraint on the way down. Narrowing is the safe
-- direction: it under-states who was told, and never over-states it.
UPDATE announcements SET audience_role = 'all' WHERE audience_role = 'everyone';

ALTER TABLE announcements
    ADD CONSTRAINT announcements_audience_role_check
    CHECK (audience_role = ANY (ARRAY[
        'all'::text, 'students'::text, 'parents'::text, 'staff'::text, 'faculty'::text
    ]));
