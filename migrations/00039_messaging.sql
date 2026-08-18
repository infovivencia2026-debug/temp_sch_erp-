-- +goose Up
-- The messaging foundation: one way out of the building, and one way to ask.
--
-- Four features queued behind this one — absence alerts, PTM reminders, fee
-- reminders and admissions campaign sequences — all want to send a message
-- when something happens. Built separately they would arrive as four senders,
-- four dedupe schemes and four places a school has to paste an SMTP password.
-- What is added here is deliberately small, because most of it already exists:
--
--   integrations       already holds provider, credentials, config, enabled,
--                      last_ok_at and last_error, with UNIQUE (institution_id,
--                      provider). That is a provider registry. A second table
--                      called messaging_providers would be the same row twice.
--   message_templates  already holds (code, channel, subject, body) and the
--                      DLT template id the TRAI regime requires.
--   message_log        already holds the outbound record. What it lacked was
--                      any way to answer "did I already send this?", which is
--                      the whole difference between a reminder and a nuisance.
--
-- So: three columns and an index on message_log, and one genuinely new table
-- for the rules. Nothing else.

-- ------------------------------------------------- message_log: send once

/* Where this message came from, and which single occurrence it is about.

   Copied deliberately from notifications.source_kind / source_id, added in
   00035 for exactly this problem. A second, differently-shaped dedupe scheme
   would mean the in-app alert and the SMS about the same absence disagree
   about whether they have already been delivered.

   occurrence_key is the third leg the notifications version does not need.
   A notification is about a row; a message is about a row *at a moment* — the
   same invoice can legitimately be chased in August and again in September,
   and the sender has to be able to say which of those two it is holding. It is
   text rather than uuid because an occurrence is often a date or a term, not a
   record: "PTM on 2026-09-12" has no id of its own until somebody books it. */
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS source_kind    text;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS source_id      uuid;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS occurrence_key text;

/* Held until the quiet period ends, rather than dropped.

   TRAI's commercial-communication rules put transactional SMS outside the
   21:00-09:00 window, and a parent woken at 02:00 by a fee reminder is a
   complaint whatever the regulator says. A rule with quiet hours set moves the
   send to the end of the window instead of cancelling it: the alternative —
   discarding — means the school silently never chased that invoice. */
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS send_after timestamptz;

-- How many times the dispatcher has picked this row up. A message stuck at
-- five attempts with an error is a provider fault the screen must show, not a
-- row to keep retrying forever.
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

/* One message per (rule, subject, occurrence, channel).

   The COALESCE is load-bearing, not tidiness: source_id is null for a message
   nothing automated produced, and user_id or student_id is null depending on
   whether the recipient is a person on file or an address typed by hand. With
   any of them bare, every such row would be unique against every other and a
   re-run of the trigger sweep would send the same reminder again — which is
   the one failure this whole table is here to prevent.

   channel is part of the key on purpose. "Tell them by email and by SMS" is
   two messages about one occurrence and both are wanted; keying without it
   would silently deliver whichever raced first and drop the other.

   institution_id leads so the index is tenant-local, and so a natural
   occurrence_key that is not a uuid ("2026-09-12") cannot collide across two
   schools that both hold a PTM that day.

   The partial predicate keeps the index off every row written before this
   migration, and off manual one-off sends, which have no occurrence to be the
   second copy of. */
CREATE UNIQUE INDEX IF NOT EXISTS message_log_one_per_occurrence
    ON message_log (
        institution_id,
        channel,
        source_kind,
        COALESCE(source_id,  '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(user_id,    '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(occurrence_key, ''))
 WHERE source_kind IS NOT NULL;

-- The dispatcher's own query: what is due to go out, oldest first.
CREATE INDEX IF NOT EXISTS message_log_due
    ON message_log (institution_id, queued_at)
 WHERE status = 'queued';

COMMENT ON COLUMN message_log.source_kind IS
    'What produced this message: ''trigger_rule'', ''circular'', ''manual''. NULL means it predates the send contract and is exempt from the one-per-occurrence index.';
COMMENT ON COLUMN message_log.source_id IS
    'The id of the thing named by source_kind — for ''trigger_rule'', message_trigger_rules.id.';
COMMENT ON COLUMN message_log.occurrence_key IS
    'Which single occurrence this message is about: an attendance row id, an invoice id, a PTM date. The third leg of the idempotency key.';
COMMENT ON COLUMN message_log.send_after IS
    'Held until this moment because the send landed inside the rule''s quiet hours. NULL means send at once.';

-- --------------------------------------------------------- trigger rules

/* "Remind guardians 24 hours before a PTM" is a row, not a deployment.

   Every one of the four features waiting on this file wants the same five
   things: something happened, was it the case we care about, who hears about
   it, what does it say, and not in the middle of the night. Modelled as
   columns, adding a sixth reminder is a form somebody fills in. Modelled as
   Go, it is a release — and the school that wants the fee chase at 15 days
   rather than 7 waits a fortnight for it.

   The rule does not name a finder or a query. The sweep knows how to find
   overdue invoices; the rule only says which of them, to whom, and when. That
   split is why a rule row is safe to let an administrator edit. */
CREATE TABLE message_trigger_rules (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- The school's own handle on the rule. Shown everywhere the rule appears,
    -- including in the message log, so "why did this parent get an SMS" is one
    -- lookup rather than a reconstruction from the event name.
    name            text NOT NULL,

    /* What happened, as 'noun.verb' — student.absent, invoice.overdue,
       ptm.upcoming, announcement.published, lead.stage_changed.

       Not a CHECK list of allowed values. A closed enum here would mean the
       admissions feature cannot add lead.stage_changed without a migration,
       and this table exists precisely so that adding a reminder is not a
       migration. The shape is enforced instead: rubbish is rejected, an event
       nothing emits yet simply never fires and says so on the screen. */
    event           text NOT NULL,

    /* Which occurrences of that event, as a flat map of constraints.

       Evaluated against the facts the sweep already gathered for the
       occurrence: min_<fact> passes when the fact is at least the value,
       max_<fact> when it is at most, and any other key is an equality match on
       the fact of that name. {"min_days_overdue": 7} is the fee chase at a
       week; {} is every occurrence.

       Deliberately not a query or an expression. A rule row an administrator
       can edit must not be able to read a table the administrator cannot. */
    condition       jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Who hears about it, relative to the occurrence: the child's guardians,
    -- the child, the member of staff the occurrence names (the teacher whose
    -- PTM it is), or everybody holding a role.
    audience        text NOT NULL,

    channel         text NOT NULL,

    -- message_templates.code. Not a foreign key: the sender falls back to a
    -- built-in body when the school has not written its own, so a rule that
    -- names a code with no row is usable rather than broken. A FK would make
    -- the fallback unreachable and force every new tenant to author four
    -- templates before its first reminder could fire.
    template_code   text NOT NULL,

    /* How far ahead of the occurrence to send, in minutes. 1440 is the day
       before. Zero means "when it happens", which is what an absence alert
       wants and a PTM reminder does not.

       Capped at a fortnight: a lead time longer than the sweep's own horizon
       is a rule that looks configured and never fires. */
    lead_minutes    integer NOT NULL DEFAULT 0,

    -- The hours nobody is to be messaged, in India/Kolkata. Both or neither:
    -- a half-set window is a rule whose author believed they had set one.
    quiet_from      time,
    quiet_to        time,

    is_active       boolean NOT NULL DEFAULT true,

    -- What the last sweep did. On the row rather than in a runs table because
    -- the only question anybody asks is "is this rule working", and the answer
    -- is the last attempt, not its history — which message_log already keeps.
    last_run_at     timestamptz,
    last_queued     integer NOT NULL DEFAULT 0,
    last_error      text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT message_trigger_rules_event_shape
        CHECK (event ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
    -- role:<key> lets a rule address staff by role without this table needing
    -- to know the role vocabulary, which lives in internal/rbac.
    CONSTRAINT message_trigger_rules_audience
        CHECK (audience ~ '^(guardians|student|staff|role:[a-z_]+)$'),
    CONSTRAINT message_trigger_rules_channel
        CHECK (channel IN ('sms','email','whatsapp','push','in_app')),
    CONSTRAINT message_trigger_rules_lead
        CHECK (lead_minutes BETWEEN 0 AND 20160),
    CONSTRAINT message_trigger_rules_quiet_pair
        CHECK ((quiet_from IS NULL) = (quiet_to IS NULL)),
    CONSTRAINT message_trigger_rules_name_present
        CHECK (btrim(name) <> ''),
    CONSTRAINT message_trigger_rules_template_present
        CHECK (btrim(template_code) <> '')
);

/* One rule per name per school, case-insensitively.

   Two rules called "Fee reminder" that differ only in a condition nobody can
   see from the list is how a school ends up sending the same chase twice and
   blaming the software. Neither column is nullable, so this is a plain unique
   index and needs no COALESCE. */
CREATE UNIQUE INDEX message_trigger_rules_one_per_name
    ON message_trigger_rules (institution_id, lower(name));

-- The sweep's own query: the live rules for one event.
CREATE INDEX message_trigger_rules_live
    ON message_trigger_rules (institution_id, event) WHERE is_active;

COMMENT ON TABLE message_trigger_rules IS
    'Send a message when something happens. One row per rule: event, condition, audience, template, lead time and quiet hours. Read by the messaging sweep in internal/api/messaging.go; other features emit events rather than sending directly.';
COMMENT ON COLUMN message_trigger_rules.event IS
    'noun.verb, e.g. student.absent, invoice.overdue, ptm.upcoming. Open by design — a feature may emit a new event without a migration.';
COMMENT ON COLUMN message_trigger_rules.condition IS
    'Flat constraint map over the occurrence facts: min_<fact> >=, max_<fact> <=, any other key is equality. {} matches every occurrence.';
COMMENT ON COLUMN message_trigger_rules.audience IS
    'guardians | student | staff | role:<role_key>, resolved relative to the occurrence.';
COMMENT ON COLUMN message_trigger_rules.lead_minutes IS
    'Minutes before the occurrence to send. 1440 is the day before; 0 is at the moment it happens.';

ALTER TABLE message_trigger_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_trigger_rules FORCE  ROW LEVEL SECURITY;

CREATE POLICY message_trigger_rules_tenant ON message_trigger_rules
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP TABLE IF EXISTS message_trigger_rules;
DROP INDEX IF EXISTS message_log_due;
DROP INDEX IF EXISTS message_log_one_per_occurrence;
ALTER TABLE message_log
    DROP COLUMN IF EXISTS attempts,
    DROP COLUMN IF EXISTS send_after,
    DROP COLUMN IF EXISTS occurrence_key,
    DROP COLUMN IF EXISTS source_id,
    DROP COLUMN IF EXISTS source_kind;
