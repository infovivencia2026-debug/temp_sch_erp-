-- +goose Up
-- Renumbered from 00100 at integration: the WhatsApp migration took 00101
-- while this was in flight.
-- The phone SMS gateway: a spare Android handset with a SIM becomes the
-- school's SMS provider.
--
-- Numbered 00100 as instructed. May be renumbered at integration -- goose keys
-- on the numeric prefix alone, so a collision means the loser is silently
-- skipped once its number is already recorded.
--
-- Every comment in this file is a line comment. goose's statement splitter
-- counts semicolons without understanding a slash-star comment, so a ';'
-- inside a block comment truncates the statement it sits in.
--
-- ---------------------------------------------------------------------------
-- What is here, and what is deliberately not
--
-- Three tables: the paired handset, the short-lived pairing code, and the
-- claim ledger that stops two phones sending the same message twice.
--
-- No table here holds a message body. message_log already holds it, and it is
-- the only place a body is allowed to live: the bodies are children's names,
-- fee amounts and absence notices, so a second copy is a second thing to
-- protect, a second thing to prune, and a second thing to leak. The ledger
-- references message_log(id) and the outbox endpoint reads the body through
-- that reference at the moment the phone asks for it.
--
-- No table here holds a recipient number either, for the same reason.
--
-- ---------------------------------------------------------------------------
-- What this is not
--
-- Not a replacement for a licensed bulk-SMS provider. Indian commercial SMS
-- needs DLT-registered sender ids and templates. A personal SIM sending
-- hundreds of messages will be throttled by the carrier and may be
-- disconnected. This is for a school of a few hundred families sending tens of
-- messages a day. The admin screen says so in the product, not only here.

-- ===========================================================================
-- 1. The paired handset
-- ===========================================================================

-- One row per phone a school has paired. The row is the device's identity, its
-- credential, and everything the admin screen needs to answer the only
-- question that matters: is this thing still alive.
--
-- A gateway that has silently died is worse than no gateway, because the
-- school believes messages are going out. So the liveness columns are on the
-- device row rather than derived from a log: the screen must be able to say
-- "not heard from for 40 minutes" without a scan.
CREATE TABLE sms_gateway_devices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- What the office calls this phone. Supplied by the handset at claim time
    -- and editable from the admin screen, because "Redmi Note 12" is what the
    -- device reports and "front office drawer" is what somebody needs to read
    -- at 4pm when messages have stopped.
    name            text NOT NULL,

    android_version text,
    sim_operator    text,
    app_version     text,

    -- The device's only credential, sealed with the same AES-GCM helper that
    -- protects the SMTP password (sealSecret in internal/api/messaging.go).
    --
    -- Sealed, not hashed, and deliberately not looked up by. AES-GCM uses a
    -- random nonce, so the ciphertext is not deterministic and cannot be an
    -- index key. The token the phone presents therefore carries this row's id
    -- in front of the secret: the server reads the id, opens this column, and
    -- compares in constant time. That keeps the stored form reversible-only-
    -- with-CREDENTIAL_KEY, which is the property asked for, without inventing
    -- a second at-rest scheme beside the one this codebase already operates.
    token_sealed    bytea NOT NULL,

    -- Which pair code produced this device. NOT NULL and UNIQUE below, which
    -- is what makes a pair code single-use structurally rather than by the
    -- handler remembering to check.
    pair_code_id    uuid NOT NULL,

    paired_at       timestamptz NOT NULL DEFAULT now(),
    -- The administrator who generated the code. Null once that user is
    -- deleted; the pairing itself is not invalidated by staff turnover.
    paired_by       uuid REFERENCES users(id) ON DELETE SET NULL,

    -- Revocation is a column, not a DELETE. A revoked phone's dispatch history
    -- is the audit trail for messages that did go out, and deleting the device
    -- would orphan it.
    revoked_at      timestamptz,
    revoked_reason  text,

    -- --- what the heartbeat reports -------------------------------------
    --
    -- last_seen_at is the single most important column in this file. Every
    -- staleness judgement on the admin screen and in the provider's
    -- Configured() answer is read from it.
    last_seen_at    timestamptz,
    battery_pct     integer,
    charging        boolean,
    signal_dbm      integer,
    sim_ready       boolean,
    -- What the handset believes it has sent today. Advisory: the authoritative
    -- count is the dispatch ledger below. Kept because a disagreement between
    -- the two is itself worth seeing.
    sent_today      integer NOT NULL DEFAULT 0,

    -- --- what the server tells the phone --------------------------------
    --
    -- The phone obeys rather than deciding for itself. One SIM, one rate:
    -- carriers throttle, so the cadence is the server's to set.
    poll_seconds    integer NOT NULL DEFAULT 20,
    per_minute_cap  integer NOT NULL DEFAULT 6,
    -- Paused stops the outbox handing this device anything without revoking
    -- its credential, which is what an office wants when the phone is being
    -- carried home for the weekend.
    paused          boolean NOT NULL DEFAULT false,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sms_gateway_devices_name_present
        CHECK (btrim(name) <> ''),
    CONSTRAINT sms_gateway_devices_battery
        CHECK (battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100),
    -- A plausible GSM range. Junk here would be rendered as a signal bar the
    -- office trusts.
    CONSTRAINT sms_gateway_devices_signal
        CHECK (signal_dbm IS NULL OR signal_dbm BETWEEN -140 AND 0),
    -- Five seconds is a battery fire; five minutes is a fee reminder that
    -- leaves late. Both ends are bounded so a bad config cannot do either.
    CONSTRAINT sms_gateway_devices_poll
        CHECK (poll_seconds BETWEEN 5 AND 300),
    -- Above roughly one a second any Indian carrier begins dropping messages
    -- silently, which reads to the school as the gateway working.
    CONSTRAINT sms_gateway_devices_cap
        CHECK (per_minute_cap BETWEEN 1 AND 60),
    CONSTRAINT sms_gateway_devices_sent_today
        CHECK (sent_today >= 0),
    CONSTRAINT sms_gateway_devices_revoke_pair
        CHECK ((revoked_at IS NULL) OR (revoked_at >= paired_at))
);

-- One live phone per name per school.
--
-- The nullable-UNIQUE trap, and why this is a partial index rather than a
-- COALESCE. A UNIQUE index containing a nullable column enforces nothing,
-- because NULL is distinct from every other NULL -- the usual fix here is
-- COALESCE(col, '00000000-0000-0000-0000-000000000000'::uuid). It is the wrong
-- fix for revoked_at: COALESCE(revoked_at, 'epoch') would additionally forbid
-- two devices of the same name being revoked at the same instant, which is a
-- spurious error rather than a rule anybody wants. A partial index says
-- exactly what is meant -- uniqueness among the live rows -- and has no
-- nullable column in its key at all.
CREATE UNIQUE INDEX sms_gateway_devices_one_live_name
    ON sms_gateway_devices (institution_id, lower(name))
 WHERE revoked_at IS NULL;

-- The provider's liveness question: has any device on this school reported in
-- recently. Asked on every dispatch, so it must not be a scan.
CREATE INDEX sms_gateway_devices_live
    ON sms_gateway_devices (institution_id, last_seen_at DESC)
 WHERE revoked_at IS NULL;

COMMENT ON TABLE sms_gateway_devices IS
    'An Android handset paired as this school''s SMS sender. Holds the sealed device token, the heartbeat the admin screen judges liveness by, and the rate the server tells the phone to obey. Never holds a message body or a recipient number.';
COMMENT ON COLUMN sms_gateway_devices.token_sealed IS
    'The device credential under sealSecret (AES-GCM, CREDENTIAL_KEY). Not an index key: the token the phone presents carries the device id in front of the secret, so lookup is by id and the comparison is constant time.';
COMMENT ON COLUMN sms_gateway_devices.last_seen_at IS
    'Last heartbeat. Every staleness judgement reads this; a device past the heartbeat window makes the sms provider report Configured()=false with the elapsed time in the reason.';
COMMENT ON COLUMN sms_gateway_devices.per_minute_cap IS
    'Messages per minute this handset may send. The server decides the rate and the phone obeys, because a SIM that exceeds what the carrier tolerates is throttled or disconnected.';

-- ===========================================================================
-- 2. The pairing code
-- ===========================================================================

-- A short-lived, single-use code an administrator reads off the admin screen
-- and types into the handset.
--
-- The claim endpoint that consumes this is unauthenticated -- it has to be,
-- since the phone has no credential until it succeeds -- so the code is the
-- entire boundary. It is therefore stored as a SHA-256 digest and never in
-- clear: a database dump must not be a set of working pairing codes for every
-- school that has one open.
--
-- Hashed rather than sealed, unlike the device token above, because the claim
-- looks the row up *by the code* and has no institution to narrow it to. That
-- needs a deterministic key, which AES-GCM's random nonce cannot provide. The
-- input is high-entropy and lives ten minutes, so a digest is the right shape.
CREATE TABLE sms_gateway_pair_codes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    code_hash       bytea NOT NULL,

    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,

    -- Set the moment a device claims it. The handler checks this under the
    -- row's own lock, so two handsets racing on one code cannot both win.
    claimed_at      timestamptz,
    -- Cleared rather than cascading if the device is ever hard-deleted: the
    -- fact that this code was used must survive the device row.
    claimed_device_id uuid REFERENCES sms_gateway_devices(id) ON DELETE SET NULL,

    CONSTRAINT sms_gateway_pair_codes_window
        CHECK (expires_at > created_at),
    CONSTRAINT sms_gateway_pair_codes_claim_pair
        CHECK ((claimed_at IS NULL) = (claimed_device_id IS NULL))
);

-- The claim's only lookup, and the reason it can be unauthenticated: a code is
-- globally unique, so the exchange never has to be told which school it is
-- for, and therefore can never be used to discover whether one exists.
CREATE UNIQUE INDEX sms_gateway_pair_codes_by_hash
    ON sms_gateway_pair_codes (code_hash);

-- The admin screen's list of codes still outstanding, and the sweep that
-- retires them.
CREATE INDEX sms_gateway_pair_codes_live
    ON sms_gateway_pair_codes (institution_id, expires_at DESC)
 WHERE claimed_at IS NULL;

-- One device per code, enforced by the schema rather than by the handler.
--
-- Here the nullable-UNIQUE trap is real and is taken seriously: pair_code_id
-- on the device is NOT NULL precisely so this index needs no COALESCE. Had it
-- been nullable, this UNIQUE would have enforced nothing and a replayed code
-- would have produced a second working device -- two phones, one school, and
-- every parent messaged twice.
ALTER TABLE sms_gateway_devices
    ADD CONSTRAINT sms_gateway_devices_pair_code_fk
    FOREIGN KEY (pair_code_id) REFERENCES sms_gateway_pair_codes(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX sms_gateway_devices_one_per_pair_code
    ON sms_gateway_devices (pair_code_id);

COMMENT ON TABLE sms_gateway_pair_codes IS
    'A single-use, ten-minute code that exchanges for a device token on the unauthenticated claim endpoint. Stored as a SHA-256 digest, never in clear; globally unique so the exchange never names an institution.';
COMMENT ON COLUMN sms_gateway_pair_codes.code_hash IS
    'SHA-256 of the 8-character code. Hashed rather than sealed because the claim looks up by the code with no institution to narrow to, which needs a deterministic key.';

-- ===========================================================================
-- 3. The claim ledger
-- ===========================================================================

-- One row per message handed to the phone gateway. This is what stops two
-- phones paired to one school sending the same message twice.
--
-- The whole table is state about a message, never a copy of one. message_id is
-- the reference; body, subject and recipient stay in message_log where they
-- already are. `error` holds the handset's failure reason -- "no service",
-- "SIM not ready" -- which is a fact about the radio, not about the parent.
--
-- The claim protocol, and why it is shaped this way:
--
--   queued      -> nobody holds it
--   dispatching -> a named device holds it until lease_expires_at
--   sent        -> the device confirmed it left the handset
--   failed      -> the device reported a reason it did not
--   expired     -> claimed and never confirmed, too many times to try again
--
-- The claim runs FOR UPDATE SKIP LOCKED so a second phone polling at the same
-- moment walks past the rows the first is taking rather than blocking on them.
--
-- The lease is what makes a phone that falls down a stairwell recoverable
-- without making a parent read the same fee demand twice: an unconfirmed lease
-- returns to queued a bounded number of times and then stops, because a
-- message that may already have been sent is not worth sending again.
CREATE TABLE sms_gateway_dispatch (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- The reference, and the whole of the relationship to the message. Not a
    -- copy of it.
    message_id      uuid NOT NULL REFERENCES message_log(id) ON DELETE CASCADE,

    -- Which handset holds or held it. Nullable: a queued row has no device,
    -- and a revoked-then-deleted device must not take the history with it.
    device_id       uuid REFERENCES sms_gateway_devices(id) ON DELETE SET NULL,

    state           text NOT NULL DEFAULT 'queued',

    -- How many times this message has been leased. Bounded in the handler, and
    -- the bound is the duplicate-suppression rule made countable.
    attempt         integer NOT NULL DEFAULT 0,

    lease_expires_at timestamptz,
    claimed_at      timestamptz,
    completed_at    timestamptz,

    -- Multipart count as the handset reports it, so a school can see what a
    -- campaign actually costs rather than counting messages and being wrong by
    -- a factor of three on anything with a name in Telugu.
    parts           integer,

    -- The handset's reason, capped by the handler. Never a body.
    error           text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sms_gateway_dispatch_state
        CHECK (state IN ('queued','dispatching','sent','failed','expired')),
    CONSTRAINT sms_gateway_dispatch_attempt
        CHECK (attempt >= 0),
    CONSTRAINT sms_gateway_dispatch_parts
        CHECK (parts IS NULL OR parts >= 0),
    -- A dispatching row without a lease is a row nothing will ever reclaim.
    CONSTRAINT sms_gateway_dispatch_lease_present
        CHECK (state <> 'dispatching' OR (lease_expires_at IS NOT NULL AND device_id IS NOT NULL))
);

-- One ledger row per message, which is the idempotency anchor for receipts.
--
-- A phone that sends and then loses the network before acknowledging will
-- retry the receipt. That retry must land on this row and change nothing,
-- rather than create a second row that a later sweep re-queues -- a second
-- send to a parent is the failure that matters here.
--
-- message_id is NOT NULL, so this is a plain UNIQUE and the nullable-UNIQUE
-- trap does not bite. Stated rather than assumed: every UNIQUE in this file
-- was checked for it.
CREATE UNIQUE INDEX sms_gateway_dispatch_one_per_message
    ON sms_gateway_dispatch (message_id);

-- The outbox claim's own query: what is takeable for this school right now.
-- Covers both legs of the claim predicate -- never-claimed rows and rows whose
-- lease has run out -- so a poll every twenty seconds is an index read.
CREATE INDEX sms_gateway_dispatch_claimable
    ON sms_gateway_dispatch (institution_id, state, lease_expires_at);

-- The admin screen: what this handset did, and what went wrong.
--
-- completed_at is indexed as a timestamp, not as a date. Casting it to a date
-- would need a time zone to be meaningful and is therefore not IMMUTABLE, so
-- it cannot be an index expression; "today" is a bounded range over this index
-- computed in the query instead.
CREATE INDEX sms_gateway_dispatch_by_device
    ON sms_gateway_dispatch (institution_id, device_id, completed_at DESC);

COMMENT ON TABLE sms_gateway_dispatch IS
    'The claim ledger for the phone SMS gateway: one row per message, referencing message_log rather than copying it. Rows move to dispatching under FOR UPDATE SKIP LOCKED with a device id and a lease, which is what stops two paired phones sending the same message twice.';
COMMENT ON COLUMN sms_gateway_dispatch.message_id IS
    'The message this is about. A reference, never a copy — body, subject and recipient live only in message_log.';
COMMENT ON COLUMN sms_gateway_dispatch.lease_expires_at IS
    'When an unconfirmed claim returns to queued. Bounded by attempt: a message that may already have left the handset is not re-sent indefinitely.';
COMMENT ON COLUMN sms_gateway_dispatch.error IS
    'The handset''s own failure reason, capped by the handler. A fact about the radio, never about the recipient.';

-- ===========================================================================
-- 4. Tenancy
-- ===========================================================================

-- Copied from migrations/00044_messaging.sql. FORCE matters as much as ENABLE:
-- without it the owner role bypasses the policy, and the owner is who
-- migrations and a psql session connect as.

ALTER TABLE sms_gateway_devices    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_gateway_devices    FORCE  ROW LEVEL SECURITY;
ALTER TABLE sms_gateway_pair_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_gateway_pair_codes FORCE  ROW LEVEL SECURITY;
ALTER TABLE sms_gateway_dispatch   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_gateway_dispatch   FORCE  ROW LEVEL SECURITY;

CREATE POLICY sms_gateway_devices_tenant ON sms_gateway_devices
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY sms_gateway_pair_codes_tenant ON sms_gateway_pair_codes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY sms_gateway_dispatch_tenant ON sms_gateway_dispatch
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON sms_gateway_devices    TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON sms_gateway_pair_codes TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON sms_gateway_dispatch   TO app_user;

-- +goose Down
--
-- One statement, not three. sms_gateway_devices and sms_gateway_pair_codes
-- reference each other -- the device names the code it was born from, the code
-- names the device it produced -- so there is no order in which three separate
-- DROPs succeed. Listing them together drops the constraints with the tables.
DROP TABLE IF EXISTS sms_gateway_dispatch, sms_gateway_devices, sms_gateway_pair_codes;
