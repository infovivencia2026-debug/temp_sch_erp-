-- +goose Up
-- How many times the office has printed a payment's receipt.
--
-- The first print from the counter is the original; every later one is
-- marked DUPLICATE on the paper, which is how a school tells a reprint from
-- a second payment. Counted only after the PDF was actually produced, so a
-- failed print does not turn the next good one into a duplicate. A family
-- downloading its own copy from the portal is not counted.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_prints integer NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE payments DROP COLUMN IF EXISTS receipt_prints;
