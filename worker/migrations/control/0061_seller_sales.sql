-- 0061_seller_sales (control: CONTROL only).
-- The seller's sales side: quotes from a lead, demo schools that expire, and
-- resellers with their commission and payouts. Written by
-- src/routes/seller/sales.ts and src/routes/seller/partners.ts.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- A quote (proforma) for a lead or a school, numbered per Indian financial
-- year: QT/2026-27/0001. GST as on an invoice. Converting it issues a
-- billing_invoices row for the school and records that invoice here.
CREATE TABLE IF NOT EXISTS seller_quotes (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  fy TEXT NOT NULL,
  seq INTEGER NOT NULL,
  enquiry_id TEXT REFERENCES purchase_enquiries(id) ON DELETE SET NULL,
  institution_id TEXT REFERENCES institutions(id) ON DELETE SET NULL,
  bill_to TEXT NOT NULL,
  description TEXT NOT NULL,
  plan_code TEXT,
  students INTEGER,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  gst_rate_bp INTEGER NOT NULL,
  gst_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  issued_on TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','void')),
  invoice_id TEXT REFERENCES billing_invoices(id) ON DELETE SET NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (fy, seq)
);
CREATE INDEX IF NOT EXISTS seller_quotes_enquiry ON seller_quotes(enquiry_id);

-- A demo school: an ordinary provisioned school with invented records, for
-- a lead in demo_booked, suspended by the daily sweep once expires_on passes.
CREATE TABLE IF NOT EXISTS seller_demos (
  provisioning_id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  enquiry_id TEXT REFERENCES purchase_enquiries(id) ON DELETE SET NULL,
  expires_on TEXT NOT NULL,
  seeded_at TEXT,
  suspended_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seller_demos_expiry ON seller_demos(expires_on) WHERE suspended_at IS NULL;

-- Resellers. commission_bp is basis points of the taxable value of each paid
-- invoice of a school linked to the partner (1000 = 10%).
CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  commission_bp INTEGER NOT NULL CHECK (commission_bp BETWEEN 0 AND 5000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A school belongs to at most one partner.
CREATE TABLE IF NOT EXISTS partner_schools (
  institution_id TEXT PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS partner_schools_partner ON partner_schools(partner_id);

CREATE TABLE IF NOT EXISTS partner_payouts (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reference TEXT NOT NULL,
  paid_on TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- One accrual per paid invoice, at the rate the partner had then. payout_id
-- is set when a payout covers it.
CREATE TABLE IF NOT EXISTS partner_commissions (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES billing_invoices(id) ON DELETE CASCADE,
  base_paise INTEGER NOT NULL,
  rate_bp INTEGER NOT NULL,
  commission_paise INTEGER NOT NULL,
  accrued_at TEXT NOT NULL,
  payout_id TEXT REFERENCES partner_payouts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS partner_commissions_partner ON partner_commissions(partner_id, payout_id);

-- "Won, set up the school": the lead a provisioning request was started from.
-- When the school is ready, provisioning writes it to the lead's
-- provisioned_institution_id (services/provision.ts).
ALTER TABLE provisioning ADD COLUMN enquiry_id TEXT;
