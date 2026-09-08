-- +goose Up

-- The refunds table could be read and never written.
--
-- listRefunds was the only handler; nothing created, approved or paid a
-- refund, so the payout batch that consumes status='approved' was
-- permanently empty and the dashboard's "refunds pending" always read
-- nought. A child leaving in November with two terms paid and unused had no
-- settlement path in the product at all.
--
-- The write path needs four things the table did not have: the decision's
-- reason (a refusal with nothing beside it is the one the parent rings
-- about), when it was decided, who paid it out, and the bank reference of
-- the payout -- the UTR or cheque number a family quotes when they say the
-- money never arrived.
ALTER TABLE refunds
    ADD COLUMN IF NOT EXISTS decision_note text,
    ADD COLUMN IF NOT EXISTS approved_at   timestamptz,
    ADD COLUMN IF NOT EXISTS processed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reference_no  text;

-- +goose Down

ALTER TABLE refunds
    DROP COLUMN IF EXISTS reference_no,
    DROP COLUMN IF EXISTS processed_by,
    DROP COLUMN IF EXISTS approved_at,
    DROP COLUMN IF EXISTS decision_note;
