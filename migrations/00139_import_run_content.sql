-- +goose Up
-- The file itself, kept with the record of the upload.
--
-- The history says a file called 4-staff.csv was loaded at 08:52 by ramesh
-- and added ten rows. The question that follows is always "which ten?" — and
-- the answer lived only on the screen of whoever uploaded it, for as long as
-- they did not refresh.
--
-- That matters most when something is wrong. A school looking at a duplicated
-- teacher wants to see the sheet that made them, and "10 added" cannot be
-- compared against anything.
--
-- Capped rather than unlimited. A class list is a few hundred kilobytes and a
-- data migration is not something to keep a copy of in a text column; past the
-- cap the row records that the file was too large to keep rather than keeping
-- a misleading half of it.

ALTER TABLE import_runs
    ADD COLUMN IF NOT EXISTS content text;

-- True when the file was past the cap and deliberately not stored, so the
-- screen can say "not kept" rather than showing an empty table that reads as
-- an empty file.
ALTER TABLE import_runs
    ADD COLUMN IF NOT EXISTS content_omitted boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE import_runs DROP COLUMN IF EXISTS content;
ALTER TABLE import_runs DROP COLUMN IF EXISTS content_omitted;
