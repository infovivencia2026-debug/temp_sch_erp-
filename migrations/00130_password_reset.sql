-- +goose Up
-- Getting back in without telephoning the office.
--
-- Until now the only recovery was an administrator issuing a temporary
-- password by hand, on the reasoning that self-service reset needs a delivery
-- gateway this deployment does not have. That was true when it was written and
-- is not any more: there is a message log, and messages are recorded whether
-- or not a provider is configured.
--
-- Numbered at 130, clear of the range the parallel branch is consuming: 121
-- was taken by message_rules between this being written and being applied.
--
-- So the flow exists and the delivery is honest about itself. The link is
-- written to message_log like every other outbound message, and where no mail
-- provider is configured the page says so and shows the link rather than
-- pretending an email is in flight.

CREATE TABLE password_resets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Only the hash. A reset token is a password for the next fifteen minutes,
    -- and a table of live ones is a table worth stealing.
    token_hash  text        NOT NULL UNIQUE,

    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    -- Kept for the audit trail: "somebody asked to reset this account from
    -- this address" is the question asked after an account is taken over.
    requested_ip text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);

-- Expired and spent rows are rubbish that never stops accumulating; the worker
-- prunes them, and the index makes that cheap.
CREATE INDEX password_resets_expiry_idx ON password_resets (expires_at)
    WHERE used_at IS NULL;

-- Deliberately no row level security. This table is written and read before
-- anybody is signed in — there is no tenant in context to key a policy on, and
-- the token itself is the authorisation. It carries no personal data beyond a
-- user id, and every read is by token hash rather than by user.

-- +goose Down
DROP TABLE IF EXISTS password_resets;
