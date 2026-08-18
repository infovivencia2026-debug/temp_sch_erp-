-- Renumbered from 00037: student learning had already taken that slot.
-- Content unchanged.
-- +goose Up
-- The platform tier: what the vendor configures, what the state requires, and
-- what happens when a support engineer needs to stand inside a school.
--
-- Three kinds of table live here and the difference matters:
--
--   * Genuinely platform-wide reference data — the district codes every
--     government return uses, the SQAA framework the state publishes, the
--     franchise brands the vendor sells to. These carry no institution_id and
--     no row-level security, exactly as plans does, because there is one
--     correct answer for the whole installation and copying it per tenant
--     would produce thirty-three slightly different spellings of "Warangal".
--
--   * Per-school configuration — branding, board rules, the calendar model,
--     the authentication policy. institution_id, ENABLE and FORCE row level
--     security, tenant policy. A school reads and writes its own.
--
--   * The impersonation register, which is per-school on purpose. A platform
--     operator standing inside a school is the school's business, so the row
--     lands in the school's tenant and the school's own administrator can read
--     it without asking the vendor for a log.

-- ------------------------------------------------------- district and mandal

/* State, district, mandal, village/ward — the codes every government return
   keys on.

   Platform-wide rather than per-school. Telangana has thirty-three districts
   whoever is reading the return; a per-tenant copy means the UDISE+ export
   from one school says "Jayashankar Bhupalpally" and the next says
   "Bhupalpally", and the reconciliation is somebody's fortnight.

   A tree rather than four columns because the government's own hierarchy is a
   tree, and because a mandal that moves between districts — which happened to
   most of Telangana in 2016 — is then one row changing its parent rather than
   a rewrite of every village beneath it. */
CREATE TABLE location_codes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id   uuid REFERENCES location_codes(id) ON DELETE RESTRICT,
    level       text NOT NULL,
    -- The government's code. Not unique on its own: district 01 exists in
    -- every state, and mandal 01 in every district.
    code        text NOT NULL,
    name        text NOT NULL,
    -- A merged or renamed mandal stops being offered without breaking the
    -- returns already filed against it.
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT location_codes_level
        CHECK (level IN ('state','district','mandal','village')),
    -- A state has no parent; everything else must have one. Without this a
    -- typo produces an orphan district that no district list ever shows.
    CONSTRAINT location_codes_parent_shape
        CHECK ((level = 'state') = (parent_id IS NULL))
);

/* One code per parent per level.

   COALESCE rather than a bare (parent_id, code): parent_id is NULL for every
   state, NULL is never equal to NULL, and a unique index containing a nullable
   column silently admits duplicates. Telangana would go in twice and the index
   would report nothing wrong. */
CREATE UNIQUE INDEX location_codes_unique
    ON location_codes (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
                       level, code);
CREATE INDEX location_codes_parent ON location_codes (parent_id) WHERE active;

-- The state this product was built for, and its districts as they stand after
-- the 2016 reorganisation. Mandals are left to the operator: there are close
-- to six hundred and inventing them would be worse than an empty list.
INSERT INTO location_codes (level, code, name) VALUES ('state', 'TS', 'Telangana');

INSERT INTO location_codes (parent_id, level, code, name)
SELECT s.id, 'district', d.code, d.name
  FROM location_codes s,
       (VALUES
          ('01','Adilabad'), ('02','Bhadradri Kothagudem'), ('03','Hanumakonda'),
          ('04','Hyderabad'), ('05','Jagtial'), ('06','Jangaon'),
          ('07','Jayashankar Bhupalpally'), ('08','Jogulamba Gadwal'),
          ('09','Kamareddy'), ('10','Karimnagar'), ('11','Khammam'),
          ('12','Komaram Bheem Asifabad'), ('13','Mahabubabad'),
          ('14','Mahabubnagar'), ('15','Mancherial'), ('16','Medak'),
          ('17','Medchal-Malkajgiri'), ('18','Mulugu'), ('19','Nagarkurnool'),
          ('20','Nalgonda'), ('21','Narayanpet'), ('22','Nirmal'),
          ('23','Nizamabad'), ('24','Peddapalli'), ('25','Rajanna Sircilla'),
          ('26','Rangareddy'), ('27','Sangareddy'), ('28','Siddipet'),
          ('29','Suryapet'), ('30','Vikarabad'), ('31','Wanaparthy'),
          ('32','Warangal'), ('33','Yadadri Bhuvanagiri')
       ) AS d(code, name)
 WHERE s.level = 'state' AND s.code = 'TS';

-- --------------------------------------------------------- SQAA framework

/* School Quality Assessment and Assurance.

   The framework is published by a board or a state authority, so it is
   platform data the vendor maintains and every school assesses itself
   against. Keeping it per-tenant would mean a school could quietly edit the
   standard it is being measured by, which is the one thing an assurance
   framework must not permit.

   Versioned, because a school assessed under the 2023 framework must still be
   able to read what it was assessed against after the 2026 one lands. */
CREATE TABLE sqaa_frameworks (
    code           text PRIMARY KEY,
    name           text NOT NULL,
    -- CBSE, the state authority, or the trust's own internal standard.
    authority      text NOT NULL,
    version        text NOT NULL,
    effective_from date,
    status         text NOT NULL DEFAULT 'draft',
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sqaa_frameworks_status
        CHECK (status IN ('draft','published','retired'))
);

/* Domains and the standards beneath them, as one self-referencing table.

   Two tables would force a third when the framework adds indicators under a
   standard, which CBSE's does. The depth is the framework's business, not the
   schema's. */
CREATE TABLE sqaa_standards (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    framework_code text NOT NULL REFERENCES sqaa_frameworks(code) ON DELETE CASCADE,
    parent_id      uuid REFERENCES sqaa_standards(id) ON DELETE CASCADE,
    code           text NOT NULL,
    name           text NOT NULL,
    description    text,
    -- Weight in basis points, so a framework whose domains are 12.5% each
    -- adds to exactly 10000 rather than to 99.9.
    weight_bp      integer NOT NULL DEFAULT 0,
    -- Whether a self-assessment against this standard must attach a document.
    evidence_required boolean NOT NULL DEFAULT false,
    sequence       integer NOT NULL DEFAULT 0,

    CONSTRAINT sqaa_standards_weight CHECK (weight_bp BETWEEN 0 AND 10000)
);

-- Same nullable-parent trap as location_codes: a domain has no parent, so a
-- bare unique index would let one domain code be created twice.
CREATE UNIQUE INDEX sqaa_standards_unique
    ON sqaa_standards (framework_code,
                       COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
                       code);
CREATE INDEX sqaa_standards_parent
    ON sqaa_standards (framework_code, parent_id, sequence);

-- ------------------------------------------------------------- franchises

/* A franchise chain: one brand, many separately registered schools.

   Platform-wide because the chain spans tenants — that is what makes it a
   chain. The membership row that ties a school to a chain is tenant-scoped
   below, so a school can see which brand it belongs to without being able to
   read the rest of the chain's roster. */
CREATE TABLE franchises (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code          text NOT NULL UNIQUE,
    name          text NOT NULL,
    brand_owner   text,
    -- Basis points, not a percentage: a 7.25% royalty is 725 and cannot drift
    -- into a rounding argument at renewal.
    royalty_bp    integer NOT NULL DEFAULT 0,
    contact_name  text,
    contact_email text,
    contact_phone text,
    -- What every member school must display or observe. Free text on purpose:
    -- it is contract language, read by a person, not evaluated by code.
    brand_standards text,
    status        text NOT NULL DEFAULT 'active',
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT franchises_status CHECK (status IN ('active','suspended','ended')),
    CONSTRAINT franchises_royalty CHECK (royalty_bp BETWEEN 0 AND 10000)
);

CREATE TABLE franchise_members (
    institution_id uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
    franchise_id   uuid NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
    agreement_no   text,
    joined_on      date NOT NULL DEFAULT CURRENT_DATE,
    renews_on      date,
    -- Paise, like every other amount in this product.
    annual_fee_paise bigint NOT NULL DEFAULT 0,
    -- The last brand audit's score, as a percentage. Null until one is done;
    -- zero would read as "failed" for a school nobody has visited yet.
    compliance_percent integer,
    last_audited_on date,
    notes          text,
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT franchise_members_fee CHECK (annual_fee_paise >= 0),
    CONSTRAINT franchise_members_compliance
        CHECK (compliance_percent IS NULL OR compliance_percent BETWEEN 0 AND 100)
);
CREATE INDEX franchise_members_franchise ON franchise_members (franchise_id);

-- --------------------------------------------------- board and disclosure

/* The documents a school must publish, and when each expires.

   institutions already carries the affiliation board, number and validity
   date. What it could not carry is the eight-odd certificates the mandatory
   public disclosure rule requires a school to put on its website — the trust
   deed, the NOC, the recognition certificate, building and fire safety, water
   and sanitation — each with its own issuing authority and its own expiry.

   Per campus as well as per school: fire safety is issued against a building,
   and a trust running three campuses holds three certificates. */
CREATE TABLE board_disclosures (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id      uuid REFERENCES campuses(id) ON DELETE CASCADE,
    document       text NOT NULL,
    title          text NOT NULL,
    reference_no   text,
    issuing_authority text,
    issued_on      date,
    -- NULL means the document does not expire (a trust deed). The renewal
    -- report treats null and "expired" as different states rather than
    -- flagging every permanent document as overdue.
    valid_to       date,
    -- Storage key, matching institutions.logo_key and student_documents.
    file_key       text,
    -- Where the school publishes it, which is what the rule actually requires.
    public_url     text,
    notes          text,
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT board_disclosures_dates
        CHECK (valid_to IS NULL OR issued_on IS NULL OR valid_to >= issued_on)
);

-- One of each document per campus, and one school-wide row where campus_id is
-- null. COALESCE because a nullable campus_id would otherwise defeat the index
-- and let a school hold four different trust deeds without complaint.
CREATE UNIQUE INDEX board_disclosures_unique
    ON board_disclosures (institution_id,
                          COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          document);
CREATE INDEX board_disclosures_expiry
    ON board_disclosures (valid_to) WHERE valid_to IS NOT NULL;

/* Which board's rules apply, and to which stage of the school.

   One row per school per stage, not per school: a Telangana school commonly
   runs SSC to class X and TSBIE for Intermediate, and the two have different
   pass marks, different internal weightings and different attendance rules. A
   single board column on institutions cannot say that, which is why a report
   card generator that reads one is wrong for half the school. */
CREATE TABLE board_configurations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    board          text NOT NULL,
    stage          text NOT NULL,
    pass_percent   integer NOT NULL DEFAULT 35,
    max_marks      integer NOT NULL DEFAULT 100,
    -- How much of the final mark comes from internal assessment. Telangana SSC
    -- puts 20 of 100 on formative work; CBSE's split differs by subject group.
    internal_weight_percent integer NOT NULL DEFAULT 20,
    -- The register threshold below which a candidate is not sent up for the
    -- board examination at all.
    attendance_min_percent  integer NOT NULL DEFAULT 75,
    exam_pattern   text NOT NULL DEFAULT 'formative_summative',
    -- Which of the school's own grading scales this board's marks convert
    -- through. Nullable: a school that has not built its scales yet must still
    -- be able to record which board it follows.
    grading_scale_id uuid REFERENCES grading_scales(id) ON DELETE SET NULL,
    -- The medium of instruction the board registration is made in.
    medium         text,
    is_default     boolean NOT NULL DEFAULT false,
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT board_configurations_stage
        CHECK (stage IN ('primary','upper_primary','secondary','higher_secondary')),
    CONSTRAINT board_configurations_pattern
        CHECK (exam_pattern IN ('formative_summative','term_annual','continuous','semester')),
    CONSTRAINT board_configurations_percentages
        CHECK (pass_percent BETWEEN 0 AND 100
           AND internal_weight_percent BETWEEN 0 AND 100
           AND attendance_min_percent BETWEEN 0 AND 100),
    CONSTRAINT board_configurations_max_marks CHECK (max_marks > 0),
    UNIQUE (institution_id, board, stage)
);

-- Exactly one default per school, enforced rather than left to the handler:
-- two defaults means whichever the report card generator reads first wins.
CREATE UNIQUE INDEX board_configurations_one_default
    ON board_configurations (institution_id) WHERE is_default;

-- ------------------------------------------------------ the calendar model

/* The school year and the financial year are different years.

   The school runs June to April. The books run April to March. Receipts,
   payroll and every statutory return follow the second; admissions,
   promotions and report cards follow the first. Software that assumes one
   calendar prints a receipt dated in the wrong financial year every June, and
   the school finds out at audit.

   One row per school. The months are stored rather than derived because a
   CBSE school in the north opens in April and a Telangana school in June, and
   both are correct. */
CREATE TABLE academic_calendar_models (
    institution_id  uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
    -- 1-12. The school year the admissions and promotion cycle follows.
    school_year_start_month integer NOT NULL DEFAULT 6,
    school_year_end_month   integer NOT NULL DEFAULT 4,
    -- April in India, and not a matter of school policy. Stored anyway so the
    -- screen can show it beside the school year rather than leaving the reader
    -- to remember why the two differ.
    financial_year_start_month integer NOT NULL DEFAULT 4,
    term_count      integer NOT NULL DEFAULT 3,
    -- 0 = Sunday, matching extract(dow).
    week_start_day  integer NOT NULL DEFAULT 1,
    working_days_per_week integer NOT NULL DEFAULT 6,
    -- Which Saturdays the school works: 'all', 'none', or 'alternate'.
    saturday_pattern text NOT NULL DEFAULT 'all',
    -- Minimum instructional days the board requires; the calendar screen
    -- measures the planned year against it.
    required_working_days integer NOT NULL DEFAULT 220,
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT academic_calendar_models_months
        CHECK (school_year_start_month BETWEEN 1 AND 12
           AND school_year_end_month BETWEEN 1 AND 12
           AND financial_year_start_month BETWEEN 1 AND 12),
    CONSTRAINT academic_calendar_models_terms CHECK (term_count BETWEEN 1 AND 6),
    CONSTRAINT academic_calendar_models_week
        CHECK (week_start_day BETWEEN 0 AND 6 AND working_days_per_week BETWEEN 1 AND 7),
    CONSTRAINT academic_calendar_models_saturday
        CHECK (saturday_pattern IN ('all','none','alternate')),
    CONSTRAINT academic_calendar_models_required
        CHECK (required_working_days BETWEEN 0 AND 366)
);

-- ---------------------------------------------------------------- branding

/* Identity, per school and per campus.

   institutions.logo_key and primary_color already exist and stay authoritative
   for the school's own header. Everything a white-label deployment
   additionally needs — a custom domain, the login banner, the email header, a
   second colour, a favicon — has nowhere to live, and a trust running two
   brands under one registration needs it per campus rather than per school. */
CREATE TABLE branding_profiles (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    -- NULL is the school-wide profile, which a campus row overrides.
    campus_id      uuid REFERENCES campuses(id) ON DELETE CASCADE,

    display_name   text,
    tagline        text,
    logo_key       text,
    wordmark_key   text,
    favicon_key    text,
    primary_color  text,
    accent_color   text,

    -- White-label: the host the school's families actually visit.
    custom_domain  text,
    -- Verified separately from being set. An unverified domain must not be
    -- served, and a boolean nobody sets is how it gets served anyway.
    domain_verified_at timestamptz,
    login_headline text,
    login_message  text,
    login_banner_key text,
    email_header_key text,
    email_footer_html text,
    -- What a parent sees as the sender. Not the envelope sender, which is the
    -- vendor's and must stay the vendor's for deliverability.
    email_from_name text,
    support_email  text,
    support_phone  text,
    updated_at     timestamptz NOT NULL DEFAULT now(),

    -- Hex, six digits, with the hash. Anything else renders as black and the
    -- school's brand quietly disappears.
    CONSTRAINT branding_profiles_primary_hex
        CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9a-fA-F]{6}$'),
    CONSTRAINT branding_profiles_accent_hex
        CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-fA-F]{6}$')
);

CREATE UNIQUE INDEX branding_profiles_unique
    ON branding_profiles (institution_id,
                          COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid));
-- A host resolves to exactly one profile. Without this two schools claim the
-- same domain and whichever row sorts first wins, silently.
CREATE UNIQUE INDEX branding_profiles_domain
    ON branding_profiles (lower(custom_domain)) WHERE custom_domain IS NOT NULL;

-- ------------------------------------------------------ SSO and MFA policy

/* How this school's people prove who they are.

   Configuration only. Nothing in this table weakens the password path in
   internal/auth: it records what the school requires and what it has
   connected, and the enforcement points read it. sso_enabled does not make
   single sign-on work — there is no adapter and no identity provider to talk
   to. Recording the intent without pretending to the connection is the honest
   state, and sso_verified_at is what a sign-in page would have to consult
   before offering the button.

   Per school rather than platform-wide: a government school federating with
   the state directory and a private trust using passwords are both correct, on
   the same installation. */
CREATE TABLE auth_policies (
    institution_id uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,

    -- Which roles must carry a second factor. An array rather than a boolean
    -- because "everyone" is not a policy any school actually adopts: the
    -- principal and the accountant, yes; eight hundred parents, no.
    mfa_required_roles text[] NOT NULL DEFAULT '{}',
    -- Days a newly created account may sign in before enrolling. Zero means
    -- enrol before the first sign-in, which locks out anyone the school
    -- creates in bulk, so the default gives a week.
    mfa_grace_days integer NOT NULL DEFAULT 7,

    password_min_length integer NOT NULL DEFAULT 10,
    -- Zero means passwords do not expire. Forced 30-day rotation is how a
    -- school ends up with Summer2026! on a sticky note.
    password_expiry_days integer NOT NULL DEFAULT 0,
    session_idle_minutes integer NOT NULL DEFAULT 120,

    -- Restricts sign-in to addresses the school controls. Empty means no
    -- restriction; a school with parent accounts on every free mail provider
    -- cannot use this and must not be forced to.
    allowed_email_domains text[] NOT NULL DEFAULT '{}',

    sso_enabled    boolean NOT NULL DEFAULT false,
    sso_protocol   text,
    sso_provider   text,
    sso_entity_id  text,
    sso_metadata_url text,
    -- Set when a real connection has been proven end to end. Until then the
    -- configuration is a draft and the sign-in page must not offer it.
    sso_verified_at timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT auth_policies_grace CHECK (mfa_grace_days BETWEEN 0 AND 90),
    CONSTRAINT auth_policies_min_length CHECK (password_min_length BETWEEN 8 AND 64),
    CONSTRAINT auth_policies_expiry CHECK (password_expiry_days BETWEEN 0 AND 730),
    CONSTRAINT auth_policies_idle CHECK (session_idle_minutes BETWEEN 5 AND 1440),
    CONSTRAINT auth_policies_protocol
        CHECK (sso_protocol IS NULL OR sso_protocol IN ('saml2','oidc')),
    -- Enabling single sign-on without naming a provider produces a login page
    -- with a button that goes nowhere.
    CONSTRAINT auth_policies_sso_shape
        CHECK (NOT sso_enabled OR (sso_protocol IS NOT NULL AND sso_provider IS NOT NULL))
);

-- ---------------------------------------------------------- impersonation

/* A platform operator standing inside a school, on the record.

   X-Acting-Institution already lets platform staff scope a request to one
   school (internal/api/acting.go). What it has never had is a reason, an end
   time, or a row the school itself can read. A vendor engineer could enter any
   school on the installation, at any hour, for as long as they liked, and the
   only trace was whatever mutations the audit middleware happened to catch.

   This is that missing half. The grant is tenant-scoped deliberately: it lands
   in the school's own tenant, so the school's administrator reads it through
   the same row-level security as everything else they own, without asking the
   vendor for a log they have no way to verify.

   Time-bounded in the schema rather than in a handler. Four hours is the cap
   because a support session that outlives an afternoon is not a support
   session, and a handler-side limit is one refactor away from being dropped. */
CREATE TABLE impersonation_grants (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    operator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    /* The operator's name, copied in rather than joined to.

       Two reasons, and the first is the whole point of this table. Platform
       staff belong to no institution, so the users row is invisible inside the
       school's tenant — a school reading its own register through row-level
       security would join to nothing and be told that somebody, unnamed,
       entered their school. That is not an audit trail.

       The second is ordinary audit practice: the record should say who it was
       at the time, and survive the account being renamed or removed. */
    operator_name  text NOT NULL,

    -- Why. Free text and mandatory: "reproducing the fee receipt fault in
    -- ticket 412" is auditable, an empty string is not.
    reason         text NOT NULL,
    ticket_id      uuid REFERENCES support_tickets(id) ON DELETE SET NULL,

    started_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    -- Set when the operator closes the session or when it is revoked. A grant
    -- past expires_at is dead whether or not this is set; this records that
    -- somebody ended it deliberately, and who.
    ended_at       timestamptz,
    ended_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    -- Copied for the same reason as operator_name: when the vendor closes
    -- their own session, the school must still be able to read who did.
    ended_by_name  text,
    ended_reason   text,

    CONSTRAINT impersonation_grants_reason CHECK (length(btrim(reason)) >= 8),
    CONSTRAINT impersonation_grants_window
        CHECK (expires_at > started_at AND expires_at <= started_at + interval '4 hours'),
    CONSTRAINT impersonation_grants_ended
        CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX impersonation_grants_live
    ON impersonation_grants (operator_user_id, expires_at DESC) WHERE ended_at IS NULL;
CREATE INDEX impersonation_grants_school
    ON impersonation_grants (institution_id, started_at DESC);

-- -------------------------------------------------------- backup register

/* What the school's backup policy is, and whether it is actually happening.

   The policy is configuration this product owns. The backup itself is not:
   taking a physical copy of a Postgres cluster is the operator's pipeline, not
   an HTTP handler, and a "Back up now" button that shells out from a web
   process is how a school's database gets dumped into a full disk at four in
   the afternoon.

   So this holds the intent and the register. The pipeline reports each
   completed run through POST /admin/platform/backups/runs, and the screen
   compares the newest successful run against the policy — which is the
   question that actually matters, because a backup nobody checked is the same
   as no backup. */
CREATE TABLE backup_policies (
    institution_id uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
    enabled        boolean NOT NULL DEFAULT true,
    frequency      text NOT NULL DEFAULT 'daily',
    -- Hour of day in Asia/Kolkata, which is the only timezone this product
    -- has. A UTC hour here means the backup runs during the school's morning.
    run_at_hour    integer NOT NULL DEFAULT 1,
    retention_days integer NOT NULL DEFAULT 30,
    -- How far back a point-in-time restore can reach. Distinct from retention:
    -- weekly fulls kept for a year still only give PITR to the last archived
    -- write-ahead log.
    pitr_window_days integer NOT NULL DEFAULT 7,
    destination    text NOT NULL DEFAULT 'object_store',
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT backup_policies_frequency
        CHECK (frequency IN ('hourly','daily','weekly')),
    CONSTRAINT backup_policies_hour CHECK (run_at_hour BETWEEN 0 AND 23),
    CONSTRAINT backup_policies_retention CHECK (retention_days BETWEEN 1 AND 3650),
    CONSTRAINT backup_policies_pitr CHECK (pitr_window_days BETWEEN 0 AND 35),
    CONSTRAINT backup_policies_destination
        CHECK (destination IN ('object_store','local','offsite'))
);

CREATE TABLE backup_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    kind           text NOT NULL DEFAULT 'scheduled',
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    status         text NOT NULL DEFAULT 'running',
    size_bytes     bigint,
    object_key     text,
    -- The moment the copy is consistent as of, which is what a restore is
    -- actually chosen by. Not the same as finished_at for a long dump.
    restore_point  timestamptz,
    checksum       text,
    error          text,

    CONSTRAINT backup_runs_kind CHECK (kind IN ('scheduled','manual','pitr','restore')),
    CONSTRAINT backup_runs_status
        CHECK (status IN ('running','succeeded','failed')),
    -- A run that succeeded and recorded no restore point is a run nobody can
    -- restore from, which is a failure wearing the wrong label.
    CONSTRAINT backup_runs_succeeded_shape
        CHECK (status <> 'succeeded' OR (finished_at IS NOT NULL AND restore_point IS NOT NULL))
);

CREATE INDEX backup_runs_recent ON backup_runs (institution_id, started_at DESC);
CREATE INDEX backup_runs_last_good
    ON backup_runs (institution_id, restore_point DESC) WHERE status = 'succeeded';

-- ------------------------------------- campus classification for the state

/* The state reports per campus, not per registration.

   institutions.management_type and school_category already exist and describe
   the legal entity. A trust running a KGBV hostel campus and a private unaided
   day campus under one registration files two different returns, and until now
   had one column to say so with. */
ALTER TABLE campuses
    ADD COLUMN management_type text,
    ADD COLUMN school_category text,
    ADD COLUMN udise_code      text,
    ADD CONSTRAINT campuses_management_type
        CHECK (management_type IS NULL OR management_type IN
               ('government','aided','private_unaided','model_school','gurukul','kgbv','central')),
    ADD CONSTRAINT campuses_school_category
        CHECK (school_category IS NULL OR school_category IN
               ('primary','upper_primary','high_school','higher_secondary','composite')),
    -- Eleven digits, the same rule institutions.udise_code is held to.
    ADD CONSTRAINT campuses_udise_code
        CHECK (udise_code IS NULL OR udise_code ~ '^[0-9]{11}$');

-- A UDISE code identifies one school building nationally. Two campuses sharing
-- one is a data-entry error that produces two returns for the same school.
CREATE UNIQUE INDEX campuses_udise_unique
    ON campuses (udise_code) WHERE udise_code IS NOT NULL;

-- ------------------------------------------- who a support ticket is for

/* A parent's grievance is not the software vendor's business.

   support_tickets carries both: a school raising a fault with the vendor, and
   a mother raising a concern about a named teacher with the school. They are
   the same shape and utterly different in who may read them — and the seller's
   ticket queue read every row on the installation with no filter at all, so
   the second kind was on the vendor's screen, with the child's school, the
   parent's name and the subject line they wrote.

   audience makes the distinction explicit and defaults to 'school', so every
   row that already exists — all of them raised through the parent portal —
   becomes invisible to the vendor rather than needing a backfill somebody
   might get wrong.

   The second constraint is the one that matters: a ticket naming a child can
   never be marked vendor-visible, whatever a handler decides. A support desk
   does not need a student_id to fix a fee calculation. */
ALTER TABLE support_tickets
    ADD COLUMN audience text NOT NULL DEFAULT 'school',
    ADD CONSTRAINT support_tickets_audience CHECK (audience IN ('school','vendor')),
    ADD CONSTRAINT support_tickets_vendor_never_names_a_child
        CHECK (audience = 'school' OR student_id IS NULL);

CREATE INDEX support_tickets_vendor_queue
    ON support_tickets (status, priority, created_at) WHERE audience = 'vendor';

COMMENT ON COLUMN support_tickets.audience IS
    'Who may read this ticket: ''school'' (the default, and every grievance raised through the parent portal) or ''vendor'' (a fault the school reported to the software vendor). A vendor ticket may never carry a student_id.';

-- --------------------------------------------------- row level security

/* Platform-wide tables are deliberately absent from the list below.
   location_codes, sqaa_frameworks, sqaa_standards and franchises hold one
   answer for the whole installation, exactly as plans does, and giving them a
   tenant policy would mean no tenant could read them. Writes are gated at the
   handler on platform.tenants.write, which no school role holds. */
ALTER TABLE franchise_members         ENABLE ROW LEVEL SECURITY;
ALTER TABLE franchise_members         FORCE  ROW LEVEL SECURITY;
ALTER TABLE board_disclosures         ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_disclosures         FORCE  ROW LEVEL SECURITY;
ALTER TABLE board_configurations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_configurations      FORCE  ROW LEVEL SECURITY;
ALTER TABLE academic_calendar_models  ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_calendar_models  FORCE  ROW LEVEL SECURITY;
ALTER TABLE branding_profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE branding_profiles         FORCE  ROW LEVEL SECURITY;
ALTER TABLE auth_policies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_policies             FORCE  ROW LEVEL SECURITY;
ALTER TABLE impersonation_grants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_grants      FORCE  ROW LEVEL SECURITY;
ALTER TABLE backup_policies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_policies           FORCE  ROW LEVEL SECURITY;
ALTER TABLE backup_runs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_runs               FORCE  ROW LEVEL SECURITY;

CREATE POLICY franchise_members_tenant ON franchise_members
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY board_disclosures_tenant ON board_disclosures
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY board_configurations_tenant ON board_configurations
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY academic_calendar_models_tenant ON academic_calendar_models
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY branding_profiles_tenant ON branding_profiles
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY auth_policies_tenant ON auth_policies
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY impersonation_grants_tenant ON impersonation_grants
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY backup_policies_tenant ON backup_policies
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY backup_runs_tenant ON backup_runs
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- +goose Down
DROP INDEX IF EXISTS support_tickets_vendor_queue;
ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS support_tickets_vendor_never_names_a_child,
    DROP CONSTRAINT IF EXISTS support_tickets_audience,
    DROP COLUMN IF EXISTS audience;
DROP INDEX IF EXISTS campuses_udise_unique;
ALTER TABLE campuses
    DROP CONSTRAINT IF EXISTS campuses_udise_code,
    DROP CONSTRAINT IF EXISTS campuses_school_category,
    DROP CONSTRAINT IF EXISTS campuses_management_type,
    DROP COLUMN IF EXISTS udise_code,
    DROP COLUMN IF EXISTS school_category,
    DROP COLUMN IF EXISTS management_type;
DROP TABLE IF EXISTS backup_runs;
DROP TABLE IF EXISTS backup_policies;
DROP TABLE IF EXISTS impersonation_grants;
DROP TABLE IF EXISTS auth_policies;
DROP TABLE IF EXISTS branding_profiles;
DROP TABLE IF EXISTS academic_calendar_models;
DROP TABLE IF EXISTS board_configurations;
DROP TABLE IF EXISTS board_disclosures;
DROP TABLE IF EXISTS franchise_members;
DROP TABLE IF EXISTS franchises;
DROP TABLE IF EXISTS sqaa_standards;
DROP TABLE IF EXISTS sqaa_frameworks;
DROP TABLE IF EXISTS location_codes;
