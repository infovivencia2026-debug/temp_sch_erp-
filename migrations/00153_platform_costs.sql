-- +goose Up
-- +goose StatementBegin

/* What the installation costs to run, so a school's price can be read against it.

   A vendor can see what every school pays and has no way to see what any of
   them costs. That makes the only number on the panel — revenue — half a
   sentence: a school paying ₹8,000 a month is a good customer or a bad one
   depending on a figure nobody has written down.

   The bill is not discoverable from inside the product. Nothing here knows what
   the server costs, what the backups cost, or what the mail provider charges;
   those are invoices that arrive by email. So the vendor enters them, once, and
   the product does the part it can actually do — apportioning them across
   schools by what each one actually uses.

   One row. Deliberately not a history: this answers "what does it cost now",
   and a vendor who wants last quarter's margin has an accounting system for
   that. The row is versioned only by updated_at, which is enough to know
   whether the figures are stale. */
CREATE TABLE IF NOT EXISTS platform_costs (
    id             boolean PRIMARY KEY DEFAULT true,
    -- Everything billed monthly and not per-unit: servers, backups, monitoring.
    infra_paise    bigint NOT NULL DEFAULT 0,
    -- Per gigabyte per month, applied to what each school has actually stored.
    storage_paise_per_gb bigint NOT NULL DEFAULT 0,
    -- Per message, because these are the costs a school can run up on its own.
    sms_paise      bigint NOT NULL DEFAULT 0,
    email_paise    bigint NOT NULL DEFAULT 0,
    whatsapp_paise bigint NOT NULL DEFAULT 0,
    notes          text NOT NULL DEFAULT '',
    updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    -- One row, enforced rather than hoped for: a second set of costs would be
    -- silently averaged by whichever query read first.
    CONSTRAINT platform_costs_single_row CHECK (id)
);

INSERT INTO platform_costs (id) VALUES (true) ON CONFLICT DO NOTHING;

/* Belongs to the platform, so no tenant column and no policy. A school must
   never read what the vendor's margin on it is. */

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS platform_costs;
-- +goose StatementEnd
