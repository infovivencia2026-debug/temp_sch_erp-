-- +goose Up
-- The number painted on the side of the bus, as far as this system is concerned.
--
-- A driver is not permanent on a route. The regular man is on leave, the spare
-- bus goes out, two drivers swap at lunch — so a handset paired once to one
-- vehicle describes a school that does not exist. What is constant is the
-- vehicle: it has a registration plate, it sits in the yard overnight, and a
-- sticker can be put inside the windscreen.
--
-- So every bus gets a short code. The driver signs in as himself and then says
-- which bus he is on today by scanning the sticker or typing the six digits
-- under it. Six digits because it is read across a cab in the dark by somebody
-- who has already started the engine.
--
-- Digits only, like the pairing codes: the phone's keypad opens on numbers.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS bus_code text;

-- +goose StatementBegin
DO $$
DECLARE
  v record;
  candidate text;
BEGIN
  FOR v IN SELECT id, institution_id FROM vehicles WHERE bus_code IS NULL LOOP
    LOOP
      candidate := lpad((floor(random() * 1000000))::int::text, 6, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM vehicles
         WHERE institution_id = v.institution_id AND bus_code = candidate);
    END LOOP;
    UPDATE vehicles SET bus_code = candidate WHERE id = v.id;
  END LOOP;
END $$;
-- +goose StatementEnd

-- Unique per school, not globally: two schools on this installation may both
-- run a bus 004312, and a driver only ever scans a sticker in his own yard.
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_institution_bus_code
  ON vehicles (institution_id, bus_code) WHERE bus_code IS NOT NULL;

COMMENT ON COLUMN vehicles.bus_code IS
  'Six digits on a sticker in the cab. The driver scans or types it to say '
  'which bus he is driving today; it never changes for the life of the vehicle.';

-- +goose Down
DROP INDEX IF EXISTS vehicles_institution_bus_code;
ALTER TABLE vehicles DROP COLUMN IF EXISTS bus_code;
