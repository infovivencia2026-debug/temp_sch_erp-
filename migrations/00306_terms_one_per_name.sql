-- +goose Up

-- One term per name per year.
--
-- terms had no uniqueness at all, so a school uploading its calendar twice --
-- which is what happens when the first upload has a typo in it -- would hold
-- two Term 1s, and every screen that offers a term to file something under
-- would offer both. The calendar importer edits on this key rather than
-- doubling, and the same key is what stops a person adding a second Term 1 by
-- hand.
--
-- Case-insensitive, because "Term 1" and "term 1" are one term.

CREATE UNIQUE INDEX IF NOT EXISTS terms_one_per_name
    ON terms (academic_year_id, lower(name));

-- +goose Down
DROP INDEX IF EXISTS terms_one_per_name;
