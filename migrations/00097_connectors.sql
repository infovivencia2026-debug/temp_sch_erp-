-- +goose Up
-- Renumbered from 00090 at integration: five migrations landed above it while
-- this was in flight, and goose refuses a migration below the current version.
--
-- NOTE TO THE INTEGRATOR: this file claims 00090 as assigned. It may be
-- renumbered on the way in; nothing below depends on its own number.
--
-- Two platform connectors, built the way 00049_tally.sql built the first one:
-- the configuration, the mapping, the record of what moved, a file route that
-- works today, and a credential table a school's own administrator cannot
-- read. Neither far end exists on this deployment. Neither is pretended into
-- existence -- internal/connectors refuses by name rather than returning a
-- plausible success, and live_push_available comes off the server so no screen
-- can promise more than the product does.
--
-- Every comment here is a line comment. goose's splitter counts semicolons
-- without understanding block comments, so a ';' inside a /* */ ends the
-- statement early and the migration fails halfway. Four runs have been lost to
-- that; this file does not use block comments at all.

-- The composite keys everything below leans on.
--
-- Both crm_lead_links and virtual_meeting_requests reference their parent by
-- (id, institution_id) rather than by id alone, so a row can never name
-- another tenant's enquiry or session whatever uuid a caller supplies. RLS
-- stops a read across tenants; it does not stop a write of a guessed id. That
-- shape needs a matching unique constraint on each parent, and neither has
-- one: 00001 and 00041 both keyed on id alone. Added here rather than by
-- editing migrations that belong to other agents and are already applied.
ALTER TABLE enquiries
    ADD CONSTRAINT enquiries_id_institution UNIQUE (id, institution_id);
ALTER TABLE virtual_class_sessions
    ADD CONSTRAINT virtual_class_sessions_id_institution UNIQUE (id, institution_id);

-- =========================================================================
-- PART ONE -- Meritto / LeadSquared
-- =========================================================================
--
-- These are admissions-marketing CRMs. The school's counsellors work leads in
-- one of them; this product holds the same leads in `enquiries`, with the
-- funnel columns 00026 added. A "sync" is therefore four separate questions,
-- and the tables below are one each:
--
--   which CRM, in which direction        -> crm_connector_settings
--   which of our fields is which of theirs -> crm_field_mappings
--   which of our leads IS which of theirs  -> crm_lead_links
--   what actually moved, and what failed   -> crm_sync_runs / _run_items
--
-- The third is the one that matters. A sync run twice must not create two
-- leads for one child: a school that ends up with duplicate leads gets two
-- counsellors ringing the same parent, which is worse than no integration.
-- So every lead that has ever crossed the boundary carries a stable external
-- id in crm_lead_links, the upsert keys on it, and the CSV import matches on
-- it before it matches on anything human like a phone number.

-- --- which CRM, and which way ---------------------------------------------

-- One row per school. Nullable provider so the screen opens before anything is
-- chosen, and the sync refuses rather than guessing.
CREATE TABLE crm_connector_settings (
    institution_id  uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,

    -- 'meritto' or 'leadsquared'. Not an enum: a school moving from one to the
    -- other is a text update, whereas an enum is a migration.
    provider        text,

    -- Which way leads travel.
    --   push  -- our enquiries go out to the CRM
    --   pull  -- their status comes back to us
    --   both  -- and the conflict rule below decides who wins
    -- A school whose counsellors live in the CRM wants 'pull' and nothing
    -- else; one using this product as the system of record wants 'push'.
    direction       text NOT NULL DEFAULT 'push',

    -- What happens when the same lead changed on both sides since the last
    -- run. There is no correct answer, only a decided one, and a connector
    -- that silently picks last-writer-wins loses a counsellor's call notes.
    --   ours       -- our value survives, theirs is recorded on the run item
    --   theirs     -- their value survives
    --   newest     -- the later of the two timestamps
    --   flag       -- neither is applied; the row is listed for a human
    conflict_policy text NOT NULL DEFAULT 'flag',

    -- How records move. 'csv' is the one that works: the school exports from
    -- here and imports into the CRM, and back. 'api' is recorded so the
    -- setting survives the day a key exists, and internal/connectors refuses
    -- it in the meantime.
    transport       text NOT NULL DEFAULT 'csv',

    -- Off until somebody has mapped the fields. An enabled connector with no
    -- mapping produces a file the CRM rejects on row one.
    is_enabled      boolean NOT NULL DEFAULT false,

    -- The watermark a 'pull' asks from, so a second run does not re-read the
    -- whole history. Set by the run, not by a human.
    last_synced_at  timestamptz,

    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT crm_connector_settings_provider
        CHECK (provider IS NULL OR provider IN ('meritto','leadsquared')),
    CONSTRAINT crm_connector_settings_direction
        CHECK (direction IN ('push','pull','both')),
    CONSTRAINT crm_connector_settings_conflict
        CHECK (conflict_policy IN ('ours','theirs','newest','flag')),
    CONSTRAINT crm_connector_settings_transport
        CHECK (transport IN ('csv','api'))
);

COMMENT ON TABLE crm_connector_settings IS
    'Per-school CRM connector configuration: which CRM, which direction, what happens on a conflict, and how records travel. No credentials — those are in crm_api_credentials, which a school administrator cannot read.';

ALTER TABLE crm_connector_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_connector_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY crm_connector_settings_tenant ON crm_connector_settings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_connector_settings TO app_user;

-- --- which field is which --------------------------------------------------

-- Our lead model against the CRM's. A table rather than a constant because the
-- CRM half is a per-tenant custom field name: LeadSquared calls a custom field
-- 'mx_Class_Sought' in one account and 'mx_ClassApplied' in the next, and a
-- hardcoded map silently drops the column in the second school.
--
-- Unmapped is visibly unmapped. Nothing is defaulted from the field name, for
-- the reason tally_ledger_mappings gives: a plausible auto-mapping writes the
-- wrong data into a real CRM and nobody notices until a counsellor rings the
-- wrong number.
CREATE TABLE crm_field_mappings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- Our side. Constrained to the lead fields internal/connectors knows how
    -- to read and write, so a mapping cannot name a column that does not
    -- exist and fail at run time instead of at save time.
    local_field     text NOT NULL,

    -- Their side, verbatim, including the mx_ prefix LeadSquared uses.
    crm_field       text NOT NULL,

    -- A mapping may be push-only. 'status' is the usual case: a school that
    -- works leads in the CRM pulls status and pushes everything else.
    direction       text NOT NULL DEFAULT 'both',

    -- Refuse the run rather than send a blank the CRM stores as a real value.
    is_required     boolean NOT NULL DEFAULT false,

    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT crm_field_mappings_local CHECK (local_field IN (
        'student_name','parent_name','phone','email','class_sought','source',
        'campaign','status','assigned_to','next_follow_up','notes',
        'utm_source','utm_medium','utm_campaign','referred_by','created_at')),
    CONSTRAINT crm_field_mappings_direction
        CHECK (direction IN ('push','pull','both')),
    CONSTRAINT crm_field_mappings_crm_not_blank
        CHECK (btrim(crm_field) <> '')
);

-- One mapping per field. Both columns NOT NULL, so a plain UNIQUE is honest
-- here -- see crm_api_credentials below for the case in this file that is not.
CREATE UNIQUE INDEX crm_field_mappings_one_per_field
    ON crm_field_mappings (institution_id, local_field);

ALTER TABLE crm_field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_field_mappings FORCE  ROW LEVEL SECURITY;

CREATE POLICY crm_field_mappings_tenant ON crm_field_mappings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_field_mappings TO app_user;

-- --- which of our leads IS which of theirs ---------------------------------

-- The identity table, and the whole defence against duplicates.
--
-- Without it, a second push has no way to know it has pushed before, so it
-- creates every lead again: two rows in the CRM for one child, two counsellors
-- assigned, two parents rung. Matching on phone number instead is not a
-- substitute -- siblings share a parent's phone, and a family that changes
-- number breaks the link exactly when the lead is hot.
--
-- external_id is whatever the CRM calls its own row (a Meritto lead id, a
-- LeadSquared ProspectId). It is opaque here and must be stored verbatim.
CREATE TABLE crm_lead_links (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    provider        text NOT NULL,

    -- Composite FK: a link can never point at another tenant's enquiry,
    -- whatever uuid a caller supplies. RLS stops a read across tenants; it
    -- does not stop a write of a guessed id.
    enquiry_id      uuid NOT NULL,

    external_id     text NOT NULL,

    -- Their status, as they last told us, kept raw. Mapped to ours on the way
    -- in; kept here unmapped so an unrecognised status can be diagnosed rather
    -- than lost.
    external_status text,

    -- The two clocks the conflict rule compares. remote_updated_at is what the
    -- CRM claims, ours is what we saw.
    remote_updated_at timestamptz,
    local_updated_at  timestamptz,

    last_pushed_at  timestamptz,
    last_pulled_at  timestamptz,

    -- Set when both sides moved and conflict_policy is 'flag'. A human clears
    -- it by deciding; nothing clears it automatically, because a sync that
    -- resolves its own conflicts silently is the failure this column names.
    conflict_at     timestamptz,
    conflict_note   text,

    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT crm_lead_links_provider CHECK (provider IN ('meritto','leadsquared')),
    CONSTRAINT crm_lead_links_external_not_blank CHECK (btrim(external_id) <> ''),
    CONSTRAINT crm_lead_links_conflict_paired
        CHECK ((conflict_at IS NULL) OR (conflict_note IS NOT NULL)),

    FOREIGN KEY (enquiry_id, institution_id)
        REFERENCES enquiries (id, institution_id) ON DELETE CASCADE
);

-- The idempotency key, in both directions, and both are needed.
--
-- One external id maps to one enquiry: a second import of the same file must
-- update the lead it created the first time, not add another.
CREATE UNIQUE INDEX crm_lead_links_one_per_external
    ON crm_lead_links (institution_id, provider, external_id);

-- And one enquiry maps to one external id: a second push of the same enquiry
-- must not mint a second lead in the CRM. Both columns are NOT NULL, so these
-- are plain UNIQUEs and enforce what they appear to.
CREATE UNIQUE INDEX crm_lead_links_one_per_enquiry
    ON crm_lead_links (institution_id, provider, enquiry_id);

-- What the screen opens on: the conflicts, newest first.
CREATE INDEX crm_lead_links_conflicts
    ON crm_lead_links (institution_id, conflict_at DESC)
 WHERE conflict_at IS NOT NULL;

COMMENT ON TABLE crm_lead_links IS
    'The identity map between enquiries and CRM leads. Two UNIQUE indexes make the sync idempotent in both directions: syncing twice updates one lead rather than creating a second, which is the failure that has counsellors ringing the same parent twice.';

ALTER TABLE crm_lead_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_lead_links FORCE  ROW LEVEL SECURITY;

CREATE POLICY crm_lead_links_tenant ON crm_lead_links
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_lead_links TO app_user;

-- --- what moved, and what did not ------------------------------------------

-- One sync. Recorded whether or not anything moved, because "the run found
-- nothing" and "no run happened" are different facts and only the first
-- exonerates the connector.
CREATE TABLE crm_sync_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    provider        text NOT NULL,
    direction       text NOT NULL,
    transport       text NOT NULL DEFAULT 'csv',

    -- 'ok' when every record was applied, 'partial' when some failed, 'failed'
    -- when the run itself could not proceed -- an unmapped required field, a
    -- transport that refuses.
    status          text NOT NULL DEFAULT 'ok',

    considered      integer NOT NULL DEFAULT 0,
    created_count   integer NOT NULL DEFAULT 0,
    updated_count   integer NOT NULL DEFAULT 0,
    -- Records the run deliberately did not act on because they were already
    -- linked and unchanged. The number that proves idempotency held.
    skipped_count   integer NOT NULL DEFAULT 0,
    conflict_count  integer NOT NULL DEFAULT 0,
    failed_count    integer NOT NULL DEFAULT 0,

    detail          text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    run_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT crm_sync_runs_provider CHECK (provider IN ('meritto','leadsquared')),
    CONSTRAINT crm_sync_runs_direction CHECK (direction IN ('push','pull')),
    CONSTRAINT crm_sync_runs_transport CHECK (transport IN ('csv','api')),
    CONSTRAINT crm_sync_runs_status CHECK (status IN ('ok','partial','failed')),
    CONSTRAINT crm_sync_runs_counts CHECK (
        considered >= 0 AND created_count >= 0 AND updated_count >= 0
        AND skipped_count >= 0 AND conflict_count >= 0 AND failed_count >= 0),
    UNIQUE (id, institution_id)
);

CREATE INDEX crm_sync_runs_recent
    ON crm_sync_runs (institution_id, started_at DESC);

ALTER TABLE crm_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_runs FORCE  ROW LEVEL SECURITY;

CREATE POLICY crm_sync_runs_tenant ON crm_sync_runs
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_sync_runs TO app_user;

-- One record within one run. The answer to "why is this lead not in the CRM",
-- which is the only question anybody asks about a sync.
CREATE TABLE crm_sync_run_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    run_id          uuid NOT NULL,

    -- Nullable: a pulled row that matched nothing here and could not be
    -- created (no phone, say) has an external id and no enquiry.
    enquiry_id      uuid,
    external_id     text,

    -- What the run did. 'skipped' is a success, not a failure: it is the
    -- second run finding the lead already linked and unchanged.
    action          text NOT NULL,
    -- Shown verbatim. "row 14: phone is blank" is useful; "invalid" is not.
    message         text,

    CONSTRAINT crm_sync_run_items_action CHECK (action IN
        ('created','updated','skipped','conflict','failed')),

    FOREIGN KEY (run_id, institution_id)
        REFERENCES crm_sync_runs (id, institution_id) ON DELETE CASCADE
);

CREATE INDEX crm_sync_run_items_by_run
    ON crm_sync_run_items (run_id, action);

ALTER TABLE crm_sync_run_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_run_items FORCE  ROW LEVEL SECURITY;

CREATE POLICY crm_sync_run_items_tenant ON crm_sync_run_items
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_sync_run_items TO app_user;

-- --- the CRM keys ----------------------------------------------------------

-- Platform-only, exactly as tally_gateway_credentials is, and for the same
-- reason: an API key that can read and write every lead in the school's
-- marketing CRM is the vendor's to hold, not the school's to read back off a
-- hosted screen. The policy below is app_is_platform_admin() with no tenant
-- limb, so an institution admin -- who holds every other key in this product
-- -- reads nothing here even for their own school.
--
-- There is no live API call today. internal/connectors.MerittoProvider and
-- LeadSquaredProvider return ErrCRMAPIUnavailable, always, and there is a test
-- pinning that so a later edit cannot quietly turn the refusal into a
-- fabricated success.
CREATE TABLE crm_api_credentials (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- NULL means an installation-wide default: one CRM account serving every
    -- campus of a trust, which is the normal arrangement for a group that buys
    -- one LeadSquared licence.
    --
    -- And here is the nullable-UNIQUE trap, live. A plain UNIQUE
    -- (provider, institution_id) would admit unlimited NULL rows, because NULL
    -- is distinct from every other NULL, so the "one default per provider"
    -- rule would enforce nothing whatsoever. The index below COALESCEs to the
    -- nil uuid so the defaults have a value to collide on.
    institution_id  uuid REFERENCES institutions(id) ON DELETE CASCADE,

    provider        text NOT NULL,

    -- The regional endpoint. LeadSquared's differs by data centre and a key
    -- issued for one returns 401 against another, which reads as a bad key.
    base_url        text,

    -- Sealed with CREDENTIAL_KEY through sealSecret, never text. bytea rather
    -- than jsonb so there is no shape to be tempted into querying and no way
    -- for a jsonb operator to put a secret in a log line.
    credentials     bytea,

    notes           text,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT crm_api_credentials_provider CHECK (provider IN ('meritto','leadsquared')),
    CONSTRAINT crm_api_credentials_url_not_blank
        CHECK (base_url IS NULL OR btrim(base_url) <> '')
);

CREATE UNIQUE INDEX crm_api_credentials_one_per_scope
    ON crm_api_credentials
       (provider, COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid));

COMMENT ON TABLE crm_api_credentials IS
    'Platform-only. CRM API keys, sealed. The RLS policy is app_is_platform_admin() with no tenant escape, so an institution admin cannot read it for their own school. No live call is made today; internal/connectors refuses by name.';

ALTER TABLE crm_api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_api_credentials FORCE  ROW LEVEL SECURITY;

-- Deliberately NOT the usual institution_id = app_current_institution() shape.
-- Platform staff only, in both directions.
CREATE POLICY crm_api_credentials_platform_only ON crm_api_credentials
    USING (app_is_platform_admin())
    WITH CHECK (app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_api_credentials TO app_user;

-- =========================================================================
-- PART TWO -- the virtual classroom platform side
-- =========================================================================
--
-- The live-class model already exists and nothing here replaces it. 00041
-- built virtual_class_sessions (a scheduled class, a nullable join_url, a
-- 'provider_pending' status that is honest about having no meeting yet) and
-- virtual_class_providers (which account a school intends to host on -- and
-- says in its own comment that credentials belong in a platform store, which
-- is this one). faculty.teaching.live_virtual_class_launcher is the teacher's
-- screen over the top.
--
-- What was missing is the platform half: which meeting provider the
-- installation has an account with, its sealed credentials, which schools may
-- use it, and the seam where a real "create meeting" call would go. That is
-- the two tables below and nothing more.
--
-- The manually pasted join URL keeps working throughout. It is the fallback
-- and it stays the fallback: internal/connectors.ManualMeetingProvider is the
-- only meeting provider that returns a meeting, and it returns the URL a human
-- typed.

-- --- the installation's meeting account ------------------------------------

CREATE TABLE virtual_meeting_platform_providers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- NULL means the installation-wide account, used by every school that has
    -- no row of its own. Same nullable-UNIQUE trap as above, same COALESCE.
    institution_id  uuid REFERENCES institutions(id) ON DELETE CASCADE,

    -- The same three the launcher already knows, spelled identically to
    -- virtual_class_providers.provider. A fourth spelling of 'google_meet'
    -- would mean a session whose provider nothing can look up.
    provider        text NOT NULL,

    display_name    text NOT NULL,

    -- The provider's own identifier for the host account: a Zoom user id, a
    -- Workspace address. The first thing a support engineer asks for when a
    -- meeting fails to create.
    account_ref     text,

    -- Server-to-server OAuth for Zoom, a service account for Meet, an app
    -- registration for Teams. Recorded so the difference is configuration
    -- rather than a branch in code somebody has to find.
    auth_style      text NOT NULL DEFAULT 'oauth_s2s',
    base_url        text,

    -- Sealed through sealSecret. Never returned in a response: a screen needs
    -- to know whether a credential is set, which is a boolean.
    credentials     bytea,

    -- Whether schools in scope may use this account at all. Distinct from
    -- whether a credential exists: an account may be configured and switched
    -- off during a billing dispute.
    is_enabled      boolean NOT NULL DEFAULT false,

    notes           text,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT virtual_meeting_platform_providers_provider
        CHECK (provider IN ('zoom','google_meet','ms_teams')),
    CONSTRAINT virtual_meeting_platform_providers_auth
        CHECK (auth_style IN ('oauth_s2s','service_account','app_registration')),
    CONSTRAINT virtual_meeting_platform_providers_name
        CHECK (btrim(display_name) <> ''),
    CONSTRAINT virtual_meeting_platform_providers_url_not_blank
        CHECK (base_url IS NULL OR btrim(base_url) <> '')
);

CREATE UNIQUE INDEX virtual_meeting_platform_providers_one_per_scope
    ON virtual_meeting_platform_providers
       (provider, COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid));

COMMENT ON TABLE virtual_meeting_platform_providers IS
    'Platform-only. The meeting account an installation (or one school) hosts live classes on, with sealed credentials. Complements virtual_class_providers, which records only which provider a school intends to use. No meeting is created through an API today; internal/connectors refuses by name and the pasted join URL remains the working path.';

ALTER TABLE virtual_meeting_platform_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_meeting_platform_providers FORCE  ROW LEVEL SECURITY;

CREATE POLICY virtual_meeting_platform_providers_platform_only
    ON virtual_meeting_platform_providers
    USING (app_is_platform_admin())
    WITH CHECK (app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON virtual_meeting_platform_providers TO app_user;

-- --- what would have been sent ---------------------------------------------

-- The queue. One row per time somebody asked for a meeting to be created for a
-- session, and what came of it.
--
-- It exists because the answer today is always "no provider can do this, paste
-- a URL", and a product that says that and forgets is a product where nobody
-- can tell how often it was wanted. When a credential arrives, this is the
-- backlog to drain and the shape a real call already writes its result into.
CREATE TABLE virtual_meeting_requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- Composite FK so a request can never name another tenant's session.
    session_id      uuid NOT NULL,

    provider        text NOT NULL,

    --   queued    -- asked for, nothing has run
    --   manual    -- refused by the provider seam; a human must paste a URL.
    --                The honest resting state on this deployment.
    --   created   -- a meeting exists and join_url on the session is set
    --   failed    -- something tried and could not
    status          text NOT NULL DEFAULT 'queued',

    -- Verbatim from the provider, including its refusal. A school reads this.
    detail          text,

    -- Filled only by a provider that actually created something.
    meeting_ref     text,
    join_url        text,

    requested_at    timestamptz NOT NULL DEFAULT now(),
    requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     timestamptz,

    CONSTRAINT virtual_meeting_requests_provider
        CHECK (provider IN ('zoom','google_meet','ms_teams','manual')),
    CONSTRAINT virtual_meeting_requests_status
        CHECK (status IN ('queued','manual','created','failed')),
    -- A request claiming a meeting exists must say where it is. Otherwise the
    -- launcher shows thirty children a button to nowhere.
    CONSTRAINT virtual_meeting_requests_created_has_url
        CHECK (status <> 'created' OR join_url IS NOT NULL),

    FOREIGN KEY (session_id, institution_id)
        REFERENCES virtual_class_sessions (id, institution_id) ON DELETE CASCADE
);

CREATE INDEX virtual_meeting_requests_recent
    ON virtual_meeting_requests (institution_id, requested_at DESC);

CREATE INDEX virtual_meeting_requests_open
    ON virtual_meeting_requests (institution_id, status)
 WHERE status IN ('queued','manual');

ALTER TABLE virtual_meeting_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_meeting_requests FORCE  ROW LEVEL SECURITY;

CREATE POLICY virtual_meeting_requests_tenant ON virtual_meeting_requests
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON virtual_meeting_requests TO app_user;

-- +goose Down

DROP TABLE IF EXISTS virtual_meeting_requests;
DROP TABLE IF EXISTS virtual_meeting_platform_providers;
DROP TABLE IF EXISTS crm_api_credentials;
DROP TABLE IF EXISTS crm_sync_run_items;
DROP TABLE IF EXISTS crm_sync_runs;
DROP TABLE IF EXISTS crm_lead_links;
DROP TABLE IF EXISTS crm_field_mappings;
DROP TABLE IF EXISTS crm_connector_settings;

ALTER TABLE virtual_class_sessions
    DROP CONSTRAINT IF EXISTS virtual_class_sessions_id_institution;
ALTER TABLE enquiries
    DROP CONSTRAINT IF EXISTS enquiries_id_institution;
