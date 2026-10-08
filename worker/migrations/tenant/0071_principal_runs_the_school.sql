-- 0071_principal_runs_the_school (tenant: every school database).
-- The institution admin can open every screen in their own school.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Testing found the principal switching to the Accounts & Finance workspace,
-- seeing that role's whole menu, and being told "No such feature" on most of
-- it: Accounting & tax reports, the Cheques register, the day book. The menu
-- offered doors the login had no key to. It was not only Finance -- the
-- account held 10 of 131 finance keys, 6 of 123 HR keys, none of the
-- transport or librarian keys, and 71 of its own 283.
--
-- The owner's decision, asked and answered: inside their own school the
-- institution admin has full access. A principal does oversee the accounts,
-- the payroll and the buses, and a menu that lists what it will then refuse
-- is worse than either giving the access or hiding the entry.
--
-- Three namespaces stay out, and for the same reason in each case -- they are
-- not this school's to grant:
--   seller_admin.*  the company that sells the product
--   super_admin.*   the platform, across every school
--   parent.* student.* driver.*  somebody's own portal: their fees, their
--                   child, their payslip. An administrator reads those
--                   through the school-side screens that are scoped and
--                   audited, not by holding the family's own login rights.
--
-- Joined on roles.key rather than a role id: ids are per database, and this
-- same file runs against every school.

INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
  SELECT r.id, p.key
    FROM roles r
    JOIN permissions p
      ON p.key NOT LIKE 'seller_admin.%'
     AND p.key NOT LIKE 'super_admin.%'
     AND p.key NOT LIKE 'parent.%'
     AND p.key NOT LIKE 'student.%'
     AND p.key NOT LIKE 'driver.%'
   WHERE r.key = 'institution_admin';
