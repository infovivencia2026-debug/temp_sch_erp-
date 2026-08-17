-- +goose Up
-- Make an institution's numbering counter genuinely unique.
--
-- numbering_schemes_institution_id_campus_id_kind_key is UNIQUE over
-- (institution_id, campus_id, kind), and campus_id is nullable. Postgres
-- treats NULLs as distinct in a unique index by default, so that constraint
-- permits unlimited rows for the same institution and kind as long as
-- campus_id is NULL — which is the normal, institution-wide case.
--
-- The consequence only appears under concurrency: several cashiers collecting
-- the first fee of a new institution each found no counter, each inserted one
-- starting at 1, and each issued receipt 00001. A 25-way concurrent test
-- reproduced it immediately.
--
-- A partial unique index over just (institution_id, kind) closes it, and gives
-- the allocator a conflict target to upsert against.

-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd

-- Collapse any duplicates created before this index existed, keeping the
-- highest counter so no number is ever reissued.
WITH ranked AS (
    SELECT id, institution_id, kind, next_value,
           row_number() OVER (PARTITION BY institution_id, kind
                              ORDER BY next_value DESC, id) AS rn
      FROM numbering_schemes
     WHERE campus_id IS NULL
)
DELETE FROM numbering_schemes ns
 USING ranked r
 WHERE ns.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS numbering_schemes_institution_kind
    ON numbering_schemes (institution_id, kind)
    WHERE campus_id IS NULL;

-- +goose Down
DROP INDEX IF EXISTS numbering_schemes_institution_kind;
