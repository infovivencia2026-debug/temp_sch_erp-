-- 0117_payroll_approval (tenant: every school database).
-- Owner, 2026-10-27: payroll is approved by the institution admin (the
-- principal) before it is published. The run stays locked/paid; these columns
-- carry the maker-checker step beside it. approval_state is NULL (not sent),
-- 'pending' (waiting for the principal) or 'approved'. A send-back returns the
-- month to draft and keeps the note for the maker.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

ALTER TABLE payroll_runs ADD COLUMN approval_state TEXT;
ALTER TABLE payroll_runs ADD COLUMN submitted_by TEXT;
ALTER TABLE payroll_runs ADD COLUMN submitted_at TEXT;
ALTER TABLE payroll_runs ADD COLUMN approved_by TEXT;
ALTER TABLE payroll_runs ADD COLUMN approved_at TEXT;
ALTER TABLE payroll_runs ADD COLUMN sent_back_note TEXT;
ALTER TABLE payroll_runs ADD COLUMN sent_back_at TEXT;
