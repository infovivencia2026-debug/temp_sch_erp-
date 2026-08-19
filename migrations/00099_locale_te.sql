-- +goose Up
-- Renumbered from 00092 at integration: seven migrations landed above it while
-- this was in flight.
-- 00092_locale_te.sql -- number claimed per the work order; may be renumbered
-- at integration.
--
-- Telugu. This widens the closed locale CHECK added in 00088 from ('en') to
-- ('en','te'). 00088 is left alone deliberately: it has already run on every
-- environment, and an edited migration is a migration that means one thing on
-- a fresh database and another on an existing one.
--
-- This is one third of a change that only works whole. The same list exists in
-- three places and all three widen together:
--
--   1. this CHECK                        -- what may be stored
--   2. localeChoices, internal/api/i18n.go -- what the API will accept
--   3. CATALOGUES, web/src/lib/i18n.tsx    -- what the client can render
--
-- Widening (1) alone is the interesting failure: the preference saves, the API
-- returns it, and the parent who chose Telugu gets a screen of raw message
-- keys -- portal.documents.title where the heading should be -- including on
-- the selector they would need to change it back. So the constraint is not
-- widened until the catalogue exists, which it now does (web/src/locales/te.ts).
--
-- Telugu's catalogue is a Partial: keys it does not carry fall back to English
-- per the chain in web/src/lib/i18n.tsx. That is a mixed screen, not a broken
-- one, and it is why this constraint can widen before the translation is
-- exhaustive.
--
-- DROP then ADD rather than an in-place change: Postgres has no ALTER
-- CONSTRAINT for a CHECK expression. Existing rows all hold 'en', which
-- satisfies the wider constraint, so the validating scan cannot fail.

ALTER TABLE user_display_preferences
    DROP CONSTRAINT IF EXISTS user_display_preferences_locale_check;

ALTER TABLE user_display_preferences
    ADD CONSTRAINT user_display_preferences_locale_check
    CHECK (locale IN ('en', 'te'));

-- Restated because the constraint it describes has changed. The wording avoids
-- a double hyphen inside the literal: goose splits on line comments before it
-- knows it is inside a string, and a dash pair here swallows the closing quote.
COMMENT ON COLUMN user_display_preferences.locale IS
    'BCP-47 language tag of the interface. Constrained to the locales that have a shipped message catalogue in web/src/locales, because storing one without a catalogue renders raw keys. Currently en and te.';

-- No new table, so no new RLS or grants: user_display_preferences keeps its
-- existing FORCEd row-level security and its existing grants to app_user, and
-- replacing a CHECK does not disturb either.

-- +goose Down

-- Back to English-only. Any account that had chosen Telugu must be moved off
-- it first or the narrowed constraint cannot validate -- and the rendering
-- argument runs the same way down as up: rolling this back removes the Telugu
-- catalogue's server-side permission, so a row still holding 'te' would be a
-- stored preference nothing will accept on the next save.
UPDATE user_display_preferences SET locale = 'en' WHERE locale <> 'en';

ALTER TABLE user_display_preferences
    DROP CONSTRAINT IF EXISTS user_display_preferences_locale_check;

ALTER TABLE user_display_preferences
    ADD CONSTRAINT user_display_preferences_locale_check
    CHECK (locale IN ('en'));
