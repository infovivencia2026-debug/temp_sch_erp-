-- +goose Up
--
-- NOTE TO THE INTEGRATOR: this file claims 00049 as assigned. It may be
-- renumbered on the way in; nothing below depends on its own number.
--
-- The Tally bridge: one body of work, two entry points.
--
-- Indian schools do not keep their statutory books in this product. They keep
-- them in Tally, because that is what the auditor, the trust board and the
-- chartered accountant all read, and no ERP is going to change that. So the
-- question this schema answers is not "how do we do accounting" -- migration
-- 00033 already did that -- but "how does what we recorded get into Tally
-- without being retyped".
--
-- Two failures shape every table here.
--
--   1. Tally rejects the FILE, not the voucher. One fee head nobody mapped and
--      the entire import fails, after the accountant has downloaded it, opened
--      Tally, found the import screen and waited. So the mapping is a first
--      class table with a completeness check that runs before a byte is
--      produced, and the answer to "why can I not export" is a list of the
--      accounts to fix rather than the word "invalid".
--
--   2. A duplicate import into Tally is painful to undo. There is no "undo
--      import" -- the vouchers land, and removing them is a manual delete of
--      each one, in a package where deletion is itself restricted. The real
--      question an accountant has in April is "have I already pushed March",
--      and a product that answers it with "check your downloads folder" has
--      not answered it. So what went out is recorded, voucher by voucher, and
--      the screen tells them before they do it twice.
--
-- Money stays bigint paise everywhere in this file, as everywhere else. The
-- conversion to the rupee figures Tally reads happens once, in Go, in
-- internal/tally, by integer division -- never in SQL, and never through a
-- float.

-- --------------------------------------------------- the connector settings

/* One row per school: which Tally company the vouchers belong to, and how
   they get there.

   The company name is not cosmetic. Tally imports into whichever company the
   file names, and if it names the wrong one the vouchers land in another
   school's books on a machine that hosts several -- which is the normal
   arrangement at a trust running three campuses through one accountant. Wrong
   here is not a failed import, it is a successful import into the wrong place,
   which nobody notices until a trial balance has two schools in it.

   No credentials live in this table. See tally_gateway_credentials. */
CREATE TABLE tally_connector_settings (
    institution_id  uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,

    -- The SVCURRENTCOMPANY the export names. Nullable so the screen opens
    -- before it is configured; the export refuses rather than guessing.
    company_name    text,

    -- The financial year the connector exports by default. April-March, held
    -- as its starting year exactly as accounting_years does: 2026 means April
    -- 2026 to March 2027. Restating that arithmetic anywhere else is how a
    -- February voucher ends up filed under the wrong year.
    default_fy_start_year integer,

    -- How a rendered batch reaches Tally. 'file' is the only one that works.
    -- See internal/tally.Provider, and the comment on
    -- tally_gateway_credentials for why 'gateway' exists and refuses.
    --
    -- A text column rather than a boolean because a third route (a Tally
    -- Connector service, a shared folder a school's own script watches) is a
    -- plausible next step, and a boolean would have to be migrated away.
    delivery        text NOT NULL DEFAULT 'file',

    -- Off until somebody has mapped the chart of accounts. An export screen
    -- that offers a download before the mapping exists is offering a file
    -- Tally will refuse.
    is_enabled      boolean NOT NULL DEFAULT false,

    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tally_connector_settings_delivery
        CHECK (delivery IN ('file','gateway')),
    CONSTRAINT tally_connector_settings_fy_sane
        CHECK (default_fy_start_year IS NULL
               OR default_fy_start_year BETWEEN 1950 AND 2200),
    -- A blank company name is not a company name, and would render an empty
    -- SVCURRENTCOMPANY that Tally reads as "the open company".
    CONSTRAINT tally_connector_settings_company_not_blank
        CHECK (company_name IS NULL OR btrim(company_name) <> '')
);

COMMENT ON TABLE tally_connector_settings IS
    'Per-school Tally connector configuration: the company vouchers import into, the default financial year, and the delivery route. Credentials never live here.';

ALTER TABLE tally_connector_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_connector_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tally_connector_settings_tenant ON tally_connector_settings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON tally_connector_settings TO app_user;

-- ------------------------------------------------------- the ledger mapping

/* This ERP's chart of accounts, mapped to Tally's ledger names.

   The two vocabularies do not agree and there is no reason they should. This
   product calls it "4100 Tuition Fee Income" because that is what the fee
   module posts to, while the school's Tally has had a ledger called "Tuition Fees
   A/c" under "Indirect Incomes" since 2013 and the auditor knows it by that
   name. Mapping is not a translation table somebody forgot to fill in -- it is
   the point of the connector.

   Deliberately not defaulted to the account name. An automatic mapping would
   silently create a hundred new ledgers in Tally on first import, all
   plausible, none matching the ones already there, and the school's opening
   balances would sit in the old ledgers while the year's postings went to the
   new ones. Unmapped must stay visibly unmapped. */
CREATE TABLE tally_ledger_mappings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- Composite FK so a mapping can never point at another tenant's account.
    -- RLS stops a caller reading across tenants. It does not stop them writing
    -- a valid-looking uuid they guessed.
    ledger_account_id uuid NOT NULL,

    -- The name as it exists in Tally. Matched by Tally on import; a typo
    -- creates a new ledger rather than failing, which is the quiet failure
    -- this whole table exists to prevent.
    tally_ledger_name text NOT NULL,

    -- The Tally group to file it under if the ledger does not exist yet.
    -- Optional: a school whose ledgers already exist never needs it, and one
    -- importing into a fresh company needs it for every row.
    tally_parent_group text,

    -- Tally's cost centre, for schools that analyse by campus or by wing.
    -- Nullable and unused by most.
    cost_centre     text,

    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tally_ledger_mappings_name_not_blank
        CHECK (btrim(tally_ledger_name) <> ''),
    CONSTRAINT tally_ledger_mappings_parent_not_blank
        CHECK (tally_parent_group IS NULL OR btrim(tally_parent_group) <> ''),
    CONSTRAINT tally_ledger_mappings_cost_centre_not_blank
        CHECK (cost_centre IS NULL OR btrim(cost_centre) <> ''),

    FOREIGN KEY (ledger_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE CASCADE
);

/* One mapping per account. Both columns are NOT NULL, so this is a plain
   UNIQUE and not a COALESCE one -- see tally_gateway_credentials for the case
   in this file where that distinction bites.

   The reverse is deliberately NOT unique: several ERP accounts mapping to one
   Tally ledger is a school consolidating "Tuition Fee - Class 1..10" into a
   single "Tuition Fees A/c", which is both common and correct. */
CREATE UNIQUE INDEX tally_ledger_mappings_one_per_account
    ON tally_ledger_mappings (institution_id, ledger_account_id);

COMMENT ON TABLE tally_ledger_mappings IS
    'This ERP''s ledger_accounts mapped to the ledger names that already exist in the school''s Tally company. Never defaulted from the account name: an auto-mapping silently creates duplicate ledgers in Tally and splits the year''s postings away from the opening balances.';

ALTER TABLE tally_ledger_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_ledger_mappings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tally_ledger_mappings_tenant ON tally_ledger_mappings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON tally_ledger_mappings TO app_user;

-- ------------------------------------------------- the voucher type mapping

/* journal_entries.voucher_type, mapped to Tally's voucher type names.

   Mostly one-to-one and mostly identical, which is exactly why it is a table
   rather than a constant: the names that differ are the ones that matter. A
   school that renamed "Receipt" to "Fee Receipt" in Tally -- ordinary, so the
   daybook reads sensibly -- gets every receipt rejected by a hardcoded map,
   and the error Tally gives names the voucher type rather than explaining it.

   This ERP's depreciation, opening and closing entries have no Tally
   equivalent at all. They are Journals there, and saying so once here is
   better than a CASE in a query somebody later copies. */
CREATE TABLE tally_voucher_type_mappings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- Matches journal_entries.voucher_type. Constrained to the same list, so a
    -- mapping cannot be written for a type that can never be posted.
    voucher_type    text NOT NULL,
    tally_voucher_type text NOT NULL,

    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tally_voucher_type_mappings_source CHECK (voucher_type IN
        ('journal','receipt','payment','contra','purchase','sales',
         'depreciation','opening','closing')),
    CONSTRAINT tally_voucher_type_mappings_target_not_blank
        CHECK (btrim(tally_voucher_type) <> '')
);

CREATE UNIQUE INDEX tally_voucher_type_mappings_one_per_type
    ON tally_voucher_type_mappings (institution_id, voucher_type);

ALTER TABLE tally_voucher_type_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_voucher_type_mappings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tally_voucher_type_mappings_tenant ON tally_voucher_type_mappings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON tally_voucher_type_mappings TO app_user;

/* The standard map, for the schools that exist today.

   Seeded rather than left empty because every school starts with the same nine
   answers and eight of them are the identity. A school that renamed a voucher
   type edits one row, and a school that did not never opens the screen. Schools
   created after this migration get the same list from the connector's
   "apply the standard voucher types" action, which runs the same map. */
INSERT INTO tally_voucher_type_mappings (institution_id, voucher_type, tally_voucher_type)
SELECT i.id, m.src, m.dst
  FROM institutions i
 CROSS JOIN (VALUES
        ('journal','Journal'),
        ('receipt','Receipt'),
        ('payment','Payment'),
        ('contra','Contra'),
        ('purchase','Purchase'),
        ('sales','Sales'),
        -- No Tally voucher type for these three. They are Journals, and a
        -- school that wants them separate creates its own type and edits here.
        ('depreciation','Journal'),
        ('opening','Journal'),
        ('closing','Journal')
    ) AS m(src, dst)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------ the gateway secrets

/* The gateway address, and anything secret about reaching it.

   Separate from tally_connector_settings for one reason: the policy below is
   different, and putting a platform-only column on a tenant-readable table
   would mean the difference lived in whichever handler remembered it.

   There is no Tally API. Tally's HTTP gateway is a listener that a running
   copy of Tally opens on the school's own LAN, on the accountant's desktop,
   while they are sitting at it. A hosted server cannot reach it. This table
   exists so the address can be recorded for the day somebody deploys an on-site
   relay -- not because the product pushes to it today, and internal/tally's
   GatewayProvider refuses every call rather than pretending otherwise.

   The policy is app_is_platform_admin() alone, with no institution_id escape.
   That is the whole security property: PlatformAdmin is set only for accounts
   belonging to no institution (see internal/auth/session.go), so an
   institution admin -- who holds every other key in this product -- cannot read
   a row here even for their own school. Gating this at the handler instead
   would be one forgotten RequirePermission away from a leak. */
CREATE TABLE tally_gateway_credentials (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which school this address belongs to. NULL means an installation-wide
    -- default: one relay serving every campus of a trust.
    --
    -- And there is the nullable-UNIQUE trap, live. A plain
    -- UNIQUE (institution_id) would let an unlimited number of NULL rows in,
    -- because NULL is distinct from every other NULL, and the "one default"
    -- rule would enforce nothing at all. The index below COALESCEs to the nil
    -- uuid so the defaults have a value to collide on.
    institution_id  uuid REFERENCES institutions(id) ON DELETE CASCADE,

    -- http://192.168.1.7:9000, typically. Not a secret on its own; kept here
    -- because it describes the school's internal network, which is not an
    -- institution admin's business to read from a hosted screen either.
    gateway_url     text,

    -- Sealed with CREDENTIAL_KEY the same way integrations.credentials is,
    -- never as text. bytea rather than jsonb so there is no shape to be
    -- tempted into querying, and no chance of a secret reaching a log through
    -- a jsonb operator.
    credentials     bytea,

    notes           text,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tally_gateway_credentials_url_not_blank
        CHECK (gateway_url IS NULL OR btrim(gateway_url) <> '')
);

CREATE UNIQUE INDEX tally_gateway_credentials_one_per_scope
    ON tally_gateway_credentials
       (COALESCE(institution_id, '00000000-0000-0000-0000-000000000000'::uuid));

COMMENT ON TABLE tally_gateway_credentials IS
    'Platform-only. The LAN address of a school''s Tally gateway and any secret needed to reach it. The RLS policy is app_is_platform_admin() with no tenant escape, so an institution admin cannot read it for their own school. There is no live push today; internal/tally.GatewayProvider refuses.';

ALTER TABLE tally_gateway_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_gateway_credentials FORCE  ROW LEVEL SECURITY;

-- Deliberately NOT the usual institution_id = app_current_institution() shape.
-- Platform staff only, in both directions.
CREATE POLICY tally_gateway_credentials_platform_only ON tally_gateway_credentials
    USING (app_is_platform_admin())
    WITH CHECK (app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON tally_gateway_credentials TO app_user;

-- ---------------------------------------------------------- what went out

/* One export. The answer to "have I already pushed March".

   Recorded even when the accountant never imports the file, because the
   product cannot know whether they did and a run that is silently forgotten is
   the same trap as no record at all. The screen says "exported on 3 April,
   1,284 vouchers" and lets them judge. */
CREATE TABLE tally_export_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- The period asked for, kept as asked rather than derived from the
    -- vouchers found. "I exported all of March and it contained nothing" is a
    -- different fact from "I never exported March", and only the requested
    -- range can tell them apart.
    from_date       date NOT NULL,
    to_date         date NOT NULL,

    -- The voucher types requested, empty meaning all of them. A text[] rather
    -- than a join table: it is a filter that was applied once, not a
    -- relationship, and nothing ever queries across it.
    voucher_types   text[] NOT NULL DEFAULT '{}',

    company_name    text NOT NULL,
    delivery        text NOT NULL DEFAULT 'file',

    voucher_count   integer NOT NULL DEFAULT 0,
    -- The debit total of the batch, which for balanced vouchers is what the
    -- batch is worth. Summing both sides would report it at twice its value.
    total_paise     bigint NOT NULL DEFAULT 0,

    -- Set when the accountant tells us they imported it. Nullable forever for
    -- the ones who never come back and say so.
    confirmed_at    timestamptz,
    confirmed_by    uuid REFERENCES users(id) ON DELETE SET NULL,

    exported_at     timestamptz NOT NULL DEFAULT now(),
    exported_by     uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tally_export_runs_period CHECK (to_date >= from_date),
    CONSTRAINT tally_export_runs_delivery CHECK (delivery IN ('file','gateway')),
    CONSTRAINT tally_export_runs_counts
        CHECK (voucher_count >= 0 AND total_paise >= 0),
    CONSTRAINT tally_export_runs_company_not_blank
        CHECK (btrim(company_name) <> ''),
    -- Half a confirmation looks like a confirmation.
    CONSTRAINT tally_export_runs_confirmation_paired
        CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
    UNIQUE (id, institution_id)
);

CREATE INDEX tally_export_runs_recent
    ON tally_export_runs (institution_id, exported_at DESC);

/* Plain date columns in the index, not an expression.

   The rule in the contract is about non-IMMUTABLE expressions -- in_at::date
   and friends -- and the way to keep clear of it is to index the stored
   columns, which is all the overlap query needs. */
CREATE INDEX tally_export_runs_period
    ON tally_export_runs (institution_id, from_date, to_date);

ALTER TABLE tally_export_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_export_runs FORCE  ROW LEVEL SECURITY;

CREATE POLICY tally_export_runs_tenant ON tally_export_runs
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON tally_export_runs TO app_user;

/* Which vouchers were in which run.

   This is the mark, and it is a row per voucher rather than a flag on
   journal_entries for two reasons. A flag cannot say WHEN, or in which run, so
   "was this in the March batch or the April one" would be unanswerable. And a
   flag would be an UPDATE against journal_entries, which carries the
   closed-year trigger -- so marking a voucher as exported would be refused the
   moment the year it belongs to was closed, which is precisely when an
   accountant is doing this work. */
CREATE TABLE tally_export_run_vouchers (
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    run_id          uuid NOT NULL,
    journal_entry_id uuid NOT NULL,

    PRIMARY KEY (run_id, journal_entry_id),

    -- Composite foreign keys again: a run's contents can never be another
    -- tenant's vouchers, whatever uuid a caller supplies.
    FOREIGN KEY (run_id, institution_id)
        REFERENCES tally_export_runs (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (journal_entry_id, institution_id)
        REFERENCES journal_entries (id, institution_id) ON DELETE CASCADE
);

/* The question the export screen asks before every download: of the vouchers
   in this range, which have gone out before, and when. Leading with the
   voucher rather than the run because that is the direction it is read. */
CREATE INDEX tally_export_run_vouchers_by_voucher
    ON tally_export_run_vouchers (institution_id, journal_entry_id);

COMMENT ON TABLE tally_export_run_vouchers IS
    'Which vouchers went out in which run. A row per voucher rather than a flag on journal_entries: a flag cannot say when, and writing one would be refused by the closed-year trigger exactly when an accountant is doing this work.';

ALTER TABLE tally_export_run_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_export_run_vouchers FORCE  ROW LEVEL SECURITY;

CREATE POLICY tally_export_run_vouchers_tenant ON tally_export_run_vouchers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON tally_export_run_vouchers TO app_user;

-- +goose Down

DROP TABLE IF EXISTS tally_export_run_vouchers;
DROP TABLE IF EXISTS tally_export_runs;
DROP TABLE IF EXISTS tally_gateway_credentials;
DROP TABLE IF EXISTS tally_voucher_type_mappings;
DROP TABLE IF EXISTS tally_ledger_mappings;
DROP TABLE IF EXISTS tally_connector_settings;
