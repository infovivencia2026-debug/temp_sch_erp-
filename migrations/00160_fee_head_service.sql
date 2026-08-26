-- +goose Up

/* Which fee heads are for a service the family has to opt into.
 *
 * The admission panel billed every child the transport fee, because the fee
 * structure lists it and nothing said it was conditional. A family living two
 * streets away was quoted eight hundred rupees for a bus they will never use —
 * and worse, the invoice was raised that way, so somebody had to notice and
 * unpick it later.
 *
 * Tuition is owed by being enrolled. Transport is owed by taking the bus, and
 * hostel by living in. That difference is a property of the fee head, not of
 * the class or the structure, so it belongs here.
 *
 * Null means unconditional, which is what every existing head was and stays.
 */
ALTER TABLE fee_heads
    ADD COLUMN IF NOT EXISTS service text;

-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fee_heads_service') THEN
        ALTER TABLE fee_heads
            ADD CONSTRAINT fee_heads_service
                CHECK (service IS NULL OR service IN ('transport', 'hostel')) NOT VALID;
        ALTER TABLE fee_heads VALIDATE CONSTRAINT fee_heads_service;
    END IF;
END $$;
-- +goose StatementEnd

/* Mark what is already there.
 *
 * By name and code, matched loosely, because these heads were typed by each
 * school rather than chosen from a list — "Transport Fee", "Bus Fee", "TRAN".
 * A school that names theirs something else marks it themselves, and until
 * they do it behaves exactly as it does today: charged to everybody. Guessing
 * wider than this would start silently dropping fees off invoices, which is
 * the worse error of the two.
 */
UPDATE fee_heads
   SET service = 'transport'
 WHERE service IS NULL
   AND (lower(name) LIKE '%transport%' OR lower(name) LIKE '%bus%'
        OR lower(code) IN ('tran', 'trans', 'bus'));

UPDATE fee_heads
   SET service = 'hostel'
 WHERE service IS NULL
   AND (lower(name) LIKE '%hostel%' OR lower(name) LIKE '%boarding%'
        OR lower(name) LIKE '%mess%'
        OR lower(code) IN ('host', 'hstl', 'mess'));

-- +goose Down
ALTER TABLE fee_heads DROP CONSTRAINT IF EXISTS fee_heads_service;
ALTER TABLE fee_heads DROP COLUMN IF EXISTS service;
