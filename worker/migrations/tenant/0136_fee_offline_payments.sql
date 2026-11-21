-- 0136_fee_offline_payments (tenant: every school database).
-- "I have paid" from the parent app (owner, 2026-11-21): a family reports a
-- payment made outside the counter (bank transfer, UPI to the school's
-- account) with its UTR and a screenshot, and which fees it was for. The
-- counter turns it into a receipt (the usual series and UTR rules) or
-- rejects it with a reason the family sees. Nothing is sent to anyone.
--
-- Forward-only: once applied anywhere this file must not change.
-- No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE IF NOT EXISTS fee_offline_payments (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL,
  mode TEXT NOT NULL,
  reference_no TEXT,
  paid_on TEXT NOT NULL,
  attachment_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  lines TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL,
  submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fee_offline_student ON fee_offline_payments(student_id, status);
