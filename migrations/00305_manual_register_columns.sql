-- +goose Up

-- THE THREE THINGS A PAPER FEE REGISTER HAS AND THIS DID NOT.
--
-- A school moving off a register finds most of its columns already here under
-- another name: the concession column is fee_concessions, the fine column is
-- fee_fine_charges, last year's dues are invoice_carry_forwards, and the
-- balance is not stored at all because net_paise - paid_paise cannot go stale.
--
-- Three columns had nowhere to land, and each one is the reason somebody keeps
-- the paper book open beside the screen.

-- 1. The remark against ONE CHILD'S BILL.
--
-- invoices carried cancelled_reason and nothing else, so "half now, father
-- spoke to the principal" or "sibling's fee adjusted here" had to go in the
-- payment remark -- where it attaches to the money rather than the demand, and
-- vanishes entirely on a bill nobody has paid yet. That is exactly the case
-- the note exists to explain.
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN invoices.note IS
    'Free remark against this bill: why it differs, what was agreed. Not printed unless the receipt template asks for it.';

-- 2. WHO ACTUALLY HANDED THE MONEY OVER.
--
-- payments recorded the mode and the staff member who took it, never the
-- person paying. At a counter where an uncle pays for two nephews and a driver
-- pays for the family he works for, "who brought this" is the question the
-- office asks the register three months later, and the answer was nowhere.
--
-- Free text, not a foreign key to guardians: the payer is frequently not a
-- registered guardian, and forcing one would either block the receipt or
-- create a fictitious guardian record to get past the form.
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS payer_name     text,
    ADD COLUMN IF NOT EXISTS payer_relation text;

COMMENT ON COLUMN payments.payer_name IS
    'Who handed the money over, as written on the counterfoil. Blank means the school did not record it.';
COMMENT ON COLUMN payments.payer_relation IS
    'How they relate to the child: father, uncle, self, driver. Free text on purpose.';

-- 3. Nothing. The ad-hoc discount stays a fee_concession.
--
-- A register writes "-500" in a box. Doing that here would need a column that
-- reduces a bill with no reason and no approver attached, which is the one
-- thing an auditor asks about and the one thing the paper book cannot answer.
-- fee_concessions already carries kind, amount or percent, reason and
-- approved_by, and the fee run applies it per head. Slower to type, and the
-- difference between a discount and a hole in the collection.

-- +goose Down
ALTER TABLE payments DROP COLUMN IF EXISTS payer_relation;
ALTER TABLE payments DROP COLUMN IF EXISTS payer_name;
ALTER TABLE invoices DROP COLUMN IF EXISTS note;
