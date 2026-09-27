-- control_billing (CONTROL D1 only). Seller billing (invoices, payments,
-- renewal reminders, automatic past_due/suspended) and the onboarding tracker.
-- Idempotent; apply with
--   npx wrangler d1 execute school-erp-control --remote --file db/changes/control_billing.sql
-- ---- Seller billing (Seller → Subscription ledger; school Settings → Billing) --
-- Invoices the vendor issues to each school for its subscription, payments
-- against them, renewal reminders and the onboarding tracker. Written by
-- src/routes/seller/billing.ts and src/routes/seller/onboarding.ts.

-- One row: who the seller is on an invoice, the GST rate and the grace periods
-- the daily billing job (billing:daily) applies.
CREATE TABLE IF NOT EXISTS billing_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seller_name TEXT NOT NULL DEFAULT '',
  seller_address TEXT NOT NULL DEFAULT '',
  seller_gstin TEXT NOT NULL DEFAULT '',
  seller_email TEXT NOT NULL DEFAULT '',
  bank_details TEXT NOT NULL DEFAULT '',
  upi_vpa TEXT NOT NULL DEFAULT '',
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  gst_rate_bp INTEGER NOT NULL DEFAULT 1800,          -- basis points: 1800 = 18%
  due_days INTEGER NOT NULL DEFAULT 15,               -- issued_on + due_days = due_on
  grace_days INTEGER NOT NULL DEFAULT 15,             -- past_due after due_on + grace_days
  suspend_after_days INTEGER NOT NULL DEFAULT 30,     -- suspended after a further this many days
  updated_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO billing_settings (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Numbered per Indian financial year (April to March): INV/2026-27/0001.
CREATE TABLE IF NOT EXISTS billing_invoices (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  number TEXT NOT NULL UNIQUE,
  fy TEXT NOT NULL,
  seq INTEGER NOT NULL,
  issued_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  period_from TEXT,
  period_to TEXT,
  plan_code TEXT,
  billing_period TEXT NOT NULL DEFAULT 'yearly',
  description TEXT NOT NULL,
  school_gstin TEXT,
  amount_paise INTEGER NOT NULL,                      -- taxable value
  gst_rate_bp INTEGER NOT NULL,
  gst_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  paid_paise INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','partial','paid','void')),
  seller_gstin TEXT NOT NULL DEFAULT '',
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (fy, seq)
);
CREATE INDEX IF NOT EXISTS billing_invoices_school ON billing_invoices(institution_id, issued_on);
CREATE INDEX IF NOT EXISTS billing_invoices_open ON billing_invoices(due_on) WHERE status IN ('issued','partial');

CREATE TABLE IF NOT EXISTS billing_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  method TEXT NOT NULL CHECK (method IN ('upi','neft','cheque','cash','online')),
  reference TEXT,
  paid_on TEXT NOT NULL,
  gateway_order_ref TEXT UNIQUE,
  recorded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_payments_invoice ON billing_payments(invoice_id);

-- Online payment attempts through the platform gateway (PAYMENT_GATEWAY_SECRET).
CREATE TABLE IF NOT EXISTS billing_gateway_orders (
  order_ref TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  payment_ref TEXT,
  failure_reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

-- Renewal reminders already queued: one per school, renewal date and step (30/7/1).
CREATE TABLE IF NOT EXISTS billing_reminders (
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  renews_on TEXT NOT NULL,
  days_before INTEGER NOT NULL,
  recipient TEXT,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (institution_id, renews_on, days_before)
);

-- Subscription status changes the billing job made, for the ledger.
CREATE TABLE IF NOT EXISTS billing_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL
);

-- ---- Onboarding tracker (Seller → Schools → Setup) ------------------------
-- The first time each milestone was seen, read from each school's own D1 by
-- the onboarding:scan job. A date once recorded is kept.
CREATE TABLE IF NOT EXISTS onboarding_progress (
  institution_id TEXT PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  admin_signed_in_at TEXT,
  profile_complete_at TEXT,
  classes_set_up_at TEXT,
  students_imported_at TEXT,
  staff_added_at TEXT,
  first_attendance_at TEXT,
  first_fee_at TEXT,
  first_parent_signed_in_at TEXT,
  scan_error TEXT,
  checked_at TEXT NOT NULL,
  last_nudged_at TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0
);
