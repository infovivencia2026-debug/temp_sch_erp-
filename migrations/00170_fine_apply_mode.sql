-- +goose Up

/* When a term's late fine is charged, as opposed to how much it is.
 *
 * The engine could only ever raise a fine against the invoice that was late.
 * That is one of the two things schools do. The other is to let the fines
 * accrue term by term and put them all on the final instalment, so a family is
 * handed one charge at the end of the year rather than three during it —
 * usually because the school would rather not have that conversation twice in
 * October and again in January.
 *
 * Which one is a policy, not a calculation: the amount is identical either
 * way. So this is a column on the rule and nothing in fines.go changes about
 * how much is owed — only which invoice carries it.
 *
 * Exemptions are NOT here. fee_fine_rules already carries
 * exempt_concession_kinds from 00045, with the same six kinds
 * fee_concessions uses, and the rule editor already offers them. I started to
 * add a second column for the same fact before reading that far, which would
 * have been two answers to "does this rule fine a staff ward".
 */
ALTER TABLE fee_fine_rules
    ADD COLUMN IF NOT EXISTS apply_mode text NOT NULL DEFAULT 'per_invoice';

-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'fee_fine_rules_apply_mode') THEN
        ALTER TABLE fee_fine_rules
            ADD CONSTRAINT fee_fine_rules_apply_mode
                CHECK (apply_mode IN ('per_invoice','final_term'));
    END IF;
END $$;
-- +goose StatementEnd

COMMENT ON COLUMN fee_fine_rules.apply_mode IS
    'per_invoice charges each term as it falls due; final_term accrues the '
    'same amounts and raises them all against the last instalment of the year.';

-- +goose Down
ALTER TABLE fee_fine_rules DROP CONSTRAINT IF EXISTS fee_fine_rules_apply_mode;
ALTER TABLE fee_fine_rules DROP COLUMN IF EXISTS apply_mode;
