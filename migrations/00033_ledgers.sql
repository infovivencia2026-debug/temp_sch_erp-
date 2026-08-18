-- +goose Up
-- The books: a chart of accounts, double-entry vouchers, and the reports an
-- auditor asks for.
--
-- The product could take a fee and print a receipt. What it could not do was
-- say what the school earned, what it owes, or what it is worth — because
-- money had nowhere to land beyond the fee tables. A trustee asking "did we
-- run a surplus" got an answer assembled by hand in a spreadsheet.
--
-- Two rules run through everything below, and both are enforced by the
-- database rather than by a handler that can be bypassed:
--
--   1. Every voucher balances. Debits equal credits, always, checked at
--      COMMIT. A trial balance that does not balance is worse than no trial
--      balance at all, because somebody will believe it.
--   2. A closed year is closed. Once the books for 2025-26 are signed, no
--      entry dated in that year can be inserted, amended or deleted — and the
--      close itself cannot be undone. Not a boolean nobody checks: a trigger
--      that refuses the write.
--
-- Money is bigint paise throughout. There is not a numeric rupee anywhere in
-- this file, and there must never be: a balance sheet that fails to tie by one
-- paise is a week of somebody's life.

-- ---------------------------------------------------------------- settings

/* One row per school: the accounts the automatic postings use, and the two
   policy numbers that are not accounting law.

   Columns rather than a settings blob, for the same reason payroll_settings is
   — an auditor reads these and a clerk edits them, and a jsonb field nobody
   can constrain is where a wrong control account hides for a year. */
CREATE TABLE ledger_settings (
    institution_id  uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,

    -- Control accounts. Nullable because a school that has not finished its
    -- chart of accounts should still be able to open the screen; the posting
    -- endpoints refuse rather than guessing when one of these is unset.
    cash_account_id         uuid,
    bank_account_id         uuid,
    petty_cash_account_id   uuid,
    fee_receivable_account_id uuid,
    fee_income_account_id   uuid,
    payable_account_id      uuid,
    depreciation_expense_account_id uuid,
    accumulated_depreciation_account_id uuid,
    surplus_account_id      uuid,

    -- Above this, a petty cash voucher needs a second signature. School
    -- policy, not law, which is exactly why it is a column and not a constant.
    petty_cash_limit_paise  bigint NOT NULL DEFAULT 200000,

    -- What a new asset gets if nobody says otherwise. Per-asset choice still
    -- wins; see fixed_assets.method for why both exist.
    default_depreciation_method text NOT NULL DEFAULT 'straight_line',

    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ledger_settings_method
        CHECK (default_depreciation_method IN ('straight_line','wdv')),
    CONSTRAINT ledger_settings_petty_limit CHECK (petty_cash_limit_paise >= 0)
);

-- --------------------------------------------------------- chart of accounts

/* The chart of accounts.

   A tree: groups hold other accounts and cannot themselves be posted to, leaves
   take the entries. The distinction is enforced below by a trigger, because a
   journal line against "Assets" instead of "Cash in Hand" is the mistake that
   makes a balance sheet useless while still balancing perfectly.

   normal_side is generated rather than stored by hand. Asset and expense
   accounts increase on the debit side; liability, income and corpus accounts
   increase on the credit. Letting a clerk set that per account would invite a
   chart where half the balances report with the wrong sign. */
CREATE TABLE ledger_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    code            text NOT NULL,
    name            text NOT NULL,
    type            text NOT NULL,
    parent_id       uuid REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
    is_group        boolean NOT NULL DEFAULT false,

    -- Marks the accounts a cashbook is drawn from. A report that had to guess
    -- which accounts are cash from their names would be wrong the first time
    -- somebody opened a second bank account.
    is_cash         boolean NOT NULL DEFAULT false,

    -- Accumulated depreciation sits under Assets but carries a credit balance.
    -- Without this flag it reports as a negative asset and every reader asks
    -- the same question.
    is_contra       boolean NOT NULL DEFAULT false,

    normal_side     text GENERATED ALWAYS AS (
        CASE WHEN type IN ('asset','expense') THEN 'debit' ELSE 'credit' END
    ) STORED,

    is_active       boolean NOT NULL DEFAULT true,
    -- Seeded rows are the standard chart. A school may rename or deactivate
    -- them but not delete them, because the control accounts in
    -- ledger_settings point here and a dangling control account is a posting
    -- that fails at the counter.
    is_system       boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ledger_accounts_type
        CHECK (type IN ('asset','liability','income','expense','equity')),
    CONSTRAINT ledger_accounts_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
    -- A group holds accounts; it does not hold cash.
    CONSTRAINT ledger_accounts_group_not_cash CHECK (NOT (is_group AND is_cash)),
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX ledger_accounts_code ON ledger_accounts (institution_id, code);

/* Two accounts under the same parent may not share a name.

   parent_id is nullable, and a NULL inside a UNIQUE index silently disables
   it — every root account would compare distinct from every other and the
   constraint would enforce nothing at all. COALESCE to the nil uuid gives the
   roots a value to collide on. */
CREATE UNIQUE INDEX ledger_accounts_sibling_name ON ledger_accounts
    (institution_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE INDEX ledger_accounts_parent ON ledger_accounts (institution_id, parent_id);

-- ------------------------------------------------------------ the year

/* The accounting year, April to March.

   Held as its starting year: 2026 means April 2026 to March 2027. Every date
   arithmetic bug in Indian financial software is a January-to-March date filed
   under the wrong year, so the rule is written once, here and in the generated
   column on journal_entries, and never restated in a handler. */
CREATE TABLE accounting_years (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    fy_start_year   integer NOT NULL,
    status          text NOT NULL DEFAULT 'open',
    closed_on       date,
    closed_by       uuid REFERENCES users(id) ON DELETE SET NULL,

    -- The entry that swept income and expenditure into the corpus. Kept so the
    -- close can be explained rather than merely asserted.
    closing_entry_id uuid,
    -- What the close computed, frozen. Recomputing it later would quietly
    -- change history the moment anybody corrected a prior-year figure.
    surplus_paise   bigint,

    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT accounting_years_status CHECK (status IN ('open','closed')),
    CONSTRAINT accounting_years_closed_is_evidenced
        CHECK (status <> 'closed' OR (closed_on IS NOT NULL AND surplus_paise IS NOT NULL)),
    CONSTRAINT accounting_years_sane CHECK (fy_start_year BETWEEN 1950 AND 2200),
    UNIQUE (institution_id, fy_start_year)
);

-- --------------------------------------------------------------- vouchers

/* A voucher: one balanced accounting event.

   source_kind and source_id are how a business fact — a fee receipt, a payroll
   run, a vendor bill — is tied to the entry that recorded it. The unique index
   below is the guard that matters: posting the same receipt twice is refused
   by the database, so a retried request, a double-clicked button or a rerun
   sweep cannot double-count revenue. */
CREATE TABLE journal_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    voucher_no      text NOT NULL,
    voucher_type    text NOT NULL DEFAULT 'journal',
    entry_date      date NOT NULL DEFAULT CURRENT_DATE,

    /* The Indian financial year this entry falls in, derived rather than
       supplied. A handler that computed this itself would eventually compute
       it differently from the year-closing query, and the two would disagree
       about a February entry — which is precisely the entry nobody checks. */
    fy_start_year   integer GENERATED ALWAYS AS (
        CASE WHEN extract(month FROM entry_date) < 4
             THEN extract(year FROM entry_date)::integer - 1
             ELSE extract(year FROM entry_date)::integer END
    ) STORED,

    -- An entry nobody can read six months later is an entry an auditor
    -- qualifies. Blank narrations are refused rather than defaulted.
    narration       text NOT NULL,
    source_kind     text,
    source_id       uuid,

    posted_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    posted_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT journal_entries_type CHECK (voucher_type IN
        ('journal','receipt','payment','contra','purchase','sales',
         'depreciation','opening','closing')),
    CONSTRAINT journal_entries_narration CHECK (nullif(btrim(narration), '') IS NOT NULL),
    -- Half a source reference is worse than none: it looks like a link.
    CONSTRAINT journal_entries_source_paired
        CHECK ((source_kind IS NULL) = (source_id IS NULL)),
    UNIQUE (institution_id, voucher_no),
    UNIQUE (id, institution_id)
);

/* One business event, one voucher.

   This is the whole defence against double-counted revenue. The fee tables are
   live and already authoritative for what a family owes; when the integration
   lead decides fees should post, this index is what makes the sweep safe to
   run twice. */
CREATE UNIQUE INDEX journal_entries_one_per_source ON journal_entries
    (institution_id, source_kind, source_id) WHERE source_id IS NOT NULL;

CREATE INDEX journal_entries_by_date ON journal_entries (institution_id, entry_date);
CREATE INDEX journal_entries_by_year ON journal_entries (institution_id, fy_start_year);

/* A line of a voucher.

   Debit and credit are separate columns rather than one signed amount. A
   signed column makes "which side is this" a convention every reader has to
   remember, and makes the balance check a sum-to-zero that a single flipped
   sign satisfies by accident. Two columns, one of which must be zero, cannot
   be misread. */
CREATE TABLE journal_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    entry_id        uuid NOT NULL,
    account_id      uuid NOT NULL,
    line_no         integer NOT NULL DEFAULT 1,
    debit_paise     bigint NOT NULL DEFAULT 0,
    credit_paise    bigint NOT NULL DEFAULT 0,
    memo            text,

    CONSTRAINT journal_lines_non_negative
        CHECK (debit_paise >= 0 AND credit_paise >= 0),
    -- One side only. A line carrying both is an unresolved argument about what
    -- happened, and it makes the account's own total meaningless.
    CONSTRAINT journal_lines_one_side
        CHECK (debit_paise = 0 OR credit_paise = 0),
    -- A zero line contributes nothing and hides a mistake behind a balanced
    -- total.
    CONSTRAINT journal_lines_not_empty
        CHECK (debit_paise + credit_paise > 0),

    /* Composite foreign keys, so a line can never be attached to another
       tenant's voucher or another tenant's account. RLS stops a caller reading
       across tenants; it does not stop them writing a valid-looking uuid they
       guessed. */
    FOREIGN KEY (entry_id, institution_id)
        REFERENCES journal_entries (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE RESTRICT
);

CREATE INDEX journal_lines_entry ON journal_lines (entry_id);
CREATE INDEX journal_lines_account ON journal_lines (institution_id, account_id);

-- +goose StatementBegin
/* Double entry, enforced at COMMIT.

   This is the single most important object in the file.

   It has to be a DEFERRABLE INITIALLY DEFERRED constraint trigger rather than a
   CHECK or an immediate trigger, because a voucher is written one line at a
   time: after the first INSERT the debits and credits necessarily differ, and
   an immediate check would reject every entry ever made. Deferring to commit
   asks the only question worth asking — is the voucher balanced by the time
   the transaction claims it is done.

   A handler-side check would not do. Handlers are not the only writer: a psql
   session, a future import job and the next agent to touch this schema all go
   straight at the tables, and any of them could leave the books unbalanced
   with nothing to stop it.

   Two lines minimum, not one. A single-line "entry" balancing at zero is
   impossible given journal_lines_not_empty, but an entry with one line and a
   matching contra elsewhere is the shape somebody reaches for when they are
   about to make a mess. */
CREATE OR REPLACE FUNCTION journal_must_balance() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    target uuid;
    dr bigint;
    cr bigint;
    n  integer;
BEGIN
    IF TG_TABLE_NAME = 'journal_entries' THEN
        target := COALESCE(NEW.id, OLD.id);
    ELSE
        target := COALESCE(NEW.entry_id, OLD.entry_id);
    END IF;

    /* The voucher may have been deleted in this same transaction — a cascade
       that took the header and its lines together leaves nothing to check. An
       exception here would make deleting a draft impossible. */
    IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = target) THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(sum(debit_paise), 0), COALESCE(sum(credit_paise), 0), count(*)
      INTO dr, cr, n
      FROM journal_lines WHERE entry_id = target;

    IF n < 2 THEN
        RAISE EXCEPTION
            'voucher % has % line(s): double entry needs at least two', target, n
            USING ERRCODE = 'check_violation';
    END IF;

    IF dr <> cr THEN
        RAISE EXCEPTION
            'voucher % is out of balance: debits % paise, credits % paise (difference %)',
            target, dr, cr, dr - cr
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END $$;
-- +goose StatementEnd

-- Fires on the lines, so adding, amending or removing one re-checks the whole
-- voucher.
CREATE CONSTRAINT TRIGGER journal_lines_balance
    AFTER INSERT OR UPDATE OR DELETE ON journal_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION journal_must_balance();

-- And on the header, because a voucher inserted with no lines at all touches
-- journal_lines never and would otherwise sail through.
CREATE CONSTRAINT TRIGGER journal_entries_balance
    AFTER INSERT OR UPDATE ON journal_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION journal_must_balance();

-- +goose StatementBegin
/* Groups do not take postings.

   Immediate rather than deferred: this is a property of the single line being
   written, so failing at the moment of the mistake gives a far better error
   than failing at commit with the whole voucher named. */
CREATE OR REPLACE FUNCTION journal_line_account_is_postable() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    acc record;
BEGIN
    SELECT code, name, is_group, is_active INTO acc
      FROM ledger_accounts WHERE id = NEW.account_id;

    IF acc.is_group THEN
        RAISE EXCEPTION
            'account %  % is a group heading: post to one of its accounts instead',
            acc.code, acc.name
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT acc.is_active THEN
        RAISE EXCEPTION 'account %  % is closed to posting', acc.code, acc.name
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER journal_lines_postable
    BEFORE INSERT OR UPDATE ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION journal_line_account_is_postable();

-- +goose StatementBegin
/* A closed year does not move.

   The point of a year-end close is that the figures reported to a trust board,
   an auditor and the Income Tax department stay the figures that were
   reported. A status column that only the closing handler consults is not a
   close; it is a note. This trigger is the close.

   Corrections to a closed year go where they go in real accounting: a dated
   entry in the current year, visible as such. */
CREATE OR REPLACE FUNCTION journal_year_must_be_open() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    inst uuid;
    fy   integer;
BEGIN
    IF TG_TABLE_NAME = 'journal_entries' THEN
        inst := COALESCE(NEW.institution_id, OLD.institution_id);
        fy   := COALESCE(NEW.fy_start_year, OLD.fy_start_year);
    ELSE
        SELECT e.institution_id, e.fy_start_year INTO inst, fy
          FROM journal_entries e
         WHERE e.id = COALESCE(NEW.entry_id, OLD.entry_id);
        -- The parent voucher is already gone: a cascade is tidying up behind a
        -- delete that was itself allowed, so there is nothing to defend.
        IF NOT FOUND THEN
            RETURN COALESCE(NEW, OLD);
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM accounting_years y
                WHERE y.institution_id = inst
                  AND y.fy_start_year = fy
                  AND y.status = 'closed') THEN
        RAISE EXCEPTION
            'the books for %-% are closed: post the correction in the current year',
            fy, substr((fy + 1)::text, 3, 2)
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN COALESCE(NEW, OLD);
END $$;
-- +goose StatementEnd

CREATE TRIGGER journal_entries_year_open
    BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION journal_year_must_be_open();

CREATE TRIGGER journal_lines_year_open
    BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION journal_year_must_be_open();

-- +goose StatementBegin
/* A close cannot be undone.

   "Irreversible in effect but auditable" is the requirement, and a reopen
   endpoint that nobody guards is how a closed year quietly becomes an open
   one. There is no reopen: the row may only travel from open to closed, and a
   closed year cannot be deleted either.

   The audit trail is what survives instead — closed_on, closed_by, the frozen
   surplus, and the closing voucher itself, which is a permanent, readable
   entry in the books rather than a flag. */
CREATE OR REPLACE FUNCTION accounting_year_close_is_final() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'closed' THEN
            RAISE EXCEPTION 'the closed year %-% cannot be deleted',
                OLD.fy_start_year, substr((OLD.fy_start_year + 1)::text, 3, 2)
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status = 'closed' THEN
        IF NEW.status <> 'closed' THEN
            RAISE EXCEPTION
                'the books for %-% are closed and cannot be reopened',
                OLD.fy_start_year, substr((OLD.fy_start_year + 1)::text, 3, 2)
                USING ERRCODE = 'check_violation';
        END IF;
        -- Closed means closed, including the evidence of the close.
        IF NEW.surplus_paise IS DISTINCT FROM OLD.surplus_paise
           OR NEW.closing_entry_id IS DISTINCT FROM OLD.closing_entry_id
           OR NEW.closed_on IS DISTINCT FROM OLD.closed_on
           OR NEW.fy_start_year IS DISTINCT FROM OLD.fy_start_year THEN
            RAISE EXCEPTION 'the record of the %-% close cannot be amended',
                OLD.fy_start_year, substr((OLD.fy_start_year + 1)::text, 3, 2)
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER accounting_years_final
    BEFORE UPDATE OR DELETE ON accounting_years
    FOR EACH ROW EXECUTE FUNCTION accounting_year_close_is_final();

-- ---------------------------------------------------------------- payables

/* The vendor directory.

   Separate from contractor_bills, which is a different problem: that table
   verifies how many guards actually turned up. This one is the ordinary
   creditor ledger — the stationer, the electrician, the bus mechanic. */
CREATE TABLE vendors (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    code            text NOT NULL,
    name            text NOT NULL,
    contact_person  text,
    phone           text,
    email           text,
    address         text,
    -- Fifteen characters, state code first. Stored uppercase because a lower
    -- case GSTIN fails a GSTR filing and nobody finds out until it does.
    gstin           text,
    pan             text,
    bank_account    text,
    bank_ifsc       text,
    -- Net terms, in days from the bill date. Drives the ageing on the payables
    -- screen when a bill carries no explicit due date.
    payment_terms_days integer NOT NULL DEFAULT 30,
    category        text,
    is_active       boolean NOT NULL DEFAULT true,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendors_name CHECK (nullif(btrim(name), '') IS NOT NULL),
    CONSTRAINT vendors_terms CHECK (payment_terms_days BETWEEN 0 AND 365),
    CONSTRAINT vendors_gstin_shape
        CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'),
    CONSTRAINT vendors_pan_shape
        CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX vendors_code ON vendors (institution_id, code);
CREATE UNIQUE INDEX vendors_name_unique ON vendors (institution_id, lower(btrim(name)));

/* A purchase bill.

   What has been paid against it is deliberately *not* a column here. A stored
   paid figure and a payment history that disagree is an argument nobody can
   settle, and the disagreement always surfaces in front of the vendor. The
   outstanding amount is summed from vendor_payments wherever it is needed.

   status therefore covers only what a human decides — whether the bill has
   been approved for payment — and never what the arithmetic already knows. */
CREATE TABLE vendor_bills (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    vendor_id       uuid NOT NULL,
    bill_no         text NOT NULL,
    bill_date       date NOT NULL DEFAULT CURRENT_DATE,
    due_on          date,

    -- The expense head this bill lands in. Required: a payable with no
    -- expenditure account cannot be posted, and a bill entered now and
    -- classified later is a bill classified never.
    expense_account_id uuid NOT NULL,

    taxable_paise   bigint NOT NULL DEFAULT 0,
    tax_paise       bigint NOT NULL DEFAULT 0,
    total_paise     bigint GENERATED ALWAYS AS (taxable_paise + tax_paise) STORED,

    status          text NOT NULL DEFAULT 'draft',
    approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at     timestamptz,
    journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    file_id         uuid REFERENCES files(id) ON DELETE SET NULL,
    narration       text,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendor_bills_status CHECK (status IN ('draft','approved','cancelled')),
    CONSTRAINT vendor_bills_amounts
        CHECK (taxable_paise >= 0 AND tax_paise >= 0 AND taxable_paise + tax_paise > 0),
    CONSTRAINT vendor_bills_due_after_bill CHECK (due_on IS NULL OR due_on >= bill_date),
    CONSTRAINT vendor_bills_approved_is_evidenced
        CHECK (status <> 'approved' OR approved_at IS NOT NULL),
    FOREIGN KEY (vendor_id, institution_id) REFERENCES vendors (id, institution_id) ON DELETE RESTRICT,
    FOREIGN KEY (expense_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE RESTRICT,
    UNIQUE (id, institution_id)
);

-- The same vendor cannot bill the same number twice. This is the duplicate
-- payment control an auditor tests first.
CREATE UNIQUE INDEX vendor_bills_no_per_vendor
    ON vendor_bills (institution_id, vendor_id, lower(btrim(bill_no)));
CREATE INDEX vendor_bills_due ON vendor_bills (institution_id, due_on);

/* Money actually paid to a vendor. */
CREATE TABLE vendor_payments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    bill_id         uuid NOT NULL,
    voucher_no      text NOT NULL,
    paid_on         date NOT NULL DEFAULT CURRENT_DATE,
    amount_paise    bigint NOT NULL,
    mode            text NOT NULL DEFAULT 'neft',
    reference_no    text,
    -- Which cash or bank account the money left.
    paid_from_account_id uuid NOT NULL,
    -- Tax deducted at source on this payment, withheld rather than paid. Held
    -- separately because it is a liability to the government, not a payment to
    -- the vendor, and the vendor's account must be relieved of the gross.
    tds_paise       bigint NOT NULL DEFAULT 0,
    journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    remarks         text,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vendor_payments_amount CHECK (amount_paise > 0),
    CONSTRAINT vendor_payments_tds CHECK (tds_paise >= 0 AND tds_paise < amount_paise),
    CONSTRAINT vendor_payments_mode
        CHECK (mode IN ('cash','cheque','dd','neft','rtgs','upi','card','adjustment')),
    CONSTRAINT vendor_payments_instrument_identified
        CHECK (mode NOT IN ('cheque','dd') OR nullif(btrim(reference_no), '') IS NOT NULL),
    FOREIGN KEY (bill_id, institution_id) REFERENCES vendor_bills (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (paid_from_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX vendor_payments_voucher ON vendor_payments (institution_id, voucher_no);
CREATE INDEX vendor_payments_bill ON vendor_payments (bill_id);

-- +goose StatementBegin
/* A bill cannot be overpaid.

   Enforced here rather than in the handler because overpayment is the failure
   that does not announce itself: the vendor keeps the money, the payable goes
   negative, and the balance sheet still balances. Only a check at the moment
   of payment catches it. */
CREATE OR REPLACE FUNCTION vendor_payment_within_bill() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    total bigint;
    paid  bigint;
    st    text;
BEGIN
    SELECT b.total_paise, b.status INTO total, st
      FROM vendor_bills b WHERE b.id = NEW.bill_id;

    IF st <> 'approved' THEN
        RAISE EXCEPTION 'bill is % — approve it before paying', st
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(sum(amount_paise), 0) INTO paid
      FROM vendor_payments
     WHERE bill_id = NEW.bill_id AND id <> NEW.id;

    IF paid + NEW.amount_paise > total THEN
        RAISE EXCEPTION
            'paying % paise would overpay the bill: total %, already paid %',
            NEW.amount_paise, total, paid
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER vendor_payments_within_bill
    BEFORE INSERT OR UPDATE ON vendor_payments
    FOR EACH ROW EXECUTE FUNCTION vendor_payment_within_bill();

/* Petty cash.

   Small amounts, paid from the tin, against a paper slip. The whole control is
   that the slip exists and that anything above the school's limit was signed
   by a second person — so approved_by is required above the limit and the
   check that enforces it reads the limit from settings at approval time. */
CREATE TABLE petty_cash_vouchers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    voucher_no      text NOT NULL,
    voucher_date    date NOT NULL DEFAULT CURRENT_DATE,
    payee           text NOT NULL,
    particulars     text NOT NULL,
    amount_paise    bigint NOT NULL,
    expense_account_id uuid NOT NULL,
    paid_from_account_id uuid NOT NULL,
    status          text NOT NULL DEFAULT 'pending',
    approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at     timestamptz,
    rejected_reason text,
    file_id         uuid REFERENCES files(id) ON DELETE SET NULL,
    journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT petty_cash_amount CHECK (amount_paise > 0),
    CONSTRAINT petty_cash_status CHECK (status IN ('pending','approved','rejected')),
    CONSTRAINT petty_cash_payee CHECK (nullif(btrim(payee), '') IS NOT NULL),
    CONSTRAINT petty_cash_particulars CHECK (nullif(btrim(particulars), '') IS NOT NULL),
    CONSTRAINT petty_cash_approved_is_evidenced
        CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
    -- Refusing a claim without saying why is how a school ends up having the
    -- same argument twice.
    CONSTRAINT petty_cash_rejected_has_reason
        CHECK (status <> 'rejected' OR nullif(btrim(rejected_reason), '') IS NOT NULL),
    FOREIGN KEY (expense_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE RESTRICT,
    FOREIGN KEY (paid_from_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX petty_cash_voucher_no ON petty_cash_vouchers (institution_id, voucher_no);
CREATE INDEX petty_cash_by_date ON petty_cash_vouchers (institution_id, voucher_date);

-- ------------------------------------------------------- fixed assets

/* The fixed asset register.

   Both depreciation methods are implemented, and the choice is stored per
   asset rather than picked once for the product. That is not indecision — an
   Indian school genuinely needs both, and a register that offers one is a
   register that has to be redone by hand every year:

     * Straight line is what the trust's own income and expenditure account and
       balance sheet use. It spreads cost less salvage evenly across useful
       life, which is what the Companies Act schedule and every auditor's
       working paper assume.

     * Written-down value is what the Income Tax Act mandates, at prescribed
       rates on the opening WDV, and it is the figure that goes on the return.
       A school computing tax depreciation on a straight line is filing a wrong
       number.

   The two legitimately disagree, permanently, and that difference is a real
   thing an accountant reconciles rather than a bug to be flattened. Storing
   the method on the asset is what lets one register answer both questions.

   Depreciation is charged annually, not monthly. Schools close their books
   once a year and the statutory rates are annual; a monthly charge would only
   invent twelve chances to round differently. */
CREATE TABLE fixed_assets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    tag_no          text NOT NULL,
    name            text NOT NULL,
    category        text NOT NULL DEFAULT 'equipment',
    -- Where the cost sits on the balance sheet.
    asset_account_id uuid NOT NULL,

    purchased_on    date NOT NULL,
    cost_paise      bigint NOT NULL,
    -- What it is expected to fetch at the end. Straight line spreads cost less
    -- salvage; WDV ignores it, which is one of the several ways the two differ.
    salvage_paise   bigint NOT NULL DEFAULT 0,
    useful_life_years integer,
    method          text NOT NULL DEFAULT 'straight_line',
    -- The prescribed annual rate, for WDV assets. Per cent, so 15.00 not 0.15.
    wdv_rate_percent numeric(5,2),

    location        text,
    vendor_id       uuid,
    invoice_ref     text,
    quantity        integer NOT NULL DEFAULT 1,

    status          text NOT NULL DEFAULT 'in_use',
    disposed_on     date,
    disposal_paise  bigint,
    disposal_note   text,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fixed_assets_method CHECK (method IN ('straight_line','wdv')),
    CONSTRAINT fixed_assets_status CHECK (status IN ('in_use','disposed','written_off')),
    CONSTRAINT fixed_assets_cost CHECK (cost_paise > 0),
    CONSTRAINT fixed_assets_salvage CHECK (salvage_paise >= 0 AND salvage_paise < cost_paise),
    CONSTRAINT fixed_assets_quantity CHECK (quantity > 0),
    -- Each method needs its own input, and neither can be guessed from the
    -- other. An asset with no life and no rate cannot be depreciated at all,
    -- and would sit in the register at cost for ever without anybody noticing.
    CONSTRAINT fixed_assets_method_has_its_input CHECK (
        (method = 'straight_line' AND useful_life_years IS NOT NULL AND useful_life_years > 0)
        OR (method = 'wdv' AND wdv_rate_percent IS NOT NULL
            AND wdv_rate_percent > 0 AND wdv_rate_percent <= 100)),
    CONSTRAINT fixed_assets_disposal_is_dated
        CHECK (status = 'in_use' OR disposed_on IS NOT NULL),
    CONSTRAINT fixed_assets_disposal_after_purchase
        CHECK (disposed_on IS NULL OR disposed_on >= purchased_on),
    FOREIGN KEY (asset_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE RESTRICT,
    FOREIGN KEY (vendor_id, institution_id) REFERENCES vendors (id, institution_id) ON DELETE SET NULL,
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX fixed_assets_tag ON fixed_assets (institution_id, tag_no);
CREATE INDEX fixed_assets_category ON fixed_assets (institution_id, category);

/* One year's depreciation on one asset.

   The unique index is the control. Running the depreciation sweep twice in a
   year is the obvious operator error, and without this it would silently
   halve the book value of every asset the school owns. */
CREATE TABLE depreciation_charges (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    asset_id        uuid NOT NULL,
    fy_start_year   integer NOT NULL,
    method          text NOT NULL,
    opening_wdv_paise bigint NOT NULL,
    charge_paise    bigint NOT NULL,
    closing_wdv_paise bigint NOT NULL,
    journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT depreciation_charges_method CHECK (method IN ('straight_line','wdv')),
    CONSTRAINT depreciation_charges_amounts
        CHECK (charge_paise >= 0 AND opening_wdv_paise >= 0 AND closing_wdv_paise >= 0),
    -- The arithmetic must tie, or the register and the ledger drift apart.
    CONSTRAINT depreciation_charges_ties
        CHECK (closing_wdv_paise = opening_wdv_paise - charge_paise),
    FOREIGN KEY (asset_id, institution_id)
        REFERENCES fixed_assets (id, institution_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX depreciation_charges_once_per_year
    ON depreciation_charges (asset_id, fy_start_year);

-- ------------------------------------------------------------- budgeting

CREATE TABLE budgets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    fy_start_year   integer NOT NULL,
    name            text NOT NULL DEFAULT 'Annual budget',
    status          text NOT NULL DEFAULT 'draft',
    approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at     timestamptz,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT budgets_status CHECK (status IN ('draft','approved','revised')),
    CONSTRAINT budgets_approved_is_evidenced
        CHECK (status = 'draft' OR approved_at IS NOT NULL),
    UNIQUE (institution_id, fy_start_year, name),
    UNIQUE (id, institution_id)
);

/* A budget line: what one account, optionally in one department, may spend. */
CREATE TABLE budget_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    budget_id       uuid NOT NULL,
    account_id      uuid NOT NULL,
    department_id   uuid REFERENCES departments(id) ON DELETE CASCADE,
    allocated_paise bigint NOT NULL DEFAULT 0,
    -- A mid-year revision, kept beside the original rather than overwriting
    -- it: "we approved eight lakh and spent eleven" is a different sentence
    -- from "we revised to eleven and spent eleven", and a board asks which.
    revised_paise   bigint,
    notes           text,

    CONSTRAINT budget_lines_allocated CHECK (allocated_paise >= 0),
    CONSTRAINT budget_lines_revised CHECK (revised_paise IS NULL OR revised_paise >= 0),
    FOREIGN KEY (budget_id, institution_id) REFERENCES budgets (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE RESTRICT
);

/* One line per account per department.

   department_id is nullable — a school-wide line names no department — and a
   NULL inside a UNIQUE index disables it silently, so every school-wide line
   would compare distinct from every other and the same account could be
   budgeted twice. COALESCE to the nil uuid gives them something to collide on. */
CREATE UNIQUE INDEX budget_lines_one_per_account ON budget_lines
    (budget_id, account_id, COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ------------------------------------------------------------------- RLS

ALTER TABLE ledger_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE accounting_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_years FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors FORCE ROW LEVEL SECURITY;
ALTER TABLE vendor_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_bills FORCE ROW LEVEL SECURITY;
ALTER TABLE vendor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_vouchers FORCE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE depreciation_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE depreciation_charges FORCE ROW LEVEL SECURITY;
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY ledger_settings_tenant ON ledger_settings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY ledger_accounts_tenant ON ledger_accounts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY accounting_years_tenant ON accounting_years
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY journal_entries_tenant ON journal_entries
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY journal_lines_tenant ON journal_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY vendors_tenant ON vendors
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY vendor_bills_tenant ON vendor_bills
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY vendor_payments_tenant ON vendor_payments
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY petty_cash_vouchers_tenant ON petty_cash_vouchers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY fixed_assets_tenant ON fixed_assets
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY depreciation_charges_tenant ON depreciation_charges
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY budgets_tenant ON budgets
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
CREATE POLICY budget_lines_tenant ON budget_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

-- --------------------------------------------------------------- seeding

/* A standard chart of accounts for an Indian school trust.

   Seeded rather than left to a setup screen, for the same reason the PT slabs
   are: a school that has to invent a chart of accounts before it can record
   an electricity bill will keep using the spreadsheet. The codes follow the
   ordinary convention — 1 assets, 2 liabilities, 3 corpus, 4 income,
   5 expenditure — because that is what an auditor expects to be handed. */
CREATE TEMP TABLE coa_seed (
    code text, name text, type text,
    is_group boolean, is_cash boolean, is_contra boolean, parent text
) ON COMMIT DROP;

INSERT INTO coa_seed (code, name, type, is_group, is_cash, is_contra, parent) VALUES
    ('1000','Assets','asset',true,false,false,NULL),
    ('1100','Fixed Assets','asset',true,false,false,'1000'),
    ('1110','Land','asset',false,false,false,'1100'),
    ('1120','Buildings','asset',false,false,false,'1100'),
    ('1130','Furniture and Fixtures','asset',false,false,false,'1100'),
    ('1140','Computers and IT Equipment','asset',false,false,false,'1100'),
    ('1150','Laboratory Equipment','asset',false,false,false,'1100'),
    ('1160','Library Books','asset',false,false,false,'1100'),
    ('1170','Vehicles','asset',false,false,false,'1100'),
    ('1180','Sports and Playground Equipment','asset',false,false,false,'1100'),
    ('1190','Accumulated Depreciation','asset',false,false,true,'1100'),
    ('1200','Current Assets','asset',true,false,false,'1000'),
    ('1210','Fee Receivable','asset',false,false,false,'1200'),
    ('1220','Other Receivables','asset',false,false,false,'1200'),
    ('1230','Stores and Consumables','asset',false,false,false,'1200'),
    ('1240','Prepaid Expenses','asset',false,false,false,'1200'),
    ('1250','Security Deposits','asset',false,false,false,'1200'),
    ('1260','Staff Advances','asset',false,false,false,'1200'),
    ('1300','Cash and Bank','asset',true,false,false,'1000'),
    ('1310','Cash in Hand','asset',false,true,false,'1300'),
    ('1320','Petty Cash','asset',false,true,false,'1300'),
    ('1330','Bank — Current Account','asset',false,true,false,'1300'),
    ('1340','Bank — Savings Account','asset',false,true,false,'1300'),
    ('1350','Fixed Deposits','asset',false,false,false,'1300'),

    ('2000','Liabilities','liability',true,false,false,NULL),
    ('2100','Current Liabilities','liability',true,false,false,'2000'),
    ('2110','Sundry Creditors','liability',false,false,false,'2100'),
    ('2120','Salary Payable','liability',false,false,false,'2100'),
    ('2130','Provident Fund Payable','liability',false,false,false,'2100'),
    ('2140','ESI Payable','liability',false,false,false,'2100'),
    ('2150','Professional Tax Payable','liability',false,false,false,'2100'),
    ('2160','TDS Payable','liability',false,false,false,'2100'),
    ('2170','GST Payable','liability',false,false,false,'2100'),
    ('2180','Fees Received in Advance','liability',false,false,false,'2100'),
    ('2190','Caution Deposits Refundable','liability',false,false,false,'2100'),
    ('2200','Borrowings','liability',true,false,false,'2000'),
    ('2210','Bank Loan','liability',false,false,false,'2200'),
    ('2220','Vehicle Loan','liability',false,false,false,'2200'),

    ('3000','Corpus and Reserves','equity',true,false,false,NULL),
    ('3100','Corpus Fund','equity',false,false,false,'3000'),
    ('3200','General Reserve','equity',false,false,false,'3000'),
    ('3300','Surplus carried forward','equity',false,false,false,'3000'),
    ('3400','Building Fund','equity',false,false,false,'3000'),

    ('4000','Income','income',true,false,false,NULL),
    ('4100','Fee Income','income',true,false,false,'4000'),
    ('4110','Tuition Fee','income',false,false,false,'4100'),
    ('4120','Admission Fee','income',false,false,false,'4100'),
    ('4130','Transport Fee','income',false,false,false,'4100'),
    ('4140','Hostel and Mess Fee','income',false,false,false,'4100'),
    ('4150','Examination Fee','income',false,false,false,'4100'),
    ('4160','Library Fee','income',false,false,false,'4100'),
    ('4170','Laboratory and Computer Fee','income',false,false,false,'4100'),
    ('4180','Late Fee and Fines','income',false,false,false,'4100'),
    ('4190','Other Fee Income','income',false,false,false,'4100'),
    ('4200','Other Income','income',true,false,false,'4000'),
    ('4210','Donations and Grants','income',false,false,false,'4200'),
    ('4220','Interest Income','income',false,false,false,'4200'),
    ('4230','Prospectus and Application Sales','income',false,false,false,'4200'),
    ('4240','Rent Income','income',false,false,false,'4200'),
    ('4290','Miscellaneous Income','income',false,false,false,'4200'),

    ('5000','Expenditure','expense',true,false,false,NULL),
    ('5100','Employee Costs','expense',true,false,false,'5000'),
    ('5110','Salaries and Wages','expense',false,false,false,'5100'),
    ('5120','Employer Provident Fund','expense',false,false,false,'5100'),
    ('5130','Employer ESI','expense',false,false,false,'5100'),
    ('5140','Gratuity','expense',false,false,false,'5100'),
    ('5150','Staff Welfare','expense',false,false,false,'5100'),
    ('5160','Staff Training and Development','expense',false,false,false,'5100'),
    ('5200','Academic Expenses','expense',true,false,false,'5000'),
    ('5210','Teaching Aids and Stationery','expense',false,false,false,'5200'),
    ('5220','Laboratory Consumables','expense',false,false,false,'5200'),
    ('5230','Books and Periodicals','expense',false,false,false,'5200'),
    ('5240','Examination Expenses','expense',false,false,false,'5200'),
    ('5250','Co-curricular and Sports','expense',false,false,false,'5200'),
    ('5300','Administrative Expenses','expense',true,false,false,'5000'),
    ('5310','Printing and Stationery','expense',false,false,false,'5300'),
    ('5320','Telephone and Internet','expense',false,false,false,'5300'),
    ('5330','Postage and Courier','expense',false,false,false,'5300'),
    ('5340','Legal and Professional Fees','expense',false,false,false,'5300'),
    ('5350','Audit Fees','expense',false,false,false,'5300'),
    ('5360','Bank Charges','expense',false,false,false,'5300'),
    ('5370','Advertisement and Publicity','expense',false,false,false,'5300'),
    ('5380','Affiliation and Statutory Fees','expense',false,false,false,'5300'),
    ('5400','Establishment Expenses','expense',true,false,false,'5000'),
    ('5410','Electricity and Water','expense',false,false,false,'5400'),
    ('5420','Repairs — Building','expense',false,false,false,'5400'),
    ('5430','Repairs — Equipment','expense',false,false,false,'5400'),
    ('5440','Housekeeping and Security','expense',false,false,false,'5400'),
    ('5450','Rent, Rates and Taxes','expense',false,false,false,'5400'),
    ('5460','Insurance','expense',false,false,false,'5400'),
    ('5500','Transport Expenses','expense',true,false,false,'5000'),
    ('5510','Fuel','expense',false,false,false,'5500'),
    ('5520','Vehicle Maintenance','expense',false,false,false,'5500'),
    ('5530','Driver and Attendant Wages','expense',false,false,false,'5500'),
    ('5540','Vehicle Insurance and Permits','expense',false,false,false,'5500'),
    ('5600','Hostel and Mess','expense',true,false,false,'5000'),
    ('5610','Provisions and Mess','expense',false,false,false,'5600'),
    ('5620','Hostel Maintenance','expense',false,false,false,'5600'),
    ('5700','Finance and Depreciation','expense',true,false,false,'5000'),
    ('5710','Depreciation','expense',false,false,false,'5700'),
    ('5720','Interest on Borrowings','expense',false,false,false,'5700'),
    ('5900','Other Expenses','expense',true,false,false,'5000'),
    ('5910','Miscellaneous Expenses','expense',false,false,false,'5900'),
    ('5920','Fee Concessions and Write-offs','expense',false,false,false,'5900');

-- +goose StatementBegin
DO $$
DECLARE inst uuid;
BEGIN
    -- institutions is under FORCE row-level security, so without this the loop
    -- below iterates an empty result and seeds nothing at all — silently,
    -- because iterating no rows is not an error. The same trap 00023 fell into.
    PERFORM set_config('app.is_platform_admin', 'on', true);

    FOR inst IN SELECT id FROM institutions LOOP
        INSERT INTO ledger_accounts
            (institution_id, code, name, type, is_group, is_cash, is_contra, is_system)
        SELECT inst, s.code, s.name, s.type, s.is_group, s.is_cash, s.is_contra, true
          FROM coa_seed s
        ON CONFLICT (institution_id, code) DO NOTHING;

        -- Parents in a second pass: a self-referencing insert cannot name a row
        -- it has not written yet, and ordering the VALUES list to make it work
        -- would be a constraint nobody maintains.
        UPDATE ledger_accounts a
           SET parent_id = p.id
          FROM coa_seed s
          JOIN ledger_accounts p ON p.institution_id = inst AND p.code = s.parent
         WHERE a.institution_id = inst
           AND a.code = s.code
           AND a.parent_id IS NULL;

        INSERT INTO ledger_settings (
            institution_id, cash_account_id, bank_account_id, petty_cash_account_id,
            fee_receivable_account_id, fee_income_account_id, payable_account_id,
            depreciation_expense_account_id, accumulated_depreciation_account_id,
            surplus_account_id)
        SELECT inst,
               (SELECT id FROM ledger_accounts WHERE institution_id = inst AND code = '1310'),
               (SELECT id FROM ledger_accounts WHERE institution_id = inst AND code = '1330'),
               (SELECT id FROM ledger_accounts WHERE institution_id = inst AND code = '1320'),
               (SELECT id FROM ledger_accounts WHERE institution_id = inst AND code = '1210'),
               (SELECT id FROM ledger_accounts WHERE institution_id = inst AND code = '4110'),
               (SELECT id FROM ledger_accounts WHERE institution_id = inst AND code = '2110'),
               (SELECT id FROM ledger_accounts WHERE institution_id = inst AND code = '5710'),
               (SELECT id FROM ledger_accounts WHERE institution_id = inst AND code = '1190'),
               (SELECT id FROM ledger_accounts WHERE institution_id = inst AND code = '3300')
        ON CONFLICT (institution_id) DO NOTHING;

        -- The current financial year, open. Without a row here the first
        -- voucher of the year has no year to belong to and the closing screen
        -- shows nothing at all.
        INSERT INTO accounting_years (institution_id, fy_start_year)
        VALUES (inst,
                CASE WHEN extract(month FROM CURRENT_DATE) < 4
                     THEN extract(year FROM CURRENT_DATE)::integer - 1
                     ELSE extract(year FROM CURRENT_DATE)::integer END)
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;
-- +goose StatementEnd

-- The control accounts must point at this school's own chart. Added after the
-- seed so the seed itself is not fighting the constraint.
ALTER TABLE ledger_settings
    ADD CONSTRAINT ledger_settings_cash_fk
        FOREIGN KEY (cash_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL,
    ADD CONSTRAINT ledger_settings_bank_fk
        FOREIGN KEY (bank_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL,
    ADD CONSTRAINT ledger_settings_petty_fk
        FOREIGN KEY (petty_cash_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL,
    ADD CONSTRAINT ledger_settings_fee_receivable_fk
        FOREIGN KEY (fee_receivable_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL,
    ADD CONSTRAINT ledger_settings_fee_income_fk
        FOREIGN KEY (fee_income_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL,
    ADD CONSTRAINT ledger_settings_payable_fk
        FOREIGN KEY (payable_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL,
    ADD CONSTRAINT ledger_settings_depreciation_fk
        FOREIGN KEY (depreciation_expense_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL,
    ADD CONSTRAINT ledger_settings_accumulated_fk
        FOREIGN KEY (accumulated_depreciation_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL,
    ADD CONSTRAINT ledger_settings_surplus_fk
        FOREIGN KEY (surplus_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL;

ALTER TABLE accounting_years
    ADD CONSTRAINT accounting_years_closing_entry_fk
        FOREIGN KEY (closing_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL;

-- +goose Down
DROP TABLE IF EXISTS budget_lines;
DROP TABLE IF EXISTS budgets;
DROP TABLE IF EXISTS depreciation_charges;
DROP TABLE IF EXISTS fixed_assets;
DROP TABLE IF EXISTS petty_cash_vouchers;
DROP TABLE IF EXISTS vendor_payments;
DROP TABLE IF EXISTS vendor_bills;
DROP TABLE IF EXISTS vendors;
DROP TABLE IF EXISTS ledger_settings;
DROP TABLE IF EXISTS accounting_years;
DROP TABLE IF EXISTS journal_lines;
DROP TABLE IF EXISTS journal_entries;
DROP TABLE IF EXISTS ledger_accounts;
DROP FUNCTION IF EXISTS journal_must_balance();
DROP FUNCTION IF EXISTS journal_line_account_is_postable();
DROP FUNCTION IF EXISTS journal_year_must_be_open();
DROP FUNCTION IF EXISTS accounting_year_close_is_final();
DROP FUNCTION IF EXISTS vendor_payment_within_bill();
