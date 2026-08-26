-- +goose Up

/* Whether the form fee has been paid.
 *
 * The catalogue has promised this since the module was written — the
 * Application Forms entry says the list is "searchable by class and by whether
 * the form fee is paid" — and there was nowhere to record it. A clerk taking
 * five hundred rupees across the counter had to keep it in a separate book,
 * which is exactly the thing a school buys this to stop doing.
 *
 * Paise, not rupees, and bigint, like every other money column here: a fee
 * held as a float rounds, and a rounded receipt is one the auditor asks about.
 *
 * Nullable amount rather than zero-means-free. A school that charges no form
 * fee must be distinguishable from one that charges and has not been paid, and
 * NULL says "no fee applies" where 0 would be a paid fee of nothing.
 */
ALTER TABLE applications
    ADD COLUMN form_fee_paise      bigint,
    ADD COLUMN form_fee_paid_at    timestamptz,
    ADD COLUMN form_fee_receipt_no text;

/* Paid means paid for something.
 *
 * A payment timestamp against no amount is unreadable six months later — was
 * it free, or did somebody tick the box on a form whose fee nobody set? The
 * constraint makes the meaningless state impossible rather than merely
 * unlikely. */
ALTER TABLE applications
    ADD CONSTRAINT applications_form_fee_amount
        CHECK (form_fee_paise IS NULL OR form_fee_paise >= 0),
    ADD CONSTRAINT applications_form_fee_paid_has_amount
        CHECK (form_fee_paid_at IS NULL OR form_fee_paise IS NOT NULL);

/* The unpaid ones are the query that gets run — a clerk chasing the fees owed
 * on this session's forms — so that is the index, not one over the whole
 * column. Partial, because the paid rows accumulate forever and are never the
 * thing being looked for. */
CREATE INDEX applications_form_fee_unpaid
    ON applications (institution_id, created_at DESC)
 WHERE form_fee_paise IS NOT NULL AND form_fee_paid_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS applications_form_fee_unpaid;
ALTER TABLE applications
    DROP CONSTRAINT IF EXISTS applications_form_fee_paid_has_amount,
    DROP CONSTRAINT IF EXISTS applications_form_fee_amount,
    DROP COLUMN IF EXISTS form_fee_receipt_no,
    DROP COLUMN IF EXISTS form_fee_paid_at,
    DROP COLUMN IF EXISTS form_fee_paise;
