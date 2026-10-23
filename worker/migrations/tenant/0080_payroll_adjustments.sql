-- One-off changes to a month's pay, made before the month is locked (owner,
-- 2026-10-13: "let them edit the payroll before publishing"). A bonus or
-- arrears adds to pay, a deduction takes off; each carries its reason. Keyed
-- by month and person, not by payslip, so re-running the month keeps them.
-- Forward-only: once applied anywhere this file must not change.
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('earning', 'deduction')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS payroll_adjustments_month ON payroll_adjustments (period_year, period_month, employee_id);
