-- +goose Up
-- Fee module additions.
--
-- The baseline covers heads, structures, invoices, payments, allocations,
-- concessions and refunds. Three things an Indian school needs are missing:
-- late-fine rules, GST treatment per head, and a way to hold post-dated
-- cheques without them counting as collected money.

-- GST on school fees is not uniform: tuition for a recognised school is exempt,
-- while transport, uniforms and canteen are usually taxable. Rate is stored in
-- basis points to stay integral — 1800 = 18.00%.
ALTER TABLE fee_heads
    ADD COLUMN IF NOT EXISTS gst_rate_bp integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS hsn_sac     text,
    ADD COLUMN IF NOT EXISTS is_taxable  boolean NOT NULL DEFAULT false;

ALTER TABLE fee_heads
    ADD CONSTRAINT fee_heads_gst_rate_bp_check
        CHECK (gst_rate_bp >= 0 AND gst_rate_bp <= 10000);

-- Late fines. Schools express these three ways, so the rule carries a kind
-- rather than assuming one: a flat charge, a per-day charge, or a percentage
-- of the outstanding amount. cap_paise stops a daily fine growing without
-- bound on an invoice nobody chases.
CREATE TABLE IF NOT EXISTS fee_fine_rules (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id        uuid REFERENCES campuses(id) ON DELETE CASCADE,
    fee_structure_id uuid REFERENCES fee_structures(id) ON DELETE CASCADE,
    name             text NOT NULL,
    kind             text NOT NULL,
    grace_days       integer NOT NULL DEFAULT 0,
    amount_paise     bigint  NOT NULL DEFAULT 0,
    percent          numeric(5,2),
    cap_paise        bigint,
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fee_fine_rules_kind_check
        CHECK (kind = ANY (ARRAY['fixed','per_day','percent'])),
    CONSTRAINT fee_fine_rules_grace_check   CHECK (grace_days >= 0),
    CONSTRAINT fee_fine_rules_amount_check  CHECK (amount_paise >= 0),
    CONSTRAINT fee_fine_rules_percent_check
        CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100)),
    -- A percent rule without a percent, or a per_day rule without an amount,
    -- would silently compute zero.
    CONSTRAINT fee_fine_rules_complete_check CHECK (
        (kind = 'percent' AND percent IS NOT NULL) OR
        (kind IN ('fixed','per_day') AND amount_paise > 0)
    )
);

CREATE INDEX IF NOT EXISTS fee_fine_rules_institution
    ON fee_fine_rules (institution_id, is_active);

-- Post-dated cheques are recorded as payments with status 'pending' so they
-- appear on the student's ledger as promised money, but they must never count
-- as collection until they clear. Every collection figure therefore filters on
-- status = 'success'; this index keeps the PDC register cheap to list.
CREATE INDEX IF NOT EXISTS payments_pdc
    ON payments (institution_id, cheque_date)
    WHERE status = 'pending' AND mode IN ('cheque','dd');

-- Allocation lookups by invoice drive the ledger view.
CREATE INDEX IF NOT EXISTS payment_allocations_invoice
    ON payment_allocations (invoice_id);

-- Data-modifying migrations run under FORCE ROW LEVEL SECURITY like everything
-- else, and the migration connection sets no tenant GUC — so an unguarded
-- "INSERT ... SELECT FROM institutions" reads zero rows and silently inserts
-- nothing. Claim platform scope for the rest of this transaction.
-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd

-- Seed the receipt and invoice numbering counters. next_value is advanced under
-- a row lock when a receipt is issued, which is what makes the series gapless.
-- The allocator also creates a missing scheme on demand, so an institution
-- added after this migration still gets a counter.
INSERT INTO numbering_schemes (institution_id, kind, prefix, padding, next_value, reset_yearly)
SELECT i.id, k.kind, k.prefix, 5, 1, true
  FROM institutions i
  CROSS JOIN (VALUES ('receipt','RCPT/'), ('invoice','INV/')) AS k(kind, prefix)
ON CONFLICT DO NOTHING;

-- +goose Down
DROP INDEX IF EXISTS payment_allocations_invoice;
DROP INDEX IF EXISTS payments_pdc;
DROP TABLE IF EXISTS fee_fine_rules;
ALTER TABLE fee_heads
    DROP COLUMN IF EXISTS gst_rate_bp,
    DROP COLUMN IF EXISTS hsn_sac,
    DROP COLUMN IF EXISTS is_taxable;
