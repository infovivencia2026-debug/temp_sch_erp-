-- +goose Up
-- The roll the school says a section has, beside the roll it actually has.
--
-- The setup template asks for capacity -- how many desks -- and nothing asks
-- how many children are sitting at them. A school migrating from another
-- system knows that number for every section and it is the first thing they
-- check after an import: 42 in 6-A, and the screen says 39, so three children
-- did not come across.
--
-- Kept apart from a count of enrollments on purpose. Strength is derivable and
-- must stay derived -- a stored copy is wrong the first time a child moves
-- section, and then quietly wrong for ever. This column is not that count. It
-- is what the school DECLARED at import, held so the two can be compared and
-- the difference shown. Once the roll is trusted the school can clear it and
-- nothing depends on it.
ALTER TABLE sections ADD COLUMN IF NOT EXISTS stated_strength integer
    CHECK (stated_strength IS NULL OR stated_strength >= 0);

COMMENT ON COLUMN sections.stated_strength IS
    'Roll declared by the school at import. Compare against enrollments; never read as the roll itself.';

-- +goose Down
ALTER TABLE sections DROP COLUMN IF EXISTS stated_strength;
