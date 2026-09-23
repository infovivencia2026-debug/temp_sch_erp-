-- +goose Up

-- ONE COUNTER PER FINANCIAL YEAR, NOT ONE COUNTER THAT REMEMBERS A YEAR.
--
-- numbering_schemes holds a single next_value and the year it is counting
-- within (current_fy). NextNumberOn reset it to 1 whenever a document's year
-- differed from current_fy -- in EITHER direction. Collect passes the payment
-- date on purpose, so a receipt written up on 2 April for cash taken on
-- 31 March belongs to the closing year's series. That back-date rewound the
-- counter to the old year; the very next counter receipt saw a mismatch again,
-- reset to 1 for the new year, and collided with the new year's 00001. Every
-- collection at the counter then failed until somebody hand-edited this table.
--
-- The fix is the obvious shape: a row per (kind, year). Each year's series
-- advances independently, so a back-dated receipt draws from last year's
-- series and this year's is untouched.
CREATE TABLE numbering_fy_counters (
    institution_id uuid   NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    kind           text   NOT NULL,
    fy             text   NOT NULL,
    next_value     bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (institution_id, kind, fy)
);
COMMENT ON TABLE numbering_fy_counters IS
    'The next sequence number per document kind per financial year. numbering_schemes keeps the format; this keeps the count. Locked FOR UPDATE by fees.NextNumberOn.';

ALTER TABLE numbering_fy_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE numbering_fy_counters FORCE  ROW LEVEL SECURITY;
CREATE POLICY numbering_fy_counters_tenant ON numbering_fy_counters
    USING      (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON numbering_fy_counters TO app_user;

-- Seeded so nothing already printed is ever reissued. The migration runs with
-- no tenant set; the lift is what lets it see the rows.
SET LOCAL app.is_platform_admin = 'on';

-- The year each counter is counting within continues at its current count.
INSERT INTO numbering_fy_counters (institution_id, kind, fy, next_value)
SELECT institution_id, kind, current_fy, next_value
  FROM numbering_schemes
 WHERE campus_id IS NULL AND reset_yearly AND current_fy IS NOT NULL
ON CONFLICT DO NOTHING;

-- Earlier years continue after the last receipt they actually issued, read
-- from the sequence recorded on each payment (00045) -- so the common
-- back-date, into the year that just closed, lands after that year's last
-- number rather than on its first.
INSERT INTO numbering_fy_counters (institution_id, kind, fy, next_value)
SELECT institution_id, 'receipt', receipt_fy, max(receipt_seq) + 1
  FROM payments
 WHERE receipt_seq IS NOT NULL AND receipt_fy IS NOT NULL
 GROUP BY institution_id, receipt_fy
ON CONFLICT DO NOTHING;

-- A WHOLE-YEAR BILL SAYS SO.
--
-- The admission invoice for a family that settles the year up front carries
-- every instalment and was stamped instalment_no = 1. The demand run's guard
-- against billing twice matches on instalment_no, so instalment 2 found no
-- invoice for the child and billed the term again -- and instalment 3 again.
-- The family was chased for money already paid, with fines accruing on both.
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS covers_year boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN invoices.covers_year IS
    'This one bill carries every instalment of the year. The demand run skips a child who holds one, whatever instalment is being raised.';

-- +goose Down
ALTER TABLE invoices DROP COLUMN IF EXISTS covers_year;
DROP TABLE IF EXISTS numbering_fy_counters;
