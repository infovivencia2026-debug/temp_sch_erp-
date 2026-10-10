-- A school asks for more gallery storage (owner, 2026-10-10). The request is
-- recorded here with the UTR of the payment the school made (until a payment
-- gateway is added); it starts 'requested' and the platform moves it to
-- 'granted' or 'rejected' after checking the UTR. extra_gb is what was asked.
-- Forward-only: once applied anywhere this file must not change.
CREATE TABLE IF NOT EXISTS storage_requests (
  id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL,
  extra_gb INTEGER NOT NULL,
  note TEXT,
  utr TEXT,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'requested',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS storage_requests_status ON storage_requests (status, created_at);
