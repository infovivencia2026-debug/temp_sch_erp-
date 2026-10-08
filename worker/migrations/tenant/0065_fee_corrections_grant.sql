-- 0065_fee_corrections_grant (tenant: every school database).
--
-- The Fee corrections screen (void, move, force-success, end a fee for a
-- class), granted to the finance role the way 0064 granted its screens.
-- Forward-only: once applied anywhere this file must not change.

INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('finance.fees.fee_corrections', 'finance', 'Void a receipt, move one to the right child, mark a confirmed online payment received, stop a fee head for a class from a date.');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'finance.fees.fee_corrections' FROM roles WHERE key = 'finance' AND is_system = 1 AND customised_at IS NULL;
