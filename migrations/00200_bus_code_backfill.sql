-- +goose Up
-- The codes 00199 meant to issue and did not.
--
-- Its backfill loop read `SELECT id FROM vehicles`, and vehicles has FORCE ROW
-- LEVEL SECURITY: with no institution in the session, the policy matched no
-- rows, the loop ran zero times, and the migration reported success while
-- every existing bus kept a NULL code. New buses were fine — those are minted
-- by the API, which runs inside a tenant.
--
-- Nothing warned. A migration that quietly does nothing is worse than one that
-- fails, because it fails at six in the morning instead, when a driver scans a
-- sticker that was never printed.
SELECT set_config('app.is_platform_admin', 'on', true);

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

-- +goose Down
-- Nothing to undo: 00199 owns the column, and taking the codes off buses that
-- have them printed on a sticker would be the damaging direction.
SELECT 1;
