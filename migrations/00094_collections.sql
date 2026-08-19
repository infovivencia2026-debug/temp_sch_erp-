-- Number claimed at 00085; it may be renumbered at integration, the way 00044
-- Renumbered at integration: the parent forum took 00093 while this was in
-- flight, and goose refuses a migration numbered below the current version.
-- was. Nothing in this file depends on its own number.
--
-- +goose Up
--
-- Three features that all end in the same place: money the school took at a
-- counter, and money the government gave it.
--
--   finance.collections.pos_canteen_terminal_integration
--   finance.collections.school_store_merchandise_sales
--   finance.concessions_refunds.grant_in_aid_accounting
--
-- The first two share every table below the word "counter". A canteen till and
-- a uniform counter are the same object -- somebody opens a drawer with a
-- float, rings things up, takes cash or charges the child's account, and at the
-- end has to explain the difference between what the machine says and what is
-- in the drawer. Building them twice would give a school two cash-up screens
-- that disagree, and the variance is the only number either screen exists for.
--
-- What is deliberately NOT here:
--
--   No wallet. finance.collections.cashless_campus_wallet is blocked for want
--   of a payment gateway, and a stored balance the school cannot top up or
--   refund electronically is a liability with no way to discharge it. The
--   cashless mode here is charge-to-student-account, which raises an ordinary
--   invoice on the fee ledger the parent already reads.
--
--   No second stock ledger. 00053 established that goods receipts write
--   inventory_movements and inventory_items.on_hand is a trigger's business.
--   A store sale writes kind='issue' through the same door; a return writes
--   kind='return'. store_product_variants exists to *name* the shelf a size
--   sits on, not to count it.
--
--   No second receipt series. 00045 built a gapless per-financial-year series
--   under a row lock because GST reads a missing number as a suppressed sale.
--   A POS sale draws its number from numbering_schemes through
--   fees.NextNumberOn with kind='pos', which is the same lock, the same April
--   reset and the same audit.


-- ===========================================================================
-- Part one: the counter
-- ===========================================================================

-- A till. A physical counter, not a device.
--
-- Named rather than identified by hardware, because a canteen replaces its
-- tablet and the cash-up history has to survive that. kind splits the two
-- features: a canteen terminal sells food and a store terminal sells stock,
-- and a school running both wants them cashed up separately even when the same
-- person works at each.
CREATE TABLE pos_terminals (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,

    code            text NOT NULL,
    name            text NOT NULL,
    kind            text NOT NULL DEFAULT 'canteen',
    location        text,
    is_active       boolean NOT NULL DEFAULT true,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pos_terminals_kind CHECK (kind IN ('canteen','store')),
    CONSTRAINT pos_terminals_code_present CHECK (btrim(code) <> ''),
    CONSTRAINT pos_terminals_name_present CHECK (btrim(name) <> ''),
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX pos_terminals_one_per_code
    ON pos_terminals (institution_id, lower(btrim(code)));
CREATE INDEX pos_terminals_live
    ON pos_terminals (institution_id, kind) WHERE is_active;

ALTER TABLE pos_terminals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_terminals FORCE  ROW LEVEL SECURITY;
CREATE POLICY pos_terminals_tenant ON pos_terminals
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON pos_terminals TO app_user;


-- One person's shift at one till.
--
-- This is the table the feature is actually about. A counter that takes cash
-- for twenty minutes at break and cannot say, at 11:20, whether the drawer is
-- short is not a point-of-sale system; it is an honesty box.
--
-- expected_cash_paise is snapshotted at close rather than computed on read.
-- The sales it was computed from can later be returned or corrected, and a
-- variance report that silently restates last Tuesday's shortfall is worse
-- than one that never existed -- the whole point is that somebody signed for a
-- number on the day.
--
-- variance_paise is generated, so the two figures can never drift apart. It is
-- counted minus expected: positive is a surplus in the drawer, negative is a
-- shortfall, and that sign convention is the one a cashier says out loud.
CREATE TABLE pos_till_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,
    terminal_id     uuid NOT NULL,

    -- The named person. NOT NULL: an unattributed drawer cannot be short,
    -- because nobody is short.
    opened_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    opened_at       timestamptz NOT NULL DEFAULT now(),
    opening_float_paise bigint NOT NULL DEFAULT 0,

    status          text NOT NULL DEFAULT 'open',

    closed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    closed_at       timestamptz,
    -- What was physically counted out of the drawer.
    counted_cash_paise  bigint,
    -- float + cash taken - cash refunded - cash paid out, frozen at close.
    expected_cash_paise bigint,
    -- Money that left the drawer for something other than a refund: change
    -- fetched, a supplier paid at the door. Recorded so it does not read as a
    -- shortfall.
    paid_out_paise  bigint NOT NULL DEFAULT 0,

    variance_paise  bigint GENERATED ALWAYS AS
        (COALESCE(counted_cash_paise, 0) - COALESCE(expected_cash_paise, 0)) STORED,
    variance_reason text,
    notes           text,

    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pos_till_sessions_status CHECK (status IN ('open','closed')),
    CONSTRAINT pos_till_sessions_money CHECK (
        opening_float_paise >= 0 AND paid_out_paise >= 0
        AND (counted_cash_paise IS NULL OR counted_cash_paise >= 0)),
    -- A closed session has all four closing facts or it is not closed. Half a
    -- cash-up is the state that lets a shortfall be forgotten.
    CONSTRAINT pos_till_sessions_closed_complete CHECK (
        (status = 'closed') =
        (closed_at IS NOT NULL AND counted_cash_paise IS NOT NULL
         AND expected_cash_paise IS NOT NULL AND closed_by IS NOT NULL)),
    -- A drawer that came up short or over needs a sentence. This is the one
    -- rule the cashier will resent and the auditor will look for.
    CONSTRAINT pos_till_sessions_variance_explained CHECK (
        status <> 'closed'
        OR counted_cash_paise = expected_cash_paise
        OR nullif(btrim(variance_reason), '') IS NOT NULL),
    CONSTRAINT pos_till_sessions_closed_after_open
        CHECK (closed_at IS NULL OR closed_at >= opened_at),

    FOREIGN KEY (terminal_id, institution_id)
        REFERENCES pos_terminals (id, institution_id) ON DELETE RESTRICT,
    UNIQUE (id, institution_id)
);

-- One open drawer per till.
--
-- Two open sessions on the same terminal means every sale after the second one
-- opened is attributed by guesswork, and neither cashier can be held to a
-- variance. Partial index rather than a constraint because closed sessions
-- pile up forever and must not collide.
--
-- No COALESCE needed: terminal_id is NOT NULL.
CREATE UNIQUE INDEX pos_till_sessions_one_open
    ON pos_till_sessions (terminal_id) WHERE status = 'open';

CREATE INDEX pos_till_sessions_recent
    ON pos_till_sessions (institution_id, opened_at DESC);
CREATE INDEX pos_till_sessions_by_person
    ON pos_till_sessions (institution_id, opened_by, opened_at DESC);

ALTER TABLE pos_till_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_till_sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY pos_till_sessions_tenant ON pos_till_sessions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON pos_till_sessions TO app_user;


-- One transaction at the counter: a sale, or the return that undoes one.
--
-- A return is a row in this table rather than a table of its own. It carries
-- the same lines, moves stock the other way, refunds through the same drawer
-- and takes its own number from the same series -- and modelling it separately
-- would mean writing the whole of that twice and reconciling the two halves in
-- every report. kind is the discriminator; every total on a return is stored
-- positive and read as an outflow.
--
-- receipt_no comes from numbering_schemes (00045) via fees.NextNumberOn with
-- kind='pos'. receipt_seq and receipt_fy are kept beside it for the same
-- reason payments does: gaplessness is then an index check rather than an
-- exercise in parsing a format the school is free to change.
--
-- student_id is nullable, because a teacher buys a samosa. It is required for
-- payment_mode='account', which the check below enforces -- an account charge
-- with nobody to charge is an invoice that can never be raised.
CREATE TABLE pos_sales (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,
    session_id      uuid NOT NULL,

    kind            text NOT NULL DEFAULT 'sale',
    channel         text NOT NULL DEFAULT 'canteen',

    -- The sale this return reverses. NULL on a sale.
    original_sale_id uuid REFERENCES pos_sales(id) ON DELETE RESTRICT,

    student_id      uuid REFERENCES students(id) ON DELETE SET NULL,
    -- Who bought it when it was not a child on the roll.
    buyer_name      text,

    sold_at         timestamptz NOT NULL DEFAULT now(),
    -- The date the document bears, which is what decides its year in the
    -- series. Separate from sold_at so a receipt written up the next morning
    -- for last night's sports-day counter can be dated honestly.
    sold_on         date NOT NULL DEFAULT CURRENT_DATE,

    payment_mode    text NOT NULL DEFAULT 'cash',

    subtotal_paise  bigint NOT NULL DEFAULT 0,
    discount_paise  bigint NOT NULL DEFAULT 0,
    tax_paise       bigint NOT NULL DEFAULT 0,
    total_paise     bigint NOT NULL,

    receipt_no      text NOT NULL,
    receipt_seq     bigint,
    receipt_fy      text,

    -- Set when payment_mode='account': the fee-ledger document that carries
    -- the charge. A return against an account sale reduces that invoice, which
    -- is why the link is kept.
    invoice_id      uuid REFERENCES invoices(id) ON DELETE SET NULL,

    remarks         text,
    sold_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pos_sales_kind    CHECK (kind IN ('sale','return')),
    CONSTRAINT pos_sales_channel CHECK (channel IN ('canteen','store')),
    -- Cash, or charged to the child's fee account. No wallet, no card, no UPI:
    -- there is no gateway behind this build and a mode the counter cannot
    -- actually settle is a mode that produces unreconcilable rows.
    CONSTRAINT pos_sales_payment_mode CHECK (payment_mode IN ('cash','account')),
    CONSTRAINT pos_sales_money CHECK (
        subtotal_paise >= 0 AND discount_paise >= 0 AND tax_paise >= 0
        AND total_paise > 0
        AND discount_paise <= subtotal_paise
        AND total_paise = subtotal_paise - discount_paise + tax_paise),
    -- A charge with no account to charge.
    CONSTRAINT pos_sales_account_needs_student
        CHECK (payment_mode <> 'account' OR student_id IS NOT NULL),
    -- A return points at what it returns; a sale does not.
    CONSTRAINT pos_sales_return_has_original
        CHECK ((kind = 'return') = (original_sale_id IS NOT NULL)),
    CONSTRAINT pos_sales_someone
        CHECK (student_id IS NOT NULL OR nullif(btrim(buyer_name), '') IS NOT NULL),
    CONSTRAINT pos_sales_receipt_present CHECK (btrim(receipt_no) <> ''),

    FOREIGN KEY (session_id, institution_id)
        REFERENCES pos_till_sessions (id, institution_id) ON DELETE RESTRICT,
    UNIQUE (institution_id, receipt_no),
    UNIQUE (id, institution_id)
);

CREATE INDEX pos_sales_by_session ON pos_sales (session_id, sold_at);
CREATE INDEX pos_sales_by_student
    ON pos_sales (institution_id, student_id, sold_at DESC) WHERE student_id IS NOT NULL;
CREATE INDEX pos_sales_by_day
    ON pos_sales (institution_id, channel, sold_on DESC);
CREATE INDEX pos_sales_returns_of
    ON pos_sales (original_sale_id) WHERE original_sale_id IS NOT NULL;

-- The series must be gapless within its financial year.
--
-- receipt_fy is nullable -- a school whose 'pos' scheme does not reset yearly
-- has none -- and a NULL inside a unique index silently disables it, which is
-- the trap this codebase has fallen into seven times. COALESCE to the empty
-- string gives the non-resetting case one value to collide on.
CREATE UNIQUE INDEX pos_sales_series_once
    ON pos_sales (institution_id, COALESCE(receipt_fy, ''), receipt_seq)
    WHERE receipt_seq IS NOT NULL;

ALTER TABLE pos_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_sales FORCE  ROW LEVEL SECURITY;
CREATE POLICY pos_sales_tenant ON pos_sales
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON pos_sales TO app_user;


-- One line on the till roll.
--
-- item_name is a snapshot, not a lookup. A canteen menu changes weekly and is
-- often a contractor's; a store item gets renamed. Either way the receipt a
-- parent is holding has to keep saying what it said, and 00035 made the same
-- call for cafeteria_purchase_items for the same reason.
--
-- variant_id is set on a store line and NULL on a canteen one. Canteen stock
-- is not tracked -- a school does not keep a perpetual inventory of samosas --
-- so a canteen line moves no stock and is priced free-hand. A store line
-- always names a variant, and the variant always names an inventory_items row,
-- which is how the sale reaches the ledger 00005 already maintains.
--
-- line_paise is stored rather than computed from quantity * unit_paise,
-- because a counter applies a two-for-one and the figure the family was
-- charged is the truth.
CREATE TABLE pos_sale_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    sale_id         uuid NOT NULL,
    line_no         integer NOT NULL DEFAULT 1,

    variant_id      uuid,
    item_name       text NOT NULL,
    -- Mirrors cafeteria_purchase_items.category so the parent-facing screen
    -- and the till agree about what a thing is.
    category        text NOT NULL DEFAULT 'other',
    -- What a uniform line is: printed on the receipt so an exchange three
    -- weeks later does not depend on somebody remembering the size.
    variant_label   text,

    quantity        integer NOT NULL DEFAULT 1,
    unit_paise      bigint  NOT NULL,
    discount_paise  bigint  NOT NULL DEFAULT 0,
    tax_paise       bigint  NOT NULL DEFAULT 0,
    line_paise      bigint  NOT NULL,

    -- Written by pos_line_to_stock(); see the trigger. NULL on a canteen line.
    inventory_movement_id uuid REFERENCES inventory_movements(id) ON DELETE SET NULL,

    CONSTRAINT pos_sale_lines_quantity CHECK (quantity > 0),
    CONSTRAINT pos_sale_lines_money CHECK (
        unit_paise >= 0 AND discount_paise >= 0 AND tax_paise >= 0
        AND line_paise >= 0),
    CONSTRAINT pos_sale_lines_name CHECK (nullif(btrim(item_name), '') IS NOT NULL),
    CONSTRAINT pos_sale_lines_category CHECK (category IN
        ('meal','snack','beverage','dessert','fruit',
         'uniform','book','stationery','other')),

    FOREIGN KEY (sale_id, institution_id)
        REFERENCES pos_sales (id, institution_id) ON DELETE CASCADE,
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX pos_sale_lines_one_per_no ON pos_sale_lines (sale_id, line_no);
CREATE INDEX pos_sale_lines_by_variant
    ON pos_sale_lines (institution_id, variant_id) WHERE variant_id IS NOT NULL;

ALTER TABLE pos_sale_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_sale_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY pos_sale_lines_tenant ON pos_sale_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON pos_sale_lines TO app_user;


-- ===========================================================================
-- Part two: what the store sells
-- ===========================================================================

-- A thing on the storefront: "White shirt, half sleeve", "Class 6 Maths".
--
-- Not a stock row. The stock rows are inventory_items and always were; this is
-- the name a parent asks for at the counter, and the tax treatment that goes
-- with it. 00003 already noted that tuition is exempt while uniforms and books
-- are not, so hsn_code and tax_rate_bp live here rather than being retyped on
-- every sale.
--
-- tax_rate_bp is basis points -- 500 is 5% -- so a rate is an integer and
-- never a float. GST slabs are whole or half percentages and a rate stored as
-- 0.05 is a rounding argument waiting to happen.
CREATE TABLE store_products (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,

    code            text NOT NULL,
    name            text NOT NULL,
    category        text NOT NULL DEFAULT 'other',

    hsn_code        text,
    tax_rate_bp     integer NOT NULL DEFAULT 0,

    -- The shelf price, in paise. A variant may override it; most do not,
    -- because a school charges the same for every size of the same shirt.
    sale_price_paise bigint NOT NULL,

    -- How long an unworn item may come back. Days, because that is how the
    -- notice on the counter is written. NULL means the school has no policy
    -- and the clerk decides, which is the honest default.
    return_window_days integer,

    is_active       boolean NOT NULL DEFAULT true,
    notes           text,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT store_products_category CHECK (category IN
        ('uniform','book','stationery','sports','other')),
    CONSTRAINT store_products_code_present CHECK (btrim(code) <> ''),
    CONSTRAINT store_products_name_present CHECK (btrim(name) <> ''),
    CONSTRAINT store_products_price CHECK (sale_price_paise >= 0),
    CONSTRAINT store_products_tax CHECK (tax_rate_bp BETWEEN 0 AND 10000),
    CONSTRAINT store_products_window
        CHECK (return_window_days IS NULL OR return_window_days BETWEEN 0 AND 365),
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX store_products_one_per_code
    ON store_products (institution_id, lower(btrim(code)));
CREATE INDEX store_products_live
    ON store_products (institution_id, category) WHERE is_active;

ALTER TABLE store_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_products FORCE  ROW LEVEL SECURITY;
CREATE POLICY store_products_tenant ON store_products
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON store_products TO app_user;


-- One size, one colour, one shelf.
--
-- This is the whole of the variant model, and stopping here is deliberate. A
-- general product-variant system -- attribute definitions, option sets, a
-- matrix generator -- is three tables and a week, and a school sells shirts in
-- eight sizes and trousers in two colours. Two nullable text columns cover
-- every uniform any of them has asked for.
--
-- item_id is the load-bearing column. A size is not a quantity on a product;
-- it is its own shelf with its own count, so it is its own inventory_items
-- row, and this table is the join that says which. That is what makes a sale
-- able to write an ordinary inventory_movements row of kind='issue' and leave
-- on_hand to the trigger 00005 already installed. No second stock ledger, no
-- parallel count to reconcile.
--
-- UNIQUE (institution_id, item_id) is not decoration: if two variants pointed
-- at one shelf, "how many size 32 shirts are left" would have two answers.
CREATE TABLE store_product_variants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL,
    item_id         uuid NOT NULL,

    size            text,
    colour          text,
    -- What the label on the garment says, when it is neither a size nor a
    -- colour: "Girls", "Winter". Kept as one free field rather than becoming
    -- the third axis of a matrix.
    variant_note    text,

    -- Overrides the product price when the school charges more for XL.
    sale_price_paise bigint,

    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT store_product_variants_price
        CHECK (sale_price_paise IS NULL OR sale_price_paise >= 0),

    FOREIGN KEY (product_id, institution_id)
        REFERENCES store_products (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (item_id, institution_id)
        REFERENCES inventory_items (id, institution_id) ON DELETE RESTRICT,
    UNIQUE (id, institution_id)
);

-- One variant per (product, size, colour).
--
-- size and colour are both nullable -- a book has neither -- and a NULL is
-- distinct from every other NULL, so a plain UNIQUE over them would enforce
-- nothing at all and every book could be entered twice. COALESCE to the empty
-- string is what makes "the product with no size and no colour" a single value
-- that can collide with itself.
CREATE UNIQUE INDEX store_product_variants_one_per_option
    ON store_product_variants (
        institution_id, product_id,
        COALESCE(lower(btrim(size)),   ''),
        COALESCE(lower(btrim(colour)), ''));

-- One shelf, one variant. See the table comment.
CREATE UNIQUE INDEX store_product_variants_one_per_item
    ON store_product_variants (institution_id, item_id);

CREATE INDEX store_product_variants_by_product
    ON store_product_variants (product_id) WHERE is_active;

ALTER TABLE store_product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_product_variants FORCE  ROW LEVEL SECURITY;
CREATE POLICY store_product_variants_tenant ON store_product_variants
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON store_product_variants TO app_user;

-- The line table can only now name its variant.
ALTER TABLE pos_sale_lines
    ADD CONSTRAINT pos_sale_lines_variant_fk
    FOREIGN KEY (variant_id, institution_id)
        REFERENCES store_product_variants (id, institution_id) ON DELETE RESTRICT;


-- Selling stock moves stock. In the database, so it cannot be forgotten.
--
-- A BEFORE INSERT trigger, and the shape is lifted directly from
-- po_receipt_to_stock() in 00053 -- same reason for BEFORE rather than AFTER
-- (the movement's id goes back onto this row and must exist from the first
-- moment the row does), same reliance on sync_inventory_on_hand() from 00005
-- to recompute on_hand from the whole history.
--
-- The kind follows the sale's kind: a sale issues, a return puts back. Both
-- are already in the CHECK on inventory_movements, so nothing new is invented
-- here. A canteen line has no variant and moves nothing.
--
-- unit_cost_paise deliberately carries the *sale* price rather than a cost.
-- The column is what a stores valuation reads, and for the school store the
-- figure that matters on an issue is what it went out for. reference carries
-- the receipt number, so a stores clerk staring at a movement can find the
-- till roll.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION pos_line_to_stock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_item  uuid;
    v_kind  text;
    v_rcpt  text;
    v_on    date;
    v_by    uuid;
    v_move  uuid;
BEGIN
    IF NEW.variant_id IS NULL THEN
        RETURN NEW;                     -- a canteen line; nothing on a shelf
    END IF;

    SELECT v.item_id INTO v_item
      FROM store_product_variants v WHERE v.id = NEW.variant_id;

    IF v_item IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT CASE WHEN s.kind = 'return' THEN 'return' ELSE 'issue' END,
           s.receipt_no, s.sold_on, s.sold_by
      INTO v_kind, v_rcpt, v_on, v_by
      FROM pos_sales s WHERE s.id = NEW.sale_id;

    INSERT INTO inventory_movements (institution_id, item_id, kind, quantity,
                                     unit_cost_paise, reference, moved_on,
                                     remarks, created_by)
    VALUES (NEW.institution_id, v_item, v_kind, NEW.quantity,
            NEW.unit_paise, v_rcpt, v_on,
            CASE WHEN v_kind = 'return' THEN 'School store return'
                 ELSE 'School store sale' END, v_by)
    RETURNING id INTO v_move;

    NEW.inventory_movement_id := v_move;
    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS pos_sale_lines_to_stock ON pos_sale_lines;
CREATE TRIGGER pos_sale_lines_to_stock
    BEFORE INSERT ON pos_sale_lines
    FOR EACH ROW EXECUTE FUNCTION pos_line_to_stock();


-- ===========================================================================
-- Part three: grant-in-aid
-- ===========================================================================

-- A sanctioned head of expenditure.
--
-- An aided school in India does not receive "a grant". It receives a sanction
-- against a named head -- teaching salaries, non-salary, maintenance,
-- contingency -- and the rule that decides whether the year's accounts are
-- accepted is that money sanctioned under one head was spent under that head.
-- Without heads as rows, "utilisation" is one number, the diversion nobody
-- sees is invisible, and the utilisation certificate cannot be produced at
-- all.
--
-- expense_account_id ties the head to the chart of accounts from 00033, which
-- is what makes this ordinary bookkeeping rather than a spreadsheet beside the
-- books. It is nullable only so a school can enter its heads before it has
-- finished its chart; every posting endpoint refuses rather than guessing.
CREATE TABLE grant_in_aid_heads (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    code            text NOT NULL,
    name            text NOT NULL,
    category        text NOT NULL DEFAULT 'non_salary',

    expense_account_id uuid,

    -- Salary heads are sanctioned by post, not by rupee: "37 teaching posts".
    -- Recorded on the sanction, described here.
    is_post_based   boolean NOT NULL DEFAULT false,

    is_active       boolean NOT NULL DEFAULT true,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT grant_in_aid_heads_category CHECK (category IN
        ('salary','non_salary','maintenance','contingency','infrastructure','other')),
    CONSTRAINT grant_in_aid_heads_code_present CHECK (btrim(code) <> ''),
    CONSTRAINT grant_in_aid_heads_name_present CHECK (btrim(name) <> ''),

    FOREIGN KEY (expense_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE RESTRICT,
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX grant_in_aid_heads_one_per_code
    ON grant_in_aid_heads (institution_id, lower(btrim(code)));

ALTER TABLE grant_in_aid_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_in_aid_heads FORCE  ROW LEVEL SECURITY;
CREATE POLICY grant_in_aid_heads_tenant ON grant_in_aid_heads
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON grant_in_aid_heads TO app_user;


-- What the government order actually sanctioned, for one head, for one year.
--
-- fy_start_year rather than a date range, and 2026 means April 2026 to March
-- 2027 -- the same convention journal_entries.fy_start_year is generated with,
-- restated nowhere and referenced everywhere, because every Indian
-- financial-software date bug is a February entry filed under the wrong year.
--
-- Three figures that are routinely confused and must never collapse:
--
     -- sanctioned  what the GO approved
     -- received    what the treasury actually released, summed from grant_receipts
     -- utilised    what was spent, summed from grant_expenditures
--
-- None of the three is derivable from another. A school can be sanctioned
-- fully, receive half, and spend more than it received out of its own funds
-- pending release; the unspent balance at year end is received minus utilised,
-- and the amount still to come is sanctioned minus received. A single "grant
-- amount" column makes both questions unanswerable.
CREATE TABLE grant_sanctions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    head_id         uuid NOT NULL,

    fy_start_year   integer NOT NULL,

    sanction_no     text NOT NULL,
    sanction_date   date NOT NULL,
    authority       text,
    scheme_name     text,

    sanctioned_paise bigint NOT NULL,
    -- Posts, for a salary head. NULL where the head is not post-based.
    sanctioned_posts integer,

    -- Last year's unspent balance carried into this sanction rather than
    -- refunded. Part of what is available to spend, and shown separately
    -- because the certificate has a line for it.
    opening_unspent_paise bigint NOT NULL DEFAULT 0,

    status          text NOT NULL DEFAULT 'sanctioned',
    notes           text,

    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT grant_sanctions_status CHECK (status IN ('draft','sanctioned','closed')),
    CONSTRAINT grant_sanctions_money CHECK (
        sanctioned_paise >= 0 AND opening_unspent_paise >= 0),
    CONSTRAINT grant_sanctions_posts
        CHECK (sanctioned_posts IS NULL OR sanctioned_posts >= 0),
    CONSTRAINT grant_sanctions_year CHECK (fy_start_year BETWEEN 1990 AND 2200),
    CONSTRAINT grant_sanctions_no_present CHECK (btrim(sanction_no) <> ''),

    FOREIGN KEY (head_id, institution_id)
        REFERENCES grant_in_aid_heads (id, institution_id) ON DELETE RESTRICT,
    UNIQUE (id, institution_id)
);

-- One sanction order per head per year.
--
-- A single GO commonly sanctions several heads at once, so the sanction number
-- repeats across rows -- it is the pair with the head that has to be unique.
-- All four columns are NOT NULL, so no COALESCE is needed here.
CREATE UNIQUE INDEX grant_sanctions_one_per_head_year
    ON grant_sanctions (institution_id, head_id, fy_start_year, lower(btrim(sanction_no)));

CREATE INDEX grant_sanctions_by_year
    ON grant_sanctions (institution_id, fy_start_year, head_id);

ALTER TABLE grant_sanctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_sanctions FORCE  ROW LEVEL SECURITY;
CREATE POLICY grant_sanctions_tenant ON grant_sanctions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON grant_sanctions TO app_user;


-- An instalment actually released by the treasury.
--
-- Separate from the sanction because a year's grant arrives in two, three or
-- five tranches, months apart, and the school's cash position through the year
-- is the difference. journal_entry_id ties the receipt to the voucher that
-- debited the bank and credited the grant account -- one voucher per receipt,
-- guaranteed unique by journal_entries_one_per_source in 00033, so a retried
-- request cannot double-count the money.
CREATE TABLE grant_receipts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    sanction_id     uuid NOT NULL,

    received_on     date   NOT NULL DEFAULT CURRENT_DATE,
    amount_paise    bigint NOT NULL,

    mode            text NOT NULL DEFAULT 'bank_transfer',
    reference_no    text,
    bank_account_id uuid,

    journal_entry_id uuid,

    remarks         text,
    recorded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT grant_receipts_amount CHECK (amount_paise > 0),
    CONSTRAINT grant_receipts_mode CHECK (mode IN
        ('bank_transfer','cheque','dd','adjustment')),

    FOREIGN KEY (sanction_id, institution_id)
        REFERENCES grant_sanctions (id, institution_id) ON DELETE RESTRICT,
    FOREIGN KEY (bank_account_id, institution_id)
        REFERENCES bank_accounts (id, institution_id) ON DELETE SET NULL,
    FOREIGN KEY (journal_entry_id, institution_id)
        REFERENCES journal_entries (id, institution_id) ON DELETE SET NULL,
    UNIQUE (id, institution_id)
);

CREATE INDEX grant_receipts_by_sanction
    ON grant_receipts (sanction_id, received_on);

ALTER TABLE grant_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_receipts FORCE  ROW LEVEL SECURITY;
CREATE POLICY grant_receipts_tenant ON grant_receipts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON grant_receipts TO app_user;


-- Expenditure booked against a sanctioned head.
--
-- The head is not a label on this row. It is inherited from the sanction, and
-- that is the point: booking an expense against a sanction is the act of
-- saying which head it fell under, and the utilisation report is that
-- arithmetic and nothing else.
--
-- source_kind / source_id link to whatever the school already recorded -- a
-- vendor bill, a payroll run, a petty cash voucher -- so the same rupee is not
-- entered twice in two systems. Both or neither, for the same reason
-- journal_entries insists: half a reference looks like a link.
--
-- voucher_ref is the school's own paper: the file number a physical voucher
-- carries, which is what an inspecting officer asks for by name.
CREATE TABLE grant_expenditures (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    sanction_id     uuid NOT NULL,

    spent_on        date   NOT NULL DEFAULT CURRENT_DATE,
    amount_paise    bigint NOT NULL,
    particulars     text   NOT NULL,

    voucher_ref     text,
    source_kind     text,
    source_id       uuid,

    journal_entry_id uuid,

    recorded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT grant_expenditures_amount CHECK (amount_paise > 0),
    CONSTRAINT grant_expenditures_particulars
        CHECK (nullif(btrim(particulars), '') IS NOT NULL),
    CONSTRAINT grant_expenditures_source_paired
        CHECK ((source_kind IS NULL) = (source_id IS NULL)),
    CONSTRAINT grant_expenditures_source_kind CHECK (source_kind IS NULL OR
        source_kind IN ('vendor_bill','payroll_run','petty_cash_voucher','manual')),

    FOREIGN KEY (sanction_id, institution_id)
        REFERENCES grant_sanctions (id, institution_id) ON DELETE RESTRICT,
    FOREIGN KEY (journal_entry_id, institution_id)
        REFERENCES journal_entries (id, institution_id) ON DELETE SET NULL,
    UNIQUE (id, institution_id)
);

CREATE INDEX grant_expenditures_by_sanction
    ON grant_expenditures (sanction_id, spent_on);

-- The same bill cannot be charged to two heads.
--
-- This is the diversion an audit looks for, committed by accident: an
-- accountant books the electricity bill against maintenance in March and
-- against contingency in April when the first head runs out. source_id is
-- nullable -- most entries are typed by hand and have no upstream record --
-- and a NULL is distinct from every other NULL, so the index is partial rather
-- than COALESCE'd: where there is no source there is nothing to double-book.
CREATE UNIQUE INDEX grant_expenditures_one_per_source
    ON grant_expenditures (institution_id, source_kind, source_id)
    WHERE source_id IS NOT NULL;

ALTER TABLE grant_expenditures ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_expenditures FORCE  ROW LEVEL SECURITY;
CREATE POLICY grant_expenditures_tenant ON grant_expenditures
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON grant_expenditures TO app_user;


-- The utilisation certificate: the document the school actually files.
--
-- GFR 12-A in substance -- grant received, grant utilised, balance unutilised,
-- and a signature certifying that it was spent for the purpose sanctioned.
-- Everything on it is a snapshot taken at issue, not a live query, because the
-- certificate is a statement somebody signed on a date and later expenditure
-- must not silently restate it. That is the same argument
-- pos_till_sessions.expected_cash_paise makes about a drawer.
--
-- The unspent balance has to go somewhere, and "somewhere" is a decision with
-- a deadline: carried into next year's sanction, or refunded to the treasury.
-- Leaving it as a number nobody dispositioned is how a school ends up with a
-- recovery order three years later.
CREATE TABLE grant_utilisation_certificates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    certificate_no  text NOT NULL,
    fy_start_year   integer NOT NULL,
    period_from     date NOT NULL,
    period_to       date NOT NULL,

    status          text NOT NULL DEFAULT 'draft',
    issued_on       date,
    filed_on        date,
    filed_reference text,

    -- Snapshotted at issue. Zero on a draft, which recomputes on every open.
    opening_unspent_paise bigint NOT NULL DEFAULT 0,
    sanctioned_paise bigint NOT NULL DEFAULT 0,
    received_paise   bigint NOT NULL DEFAULT 0,
    utilised_paise   bigint NOT NULL DEFAULT 0,
    unspent_paise    bigint NOT NULL DEFAULT 0,

    unspent_disposition text NOT NULL DEFAULT 'pending',
    refunded_on     date,
    refund_reference text,

    certified_by    text,
    remarks         text,

    prepared_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT grant_uc_status CHECK (status IN ('draft','issued','filed')),
    CONSTRAINT grant_uc_disposition CHECK (unspent_disposition IN
        ('pending','carried_forward','refunded','none')),
    CONSTRAINT grant_uc_money CHECK (
        opening_unspent_paise >= 0 AND sanctioned_paise >= 0
        AND received_paise >= 0 AND utilised_paise >= 0),
    CONSTRAINT grant_uc_period CHECK (period_to >= period_from),
    CONSTRAINT grant_uc_year CHECK (fy_start_year BETWEEN 1990 AND 2200),
    CONSTRAINT grant_uc_no_present CHECK (btrim(certificate_no) <> ''),
    -- Issued means signed, and a signed certificate carries a date and a name.
    CONSTRAINT grant_uc_issued_complete CHECK (
        status = 'draft'
        OR (issued_on IS NOT NULL AND nullif(btrim(certified_by), '') IS NOT NULL)),
    CONSTRAINT grant_uc_filed_complete CHECK (status <> 'filed' OR filed_on IS NOT NULL),
    -- A refund that has not happened is not a disposition, it is an intention.
    CONSTRAINT grant_uc_refund_complete CHECK (
        unspent_disposition <> 'refunded' OR refunded_on IS NOT NULL),
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX grant_uc_one_per_no
    ON grant_utilisation_certificates (institution_id, lower(btrim(certificate_no)));
CREATE INDEX grant_uc_by_year
    ON grant_utilisation_certificates (institution_id, fy_start_year DESC);

ALTER TABLE grant_utilisation_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_utilisation_certificates FORCE  ROW LEVEL SECURITY;
CREATE POLICY grant_uc_tenant ON grant_utilisation_certificates
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON grant_utilisation_certificates TO app_user;


-- One line of the certificate: one head, one sanction, four figures.
--
-- head_name is copied rather than joined. A certificate filed in 2026 has to
-- keep reading the way it read when it was signed, and a school that renames
-- "Contingency" to "Office contingency" next year must not appear to have
-- filed a document that says something else.
CREATE TABLE grant_utilisation_certificate_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    certificate_id  uuid NOT NULL,
    sanction_id     uuid NOT NULL,

    head_name       text NOT NULL,
    sanction_no     text NOT NULL,

    opening_unspent_paise bigint NOT NULL DEFAULT 0,
    sanctioned_paise bigint NOT NULL DEFAULT 0,
    received_paise   bigint NOT NULL DEFAULT 0,
    utilised_paise   bigint NOT NULL DEFAULT 0,
    unspent_paise    bigint NOT NULL DEFAULT 0,

    CONSTRAINT grant_uc_lines_money CHECK (
        opening_unspent_paise >= 0 AND sanctioned_paise >= 0
        AND received_paise >= 0 AND utilised_paise >= 0),

    FOREIGN KEY (certificate_id, institution_id)
        REFERENCES grant_utilisation_certificates (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (sanction_id, institution_id)
        REFERENCES grant_sanctions (id, institution_id) ON DELETE RESTRICT
);

-- A head appears once on a certificate. Twice is a double count that still
-- adds up, which is the worst kind.
CREATE UNIQUE INDEX grant_uc_lines_one_per_sanction
    ON grant_utilisation_certificate_lines (certificate_id, sanction_id);

ALTER TABLE grant_utilisation_certificate_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_utilisation_certificate_lines FORCE  ROW LEVEL SECURITY;
CREATE POLICY grant_uc_lines_tenant ON grant_utilisation_certificate_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON grant_utilisation_certificate_lines TO app_user;


-- ===========================================================================
-- Settings shared by the three features
-- ===========================================================================

-- One row per school, holding the references the posting endpoints need.
--
-- Nullable throughout, and every endpoint that needs one refuses by name
-- rather than defaulting -- the argument loadControls() makes in 00033.
-- Guessing "they probably meant the Cash in Hand account" is how a school's
-- canteen takings end up somewhere nobody reconciles.
CREATE TABLE collections_settings (
    institution_id  uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,

    -- The fee head a charge-to-account canteen sale is invoiced under.
    canteen_fee_head_id uuid REFERENCES fee_heads(id) ON DELETE SET NULL,
    -- And the one a store sale uses. Separate, because a school shows uniform
    -- sales and canteen charges as different lines on a parent's statement.
    store_fee_head_id   uuid REFERENCES fee_heads(id) ON DELETE SET NULL,

    -- Below this, a cash-up variance is noise: a five-rupee coin nobody can
    -- find. Above it, the screen flags the session. Policy, not law, which is
    -- exactly why it is a column.
    variance_tolerance_paise bigint NOT NULL DEFAULT 5000,

    -- Where a grant receipt is credited. An aided grant is not the school's
    -- income until it is spent, so this is normally a liability account and
    -- the utilisation is what releases it -- but the account is the school's
    -- choice and its auditor's, not this schema's.
    grant_liability_account_id uuid,
    grant_bank_account_id      uuid,

    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT collections_settings_tolerance CHECK (variance_tolerance_paise >= 0),
    FOREIGN KEY (grant_liability_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL,
    FOREIGN KEY (grant_bank_account_id, institution_id)
        REFERENCES ledger_accounts (id, institution_id) ON DELETE SET NULL
);

ALTER TABLE collections_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY collections_settings_tenant ON collections_settings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON collections_settings TO app_user;


-- --------------------------------------------------------------- documentation

COMMENT ON TABLE pos_till_sessions IS
    'One person''s shift at one till. expected_cash_paise is frozen at close, not recomputed, so a variance somebody signed for on the day cannot be restated by a later correction. Read by internal/api/collections.go.';
COMMENT ON COLUMN pos_till_sessions.variance_paise IS
    'counted minus expected. Positive is a surplus in the drawer, negative a shortfall.';
COMMENT ON TABLE pos_sales IS
    'A till transaction. kind=return is the reversal of a sale and carries positive totals read as an outflow. receipt_no is drawn from numbering_schemes kind=''pos'' through fees.NextNumberOn, so it shares the fee counter''s gapless per-financial-year series and its row lock.';
COMMENT ON TABLE store_product_variants IS
    'The join from a sellable product to the inventory_items row that actually holds the stock for one size or colour. Deliberately not a general variant system: two nullable text columns cover every uniform a school has asked for, and item_id is what keeps this off a second stock ledger.';
COMMENT ON TABLE grant_sanctions IS
    'What a government order sanctioned, per head, per financial year. sanctioned, received (grant_receipts) and utilised (grant_expenditures) are three independent figures and none is derivable from another.';
COMMENT ON TABLE grant_utilisation_certificates IS
    'The GFR 12-A style certificate a school files. Every figure is snapshotted at issue: a signed certificate is a statement made on a date, and later expenditure must not silently rewrite it.';


-- +goose Down

DROP TABLE IF EXISTS collections_settings;
DROP TABLE IF EXISTS grant_utilisation_certificate_lines;
DROP TABLE IF EXISTS grant_utilisation_certificates;
DROP TABLE IF EXISTS grant_expenditures;
DROP TABLE IF EXISTS grant_receipts;
DROP TABLE IF EXISTS grant_sanctions;
DROP TABLE IF EXISTS grant_in_aid_heads;

DROP TRIGGER IF EXISTS pos_sale_lines_to_stock ON pos_sale_lines;
DROP FUNCTION IF EXISTS pos_line_to_stock();

DROP TABLE IF EXISTS pos_sale_lines;
DROP TABLE IF EXISTS store_product_variants;
DROP TABLE IF EXISTS store_products;
DROP TABLE IF EXISTS pos_sales;
DROP TABLE IF EXISTS pos_till_sessions;
DROP TABLE IF EXISTS pos_terminals;

-- The movements the store wrote are deliberately left alone: they are rows in
-- 00005's ledger, on_hand was recomputed from them, and deleting them here
-- would silently restate every stock figure in the school.
