-- +goose Up
-- DIGITAL MONEY, PHASE 2: spending the wallet — at the canteen and store
-- counters, and against fees.
--
-- Phase 1 (00322) put money IN. This lets it come OUT, in the two places a
-- family expects: the child buys lunch and the till draws from their balance,
-- or the office settles a fee from it. Both are ordinary sales and ordinary
-- payments that happen to be paid a new way, so each rides its existing table
-- (pos_sales, payments) with one more allowed payment_mode, and the wallet
-- ledger gets a matching 'spend' row in the same transaction. The balance
-- trigger from 00322 refuses to go below zero, so an overdraft aborts the sale
-- or the payment along with it — the wallet is prepaid, not credit.
--
-- A spend points back at what it paid for: payment_id for a fee (already
-- there), pos_sale_id for a counter sale (added here). One event, two rows,
-- linked — so neither the ledger nor the till counts it twice.

-- The counter: cash, the fee account, or the wallet. A wallet sale, like an
-- account charge, needs a child to draw from.
ALTER TABLE pos_sales DROP CONSTRAINT pos_sales_payment_mode;
ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_payment_mode
    CHECK (payment_mode IN ('cash', 'account', 'wallet'));
ALTER TABLE pos_sales DROP CONSTRAINT pos_sales_account_needs_student;
ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_account_needs_student
    CHECK (payment_mode NOT IN ('account', 'wallet') OR student_id IS NOT NULL);

-- The fee counter: a payment settled from the wallet.
ALTER TABLE payments DROP CONSTRAINT payments_mode_check;
ALTER TABLE payments ADD CONSTRAINT payments_mode_check
    CHECK (mode IN ('cash', 'cheque', 'dd', 'neft', 'upi', 'card', 'netbanking',
                    'gateway', 'adjustment', 'wallet'));

ALTER TABLE wallet_transactions
    ADD COLUMN pos_sale_id uuid REFERENCES pos_sales(id) ON DELETE SET NULL;
CREATE INDEX wallet_transactions_pos_sale ON wallet_transactions (pos_sale_id)
    WHERE pos_sale_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS wallet_transactions_pos_sale;
ALTER TABLE wallet_transactions DROP COLUMN IF EXISTS pos_sale_id;

ALTER TABLE payments DROP CONSTRAINT payments_mode_check;
ALTER TABLE payments ADD CONSTRAINT payments_mode_check
    CHECK (mode IN ('cash', 'cheque', 'dd', 'neft', 'upi', 'card', 'netbanking',
                    'gateway', 'adjustment'));

ALTER TABLE pos_sales DROP CONSTRAINT pos_sales_account_needs_student;
ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_account_needs_student
    CHECK (payment_mode <> 'account' OR student_id IS NOT NULL);
ALTER TABLE pos_sales DROP CONSTRAINT pos_sales_payment_mode;
ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_payment_mode
    CHECK (payment_mode IN ('cash', 'account'));
