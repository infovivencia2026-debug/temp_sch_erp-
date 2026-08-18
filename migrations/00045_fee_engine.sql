-- +goose Up
-- The fee engine: versioned structures, a late-fine rule engine, and a receipt
-- series an auditor will accept.
--
-- NOTE TO THE INTEGRATOR: this file claims 00045. Several workers are cutting
-- migrations against the same base, so it may need renumbering on merge. It
-- depends only on tables that exist at 00044 and adds no ordering constraint
-- beyond that.
--
-- Almost nothing here is a new concept. The fee module already has structures,
-- items, heads with GST treatment, invoices, payments, allocations,
-- concessions and a numbering counter. What it lacks is the *history* of those
-- things:
--
--   fee_structures       has is_active but no notion of a revision, so a school
--                        that raises the transport fee in September edits the
--                        row and every invoice raised in April silently changes
--                        meaning. There is no way to answer "what did this
--                        parent actually agree to pay?".
--   fee_fine_rules       (00003) has kind/grace/amount/percent/cap, which is
--                        most of a rules engine. It cannot say "this head
--                        only", cannot compound, and has no exempt list, so a
--                        staff ward on a full concession gets fined.
--   numbering_schemes    (00001, 00004) has reset_yearly and nothing that
--                        reads it. NextNumber formats the financial year into
--                        the string but never resets the counter, so a school's
--                        first receipt of 2027-28 is RCPT/2027-28/00398. GST
--                        wants each year's series to start at 1 and to have no
--                        holes.
--
-- So: two new tables for versions, one for the fines that get raised, and
-- columns on the three existing tables above.

-- ===================================================================
-- 1. Fee structure versioning
-- ===================================================================

/* A revision of a fee structure, with the date it starts to bite.

   The problem this solves is not "keep a changelog". It is that an invoice is
   a claim on a parent for a specific amount, and the amount has to remain
   answerable months later. Editing fee_structure_items in place makes every
   historical invoice unexplainable: the ledger says ₹45,000, the structure now
   says ₹48,000, and nobody can say which is wrong.

   A version is therefore immutable once active. Revising the fee means adding
   a version, not editing one — and invoices keep pointing at the version they
   were raised under (see invoices.fee_structure_version_id below).

   academic_year_id is nullable and means "the structure's own year". It exists
   so a structure can carry versions across years without being duplicated, and
   it is the reason the one-active index below has to COALESCE. */
CREATE TABLE fee_structure_versions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id      uuid NOT NULL REFERENCES institutions(id)   ON DELETE CASCADE,
    fee_structure_id    uuid NOT NULL REFERENCES fee_structures(id) ON DELETE CASCADE,

    -- NULL means "inherit fee_structures.academic_year_id". Kept separate so a
    -- structure that outlives a year does not have to be cloned.
    academic_year_id    uuid REFERENCES academic_years(id) ON DELETE CASCADE,

    -- Human-facing revision number, 1, 2, 3 within the structure. Not derived
    -- from created_at: two drafts prepared in either order must still present
    -- as v2 and v3 in the order the school intends to apply them.
    version_no          integer NOT NULL,

    /* draft      — being prepared, invoices may not cite it
       active     — the version new invoices are raised under
       superseded — a later version took over; historical invoices still cite it

       No 'deleted'. A version an invoice cites must never disappear, which the
       ON DELETE RESTRICT on invoices.fee_structure_version_id enforces. */
    status              text NOT NULL DEFAULT 'draft',

    -- The date this revision starts to apply. Mid-year revisions are the whole
    -- point, so this is a real date and not derived from the academic year.
    effective_from      date NOT NULL,
    -- Set when a later version supersedes this one. NULL while current.
    effective_to        date,

    -- Why the fee changed. Shown next to the version everywhere, because "the
    -- transport fee went up ₹300 in September" is the question a parent asks
    -- and a school should not have to reconstruct it from two amounts.
    revision_note       text,

    -- The version this one replaced, so the screen can show a diff without
    -- guessing at version_no arithmetic.
    supersedes_id       uuid REFERENCES fee_structure_versions(id) ON DELETE SET NULL,

    activated_at        timestamptz,
    activated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fee_structure_versions_status_check
        CHECK (status IN ('draft','active','superseded')),
    CONSTRAINT fee_structure_versions_version_no_check
        CHECK (version_no > 0),
    -- A window that closes before it opens is a data-entry slip that would
    -- otherwise make the version match no invoice at all.
    CONSTRAINT fee_structure_versions_window_check
        CHECK (effective_to IS NULL OR effective_to >= effective_from),
    -- An active version has been activated; a draft has not. Without this a
    -- row can claim to be live with no record of who made it so.
    CONSTRAINT fee_structure_versions_activation_check
        CHECK ((status = 'draft') = (activated_at IS NULL))
);

-- v1, v2, v3 within a structure. Both columns are NOT NULL, so this one needs
-- no COALESCE.
CREATE UNIQUE INDEX fee_structure_versions_no
    ON fee_structure_versions (fee_structure_id, version_no);

/* Exactly one active version per structure per year.

   THE NULLABLE-UNIQUE TRAP. academic_year_id is nullable, and Postgres treats
   every NULL as distinct from every other NULL. Written bare, this index would
   permit unlimited active versions for the ordinary case — the one where the
   version inherits the structure's year and the column is NULL — which is
   precisely the case that matters. Two active versions means the invoice run
   picks whichever the planner returned first, and a class is billed two
   different amounts in the same term with nothing in the schema objecting.

   COALESCE to the zero uuid collapses those NULLs into one comparable value,
   which is what actually enforces the rule. This is the seventh time in this
   codebase; see academic_years_one_current and numbering_schemes (00004). */
CREATE UNIQUE INDEX fee_structure_versions_one_active
    ON fee_structure_versions (
        institution_id,
        fee_structure_id,
        COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE status = 'active';

-- The invoice run's query: the live version of each structure.
CREATE INDEX fee_structure_versions_lookup
    ON fee_structure_versions (institution_id, fee_structure_id, effective_from DESC);

COMMENT ON TABLE fee_structure_versions IS
    'One revision of a fee structure. Immutable once active; a mid-year fee change is a new version, not an edit. Invoices cite the version they were raised under so a historical claim stays explainable.';
COMMENT ON COLUMN fee_structure_versions.academic_year_id IS
    'NULL means inherit fee_structures.academic_year_id. Nullable, hence the COALESCE in fee_structure_versions_one_active.';
COMMENT ON COLUMN fee_structure_versions.status IS
    'draft | active | superseded. Exactly one active per (structure, year); superseded rows are retained because invoices still cite them.';

ALTER TABLE fee_structure_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_structure_versions FORCE  ROW LEVEL SECURITY;

CREATE POLICY fee_structure_versions_tenant ON fee_structure_versions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON fee_structure_versions TO app_user;


/* The amounts, frozen as at one version.

   A snapshot rather than a reference to fee_structure_items, because the point
   of the exercise is that the live items change and this must not. Same shape
   as fee_structure_items deliberately: the invoice run reads whichever of the
   two it is pointed at, and identical columns mean it does not need two code
   paths. */
CREATE TABLE fee_structure_version_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id      uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    version_id          uuid NOT NULL REFERENCES fee_structure_versions(id) ON DELETE CASCADE,
    fee_head_id         uuid NOT NULL REFERENCES fee_heads(id) ON DELETE RESTRICT,
    instalment_no       integer NOT NULL DEFAULT 1,
    -- bigint paise, like every other amount in this schema. A ₹45,000 term fee
    -- is 4500000 and every total is exact.
    amount_paise        bigint NOT NULL,
    due_on              date,

    CONSTRAINT fee_structure_version_items_amount_check CHECK (amount_paise >= 0),
    CONSTRAINT fee_structure_version_items_instalment_check CHECK (instalment_no > 0)
);

-- One line per head per instalment, mirroring
-- fee_structure_items_fee_structure_id_fee_head_id_instalment_key. All three
-- columns are NOT NULL, so no COALESCE is needed here.
CREATE UNIQUE INDEX fee_structure_version_items_line
    ON fee_structure_version_items (version_id, fee_head_id, instalment_no);

CREATE INDEX fee_structure_version_items_version
    ON fee_structure_version_items (institution_id, version_id);

COMMENT ON TABLE fee_structure_version_items IS
    'The fee lines frozen as at one version. A snapshot, not a reference: fee_structure_items keeps changing and this must not.';

ALTER TABLE fee_structure_version_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_structure_version_items FORCE  ROW LEVEL SECURITY;

CREATE POLICY fee_structure_version_items_tenant ON fee_structure_version_items
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON fee_structure_version_items TO app_user;


/* Which version this invoice was raised under.

   ON DELETE RESTRICT, not CASCADE and not SET NULL, and that is the entire
   guarantee: once an invoice cites a version, the version cannot be removed,
   so the claim stays explainable for as long as the claim exists.

   Nullable because every invoice raised before this migration was raised under
   no version at all. Backfilling them would be a fabrication — invoices carry
   no fee_structure_id, so there is nothing to join on and any value written
   here would be a guess presented as a fact. NULL reads as "raised before
   versioning", which is true. */
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS fee_structure_version_id uuid
        REFERENCES fee_structure_versions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS invoices_fee_structure_version
    ON invoices (fee_structure_version_id)
 WHERE fee_structure_version_id IS NOT NULL;

COMMENT ON COLUMN invoices.fee_structure_version_id IS
    'The fee structure version this invoice was raised under. ON DELETE RESTRICT: the version outlives the structure edit. NULL means the invoice predates versioning.';


-- ===================================================================
-- 2. Late fine rules engine
-- ===================================================================

/* fee_fine_rules (00003) is extended rather than replaced.

   It already carries kind (fixed/per_day/percent), grace_days, amount_paise,
   percent and cap_paise, which is most of what a fine rule needs. A second
   table would mean two places a school can configure a fine and two answers
   to "why was this parent charged ₹500". */

ALTER TABLE fee_fine_rules
    -- Which head the rule bites on. NULL means every head, which is what every
    -- existing row means, so the default is correct for them without a backfill.
    ADD COLUMN IF NOT EXISTS fee_head_id uuid REFERENCES fee_heads(id) ON DELETE CASCADE,

    -- none | weekly | monthly. A monthly rule levies its charge once per
    -- elapsed month rather than once, which is how most schools actually
    -- express "₹200 a month late".
    ADD COLUMN IF NOT EXISTS compound_period text NOT NULL DEFAULT 'none',

    /* Concession kinds this rule does not apply to, e.g. {staff_ward,rte}.

       A text[] over fee_concessions.kind rather than a join table: the list is
       short, closed, and read on every evaluation. A staff ward on a full
       concession being chased for a late fine is the complaint this prevents.

       Not a FK — kind is a CHECK-constrained text on fee_concessions, so there
       is no key to point at. The CHECK below keeps the values honest. */
    ADD COLUMN IF NOT EXISTS exempt_concession_kinds text[] NOT NULL DEFAULT '{}',

    -- Tie-break when two rules are equally specific. Lower wins.
    ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100,

    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE fee_fine_rules
    ADD CONSTRAINT fee_fine_rules_compound_check
        CHECK (compound_period IN ('none','weekly','monthly'));

-- A per-day charge already scales with time; compounding it as well would
-- multiply the same elapsed days twice and produce a fine nobody configured.
-- Rejected here rather than silently ignored in Go, so the screen cannot save
-- a rule that means something other than it says.
ALTER TABLE fee_fine_rules
    ADD CONSTRAINT fee_fine_rules_per_day_not_compounded
        CHECK (NOT (kind = 'per_day' AND compound_period <> 'none'));

ALTER TABLE fee_fine_rules
    ADD CONSTRAINT fee_fine_rules_exempt_kinds_check
        CHECK (exempt_concession_kinds <@ ARRAY['scholarship','sibling','staff_ward','rte','merit','other']::text[]);

/* One active rule per target.

   THE NULLABLE-UNIQUE TRAP AGAIN, and worse here than usual: all three of the
   targeting columns are nullable, and the commonest rule of all — "₹50 a day
   on anything overdue, anywhere" — has all three NULL. Bare, this index would
   permit any number of those, and the engine would either pick one
   arbitrarily or, if it summed them, fine the parent twice for one late
   payment. COALESCE to the zero uuid is what makes the constraint real.

   Partial on is_active: a school switching from one fine policy to another
   deactivates the old rule and keeps it for the audit trail, and two inactive
   rules with the same target are harmless. */
CREATE UNIQUE INDEX fee_fine_rules_one_active_per_target
    ON fee_fine_rules (
        institution_id,
        COALESCE(campus_id,        '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(fee_structure_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(fee_head_id,      '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE is_active;

COMMENT ON COLUMN fee_fine_rules.fee_head_id IS
    'The head this rule bites on. NULL means every head. Nullable, hence the COALESCE in fee_fine_rules_one_active_per_target.';
COMMENT ON COLUMN fee_fine_rules.compound_period IS
    'none | weekly | monthly. Levies the charge once per elapsed period. Forbidden with kind=per_day, which already scales with time.';
COMMENT ON COLUMN fee_fine_rules.exempt_concession_kinds IS
    'fee_concessions.kind values this rule does not apply to, e.g. {staff_ward,rte}. Empty means the rule applies to everyone.';


/* A fine that was actually raised, and the arithmetic behind it.

   Fines are not a timer. The engine previews (a pure function over dues,
   as-of date and rules — see EvaluateFines in internal/fees) and a human
   applies. This table is the record of the applying, and it exists because
   invoices.fine_paise is a single bigint that cannot answer "which rule, on
   what date, on what basis?" — which is the first thing a parent disputing a
   fine asks.

   The row keeps fee_structure_version_id because a percent fine on a head is a
   percent of what that head cost *under the version the invoice was raised
   under*, not under whatever the structure says today. Recomputing it later
   against the current structure would quietly restate a settled charge. */
CREATE TABLE fee_fine_charges (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id           uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    invoice_id               uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,

    -- SET NULL rather than CASCADE: deleting the rule must not delete the
    -- money already charged under it. rule_name keeps the charge readable
    -- after that happens.
    fee_fine_rule_id         uuid REFERENCES fee_fine_rules(id) ON DELETE SET NULL,
    rule_name                text NOT NULL,

    -- The head the fine was raised against. NULL for an all-heads rule.
    fee_head_id              uuid REFERENCES fee_heads(id) ON DELETE SET NULL,

    -- The version the invoice was raised under, copied at apply time so the
    -- basis stays reconstructible even if the invoice is later re-pointed.
    fee_structure_version_id uuid REFERENCES fee_structure_versions(id) ON DELETE SET NULL,

    -- The date the fine was computed as at. Part of the idempotency key: two
    -- runs on the same day must not double-charge.
    as_of                    date NOT NULL,
    days_overdue             integer NOT NULL,
    -- The amount the fine was computed on: the head's versioned amount for a
    -- head rule, the invoice balance for an all-heads rule.
    basis_paise              bigint NOT NULL,
    amount_paise             bigint NOT NULL,
    -- Whether cap_paise bit. Shown on the screen because "why is this ₹2,000
    -- and not ₹3,500" is otherwise unanswerable.
    was_capped               boolean NOT NULL DEFAULT false,
    -- How many compounding periods were levied. 1 for a non-compounding rule.
    periods                  integer NOT NULL DEFAULT 1,

    /* The full working, as the preview produced it: kind, grace, rate, each
       period's step. Written so a dispute is answered by reading a row rather
       than by re-running a calculation whose inputs have since moved. */
    working                  jsonb NOT NULL DEFAULT '{}'::jsonb,

    status                   text NOT NULL DEFAULT 'applied',
    waived_reason            text,
    applied_at               timestamptz NOT NULL DEFAULT now(),
    applied_by               uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT fee_fine_charges_status_check
        CHECK (status IN ('applied','waived','reversed')),
    CONSTRAINT fee_fine_charges_amount_check   CHECK (amount_paise >= 0),
    CONSTRAINT fee_fine_charges_basis_check    CHECK (basis_paise  >= 0),
    CONSTRAINT fee_fine_charges_periods_check  CHECK (periods > 0),
    CONSTRAINT fee_fine_charges_overdue_check  CHECK (days_overdue >= 0),
    -- A waiver without a reason is an unexplained reversal of a charge a
    -- parent was told about.
    CONSTRAINT fee_fine_charges_waiver_check
        CHECK (status <> 'waived' OR btrim(COALESCE(waived_reason,'')) <> '')
);

/* One live charge per invoice per rule per day.

   Re-running apply must be idempotent — an operator who clicks twice, or a
   retried request, must not double the fine. fee_fine_rule_id is nullable
   (the rule may later be deleted), so COALESCE again; without it the second
   click after a rule deletion would insert a duplicate.

   Partial on 'applied': a waived or reversed charge is history, and the same
   rule may legitimately be re-applied on the same day after a reversal. */
CREATE UNIQUE INDEX fee_fine_charges_once_per_day
    ON fee_fine_charges (
        institution_id,
        invoice_id,
        COALESCE(fee_fine_rule_id, '00000000-0000-0000-0000-000000000000'::uuid),
        as_of)
 WHERE status = 'applied';

CREATE INDEX fee_fine_charges_invoice
    ON fee_fine_charges (institution_id, invoice_id, applied_at DESC);

COMMENT ON TABLE fee_fine_charges IS
    'A late fine that was applied, with its working. Preview is a pure function (internal/fees.EvaluateFines); this is the record of a human applying the result. Never written by a timer.';
COMMENT ON COLUMN fee_fine_charges.basis_paise IS
    'What the fine was computed on: the head amount under the invoice''s fee structure version for a head rule, the invoice balance otherwise.';
COMMENT ON COLUMN fee_fine_charges.working IS
    'The arithmetic the preview produced, kept so a disputed fine is answered by reading rather than recomputing against inputs that have since moved.';

ALTER TABLE fee_fine_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_fine_charges FORCE  ROW LEVEL SECURITY;

CREATE POLICY fee_fine_charges_tenant ON fee_fine_charges
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON fee_fine_charges TO app_user;


-- ===================================================================
-- 3. GST compliant receipt numbering
-- ===================================================================

/* numbering_schemes has had reset_yearly since 00001 and nothing has ever read
   it. NextNumber renders the financial year into the string but leaves
   next_value alone, so the first receipt of 2027-28 continues the 2026-27
   count. Under GST each financial year's series must start at 1 and be
   gapless, so that is a compliance defect and not a cosmetic one.

   The fix needs one fact the table does not hold: which financial year the
   counter is currently counting within. */
ALTER TABLE numbering_schemes
    -- '2026-27'. The counter resets to 1 the first time a number is drawn in a
    -- later year, under the same row lock that serialises the draw.
    ADD COLUMN IF NOT EXISTS current_fy text,

    /* How the number is rendered. Placeholders: {prefix} {fy} {seq} {suffix}.
       A school that has printed 'SRV/2026-27/00001' on a year of receipts
       cannot be moved to another shape by a release, so the shape is data. */
    ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT '{prefix}{fy}/{seq}{suffix}',

    -- The most recently issued number, for the series screen. Cheaper and more
    -- honest than deriving it from payments, which only knows about receipts.
    ADD COLUMN IF NOT EXISTS last_number text,
    ADD COLUMN IF NOT EXISTS last_issued_at timestamptz,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE numbering_schemes
    ADD CONSTRAINT numbering_schemes_current_fy_shape
        CHECK (current_fy IS NULL OR current_fy ~ '^[0-9]{4}-[0-9]{2}$');

-- The format must contain the sequence, or every receipt in the year is
-- rendered identically and the series stops being a series.
ALTER TABLE numbering_schemes
    ADD CONSTRAINT numbering_schemes_format_has_seq
        CHECK (format LIKE '%{seq}%');

/* Adopt the current year for every existing counter, at its current value.

   Deliberately NOT resetting to 1. Existing receipts keep the numbers they
   were issued, and re-starting this year's count now would reissue numbers
   already printed and handed to parents — the one thing a gapless series must
   never do. Setting current_fy to the year in progress means the first reset
   happens at the next 1 April, which is what "this applies going forward"
   means. */
-- +goose StatementBegin
SELECT set_config('app.is_platform_admin', 'on', true);
-- +goose StatementEnd

UPDATE numbering_schemes
   SET current_fy = to_char(
           CASE WHEN extract(month FROM CURRENT_DATE) >= 4
                THEN CURRENT_DATE
                ELSE CURRENT_DATE - interval '1 year'
           END, 'YYYY')
       || '-' ||
       to_char(
           CASE WHEN extract(month FROM CURRENT_DATE) >= 4
                THEN CURRENT_DATE + interval '1 year'
                ELSE CURRENT_DATE
           END, 'YY')
 WHERE current_fy IS NULL;

COMMENT ON COLUMN numbering_schemes.current_fy IS
    'The Indian financial year the counter is currently counting within, "2026-27". next_value resets to 1 when a number is drawn in a later year. Backfilled to the year in progress so no already-issued number is reused.';
COMMENT ON COLUMN numbering_schemes.format IS
    'Render template. Placeholders {prefix} {fy} {seq} {suffix}. Must contain {seq}.';


/* The sequence and year behind a receipt number, as separate facts.

   receipt_no is a rendered string; 'RCPT/2026-27/00042' cannot be ordered,
   gap-checked or proved unique-per-year without parsing it, and parsing is
   exactly what breaks when a school changes its prefix. Storing the two facts
   the compliance question is actually about makes both checks a plain index.

   Nullable because every payment taken before this migration has a rendered
   number and no recorded sequence. They keep their numbers; they are simply
   outside the derived series. */
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS receipt_seq bigint,
    ADD COLUMN IF NOT EXISTS receipt_fy  text;

/* Never reused: one payment per (institution, year, sequence).

   THE NULLABLE-UNIQUE TRAP a third time — receipt_fy is nullable, so bare this
   would enforce nothing for exactly the rows most at risk, the ones written
   while the FY rollover is being got wrong. Partial on receipt_seq IS NOT NULL
   so pre-existing payments are exempt rather than colliding on NULL. */
CREATE UNIQUE INDEX IF NOT EXISTS payments_receipt_series_unique
    ON payments (institution_id, COALESCE(receipt_fy, ''), receipt_seq)
 WHERE receipt_seq IS NOT NULL;

-- The gap audit's query: this year's sequences in order.
CREATE INDEX IF NOT EXISTS payments_receipt_series
    ON payments (institution_id, receipt_fy, receipt_seq)
 WHERE receipt_seq IS NOT NULL;

COMMENT ON COLUMN payments.receipt_seq IS
    'The sequence drawn from numbering_schemes for this receipt, as a number. Kept separate from receipt_no so gaplessness is an index check rather than string parsing. NULL for payments predating the series.';
COMMENT ON COLUMN payments.receipt_fy IS
    'The financial year the sequence belongs to, "2026-27". With receipt_seq, the pair GST requires to be unique and gapless.';


-- ===================================================================
-- Seed: a v1 for every structure that already exists
-- ===================================================================

/* Without this the versioning screen opens empty on a school with a fully
   configured fee book, and the first revision would present as v1 rather than
   v2 — losing the fact that there was an earlier arrangement.

   effective_from is the academic year's start, which is the honest answer:
   the structure has applied since the year began. Status mirrors the
   structure's own is_active, so a retired structure does not claim a live
   version and trip the one-active index. */
INSERT INTO fee_structure_versions (
        institution_id, fee_structure_id, academic_year_id, version_no,
        status, effective_from, revision_note, activated_at, created_at)
SELECT fs.institution_id, fs.id, NULL, 1,
       CASE WHEN fs.is_active THEN 'active' ELSE 'draft' END,
       COALESCE(ay.starts_on, fs.created_at::date),
       'Version 1, recorded when versioning was introduced. The arrangement in force at that point.',
       CASE WHEN fs.is_active THEN fs.created_at ELSE NULL END,
       fs.created_at
  FROM fee_structures fs
  LEFT JOIN academic_years ay ON ay.id = fs.academic_year_id;

-- And freeze what that v1 actually charged.
INSERT INTO fee_structure_version_items (
        institution_id, version_id, fee_head_id, instalment_no, amount_paise, due_on)
SELECT fsi.institution_id, v.id, fsi.fee_head_id, fsi.instalment_no,
       fsi.amount_paise, fsi.due_on
  FROM fee_structure_items fsi
  JOIN fee_structure_versions v
    ON v.fee_structure_id = fsi.fee_structure_id AND v.version_no = 1;


-- +goose Down
DROP INDEX IF EXISTS payments_receipt_series;
DROP INDEX IF EXISTS payments_receipt_series_unique;
ALTER TABLE payments
    DROP COLUMN IF EXISTS receipt_fy,
    DROP COLUMN IF EXISTS receipt_seq;

ALTER TABLE numbering_schemes
    DROP CONSTRAINT IF EXISTS numbering_schemes_format_has_seq,
    DROP CONSTRAINT IF EXISTS numbering_schemes_current_fy_shape;
ALTER TABLE numbering_schemes
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS last_issued_at,
    DROP COLUMN IF EXISTS last_number,
    DROP COLUMN IF EXISTS format,
    DROP COLUMN IF EXISTS current_fy;

DROP TABLE IF EXISTS fee_fine_charges;

DROP INDEX IF EXISTS fee_fine_rules_one_active_per_target;
ALTER TABLE fee_fine_rules
    DROP CONSTRAINT IF EXISTS fee_fine_rules_exempt_kinds_check,
    DROP CONSTRAINT IF EXISTS fee_fine_rules_per_day_not_compounded,
    DROP CONSTRAINT IF EXISTS fee_fine_rules_compound_check;
ALTER TABLE fee_fine_rules
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS priority,
    DROP COLUMN IF EXISTS exempt_concession_kinds,
    DROP COLUMN IF EXISTS compound_period,
    DROP COLUMN IF EXISTS fee_head_id;

-- Must precede dropping fee_structure_versions: the RESTRICT that protects a
-- cited version would otherwise refuse the drop on any database with invoices.
DROP INDEX IF EXISTS invoices_fee_structure_version;
ALTER TABLE invoices DROP COLUMN IF EXISTS fee_structure_version_id;

DROP TABLE IF EXISTS fee_structure_version_items;
DROP TABLE IF EXISTS fee_structure_versions;
