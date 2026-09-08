-- +goose Up

-- Where last year's unpaid balance went.
--
-- Nothing in the fee engine carried money across a year. A family that owed
-- two terms on 31 March started April owing nothing on the new year's bill:
-- the old invoices stayed open in the ledger, but the demand raised in June
-- was built from the new structure alone, and that is the paper the family
-- receives and pays against. Arrears were chased from memory.
--
-- The demand run now brings the balance forward as a line on the new
-- invoice and settles the old one by an adjustment, so the amount exists in
-- exactly one open place. This table is the join between the two: which old
-- invoice, which new one, the adjustment that closed the old, and how much.
-- Without it a brought-forward line is a number with no provenance, and
-- the first question a parent asks about it is "from what".
CREATE TABLE invoice_carry_forwards (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    from_invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    to_invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    payment_id       uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    amount_paise     bigint NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invoice_carry_forwards_amount CHECK (amount_paise > 0),
    CONSTRAINT invoice_carry_forwards_moves  CHECK (from_invoice_id <> to_invoice_id)
);

-- An old invoice is carried once. A second carry would bill the same debt
-- twice, and the adjustment that settled it makes a second one impossible
-- anyway; the index says so before the ledger has to.
CREATE UNIQUE INDEX invoice_carry_forwards_once ON invoice_carry_forwards (from_invoice_id);
CREATE INDEX invoice_carry_forwards_to ON invoice_carry_forwards (institution_id, to_invoice_id);

ALTER TABLE invoice_carry_forwards ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_carry_forwards FORCE  ROW LEVEL SECURITY;
CREATE POLICY invoice_carry_forwards_tenant ON invoice_carry_forwards
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_carry_forwards TO app_user;

-- +goose Down

DROP TABLE IF EXISTS invoice_carry_forwards;
