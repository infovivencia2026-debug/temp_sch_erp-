-- +goose Up
-- Numbered well above the highest migration on origin/main (00218) because
-- another session is adding migrations at the same time.
--
-- Payment gateway credentials, platform-only.
--
-- The catalogue promises the platform owner a place to keep Razorpay, Paytm,
-- CCAvenue, BillDesk and Easebuzz keys. Nothing in this product charges a card
-- today -- internal/api/portal_pay.go says so in its first paragraph -- so this
-- table is the same honest shape as tally_gateway_credentials: a record of the
-- key the day a checkout is wired, and never a claim that one already is. The
-- handler returns live_checkout_available = false off the server, so no screen
-- can promise more than the product does.
--
-- Every comment here is a line comment. goose counts semicolons without
-- understanding block comments.
CREATE TABLE payment_gateway_credentials (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- NULL is an installation-wide default: one merchant account collecting
    -- for every campus of a trust. The unique index below COALESCEs to the nil
    -- uuid so the defaults have a value to collide on.
    institution_id  uuid REFERENCES institutions(id) ON DELETE CASCADE,

    provider        text NOT NULL
                    CHECK (provider IN ('razorpay','paytm','ccavenue','billdesk','easebuzz')),

    -- Gateways issue a separate key pair for their sandbox. Recording which
    -- one this is keeps a test key from being mistaken for money.
    mode            text NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),

    -- The public half: key id, merchant id, access code. Not secret on its own.
    key_id          text,

    -- The secret half and the webhook signing secret, sealed with
    -- CREDENTIAL_KEY the same way integrations.credentials is. bytea so there
    -- is no shape to be tempted into querying.
    key_secret      bytea,
    webhook_secret  bytea,

    is_enabled      boolean NOT NULL DEFAULT false,
    notes           text,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT payment_gateway_credentials_key_not_blank
        CHECK (key_id IS NULL OR btrim(key_id) <> '')
);

CREATE UNIQUE INDEX payment_gateway_credentials_one_per_scope
    ON payment_gateway_credentials
       (COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid), provider);

COMMENT ON TABLE payment_gateway_credentials IS
    'Platform-only. Merchant keys per school and gateway, sealed. The RLS policy is app_is_platform_admin() with no tenant escape. No checkout uses these yet; the handler says so.';

ALTER TABLE payment_gateway_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateway_credentials FORCE  ROW LEVEL SECURITY;

-- Platform staff only, in both directions. An institution admin cannot read
-- their own school's row.
CREATE POLICY payment_gateway_credentials_platform_only ON payment_gateway_credentials
    USING (app_is_platform_admin())
    WITH CHECK (app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_gateway_credentials TO app_user;

-- +goose Down
DROP TABLE IF EXISTS payment_gateway_credentials;
