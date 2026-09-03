-- +goose Up
-- What a school has left to spend on messages it does not pay for directly.
--
-- Every SMS and every WhatsApp template costs real money on somebody's vendor
-- account. Until now nothing counted them: a fee-reminder rule aimed at the
-- wrong audience, or a loop that requeues, spends that money at whatever rate
-- the dispatcher can manage and the first anybody knows is the vendor's bill.
-- Email and in-app are not here because they cost nothing per message.
--
-- A METER, NOT A TILL. Nothing is sold and no money moves through this
-- product. The school links its own vendor account and pays the vendor; these
-- rows exist so somebody can say "this school may send twenty thousand
-- messages this term" and have that hold. Top-ups are entered by hand by
-- whoever administers the platform.
--
-- ABSENCE MEANS UNMETERED, and that is the important decision in this file.
-- A school with no row here sends exactly as it did before. If a missing row
-- meant a zero balance, deploying this migration would silently stop every
-- message in the product for every school that has one configured -- a fee
-- reminder that never goes, an absence alert a parent never gets, and nothing
-- on any screen to say why. Metering begins when somebody sets a balance, as
-- a deliberate act.

CREATE TABLE IF NOT EXISTS message_credits (
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- Only the channels that cost money per message. Deliberately not a
    -- reference to a channel table: the set is decided by the dispatcher and
    -- a value it does not meter would be a row nothing ever reads.
    channel text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),

    -- Whole messages, not currency. A credit is one send, because that is the
    -- unit the dispatcher can actually count -- rates differ per vendor, per
    -- destination and per template, and storing money here would be a number
    -- that drifts from the vendor's own bill and looks authoritative.
    balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),

    -- Warn before it bites. A school that discovers its balance by messages
    -- silently not arriving has already missed the ones that mattered.
    low_water integer NOT NULL DEFAULT 100 CHECK (low_water >= 0),

    updated_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (institution_id, channel)
);

-- Every movement, with its reason.
--
-- The balance alone answers "how many are left" and nothing else. The question
-- actually asked when a bill arrives is "where did eleven thousand messages
-- go", and that needs one row per movement: which message, on whose authority,
-- and when.
CREATE TABLE IF NOT EXISTS message_credit_entries (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    channel        text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),

    -- Negative for a send, positive for a top-up. Never zero: a movement of
    -- nothing is not a movement.
    delta integer NOT NULL CHECK (delta <> 0),

    -- 'send' | 'topup' | 'adjustment'. Free text rather than an enum so a
    -- reason this table has not thought of does not require a migration.
    reason text NOT NULL CHECK (btrim(reason) <> ''),

    -- The message this paid for, when it paid for one. ON DELETE SET NULL
    -- because the ledger must outlive the log it refers to: message_log is
    -- pruned and the money still went.
    message_id uuid REFERENCES message_log(id) ON DELETE SET NULL,

    -- Who topped it up. NULL for a send, which no person authorised
    -- individually.
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,

    note       text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_credit_entries_inst_idx
    ON message_credit_entries (institution_id, channel, created_at DESC);

ALTER TABLE message_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_credits FORCE ROW LEVEL SECURITY;
CREATE POLICY message_credits_tenant ON message_credits
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

ALTER TABLE message_credit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_credit_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY message_credit_entries_tenant ON message_credit_entries
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON message_credits TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON message_credit_entries TO app_user;

-- +goose Down
DROP TABLE IF EXISTS message_credit_entries;
DROP TABLE IF EXISTS message_credits;
