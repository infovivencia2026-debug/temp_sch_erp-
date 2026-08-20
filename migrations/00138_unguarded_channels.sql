-- +goose Up
--
-- Per-channel exemption from the recipient allowlist.
--
-- The guard was one decision for the whole school: allowlist or everyone,
-- applied to every channel that leaves the building. That is the right default
-- and the wrong granularity, because the two channels do not carry the same
-- risk.
--
-- SMS goes out through the school's own SIM to whoever the school means to
-- reach; the cost of a mistake is a wrong text message. WhatsApp goes out
-- through a Meta Business account whose quality rating is shared, template
-- policy is enforced by somebody else, and a complaint against the number
-- affects every other system using it. A school piloting WhatsApp on a
-- borrowed number wants exactly one recipient reachable there, while the SMS
-- register runs normally.
--
-- Forcing one mode meant choosing between an unusable SMS channel and an
-- unguarded WhatsApp one. This names the channels the guard does not apply to,
-- rather than adding a second mode nobody could hold in their head.
--
-- Empty by default, so an existing school's behaviour does not change: every
-- channel stays guarded until somebody says otherwise.

ALTER TABLE messaging_recipient_policy
    ADD COLUMN IF NOT EXISTS unguarded_channels text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN messaging_recipient_policy.unguarded_channels IS
    'Channels the allowlist does not apply to, e.g. {sms}. Empty means every channel is guarded. in_app is always exempt: it cannot leave the building.';

-- A typo here would silently unguard nothing, or worse, look like it unguarded
-- something. The set is small and closed, so the database can say so.
ALTER TABLE messaging_recipient_policy
    DROP CONSTRAINT IF EXISTS messaging_recipient_policy_unguarded_known;
ALTER TABLE messaging_recipient_policy
    ADD CONSTRAINT messaging_recipient_policy_unguarded_known
    CHECK (unguarded_channels <@ ARRAY['sms','email','whatsapp']::text[]);

-- +goose Down
ALTER TABLE messaging_recipient_policy
    DROP CONSTRAINT IF EXISTS messaging_recipient_policy_unguarded_known;
ALTER TABLE messaging_recipient_policy
    DROP COLUMN IF EXISTS unguarded_channels;
