-- +goose Up
-- Changing the address you sign in with.
--
-- The profile screen updated a name and a phone number and refused the email,
-- with a comment saying it is a login identifier and changing it needs a
-- verification round trip rather than a PUT. That reasoning is right and the
-- conclusion was to do nothing, so a teacher who changed schools — or simply
-- mistyped their address on the day they were appointed — had no way to fix
-- the thing they sign in with.
--
-- This is the round trip. The new address is held here, unconfirmed, until
-- somebody opens the link sent to it. Until then the old address still signs
-- in: a change that takes effect before it is proved locks the owner out of
-- their own account when the address was typed wrongly, which is the single
-- most likely reason they are on this screen.

CREATE TABLE IF NOT EXISTS email_changes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Where the confirmation was sent, and where the account moves to when it
    -- is opened. Stored in the clear on purpose: unlike a token this is not a
    -- secret, and it has to be shown back to the person on the screen that
    -- says where the link went.
    new_email   citext      NOT NULL,

    -- Only the hash. The token is an authorisation to move somebody's login.
    token_hash  text        NOT NULL UNIQUE,

    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_changes_user_idx ON email_changes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_changes_expiry_idx ON email_changes (expires_at) WHERE used_at IS NULL;

-- No row level security, for the same reason password_resets has none: the
-- confirmation is opened before anybody signs in, there is no tenant in
-- context to key a policy on, and the token is the authorisation.

-- +goose Down
DROP TABLE IF EXISTS email_changes;
