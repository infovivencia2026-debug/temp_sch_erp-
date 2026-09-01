-- +goose Up
-- 00088_i18n.sql -- number claimed per the work order; may be renumbered at
-- integration.
--
-- Additive only. There is exactly one per-account display store in this
-- product, user_display_preferences (00083), and this migration extends it
-- rather than standing a second one beside it: a locale is the same kind of
-- fact as a theme -- something about this person's eyes and reading, keyed on
-- the user and not on a student -- and two tables holding half the answer each
-- is how a header toggle ends up disagreeing with a settings screen.
--
-- Two columns:
--
--   locale         which language the interface renders in. 'en' is the
--                  default and stays the default; a row that has never been
--                  touched must render byte-identically to today.
--   high_contrast  an opt-in token override, off by default. It is a separate
--                  axis from theme, not a fourth theme value: somebody wants
--                  high contrast *and* dark, and folding it into the theme
--                  enum would force them to choose.
--
-- The locale CHECK is deliberately closed rather than a free text column.
-- A locale with no message catalogue renders as a screen of raw keys, so the
-- set of storable values is the set of catalogues that ship. Adding Telugu is
-- an ALTER of this constraint plus web/src/locales/te.ts -- see the note at
-- the bottom of this file.

ALTER TABLE user_display_preferences
    ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en';

ALTER TABLE user_display_preferences
    ADD COLUMN IF NOT EXISTS high_contrast boolean NOT NULL DEFAULT false;

-- Named so the next worker can find and replace it. Written as a separate
-- statement guarded by a catalogue check because ADD COLUMN IF NOT EXISTS
-- above may have been a no-op on a re-run.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'user_display_preferences_locale_check'
    ) THEN
        ALTER TABLE user_display_preferences
            ADD CONSTRAINT user_display_preferences_locale_check
            CHECK (locale IN ('en'));
    END IF;
END $$;
-- +goose StatementEnd

COMMENT ON COLUMN user_display_preferences.locale IS
    'BCP-47 language tag of the interface. Constrained to the locales that have a shipped message catalogue in web/src/locales — storing one without a catalogue renders raw keys.';

COMMENT ON COLUMN user_display_preferences.high_contrast IS
    'Opt-in high-contrast token override, applied as data-contrast="high" on the document root. Independent of theme: high contrast is available in both light and dark.';

-- No new table, so no new RLS: the existing user_display_preferences_tenant
-- policy and the existing grants to app_user cover these columns unchanged.
-- RLS is still FORCEd on the table; adding a column does not disturb it.
--
-- ADDING TELUGU (the next worker):
--   1. ALTER TABLE user_display_preferences
--          DROP CONSTRAINT user_display_preferences_locale_check;
--      ALTER TABLE user_display_preferences
--          ADD  CONSTRAINT user_display_preferences_locale_check
--          CHECK (locale IN ('en', 'te'));
--      ...in a NEW migration. Do not edit this one.
--   2. Add 'te' to localeChoices in internal/api/i18n.go, which is what the
--      API validates against.
--   3. Add web/src/locales/te.ts and register it in CATALOGUES in
--      web/src/lib/i18n.tsx.

-- +goose Down

ALTER TABLE user_display_preferences
    DROP CONSTRAINT IF EXISTS user_display_preferences_locale_check;
ALTER TABLE user_display_preferences DROP COLUMN IF EXISTS high_contrast;
ALTER TABLE user_display_preferences DROP COLUMN IF EXISTS locale;
