-- +goose Up
-- Buying without a telephone call.
--
-- The website could take an enquiry and nothing else: a school that had made
-- up its mind still had to wait for a salesperson to ring back and provision
-- them by hand. That is the right answer for a school the vendor wants to
-- qualify, and the wrong one for a school holding a card and a decision.
--
-- signup_orders is the record of a school buying itself. It is deliberately
-- separate from purchase_enquiries: an enquiry is a lead, and a lead that goes
-- nowhere is normal, whereas an order is money and every one of them must be
-- explainable afterwards. Keeping them in one table would mean a status column
-- that means two different things depending on the row.

CREATE TABLE signup_orders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What the school told us about itself, before it exists as a tenant.
    school_name     text        NOT NULL,
    contact_name    text        NOT NULL,
    email           citext      NOT NULL,
    phone           text,
    district        text,
    state           text,
    board           text,
    students        integer,
    admin_username  citext,

    plan_code       text        NOT NULL REFERENCES plans(code) ON DELETE RESTRICT,
    -- Copied rather than joined. A plan's price changes; what this school
    -- agreed to pay on the day does not, and a receipt that silently reprices
    -- itself is not a receipt.
    amount_paise    bigint      NOT NULL CHECK (amount_paise >= 0),

    -- The gateway's three identifiers, in the shape Razorpay uses: an order
    -- created before the customer pays, a payment id and a signature returned
    -- after. Held as text because they are somebody else's identifiers and
    -- their format is not ours to constrain.
    order_ref       text        NOT NULL UNIQUE,
    payment_ref     text,
    signature       text,

    status          text        NOT NULL DEFAULT 'created',
    failure_reason  text,

    -- Set once the order becomes a school. The order row outlives the
    -- provisioning so a refund or a dispute can still find the tenant.
    institution_id  uuid        REFERENCES institutions(id) ON DELETE SET NULL,
    admin_user_id   uuid        REFERENCES users(id) ON DELETE SET NULL,

    -- The credentials are delivered once and never stored. This records that
    -- the delivery happened, which is the question support is actually asked.
    credentials_sent_at timestamptz,

    created_at      timestamptz NOT NULL DEFAULT now(),
    paid_at         timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT signup_orders_status_check
        CHECK (status IN ('created','paid','provisioned','failed','abandoned')),

    -- A paid order without the gateway's own identifiers cannot be reconciled
    -- against a settlement report, and an unreconcilable payment is the one
    -- kind of row an auditor will always find.
    CONSTRAINT signup_orders_paid_has_refs
        CHECK (status NOT IN ('paid','provisioned')
               OR (payment_ref IS NOT NULL AND signature IS NOT NULL)),
    CONSTRAINT signup_orders_provisioned_has_tenant
        CHECK (status <> 'provisioned' OR institution_id IS NOT NULL)
);

-- The seller console lists these newest-first alongside the enquiries.
CREATE INDEX signup_orders_created_idx ON signup_orders (created_at DESC);
CREATE INDEX signup_orders_status_idx  ON signup_orders (status);

-- signup_orders is platform data, not tenant data: the rows exist before any
-- institution does, so there is nothing for a tenant policy to key on. It is
-- reachable only through AsPlatform, the same way plans and institutions are.

CREATE TRIGGER signup_orders_touch
    BEFORE UPDATE ON signup_orders
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- +goose Down
DROP TABLE IF EXISTS signup_orders;
