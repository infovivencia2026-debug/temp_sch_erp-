-- +goose Up
-- DIGITAL MONEY, PHASE 3: the petty-cash tin as a managed float.
--
-- Petty cash already exists as a voucher register with approval and a real GL
-- posting (00033): a slip is raised, someone approves it, and Dr expense /
-- Cr petty-cash lands in journal_entries. What it never had was the other
-- half of an imprest system -- the float itself. There was no float amount,
-- no way to put money INTO the tin except a hand-posted journal, no drawer
-- count, and no bar on approving your own slip. The balance shown as "in the
-- tin" started at zero and went negative as slips were approved.
--
-- This adds the three missing pieces, on the existing accounts:
--   1. a float size and a custodian on ledger_settings;
--   2. petty_cash_topups -- replenishment, posted Dr petty / Cr bank-or-cash
--      through the same postVoucher with its own source_kind, so a retried
--      top-up cannot post twice;
--   3. petty_cash_counts -- "count the drawer": the counted cash against what
--      the ledger says, the variance generated, and a reason required when it
--      is not zero. Modelled on pos_till_sessions (00094), which already does
--      this for the sales tills.
-- The self-approval bar and the overdraw guard are enforced in the handler,
-- where the limit and the live balance are already read.

ALTER TABLE ledger_settings
    -- How much the tin is meant to hold when full. Replenish-to-float is
    -- float minus what the ledger says is in it. Zero means "not set".
    ADD COLUMN petty_cash_float_paise bigint NOT NULL DEFAULT 0
        CHECK (petty_cash_float_paise >= 0),
    -- Who holds the tin. Advisory today: named on the screen and on counts.
    ADD COLUMN petty_cash_custodian_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE petty_cash_topups (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    topup_date        date NOT NULL DEFAULT CURRENT_DATE,
    amount_paise      bigint NOT NULL CHECK (amount_paise > 0),
    -- Where the money came from: the bank or the main cash account.
    from_account_id   uuid NOT NULL,
    reference_no      text,
    note              text,
    journal_entry_id  uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (from_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE RESTRICT
);
CREATE INDEX petty_cash_topups_inst ON petty_cash_topups (institution_id, topup_date DESC);

CREATE TABLE petty_cash_counts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    counted_on        date NOT NULL DEFAULT CURRENT_DATE,
    -- What the ledger said was in the tin at the moment of counting, frozen
    -- here so the variance stays true after later postings.
    book_paise        bigint NOT NULL,
    counted_paise     bigint NOT NULL CHECK (counted_paise >= 0),
    variance_paise    bigint GENERATED ALWAYS AS (counted_paise - book_paise) STORED,
    variance_reason   text,
    counted_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    -- A drawer that does not agree with the book needs a sentence saying why.
    CONSTRAINT petty_cash_count_variance_explained
        CHECK (counted_paise = book_paise OR nullif(btrim(variance_reason), '') IS NOT NULL)
);
CREATE INDEX petty_cash_counts_inst ON petty_cash_counts (institution_id, counted_on DESC);

ALTER TABLE petty_cash_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_topups FORCE  ROW LEVEL SECURITY;
CREATE POLICY petty_cash_topups_tenant ON petty_cash_topups
    USING      (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON petty_cash_topups TO app_user;

ALTER TABLE petty_cash_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_counts FORCE  ROW LEVEL SECURITY;
CREATE POLICY petty_cash_counts_tenant ON petty_cash_counts
    USING      (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON petty_cash_counts TO app_user;

-- +goose Down
DROP TABLE IF EXISTS petty_cash_counts;
DROP TABLE IF EXISTS petty_cash_topups;
ALTER TABLE ledger_settings
    DROP COLUMN IF EXISTS petty_cash_custodian_id,
    DROP COLUMN IF EXISTS petty_cash_float_paise;
