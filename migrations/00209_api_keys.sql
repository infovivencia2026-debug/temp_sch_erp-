-- +goose Up
-- A credential a machine can hold, because until now nothing could.
--
-- Every caller of /api/v1 authenticated with the erp_session cookie and
-- nothing else. That is right for a browser and useless for everything else a
-- school actually asks for: the accountant's Tally bridge, the biometric
-- vendor's nightly export, the district's attendance pull, a script the IT
-- teacher writes to reconcile the roll. What those integrations do today is
-- drive a headless browser through the login form with a real person's
-- password, which means the integration holds an account that can do
-- everything that person can, cannot be revoked without locking a human out,
-- and dies the day that person leaves.
--
-- An API key is that credential done honestly: it belongs to one school, it
-- carries a named subset of that school's permissions and never more, it can
-- be revoked on its own, and it says when it was last used so an owner can
-- tell a live integration from an abandoned one.
--
-- The alternative considered and rejected was a service *user*: a row in
-- users with a password and roles. It reuses more of the existing machinery,
-- and that is exactly the problem. A service user can sign in to the web app,
-- appears in the staff list, can be given a role by somebody who does not
-- know what it is for, and inherits every permission that role later gains.
-- A key that stores its own frozen permission list cannot quietly widen.

CREATE TABLE IF NOT EXISTS api_keys (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- What it is for, in the owner's words. The only thing shown on the
    -- screen where somebody decides whether revoking it will break anything,
    -- so it is required rather than nullable.
    name text NOT NULL CHECK (btrim(name) <> ''),

    -- SHA-256 of the secret half of the token, and nothing else.
    --
    -- Deliberately NOT sealSecret/openSecret, which is what vehicle_trackers
    -- uses for its device token. That pair is reversible on purpose because a
    -- tracker's token has to be re-displayable when a phone is re-paired. A
    -- key is different: it is shown once at creation and must be
    -- unrecoverable afterwards, so that neither a database dump nor an
    -- operator with CREDENTIAL_KEY can replay a customer's integration. A
    -- one-way hash is the only storage that makes that claim true, and it is
    -- the same discipline sessions.token_hash already applies.
    --
    -- Unhashed length is 32 random bytes, so a plain SHA-256 with no
    -- stretching is right here: there is no low-entropy password to grind.
    token_hash bytea NOT NULL,

    -- The first characters of the token, kept in clear so a screen can say
    -- "erpk_7f3a..." beside the name. Not a credential and not used for
    -- lookup: the row is found by its id, which the token carries.
    token_hint text NOT NULL DEFAULT '',

    -- The frozen grant. A subset of what the institution's own roles grant,
    -- checked when the key is issued and intersected again on every request,
    -- so a permission later withdrawn from the school stops working for its
    -- keys too. Never contains a platform.* key: see internal/api/api_keys.go.
    permissions text[] NOT NULL DEFAULT '{}',

    -- Requests per minute allowed to this key. Enforced in process rather
    -- than in the database; the column exists so the limit is the owner's
    -- setting and not a constant somebody has to redeploy.
    rate_per_minute integer NOT NULL DEFAULT 120 CHECK (rate_per_minute BETWEEN 1 AND 6000),

    -- The person who issued it. NOT NULL and not ON DELETE SET NULL: the key
    -- runs as this user for scope resolution and for the audit trail, and a
    -- key whose owner has left the school must stop working rather than
    -- become an actor nobody is answerable for.
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- Written at most once a minute by the resolver. Not part of the security
    -- story at all: revocation is checked on every request against
    -- revoked_at, so this can lag without letting a dead key live.
    last_used_at timestamptz,

    revoked_at timestamptz,
    revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,

    -- An optional end date, for the vendor engagement that is meant to be
    -- over in March. Null means it does not expire on its own.
    expires_at timestamptz
);

-- The resolver looks a key up by id and then checks the hash, so the primary
-- key already serves the hot path. This index is for the owner's screen,
-- which lists live keys for one school.
CREATE INDEX IF NOT EXISTS api_keys_institution_live
    ON api_keys (institution_id, created_at DESC)
 WHERE revoked_at IS NULL;

-- Two keys cannot share a name inside one school while both are live. A list
-- with two rows called "Tally" is a list nobody can revoke from safely.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_one_live_name
    ON api_keys (institution_id, lower(btrim(name)))
 WHERE revoked_at IS NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

-- The same policy every other tenant table carries. FORCE matters here more
-- than most: without it the owning role is exempt, and a migration or a job
-- connecting as erp_owner would read every school's keys.
CREATE POLICY api_keys_tenant ON api_keys
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO app_user;

-- +goose Down
DROP TABLE IF EXISTS api_keys;
