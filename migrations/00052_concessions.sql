-- Number claimed as 00052 per the build plan; the tree's highest applied is
-- 00049, so the integrator may renumber this down. Content is independent of
-- the number: nothing here references another migration by version.
--
-- +goose Up
--
-- ===========================================================================
-- Money the school is owed, money the child is owed, and paperwork for money
-- neither of them has yet.
--
-- Three features in one file because they share exactly one noun that would
-- otherwise be entered three times: a government scheme. The RTE claim and the
-- NSP scholarship are both "a scheme run by an authority, under which money
-- moves"; they differ in *who the money reaches*, which is one column, not two
-- registries. The loan tracker shares nothing with either and is fenced off at
-- the bottom of the file.
--
-- What already existed and is reused rather than rebuilt:
--
--   students.is_rte      added in 00005, written by the admissions funnel when
--                        an application with quota='rte' is converted
--                        (internal/api/admissions_funnel.go). That boolean IS
--                        the answer to "is this child a 25% quota admission?".
--                        A second flag here would be a second answer, and the
--                        two would disagree within a term.
--   applications.quota   'rte' among others, the seat basis at admission. The
--                        claim reads students.is_rte rather than this, because
--                        a child claimed for is a child on the roll, not an
--                        application that was once made.
--   fee_concessions      kind='rte' is the fee side of the same fact. A claim
--                        line points at the concession row that zeroed the
--                        child's fee, so "why is this child free?" and "what
--                        did we claim for them?" resolve to one another.
--   students.category    general|obc|sc|st|ews|other, already CHECK-constrained.
--                        Caste and income category is not duplicated here. It
--                        is read through a finance-gated endpoint and appears
--                        on exactly one screen plus one export.
--   student_bank_accounts  where a DBT scholarship lands. This file stores no
--                        account number anywhere. The NSP import keeps four
--                        digits for eye-matching and nothing more.
--   payments (mode='adjustment') + payment_allocations
--                        how a scholarship credit becomes visible against a
--                        child's dues instead of living in its own universe.
--   student_documents, issued_certificates
--                        the loan document checklist points at these. A
--                        bonafide certificate the school already issues is not
--                        re-uploaded to satisfy a lender.
--   bank_accounts        where a treasury release lands.
--
-- What is deliberately NOT here: no interest rate, no tenure, no repayment
-- schedule, no EMI, no eligibility score. The school is not a lender and this
-- schema must not let a screen imply otherwise.
-- ===========================================================================


-- ================================================= the scheme, shared by two

-- A government scheme the school deals with.
--
-- paid_to is the whole distinction between the two features that read this
-- table. Under RTE the state owes the SCHOOL, and the school raises a claim,
-- chases a sanction order and waits for a treasury release. Under NSP the
-- centre owes the STUDENT, pays into the student's own account, and the
-- school's job is verification and reconciliation. Same noun, opposite
-- direction of the debt, so one table with a column rather than two tables
-- whose rows a clerk would have to keep in step by hand.
CREATE TABLE government_aid_schemes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    code              text NOT NULL,
    name              text NOT NULL,

    -- rte_reimbursement   the 25% quota under s.12(1)(c) of the RTE Act
    -- fee_reimbursement   a state scheme reimbursing fees for a named group
    -- nsp_scholarship     National Scholarship Portal, paid to the student
    -- state_scholarship   a state portal, also paid to the student
    kind              text NOT NULL,

    -- Who the money actually reaches. Derived from kind in practice but stored,
    -- because a state occasionally routes a "scholarship" through the school
    -- and the claim screens must be able to see it.
    paid_to           text NOT NULL,

    authority         text,
    portal_url        text,

    -- How often the school raises a claim. Meaningless for a scheme paid to
    -- the student, which is why the CHECK below only demands it for the other.
    claim_frequency   text,

    is_active         boolean NOT NULL DEFAULT true,
    notes             text,

    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT government_aid_schemes_kind CHECK (kind IN
        ('rte_reimbursement','fee_reimbursement','nsp_scholarship','state_scholarship')),
    CONSTRAINT government_aid_schemes_paid_to CHECK (paid_to IN ('school','student')),
    CONSTRAINT government_aid_schemes_frequency CHECK (claim_frequency IS NULL OR
        claim_frequency IN ('monthly','quarterly','half_yearly','annual')),
    -- A scheme the school claims against must say how often it claims,
    -- otherwise the claim screen cannot propose a period and every claim is
    -- typed from memory.
    CONSTRAINT government_aid_schemes_claim_cycle
        CHECK (paid_to = 'student' OR claim_frequency IS NOT NULL),
    CONSTRAINT government_aid_schemes_code_present  CHECK (btrim(code) <> ''),
    CONSTRAINT government_aid_schemes_name_present  CHECK (btrim(name) <> ''),

    UNIQUE (id, institution_id)
);

-- One code per school, case-insensitively. Both columns NOT NULL, so a plain
-- unique index is enough and no COALESCE is needed.
CREATE UNIQUE INDEX government_aid_schemes_one_per_code
    ON government_aid_schemes (institution_id, lower(btrim(code)));

CREATE INDEX government_aid_schemes_live
    ON government_aid_schemes (institution_id, kind) WHERE is_active;

-- Building a quarter's claim lines means "every RTE child on the roll", and
-- students.is_rte has carried no index since 00005 added it. On a school with
-- 2,000 children that is a sequential scan four times a year; on the state's
-- deadline day it is the one screen everybody is on. Partial, because the
-- false rows are 95% of the table and are never the ones being looked for.
CREATE INDEX IF NOT EXISTS students_rte
    ON students (institution_id) WHERE is_rte;

COMMENT ON TABLE government_aid_schemes IS
    'A government scheme under which money moves for a child. paid_to = school means the school raises a claim (RTE, state fee reimbursement); paid_to = student means the portal credits the child directly (NSP) and the school reconciles. Read by internal/api/concessions.go.';
COMMENT ON COLUMN government_aid_schemes.paid_to IS
    'school | student. The direction of the debt, and which of the two feature screens owns this row.';


-- The notified per-child rate, for one scheme, one academic year, one band of
-- classes.
--
-- The rate is notified by a government order and changes: by year, and by
-- class band, because primary and upper-primary are reimbursed differently
-- under RTE. Storing it means a claim can be recomputed and explained two
-- years later, when the person who typed it has left and the GO is a
-- photocopy in a file.
--
-- Bands are half-open in neither direction — from_level and to_level are both
-- inclusive class levels, matching classes.level. Overlapping bands would make
-- "the rate for class 5" ambiguous; the unique index below stops the identical
-- band being entered twice, and the handler refuses an overlapping one. A gist
-- EXCLUDE constraint would be the stronger guard but needs btree_gist, which
-- this deployment does not have installed and which a migration cannot install
-- without superuser.
CREATE TABLE reimbursement_rates (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    scheme_id         uuid NOT NULL REFERENCES government_aid_schemes(id) ON DELETE CASCADE,
    academic_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,

    from_level        integer NOT NULL,
    to_level          integer NOT NULL,

    -- Paise per child per full academic year. A claim for part of a year is a
    -- fraction of this, computed and stored on the line so the arithmetic is
    -- visible rather than re-derived.
    annual_rate_paise bigint NOT NULL,

    notification_ref  text,
    notified_on       date,
    notes             text,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reimbursement_rates_band     CHECK (to_level >= from_level),
    CONSTRAINT reimbursement_rates_levels   CHECK (from_level BETWEEN -3 AND 15),
    CONSTRAINT reimbursement_rates_positive CHECK (annual_rate_paise >= 0),

    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX reimbursement_rates_one_per_band
    ON reimbursement_rates (institution_id, scheme_id, academic_year_id, from_level, to_level);

COMMENT ON TABLE reimbursement_rates IS
    'The notified per-child annual reimbursement rate, by scheme, academic year and inclusive class band. Kept so a claim raised two years ago can still be explained against the government order that set it.';


-- ================================================ the claim, and what came back

-- One claim, for one scheme, for one period.
--
-- The lifecycle a school actually lives through:
--
--   draft            lines assembled from who was on roll in the period
--   submitted        sent to the department; submitted_on starts the clock
--   sanctioned       the order came back approving the whole claim
--   part_sanctioned  the order came back approving some of the children
--   rejected         it came back approving none
--   closed           the money is in, or the school has written it off
--
-- The three money columns are three different facts and are never collapsed:
-- claimed_paise is what was asked, sanctioned_paise is what the order approved,
-- received_paise is what the treasury actually released. The gap between the
-- first and the last, aged from submitted_on, is the entire point of this
-- table. A school with 180 RTE children typically has two years of these open.
--
-- claimed_paise, sanctioned_paise and child_count are maintained by trigger
-- from the lines; received_paise by trigger from the receipts. Derived totals
-- that a handler is trusted to keep in step drift the first time somebody
-- deletes a line in psql.
CREATE TABLE reimbursement_claims (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    -- RESTRICT: a submitted claim names a scheme, and deleting the scheme
    -- would leave a claim nobody can explain to an auditor.
    scheme_id         uuid NOT NULL REFERENCES government_aid_schemes(id) ON DELETE RESTRICT,
    academic_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,

    claim_no          text NOT NULL,
    period_start      date NOT NULL,
    period_end        date NOT NULL,

    status            text NOT NULL DEFAULT 'draft',

    child_count       integer NOT NULL DEFAULT 0,
    claimed_paise     bigint  NOT NULL DEFAULT 0,
    sanctioned_paise  bigint  NOT NULL DEFAULT 0,
    received_paise    bigint  NOT NULL DEFAULT 0,

    submitted_on      date,
    -- The acknowledgement the department gave on receipt. Often the only thing
    -- a school can produce when the department says it never arrived.
    submitted_ref     text,

    sanction_order_no text,
    sanction_on       date,
    rejected_reason   text,

    notes             text,
    prepared_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reimbursement_claims_status CHECK (status IN
        ('draft','submitted','part_sanctioned','sanctioned','rejected','closed')),
    CONSTRAINT reimbursement_claims_period CHECK (period_end >= period_start),
    CONSTRAINT reimbursement_claims_no_present CHECK (btrim(claim_no) <> ''),
    -- Anything past draft has been sent somewhere, and the date it was sent is
    -- what the ageing counts from. Without this the oldest, most valuable
    -- outstanding claims are the ones with no age at all.
    CONSTRAINT reimbursement_claims_submitted_is_dated
        CHECK (status = 'draft' OR submitted_on IS NOT NULL),
    CONSTRAINT reimbursement_claims_sanction_is_evidenced
        CHECK (status NOT IN ('sanctioned','part_sanctioned') OR sanction_on IS NOT NULL),
    CONSTRAINT reimbursement_claims_rejection_is_reasoned
        CHECK (status <> 'rejected' OR nullif(btrim(rejected_reason),'') IS NOT NULL),
    CONSTRAINT reimbursement_claims_amounts_sane
        CHECK (child_count >= 0 AND claimed_paise >= 0
               AND sanctioned_paise >= 0 AND received_paise >= 0),
    -- A department cannot sanction more than was claimed. If a school believes
    -- it has, the claim was understated and belongs in a revised claim.
    CONSTRAINT reimbursement_claims_sanction_within_claim
        CHECK (sanctioned_paise <= claimed_paise),

    UNIQUE (id, institution_id)
);

-- One claim number per scheme, case-insensitively. All three columns NOT NULL.
CREATE UNIQUE INDEX reimbursement_claims_one_per_no
    ON reimbursement_claims (institution_id, scheme_id, lower(btrim(claim_no)));

-- And one claim per scheme per period. A school that claims the same quarter
-- twice gets the second one rejected months later, by which time the first has
-- been forgotten.
CREATE UNIQUE INDEX reimbursement_claims_one_per_period
    ON reimbursement_claims (institution_id, scheme_id, academic_year_id, period_start, period_end);

CREATE INDEX reimbursement_claims_outstanding
    ON reimbursement_claims (institution_id, submitted_on)
 WHERE status IN ('submitted','part_sanctioned','sanctioned');

COMMENT ON TABLE reimbursement_claims IS
    'One RTE or state fee-reimbursement claim, for one scheme and one period. claimed / sanctioned / received are three separate facts; the gap between the first and the last, aged from submitted_on, is what the school is owed. Totals are trigger-maintained from lines and receipts.';
COMMENT ON COLUMN reimbursement_claims.received_paise IS
    'Sum of reimbursement_receipts for this claim, maintained by trigger. Never written by hand.';


-- One child on one claim.
--
-- Per child, per quarter, is the granularity a department argues at: a sanction
-- order disallows named children, not a lump sum, and a school that only stored
-- the total cannot answer which child was struck off or why.
--
-- Money received is NOT split down to the child. A treasury release arrives as
-- one transfer against the whole claim, and apportioning it across children
-- would invent a fact the school was never told. What the school genuinely has
-- per child is claimed vs sanctioned, which comes straight off the order.
CREATE TABLE reimbursement_claim_lines (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    claim_id          uuid NOT NULL REFERENCES reimbursement_claims(id) ON DELETE CASCADE,
    -- RESTRICT: a child who has left is still a child the state owes for.
    student_id        uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,

    class_id          uuid REFERENCES classes(id) ON DELETE SET NULL,
    -- Snapshot of the level the band was chosen by. The child is promoted; the
    -- claim must not silently re-band itself in April.
    class_level       integer,

    -- The notified annual rate applied, copied not referenced, for the same
    -- reason payout_items copies an account number: the row must stay
    -- explicable after the rate table is corrected.
    rate_paise        bigint NOT NULL,
    months            integer NOT NULL DEFAULT 12,
    claimed_paise     bigint NOT NULL,

    -- NULL until the sanction order is recorded. Zero means the order named
    -- this child and approved nothing, which is a different fact from silence.
    sanctioned_paise  bigint,
    disallowed_reason text,

    -- The fee_concessions row of kind 'rte' that made this child eligible.
    -- SET NULL rather than RESTRICT: a concession may legitimately be revised
    -- after a claim was raised, and the claim stands on its own record.
    concession_id     uuid REFERENCES fee_concessions(id) ON DELETE SET NULL,

    notes             text,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reimbursement_claim_lines_months   CHECK (months BETWEEN 1 AND 12),
    CONSTRAINT reimbursement_claim_lines_positive CHECK (rate_paise >= 0 AND claimed_paise >= 0),
    CONSTRAINT reimbursement_claim_lines_sanction_within_claim
        CHECK (sanctioned_paise IS NULL
               OR (sanctioned_paise >= 0 AND sanctioned_paise <= claimed_paise)),
    -- A child struck off the order has a reason on the order. Recording the
    -- shortfall without it leaves nothing to appeal with.
    CONSTRAINT reimbursement_claim_lines_shortfall_is_reasoned
        CHECK (sanctioned_paise IS NULL OR sanctioned_paise = claimed_paise
               OR nullif(btrim(disallowed_reason),'') IS NOT NULL),

    UNIQUE (id, institution_id)
);

-- One line per child per claim. Both columns NOT NULL, no COALESCE needed.
CREATE UNIQUE INDEX reimbursement_claim_lines_one_per_child
    ON reimbursement_claim_lines (claim_id, student_id);

CREATE INDEX reimbursement_claim_lines_by_student
    ON reimbursement_claim_lines (institution_id, student_id);

COMMENT ON TABLE reimbursement_claim_lines IS
    'One child on one claim: the rate applied, the months claimed, and what the sanction order allowed. sanctioned_paise NULL means no order yet; 0 means the order named the child and allowed nothing.';


-- Money the treasury actually released against a claim.
--
-- Recorded by hand or from a bank statement line, because there is no live
-- treasury API and this file will not pretend there is. One claim usually
-- draws several releases months apart.
CREATE TABLE reimbursement_receipts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    claim_id          uuid NOT NULL REFERENCES reimbursement_claims(id) ON DELETE CASCADE,

    received_on       date   NOT NULL,
    amount_paise      bigint NOT NULL,
    mode              text   NOT NULL DEFAULT 'neft',
    reference_no      text,
    treasury_voucher  text,
    -- Which of the school's own accounts it landed in, so the figure can be
    -- tied to the bank reconciliation that already exists.
    bank_account_id   uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,

    notes             text,
    recorded_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reimbursement_receipts_positive CHECK (amount_paise > 0),
    CONSTRAINT reimbursement_receipts_mode CHECK (mode IN
        ('neft','rtgs','cheque','dd','adjustment')),

    UNIQUE (id, institution_id)
);

-- The same release entered twice, which is how a claim quietly appears settled.
-- reference_no is nullable and part of the identity of the row, so it is
-- COALESCEd: without that, one NULL never equals another and the guard would
-- silently enforce nothing.
CREATE UNIQUE INDEX reimbursement_receipts_no_duplicate
    ON reimbursement_receipts (
        institution_id, claim_id, received_on, amount_paise,
        lower(btrim(COALESCE(reference_no, ''))));

CREATE INDEX reimbursement_receipts_by_claim
    ON reimbursement_receipts (claim_id, received_on DESC);

COMMENT ON TABLE reimbursement_receipts IS
    'A treasury release against a claim, entered by hand or from a bank statement. There is no live government API; money moves here by record, never by integration.';


-- +goose StatementBegin
/* Keep the claim header in step with its lines.

   In the database rather than the handler because the handler is not the only
   writer: a correction typed in psql, a later import, and the next agent to
   touch this schema all go straight at the lines. A header that disagrees with
   its own lines is worse than no header, because the ageing report is built
   from the header and would be confidently wrong. */
CREATE OR REPLACE FUNCTION reimbursement_claim_totals() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    target uuid := COALESCE(NEW.claim_id, OLD.claim_id);
BEGIN
    UPDATE reimbursement_claims c
       SET child_count      = t.n,
           claimed_paise    = t.claimed,
           sanctioned_paise = t.sanctioned,
           updated_at       = now()
      FROM (
        SELECT count(*)                                AS n,
               COALESCE(sum(l.claimed_paise), 0)       AS claimed,
               COALESCE(sum(COALESCE(l.sanctioned_paise, 0)), 0) AS sanctioned
          FROM reimbursement_claim_lines l
         WHERE l.claim_id = target
      ) t
     WHERE c.id = target;
    RETURN COALESCE(NEW, OLD);
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER reimbursement_claim_lines_roll_up
    AFTER INSERT OR UPDATE OR DELETE ON reimbursement_claim_lines
    FOR EACH ROW EXECUTE FUNCTION reimbursement_claim_totals();

-- +goose StatementBegin
/* And in step with its receipts, for the same reason. received_paise is the
   number the ageing report subtracts; it is never written by hand. */
CREATE OR REPLACE FUNCTION reimbursement_claim_received() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    target uuid := COALESCE(NEW.claim_id, OLD.claim_id);
BEGIN
    UPDATE reimbursement_claims c
       SET received_paise = COALESCE(
               (SELECT sum(rr.amount_paise) FROM reimbursement_receipts rr
                 WHERE rr.claim_id = target), 0),
           updated_at = now()
     WHERE c.id = target;
    RETURN COALESCE(NEW, OLD);
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER reimbursement_receipts_roll_up
    AFTER INSERT OR UPDATE OR DELETE ON reimbursement_receipts
    FOR EACH ROW EXECUTE FUNCTION reimbursement_claim_received();


-- ============================================ NSP: what we expected, what landed

-- The school's own record of a scholarship a child is expected to receive.
--
-- NSP pays the student, not the school, so the school never sees the money.
-- What it can see, and what nobody else is keeping, is the expectation: this
-- child applied, we verified them on the portal, the portal sanctioned this
-- much, and either it arrived or it did not. The case that matters is the
-- fourth: sanctioned months ago, never credited, and nobody chasing it because
-- the school assumed the portal had it in hand.
--
-- Caste and income category is NOT copied here. It is the eligibility basis
-- and it already lives on students.category under a CHECK constraint; a second
-- copy would be a second thing to leak and a second thing to go stale.
CREATE TABLE scholarship_awards (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    scheme_id         uuid NOT NULL REFERENCES government_aid_schemes(id) ON DELETE RESTRICT,
    student_id        uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    academic_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,

    -- The portal's own application id. Nullable because a school often records
    -- the intention before the family brings the acknowledgement slip.
    application_ref   text,

    -- applied           the family says they applied
    -- school_verified   the school verified them on the portal — the school's
    --                   one real duty in this process
    -- school_rejected   the school refused to verify, with a reason
    -- sanctioned        the portal sanctioned an amount
    -- credited          money reached the child's account
    -- not_credited      sanctioned, and the credit failed or never came
    -- withdrawn         the family withdrew, or the application lapsed
    stage             text NOT NULL DEFAULT 'applied',

    verified_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    verified_at       timestamptz,
    rejected_reason   text,

    expected_paise    bigint,
    sanctioned_paise  bigint,
    credited_paise    bigint NOT NULL DEFAULT 0,
    credited_on       date,

    -- Which registered account the credit was expected in. Points at the
    -- existing register; no account number is stored in this file.
    bank_account_id   uuid REFERENCES student_bank_accounts(id) ON DELETE SET NULL,

    -- Some state schemes are meant to discharge the school's own fee rather
    -- than reach the family as cash. Where that is true the credit is posted
    -- against the child's dues as an adjustment payment, so it shows on the
    -- fee ledger the parent and the accountant both already read.
    offsets_fees      boolean NOT NULL DEFAULT false,
    fee_credit_payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,

    notes             text,
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT scholarship_awards_stage CHECK (stage IN
        ('applied','school_verified','school_rejected','sanctioned','credited',
         'not_credited','withdrawn')),
    CONSTRAINT scholarship_awards_amounts CHECK (
        (expected_paise   IS NULL OR expected_paise   >= 0) AND
        (sanctioned_paise IS NULL OR sanctioned_paise >= 0) AND
        credited_paise >= 0),
    CONSTRAINT scholarship_awards_verified_is_evidenced
        CHECK (verified_at IS NULL OR verified_by IS NOT NULL),
    CONSTRAINT scholarship_awards_verification_is_recorded
        CHECK (stage <> 'school_verified' OR verified_at IS NOT NULL),
    CONSTRAINT scholarship_awards_rejection_is_reasoned
        CHECK (stage <> 'school_rejected' OR nullif(btrim(rejected_reason),'') IS NOT NULL),
    CONSTRAINT scholarship_awards_sanction_is_amounted
        CHECK (stage NOT IN ('sanctioned','credited','not_credited')
               OR sanctioned_paise IS NOT NULL),
    -- Credited means money arrived. A stage of 'credited' with nothing in it,
    -- or a credit date with no amount, is the reconciliation reporting success
    -- for a transfer that never happened.
    CONSTRAINT scholarship_awards_credit_is_real
        CHECK (stage <> 'credited' OR (credited_paise > 0 AND credited_on IS NOT NULL)),
    CONSTRAINT scholarship_awards_credit_date_has_amount
        CHECK (credited_on IS NULL OR credited_paise > 0),
    -- A fee credit only exists for a scholarship meant to offset fees.
    CONSTRAINT scholarship_awards_fee_credit_is_intended
        CHECK (fee_credit_payment_id IS NULL OR offsets_fees),

    UNIQUE (id, institution_id)
);

-- One award per child per scheme per year. All four columns NOT NULL.
CREATE UNIQUE INDEX scholarship_awards_one_per_child
    ON scholarship_awards (institution_id, scheme_id, student_id, academic_year_id);

-- And one application reference per scheme. Partial rather than COALESCEd: an
-- absent reference is genuinely not a duplicate of another absent one, and the
-- WHERE clause says so instead of a sentinel uuid pretending otherwise.
CREATE UNIQUE INDEX scholarship_awards_one_per_ref
    ON scholarship_awards (institution_id, scheme_id, lower(btrim(application_ref)))
 WHERE application_ref IS NOT NULL AND btrim(application_ref) <> '';

CREATE INDEX scholarship_awards_by_stage
    ON scholarship_awards (institution_id, academic_year_id, stage);

COMMENT ON TABLE scholarship_awards IS
    'The school''s record of a scholarship a child is expected to receive under a portal scheme. NSP pays the student directly; this is the expectation the reconciliation compares the portal''s disbursement file against. Category is not copied here — it lives on students.category.';
COMMENT ON COLUMN scholarship_awards.fee_credit_payment_id IS
    'The payments row (mode=adjustment) posting this credit against the child''s dues, where the scheme is meant to discharge fees. NULL means the money reached the family as cash, which is the usual case.';


-- One import of a portal disbursement list.
--
-- File exchange, not an API. NSP publishes a disbursement list the school
-- downloads; there is no live integration and nothing here claims one. Kept
-- even when it matches nothing, because "I imported it and nothing happened"
-- is a support call the row itself answers.
CREATE TABLE scholarship_disbursement_imports (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    scheme_id         uuid NOT NULL REFERENCES government_aid_schemes(id) ON DELETE CASCADE,
    academic_year_id  uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,

    filename          text,
    source            text NOT NULL DEFAULT 'nsp_portal_csv',

    row_count         integer NOT NULL DEFAULT 0,
    matched_count     integer NOT NULL DEFAULT 0,
    unmatched_count   integer NOT NULL DEFAULT 0,
    rejected_count    integer NOT NULL DEFAULT 0,
    credited_paise    bigint  NOT NULL DEFAULT 0,

    -- Rows the parser refused, with the reason, so a mis-shaped column is
    -- diagnosable without re-running the import.
    rejects           jsonb NOT NULL DEFAULT '[]'::jsonb,

    imported_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    imported_at       timestamptz NOT NULL DEFAULT now(),
    notes             text,

    CONSTRAINT scholarship_disbursement_imports_source CHECK (source IN
        ('nsp_portal_csv','state_portal_csv','manual')),
    CONSTRAINT scholarship_disbursement_imports_counts CHECK (
        row_count >= 0 AND matched_count >= 0 AND unmatched_count >= 0
        AND rejected_count >= 0 AND credited_paise >= 0),

    UNIQUE (id, institution_id)
);

CREATE INDEX scholarship_disbursement_imports_recent
    ON scholarship_disbursement_imports (institution_id, scheme_id, imported_at DESC);

COMMENT ON TABLE scholarship_disbursement_imports IS
    'One import of a portal disbursement list. There is no NSP API: the school downloads a file and uploads it here.';


-- One row of a portal disbursement list, kept raw and parsed.
--
-- account_last4 and nothing more. The portal file carries full account numbers;
-- storing them would create a second register of children's bank details
-- outside student_bank_accounts, without its masking, without its reveal audit,
-- and without anybody having decided to. Four digits is enough to eye-match a
-- row against the register, which is all this screen needs.
CREATE TABLE scholarship_disbursement_lines (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    import_id         uuid NOT NULL REFERENCES scholarship_disbursement_imports(id) ON DELETE CASCADE,
    line_no           integer NOT NULL,

    application_ref   text,
    student_name_given text,
    admission_no_given text,

    amount_paise      bigint NOT NULL,
    credited_on       date,
    bank_reference    text,
    account_last4     text,
    portal_status     text,

    -- What this line was matched to, and how.
    award_id          uuid REFERENCES scholarship_awards(id) ON DELETE SET NULL,
    match_kind        text NOT NULL DEFAULT 'unmatched',

    -- What is wrong with this line even though it matched. This is the column
    -- the screen is built around.
    --   amount_differs  the portal credited something other than the sanction
    --   student_left    credited to a child no longer on the school's roll
    --   no_award        credited to somebody this school has no record of
    --   duplicate       the same application reference twice in one file
    exception         text,

    raw_line          text,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT scholarship_disbursement_lines_positive CHECK (amount_paise >= 0),
    CONSTRAINT scholarship_disbursement_lines_match_kind CHECK (match_kind IN
        ('unmatched','application_ref','admission_no','manual')),
    CONSTRAINT scholarship_disbursement_lines_exception CHECK (exception IS NULL OR exception IN
        ('amount_differs','student_left','no_award','duplicate')),
    -- Matched and unmatched are the two states, and they must agree with
    -- whether an award is actually named.
    CONSTRAINT scholarship_disbursement_lines_match_agrees
        CHECK ((match_kind = 'unmatched') = (award_id IS NULL)),
    -- Four characters, never more. The CHECK is the guard: a parser change
    -- that started writing the whole number would fail here rather than
    -- quietly building a second copy of the bank register.
    CONSTRAINT scholarship_disbursement_lines_last4_only
        CHECK (account_last4 IS NULL OR account_last4 ~ '^[0-9A-Za-z]{4}$'),

    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX scholarship_disbursement_lines_one_per_row
    ON scholarship_disbursement_lines (import_id, line_no);

CREATE INDEX scholarship_disbursement_lines_exceptions
    ON scholarship_disbursement_lines (institution_id, import_id)
 WHERE exception IS NOT NULL OR match_kind = 'unmatched';

COMMENT ON TABLE scholarship_disbursement_lines IS
    'One row of an imported portal disbursement list. Holds four digits of the account and never the whole number: student_bank_accounts is the one register of children''s bank details and this must not become a second.';
COMMENT ON COLUMN scholarship_disbursement_lines.exception IS
    'Why this line needs a person: amount_differs | student_left | no_award | duplicate. NULL means it reconciled cleanly.';


-- ================================================ education loans: paperwork only

-- A lender the school has dealt with.
--
-- A contact list, deliberately. No product, no rate, no eligibility rule and
-- no ranking: the moment this table carries an interest rate, a screen built
-- on it is offering a financial product, which the school is not licensed to
-- do and has not agreed to be liable for.
CREATE TABLE education_loan_lenders (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    name              text NOT NULL,
    lender_kind       text NOT NULL DEFAULT 'public_sector_bank',
    branch            text,

    contact_name      text,
    contact_phone     text,
    contact_email     text,

    is_active         boolean NOT NULL DEFAULT true,
    notes             text,

    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT education_loan_lenders_kind CHECK (lender_kind IN
        ('public_sector_bank','private_bank','nbfc','cooperative','other')),
    CONSTRAINT education_loan_lenders_name_present CHECK (btrim(name) <> ''),
    CONSTRAINT education_loan_lenders_phone_shape
        CHECK (contact_phone IS NULL OR contact_phone ~ '^[0-9+][0-9 -]{7,17}$'),
    CONSTRAINT education_loan_lenders_email_shape
        CHECK (contact_email IS NULL OR contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

    UNIQUE (id, institution_id)
);

-- One lender per branch. branch is nullable and part of the identity, so it is
-- COALESCEd — head office and a named branch are different rows, but two rows
-- with no branch are the same lender entered twice.
CREATE UNIQUE INDEX education_loan_lenders_one_per_branch
    ON education_loan_lenders (
        institution_id, lower(btrim(name)), lower(btrim(COALESCE(branch, ''))));

COMMENT ON TABLE education_loan_lenders IS
    'Banks and NBFCs the school has helped families apply to. A contact list. Deliberately carries no rate, tenure or eligibility rule — the school is not a lender and nothing built on this table may imply it is.';


-- One family's application to one lender.
--
-- The school's role is to hand over paperwork and to know where the application
-- has got to. Three things are therefore absent by design: no interest, no
-- repayment schedule, no approval by the school. sanctioned and disbursed
-- amounts are recorded as *reported* — the lender does not tell the school
-- anything, the family does, and the column comments say so.
CREATE TABLE education_loan_applications (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id        uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    -- Nullable: a family often starts by asking the school what is needed,
    -- before any lender is chosen.
    lender_id         uuid REFERENCES education_loan_lenders(id) ON DELETE SET NULL,
    academic_year_id  uuid REFERENCES academic_years(id) ON DELETE SET NULL,

    -- The lender's own application number, once there is one.
    reference_no      text,
    opened_on         date NOT NULL DEFAULT CURRENT_DATE,

    -- What the family says they need. Not an assessment, not an offer.
    amount_sought_paise bigint,

    status            text NOT NULL DEFAULT 'enquiry',
    status_changed_on date NOT NULL DEFAULT CURRENT_DATE,

    -- Reported by the family. The school is not a party to the loan.
    sanctioned_amount_paise bigint,
    disbursed_amount_paise  bigint,
    outcome_reported_on     date,
    declined_reason         text,
    closed_on               date,

    assisted_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    notes             text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT education_loan_applications_status CHECK (status IN
        ('enquiry','documents_pending','submitted_to_lender','under_review',
         'sanctioned','declined','withdrawn','disbursed')),
    CONSTRAINT education_loan_applications_amounts CHECK (
        (amount_sought_paise     IS NULL OR amount_sought_paise     > 0) AND
        (sanctioned_amount_paise IS NULL OR sanctioned_amount_paise > 0) AND
        (disbursed_amount_paise  IS NULL OR disbursed_amount_paise  > 0)),
    -- An outcome only exists once there is a lender to have produced it.
    CONSTRAINT education_loan_applications_lender_before_lender_states
        CHECK (status IN ('enquiry','documents_pending','withdrawn')
               OR lender_id IS NOT NULL),
    CONSTRAINT education_loan_applications_sanction_is_staged
        CHECK (sanctioned_amount_paise IS NULL OR status IN ('sanctioned','disbursed')),
    CONSTRAINT education_loan_applications_disbursal_is_staged
        CHECK (disbursed_amount_paise IS NULL OR status = 'disbursed'),
    CONSTRAINT education_loan_applications_decline_is_reasoned
        CHECK (status <> 'declined' OR nullif(btrim(declined_reason),'') IS NOT NULL),

    UNIQUE (id, institution_id)
);

-- One live application per child per lender. A family with two open
-- applications at the same bank has one of them stalled and forgotten, which
-- is the exact thing this screen exists to prevent. lender_id is nullable and
-- part of the key, so it is COALESCEd to the nil uuid.
CREATE UNIQUE INDEX education_loan_applications_one_live
    ON education_loan_applications (
        institution_id, student_id,
        COALESCE(lender_id, '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE status IN ('enquiry','documents_pending','submitted_to_lender','under_review');

-- And one lender reference, where there is one.
CREATE UNIQUE INDEX education_loan_applications_one_per_ref
    ON education_loan_applications (
        institution_id,
        COALESCE(lender_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(btrim(reference_no)))
 WHERE reference_no IS NOT NULL AND btrim(reference_no) <> '';

CREATE INDEX education_loan_applications_open
    ON education_loan_applications (institution_id, status, status_changed_on);

COMMENT ON TABLE education_loan_applications IS
    'A family''s education-loan application, tracked by the school as documents and status only. No interest, no repayment schedule, no school approval: the school is not the lender and this table gives it nothing to pretend with.';
COMMENT ON COLUMN education_loan_applications.sanctioned_amount_paise IS
    'As reported to the school by the family. The lender tells the school nothing; this is hearsay recorded as such.';


-- The document checklist for one application.
--
-- Points at documents the school already holds rather than asking for them
-- again: student_documents for uploads, issued_certificates for a bonafide the
-- school has already issued. A lender's list is long and mostly things the
-- office has in a drawer; the value here is knowing which one is missing.
CREATE TABLE education_loan_documents (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    application_id    uuid NOT NULL REFERENCES education_loan_applications(id) ON DELETE CASCADE,

    doc_kind          text NOT NULL,
    -- Free text only for doc_kind='other', so the common kinds stay countable.
    label             text,

    status            text NOT NULL DEFAULT 'required',

    -- Whichever of these the document actually is. Both nullable: a document
    -- the family brings on paper and the office photocopies has neither.
    student_document_id   uuid REFERENCES student_documents(id) ON DELETE SET NULL,
    issued_certificate_id uuid REFERENCES issued_certificates(id) ON DELETE SET NULL,

    provided_on       date,
    waived_reason     text,
    notes             text,

    updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT education_loan_documents_kind CHECK (doc_kind IN
        ('fee_structure','bonafide_certificate','admission_letter','fee_receipts',
         'marksheet','id_proof','address_proof','income_proof','photograph','other')),
    CONSTRAINT education_loan_documents_status CHECK (status IN
        ('required','provided','submitted','verified','waived')),
    CONSTRAINT education_loan_documents_other_is_named
        CHECK (doc_kind <> 'other' OR nullif(btrim(label),'') IS NOT NULL),
    CONSTRAINT education_loan_documents_waiver_is_reasoned
        CHECK (status <> 'waived' OR nullif(btrim(waived_reason),'') IS NOT NULL),
    -- Anything past 'required' happened on a day. Without the date, "provided"
    -- is a checkbox nobody can date when the lender asks.
    CONSTRAINT education_loan_documents_provided_is_dated
        CHECK (status IN ('required','waived') OR provided_on IS NOT NULL),

    UNIQUE (id, institution_id)
);

-- One row per kind per application. label is nullable and distinguishes two
-- 'other' rows, so it is COALESCEd.
CREATE UNIQUE INDEX education_loan_documents_one_per_kind
    ON education_loan_documents (
        application_id, doc_kind, lower(btrim(COALESCE(label, ''))));

COMMENT ON TABLE education_loan_documents IS
    'The lender''s document checklist for one application, pointed at student_documents and issued_certificates so a certificate the school already issued is not asked for twice.';


-- Where the application has been.
--
-- A parent's actual question is "has anything happened?", and a status column
-- alone answers it only for the last thing. This is small on purpose: from,
-- to, when, who, and a sentence.
CREATE TABLE education_loan_events (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    application_id    uuid NOT NULL REFERENCES education_loan_applications(id) ON DELETE CASCADE,

    happened_at       timestamptz NOT NULL DEFAULT now(),
    from_status       text,
    to_status         text NOT NULL,
    note              text,
    actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT education_loan_events_to_status CHECK (to_status IN
        ('enquiry','documents_pending','submitted_to_lender','under_review',
         'sanctioned','declined','withdrawn','disbursed')),

    UNIQUE (id, institution_id)
);

CREATE INDEX education_loan_events_by_application
    ON education_loan_events (application_id, happened_at DESC);

COMMENT ON TABLE education_loan_events IS
    'Status history for one education-loan application, so a family can be told what has happened rather than only where it stands.';


-- =========================================================== RLS, then grants

ALTER TABLE government_aid_schemes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE government_aid_schemes            FORCE  ROW LEVEL SECURITY;
ALTER TABLE reimbursement_rates               ENABLE ROW LEVEL SECURITY;
ALTER TABLE reimbursement_rates               FORCE  ROW LEVEL SECURITY;
ALTER TABLE reimbursement_claims              ENABLE ROW LEVEL SECURITY;
ALTER TABLE reimbursement_claims              FORCE  ROW LEVEL SECURITY;
ALTER TABLE reimbursement_claim_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE reimbursement_claim_lines         FORCE  ROW LEVEL SECURITY;
ALTER TABLE reimbursement_receipts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE reimbursement_receipts            FORCE  ROW LEVEL SECURITY;
ALTER TABLE scholarship_awards                ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_awards                FORCE  ROW LEVEL SECURITY;
ALTER TABLE scholarship_disbursement_imports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_disbursement_imports  FORCE  ROW LEVEL SECURITY;
ALTER TABLE scholarship_disbursement_lines    ENABLE ROW LEVEL SECURITY;
ALTER TABLE scholarship_disbursement_lines    FORCE  ROW LEVEL SECURITY;
ALTER TABLE education_loan_lenders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE education_loan_lenders            FORCE  ROW LEVEL SECURITY;
ALTER TABLE education_loan_applications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE education_loan_applications       FORCE  ROW LEVEL SECURITY;
ALTER TABLE education_loan_documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE education_loan_documents          FORCE  ROW LEVEL SECURITY;
ALTER TABLE education_loan_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE education_loan_events             FORCE  ROW LEVEL SECURITY;

CREATE POLICY government_aid_schemes_tenant ON government_aid_schemes
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY reimbursement_rates_tenant ON reimbursement_rates
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY reimbursement_claims_tenant ON reimbursement_claims
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY reimbursement_claim_lines_tenant ON reimbursement_claim_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY reimbursement_receipts_tenant ON reimbursement_receipts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY scholarship_awards_tenant ON scholarship_awards
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY scholarship_disbursement_imports_tenant ON scholarship_disbursement_imports
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY scholarship_disbursement_lines_tenant ON scholarship_disbursement_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY education_loan_lenders_tenant ON education_loan_lenders
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY education_loan_applications_tenant ON education_loan_applications
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY education_loan_documents_tenant ON education_loan_documents
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY education_loan_events_tenant ON education_loan_events
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- 00042 sets ALTER DEFAULT PRIVILEGES so tables created after it are covered
-- whichever role creates them. Stated explicitly anyway, for the same reason
-- 00046 states it: a database restored from a dump taken before that migration
-- has the default privileges but not necessarily the creating role.
GRANT SELECT, INSERT, UPDATE, DELETE ON government_aid_schemes           TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement_rates              TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement_claims             TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement_claim_lines        TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement_receipts           TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON scholarship_awards               TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON scholarship_disbursement_imports TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON scholarship_disbursement_lines   TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON education_loan_lenders           TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON education_loan_applications      TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON education_loan_documents         TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON education_loan_events            TO app_user;

-- +goose Down
DROP TRIGGER IF EXISTS reimbursement_receipts_roll_up ON reimbursement_receipts;
DROP TRIGGER IF EXISTS reimbursement_claim_lines_roll_up ON reimbursement_claim_lines;
DROP FUNCTION IF EXISTS reimbursement_claim_received();
DROP FUNCTION IF EXISTS reimbursement_claim_totals();
DROP TABLE IF EXISTS education_loan_events;
DROP TABLE IF EXISTS education_loan_documents;
DROP TABLE IF EXISTS education_loan_applications;
DROP TABLE IF EXISTS education_loan_lenders;
DROP TABLE IF EXISTS scholarship_disbursement_lines;
DROP TABLE IF EXISTS scholarship_disbursement_imports;
DROP TABLE IF EXISTS scholarship_awards;
DROP TABLE IF EXISTS reimbursement_receipts;
DROP TABLE IF EXISTS reimbursement_claim_lines;
DROP TABLE IF EXISTS reimbursement_claims;
DROP TABLE IF EXISTS reimbursement_rates;
DROP TABLE IF EXISTS government_aid_schemes;
DROP INDEX IF EXISTS students_rte;
