-- Numbered 00046 as instructed. THIS NUMBER MAY BE RENUMBERED AT INTEGRATION:
-- 00045 is claimed by another worker in this same round, and goose refuses a
-- version that appears behind the current one, so if this lands after a higher
-- number it must be renamed rather than reordered. Nothing in the file depends
-- on its own number.

-- +goose Up

/* Banking: the statement, the payout, and the account number.

   Three features that look unrelated and are in fact one subject — the point
   where the school's books meet a bank. Built together because they share the
   same two nouns and separating them would mean three different ideas of what
   a bank account is:

     bank_accounts        the school's own accounts. The BRS reconciles one,
                          the payout batch debits one.
     student_bank_accounts a child's (or their guardian's) account, which is
                          where a DBT scholarship lands and where a refund goes.

   What is deliberately NOT here: any ALTER on payments, invoices, receipts,
   vendor_bills or payslips. Those tables are being edited elsewhere this round.
   Everything this file needs to say about a book entry it says on its own row,
   pointing at theirs — bank_statement_lines.match_id rather than a
   payments.bank_line_id. payments already carries reconciled_at/reconciled_by
   from 00001 and this file leaves them alone; the match on the line is the
   record, and the residue is derived from it. */

-- ============================================================ the school's banks

/* The school's own bank accounts.

   Not the same thing as the ledger account, and not merged into it. A ledger
   account is a place postings land; this is a place money physically sits, and
   it carries the number and IFSC the bank's own upload file demands. Joined to
   ledger_accounts rather than duplicating it so the cashbook and the
   reconciliation cannot disagree about the balance — but nullable, because a
   school will register the bank account it wants to reconcile before anybody
   has decided which ledger code it posts to, and refusing that would make the
   first import impossible. */
CREATE TABLE bank_accounts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- The cashbook this account is the bank side of. RESTRICT, not CASCADE:
    -- deleting a chart-of-accounts row must never silently orphan a reconciled
    -- period.
    ledger_account_id uuid,

    -- What the school calls it: "SBI Main Collection", "HDFC Salary".
    label             text NOT NULL,
    bank_name         text NOT NULL,
    branch            text,
    account_number    text NOT NULL,
    ifsc              text NOT NULL,
    account_type      text NOT NULL DEFAULT 'current',

    -- What this account is used for, which is why a payout batch may not debit
    -- the collection account by accident.
    allows_payouts    boolean NOT NULL DEFAULT false,
    is_active         boolean NOT NULL DEFAULT true,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    /* IFSC is exactly eleven: four letters of bank code, a reserved zero, then
       six alphanumeric for the branch. Enforced in the database and not only in
       the handler because a wrong IFSC is not a validation nicety — it is a
       transfer that fails at the bank days later, or worse, one that succeeds
       into somebody else's account. */
    CONSTRAINT bank_accounts_ifsc_shape
        CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
    CONSTRAINT bank_accounts_number_shape
        CHECK (account_number ~ '^[A-Za-z0-9]{6,20}$'),
    CONSTRAINT bank_accounts_type
        CHECK (account_type IN ('current','savings','od','cc')),
    CONSTRAINT bank_accounts_label_present
        CHECK (nullif(btrim(label), '') IS NOT NULL),
    CONSTRAINT bank_accounts_bank_present
        CHECK (nullif(btrim(bank_name), '') IS NOT NULL),

    FOREIGN KEY (ledger_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE RESTRICT,
    UNIQUE (id, institution_id)
);

-- The same account number at the same bank cannot be registered twice. Both
-- columns are NOT NULL, so this is a plain unique index and needs no COALESCE.
CREATE UNIQUE INDEX bank_accounts_number_once
    ON bank_accounts (institution_id, upper(btrim(ifsc)), upper(btrim(account_number)));

CREATE UNIQUE INDEX bank_accounts_label_once
    ON bank_accounts (institution_id, lower(btrim(label)));

COMMENT ON TABLE bank_accounts IS
    'The school''s own bank accounts. Reconciled by bank_reconciliations, debited by payout_batches. Distinct from ledger_accounts, which is where the postings land.';

-- ==================================================== the reconciliation period

/* One reconciliation: one account, one period, an opening and a closing figure.

   The row exists so that a reconciled period can be *closed*. Without it the
   BRS is a report — recomputed on every visit, and therefore quietly different
   next month when somebody backdates a receipt into a period the auditor has
   already signed. With it, finalising freezes the arithmetic: the residue is
   stored, and the trigger below refuses to let a finalised period's lines move.

   Opening and closing balances are the bank's figures, typed from the
   statement, not computed from the book. That is the whole point of a
   reconciliation — the two sides are allowed to differ, and the difference is
   the output. */
CREATE TABLE bank_reconciliations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id      uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    bank_account_id     uuid NOT NULL,

    period_start        date NOT NULL,
    period_end          date NOT NULL,

    -- Per the bank statement, in paise. Signed: an overdraft is negative.
    opening_balance_paise bigint NOT NULL DEFAULT 0,
    closing_balance_paise bigint NOT NULL DEFAULT 0,

    status              text NOT NULL DEFAULT 'open',

    /* The residue, frozen at finalisation and NULL until then.

       Stored rather than recomputed because that is the difference between a
       reconciliation and a report. A finalised period must answer with the
       numbers it was signed off with, even after a later correction elsewhere
       changes what a fresh computation would say. */
    book_closing_paise      bigint,
    unmatched_bank_count    integer,
    unmatched_bank_paise    bigint,
    unmatched_book_count    integer,
    unmatched_book_paise    bigint,
    difference_paise        bigint,
    -- The full statement as rendered at finalisation, for the auditor who asks
    -- what was on the screen that day.
    snapshot            jsonb NOT NULL DEFAULT '{}'::jsonb,

    notes               text,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    finalised_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    finalised_at        timestamptz,
    -- Reopening is allowed but never silent: who did it and why are columns,
    -- because "the closed period changed" with no name against it is the
    -- finding an auditor writes up.
    reopened_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    reopened_at         timestamptz,
    reopen_reason       text,

    CONSTRAINT bank_reconciliations_period CHECK (period_end >= period_start),
    CONSTRAINT bank_reconciliations_status CHECK (status IN ('open','finalised')),
    CONSTRAINT bank_reconciliations_finalised_is_evidenced
        CHECK (status <> 'finalised' OR (finalised_at IS NOT NULL AND finalised_by IS NOT NULL)),
    CONSTRAINT bank_reconciliations_reopen_is_reasoned
        CHECK (reopened_at IS NULL OR nullif(btrim(reopen_reason), '') IS NOT NULL),

    FOREIGN KEY (bank_account_id, institution_id)
        REFERENCES bank_accounts (id, institution_id) ON DELETE RESTRICT,
    UNIQUE (id, institution_id)
);

/* One reconciliation per account per period.

   Every column here is NOT NULL, so no COALESCE is required — but note the
   shape, because the temptation is to key on (account, period_start) alone and
   let period_end vary. That would let a March 1-31 and a March 1-15 statement
   both exist and both claim to be "March", and the closing balance of one
   becomes the opening of neither. */
CREATE UNIQUE INDEX bank_reconciliations_one_per_period
    ON bank_reconciliations (institution_id, bank_account_id, period_start, period_end);

CREATE INDEX bank_reconciliations_open
    ON bank_reconciliations (institution_id, bank_account_id, period_start DESC)
 WHERE status = 'open';

COMMENT ON TABLE bank_reconciliations IS
    'One bank reconciliation statement: an account, a period, the bank''s opening and closing balance, and — once finalised — the frozen residue. Finalising locks the period''s statement lines against further change.';
COMMENT ON COLUMN bank_reconciliations.difference_paise IS
    'Bank closing minus book closing at finalisation. Zero is a clean reconciliation; non-zero is the residue the notes must explain.';

-- ============================================================== the import run

/* One upload of one CSV.

   Kept even when it inserts nothing. "I imported it and nothing happened" is
   the commonest support call, and the honest answer — 412 rows read, 412
   already present, 0 new — is only available if the run itself is a row. */
CREATE TABLE bank_statement_imports (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    bank_account_id   uuid NOT NULL,

    filename          text NOT NULL,
    -- sha256 of the uploaded bytes. Not unique: a school may legitimately
    -- re-upload a corrected file, and idempotency is enforced per line below,
    -- which is the level at which a duplicate actually hurts.
    file_hash         text NOT NULL,

    rows_read         integer NOT NULL DEFAULT 0,
    rows_inserted     integer NOT NULL DEFAULT 0,
    rows_duplicate    integer NOT NULL DEFAULT 0,
    rows_rejected     integer NOT NULL DEFAULT 0,
    -- Why the rejected rows were rejected, one message per row, so a mis-parse
    -- is diagnosable without the operator re-opening the spreadsheet.
    rejects           jsonb NOT NULL DEFAULT '[]'::jsonb,

    imported_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    imported_at       timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (bank_account_id, institution_id)
        REFERENCES bank_accounts (id, institution_id) ON DELETE CASCADE,
    UNIQUE (id, institution_id)
);

CREATE INDEX bank_statement_imports_recent
    ON bank_statement_imports (institution_id, bank_account_id, imported_at DESC);

-- ========================================================== the statement line

/* One line of the bank's statement, exactly as it arrived and as parsed.

   raw_line is not redundant with the parsed columns. Every bank exports a
   different CSV, half of them with the date as DD-MM-YY and the amount in two
   columns, and the first import from a new bank always parses something wrong.
   Keeping the original text means that is a diagnosis rather than an
   archaeology exercise, and it is the only way to prove after the fact that
   the number in the books is the number the bank sent.

   amount_paise is signed and direction is derived from it, not the other way
   round: a file with separate debit and credit columns, a file with one signed
   column, and a file with a Dr/Cr suffix all have to land in the same shape,
   and the sign is the only representation all three can agree on. */
CREATE TABLE bank_statement_lines (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    bank_account_id   uuid NOT NULL,
    import_id         uuid NOT NULL REFERENCES bank_statement_imports(id) ON DELETE CASCADE,

    -- Which reconciliation this line falls in. Assigned when a period exists
    -- that covers txn_date; NULL for a line imported before its period was
    -- opened, which is normal and must not block the import.
    reconciliation_id uuid,

    txn_date          date NOT NULL,
    value_date        date,
    narration         text NOT NULL DEFAULT '',
    -- The bank's own reference: UTR, cheque number, gateway id. The single
    -- most useful matching key when it is present, which is not always.
    reference_no      text,

    -- Money in is positive, money out is negative. Never zero: a zero-value
    -- statement line is a parse failure wearing a transaction's clothes.
    amount_paise      bigint NOT NULL,
    direction         text GENERATED ALWAYS AS (
        CASE WHEN amount_paise >= 0 THEN 'credit' ELSE 'debit' END
    ) STORED,
    -- The running balance if the file carries one. Nullable: many do not.
    balance_paise     bigint,

    raw_line          text NOT NULL,
    line_no           integer NOT NULL,

    /* The idempotency key. sha256 over the normalised business content of the
       line plus an occurrence ordinal.

       The ordinal is the part that is easy to get wrong. Hash the content
       alone and two genuinely distinct transactions — same day, same amount,
       same narration, which happens constantly with round-figure fee
       collections — collapse into one, and the school is silently short a
       receipt. Include line_no instead and re-importing a file that gained a
       header row shifts every hash, so the whole statement duplicates. The
       ordinal counts identical *preceding* lines within the same file, so it
       is stable under re-import and still distinguishes true duplicates. */
    line_hash         text NOT NULL,

    /* The match. NULL together or set together — a line with a match_id and no
       kind is a dangling pointer nobody can resolve. */
    match_kind        text,
    match_id          uuid,
    -- How it was matched: exact on amount+date+reference, fuzzy and then
    -- confirmed by a person, or entered by hand. Kept because "the computer
    -- matched it" and "Anita matched it" are different levels of evidence.
    match_confidence  text,
    matched_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    matched_at        timestamptz,

    -- A line the accountant has looked at and decided is not a book entry at
    -- all — bank charges, interest credited. Explained rather than matched,
    -- and it leaves the residue once explained.
    explained_as      text,

    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT bank_statement_lines_amount_nonzero CHECK (amount_paise <> 0),
    CONSTRAINT bank_statement_lines_match_paired
        CHECK ((match_kind IS NULL) = (match_id IS NULL)),
    CONSTRAINT bank_statement_lines_match_evidenced
        CHECK (match_kind IS NULL OR (matched_at IS NOT NULL AND match_confidence IS NOT NULL)),
    CONSTRAINT bank_statement_lines_match_kind
        CHECK (match_kind IS NULL OR match_kind IN ('payment','vendor_payment','payout_item','refund')),
    CONSTRAINT bank_statement_lines_confidence
        CHECK (match_confidence IS NULL OR match_confidence IN ('exact','fuzzy','manual')),
    -- Matched or explained, never both: they are two different answers to the
    -- same question and holding both means the residue counts the line twice.
    CONSTRAINT bank_statement_lines_not_both
        CHECK (match_kind IS NULL OR explained_as IS NULL),

    FOREIGN KEY (bank_account_id, institution_id)
        REFERENCES bank_accounts (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (reconciliation_id, institution_id)
        REFERENCES bank_reconciliations (id, institution_id) ON DELETE SET NULL,
    UNIQUE (id, institution_id)
);

/* Import the same statement twice and the second import inserts nothing.

   This index is the entire idempotency guarantee. The handler's ON CONFLICT DO
   NOTHING is what counts the duplicates; this is what makes the count true even
   if two accountants upload the same file at the same moment. */
CREATE UNIQUE INDEX bank_statement_lines_once
    ON bank_statement_lines (institution_id, bank_account_id, line_hash);

/* One book entry may be claimed by exactly one bank line.

   COALESCE on match_id even though the partial predicate already excludes the
   NULL rows. Belt and braces, and deliberately: the predicate and the key are
   edited by different people at different times, and the version of this index
   that loses its WHERE clause and keeps a bare nullable column enforces
   nothing at all while looking correct. This codebase has been bitten six
   times by exactly that.

   Without this, a fuzzy match confirmed twice against the same receipt makes
   the school's collections look doubled and the residue look clean. */
CREATE UNIQUE INDEX bank_statement_lines_one_claim_per_entry
    ON bank_statement_lines (
        institution_id,
        match_kind,
        COALESCE(match_id, '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE match_kind IS NOT NULL;

-- The matching sweep's own query: unmatched lines for one account in date
-- order. Partial, because a reconciled statement is mostly matched and the
-- index only ever has to carry the residue.
CREATE INDEX bank_statement_lines_unmatched
    ON bank_statement_lines (institution_id, bank_account_id, txn_date)
 WHERE match_kind IS NULL AND explained_as IS NULL;

CREATE INDEX bank_statement_lines_period
    ON bank_statement_lines (reconciliation_id) WHERE reconciliation_id IS NOT NULL;

-- Candidate lookup during matching: amount and date are the first two keys of
-- every strategy.
CREATE INDEX bank_statement_lines_amount
    ON bank_statement_lines (institution_id, bank_account_id, amount_paise, txn_date);

COMMENT ON TABLE bank_statement_lines IS
    'One line of an imported bank statement, kept both raw and parsed. match_kind/match_id point at the book entry; a line with neither a match nor an explanation is the bank side of the reconciliation residue.';
COMMENT ON COLUMN bank_statement_lines.line_hash IS
    'sha256 of normalised content plus an occurrence ordinal within the file. Stable under re-import, distinct for genuine same-day duplicates. See internal/api/banking.go statementLineHash.';
COMMENT ON COLUMN bank_statement_lines.raw_line IS
    'The original CSV row verbatim. Kept so a mis-parse is diagnosable and so the parsed figures can be proved against what the bank actually sent.';

-- +goose StatementBegin
/* A finalised period does not change.

   In the database rather than the handler because the handler is not the only
   writer. A psql session, a later import job, and the next agent to touch this
   schema all go straight at the table; any of them could silently alter a
   period an auditor has signed, and the whole reason bank_reconciliations
   exists is to make that impossible rather than merely discouraged.

   Reopening is the supported path — it is a status change on the parent, it
   records who and why, and it is the thing a reviewer can see. */
CREATE OR REPLACE FUNCTION bank_line_period_is_open() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    locked_period uuid;
BEGIN
    -- Both sides: moving a line OUT of a finalised period is as much a change
    -- to that period's statement as moving one in.
    FOR locked_period IN
        SELECT r.id FROM bank_reconciliations r
         WHERE r.id IN (COALESCE(NEW.reconciliation_id, OLD.reconciliation_id),
                        COALESCE(OLD.reconciliation_id, NEW.reconciliation_id))
           AND r.status = 'finalised'
    LOOP
        RAISE EXCEPTION
            'bank reconciliation % is finalised; reopen it before changing its statement lines',
            locked_period
            USING ERRCODE = 'integrity_constraint_violation';
    END LOOP;
    RETURN COALESCE(NEW, OLD);
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER bank_statement_lines_respect_lock
    BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_lines
    FOR EACH ROW EXECUTE FUNCTION bank_line_period_is_open();

-- ================================================================== payouts

/* A batch of outbound payments, prepared here and paid by the bank.

   Maker/checker is the reason this is a table and not a button. The control an
   auditor tests on outbound payments is that the person who assembled the list
   is not the person who released it, and a control enforced only in the UI is
   not a control — so it is a CHECK constraint here, re-asserted in the handler,
   and neither is load-bearing alone.

   provider names how the money is expected to leave. There is exactly one
   implementation today, 'file_export', which produces a CSV for the school to
   upload to its own net-banking portal. A live API provider is a row's worth
   of change and a set of bank credentials this deployment does not have; the
   column exists so that adding it is not a migration, and the status ladder
   stops at 'exported' so that nothing here ever claims a transfer happened. */
CREATE TABLE payout_batches (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    -- The account the money leaves. RESTRICT: an exported batch names an
    -- account that must remain resolvable.
    bank_account_id   uuid NOT NULL,

    batch_no          text NOT NULL,
    purpose           text NOT NULL,
    value_date        date NOT NULL DEFAULT CURRENT_DATE,

    /* draft     — being assembled by the maker
       submitted — maker is done, awaiting a checker
       approved  — a different person released it
       rejected  — a different person refused it, with a reason
       exported  — the bank file has been generated; the money's fate is now
                   the bank's business and this system does not pretend to know
                   it until a statement line matches back
       cancelled — abandoned before approval */
    status            text NOT NULL DEFAULT 'draft',

    provider          text NOT NULL DEFAULT 'file_export',

    created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at        timestamptz NOT NULL DEFAULT now(),
    submitted_at      timestamptz,
    approved_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
    approved_at       timestamptz,
    rejected_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
    rejected_at       timestamptz,
    decision_reason   text,
    exported_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    exported_at       timestamptz,
    notes             text,

    CONSTRAINT payout_batches_purpose
        CHECK (purpose IN ('vendor','salary','refund','scholarship','mixed')),
    CONSTRAINT payout_batches_status
        CHECK (status IN ('draft','submitted','approved','rejected','exported','cancelled')),
    CONSTRAINT payout_batches_provider
        CHECK (provider IN ('file_export')),

    /* The maker may not be the checker. The single most important line in this
       table. */
    CONSTRAINT payout_batches_maker_is_not_checker
        CHECK (approved_by IS NULL OR approved_by <> created_by),
    -- And may not be the one who rejects it either, or "reject and redo"
    -- becomes a way around the control.
    CONSTRAINT payout_batches_maker_is_not_rejecter
        CHECK (rejected_by IS NULL OR rejected_by <> created_by),

    CONSTRAINT payout_batches_approved_is_evidenced
        CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
    CONSTRAINT payout_batches_rejected_is_evidenced
        CHECK (status <> 'rejected'
               OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL
                   AND nullif(btrim(decision_reason), '') IS NOT NULL)),
    -- Exporting requires an approval that already happened. Without this a
    -- handler bug could produce the bank file straight out of draft.
    CONSTRAINT payout_batches_exported_was_approved
        CHECK (status <> 'exported' OR (approved_by IS NOT NULL AND exported_at IS NOT NULL)),
    CONSTRAINT payout_batches_no_present
        CHECK (nullif(btrim(batch_no), '') IS NOT NULL),

    FOREIGN KEY (bank_account_id, institution_id)
        REFERENCES bank_accounts (id, institution_id) ON DELETE RESTRICT,
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX payout_batches_no_once
    ON payout_batches (institution_id, lower(btrim(batch_no)));

CREATE INDEX payout_batches_pending
    ON payout_batches (institution_id, value_date DESC)
 WHERE status IN ('draft','submitted','approved');

COMMENT ON TABLE payout_batches IS
    'An outbound payment batch under maker/checker. created_by assembles, a different approved_by releases — enforced by CHECK here and re-checked in internal/api/banking.go. Status stops at ''exported''; nothing in this schema claims a bank has actually transferred anything.';
COMMENT ON COLUMN payout_batches.provider IS
    'How the money is expected to leave. Only ''file_export'' is implemented — a CSV for the school''s own net-banking upload. A live bank API needs credentials this deployment does not hold.';

/* One beneficiary, one amount.

   The beneficiary's account number and IFSC are copied onto the item rather
   than read through the FK at export time. That looks like denormalisation and
   is deliberate: the file the school uploaded last Tuesday must remain
   explicable next March, and if the vendor changed banks in between, reading
   through would rewrite history. What was paid is what was in the file. */
CREATE TABLE payout_items (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    batch_id          uuid NOT NULL,

    beneficiary_kind  text NOT NULL,
    vendor_id         uuid REFERENCES vendors(id) ON DELETE SET NULL,
    employee_id       uuid REFERENCES employees(id) ON DELETE SET NULL,
    student_id        uuid REFERENCES students(id) ON DELETE SET NULL,

    beneficiary_name  text NOT NULL,
    account_number    text NOT NULL,
    ifsc              text NOT NULL,
    amount_paise      bigint NOT NULL,
    mode              text NOT NULL DEFAULT 'neft',
    narration         text,

    /* What this pays: a vendor bill, a payslip, a refund. Nullable, because a
       school does make an ad-hoc transfer that answers to no document, and
       forcing a fake source id would be worse than admitting it. */
    source_kind       text,
    source_id         uuid,

    status            text NOT NULL DEFAULT 'pending',
    -- The bank's Unique Transaction Reference, typed back in or matched from a
    -- statement line. This is the hook that closes the loop between a payout
    -- and the BRS.
    utr               text,
    failure_reason    text,

    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT payout_items_amount CHECK (amount_paise > 0),
    CONSTRAINT payout_items_ifsc_shape CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
    CONSTRAINT payout_items_number_shape CHECK (account_number ~ '^[A-Za-z0-9]{6,20}$'),
    CONSTRAINT payout_items_name_present CHECK (nullif(btrim(beneficiary_name), '') IS NOT NULL),
    CONSTRAINT payout_items_kind CHECK (beneficiary_kind IN ('vendor','employee','student','other')),
    CONSTRAINT payout_items_mode CHECK (mode IN ('neft','rtgs','imps','upi')),
    CONSTRAINT payout_items_status CHECK (status IN ('pending','exported','paid','failed')),
    CONSTRAINT payout_items_source_kind
        CHECK (source_kind IS NULL OR source_kind IN ('vendor_bill','payslip','refund','manual')),
    CONSTRAINT payout_items_source_paired
        CHECK (source_kind IS NULL OR source_kind = 'manual' OR source_id IS NOT NULL),

    /* The named beneficiary must be the one the kind says it is. Without this
       an item can claim beneficiary_kind 'vendor' while carrying a student_id,
       and the reconciliation back from the statement points at the wrong
       person. */
    CONSTRAINT payout_items_beneficiary_matches_kind CHECK (
        (beneficiary_kind = 'vendor'   AND vendor_id   IS NOT NULL AND employee_id IS NULL AND student_id IS NULL) OR
        (beneficiary_kind = 'employee' AND employee_id IS NOT NULL AND vendor_id   IS NULL AND student_id IS NULL) OR
        (beneficiary_kind = 'student'  AND student_id  IS NOT NULL AND vendor_id   IS NULL AND employee_id IS NULL) OR
        (beneficiary_kind = 'other'    AND vendor_id IS NULL AND employee_id IS NULL AND student_id IS NULL)
    ),
    CONSTRAINT payout_items_failure_is_explained
        CHECK (status <> 'failed' OR nullif(btrim(failure_reason), '') IS NOT NULL),

    FOREIGN KEY (batch_id, institution_id)
        REFERENCES payout_batches (id, institution_id) ON DELETE CASCADE
);

CREATE INDEX payout_items_batch ON payout_items (batch_id);

/* The duplicate-payment control: one live payout per source document.

   The COALESCE is the point. source_id is nullable — an ad-hoc transfer has no
   document — and a bare nullable column in a unique index compares distinct
   against every other NULL, so every ad-hoc row would be unique against every
   other and, far worse, the index would appear to be protecting the rows that
   *do* have a source while actually enforcing nothing the moment somebody
   widens the predicate.

   Scoped to live statuses: a payout that failed at the bank must be re-payable,
   and a cancelled batch's items must not block the corrected one. */
CREATE UNIQUE INDEX payout_items_one_live_per_source
    ON payout_items (
        institution_id,
        source_kind,
        COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE source_kind IS NOT NULL
   AND source_kind <> 'manual'
   AND status IN ('pending','exported','paid');

COMMENT ON TABLE payout_items IS
    'One beneficiary line of a payout batch. Account number and IFSC are copied, not referenced, so an exported file stays explicable after the beneficiary changes banks.';

-- ================================================= the student bank register

/* A student's bank account, for DBT scholarship credits and refunds.

   Sensitive under the DPDP Act and treated as such. Three rules, and none of
   them live only in the UI:

     the list never carries the full number — the API masks it server-side, so
     a screen that forgot to mask has nothing to leak,
     revealing it requires finance.export, checked by middleware,
     every reveal is written to audit_log by hand, naming the student and the
     last four digits only, so the audit trail is not itself a copy of the
     thing being protected.

   guardian_id is here because a minor's scholarship is very often credited to
   a parent's account. Modelling that as "the student's account, held by
   somebody else" is what the DBT portal actually asks for, and pretending the
   child holds it would put the wrong name on the transfer. */
CREATE TABLE student_bank_accounts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id      uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    student_id          uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,

    -- Whose account it actually is. NULL means the child's own.
    guardian_id         uuid REFERENCES guardians(id) ON DELETE SET NULL,
    account_holder_name text NOT NULL,
    relationship        text NOT NULL DEFAULT 'self',

    bank_name           text NOT NULL,
    branch              text,
    account_number      text NOT NULL,
    ifsc                text NOT NULL,
    account_type        text NOT NULL DEFAULT 'savings',

    /* DBT will not credit an account that is not Aadhaar-seeded, and the
       school finds out by the transfer failing weeks later. Recording what the
       family told us lets the register warn beforehand — it is a claim, not a
       verification, and the column name says so. */
    is_aadhaar_seeded   boolean NOT NULL DEFAULT false,
    dbt_consent_on      date,

    is_primary          boolean NOT NULL DEFAULT false,
    is_active           boolean NOT NULL DEFAULT true,

    -- Somebody checked this against a passbook or a cancelled cheque.
    verified_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    verified_at         timestamptz,

    notes               text,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT student_bank_accounts_ifsc_shape
        CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
    CONSTRAINT student_bank_accounts_number_shape
        CHECK (account_number ~ '^[A-Za-z0-9]{6,20}$'),
    CONSTRAINT student_bank_accounts_holder_present
        CHECK (nullif(btrim(account_holder_name), '') IS NOT NULL),
    CONSTRAINT student_bank_accounts_bank_present
        CHECK (nullif(btrim(bank_name), '') IS NOT NULL),
    CONSTRAINT student_bank_accounts_type
        CHECK (account_type IN ('savings','current','pmjdy')),
    CONSTRAINT student_bank_accounts_relationship
        CHECK (relationship IN ('self','father','mother','guardian','other')),
    -- 'self' means the child's own account and must not name a guardian; any
    -- other relationship must. Otherwise the register cannot answer whose
    -- account a transfer is going to, which is the one question DBT asks.
    CONSTRAINT student_bank_accounts_holder_matches_relationship
        CHECK ((relationship = 'self') = (guardian_id IS NULL)),
    CONSTRAINT student_bank_accounts_verified_is_evidenced
        CHECK (verified_at IS NULL OR verified_by IS NOT NULL),
    -- An inactive account cannot be the primary one. Without this, deactivating
    -- the primary leaves a student with a primary account nobody may use, and
    -- the payout builder picks it anyway.
    CONSTRAINT student_bank_accounts_primary_is_active
        CHECK (NOT is_primary OR is_active),

    UNIQUE (id, institution_id)
);

/* Exactly one primary account per student.

   A partial unique index on two NOT NULL columns, which is the correct shape
   and needs no COALESCE — stated explicitly because the tempting alternative
   does. Modelling "primary" as a nullable rank or a nullable primary_account_id
   and keying on it would put a NULL inside the unique index, every NULL would
   compare distinct from every other, and a student would quietly accumulate
   four primary accounts with the constraint reporting success. That is the trap
   this schema has fallen into six times; it is avoided here by making the
   column a NOT NULL boolean and pushing the nullability into the predicate,
   where it cannot silently disable anything.

   Where a genuinely nullable column does appear in a key in this file —
   payout_items.source_id and bank_statement_lines.match_id — it is COALESCEd. */
CREATE UNIQUE INDEX student_bank_accounts_one_primary
    ON student_bank_accounts (institution_id, student_id)
 WHERE is_primary;

/* The same account registered twice for one child.

   guardian_id is nullable and part of the identity of the row, so it is
   COALESCEd: without it, one NULL guardian never equals another and the same
   self-held account could be entered any number of times. */
CREATE UNIQUE INDEX student_bank_accounts_no_duplicate
    ON student_bank_accounts (
        institution_id,
        student_id,
        upper(btrim(account_number)),
        upper(btrim(ifsc)),
        COALESCE(guardian_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX student_bank_accounts_by_student
    ON student_bank_accounts (institution_id, student_id) WHERE is_active;

COMMENT ON TABLE student_bank_accounts IS
    'Student (or guardian-held) bank accounts for DBT scholarship credits and fee refunds. Sensitive PII: the API masks account_number in every list, full reveal requires finance.export and writes an audit_log row. See internal/api/banking.go.';
COMMENT ON COLUMN student_bank_accounts.is_aadhaar_seeded IS
    'What the family told us about Aadhaar seeding. A claim used to warn before a DBT run, not a verification — DBT itself is the only authority.';

-- =========================================================== RLS, then grants

ALTER TABLE bank_accounts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts            FORCE  ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliations     FORCE  ROW LEVEL SECURITY;
ALTER TABLE bank_statement_imports   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_imports   FORCE  ROW LEVEL SECURITY;
ALTER TABLE bank_statement_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_lines     FORCE  ROW LEVEL SECURITY;
ALTER TABLE payout_batches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_batches           FORCE  ROW LEVEL SECURITY;
ALTER TABLE payout_items             ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_items             FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_bank_accounts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_bank_accounts    FORCE  ROW LEVEL SECURITY;

CREATE POLICY bank_accounts_tenant ON bank_accounts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY bank_reconciliations_tenant ON bank_reconciliations
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY bank_statement_imports_tenant ON bank_statement_imports
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY bank_statement_lines_tenant ON bank_statement_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY payout_batches_tenant ON payout_batches
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY payout_items_tenant ON payout_items
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

CREATE POLICY student_bank_accounts_tenant ON student_bank_accounts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- 00042 sets ALTER DEFAULT PRIVILEGES so tables created after it are covered
-- whichever role creates them. Stated explicitly anyway: a database restored
-- from a dump taken before that migration has the default privileges but not
-- necessarily the role that created these tables, and an ungranted table is a
-- login that fails with a message pointing at the wrong thing entirely.
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_accounts          TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_reconciliations   TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_statement_imports TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_statement_lines   TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON payout_batches         TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON payout_items           TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_bank_accounts  TO app_user;

-- +goose Down
DROP TRIGGER IF EXISTS bank_statement_lines_respect_lock ON bank_statement_lines;
DROP FUNCTION IF EXISTS bank_line_period_is_open();
DROP TABLE IF EXISTS student_bank_accounts;
DROP TABLE IF EXISTS payout_items;
DROP TABLE IF EXISTS payout_batches;
DROP TABLE IF EXISTS bank_statement_lines;
DROP TABLE IF EXISTS bank_statement_imports;
DROP TABLE IF EXISTS bank_reconciliations;
DROP TABLE IF EXISTS bank_accounts;
