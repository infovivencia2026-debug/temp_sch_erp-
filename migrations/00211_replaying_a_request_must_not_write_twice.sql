-- +goose Up
-- The receipt a retry can be answered from.
--
-- This exists so the app can hold a write while there is no signal and send it
-- when there is. That queue is only safe if sending twice is harmless, and
-- today it is not. A teacher on a bus with one bar submits a fee receipt, the
-- request leaves, the answer never comes back. The queue cannot tell "never
-- arrived" from "arrived and the reply was lost" -- from the client both look
-- identical -- so it either drops writes that did happen or repeats writes
-- that did. One loses the register; the other charges the family twice.
--
-- The way out is for the client to name the attempt. A key is minted once,
-- when somebody presses the button, and travels with every retry of that same
-- attempt. The first request to arrive does the work and its answer is kept
-- here; every later arrival of the same key is answered from this row without
-- running the handler again. The write happens once no matter how many times
-- the network makes the client ask.
--
-- Five features already solved this for themselves -- announcements, the
-- classroom register, banking, SMS, the connectors -- each with its own
-- client_ref column and its own bespoke lookup. Those stay: they dedupe on
-- domain identity and can answer questions this cannot, such as whether two
-- registers for the same section on the same day are the same register. This
-- is the general case, for the several hundred endpoints that have no such
-- column and would otherwise never be safe to retry.

CREATE TABLE IF NOT EXISTS idempotency_keys (
    -- The key the client minted. Scoped per institution, because these are
    -- client-generated and one school must not be able to probe, collide with,
    -- or replay another's by guessing a value.
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    key            text NOT NULL CHECK (btrim(key) <> '' AND length(key) <= 200),

    -- Whose attempt it was. A key replayed under a different account is not
    -- the same attempt, whatever it claims: two people share the staffroom
    -- laptop, and answering the second from the first one's stored response
    -- would hand them somebody else's data.
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- What was asked. Stored so a key reused for a DIFFERENT request is
    -- refused rather than answered from the wrong receipt -- the failure mode
    -- where a client bug turns one key into a lid over every later write.
    method       text NOT NULL,
    path         text NOT NULL,
    request_hash text NOT NULL,

    -- What was answered, kept verbatim so the replay is indistinguishable
    -- from the original. NULL while the first request is still running, which
    -- is what makes the row a lock as well as a receipt: a second request
    -- arriving mid-flight finds the row, sees no answer yet, and is told to
    -- wait rather than starting the same work alongside it.
    status_code  int,
    response_body bytea,

    created_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,

    PRIMARY KEY (institution_id, key)
);

-- Receipts are worth keeping only as long as a client might still retry.
-- The sweep runs in the worker's weekly housekeeping (sessionPrune); the index is
-- here so it does not table-scan a table that sees every write in the product.
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY idempotency_keys_tenant ON idempotency_keys
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO app_user;

-- +goose Down
DROP TABLE IF EXISTS idempotency_keys;
