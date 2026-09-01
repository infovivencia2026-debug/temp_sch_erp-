-- +goose Up

-- The fingerprint reader, pushing rather than being polled.
--
-- A ZK reader can be reached two ways. Something on the school LAN can dial
-- the device on port 4370 and pull, which needs a machine at the school that
-- stays on and stays reachable — and when it is off, nobody knows until
-- somebody asks why yesterday is empty. Or the device dials out, on a schedule
-- it keeps itself, to an HTTP endpoint. That is ADMS, and it is the better
-- direction for a school with a reader on a domestic broadband line behind a
-- router nobody administers.
--
-- Two things follow from the device being the client, and both shape this.
--
-- It cannot authenticate. There is no header to set, no token to store, no
-- certificate to pin: it identifies itself with a serial number in a query
-- string and nothing else. So the serial IS the credential, and that has to be
-- said out loud rather than discovered. A serial is guessable, so the endpoint
-- must never confirm whether one exists, must never return anything about the
-- school, and must only ever accept punches for staff already enrolled here.
-- A forged serial that gets it right can post attendance rows; it cannot read
-- a name, a number or a roll.
--
-- And it will re-send. A reader that loses its connection mid-upload replays
-- the batch, and a reader whose clock is wrong replays yesterday. Every punch
-- therefore has to be idempotent on its own content, which is why the raw
-- table is keyed on (device, device user, punched at) rather than on an id.

CREATE TABLE IF NOT EXISTS biometric_devices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE SET NULL,
    -- The serial the device sends as ?SN=. Unique across the platform, not per
    -- school: it is the only thing distinguishing one school's reader from
    -- another's, so two schools cannot be allowed to claim the same one.
    serial          text NOT NULL UNIQUE,
    name            text NOT NULL,
    -- Off by default. A device is registered before it is trusted, so a serial
    -- typed wrong does not silently start accepting somebody else's punches.
    is_active       boolean NOT NULL DEFAULT false,
    -- What the device last told us, for the question a school actually asks:
    -- is it still talking to us?
    last_seen_at    timestamptz,
    last_push_at    timestamptz,
    firmware        text,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT biometric_devices_serial CHECK (NULLIF(btrim(serial), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS biometric_devices_institution
    ON biometric_devices (institution_id);

-- The raw punch, exactly as the reader sent it.
--
-- Kept separate from staff_attendance because they are different facts. A
-- punch is a thing that happened at a machine at a moment; a day's attendance
-- is a judgement made from several of them, and the judgement changes when a
-- late punch arrives, when a shift is redefined, or when HR corrects a record.
-- Throwing away the punches would make every one of those irreversible.
CREATE TABLE IF NOT EXISTS biometric_punches (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    device_id       uuid NOT NULL REFERENCES biometric_devices(id) ON DELETE CASCADE,
    -- The number the reader knows the person by, which resolves through
    -- employees.device_user_id. Kept as sent even when it resolves to nobody:
    -- a punch from an unknown id is how a school finds out somebody enrolled a
    -- finger without telling the office.
    device_user_id  integer NOT NULL,
    employee_id     uuid REFERENCES employees(id) ON DELETE SET NULL,
    punched_at      timestamptz NOT NULL,
    -- 0 check-in, 1 check-out, and several others no ZK model agrees on. Kept
    -- rather than interpreted, because the pairing below does not need it and
    -- a wrong interpretation would be baked into the record.
    status_code     integer,
    verify_mode     integer,
    raw             text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotent on content, not on an id. A reader that loses its connection
-- mid-upload replays the whole batch; without this the replay doubles the day.
CREATE UNIQUE INDEX IF NOT EXISTS biometric_punches_once
    ON biometric_punches (device_id, device_user_id, punched_at);

CREATE INDEX IF NOT EXISTS biometric_punches_day
    ON biometric_punches (institution_id, punched_at);

CREATE INDEX IF NOT EXISTS biometric_punches_unresolved
    ON biometric_punches (institution_id, device_user_id)
    WHERE employee_id IS NULL;

ALTER TABLE biometric_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE biometric_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY biometric_devices_tenant ON biometric_devices
    USING (app_is_platform_admin() OR institution_id = app_current_institution())
    WITH CHECK (app_is_platform_admin() OR institution_id = app_current_institution());

ALTER TABLE biometric_punches ENABLE ROW LEVEL SECURITY;
ALTER TABLE biometric_punches FORCE ROW LEVEL SECURITY;
CREATE POLICY biometric_punches_tenant ON biometric_punches
    USING (app_is_platform_admin() OR institution_id = app_current_institution())
    WITH CHECK (app_is_platform_admin() OR institution_id = app_current_institution());

-- +goose Down

DROP TABLE IF EXISTS biometric_punches;
DROP TABLE IF EXISTS biometric_devices;
