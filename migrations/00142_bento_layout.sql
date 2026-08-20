-- +goose Up
-- Renumbered 00136 -> 00142 at integration: another session deployed through
-- 00141 while this was in flight, and goose skips a migration below the
-- current version rather than failing, which is how it silently did nothing.
-- 00136_bento_layout.sql -- number claimed per the work order; may be
-- renumbered at integration. Depends only on 00083 having created
-- user_display_preferences.
--
-- Additive only, and deliberately on the row that already exists. A layout is
-- the same kind of fact as a theme, a density or a locale: something about
-- this person's own eyes, keyed on the user and never on a student. Standing a
-- second table (or a second endpoint) beside it is how a header toggle ends up
-- disagreeing with a settings screen, and how one Save half-succeeds.
--
--   layout   which dashboard language the shell renders. 'classic' is the
--            default and stays the default: an account that never touches the
--            switch must render byte-identically to today.
--
-- The CHECK is closed rather than free text for the same reason the locale
-- CHECK is. A layout value with no implementation behind it is a preference
-- that appears to work and does nothing -- worse than not offering it. The
-- storable set is the set of layouts the client can actually render.

ALTER TABLE user_display_preferences
    ADD COLUMN IF NOT EXISTS layout text NOT NULL DEFAULT 'classic';

-- Named so the next worker can find and replace it. A separate guarded
-- statement because ADD COLUMN IF NOT EXISTS above may have been a no-op on a
-- re-run, in which case the constraint would never be created.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'user_display_preferences_layout_check'
    ) THEN
        ALTER TABLE user_display_preferences
            ADD CONSTRAINT user_display_preferences_layout_check
            CHECK (layout IN ('classic', 'bento'));
    END IF;
END $$;
-- +goose StatementEnd

COMMENT ON COLUMN user_display_preferences.layout IS
    'Which dashboard layout the shell renders for this account: classic (the default, unchanged) or bento (opt-in, experimental). Constrained to the layouts the client implements. Storing one it does not know renders the classic screen anyway, so an unknown value would be a silently dead setting.';

-- No new table, so no new RLS: the existing user_display_preferences tenant
-- policy and the existing grants to app_user cover this column unchanged. RLS
-- is still FORCEd on the table; adding a column does not disturb it.
--
-- ADDING A THIRD LAYOUT (the next worker):
--   1. In a NEW migration -- do not edit this one --
--          ALTER TABLE user_display_preferences
--              DROP CONSTRAINT user_display_preferences_layout_check;
--          ALTER TABLE user_display_preferences
--              ADD  CONSTRAINT user_display_preferences_layout_check
--              CHECK (layout IN ('classic', 'bento', '<new>'));
--   2. Add it to layoutChoices in internal/api/student_life.go, which is what
--      the API validates against.
--   3. Add it to LAYOUTS in web/src/lib/layout.tsx and give the header switch
--      a button for it.

-- +goose Down

ALTER TABLE user_display_preferences
    DROP CONSTRAINT IF EXISTS user_display_preferences_layout_check;
ALTER TABLE user_display_preferences DROP COLUMN IF EXISTS layout;
