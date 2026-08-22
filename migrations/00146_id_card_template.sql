-- +goose Up
-- The school's own ID card, front and back.
--
-- Cards were laid out by the software: a border, the school's name in the
-- corner, the person's name and code. Correct, and nothing like the card any
-- particular school actually issues — every one of them has artwork already,
-- printed by a stationer, with a crest, a colour, a signature block, and on the
-- reverse the rules about returning it if found.
--
-- So the artwork is the school's and the data is ours. They upload the front
-- and the back exactly as their printer supplies them, and the name, photo and
-- employee code are laid over the front. A school that uploads nothing keeps
-- the plain card, which is better than no card at all.
--
-- Two columns, because a card has two sides and the back is usually the half
-- carrying the school's terms. Nullable both ways: a school may have artwork
-- for one side and not the other, and refusing to store the front until they
-- find the back helps nobody.
--
-- It hangs off branding_profiles rather than taking its own table: this is the
-- same kind of fact as the logo and the wordmark — one per school, set once,
-- read wherever it is printed.

ALTER TABLE branding_profiles
    ADD COLUMN IF NOT EXISTS id_card_front_key text,
    ADD COLUMN IF NOT EXISTS id_card_back_key  text;

-- +goose Down
ALTER TABLE branding_profiles
    DROP COLUMN IF EXISTS id_card_front_key,
    DROP COLUMN IF EXISTS id_card_back_key;
