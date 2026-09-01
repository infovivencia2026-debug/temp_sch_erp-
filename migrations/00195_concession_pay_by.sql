-- +goose Up
-- The date a whole-year payment has to arrive by.
--
-- "Pay all three terms in one instalment" is a discount given in exchange for
-- the school having the money early. Without a date it is a discount given in
-- exchange for nothing: the family takes the reduced figure and pays whenever,
-- and the school has no way to say the offer has lapsed.
--
-- Only meaningful on kind = 'full_payment'; every other concession is a
-- property of the family, not of when they pay.
ALTER TABLE fee_concessions ADD COLUMN IF NOT EXISTS pay_by date;

COMMENT ON COLUMN fee_concessions.pay_by IS
  'For full_payment: the date the whole year must be settled by. Becomes the '
  'invoice due date, so the ordinary reminder and overdue machinery chases it.';

-- +goose Down
ALTER TABLE fee_concessions DROP COLUMN IF EXISTS pay_by;
