-- 0052_school_tax_registration (tenant: every school database).
--
-- The school's own GSTIN, PAN and TAN. Vendors have carried theirs since the
-- purchase ledger was written; the school itself had nowhere to put its own,
-- so the taxation and audit sheet printed with no registration on it at all --
-- a document that cannot be filed, checked, or matched to a return.
--
-- They belong on ledger_settings rather than a new table: one row per school,
-- already the home of the accounts configuration, already read by every report
-- that needs to know how this school keeps its books.
--
-- Forward-only: once applied anywhere this file must not change.

ALTER TABLE ledger_settings ADD COLUMN gstin TEXT;
ALTER TABLE ledger_settings ADD COLUMN pan TEXT;
ALTER TABLE ledger_settings ADD COLUMN tan TEXT;
