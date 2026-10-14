-- Per-school payroll rules (owner, 2026-10-14, after comparing a school's own
-- August 2026 salary workbook). Every default reproduces the run as it was, so
-- no school changes until it opts in on Payroll -> Statutory -> Settings.
-- Forward-only: once applied anywhere this file must not change.
ALTER TABLE payroll_settings ADD COLUMN pf_wage_base TEXT NOT NULL DEFAULT 'basic_da';
ALTER TABLE payroll_settings ADD COLUMN lop_method TEXT NOT NULL DEFAULT 'prorate';
ALTER TABLE payroll_settings ADD COLUMN lop_day_base TEXT NOT NULL DEFAULT 'gross';
ALTER TABLE payroll_settings ADD COLUMN lop_divisor TEXT NOT NULL DEFAULT 'month';
ALTER TABLE payroll_settings ADD COLUMN free_leave_days REAL NOT NULL DEFAULT 0;
ALTER TABLE payroll_settings ADD COLUMN late_rule TEXT NOT NULL DEFAULT 'policy';
ALTER TABLE payroll_settings ADD COLUMN late_marks_per_day INTEGER NOT NULL DEFAULT 3;
ALTER TABLE payroll_settings ADD COLUMN pay_holidays_worked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_settings ADD COLUMN esi_mode TEXT NOT NULL DEFAULT 'deduct';
ALTER TABLE payroll_settings ADD COLUMN bank_branch TEXT;
ALTER TABLE payroll_settings ADD COLUMN bank_address TEXT;
-- Days typed in by hand for a month: holidays worked (comp-off) beyond what the
-- register shows, and vacation taken.
CREATE TABLE IF NOT EXISTS payroll_month_days (
  institution_id TEXT NOT NULL,
  employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  holidays_worked REAL NOT NULL DEFAULT 0,
  vacation_days REAL NOT NULL DEFAULT 0,
  vacation_dates TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (employee_id, period_year, period_month)
);
