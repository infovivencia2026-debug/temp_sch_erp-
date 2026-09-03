-- +goose Up

-- A short message from the office to whoever is driving a bus right now.
--
-- Addressed to the vehicle, not the person: the office is talking to "the
-- 14A bus" and the handset paired to it fetches this on its heartbeat, whoever
-- signed in this morning. acknowledged_at is the one-tap OK; it is what the
-- office watches, because a message that was delivered to a phone face-down
-- on the dashboard is not a message that was read.
CREATE TABLE driver_notices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    vehicle_id      uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    body            text NOT NULL,
    sent_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    sent_at         timestamptz NOT NULL DEFAULT now(),
    -- A notice nobody answered is not shown to tomorrow's driver.
    expires_at      timestamptz NOT NULL DEFAULT now() + interval '12 hours',
    acknowledged_at timestamptz,
    acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT driver_notices_body CHECK (nullif(btrim(body), '') IS NOT NULL AND length(body) <= 500)
);

CREATE INDEX driver_notices_pending ON driver_notices (vehicle_id, sent_at)
    WHERE acknowledged_at IS NULL;
CREATE INDEX driver_notices_by_vehicle ON driver_notices (vehicle_id, sent_at DESC);

ALTER TABLE driver_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_notices FORCE  ROW LEVEL SECURITY;
CREATE POLICY driver_notices_tenant ON driver_notices
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON driver_notices TO app_user;

-- +goose Down

DROP TABLE IF EXISTS driver_notices;
