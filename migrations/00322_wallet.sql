-- +goose Up
-- DIGITAL MONEY: a school-held prepaid balance per student (Phase 1).
--
-- Parents pre-load a balance the school holds; it is drawn down later by fees,
-- canteen and bus. This migration adds the ledger only — no real money moves
-- here. A top-up records money the school has ALREADY received (cash at the
-- desk, or a UPI transfer the office reconciles), exactly as the UPI feature
-- (00320) records a fee the family has already paid.
--
-- Two tables. wallet_accounts holds one row per student with a derived balance;
-- wallet_transactions is the append-only ledger, and a trigger keeps the
-- balance equal to the sum of its rows — the same discipline invoices.paid_paise
-- follows against payment_allocations, so the balance is never written by hand
-- and can always be re-derived. All money is bigint paise.

CREATE TABLE wallet_accounts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid REFERENCES campuses(id) ON DELETE SET NULL,
    student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    balance_paise  bigint NOT NULL DEFAULT 0,
    status         text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'frozen', 'closed')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    -- One wallet per student, and a composite key so children can enforce
    -- tenancy across the join (the 00094 pattern).
    UNIQUE (institution_id, student_id),
    UNIQUE (id, institution_id)
);

CREATE TABLE wallet_transactions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid REFERENCES campuses(id) ON DELETE SET NULL,
    wallet_id      uuid NOT NULL,
    student_id     uuid NOT NULL,
    kind           text NOT NULL
                     CHECK (kind IN ('top_up', 'spend', 'refund', 'adjustment')),
    -- Signed: a credit (top_up / refund) is positive, a debit (spend) negative.
    -- An adjustment may be either. Zero is meaningless, so it is refused.
    delta_paise    bigint NOT NULL CHECK (delta_paise <> 0),
    -- How a top-up arrived (cash / upi / gateway / adjustment), and its bank
    -- reference (UTR or instrument), for reconciliation against the statement.
    source_mode    text,
    reference_no   text,
    -- Set when a spend settled fees: it points at the payments row that carries
    -- the allocation, so the wallet debit and the fee credit are one event and
    -- neither is counted twice.
    payment_id     uuid REFERENCES payments(id) ON DELETE SET NULL,
    note           text,
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (wallet_id, institution_id)
        REFERENCES wallet_accounts (id, institution_id) ON DELETE CASCADE,
    UNIQUE (id, institution_id)
);

CREATE INDEX wallet_transactions_wallet ON wallet_transactions (wallet_id, created_at DESC);
CREATE INDEX wallet_accounts_student ON wallet_accounts (student_id);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION sync_wallet_balance() RETURNS trigger AS $$
DECLARE
    target  uuid;
    new_bal bigint;
BEGIN
    target := COALESCE(NEW.wallet_id, OLD.wallet_id);
    SELECT COALESCE(SUM(delta_paise), 0) INTO new_bal
      FROM wallet_transactions
     WHERE wallet_id = target;
    -- A wallet may not go overdrawn: it is a prepaid balance, not credit. The
    -- UPDATE takes a row lock on the account, so two concurrent spends serialize
    -- here and the second sees the first's balance rather than racing past it.
    IF new_bal < 0 THEN
        RAISE EXCEPTION 'wallet balance cannot go negative';
    END IF;
    UPDATE wallet_accounts
       SET balance_paise = new_bal, updated_at = now()
     WHERE id = target;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER wallet_transactions_sync
AFTER INSERT OR UPDATE OR DELETE ON wallet_transactions
FOR EACH ROW EXECUTE FUNCTION sync_wallet_balance();

ALTER TABLE wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_accounts FORCE  ROW LEVEL SECURITY;
CREATE POLICY wallet_accounts_tenant ON wallet_accounts
    USING      (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON wallet_accounts TO app_user;

ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions FORCE  ROW LEVEL SECURITY;
CREATE POLICY wallet_transactions_tenant ON wallet_transactions
    USING      (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON wallet_transactions TO app_user;

-- Carry the new permission keys to tenants that already exist. `migrate seed`
-- (which would grant these from the Go catalogue) is not run by the deploy, so
-- the migration does it — the 00314/00321 pattern. Platform standing first,
-- because permissions and role_permissions are under forced RLS.
SET LOCAL app.is_platform_admin = 'on';

INSERT INTO permissions (key, module, description) VALUES
    ('finance.wallet.read',   'finance', 'View student wallet balances and history'),
    ('finance.wallet.manage', 'finance', 'Top up and adjust student wallets'),
    ('self.wallet.read',      'self',    'View own wallet balance and history')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.key
  FROM roles r
  JOIN (VALUES
        ('institution_admin', 'finance.wallet.read'),
        ('institution_admin', 'finance.wallet.manage'),
        ('finance',           'finance.wallet.read'),
        ('finance',           'finance.wallet.manage'),
        ('board_member',      'finance.wallet.read'),
        ('student',           'self.wallet.read'),
        ('parent',            'self.wallet.read')
       ) AS g(role_key, key) ON r.key = g.role_key
ON CONFLICT DO NOTHING;

-- +goose Down
SET LOCAL app.is_platform_admin = 'on';
DELETE FROM role_permissions
 WHERE permission_key IN ('finance.wallet.read', 'finance.wallet.manage', 'self.wallet.read');
DELETE FROM permissions
 WHERE key IN ('finance.wallet.read', 'finance.wallet.manage', 'self.wallet.read');

DROP TRIGGER IF EXISTS wallet_transactions_sync ON wallet_transactions;
DROP FUNCTION IF EXISTS sync_wallet_balance();
DROP TABLE IF EXISTS wallet_transactions;
DROP TABLE IF EXISTS wallet_accounts;
