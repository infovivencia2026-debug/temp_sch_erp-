-- 0135_fee_line_allocations (tenant: every school database).
-- A payment now lands on the fee and instalment it paid, not only on the
-- bill (owner, 2026-11-21, "Fees all in one place"). Three things:
--
-- 1. payment_line_allocations: each payment_allocations row (payment ->
--    invoice) split over that invoice's lines (fee head). Hangs off the
--    allocation with ON DELETE CASCADE, so a void, bounce or move that
--    removes the allocation removes its lines too.
-- 2. payments.txn_id: a transaction ID shown beside the receipt number.
--    An extra field only; receipt_no and its series are not touched.
--    payments.receiving_account: the account the money went into.
-- 3. fee_requests: cancel / change / remove fee / edit amount / transfer /
--    class change requests that wait for approval.
--
-- BACKFILL ORDER (deterministic; totals do not change):
--   per invoice, existing allocations are taken in payment order
--   (paid_on, created_at, allocation created_at, allocation id) and laid
--   end to end; the invoice's lines are laid end to end in rowid order
--   (the order they were billed), each line worth amount - discount.
--   Each allocation gets the overlap with each line. Anything beyond the
--   lines' total (late fee, rounding) is kept as one row with no line.
--   So every allocation's line rows sum to exactly its amount, and every
--   payment's and invoice's totals are unchanged.
--
-- Forward-only: once applied anywhere this file must not change.
-- No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE IF NOT EXISTS payment_line_allocations (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  payment_allocation_id TEXT NOT NULL REFERENCES payment_allocations(id) ON DELETE CASCADE,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_line_id TEXT REFERENCES invoice_lines(id) ON DELETE SET NULL,
  fee_head_id TEXT REFERENCES fee_heads(id) ON DELETE SET NULL,
  amount_paise INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pla_payment ON payment_line_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_pla_line ON payment_line_allocations(invoice_line_id);
CREATE INDEX IF NOT EXISTS idx_pla_alloc ON payment_line_allocations(payment_allocation_id);

ALTER TABLE payments ADD COLUMN txn_id TEXT;
-- Which school account the money went into (Cash, a bank account): picked at the counter.
ALTER TABLE payments ADD COLUMN receiving_account TEXT;
-- The fee lines a held cheque is meant for, used when it clears (JSON).
ALTER TABLE payments ADD COLUMN line_plan TEXT;
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference_no);

CREATE TABLE IF NOT EXISTS fee_requests (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payment_id TEXT REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_line_id TEXT REFERENCES invoice_lines(id) ON DELETE SET NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  request_ip TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_fee_requests_student ON fee_requests(student_id, status);

UPDATE payments SET txn_id = 'T' || strftime('%Y%m%d%H%M%S', created_at) || upper(substr(replace(id, '-', ''), 1, 6))
 WHERE txn_id IS NULL;

INSERT INTO payment_line_allocations (institution_id, payment_allocation_id, payment_id, invoice_id, invoice_line_id, fee_head_id, amount_paise, source)
WITH lc AS (
  SELECT il.id, il.invoice_id, il.fee_head_id, max(il.amount_paise - il.discount_paise, 0) AS cap,
         sum(max(il.amount_paise - il.discount_paise, 0)) OVER (PARTITION BY il.invoice_id ORDER BY il.rowid) AS hi
    FROM invoice_lines il
), l2 AS (SELECT id, invoice_id, fee_head_id, hi - cap AS lo, hi FROM lc),
tot AS (SELECT invoice_id, max(hi) AS t FROM lc GROUP BY invoice_id),
na AS (
  SELECT pa.id, pa.institution_id, pa.payment_id, pa.invoice_id, pa.amount_paise,
         sum(pa.amount_paise) OVER (PARTITION BY pa.invoice_id ORDER BY p.paid_on, p.created_at, pa.created_at, pa.id) AS hi
    FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
   WHERE NOT EXISTS (SELECT 1 FROM payment_line_allocations x WHERE x.payment_allocation_id = pa.id)
), a2 AS (SELECT id, institution_id, payment_id, invoice_id, hi - amount_paise AS lo, hi FROM na)
SELECT a2.institution_id, a2.id, a2.payment_id, a2.invoice_id, l2.id, l2.fee_head_id, min(a2.hi, l2.hi) - max(a2.lo, l2.lo), 'backfill'
  FROM a2 JOIN l2 ON l2.invoice_id = a2.invoice_id
 WHERE min(a2.hi, l2.hi) > max(a2.lo, l2.lo)
UNION ALL
SELECT a2.institution_id, a2.id, a2.payment_id, a2.invoice_id, NULL, NULL, a2.hi - max(a2.lo, COALESCE(tot.t, 0)), 'backfill'
  FROM a2 LEFT JOIN tot ON tot.invoice_id = a2.invoice_id
 WHERE a2.hi > COALESCE(tot.t, 0);
