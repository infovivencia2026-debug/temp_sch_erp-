-- +goose Up
-- Renumbered from 00091 at integration: seven migrations landed above it while
-- this was in flight.
-- Two things a school asks for once it has lived with the product for a term:
-- a report nobody had to write for it, and the digital half of the library.
--
-- Numbered 00091 by assignment; the integrator may renumber it. Nothing here
-- depends on its own number.
--
-- Note on comment style: goose splits statements on ';' without understanding
-- block comments, so a ';' inside a slash-star comment truncates the statement
-- that follows it. Every comment in this file is a line comment for that
-- reason.

-- =========================================================================
-- 1. The custom report builder
-- =========================================================================
--
-- The whole risk in "let a principal build their own report" is that it turns
-- into an SQL console wearing a form. Nothing in these tables is a table name,
-- a column name or a fragment of SQL as far as Postgres is concerned: every
-- value stored here is a KEY into a whitelist that lives in Go
-- (internal/api/report_builder.go, reportSubjects). The server translates a
-- saved definition into a parameterised query; an unknown key is refused at
-- save time and refused again at run time, because a whitelist that shrinks
-- must invalidate the definitions that were legal under the old one.
--
-- The subject/column/filter keys are therefore deliberately plain text with no
-- foreign key: their referent is code, not data.

CREATE TABLE report_definitions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    name            text        NOT NULL,
    description     text,
    -- One of the whitelisted subjects: students, attendance, fees, staff.
    subject         text        NOT NULL,
    -- Selected column keys, in the order the report shows them. A report with
    -- no columns is not a report, so the array must be non-empty.
    columns         text[]      NOT NULL,
    -- [{"field":"status","op":"eq","value":"active"}, ...]. Validated against
    -- the subject's filterable fields and their permitted operators.
    filters         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- Grouping turns the report into an aggregate: the grouped columns become
    -- the key and every other selected column must carry an aggregate, which
    -- the subject's schema declares per column.
    group_by        text[]      NOT NULL DEFAULT '{}',
    sort_column     text,
    sort_dir        text        NOT NULL DEFAULT 'asc',
    -- A report that can run over the whole institution can be slow. The
    -- builder caps it; the cap is stored so a saved report cannot be widened
    -- by editing a query string.
    row_limit       integer     NOT NULL DEFAULT 500,
    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT report_definitions_name CHECK (nullif(btrim(name), '') IS NOT NULL),
    CONSTRAINT report_definitions_columns CHECK (cardinality(columns) BETWEEN 1 AND 20),
    CONSTRAINT report_definitions_filters_shape CHECK (jsonb_typeof(filters) = 'array'),
    CONSTRAINT report_definitions_sort_dir CHECK (sort_dir IN ('asc','desc')),
    CONSTRAINT report_definitions_row_limit CHECK (row_limit BETWEEN 1 AND 5000)
);

-- One report of a given name per school. Two "Fee defaulters" in the picker,
-- differing only in which columns somebody happened to tick, is how a school
-- ends up not trusting either.
CREATE UNIQUE INDEX report_definitions_name_unique
    ON report_definitions (institution_id, lower(btrim(name)));

CREATE INDEX report_definitions_subject
    ON report_definitions (institution_id, subject);

-- Sharing a saved report with a role.
--
-- This shares the DEFINITION, never the rows. Rendering re-resolves the
-- reader's own scope, so a head of department opening a report the principal
-- shared gets their department. Sharing rows instead of a definition is how a
-- report builder becomes a privilege escalation, and the API depends on that
-- distinction rather than on anything stored here.
CREATE TABLE report_shares (
    report_id       uuid        NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
    -- A role key from internal/rbac, e.g. 'hod'. Roles are seeded per
    -- institution and renameable, so this is the stable key, not a row id.
    role_key        text        NOT NULL,
    shared_at       timestamptz NOT NULL DEFAULT now(),
    shared_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (report_id, role_key)
);

-- What was run, by whom, and whether it left the building.
--
-- Export is the act worth recording: a list of every child's address is a
-- different thing on screen from the same list in somebody's downloads
-- folder. Kept as its own row rather than a flag on the definition because a
-- report is run many times and exported occasionally.
CREATE TABLE report_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    report_id       uuid        NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
    ran_by          uuid        REFERENCES users(id) ON DELETE SET NULL,
    ran_at          timestamptz NOT NULL DEFAULT now(),
    row_count       integer     NOT NULL DEFAULT 0,
    exported        boolean     NOT NULL DEFAULT false,
    -- 'institution' or 'department': the boundary the rows were drawn inside,
    -- so an audit can tell the principal's copy from the HOD's.
    scope_label     text        NOT NULL DEFAULT 'institution',
    duration_ms     integer,
    CONSTRAINT report_runs_row_count CHECK (row_count >= 0)
);

CREATE INDEX report_runs_recent ON report_runs (report_id, ran_at DESC);

-- =========================================================================
-- 2. Digital holdings: e-books, journals and databases
-- =========================================================================
--
-- The catalogue entry for this feature names EBSCO and JSTOR and promises
-- single sign-on. Neither subscription exists on this deployment, and an
-- integration that cannot be exercised is a claim, not a feature. What is
-- built here is the part a school without a subscription still needs: a
-- catalogue of what it does hold digitally, who may see each item, and
-- lending for the ones licensed a single concurrent reader.
--
-- The provider table below is the seam for a real subscription, deliberately
-- built and deliberately marked unavailable, so adding one later is wiring
-- rather than a migration.

CREATE TABLE digital_library_providers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    -- ebsco | jstor | proquest | other. The vocabulary is closed so a screen
    -- can say what it can and cannot do per provider.
    kind            text        NOT NULL,
    name            text        NOT NULL,
    -- Where a link resolver would send a reader. Nullable while unconfigured.
    base_url        text,
    -- Deliberately NOT a credential store. The sealed-credential column type
    -- this codebase uses for Tally belongs with a working integration; until
    -- one exists, holding a school's subscription password would be storing a
    -- secret to do nothing with. This records only whether one has been
    -- supplied out of band.
    has_credentials boolean     NOT NULL DEFAULT false,
    -- Always 'unavailable' today. The CHECK admits the other values so the
    -- day a subscription arrives is a code change, not a migration.
    status          text        NOT NULL DEFAULT 'unavailable',
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT digital_library_providers_kind
        CHECK (kind IN ('ebsco','jstor','proquest','other')),
    CONSTRAINT digital_library_providers_status
        CHECK (status IN ('unavailable','configured','live'))
);

CREATE UNIQUE INDEX digital_library_providers_one_per_kind
    ON digital_library_providers (institution_id, kind, lower(btrim(name)));

CREATE TABLE digital_holdings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid        REFERENCES campuses(id) ON DELETE CASCADE,
    kind            text        NOT NULL,
    title           text        NOT NULL,
    author          text,
    publisher       text,
    -- ISBN for an e-book, ISSN for a journal. One column, because a holding is
    -- one or the other and never both.
    identifier      text,
    language        text,
    description     text,
    -- open          : anyone who can see it may open it, no lending
    -- subscription  : the school pays; access is via a provider or a link
    -- single_copy_loan : one concurrent reader, borrowed like a physical book
    access_model    text        NOT NULL,
    provider_id     uuid        REFERENCES digital_library_providers(id) ON DELETE SET NULL,
    -- Exactly one of these two, enforced below: a link out, or a file we hold.
    -- external_url exists because POST /files/presign answers 503 on this
    -- deployment, so a file-only design would be unusable in production while
    -- looking finished.
    external_url    text,
    file_id         uuid        REFERENCES files(id) ON DELETE SET NULL,
    -- Free-tagged subjects rather than a join to `subjects`: a research
    -- database covers "history" whether or not the school teaches it as a
    -- timetabled subject, and forcing the join would make half the catalogue
    -- untaggable.
    subject_tags    text[]      NOT NULL DEFAULT '{}',
    -- Set for access_model='single_copy_loan'. Points at a shadow row in the
    -- physical catalogue so the existing hold queue, due dates and returns
    -- apply unchanged. Restating that logic for e-books would give a school
    -- two lending desks that disagree about who has what.
    library_title_id uuid       REFERENCES library_titles(id) ON DELETE SET NULL,
    loan_days       integer     NOT NULL DEFAULT 14,
    is_active       boolean     NOT NULL DEFAULT true,
    created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT digital_holdings_kind CHECK (kind IN ('ebook','journal','database')),
    CONSTRAINT digital_holdings_access_model
        CHECK (access_model IN ('open','subscription','single_copy_loan')),
    CONSTRAINT digital_holdings_title CHECK (nullif(btrim(title), '') IS NOT NULL),
    CONSTRAINT digital_holdings_one_location
        CHECK ((nullif(btrim(external_url), '') IS NULL) <> (file_id IS NULL)),
    CONSTRAINT digital_holdings_loan_days CHECK (loan_days BETWEEN 1 AND 90),
    -- A database is a place you search, not a thing one reader can borrow.
    CONSTRAINT digital_holdings_database_not_lent
        CHECK (kind <> 'database' OR access_model <> 'single_copy_loan')
);

-- One catalogue entry per title per campus. campus_id is nullable and means
-- "every campus", so it goes through COALESCE: a UNIQUE index containing a
-- nullable column enforces nothing at all, because no NULL equals any other.
CREATE UNIQUE INDEX digital_holdings_one_per_title
    ON digital_holdings (
        institution_id,
        COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(btrim(title)),
        kind);

CREATE INDEX digital_holdings_browse
    ON digital_holdings (institution_id, kind, access_model) WHERE is_active;

CREATE INDEX digital_holdings_tags ON digital_holdings USING gin (subject_tags);

-- Who may see a holding.
--
-- Absence of any row means everyone: a school that has not thought about
-- visibility gets a working catalogue rather than an empty one. A single row
-- narrows it, which is why this is a table and not two nullable columns on the
-- holding — visibility is a set, and "Class 9, Class 10 and every teacher" is
-- three rows, not one.
CREATE TABLE digital_holding_visibility (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    holding_id      uuid        NOT NULL REFERENCES digital_holdings(id) ON DELETE CASCADE,
    -- Exactly one of these. A class rule shows it to that class's pupils; a
    -- role rule shows it to holders of that role, which is how a research
    -- database reaches the staff room and not Class 2.
    class_id        uuid        REFERENCES classes(id) ON DELETE CASCADE,
    role_key        text,
    CONSTRAINT digital_holding_visibility_one_rule
        CHECK ((class_id IS NULL) <> (role_key IS NULL))
);

-- The same COALESCE trap again, and the reason it is worth the noise: without
-- it a librarian clicking "Class 6" twice would store two identical rules and
-- the screen would show a duplicate it could not explain.
CREATE UNIQUE INDEX digital_holding_visibility_unique
    ON digital_holding_visibility (
        holding_id,
        COALESCE(class_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(role_key, ''));

-- --- RLS -----------------------------------------------------------------

ALTER TABLE report_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE report_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_shares FORCE ROW LEVEL SECURITY;
ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE digital_library_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE digital_library_providers FORCE ROW LEVEL SECURITY;
ALTER TABLE digital_holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE digital_holdings FORCE ROW LEVEL SECURITY;
ALTER TABLE digital_holding_visibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE digital_holding_visibility FORCE ROW LEVEL SECURITY;

CREATE POLICY report_definitions_tenant ON report_definitions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY report_runs_tenant ON report_runs
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY digital_library_providers_tenant ON digital_library_providers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY digital_holdings_tenant ON digital_holdings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- Shares and visibility rules carry no institution of their own; the row they
-- qualify does, and they cascade from it.
CREATE POLICY report_shares_tenant ON report_shares
    USING (EXISTS (SELECT 1 FROM report_definitions d
                    WHERE d.id = report_id
                      AND (d.institution_id = app_current_institution()
                           OR app_is_platform_admin())))
    WITH CHECK (EXISTS (SELECT 1 FROM report_definitions d
                         WHERE d.id = report_id
                           AND (d.institution_id = app_current_institution()
                                OR app_is_platform_admin())));

CREATE POLICY digital_holding_visibility_tenant ON digital_holding_visibility
    USING (EXISTS (SELECT 1 FROM digital_holdings h
                    WHERE h.id = holding_id
                      AND (h.institution_id = app_current_institution()
                           OR app_is_platform_admin())))
    WITH CHECK (EXISTS (SELECT 1 FROM digital_holdings h
                         WHERE h.id = holding_id
                           AND (h.institution_id = app_current_institution()
                                OR app_is_platform_admin())));

GRANT SELECT, INSERT, UPDATE, DELETE ON report_definitions TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON report_shares TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON report_runs TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON digital_library_providers TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON digital_holdings TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON digital_holding_visibility TO app_user;

-- +goose Down
DROP TABLE IF EXISTS digital_holding_visibility;
DROP TABLE IF EXISTS digital_holdings;
DROP TABLE IF EXISTS digital_library_providers;
DROP TABLE IF EXISTS report_runs;
DROP TABLE IF EXISTS report_shares;
DROP TABLE IF EXISTS report_definitions;
