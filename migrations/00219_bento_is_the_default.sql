-- +goose Up

-- Bento becomes the default layout on the server, as it already was in the
-- client.
--
-- The two disagreed. web/src/lib/layout.tsx stamps 'bento' on a device that
-- has stored nothing; 00142 gave the account row a default of 'classic'. Which
-- one a person actually saw came down to timing: a fresh device painted bento
-- and then, when the shell reconciled against the account row, snapped to
-- classic -- the stacked, single-column board. A parent opening the app for
-- the first time was shown the old layout and called it an old version, while
-- the admin dock on another device paged as intended. Two defaults for one
-- setting is exactly the drift the layout module warns about; this ends it.
--
-- Existing rows are moved with the default. 'classic' on a row cannot be
-- told apart from "never chose": the row is created the first time ANY
-- display preference is saved -- a theme, a locale -- and the layout column
-- simply took its default. Treating those as a considered choice would keep
-- the old board for everyone who once picked dark mode. Anybody who wants
-- classic back has the same switch they always had, and their choice is kept
-- from here on because it is no longer the default.
--
-- Platform admin because the table is FORCE ROW LEVEL SECURITY and a
-- migration carries no institution.

ALTER TABLE user_display_preferences
    ALTER COLUMN layout SET DEFAULT 'bento';

SET LOCAL app.is_platform_admin = 'on';
UPDATE user_display_preferences SET layout = 'bento' WHERE layout = 'classic';

COMMENT ON COLUMN user_display_preferences.layout IS
    'Which dashboard layout the shell renders for this account: bento (the default) or classic. Constrained to the layouts the client implements.';

-- +goose Down

ALTER TABLE user_display_preferences
    ALTER COLUMN layout SET DEFAULT 'classic';
