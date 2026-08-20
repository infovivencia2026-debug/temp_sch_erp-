-- +goose Up
-- What was uploaded, by whom, and when.
--
-- Every importer in the product ran, reported a count on screen, and forgot.
-- Refresh the page and there was no record that a file had ever been loaded --
-- so "did somebody already import the class list?" was answerable only by
-- looking for the rows and guessing, and "who loaded this and when?" was not
-- answerable at all.
--
-- That matters most exactly where imports matter: a school office where three
-- people share the work. The second person re-uploads because they cannot see
-- that the first already did, and an importer that upserts quietly rewrites
-- everything while one that inserts creates a second copy of the school.
--
-- One row per committed import. Dry runs are not recorded: nothing happened,
-- and a log of things that did not happen is a log people learn to skim.

CREATE TABLE IF NOT EXISTS import_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- classes | sections | staff | students -- whatever the importer called it.
    -- Text rather than an enum: a new importer should not need a migration
    -- before it can record what it did.
    entity         text        NOT NULL,

    -- The name of the file as the browser reported it, or a description of a
    -- paste. Kept because it is what a person actually recognises: "the count
    -- was 312" means nothing next to "students-final-v3.csv".
    filename       text,

    rows_read      integer     NOT NULL DEFAULT 0,
    rows_imported  integer     NOT NULL DEFAULT 0,
    rows_rejected  integer     NOT NULL DEFAULT 0,

    imported_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_runs_recent
    ON import_runs (institution_id, entity, created_at DESC);

ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY import_runs_tenant ON import_runs
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS import_runs;
