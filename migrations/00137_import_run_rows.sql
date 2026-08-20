-- +goose Up
-- What each import actually created, so it can be undone.
--
-- import_runs records that a file was loaded and how many rows went in. That
-- answers "has somebody already done this" and not the question that follows
-- it: "I have loaded the wrong file, take it back out". Without a record of
-- which rows came from which upload, the only way to undo a three-hundred-row
-- import is to find those three hundred rows by eye among the ones that were
-- already there.
--
-- One row per record created. Records that were *updated* by an import are
-- deliberately not listed: the importers upsert, so a second upload of a
-- corrected sheet edits rows that existed before it, and undoing that upload
-- must not delete a class the school created by hand in March.

CREATE TABLE IF NOT EXISTS import_run_rows (
    id             bigserial PRIMARY KEY,
    run_id         uuid NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- The table the record is in, and its id. Text rather than a foreign key
    -- per table: an importer that lands rows in a new table should not need a
    -- migration before it can record what it did, and the delete resolves the
    -- name against a fixed list in code rather than trusting this column.
    entity    text NOT NULL,
    record_id uuid NOT NULL,

    UNIQUE (run_id, entity, record_id)
);

CREATE INDEX IF NOT EXISTS import_run_rows_run ON import_run_rows (run_id);

ALTER TABLE import_run_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_run_rows FORCE ROW LEVEL SECURITY;

CREATE POLICY import_run_rows_tenant ON import_run_rows
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- Whether an import has since been taken back out. Kept rather than deleting
-- the run: "this file was loaded and then undone" is a different fact from
-- "this file was never loaded", and the second is what an empty history says.
ALTER TABLE import_runs
    ADD COLUMN IF NOT EXISTS undone_at timestamptz;
ALTER TABLE import_runs
    ADD COLUMN IF NOT EXISTS undone_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE import_runs DROP COLUMN IF EXISTS undone_at;
ALTER TABLE import_runs DROP COLUMN IF EXISTS undone_by;
DROP TABLE IF EXISTS import_run_rows;
