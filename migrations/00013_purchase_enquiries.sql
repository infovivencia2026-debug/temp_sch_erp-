-- +goose Up
-- Where a prospective school lands before it is a customer.
--
-- The commercial cycle now runs seller → tenant → principal → tour, but it had
-- no front door: a school that wanted to buy had to already know somebody. The
-- public pricing page needs somewhere to put an enquiry, and that somewhere
-- cannot be a tenant table, because at this point there is no tenant.
--
-- No institution_id and no RLS, for the same reason as plans and
-- subscriptions: this is the vendor's data about a school that does not exist
-- yet. It is read only by the seller console, which requires
-- platform.tenants.write.

CREATE TABLE purchase_enquiries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_name     text        NOT NULL,
    contact_name    text        NOT NULL,
    email           citext,
    phone           text,
    district        text,
    state           text,
    board           text,
    students        integer,
    plan_code       text        REFERENCES plans(code) ON DELETE SET NULL,
    message         text,
    status          text        NOT NULL DEFAULT 'new',
    -- Set once the enquiry becomes a tenant, so the console can show which
    -- leads converted rather than leaving them open for ever.
    provisioned_institution_id uuid REFERENCES institutions(id) ON DELETE SET NULL,
    -- Where the enquiry came from, for whoever is paying for the advertising.
    source          text        NOT NULL DEFAULT 'website',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT purchase_enquiries_status_check
        CHECK (status IN ('new','contacted','demo_booked','won','lost')),
    -- A lead nobody can telephone or email is not a lead.
    CONSTRAINT purchase_enquiries_reachable
        CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX purchase_enquiries_open
    ON purchase_enquiries (created_at DESC)
 WHERE status IN ('new','contacted','demo_booked');

-- +goose Down
DROP TABLE IF EXISTS purchase_enquiries;
