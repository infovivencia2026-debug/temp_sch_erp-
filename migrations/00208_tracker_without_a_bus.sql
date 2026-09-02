-- +goose Up
-- The phone belongs to the driver. The bus is chosen per run.
--
-- Pairing bound a handset to one vehicle: vehicle_tracker_pair_codes and
-- vehicle_trackers both carried vehicle_id NOT NULL, so the office had to pick
-- a bus before it could even print a code, and a driver taking a relief bus was
-- reporting positions against the vehicle somebody assigned him weeks earlier.
--
-- That is the wrong shape for a depot where drivers and buses are not paired.
-- The handset now identifies the DRIVER; which bus he is in is answered at the
-- start of every run, by reading the QR sticker in its windscreen. A trip still
-- carries vehicle_id NOT NULL, because a run without a bus is meaningless --
-- only the registration is late-bound rather than fixed at pairing.
--
-- Nullable, not dropped. A school that does pair one phone to one bus keeps
-- working exactly as before: the column still holds that assignment, the trip
-- falls back to it when no sticker is scanned, and nothing has to be re-paired.

ALTER TABLE vehicle_tracker_pair_codes ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE vehicle_trackers          ALTER COLUMN vehicle_id DROP NOT NULL;

-- The one-live-tracker-per-vehicle rule only ever meant anything for a tracker
-- that names a vehicle. Rebuilt as a partial index so unbound handsets -- of
-- which a depot has one per driver -- do not collide with each other on NULL.
-- Keeps the original's shape -- the COALESCE is what makes "one LIVE tracker"
-- mean anything, since NULL revoked_at would otherwise never collide -- and adds
-- the partial clause so unbound handsets, of which a depot has one per driver,
-- do not all collide with each other on a NULL vehicle.
DROP INDEX IF EXISTS vehicle_trackers_one_live_per_vehicle;
CREATE UNIQUE INDEX vehicle_trackers_one_live_per_vehicle
    ON vehicle_trackers (vehicle_id, COALESCE(revoked_at, 'epoch'::timestamptz))
 WHERE vehicle_id IS NOT NULL;

-- +goose Down
DELETE FROM vehicle_trackers          WHERE vehicle_id IS NULL;
DELETE FROM vehicle_tracker_pair_codes WHERE vehicle_id IS NULL;
DROP INDEX IF EXISTS vehicle_trackers_one_live_per_vehicle;
CREATE UNIQUE INDEX vehicle_trackers_one_live_per_vehicle
    ON vehicle_trackers (vehicle_id, COALESCE(revoked_at, 'epoch'::timestamptz));
ALTER TABLE vehicle_trackers          ALTER COLUMN vehicle_id SET NOT NULL;
ALTER TABLE vehicle_tracker_pair_codes ALTER COLUMN vehicle_id SET NOT NULL;
