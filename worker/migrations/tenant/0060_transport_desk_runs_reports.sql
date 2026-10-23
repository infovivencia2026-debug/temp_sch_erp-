-- 0060_transport_desk_runs_reports (tenant: every school database).
-- The transport office gets a front page, a runs screen and a reports page.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- The transport manager had eleven operational screens and nowhere that
-- answered the morning's question -- are the buses out, is anything wrong --
-- and no sheet to hand anybody who asked for one. Three keys, granted to the
-- transport_manager role wherever that role exists.
--
-- Joined on roles.key rather than a role id: ids are per database, and this
-- same file runs against every school.

INSERT OR IGNORE INTO permissions (key, module, description) VALUES
  ('transport_manager.home.dashboard', 'transport_manager',
   'The transport office on one page: how many buses are out, what has finished, and the handful of things wanting doing before the phone rings.'),
  ('transport_manager.transport.todays_runs', 'transport_manager',
   'Every route today with its bus, driver, attendant, pre-trip check, how many children are aboard and whether it is running.'),
  ('transport_manager.reports.transport_reports', 'transport_manager',
   'The sheets a transport office is asked for, ready made: who rides what, the fleet and its papers, attendance, fuel and incidents. Prints, and exports to a spreadsheet.');

INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
  SELECT r.id, p.key FROM roles r
    JOIN permissions p ON p.key IN (
      'transport_manager.home.dashboard',
      'transport_manager.transport.todays_runs',
      'transport_manager.reports.transport_reports')
   WHERE r.key = 'transport_manager';
