-- +goose Up

/* When the form fee was paid.
 *
 * The amount and the receipt number have been on this table since the
 * admissions funnel landed (00026) and no code ever read or wrote either. What
 * was never there is the answer to the only question a clerk actually asks —
 * has this one paid? An amount alone cannot say: it is the price, not the
 * payment, and every unpaid form carries it too.
 *
 * So one column, not four. The catalogue has promised the rest all along: the
 * Application Forms entry says the list is "searchable by class and by whether
 * the form fee is paid", and this is the column that makes that sentence true.
 */
ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS form_fee_paid_at timestamptz;

/* Paid means paid for something.
 *
 * A payment timestamp against no amount is unreadable six months later — was
 * the form free, or did somebody tick a box on a form whose fee nobody set?
 * The constraint makes the meaningless state impossible rather than merely
 * unlikely.
 *
 * NOT VALID, then validated: the table already holds rows, and a plain ADD
 * CONSTRAINT takes an ACCESS EXCLUSIVE lock for a full scan. Every application
 * currently has a NULL timestamp so the scan will pass, but the two-step is
 * what keeps the admissions desk working while it runs.
 */
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'applications_form_fee_paid_has_amount') THEN
        ALTER TABLE applications
            ADD CONSTRAINT applications_form_fee_paid_has_amount
                CHECK (form_fee_paid_at IS NULL OR form_fee_paise IS NOT NULL) NOT VALID;
        ALTER TABLE applications
            VALIDATE CONSTRAINT applications_form_fee_paid_has_amount;
    END IF;
END $$;
-- +goose StatementEnd

/* The unpaid ones are the query that gets run — a clerk chasing the fees owed
 * on this session's forms — so that is the index, not one over the whole
 * column. Partial, because the paid rows accumulate forever and are never the
 * thing being looked for. */
CREATE INDEX IF NOT EXISTS applications_form_fee_unpaid
    ON applications (institution_id, created_at DESC)
 WHERE form_fee_paise IS NOT NULL AND form_fee_paid_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS applications_form_fee_unpaid;
ALTER TABLE applications
    DROP CONSTRAINT IF EXISTS applications_form_fee_paid_has_amount;
ALTER TABLE applications
    DROP COLUMN IF EXISTS form_fee_paid_at;
