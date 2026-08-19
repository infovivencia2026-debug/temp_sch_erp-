-- +goose Up
-- Renumbered at integration: the parent forum took 00093 while this was in
-- flight, and goose refuses a migration numbered below the current version.
-- Admissions growth: the form a school designs, the nurture it sends, and the
-- reason a family walked away.
--
-- Numbered 00086 as instructed. May be renumbered at integration -- goose keys
-- on the numeric prefix alone, so a collision means the loser is silently
-- skipped once its number is already recorded.
--
-- Block comments are avoided throughout. goose's statement splitter does not
-- understand a semicolon inside a slash-star comment, so every note here is a
-- line comment.

-- ===========================================================================
-- 1. The online application form builder
-- ===========================================================================

-- A form the school designs, and the URL an applicant reaches it at.
--
-- The form is the stable thing -- "Nursery admission 2026-27" -- and it holds
-- no fields of its own. Every field belongs to a version, because the one
-- requirement that makes this feature honest rather than dangerous is that a
-- form already in use must never be silently mutated. A school that adds a
-- required field on Tuesday must not thereby make Monday's four hundred
-- submitted applications retrospectively invalid, or render them with a blank
-- box nobody was ever asked to fill in.
CREATE TABLE admission_forms (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid        REFERENCES campuses(id) ON DELETE SET NULL,
    -- Which intake this form collects for. Null means "whatever session is
    -- current", which is what a school with one intake actually wants.
    admission_session_id uuid   REFERENCES admission_sessions(id) ON DELETE SET NULL,

    name            text        NOT NULL,
    description     text,

    -- The public handle. An applicant arrives at /admissions/apply/<slug> with
    -- no account, so this is the only thing identifying which school and which
    -- form they are filling in. Random-ish and school-chosen rather than the
    -- id, because a school wants to print it on a poster.
    --
    -- Guessable by design: this is a public application form, not a secret.
    -- What protects it is that submission creates an application in 'submitted'
    -- and nothing else -- no read of any existing record, ever.
    slug            text        NOT NULL,

    -- Off by default. A form that went live the moment somebody started
    -- drafting it is the accident this flag prevents.
    is_open         boolean     NOT NULL DEFAULT false,
    opens_on        date,
    closes_on       date,

    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT admission_forms_name_present CHECK (btrim(name) <> ''),
    -- Lowercase, hyphenated, no surprises in a URL.
    CONSTRAINT admission_forms_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
    CONSTRAINT admission_forms_window CHECK (opens_on IS NULL OR closes_on IS NULL OR closes_on >= opens_on)
);

-- The slug is resolved with no session in hand, so it must be unique across
-- every school on the platform, not merely within one. institution_id is
-- deliberately NOT in this key.
CREATE UNIQUE INDEX admission_forms_slug ON admission_forms (slug);
CREATE UNIQUE INDEX admission_forms_name ON admission_forms (institution_id, lower(name));

-- One version of a form: a frozen definition, and the applications answered
-- against it.
--
-- status is the whole mechanism. A draft may be edited freely. A published
-- version may not be edited at all -- the API refuses, and the school edits by
-- taking a fresh draft from it, which becomes version n+1. A retired version
-- is still readable so that last season's applications render as they were
-- answered.
CREATE TABLE admission_form_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    form_id         uuid        NOT NULL REFERENCES admission_forms(id) ON DELETE CASCADE,
    version         integer     NOT NULL,
    status          text        NOT NULL DEFAULT 'draft',
    notes           text,
    published_at    timestamptz,
    published_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT admission_form_versions_status
        CHECK (status IN ('draft','published','retired')),
    CONSTRAINT admission_form_versions_version CHECK (version >= 1),
    -- A published version with no moment of publication is a row whose
    -- immutability nobody can date.
    CONSTRAINT admission_form_versions_published_dated
        CHECK ((status = 'published') = (published_at IS NOT NULL) OR status = 'retired')
);

CREATE UNIQUE INDEX admission_form_versions_no
    ON admission_form_versions (form_id, version);

-- Exactly one live definition per form. Without this a school with two
-- published versions has a form whose rendering depends on which row the
-- planner returned first.
CREATE UNIQUE INDEX admission_form_versions_one_live
    ON admission_form_versions (form_id) WHERE status = 'published';

-- Only one draft in flight, for the same reason: "edit the form" has to mean
-- one thing.
CREATE UNIQUE INDEX admission_form_versions_one_draft
    ON admission_form_versions (form_id) WHERE status = 'draft';

-- A heading and the run of fields under it.
CREATE TABLE admission_form_sections (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    version_id      uuid        NOT NULL REFERENCES admission_form_versions(id) ON DELETE CASCADE,
    title           text        NOT NULL,
    description     text,
    sequence        integer     NOT NULL DEFAULT 0,
    CONSTRAINT admission_form_sections_title_present CHECK (btrim(title) <> '')
);

CREATE UNIQUE INDEX admission_form_sections_title
    ON admission_form_sections (version_id, lower(title));
CREATE INDEX admission_form_sections_order
    ON admission_form_sections (version_id, sequence);

-- One question.
--
-- Validation lives here and is enforced by the server from these columns. The
-- browser may enforce it too, for the applicant's sake, but the browser is not
-- a party to the decision: this is an unauthenticated surface and every rule
-- the client applies is a rule an attacker simply does not run.
CREATE TABLE admission_form_fields (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    version_id      uuid        NOT NULL REFERENCES admission_form_versions(id) ON DELETE CASCADE,
    section_id      uuid        NOT NULL REFERENCES admission_form_sections(id) ON DELETE CASCADE,

    -- The stable name of the answer, e.g. 'mother_occupation'. What exports
    -- and reports key on, so it survives the label being reworded.
    --
    -- A code matching a reserved name (first_name, class_sought, parent_phone
    -- and the rest -- the list is in internal/api/admissions_growth.go) is
    -- written through to the applications row itself rather than kept only as
    -- an answer. That is what lets a school-designed form produce a real
    -- application instead of a bag of key-value pairs beside one.
    code            text        NOT NULL,
    label           text        NOT NULL,
    field_type      text        NOT NULL,
    help_text       text,
    placeholder     text,
    is_required     boolean     NOT NULL DEFAULT false,
    sequence        integer     NOT NULL DEFAULT 0,

    -- For 'select'. Either an explicit list, or the name of a custom_options
    -- kind so the school edits the vocabulary in one place rather than in
    -- every form that offers it. See internal/api/custom_options.go.
    options         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    option_kind     text,

    -- Server-side validation. All optional, all enforced.
    min_length      integer,
    max_length      integer,
    min_number      numeric,
    max_number      numeric,
    pattern         text,

    -- Show this field only when another answer says so:
    -- {"field": "has_sibling", "equals": "yes"}. Empty means always shown.
    --
    -- A hidden field is never required, and an answer to a hidden field is
    -- discarded -- both decided on the server, because "the box was not on
    -- screen" is a claim about the client.
    visible_when    jsonb       NOT NULL DEFAULT '{}'::jsonb,

    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT admission_form_fields_type
        CHECK (field_type IN ('text','textarea','number','date','select','checkbox','file','email','phone')),
    CONSTRAINT admission_form_fields_code_shape
        CHECK (code ~ '^[a-z][a-z0-9_]{1,48}$'),
    CONSTRAINT admission_form_fields_label_present CHECK (btrim(label) <> ''),
    CONSTRAINT admission_form_fields_lengths
        CHECK (min_length IS NULL OR max_length IS NULL OR max_length >= min_length),
    CONSTRAINT admission_form_fields_numbers
        CHECK (min_number IS NULL OR max_number IS NULL OR max_number >= min_number)
);

CREATE UNIQUE INDEX admission_form_fields_code
    ON admission_form_fields (version_id, lower(code));
CREATE INDEX admission_form_fields_order
    ON admission_form_fields (version_id, sequence);
CREATE INDEX admission_form_fields_section
    ON admission_form_fields (section_id, sequence);

-- What one applicant answered.
--
-- One typed column per shape rather than a single text blob: a date of birth
-- stored as text sorts as text, and the first report that asks "how many
-- applicants are under six" gets the wrong answer quietly.
CREATE TABLE application_form_answers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    application_id  uuid        NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    -- Denormalised from the field on purpose. It is what tells the renderer
    -- which definition to lay this application out with, and the field row
    -- alone would not survive the version being dropped.
    version_id      uuid        NOT NULL REFERENCES admission_form_versions(id) ON DELETE RESTRICT,
    field_id        uuid        NOT NULL REFERENCES admission_form_fields(id) ON DELETE RESTRICT,

    value_text      text,
    value_number    numeric,
    value_date      date,
    value_bool      boolean,
    -- A file field takes an id minted by POST /api/v1/files/presign, or a URL.
    -- The second exists because object storage answers 503
    -- storage_unconfigured on this deployment, and without the fallback every
    -- file field on every form would be decorative.
    file_id         uuid        REFERENCES files(id) ON DELETE SET NULL,
    external_url    text,

    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT application_form_answers_file_one
        CHECK (file_id IS NULL OR external_url IS NULL)
);

-- One answer per question per application. Both columns are NOT NULL, so no
-- COALESCE is needed here -- and a plain unique index that looks like it needs
-- one is worth saying so about, given how often the nullable-UNIQUE trap has
-- bitten this schema.
CREATE UNIQUE INDEX application_form_answers_once
    ON application_form_answers (application_id, field_id);
CREATE INDEX application_form_answers_version
    ON application_form_answers (version_id);

-- Which definition this application was answered under, so the office renders
-- it as the family saw it rather than as the form looks today.
ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS form_version_id uuid REFERENCES admission_form_versions(id) ON DELETE SET NULL,
    -- Filled by the public endpoint. Not an audit trail, a rate-limit and
    -- abuse question: "which address sent these ninety applications".
    ADD COLUMN IF NOT EXISTS submitted_from  text,
    ADD COLUMN IF NOT EXISTS submitted_at    timestamptz;

CREATE INDEX IF NOT EXISTS applications_form_version
    ON applications (form_version_id) WHERE form_version_id IS NOT NULL;

-- ===========================================================================
-- 2. Multi-touch campaign sequences
-- ===========================================================================

-- A nurture sequence: touch one on day zero, touch two on day three, touch
-- five on day fourteen.
--
-- Nothing here sends anything. Sending is message_log via QueueMessage in
-- internal/api/messaging.go, and this is deliberate: four features already
-- queued behind that foundation, and a fifth sender with its own provider
-- config and its own dedupe scheme would be the thing 00044 was written to
-- prevent.
CREATE TABLE admission_campaigns (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    name            text        NOT NULL,
    description     text,
    is_active       boolean     NOT NULL DEFAULT true,

    -- Enrol a lead automatically when an enquiry arrives from this source.
    -- Null means the sequence is only ever enrolled onto by hand, which is
    -- what a school running one campaign for one newspaper advert wants.
    auto_enrol_source text,

    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT admission_campaigns_name_present CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX admission_campaigns_name
    ON admission_campaigns (institution_id, lower(name));

-- One touch: how long after enrolment, on what channel, saying what.
--
-- template_code names a message_templates row and is not a foreign key, for
-- the same reason message_trigger_rules.template_code is not: the sender falls
-- back to a built-in body, so a step naming a code the school has not authored
-- yet is usable rather than broken.
CREATE TABLE admission_campaign_steps (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campaign_id     uuid        NOT NULL REFERENCES admission_campaigns(id) ON DELETE CASCADE,
    step_no         integer     NOT NULL,
    name            text        NOT NULL,
    -- Days after the lead was enrolled. 0 is the welcome message.
    offset_days     integer     NOT NULL DEFAULT 0,
    channel         text        NOT NULL,
    template_code   text        NOT NULL,
    -- The hours nobody is to be messaged, same shape as
    -- message_trigger_rules. Both or neither.
    quiet_from      time,
    quiet_to        time,
    is_active       boolean     NOT NULL DEFAULT true,

    CONSTRAINT admission_campaign_steps_no CHECK (step_no BETWEEN 1 AND 50),
    CONSTRAINT admission_campaign_steps_offset CHECK (offset_days BETWEEN 0 AND 365),
    CONSTRAINT admission_campaign_steps_channel
        CHECK (channel IN ('sms','email','whatsapp','push','in_app')),
    CONSTRAINT admission_campaign_steps_template CHECK (btrim(template_code) <> ''),
    CONSTRAINT admission_campaign_steps_name_present CHECK (btrim(name) <> ''),
    CONSTRAINT admission_campaign_steps_quiet_pair
        CHECK ((quiet_from IS NULL) = (quiet_to IS NULL))
);

CREATE UNIQUE INDEX admission_campaign_steps_no_idx
    ON admission_campaign_steps (campaign_id, step_no);
CREATE INDEX admission_campaign_steps_order
    ON admission_campaign_steps (campaign_id, offset_days);

-- One lead on one sequence.
--
-- stopped_reason is the column that makes this feature usable rather than
-- embarrassing. A parent who has already paid must not keep receiving "still
-- thinking it over?", so the runner checks the lead's state before every
-- single send and closes the enrolment the moment it converts or opts out.
CREATE TABLE admission_campaign_enrolments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campaign_id     uuid        NOT NULL REFERENCES admission_campaigns(id) ON DELETE CASCADE,
    enquiry_id      uuid        NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
    enrolled_at     timestamptz NOT NULL DEFAULT now(),
    enrolled_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
    status          text        NOT NULL DEFAULT 'active',
    stopped_at      timestamptz,
    stopped_reason  text,

    CONSTRAINT admission_campaign_enrolments_status
        CHECK (status IN ('active','completed','stopped')),
    CONSTRAINT admission_campaign_enrolments_stop_dated
        CHECK ((status = 'active') = (stopped_at IS NULL))
);

-- A lead enrolled twice on the same sequence would receive every touch twice.
CREATE UNIQUE INDEX admission_campaign_enrolments_once
    ON admission_campaign_enrolments (campaign_id, enquiry_id);
CREATE INDEX admission_campaign_enrolments_live
    ON admission_campaign_enrolments (institution_id, status) WHERE status = 'active';
CREATE INDEX admission_campaign_enrolments_lead
    ON admission_campaign_enrolments (enquiry_id);

-- What happened to one touch for one lead.
--
-- Separate from message_log rather than derived from it. message_log dedupes a
-- send that was attempted; this table records a touch that was deliberately
-- skipped -- because the lead converted, because the school has no SMS gateway
-- yet, because there is no phone number on the enquiry -- and "we did not send
-- it, and here is why" is exactly what a nurture screen has to be able to say.
CREATE TABLE admission_campaign_sends (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    enrolment_id    uuid        NOT NULL REFERENCES admission_campaign_enrolments(id) ON DELETE CASCADE,
    step_id         uuid        NOT NULL REFERENCES admission_campaign_steps(id) ON DELETE CASCADE,
    -- enrolled_at + offset_days, computed once at enrolment so that changing a
    -- step's offset afterwards does not silently re-date a touch already due.
    due_at          timestamptz NOT NULL,
    status          text        NOT NULL DEFAULT 'pending',
    -- The message_log row, once there is one. Null while pending, and null
    -- forever for a skip.
    message_id      uuid        REFERENCES message_log(id) ON DELETE SET NULL,
    queued_at       timestamptz,
    note            text,

    CONSTRAINT admission_campaign_sends_status
        CHECK (status IN ('pending','queued','skipped','failed'))
);

-- One touch per step per enrolment. This is the idempotency that lets the
-- runner be called twice by two schedulers without a parent getting the same
-- message twice.
CREATE UNIQUE INDEX admission_campaign_sends_once
    ON admission_campaign_sends (enrolment_id, step_id);
-- The runner's own query: what is due, oldest first.
CREATE INDEX admission_campaign_sends_due
    ON admission_campaign_sends (institution_id, due_at) WHERE status = 'pending';

-- Opting out is a fact about the family, not about one sequence. A parent who
-- asks to be left alone must be left alone by every campaign the school ever
-- runs, including the ones written next year.
ALTER TABLE enquiries
    ADD COLUMN IF NOT EXISTS marketing_opt_out boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS opted_out_at timestamptz;

-- ===========================================================================
-- 3. Lost lead reason analysis
-- ===========================================================================

-- Why the family did not come.
--
-- No lost-reason field existed: enquiries.status could say 'lost' and nothing
-- could say why, so the one question the admissions head is actually asked at
-- the end of a season -- are we losing them on fees or on distance -- had no
-- answer in the system.
--
-- lost_reason is a code, not a foreign key. The starting vocabulary lives in
-- Go beside the built-in lists it extends, and a school adds its own through
-- custom_options under kind 'lost_reason'. A check constraint here would mean
-- a migration every time a school met a reason nobody had thought of, which is
-- the exact failure custom_options was created to end.
ALTER TABLE enquiries
    ADD COLUMN IF NOT EXISTS lost_reason      text,
    ADD COLUMN IF NOT EXISTS lost_reason_note text,
    ADD COLUMN IF NOT EXISTS lost_at          timestamptz,
    ADD COLUMN IF NOT EXISTS lost_by          uuid REFERENCES users(id) ON DELETE SET NULL;

-- A lost lead with no reason is the row this feature exists to stop, but it
-- cannot be a NOT NULL: every enquiry already marked lost before today has
-- none, and refusing to load them would be worse than reporting them as
-- "Not recorded". The screen chases the gap instead.
CREATE INDEX IF NOT EXISTS enquiries_lost_reason
    ON enquiries (institution_id, lost_reason, class_sought)
 WHERE status = 'lost';

-- Losing leads in a month is a trend, and a trend needs a groupable column.
-- lost_at::date in an index would be rejected as non-IMMUTABLE, so the month
-- is stored.
ALTER TABLE enquiries
    ADD COLUMN IF NOT EXISTS lost_month date
        GENERATED ALWAYS AS (date_trunc('month', lost_at AT TIME ZONE 'Asia/Kolkata')::date) STORED;

CREATE INDEX IF NOT EXISTS enquiries_lost_month
    ON enquiries (institution_id, lost_month) WHERE lost_month IS NOT NULL;

-- ===========================================================================
-- Row level security
-- ===========================================================================

ALTER TABLE admission_forms                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_forms                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE admission_form_versions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_form_versions         FORCE  ROW LEVEL SECURITY;
ALTER TABLE admission_form_sections         ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_form_sections         FORCE  ROW LEVEL SECURITY;
ALTER TABLE admission_form_fields           ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_form_fields           FORCE  ROW LEVEL SECURITY;
ALTER TABLE application_form_answers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_form_answers        FORCE  ROW LEVEL SECURITY;
ALTER TABLE admission_campaigns             ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_campaigns             FORCE  ROW LEVEL SECURITY;
ALTER TABLE admission_campaign_steps        ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_campaign_steps        FORCE  ROW LEVEL SECURITY;
ALTER TABLE admission_campaign_enrolments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_campaign_enrolments   FORCE  ROW LEVEL SECURITY;
ALTER TABLE admission_campaign_sends        ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_campaign_sends        FORCE  ROW LEVEL SECURITY;

CREATE POLICY admission_forms_tenant ON admission_forms
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY admission_form_versions_tenant ON admission_form_versions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY admission_form_sections_tenant ON admission_form_sections
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY admission_form_fields_tenant ON admission_form_fields
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY application_form_answers_tenant ON application_form_answers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY admission_campaigns_tenant ON admission_campaigns
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY admission_campaign_steps_tenant ON admission_campaign_steps
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY admission_campaign_enrolments_tenant ON admission_campaign_enrolments
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY admission_campaign_sends_tenant ON admission_campaign_sends
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON admission_forms                TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON admission_form_versions        TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON admission_form_sections        TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON admission_form_fields          TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_form_answers       TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON admission_campaigns            TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON admission_campaign_steps       TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON admission_campaign_enrolments  TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON admission_campaign_sends       TO app_user;

CREATE TRIGGER admission_forms_touch
    BEFORE UPDATE ON admission_forms
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER admission_form_versions_touch
    BEFORE UPDATE ON admission_form_versions
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER admission_campaigns_touch
    BEFORE UPDATE ON admission_campaigns
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMENT ON TABLE admission_form_versions IS
    'A frozen application-form definition. Published versions are immutable: the API refuses to edit one, and a school edits by taking a fresh draft, which becomes version n+1. Applications keep form_version_id so last season''s submissions render as they were answered.';
COMMENT ON TABLE admission_campaign_sends IS
    'One touch for one lead. UNIQUE (enrolment_id, step_id) is the idempotency that lets the runner be invoked twice without a parent being messaged twice.';
COMMENT ON COLUMN enquiries.lost_reason IS
    'Why this lead did not convert. A custom_options code under kind ''lost_reason'', not a constrained enum — the vocabulary is the school''s.';

-- +goose Down
DROP INDEX IF EXISTS enquiries_lost_month;
DROP INDEX IF EXISTS enquiries_lost_reason;
ALTER TABLE enquiries
    DROP COLUMN IF EXISTS lost_month,
    DROP COLUMN IF EXISTS lost_by,
    DROP COLUMN IF EXISTS lost_at,
    DROP COLUMN IF EXISTS lost_reason_note,
    DROP COLUMN IF EXISTS lost_reason,
    DROP COLUMN IF EXISTS opted_out_at,
    DROP COLUMN IF EXISTS marketing_opt_out;

DROP INDEX IF EXISTS applications_form_version;
ALTER TABLE applications
    DROP COLUMN IF EXISTS submitted_at,
    DROP COLUMN IF EXISTS submitted_from,
    DROP COLUMN IF EXISTS form_version_id;

DROP TABLE IF EXISTS admission_campaign_sends;
DROP TABLE IF EXISTS admission_campaign_enrolments;
DROP TABLE IF EXISTS admission_campaign_steps;
DROP TABLE IF EXISTS admission_campaigns;
DROP TABLE IF EXISTS application_form_answers;
DROP TABLE IF EXISTS admission_form_fields;
DROP TABLE IF EXISTS admission_form_sections;
DROP TABLE IF EXISTS admission_form_versions;
DROP TABLE IF EXISTS admission_forms;
