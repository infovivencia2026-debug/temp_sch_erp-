-- 0087_feature_year_end_payout (tenant: every school database).
-- Year-end payout (owner, 2026-10-14: "holiday pay may be given at the end of
-- the working month of the academic year... if no leave is applied that is
-- also considered as a pay"). The rates the school pays holiday work and
-- unused leave at, and one record per academic year of the payout that was
-- added to a month's payroll, so it is never added twice.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Rates: 'gross_30' (gross / 30), 'ctc_30' (CTC / 30), 'pattern' (gross over
-- the work pattern's divisor) or 'fixed' (a rupee figure a day). A cap of 0
-- means no cap. Leave types counted: 'encashable' (policy rule) or 'paid'.
ALTER TABLE payroll_settings ADD COLUMN ye_holiday_rate TEXT NOT NULL DEFAULT 'gross_30';
ALTER TABLE payroll_settings ADD COLUMN ye_holiday_fixed_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_settings ADD COLUMN ye_holiday_max_days REAL NOT NULL DEFAULT 0;
ALTER TABLE payroll_settings ADD COLUMN ye_leave_rate TEXT NOT NULL DEFAULT 'gross_30';
ALTER TABLE payroll_settings ADD COLUMN ye_leave_fixed_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_settings ADD COLUMN ye_leave_max_days REAL NOT NULL DEFAULT 0;
ALTER TABLE payroll_settings ADD COLUMN ye_leave_types TEXT NOT NULL DEFAULT 'encashable';

CREATE TABLE IF NOT EXISTS payroll_year_end_payouts (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  academic_year_id TEXT NOT NULL UNIQUE REFERENCES academic_years (id) ON DELETE CASCADE,
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  people INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL DEFAULT 0,
  adjustment_ids TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The permission vocabulary: the catalogue (navigation) key.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hr.payroll.year_end_payout', 'hr', 'Holiday work and unused leave paid out once a year, added to a month''s payroll as pay adjustments.');

-- The built-in roles pick it up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hr.payroll.year_end_payout' FROM roles WHERE key = 'hr' AND is_system = 1 AND customised_at IS NULL;
