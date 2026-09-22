-- +goose Up
/* A built-in role a school has changed.

   Every built-in role (Principal, Accounts, HR, Faculty ...) is restored
   from code on every upgrade, which is why the grid refused to edit one:
   an edit would have appeared to work and silently reverted weeks later.
   The refusal was the rigid part. A principal who wants the Principal role
   to hold one more screen, or the Accounts role to hold one fewer, should
   be able to say so and have it stick.

   customised_at is that record. Set when the school edits a built-in role's
   grants; while it is set the seeder leaves that role's grants alone. The
   Reset to preset action clears it and restores the role from code. */
ALTER TABLE roles ADD COLUMN IF NOT EXISTS customised_at timestamptz;

-- +goose Down
ALTER TABLE roles DROP COLUMN IF EXISTS customised_at;
