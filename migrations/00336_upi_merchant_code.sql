-- +goose Up

-- THE QR A MERCHANT ACCOUNT WILL ACTUALLY ACCEPT.
--
-- `upi://pay?pa=&pn=&am=&cu=&tn=` is a complete and valid intent for a PERSONAL
-- address, and that is what this shipped. A school that asked its bank for a
-- MERCHANT collection account gets a different contract: the payee resolves as
-- a merchant, and UPI apps then validate the code as a merchant QR and refuse
-- one that carries no merchant category. The parent sees "invalid QR" at the
-- counter, with a code that is provably well-formed by every other measure.
--
-- The category is a four-digit ISO 18245 code the bank assigns. Schools are
-- 8211 (elementary and secondary schools); a college or a trust may be given
-- something else, so it is recorded rather than assumed.
--
-- NULL means a personal address, which is the majority and the existing
-- behaviour: no mc, no tr, exactly the intent that works today. Nothing about
-- an existing school's code changes until somebody fills this in.
ALTER TABLE institutions
    ADD COLUMN IF NOT EXISTS upi_merchant_code text;

ALTER TABLE institutions
    DROP CONSTRAINT IF EXISTS institutions_upi_merchant_code_check;
ALTER TABLE institutions
    ADD CONSTRAINT institutions_upi_merchant_code_check
    CHECK (upi_merchant_code IS NULL OR upi_merchant_code ~ '^[0-9]{4}$');

COMMENT ON COLUMN institutions.upi_merchant_code IS
    'ISO 18245 merchant category code from the bank, for a merchant UPI account (schools are usually 8211). NULL for an ordinary personal VPA, which needs none.';

-- +goose Down
ALTER TABLE institutions DROP CONSTRAINT IF EXISTS institutions_upi_merchant_code_check;
ALTER TABLE institutions DROP COLUMN IF EXISTS upi_merchant_code;
