-- +goose Up

-- THE SCHOOL'S OWN UPI ADDRESS, SO A FEE CAN BE PAID BY SCANNING.
--
-- Every fee counter in the country already has a laminated QR taped to it.
-- The parent scans, the money lands in the school's account the same second,
-- and the clerk types the UTR into the register. Nothing about that needs a
-- payment gateway, a merchant onboarding or a webhook: it needs the school's
-- VPA and a code that carries the amount and a note the bank statement will
-- show.
--
-- This is deliberately NOT the payment_gateway_credentials table (00241). A
-- gateway pulls money and tells the system; a UPI address is a place money is
-- sent, and the office still records it. The two live in different columns so
-- nothing can mistake one for the other, and the parent's screen says in words
-- that the receipt follows once the office records the transfer.
--
-- The shape check is the NPCI virtual payment address: handle@psp, the handle
-- alphanumerics with dot, hyphen and underscore, the PSP suffix alphanumeric.
-- A wrong VPA is worse than none: it would be printed on every fee screen and
-- the money would go to whoever holds it.
ALTER TABLE institutions
    ADD COLUMN IF NOT EXISTS upi_vpa text,
    ADD COLUMN IF NOT EXISTS upi_payee_name text;

ALTER TABLE institutions
    ADD CONSTRAINT institutions_upi_vpa_shape
    CHECK (upi_vpa IS NULL OR upi_vpa ~ '^[A-Za-z0-9._-]{3,}@[A-Za-z0-9]{2,}$');

COMMENT ON COLUMN institutions.upi_vpa IS
    'The school''s UPI address for fee collection (handle@psp). NULL means no UPI QR is offered anywhere.';
COMMENT ON COLUMN institutions.upi_payee_name IS
    'What the payer''s UPI app shows as the payee. NULL falls back to the school''s name.';

-- +goose Down
ALTER TABLE institutions DROP CONSTRAINT IF EXISTS institutions_upi_vpa_shape;
ALTER TABLE institutions DROP COLUMN IF EXISTS upi_vpa, DROP COLUMN IF EXISTS upi_payee_name;
