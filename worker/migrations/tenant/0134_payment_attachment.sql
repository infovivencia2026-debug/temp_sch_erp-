-- 0134_payment_attachment (tenant: every school database).
-- A file the counter attaches to a payment with its comment (owner,
-- 2026-11-20): a bank slip, a letter, a photo. Optional, up to 2 MB.
--
-- Forward-only: once applied anywhere this file must not change.
-- No BEGIN/COMMIT (D1 rejects them).

ALTER TABLE payments ADD COLUMN attachment_file_id TEXT;
