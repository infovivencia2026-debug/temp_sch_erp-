-- +goose Up
--
-- NOTE TO THE INTEGRATOR: this file claims 00101 as assigned. Six migrations
-- were renumbered on the way in today; nothing below depends on its own
-- number, and every statement is written to be safe to re-run.
--
-- Every comment here is a line comment. goose's splitter counts semicolons
-- without understanding block comments, so a ';' inside a /* */ ends the
-- statement early and the migration fails halfway.
--
-- Two things live here, and they are not the same feature.
--
--   1. WhatsApp Business Cloud API is not the generic HTTP gateway that
--      00044's gatewayProvider models. Meta's endpoint takes one JSON shape,
--      and outside a 24-hour customer-service window it accepts only
--      pre-approved TEMPLATE messages -- not free text. Every message this
--      product sends is outside that window, because parents do not message
--      the school first. So a template send is the supported path, and an
--      approved template is a NAME plus POSITIONAL parameters. message_
--      templates carried neither, so it carries them now.
--
--   2. A recipient allowlist, which is a safety guard rather than a filter.
--      A school in setup must not be able to blast every parent by clicking
--      Dispatch. The default for an institution that has never configured it
--      is 'allowlist' with an empty list, which sends to nobody. Failing
--      closed is the whole point: the cost of an accidental broadcast to
--      every family is far higher than the cost of a message held during
--      setup. It is enforced in DispatchMessages, on every channel, so a
--      caller that queues directly cannot go around it.

-- ------------------------------------------- 1. the WhatsApp template mapping

-- An approved WhatsApp template is a name, a language and an ordered list of
-- positional parameters. This product's bodies use {{placeholder}} names, and
-- the order they happen to appear in the body is NOT necessarily the order
-- Meta approved them in -- a school may reword its own body without touching
-- the approved template. So the mapping is stored, explicitly, rather than
-- inferred from the body at send time.

ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS wa_template_name text;
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS wa_language      text;
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS wa_params        jsonb NOT NULL DEFAULT '[]'::jsonb;

-- wa_params is an ordered JSON array of placeholder names:
--   ["student_name", "on_date"]
-- meaning body parameter {{1}} is student_name and {{2}} is on_date. An array
-- rather than an object because position is the entire meaning; an object
-- would leave the order to whatever the JSON serialiser felt like.
ALTER TABLE message_templates
    DROP CONSTRAINT IF EXISTS message_templates_wa_params_is_array;
ALTER TABLE message_templates
    ADD CONSTRAINT message_templates_wa_params_is_array
    CHECK (jsonb_typeof(wa_params) = 'array');

-- A language code as Meta writes them: en, en_US, te, hi.
ALTER TABLE message_templates
    DROP CONSTRAINT IF EXISTS message_templates_wa_language_shape;
ALTER TABLE message_templates
    ADD CONSTRAINT message_templates_wa_language_shape
    CHECK (wa_language IS NULL OR wa_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$');

-- Meta's own naming rule for an approved template: lowercase, digits and
-- underscores. Rejecting it here rather than at the API means the operator
-- finds out on the settings screen instead of at 3 a.m. in the dispatch log.
ALTER TABLE message_templates
    DROP CONSTRAINT IF EXISTS message_templates_wa_name_shape;
ALTER TABLE message_templates
    ADD CONSTRAINT message_templates_wa_name_shape
    CHECK (wa_template_name IS NULL OR wa_template_name ~ '^[a-z0-9_]{1,512}$');

COMMENT ON COLUMN message_templates.wa_template_name IS
    'The name of the template approved in the WhatsApp Business account. Outside the 24-hour window Meta accepts nothing else.';
COMMENT ON COLUMN message_templates.wa_language IS
    'The approved template language: en, en_US, te. A template approved in one language does not exist in another.';
COMMENT ON COLUMN message_templates.wa_params IS
    'Ordered array of {{placeholder}} names. Position i maps to the approved template body parameter {{i+1}}. Stored, never inferred from the body.';

-- ---------------------------------------- 2. the vars a template send needs

-- The rendered body is already on message_log, but a WhatsApp template send
-- does not carry a body -- it carries the template name and the parameter
-- VALUES, and Meta hydrates the approved text itself. Those values are the
-- template vars, which until now were discarded once the body was rendered.
--
-- Held as jsonb on the row that already holds the rendered body, so no new
-- copy of a parent's data appears anywhere it was not already.
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS template_vars jsonb;

COMMENT ON COLUMN message_log.template_vars IS
    'The variables this message was rendered from. Kept because a WhatsApp template send transmits parameter values rather than the rendered body.';

-- A message the allowlist held back is not a failure and not a success. It
-- has to be its own status, because the two things a school asks are "did it
-- go" and "why not", and burying it as failed would put it on the retry
-- schedule to be refused four more times before going quiet.
ALTER TABLE message_log DROP CONSTRAINT IF EXISTS message_log_status_check;
ALTER TABLE message_log ADD CONSTRAINT message_log_status_check
    CHECK (status = ANY (ARRAY['queued','sent','delivered','failed','bounced','read','suppressed']));

-- ------------------------------------------------- 3. the recipient allowlist

-- One row per school, and its absence means the safe answer.
--
-- There is deliberately no DEFAULT row inserted for existing institutions.
-- The Go side reads a missing row as mode 'allowlist' with an empty list,
-- which sends to nobody -- so a school that upgrades into this migration is
-- immediately guarded rather than immediately live. Seeding 'everyone' for
-- existing tenants would be the exact accident this table exists to prevent.
CREATE TABLE IF NOT EXISTS messaging_recipient_policy (
    institution_id  uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,

    -- allowlist: only the numbers and addresses listed below are messaged.
    -- everyone:  no guard. A deliberate, recorded decision.
    mode            text NOT NULL DEFAULT 'allowlist',

    -- Why the school is in the mode it is in. Shown on the screen beside the
    -- mode, because "who turned the guard off and when" is the first question
    -- asked after an unintended broadcast.
    note            text,

    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT messaging_recipient_policy_mode
        CHECK (mode IN ('allowlist','everyone'))
);

COMMENT ON TABLE messaging_recipient_policy IS
    'Whether outbound messages are restricted to an allowlist. No row means allowlist with an empty list, which sends to nobody — the safe default.';
COMMENT ON COLUMN messaging_recipient_policy.mode IS
    'allowlist (default, fails closed) or everyone (guard off). Enforced in DispatchMessages for every channel that leaves the building.';

ALTER TABLE messaging_recipient_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_recipient_policy FORCE  ROW LEVEL SECURITY;

CREATE POLICY messaging_recipient_policy_tenant ON messaging_recipient_policy
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON messaging_recipient_policy TO app_user;

-- Who may be messaged while the guard is on.
--
-- normalised is the column that is matched, and it is written by the Go side
-- so that '9100575183', '+919100575183' and '919100575183' are one entry
-- rather than three that each half-work. raw is kept only to show the
-- operator what they typed.
CREATE TABLE IF NOT EXISTS messaging_allowed_recipients (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- phone covers SMS, WhatsApp and the phone gateway; email covers SMTP.
    -- One table rather than one per channel, because the guard's sentence is
    -- "do not message real families", not "do not message them by SMS".
    kind            text NOT NULL,

    raw             text NOT NULL,
    normalised      text NOT NULL,

    -- Whose number it is. An allowlist of bare digits nobody can attribute is
    -- an allowlist nobody dares remove an entry from.
    label           text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT messaging_allowed_recipients_kind
        CHECK (kind IN ('phone','email')),
    CONSTRAINT messaging_allowed_recipients_normalised_present
        CHECK (btrim(normalised) <> ''),
    CONSTRAINT messaging_allowed_recipients_raw_present
        CHECK (btrim(raw) <> '')
);

-- Every column here is NOT NULL, so this is a plain unique index and needs
-- none of the COALESCE the nullable-UNIQUE trap demands elsewhere.
CREATE UNIQUE INDEX IF NOT EXISTS messaging_allowed_recipients_one_per_value
    ON messaging_allowed_recipients (institution_id, kind, normalised);

COMMENT ON TABLE messaging_allowed_recipients IS
    'The only recipients outbound messaging may reach while the school is in allowlist mode. Applies to every channel.';
COMMENT ON COLUMN messaging_allowed_recipients.normalised IS
    'E.164 digits without a plus for a phone, lowercased and trimmed for an email. The column the dispatcher matches on.';

ALTER TABLE messaging_allowed_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_allowed_recipients FORCE  ROW LEVEL SECURITY;

CREATE POLICY messaging_allowed_recipients_tenant ON messaging_allowed_recipients
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON messaging_allowed_recipients TO app_user;

-- +goose Down
DROP TABLE IF EXISTS messaging_allowed_recipients;
DROP TABLE IF EXISTS messaging_recipient_policy;

-- A row already suppressed would violate the narrower constraint, so it goes
-- back to 'failed' carrying its reason rather than blocking the rollback.
UPDATE message_log SET status = 'failed' WHERE status = 'suppressed';

ALTER TABLE message_log DROP CONSTRAINT IF EXISTS message_log_status_check;
ALTER TABLE message_log ADD CONSTRAINT message_log_status_check
    CHECK (status = ANY (ARRAY['queued','sent','delivered','failed','bounced','read']));

ALTER TABLE message_log DROP COLUMN IF EXISTS template_vars;

ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_wa_name_shape;
ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_wa_language_shape;
ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_wa_params_is_array;
ALTER TABLE message_templates
    DROP COLUMN IF EXISTS wa_params,
    DROP COLUMN IF EXISTS wa_language,
    DROP COLUMN IF EXISTS wa_template_name;
