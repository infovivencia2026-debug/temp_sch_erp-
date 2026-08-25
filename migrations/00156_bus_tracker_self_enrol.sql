-- +goose Up
-- +goose StatementBegin

/* A driver enrols their own phone, and the principal says yes.

   Pairing a bus tracker needed somebody with transport.write to generate an
   eight-character code in the console, and somebody else to type it into a
   handset within ten minutes. Two people and a stopwatch, for a driver who is
   standing next to their bus at six in the morning and whose office opens at
   nine.

   So the driver signs in on the handset with the phone number and PIN the
   office already issued them -- migration 00155 -- types the registration
   number painted on the bus they are driving, and the tracker appears in the
   transport screen waiting to be let in.

   IT REPORTS NOTHING UNTIL IT IS APPROVED. A tracker is a live map of where
   children are; anybody holding a staff PIN could otherwise attach a phone to
   a school's bus and watch it. The approval is deliberately narrower than the
   pairing it replaces: transport.write is held by the transport manager and
   the office, and this is the principal's decision or the platform's, nobody
   else's. See approveBusTracker in internal/api/device_login.go, which checks
   the role and not only the permission.

   Mirrors sms_gateway_devices in 00155 exactly, including why pair_code_id
   keeps its UNIQUE and loses only its NOT NULL: multiple NULLs are permitted
   by a Postgres unique index, so a pair code stays structurally single-use for
   every tracker that still arrives that way. */

ALTER TABLE vehicle_trackers ALTER COLUMN pair_code_id DROP NOT NULL;

ALTER TABLE vehicle_trackers ADD COLUMN IF NOT EXISTS enrolled_by uuid
    REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE vehicle_trackers ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE vehicle_trackers ADD COLUMN IF NOT EXISTS approved_by uuid
    REFERENCES users(id) ON DELETE SET NULL;

-- Every tracker arrived one way or the other, never both and never neither.
-- This replaces the NOT NULL pair_code_id used to carry: dropping it without
-- putting something in its place leaves a tracker belonging to no enrolment at
-- all, and nothing would notice.
ALTER TABLE vehicle_trackers DROP CONSTRAINT IF EXISTS vehicle_trackers_enrolment;
ALTER TABLE vehicle_trackers ADD CONSTRAINT vehicle_trackers_enrolment
    CHECK (num_nonnulls(pair_code_id, enrolled_by) = 1);

-- Every tracker that exists today came through a code an administrator
-- generated, which is an approval by any reading. Backfilled to when it was
-- paired rather than to now, so the column means the same thing on an old row
-- as on a new one.
UPDATE vehicle_trackers SET approved_at = paired_at WHERE approved_at IS NULL;

-- Finding a bus by the number painted on its side.
--
-- The driver types what they can read from where they are standing, and they
-- will type it with spaces, without them, and in either case. Matched on the
-- digits and letters alone, which is the same normalisation the enrol handler
-- applies to the input.
CREATE INDEX IF NOT EXISTS vehicles_registration_normalised
    ON vehicles (institution_id, upper(regexp_replace(registration_no, '[^A-Za-z0-9]', '', 'g')));

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP INDEX IF EXISTS vehicles_registration_normalised;
ALTER TABLE vehicle_trackers DROP CONSTRAINT IF EXISTS vehicle_trackers_enrolment;
ALTER TABLE vehicle_trackers DROP COLUMN IF EXISTS approved_by;
ALTER TABLE vehicle_trackers DROP COLUMN IF EXISTS approved_at;
ALTER TABLE vehicle_trackers DROP COLUMN IF EXISTS enrolled_by;

-- +goose StatementEnd
