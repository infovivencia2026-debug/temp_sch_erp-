-- 0062_finance_may_read_payroll (tenant: every school database).
-- Accounts & Finance can see the payroll run it is asked to approve.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Finance holds finance.accounts.approve_pay_salaries -- the screen is called
-- "Approve & pay salaries" and sits in their own menu -- and did not hold
-- hr.payroll.read, which that screen's first tab needs. So the role was given
-- a feature and then told, on opening it, that the payroll run is HR's to
-- show and to go and ask an admin for the very permission this grant is.
--
-- Read only. Finance approves the run and releases the money; running
-- payroll, editing salary structures and publishing payslips stay with HR,
-- which is hr.payroll.write and is not granted here.
--
-- Joined on roles.key rather than a role id: ids are per database, and this
-- same file runs against every school.

INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
  SELECT r.id, 'hr.payroll.read' FROM roles r WHERE r.key = 'finance';
