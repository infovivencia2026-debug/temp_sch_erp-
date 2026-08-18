-- Numbered 00051 as claimed in the build brief. May be renumbered at
-- integration: several workers are landing in the 00047-00052 range this
-- round and goose refuses a migration that appears behind the current
-- version. Content is order-independent of the others — it adds tables and
-- touches no migration but its own.
-- +goose Up

-- Four administrative features that all have the same shape: a thing the
-- school already records, and a control on top of it that the school is
-- answerable for.
--
--   Purchasing      requisition -> approval -> order -> receipt -> match.
--   Mid-day meal    the daily register -> the monthly PM POSHAN return.
--   360 evaluation  invitations -> anonymous responses -> a released result.
--   Fee filing      a fee structure version -> a filing -> a committee decision.
--
-- What is deliberately NOT here:
--
--   No second stock ledger. Goods receipts write inventory_movements, the
--   table 00005 created and the stores screen already reads. A receipt that
--   did not move stock would make the stores screen a lie, so the movement is
--   written by a trigger rather than by the handler — there is no code path
--   that can record a receipt and forget the stock.
--
--   No second vendor. purchase_orders composite-FK vendors(id, institution_id)
--   from 00033, and the three-way match points at vendor_bills from the same
--   migration. Accounts payable already owns the creditor.
--
--   No second fee structure. The filing cites fee_structure_versions from
--   00045 — versioning was built so that "what we filed" stays retrievable
--   after the live structure moves on, which is exactly this problem.
--
--   No appraisal tables. HR has an annual appraisal feature in the backlog
--   (hr.hiring_growth.annual_performance_appraisal_kpi). Everything here is
--   prefixed evaluation_ and scoped to a 360 feedback cycle: no salary, no
--   increment, no KPI. An HR worker building appraisals should build
--   appraisal_* and may cite an evaluation cycle; the two must not merge,
--   because an appraisal is attributable by design and a 360 must not be.


-- ============================================================================
-- PART 1 — PURCHASING
-- ============================================================================

/* inventory_items had no composite key, so nothing could FK it tenant-safely.

   Purchase order lines and goods receipt lines both point at an item, and a
   line pointing at another school's item is the one referential error RLS
   does not catch — both rows are visible to their own policies, and the join
   simply returns nothing. Adding the composite target lets the FK carry the
   tenant, which is what vendors(id, institution_id) already does in 00033.
   Additive and idempotent — it changes nothing for existing rows. */
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'inventory_items_id_institution'
           AND conrelid = 'inventory_items'::regclass
    ) THEN
        ALTER TABLE inventory_items
            ADD CONSTRAINT inventory_items_id_institution UNIQUE (id, institution_id);
    END IF;
END $$;
-- +goose StatementEnd


/* Who may approve a requisition of this size.

   The threshold is the control. A school where the store keeper can approve
   anything has no purchasing control at all, and one where the correspondent
   must sign for a ream of paper has a control nobody obeys. So: a ladder of
   value bands, each naming the permission the approver must hold.

   The permission is a key from internal/rbac, not a role name and not a user
   id. Naming a user means the school stops being able to buy anything the
   week that person is on leave — naming a permission means the answer is
   whoever the school has already decided holds it.

   up_to_paise NULL is the top band — "everything above the one below". There
   is exactly one, enforced below, because two unbounded bands is a ladder
   with no top. */
CREATE TABLE purchase_approval_thresholds (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- What the school calls this rung. Shown on the requisition so the person
    -- raising it knows who they are waiting for.
    label           text NOT NULL,

    -- Inclusive ceiling in paise. NULL means unbounded.
    up_to_paise     bigint,

    -- The rbac key the approver must hold. Verified server-side in
    -- decidePurchaseRequisition; the UI hiding a button is not the control.
    approver_permission text NOT NULL,

    sort_order      integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT purchase_approval_thresholds_label CHECK (btrim(label) <> ''),
    CONSTRAINT purchase_approval_thresholds_ceiling
        CHECK (up_to_paise IS NULL OR up_to_paise > 0),
    CONSTRAINT purchase_approval_thresholds_permission
        CHECK (approver_permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

/* One ceiling per school, and only one unbounded band.

   THE NULLABLE-UNIQUE TRAP, first of five in this file. up_to_paise is
   nullable and NULL is distinct from every other NULL, so a bare
   UNIQUE (institution_id, up_to_paise) would permit any number of unbounded
   top bands — precisely the row whose duplication makes the ladder
   ambiguous. COALESCE to -1 collapses them into one comparable value. -1
   rather than 0 because 0 is a legal ceiling nobody would set but the CHECK
   above does not forbid at the type level. */
CREATE UNIQUE INDEX purchase_approval_thresholds_band
    ON purchase_approval_thresholds (institution_id, COALESCE(up_to_paise, -1));

COMMENT ON TABLE purchase_approval_thresholds IS
    'Value ladder deciding who may approve a purchase requisition. Each band names an rbac permission key, not a person. Read by internal/api/admin_ops.go; with no rows the handler falls back to a built-in two-rung ladder.';
COMMENT ON COLUMN purchase_approval_thresholds.up_to_paise IS
    'Inclusive ceiling in paise. NULL is the unbounded top band; at most one per school, enforced by purchase_approval_thresholds_band.';

ALTER TABLE purchase_approval_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_approval_thresholds FORCE  ROW LEVEL SECURITY;

CREATE POLICY purchase_approval_thresholds_tenant ON purchase_approval_thresholds
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_approval_thresholds TO app_user;


/* A department asking for something.

   The requisition is not the order. It is the record of who wanted what and
   who agreed to it, and it survives the order being cancelled — which is the
   whole reason it is a separate table rather than a draft status on
   purchase_orders. "Why did we buy forty chairs" is answered here.

   estimated_total_paise is stored rather than summed on demand because it is
   what the approval was given against. If a line is edited after approval the
   stored figure and the live sum disagree, and that disagreement is the thing
   the screen must show — recomputing it away would hide the amendment. */
CREATE TABLE purchase_requisitions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,

    requisition_no  text NOT NULL,
    department_id   uuid REFERENCES departments(id) ON DELETE SET NULL,
    requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    raised_on       date NOT NULL DEFAULT CURRENT_DATE,
    needed_by       date,

    -- Why. Required on submission by the handler, not here, because a draft
    -- being typed has not got there yet.
    justification   text,

    /* draft     — being written
       submitted — waiting on the approver the ladder names
       approved  — may become a purchase order
       rejected  — with a reason, which the CHECK below insists on
       ordered   — a purchase order cites it
       cancelled — withdrawn before decision */
    status          text NOT NULL DEFAULT 'draft',

    estimated_total_paise bigint NOT NULL DEFAULT 0,

    -- Which rung the value put it on, captured at submission. Stored because
    -- the ladder can be re-configured later and "who should have approved
    -- this" must not silently change afterwards.
    approval_band   text,
    approval_permission text,

    submitted_at    timestamptz,
    decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at      timestamptz,
    decision_note   text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT purchase_requisitions_status CHECK (status IN
        ('draft','submitted','approved','rejected','ordered','cancelled')),
    CONSTRAINT purchase_requisitions_no CHECK (btrim(requisition_no) <> ''),
    CONSTRAINT purchase_requisitions_total CHECK (estimated_total_paise >= 0),
    CONSTRAINT purchase_requisitions_needed_after_raised
        CHECK (needed_by IS NULL OR needed_by >= raised_on),
    -- A decision with no decider is a decision nobody made.
    CONSTRAINT purchase_requisitions_decision_evidenced
        CHECK (status NOT IN ('approved','rejected') OR decided_at IS NOT NULL),
    -- A rejection with no reason is the single most complained-about state in
    -- any purchasing system. The requester has to be told why.
    CONSTRAINT purchase_requisitions_rejection_reasoned
        CHECK (status <> 'rejected' OR nullif(btrim(decision_note), '') IS NOT NULL),
    CONSTRAINT purchase_requisitions_submitted_evidenced
        CHECK (status = 'draft' OR submitted_at IS NOT NULL),
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX purchase_requisitions_no_unique
    ON purchase_requisitions (institution_id, lower(btrim(requisition_no)));

-- The approver's queue.
CREATE INDEX purchase_requisitions_pending
    ON purchase_requisitions (institution_id, submitted_at)
 WHERE status = 'submitted';

COMMENT ON TABLE purchase_requisitions IS
    'A department asking to buy something. Separate from purchase_orders so the request survives the order: who wanted it and who agreed is answerable after the PO is cancelled.';
COMMENT ON COLUMN purchase_requisitions.estimated_total_paise IS
    'The value the approval was given against. Deliberately stored, not summed: a divergence from the live line sum is an amendment after approval, which the screen must show rather than hide.';

ALTER TABLE purchase_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_requisitions FORCE  ROW LEVEL SECURITY;

CREATE POLICY purchase_requisitions_tenant ON purchase_requisitions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_requisitions TO app_user;


/* What was asked for.

   item_id is nullable on purpose: half of what a school requisitions has
   never been in the stores catalogue — a repair, a one-off, a thing nobody
   has named yet. description carries those. A line with an item is
   receivable into stock — a line without one is not, and the goods receipt
   trigger below refuses it rather than inventing an item. */
CREATE TABLE purchase_requisition_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    requisition_id  uuid NOT NULL,
    item_id         uuid,
    description     text NOT NULL,
    quantity        integer NOT NULL,
    unit            text NOT NULL DEFAULT 'nos',
    estimated_unit_paise bigint NOT NULL DEFAULT 0,
    line_no         integer NOT NULL DEFAULT 1,

    CONSTRAINT purchase_requisition_lines_qty CHECK (quantity > 0),
    CONSTRAINT purchase_requisition_lines_rate CHECK (estimated_unit_paise >= 0),
    CONSTRAINT purchase_requisition_lines_desc CHECK (btrim(description) <> ''),
    FOREIGN KEY (requisition_id, institution_id)
        REFERENCES purchase_requisitions (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (item_id, institution_id)
        REFERENCES inventory_items (id, institution_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX purchase_requisition_lines_no
    ON purchase_requisition_lines (requisition_id, line_no);
CREATE INDEX purchase_requisition_lines_req
    ON purchase_requisition_lines (institution_id, requisition_id);

ALTER TABLE purchase_requisition_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_requisition_lines FORCE  ROW LEVEL SECURITY;

CREATE POLICY purchase_requisition_lines_tenant ON purchase_requisition_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_requisition_lines TO app_user;


/* The order placed on a vendor.

   vendor_id composite-FKs vendors(id, institution_id) from 00033 rather than
   introducing a purchasing-side supplier. A school that keeps two vendor
   lists reconciles them by hand for ever, and the payables screen is already
   the place a vendor's bank details and GSTIN live.

   requisition_id is nullable because emergency purchases happen — the bus
   breaks down on a Sunday. A PO with no requisition is a visible exception on
   the screen, which is the correct treatment: recording it is better than
   forcing a backdated requisition that fools the control. */
CREATE TABLE purchase_orders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,

    po_no           text NOT NULL,
    vendor_id       uuid NOT NULL,
    requisition_id  uuid,

    order_date      date NOT NULL DEFAULT CURRENT_DATE,
    expected_on     date,

    /* draft          — being prepared, may still be edited freely
       issued         — sent to the vendor, nothing received
       partly_received— some but not all lines fully received
       received       — every line received in full
       closed         — short-closed deliberately — no more is expected
       cancelled      — never fulfilled

       partly_received and received are maintained by trigger, not typed. A
       status somebody sets by hand and a receipt history that disagrees is
       how a school pays for a delivery that never came. */
    status          text NOT NULL DEFAULT 'draft',

    -- Freight, insurance and the like: real money on an Indian purchase order
    -- and not attributable to any one line.
    other_charges_paise bigint NOT NULL DEFAULT 0,
    terms           text,
    notes           text,

    issued_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    issued_at       timestamptz,
    closed_reason   text,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT purchase_orders_status CHECK (status IN
        ('draft','issued','partly_received','received','closed','cancelled')),
    CONSTRAINT purchase_orders_no CHECK (btrim(po_no) <> ''),
    CONSTRAINT purchase_orders_charges CHECK (other_charges_paise >= 0),
    CONSTRAINT purchase_orders_expected_after_order
        CHECK (expected_on IS NULL OR expected_on >= order_date),
    -- An order the vendor has is an order somebody sent.
    CONSTRAINT purchase_orders_issue_evidenced
        CHECK (status = 'draft' OR issued_at IS NOT NULL),
    CONSTRAINT purchase_orders_close_reasoned
        CHECK (status <> 'closed' OR nullif(btrim(closed_reason), '') IS NOT NULL),
    FOREIGN KEY (vendor_id, institution_id)
        REFERENCES vendors (id, institution_id) ON DELETE RESTRICT,
    FOREIGN KEY (requisition_id, institution_id)
        REFERENCES purchase_requisitions (id, institution_id) ON DELETE SET NULL,
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX purchase_orders_no_unique
    ON purchase_orders (institution_id, lower(btrim(po_no)));
CREATE INDEX purchase_orders_open
    ON purchase_orders (institution_id, expected_on)
 WHERE status IN ('issued','partly_received');
CREATE INDEX purchase_orders_vendor ON purchase_orders (institution_id, vendor_id);

COMMENT ON TABLE purchase_orders IS
    'A purchase order on an existing vendor (00033). status is trigger-maintained from goods receipts; never set partly_received or received by hand.';

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE  ROW LEVEL SECURITY;

CREATE POLICY purchase_orders_tenant ON purchase_orders
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_orders TO app_user;


/* One ordered line, and how much of it has arrived.

   received_qty is maintained by the goods receipt trigger. The CHECK beside
   it is the constraint the brief asks for and the one that matters:

       CHECK (quantity >= received_qty)

   An order for 100 chairs against which 40 have been received cannot be
   amended down to 20. The school would then be holding stock it has no
   authority for, the three-way match would show a receipt exceeding the
   order, and the natural human fix — quietly reduce the PO — is exactly the
   fraud pattern the match exists to catch. Enforced here, in the database,
   so it holds against a handler that forgets, a bulk update, and a psql
   session.

   tax_rate_bp is basis points: GST at 18% is 1800. Integer because a
   percentage stored as a float eventually produces a tax figure that does
   not tie to the vendor's invoice by one paisa, and then somebody spends an
   afternoon on it. */
CREATE TABLE purchase_order_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    purchase_order_id uuid NOT NULL,
    item_id         uuid,
    description     text NOT NULL,
    quantity        integer NOT NULL,
    unit            text NOT NULL DEFAULT 'nos',
    unit_price_paise bigint NOT NULL,
    tax_rate_bp     integer NOT NULL DEFAULT 0,
    line_no         integer NOT NULL DEFAULT 1,

    -- Trigger-maintained. Written only by sync_po_line_receipts().
    received_qty    integer NOT NULL DEFAULT 0,
    rejected_qty    integer NOT NULL DEFAULT 0,

    taxable_paise   bigint GENERATED ALWAYS AS (quantity::bigint * unit_price_paise) STORED,

    CONSTRAINT purchase_order_lines_qty CHECK (quantity > 0),
    CONSTRAINT purchase_order_lines_price CHECK (unit_price_paise >= 0),
    CONSTRAINT purchase_order_lines_tax CHECK (tax_rate_bp BETWEEN 0 AND 10000),
    CONSTRAINT purchase_order_lines_desc CHECK (btrim(description) <> ''),
    CONSTRAINT purchase_order_lines_received_non_negative
        CHECK (received_qty >= 0 AND rejected_qty >= 0),
    -- The one that matters. See the comment above.
    CONSTRAINT purchase_order_lines_not_below_received
        CHECK (quantity >= received_qty),
    FOREIGN KEY (purchase_order_id, institution_id)
        REFERENCES purchase_orders (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (item_id, institution_id)
        REFERENCES inventory_items (id, institution_id) ON DELETE RESTRICT,
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX purchase_order_lines_no
    ON purchase_order_lines (purchase_order_id, line_no);
CREATE INDEX purchase_order_lines_po
    ON purchase_order_lines (institution_id, purchase_order_id);
-- "What is still outstanding on open orders" — the buyer's chase list.
CREATE INDEX purchase_order_lines_outstanding
    ON purchase_order_lines (institution_id, purchase_order_id)
 WHERE received_qty < quantity;

COMMENT ON COLUMN purchase_order_lines.received_qty IS
    'Trigger-maintained from goods_receipt_lines. purchase_order_lines_not_below_received refuses an amendment that would drop the order below what has already arrived.';
COMMENT ON COLUMN purchase_order_lines.tax_rate_bp IS
    'GST rate in basis points; 18% is 1800. Integer so the tax figure ties to the vendor invoice exactly.';

ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE  ROW LEVEL SECURITY;

CREATE POLICY purchase_order_lines_tenant ON purchase_order_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_lines TO app_user;


/* The delivery note. One per arrival, not one per order.

   Partial delivery is the case that matters and the reason this is a table
   rather than a received_on column on the order: 60 chairs on Tuesday and 40
   on the following Monday is two documents, two dates, two people who signed
   for them, and possibly two different quantities rejected. */
CREATE TABLE goods_receipts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    purchase_order_id uuid NOT NULL,
    grn_no          text NOT NULL,
    received_on     date NOT NULL DEFAULT CURRENT_DATE,
    -- The vendor's own delivery document, so the two papers can be tied
    -- together when somebody queries the delivery six months later.
    challan_no      text,
    received_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    remarks         text,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT goods_receipts_no CHECK (btrim(grn_no) <> ''),
    FOREIGN KEY (purchase_order_id, institution_id)
        REFERENCES purchase_orders (id, institution_id) ON DELETE CASCADE,
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX goods_receipts_no_unique
    ON goods_receipts (institution_id, lower(btrim(grn_no)));
CREATE INDEX goods_receipts_po ON goods_receipts (institution_id, purchase_order_id);

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE  ROW LEVEL SECURITY;

CREATE POLICY goods_receipts_tenant ON goods_receipts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON goods_receipts TO app_user;


/* What actually arrived, line by line, and the stock movement it caused.

   inventory_movement_id is set by the trigger below, not by the handler. It
   is the evidence that this receipt reached the stores ledger: a row here
   with a null movement and an item set would mean stock the school believes
   it has and cannot find, so the trigger writes both or neither. */
CREATE TABLE goods_receipt_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    goods_receipt_id uuid NOT NULL,
    purchase_order_line_id uuid NOT NULL,

    quantity_received integer NOT NULL,
    -- Damaged, wrong specification, short weight. Rejected goods are received
    -- physically and never enter stock, so this figure moves no inventory and
    -- is not payable.
    quantity_rejected integer NOT NULL DEFAULT 0,
    rejection_reason  text,

    -- Written by sync_po_line_receipts(); see the trigger.
    inventory_movement_id uuid REFERENCES inventory_movements(id) ON DELETE SET NULL,

    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT goods_receipt_lines_qty
        CHECK (quantity_received >= 0 AND quantity_rejected >= 0),
    CONSTRAINT goods_receipt_lines_something_arrived
        CHECK (quantity_received + quantity_rejected > 0),
    CONSTRAINT goods_receipt_lines_rejection_reasoned
        CHECK (quantity_rejected = 0 OR nullif(btrim(rejection_reason), '') IS NOT NULL),
    FOREIGN KEY (goods_receipt_id, institution_id)
        REFERENCES goods_receipts (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (purchase_order_line_id, institution_id)
        REFERENCES purchase_order_lines (id, institution_id) ON DELETE CASCADE
);

-- One row per PO line per GRN. Receiving the same line twice on one delivery
-- note is a double entry, and the second one is always the mistake.
CREATE UNIQUE INDEX goods_receipt_lines_one_per_line
    ON goods_receipt_lines (goods_receipt_id, purchase_order_line_id);
CREATE INDEX goods_receipt_lines_po_line
    ON goods_receipt_lines (institution_id, purchase_order_line_id);

ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_lines FORCE  ROW LEVEL SECURITY;

CREATE POLICY goods_receipt_lines_tenant ON goods_receipt_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON goods_receipt_lines TO app_user;


/* Receiving goods moves stock. In the database, so it cannot be forgotten.

   A BEFORE INSERT trigger rather than an AFTER one, because the movement's id
   goes back onto this row and the link must exist from the first moment the
   row does.

   Only lines carrying an inventory item move stock. A requisition for a
   repair, or a service, is receivable and has no shelf to sit on — inventing
   an inventory_items row for "annual AMC" would fill the stores screen with
   things that are not stock. Those lines record the receipt and move
   nothing, which is the truth.

   The movement is kind='receipt', which the existing sync_inventory_on_hand()
   trigger from 00005 already understands — it recomputes
   inventory_items.on_hand from the whole movement history, so nothing here
   touches a balance. unit_cost_paise carries the PO price so a later stores
   valuation has a cost, and reference carries the GRN number so a stores
   clerk looking at a movement can find the delivery note. */
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION po_receipt_to_stock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_item uuid;
    v_price bigint;
    v_grn text;
    v_when date;
    v_by uuid;
    v_move uuid;
BEGIN
    IF NEW.quantity_received = 0 THEN
        RETURN NEW;
    END IF;

    SELECT l.item_id, l.unit_price_paise INTO v_item, v_price
      FROM purchase_order_lines l WHERE l.id = NEW.purchase_order_line_id;

    IF v_item IS NULL THEN
        RETURN NEW;                    -- a service or one-off; nothing to shelve
    END IF;

    SELECT g.grn_no, g.received_on, g.received_by INTO v_grn, v_when, v_by
      FROM goods_receipts g WHERE g.id = NEW.goods_receipt_id;

    INSERT INTO inventory_movements (institution_id, item_id, kind, quantity,
                                     unit_cost_paise, reference, moved_on,
                                     remarks, created_by)
    VALUES (NEW.institution_id, v_item, 'receipt', NEW.quantity_received,
            v_price, v_grn, v_when, 'Goods receipt against purchase order', v_by)
    RETURNING id INTO v_move;

    NEW.inventory_movement_id := v_move;
    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS goods_receipt_lines_to_stock ON goods_receipt_lines;
CREATE TRIGGER goods_receipt_lines_to_stock
    BEFORE INSERT ON goods_receipt_lines
    FOR EACH ROW EXECUTE FUNCTION po_receipt_to_stock();


/* Roll the receipt up onto the order line, and the line up onto the order.

   Recomputed from the whole receipt history rather than incremented, for the
   same reason sync_inventory_on_hand() does: a counter that drifts is worse
   than no counter, and a delete has to be able to put it back.

   The status ladder deliberately leaves draft, closed and cancelled alone. A
   short-closed order stays short-closed when the last delivery finally turns
   up two months later — that is a decision the school made and this trigger
   is not entitled to reverse it. */
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION sync_po_line_receipts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_line uuid := COALESCE(NEW.purchase_order_line_id, OLD.purchase_order_line_id);
    v_po   uuid;
BEGIN
    UPDATE purchase_order_lines l
       SET received_qty = COALESCE((
               SELECT sum(g.quantity_received) FROM goods_receipt_lines g
                WHERE g.purchase_order_line_id = v_line), 0),
           rejected_qty = COALESCE((
               SELECT sum(g.quantity_rejected) FROM goods_receipt_lines g
                WHERE g.purchase_order_line_id = v_line), 0)
     WHERE l.id = v_line
    RETURNING l.purchase_order_id INTO v_po;

    IF v_po IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE purchase_orders o
       SET status = CASE
               WHEN NOT EXISTS (SELECT 1 FROM purchase_order_lines l
                                 WHERE l.purchase_order_id = v_po
                                   AND l.received_qty < l.quantity) THEN 'received'
               WHEN EXISTS (SELECT 1 FROM purchase_order_lines l
                             WHERE l.purchase_order_id = v_po
                               AND l.received_qty > 0) THEN 'partly_received'
               ELSE 'issued' END,
           updated_at = now()
     WHERE o.id = v_po
       AND o.status IN ('issued','partly_received','received');

    RETURN NULL;
END $$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS goods_receipt_lines_sync ON goods_receipt_lines;
CREATE TRIGGER goods_receipt_lines_sync
    AFTER INSERT OR UPDATE OR DELETE ON goods_receipt_lines
    FOR EACH ROW EXECUTE FUNCTION sync_po_line_receipts();


/* The third leg: the vendor's bill against the order and the receipt.

   Three-way matching is what stops a school paying for what never arrived.
   Two of the three legs already exist — purchase_orders here, vendor_bills in
   00033 — and this table is the reconciliation between them plus the receipt.

   The three figures are stored as at the moment of matching rather than
   recomputed on read. A match is a decision somebody made against the numbers
   in front of them — if a later amendment moves a figure, the screen must show
   that the match no longer holds, which it cannot do if the stored answer
   silently follows the input.

   status is what the school decided, never what the arithmetic knows:
     matched            — the three agree inside tolerance, pay it
     variance_accepted  — they do not agree, somebody with authority said pay
                          anyway, and said why
     blocked            — do not pay until this is explained */
CREATE TABLE purchase_invoice_matches (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    purchase_order_id uuid NOT NULL,
    vendor_bill_id  uuid NOT NULL,

    ordered_paise   bigint NOT NULL,
    received_paise  bigint NOT NULL,
    invoiced_paise  bigint NOT NULL,
    -- Received against invoiced. This, not ordered-against-invoiced, is the
    -- exposure: an invoice for goods that never came.
    variance_paise  bigint GENERATED ALWAYS AS (invoiced_paise - received_paise) STORED,

    status          text NOT NULL DEFAULT 'blocked',
    matched_on      date NOT NULL DEFAULT CURRENT_DATE,
    decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at      timestamptz,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT purchase_invoice_matches_status
        CHECK (status IN ('matched','variance_accepted','blocked')),
    CONSTRAINT purchase_invoice_matches_amounts
        CHECK (ordered_paise >= 0 AND received_paise >= 0 AND invoiced_paise >= 0),
    -- Accepting a variance without saying why is the whole control defeated.
    CONSTRAINT purchase_invoice_matches_variance_reasoned
        CHECK (status <> 'variance_accepted'
               OR (nullif(btrim(note), '') IS NOT NULL AND decided_at IS NOT NULL)),
    FOREIGN KEY (purchase_order_id, institution_id)
        REFERENCES purchase_orders (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (vendor_bill_id, institution_id)
        REFERENCES vendor_bills (id, institution_id) ON DELETE CASCADE
);

-- One bill matches one order. A bill spanning two orders is two bills as far
-- as the vendor's own numbering is concerned, and treating it otherwise makes
-- the duplicate-payment control unenforceable.
CREATE UNIQUE INDEX purchase_invoice_matches_one_per_bill
    ON purchase_invoice_matches (institution_id, vendor_bill_id);
CREATE INDEX purchase_invoice_matches_po
    ON purchase_invoice_matches (institution_id, purchase_order_id);

COMMENT ON TABLE purchase_invoice_matches IS
    'Three-way match: purchase order, goods receipt, vendor bill. Figures are frozen as at the match; a later amendment must show the match as stale rather than silently re-agreeing.';

ALTER TABLE purchase_invoice_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_invoice_matches FORCE  ROW LEVEL SECURITY;

CREATE POLICY purchase_invoice_matches_tenant ON purchase_invoice_matches
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_invoice_matches TO app_user;


-- ============================================================================
-- PART 2 — MID-DAY MEAL UTILISATION
-- ============================================================================

/* The per-child entitlement, which is what makes a consumption figure
   checkable.

   PM POSHAN sets a foodgrain quantity and a cooking cost per child per meal
   day, different for primary (classes 1-5) and upper primary (6-8), and both
   are revised by circular every few years. So: a table, with an effective
   date, and not a constant in Go — a school reconciling last April's return
   needs last April's rate, and a hard-coded figure makes every historical
   return wrong the day the rate changes.

   grain_grams is grams, not paise. Weight and money are different quantities
   and a schema that puts rice in a paise column is one that eventually
   reports 100 g as a rupee value. */
CREATE TABLE mdm_norms (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

    -- 'primary' is classes 1-5, 'upper_primary' 6-8. The scheme's own split.
    stage           text NOT NULL,
    effective_from  date NOT NULL,

    grain_grams_per_child integer NOT NULL,
    cooking_cost_paise_per_child bigint NOT NULL,
    -- What the grain actually is. Rice in the south, wheat in much of the
    -- north, and a return that says "kg" without saying of what is not a
    -- return anybody can check.
    grain           text NOT NULL DEFAULT 'rice',

    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mdm_norms_stage CHECK (stage IN ('primary','upper_primary')),
    CONSTRAINT mdm_norms_grain_positive CHECK (grain_grams_per_child > 0),
    CONSTRAINT mdm_norms_cost_positive CHECK (cooking_cost_paise_per_child > 0),
    CONSTRAINT mdm_norms_grain_named CHECK (btrim(grain) <> '')
);

-- All three columns are NOT NULL, so this needs no COALESCE.
CREATE UNIQUE INDEX mdm_norms_one_per_stage_date
    ON mdm_norms (institution_id, stage, effective_from);

COMMENT ON TABLE mdm_norms IS
    'PM POSHAN per-child entitlement by stage, with an effective date. Dated rather than constant so a historical return reconciles against the rate that applied at the time.';

ALTER TABLE mdm_norms ENABLE ROW LEVEL SECURITY;
ALTER TABLE mdm_norms FORCE  ROW LEVEL SECURITY;

CREATE POLICY mdm_norms_tenant ON mdm_norms
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON mdm_norms TO app_user;


/* Foodgrain lifted from the FCI godown or the fair price shop.

   The return reconciles consumption against what was lifted, so the lifting
   has to be recorded somewhere. Not inventory_movements: that ledger's
   quantity is integer, and grain is weighed to the kilogram and often to
   three decimals on a challan. Rounding a school's rice to whole units would
   put the arithmetic error straight into a government return.

   quantity_kg is numeric(12,3) and carries its own unit in `grain`. There is
   no money column here on purpose — foodgrain under PM POSHAN is issued free
   against an allocation, and a value on this row would invite somebody to add
   it to the cooking cost. */
CREATE TABLE mdm_foodgrain_receipts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,

    lifted_on       date NOT NULL DEFAULT CURRENT_DATE,
    grain           text NOT NULL DEFAULT 'rice',
    quantity_kg     numeric(12,3) NOT NULL,
    -- FCI, the fair price shop, the block office. Free text: the source
    -- vocabulary differs by state and a CHECK list would be wrong somewhere.
    source          text,
    challan_no      text,
    remarks         text,
    recorded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mdm_foodgrain_receipts_qty CHECK (quantity_kg > 0),
    CONSTRAINT mdm_foodgrain_receipts_grain CHECK (btrim(grain) <> '')
);

/* One challan number per school per grain.

   THE NULLABLE-UNIQUE TRAP again: challan_no is nullable, because a
   hand-written slip from the block office often has no number on it. Bare,
   this index would enforce nothing at all for the rows that do carry one. The
   COALESCE to the empty string collapses the unnumbered rows into a single
   comparable value, and the partial predicate then exempts them — several
   unnumbered liftings in a month are normal, two rows claiming the same real
   challan are a double count in the return. */
CREATE UNIQUE INDEX mdm_foodgrain_receipts_challan
    ON mdm_foodgrain_receipts (institution_id, grain, lower(btrim(COALESCE(challan_no, ''))))
 WHERE nullif(btrim(challan_no), '') IS NOT NULL;

-- Do not use lifted_on::date in an index: it is already a date, and casting
-- an already-typed column adds nothing. Plain composite, month queries scan it.
CREATE INDEX mdm_foodgrain_receipts_period
    ON mdm_foodgrain_receipts (institution_id, lifted_on);

COMMENT ON TABLE mdm_foodgrain_receipts IS
    'Foodgrain lifted against the PM POSHAN allocation. Weight in numeric kg with its own grain column — deliberately not inventory_movements, whose integer quantity cannot carry a challan weight.';

ALTER TABLE mdm_foodgrain_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mdm_foodgrain_receipts FORCE  ROW LEVEL SECURITY;

CREATE POLICY mdm_foodgrain_receipts_tenant ON mdm_foodgrain_receipts
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON mdm_foodgrain_receipts TO app_user;


/* The monthly return the school actually files.

   Everything countable on it is aggregated from mdm_registers (00008) and
   mdm_foodgrain_receipts above, and the report endpoint computes those live.
   What is stored here is the part the arithmetic cannot know:

     - the opening balances, which come from last month's closing and, for the
       very first month, from a paper register nobody is going to key in.
     - what the government actually allotted and released, which arrives by
       sanction order and is not derivable from anything the school records.
     - the school's explanation of any gap, which is the entire reason a
       return gets accepted or sent back.

   And, once finalised, a frozen copy. filed_figures is the return as
   submitted: a month closed in April must still read in November exactly as
   it read when the block officer received it, whatever has since been
   backdated into the daily register. Recomputing a filed return is how a
   school ends up unable to explain its own submission. */
CREATE TABLE mdm_monthly_returns (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,

    -- Always the first of the month. A CHECK rather than a convention,
    -- because a return dated the 17th silently becomes a second return for
    -- the same month.
    period_month    date NOT NULL,

    status          text NOT NULL DEFAULT 'draft',

    -- Foodgrain, in kg. Opening and allotment are entered; consumption and
    -- closing are computed by the report and copied into filed_figures on
    -- finalisation.
    opening_grain_kg   numeric(12,3) NOT NULL DEFAULT 0,
    allotted_grain_kg  numeric(12,3) NOT NULL DEFAULT 0,

    -- Cooking cost, in paise. Same split: allotted and released are facts
    -- from the sanction order, expenditure is summed from the register.
    opening_cost_paise    bigint NOT NULL DEFAULT 0,
    allotted_cost_paise   bigint NOT NULL DEFAULT 0,
    released_cost_paise   bigint NOT NULL DEFAULT 0,

    -- Working days as the school declares them for the return. Nullable: the
    -- report derives a figure from the holiday calendar, and this overrides
    -- it only where the school has a reason.
    declared_working_days integer,

    -- The gap explanation. A return whose meal days fall short of its working
    -- days and says nothing about why is a return that comes back.
    variance_explanation  text,
    remarks               text,

    /* The frozen return. Written once, on finalisation, by the handler.
       Empty while the return is a draft. */
    filed_figures   jsonb NOT NULL DEFAULT '{}'::jsonb,

    finalised_at    timestamptz,
    finalised_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    filed_on        date,
    acknowledgement_no text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mdm_monthly_returns_status
        CHECK (status IN ('draft','finalised','filed')),
    CONSTRAINT mdm_monthly_returns_month_start
        CHECK (period_month = date_trunc('month', period_month)::date),
    CONSTRAINT mdm_monthly_returns_grain
        CHECK (opening_grain_kg >= 0 AND allotted_grain_kg >= 0),
    CONSTRAINT mdm_monthly_returns_money
        CHECK (opening_cost_paise >= 0 AND allotted_cost_paise >= 0
               AND released_cost_paise >= 0),
    CONSTRAINT mdm_monthly_returns_working_days
        CHECK (declared_working_days IS NULL
               OR declared_working_days BETWEEN 0 AND 31),
    -- A finalised return has a frozen copy and somebody who froze it.
    CONSTRAINT mdm_monthly_returns_finalisation
        CHECK ((status = 'draft') = (finalised_at IS NULL)),
    CONSTRAINT mdm_monthly_returns_frozen_when_final
        CHECK (status = 'draft' OR filed_figures <> '{}'::jsonb),
    CONSTRAINT mdm_monthly_returns_filed_evidenced
        CHECK (status <> 'filed' OR filed_on IS NOT NULL)
);

/* One return per campus per month.

   THE NULLABLE-UNIQUE TRAP. campus_id is nullable — a single-campus school
   files school-wide and leaves it null — and that is the common case, so a
   bare unique would enforce nothing for almost every school in the product.
   COALESCE to the zero uuid is what actually stops two returns for April.

   mdm_registers (00008) has this same shape written bare and therefore
   unenforced — noted for whoever next touches that table, not fixed here,
   because it is not this migration's to alter and duplicate register rows may
   already exist in production. The report endpoint sums the register, so it
   is correct either way. */
CREATE UNIQUE INDEX mdm_monthly_returns_one_per_month
    ON mdm_monthly_returns (
        institution_id,
        COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid),
        period_month);

COMMENT ON TABLE mdm_monthly_returns IS
    'The monthly PM POSHAN utilisation return. Stores only what aggregation cannot know — opening balances, sanctioned allotments, the explanation — plus filed_figures, the frozen copy of what was submitted.';
COMMENT ON COLUMN mdm_monthly_returns.filed_figures IS
    'The return as submitted, frozen at finalisation. Never recomputed: a closed month must read in November exactly as the block officer received it in April.';

ALTER TABLE mdm_monthly_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE mdm_monthly_returns FORCE  ROW LEVEL SECURITY;

CREATE POLICY mdm_monthly_returns_tenant ON mdm_monthly_returns
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON mdm_monthly_returns TO app_user;

/* A finalised return does not change.

   Enforced by trigger rather than by the handler because the point of
   freezing is that nothing can move it — not a second handler written next
   year, not a bulk fix, not psql. Reopening is a deliberate act: set status
   back to 'draft', which clears the freeze, and which the handler audits. */
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION mdm_return_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.status = 'draft' THEN
        RETURN NEW;
    END IF;
    -- Reopening, and the acknowledgement/filing details, are the only moves
    -- allowed once finalised.
    IF NEW.status = 'draft' THEN
        RETURN NEW;
    END IF;
    IF NEW.filed_figures IS DISTINCT FROM OLD.filed_figures
       OR NEW.period_month IS DISTINCT FROM OLD.period_month
       OR NEW.opening_grain_kg IS DISTINCT FROM OLD.opening_grain_kg
       OR NEW.allotted_grain_kg IS DISTINCT FROM OLD.allotted_grain_kg
       OR NEW.opening_cost_paise IS DISTINCT FROM OLD.opening_cost_paise
       OR NEW.allotted_cost_paise IS DISTINCT FROM OLD.allotted_cost_paise
       OR NEW.released_cost_paise IS DISTINCT FROM OLD.released_cost_paise THEN
        RAISE EXCEPTION 'this return is finalised; reopen it before changing the figures'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS mdm_monthly_returns_frozen ON mdm_monthly_returns;
CREATE TRIGGER mdm_monthly_returns_frozen
    BEFORE UPDATE ON mdm_monthly_returns
    FOR EACH ROW EXECUTE FUNCTION mdm_return_frozen();


-- ============================================================================
-- PART 3 — 360 EVALUATION OVERSIGHT
-- ============================================================================
--
-- Scoped to feedback, not to pay. There is no increment, no KPI and no
-- salary anywhere in these six tables, because HR has an appraisal feature in
-- the backlog and the two instruments have opposite requirements: an
-- appraisal must be attributable to the manager who wrote it, and a 360 is
-- worthless if it is attributable to the peer who wrote it.

/* One round of feedback the principal is running.

   min_responses is the anonymity floor and the reason this table exists
   rather than a status column on the employee. Below it, no aggregate is
   released at all — not "2 responses, average 3.5", which with two peers
   named on the invitation list is a sentence about two identifiable people.
   Three is the usual floor — the school may raise it and the CHECK refuses to
   let anyone drop it below two. */
CREATE TABLE evaluation_cycles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,

    name            text NOT NULL,
    purpose         text,
    opens_on        date NOT NULL DEFAULT CURRENT_DATE,
    closes_on       date NOT NULL,

    /* draft    — questions being written, nobody invited
       open     — invitations out, responses arriving
       closed   — no more responses — results computed but not visible to the
                  people they are about
       released — the subject may see their own aggregate */
    status          text NOT NULL DEFAULT 'draft',

    -- The anonymity floor. See the table comment.
    min_responses   integer NOT NULL DEFAULT 3,

    -- Which directions this cycle gathers from, as a sorted set. Held on the
    -- cycle so the oversight screen can show "3 of 4 peers, head not yet"
    -- without inferring the expected set from the invitations that happen to
    -- exist.
    relations       text[] NOT NULL DEFAULT ARRAY['head','peer','self'],

    released_at     timestamptz,
    released_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT evaluation_cycles_status
        CHECK (status IN ('draft','open','closed','released')),
    CONSTRAINT evaluation_cycles_name CHECK (btrim(name) <> ''),
    CONSTRAINT evaluation_cycles_window CHECK (closes_on >= opens_on),
    -- Two is the arithmetic minimum for an average to conceal anything, and
    -- even two is thin. The floor cannot be configured away.
    CONSTRAINT evaluation_cycles_anonymity_floor
        CHECK (min_responses >= 2),
    CONSTRAINT evaluation_cycles_relations_known
        CHECK (relations <@ ARRAY['head','peer','self','student','parent']
               AND array_length(relations, 1) >= 1),
    CONSTRAINT evaluation_cycles_release_evidenced
        CHECK ((status = 'released') = (released_at IS NOT NULL)),
    UNIQUE (id, institution_id)
);

/* One cycle of a given name per year.

   THE NULLABLE-UNIQUE TRAP. academic_year_id is nullable — a cycle run
   outside the academic frame, say on joining — so bare, this would permit
   unlimited "Annual 360" rows, which is exactly the duplicate that makes two
   half-populated cycles for the same round. */
CREATE UNIQUE INDEX evaluation_cycles_one_per_name
    ON evaluation_cycles (
        institution_id,
        lower(btrim(name)),
        COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX evaluation_cycles_open
    ON evaluation_cycles (institution_id, closes_on) WHERE status = 'open';

COMMENT ON TABLE evaluation_cycles IS
    'One 360 feedback round. min_responses is the anonymity floor: below it no aggregate is released at all. Feedback only — no pay, no increment, no KPI; staff appraisal is a separate HR concern and must not be merged into these tables.';
COMMENT ON COLUMN evaluation_cycles.min_responses IS
    'Minimum responses in a relation before its aggregate may be shown. Enforced server-side in internal/api/admin_ops.go, not in the UI. Floor of 2 is a CHECK.';

ALTER TABLE evaluation_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_cycles FORCE  ROW LEVEL SECURITY;

CREATE POLICY evaluation_cycles_tenant ON evaluation_cycles
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON evaluation_cycles TO app_user;


/* What is asked.

   kind='rating' produces a number that can be averaged and therefore
   anonymised. kind='text' produces a comment, which cannot: a free-text
   answer is identifiable by its phrasing however many people wrote one.
   Comments are released only in bulk and only after the floor is met, and the
   API never returns them attributed. */
CREATE TABLE evaluation_questions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    cycle_id        uuid NOT NULL,
    seq             integer NOT NULL,
    prompt          text NOT NULL,
    kind            text NOT NULL DEFAULT 'rating',
    max_rating      integer NOT NULL DEFAULT 5,
    -- Which directions answer this one. A question about classroom practice
    -- goes to the head and to students, not to the accounts clerk next door.
    asked_of        text[] NOT NULL DEFAULT ARRAY['head','peer','self'],

    CONSTRAINT evaluation_questions_kind CHECK (kind IN ('rating','text')),
    CONSTRAINT evaluation_questions_prompt CHECK (btrim(prompt) <> ''),
    CONSTRAINT evaluation_questions_scale CHECK (max_rating BETWEEN 2 AND 10),
    CONSTRAINT evaluation_questions_seq CHECK (seq > 0),
    CONSTRAINT evaluation_questions_asked_of_known
        CHECK (asked_of <@ ARRAY['head','peer','self','student','parent']),
    FOREIGN KEY (cycle_id, institution_id)
        REFERENCES evaluation_cycles (id, institution_id) ON DELETE CASCADE,
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX evaluation_questions_seq_unique
    ON evaluation_questions (cycle_id, seq);

ALTER TABLE evaluation_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_questions FORCE  ROW LEVEL SECURITY;

CREATE POLICY evaluation_questions_tenant ON evaluation_questions
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON evaluation_questions TO app_user;


/* Who is being evaluated.

   Named reviewees rather than subjects: "subject" in this codebase is a
   school subject, and a table called evaluation_subjects would be read as
   Physics by every person who came after.

   Keyed on employees, not users. A 360 is about a member of staff, and
   employees is the staff register — a teacher with no login still has a head
   who can be asked about them. */
CREATE TABLE evaluation_reviewees (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    cycle_id        uuid NOT NULL,
    employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- Released per person, not per cycle: a cycle can be released for the
    -- twenty people whose feedback is complete while three stragglers stay
    -- open.
    released_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (cycle_id, institution_id)
        REFERENCES evaluation_cycles (id, institution_id) ON DELETE CASCADE,
    UNIQUE (id, institution_id)
);

-- Both columns NOT NULL; no COALESCE needed.
CREATE UNIQUE INDEX evaluation_reviewees_one_per_cycle
    ON evaluation_reviewees (cycle_id, employee_id);
CREATE INDEX evaluation_reviewees_cycle
    ON evaluation_reviewees (institution_id, cycle_id);

ALTER TABLE evaluation_reviewees ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_reviewees FORCE  ROW LEVEL SECURITY;

CREATE POLICY evaluation_reviewees_tenant ON evaluation_reviewees
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON evaluation_reviewees TO app_user;


/* Who was asked, and whether they have answered.

   This table carries identity. It has to: the whole oversight feature is
   "who has not responded yet", and a chase list needs names.

   What it does NOT carry is any link to what they said. There is no
   response_id here and no invitation_id on evaluation_responses. That
   severance is the anonymity mechanism, and it is structural rather than
   procedural: there is no join, in any direction, that reconnects a person to
   their answers. A future handler cannot accidentally expose the link because
   the link does not exist in the schema.

   responded_at is therefore the only thing a submission writes back here —
   the fact of it, not the content. */
CREATE TABLE evaluation_invitations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    cycle_id        uuid NOT NULL,
    reviewee_id     uuid NOT NULL,

    relation        text NOT NULL,
    -- The person asked, where they have a login. Null for an invitation sent
    -- to a parent or an external observer, whom label names instead.
    respondent_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    respondent_label   text,

    status          text NOT NULL DEFAULT 'invited',
    invited_at      timestamptz NOT NULL DEFAULT now(),
    -- That they answered. Never what they answered.
    responded_at    timestamptz,
    declined_reason text,

    CONSTRAINT evaluation_invitations_relation
        CHECK (relation IN ('head','peer','self','student','parent')),
    CONSTRAINT evaluation_invitations_status
        CHECK (status IN ('invited','responded','declined','expired')),
    CONSTRAINT evaluation_invitations_response_evidenced
        CHECK ((status = 'responded') = (responded_at IS NOT NULL)),
    -- An invitation addressed to nobody cannot be chased.
    CONSTRAINT evaluation_invitations_addressed
        CHECK (respondent_user_id IS NOT NULL
               OR nullif(btrim(respondent_label), '') IS NOT NULL),
    FOREIGN KEY (cycle_id, institution_id)
        REFERENCES evaluation_cycles (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (reviewee_id, institution_id)
        REFERENCES evaluation_reviewees (id, institution_id) ON DELETE CASCADE
);

/* One invitation per person per reviewee per relation.

   THE NULLABLE-UNIQUE TRAP, and here it has a privacy consequence rather than
   merely a data-quality one. respondent_user_id is null for external
   respondents — bare, this index would let the same peer be invited twice,
   and two responses from one peer is both a skewed average and — once the
   count crosses min_responses on the strength of a duplicate — a released
   aggregate that is effectively one person's opinion. */
CREATE UNIQUE INDEX evaluation_invitations_one_per_respondent
    ON evaluation_invitations (
        reviewee_id,
        relation,
        COALESCE(respondent_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(btrim(COALESCE(respondent_label, ''))));

CREATE INDEX evaluation_invitations_outstanding
    ON evaluation_invitations (institution_id, cycle_id)
 WHERE status = 'invited';
-- The respondent's own queue: "what have I been asked to fill in".
CREATE INDEX evaluation_invitations_mine
    ON evaluation_invitations (respondent_user_id, status)
 WHERE respondent_user_id IS NOT NULL;

COMMENT ON TABLE evaluation_invitations IS
    'Who was asked and whether they answered. Deliberately holds NO link to evaluation_responses: the severance is what makes the instrument anonymous, and it is structural, so no future handler can reconnect them.';

ALTER TABLE evaluation_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_invitations FORCE  ROW LEVEL SECURITY;

CREATE POLICY evaluation_invitations_tenant ON evaluation_invitations
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON evaluation_invitations TO app_user;


/* One submitted response. Note what is absent.

   No respondent column of any kind — not a user id, not an invitation id, not
   an email, not a token. The relation is kept because "the head said 4, the
   peers averaged 3" is the entire value of a 360 and is not identifying on
   its own — where a reviewee has exactly one head, the head's row is
   identifiable by construction, which is why 'head' is treated as attributed
   in the API and shown as such to the reviewee rather than pretending
   otherwise.

   submitted_at is a timestamptz and is a real, small identification risk on
   its own — a cycle with three peers and three timestamps is correlatable
   against, say, a login log. The API therefore never returns it for a
   reviewee-facing view — oversight sees counts and the daily shape, not the
   moment. */
CREATE TABLE evaluation_responses (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    cycle_id        uuid NOT NULL,
    reviewee_id     uuid NOT NULL,
    relation        text NOT NULL,
    submitted_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT evaluation_responses_relation
        CHECK (relation IN ('head','peer','self','student','parent')),
    FOREIGN KEY (cycle_id, institution_id)
        REFERENCES evaluation_cycles (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (reviewee_id, institution_id)
        REFERENCES evaluation_reviewees (id, institution_id) ON DELETE CASCADE,
    UNIQUE (id, institution_id)
);

CREATE INDEX evaluation_responses_reviewee
    ON evaluation_responses (reviewee_id, relation);

COMMENT ON TABLE evaluation_responses IS
    'A submitted 360 response. Carries no respondent identity of any kind, by design — there is no column and no join that could reconnect it to evaluation_invitations.';

ALTER TABLE evaluation_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_responses FORCE  ROW LEVEL SECURITY;

CREATE POLICY evaluation_responses_tenant ON evaluation_responses
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON evaluation_responses TO app_user;


CREATE TABLE evaluation_answers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    response_id     uuid NOT NULL,
    question_id     uuid NOT NULL,
    rating          integer,
    comment         text,

    CONSTRAINT evaluation_answers_rating CHECK (rating IS NULL OR rating >= 1),
    -- An answer that is neither a rating nor a comment is a row that says
    -- nothing and still counts towards the anonymity floor.
    CONSTRAINT evaluation_answers_has_content
        CHECK (rating IS NOT NULL OR nullif(btrim(comment), '') IS NOT NULL),
    FOREIGN KEY (response_id, institution_id)
        REFERENCES evaluation_responses (id, institution_id) ON DELETE CASCADE,
    FOREIGN KEY (question_id, institution_id)
        REFERENCES evaluation_questions (id, institution_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX evaluation_answers_one_per_question
    ON evaluation_answers (response_id, question_id);
CREATE INDEX evaluation_answers_question
    ON evaluation_answers (institution_id, question_id);

ALTER TABLE evaluation_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_answers FORCE  ROW LEVEL SECURITY;

CREATE POLICY evaluation_answers_tenant ON evaluation_answers
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON evaluation_answers TO app_user;

/* The rating must fit the scale it was asked on.

   A CHECK cannot reach the question's max_rating, so this is a trigger. Worth
   the trigger: a 7 on a 5-point scale silently drags an aggregate above the
   top of the scale, and the first person to notice is the teacher being told
   their peers rated them 5.4 out of 5. */
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION evaluation_answer_within_scale() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_kind text;
    v_max  integer;
BEGIN
    IF NEW.rating IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT kind, max_rating INTO v_kind, v_max
      FROM evaluation_questions WHERE id = NEW.question_id;
    IF v_kind = 'text' THEN
        RAISE EXCEPTION 'that question asks for a comment, not a rating'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.rating > v_max THEN
        RAISE EXCEPTION 'rating % is above the scale for this question (max %)',
            NEW.rating, v_max USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS evaluation_answers_scale ON evaluation_answers;
CREATE TRIGGER evaluation_answers_scale
    BEFORE INSERT OR UPDATE ON evaluation_answers
    FOR EACH ROW EXECUTE FUNCTION evaluation_answer_within_scale();


-- ============================================================================
-- PART 4 — FEE REGULATORY COMMITTEE FILING
-- ============================================================================

/* What the school filed with the district or state fee regulatory committee.

   Several states — Maharashtra, Tamil Nadu, Rajasthan, Gujarat, Karnataka
   among them — require a private unaided school to file its fee structure
   with a committee, support it with accounts, and then charge only what was
   approved. The exposure is the last clause: a school charging above the
   approved figure is liable to refund the difference to every parent, and
   nobody discovers it until an inspection.

   So the design is:

     fee_structure_version_id   what was filed, citing 00045's versioning
                                rather than the live structure. This is what
                                versioning was built for: the live structure
                                moves on, and the filing must not.
     filed_snapshot             the amounts as filed, frozen. Belt and braces
                                over the version reference, because a school
                                may file a proposal that is not yet any live
                                version at all.
     lines                      per head, per class, proposed and approved.
                                The variance report is proposed-vs-approved
                                joined to what invoice_lines actually charged.

   Supporting documents attach through fee_regulatory_filing_documents below,
   which holds a file_id into the existing files table. files.owner_type /
   owner_id look like the polymorphic answer and are dead columns — nothing in
   the codebase has ever written them — so following them would have been
   inventing a convention rather than reusing one. The live pattern is
   student_documents / employee_documents / application_documents: a typed
   join row carrying file_id and a doc_type. That is what is copied. */
CREATE TABLE fee_regulatory_filings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    campus_id       uuid REFERENCES campuses(id) ON DELETE CASCADE,

    filing_no       text NOT NULL,
    academic_year_id uuid REFERENCES academic_years(id) ON DELETE SET NULL,

    -- Who it goes to. The committee's name and level differ by state; free
    -- text with a small level vocabulary rather than a closed list of bodies.
    committee_name  text NOT NULL,
    committee_level text NOT NULL DEFAULT 'district',
    state           text,

    fee_structure_version_id uuid REFERENCES fee_structure_versions(id) ON DELETE RESTRICT,

    /* draft                     — being compiled
       submitted                 — filed, awaiting the committee
       approved                  — as filed
       approved_with_modification— the committee cut something — the approved
                                   amounts on the lines are what may be charged
       rejected                  — refile
       withdrawn                 — the school pulled it */
    status          text NOT NULL DEFAULT 'draft',

    submitted_on    date,
    acknowledgement_no text,
    decided_on      date,
    decision_note   text,
    decided_recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,

    -- Frozen at submission. See the table comment.
    filed_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,

    prepared_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fee_regulatory_filings_status CHECK (status IN
        ('draft','submitted','approved','approved_with_modification',
         'rejected','withdrawn')),
    CONSTRAINT fee_regulatory_filings_level
        CHECK (committee_level IN ('district','division','state')),
    CONSTRAINT fee_regulatory_filings_no CHECK (btrim(filing_no) <> ''),
    CONSTRAINT fee_regulatory_filings_committee CHECK (btrim(committee_name) <> ''),
    -- A filing that has left the building has a date and a frozen copy.
    CONSTRAINT fee_regulatory_filings_submission_evidenced
        CHECK (status = 'draft' OR submitted_on IS NOT NULL),
    CONSTRAINT fee_regulatory_filings_snapshot_when_submitted
        CHECK (status = 'draft' OR filed_snapshot <> '{}'::jsonb),
    -- A decision is a date and a reason, or it is hearsay.
    CONSTRAINT fee_regulatory_filings_decision_evidenced
        CHECK (status NOT IN ('approved','approved_with_modification','rejected')
               OR decided_on IS NOT NULL),
    CONSTRAINT fee_regulatory_filings_modification_reasoned
        CHECK (status NOT IN ('approved_with_modification','rejected')
               OR nullif(btrim(decision_note), '') IS NOT NULL),
    UNIQUE (id, institution_id)
);

CREATE UNIQUE INDEX fee_regulatory_filings_no_unique
    ON fee_regulatory_filings (institution_id, lower(btrim(filing_no)));

/* One live filing per year per campus.

   THE NULLABLE-UNIQUE TRAP, twice over in one index: both campus_id and
   academic_year_id are nullable. Two concurrent live filings for the same
   year is the state in which nobody can say which approval the school is
   charging under — which is the exact question an inspection asks. Withdrawn
   and rejected filings are exempt by the predicate: refiling after a
   rejection is the normal path. */
CREATE UNIQUE INDEX fee_regulatory_filings_one_live
    ON fee_regulatory_filings (
        institution_id,
        COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid))
 WHERE status IN ('draft','submitted','approved','approved_with_modification');

COMMENT ON TABLE fee_regulatory_filings IS
    'A fee structure filed with a state or district fee regulatory committee, and the committee''s decision. filed_snapshot is immutable once submitted — what was filed must remain retrievable unchanged. Documents attach via files(owner_type=''fee_regulatory_filing'').';
COMMENT ON COLUMN fee_regulatory_filings.filed_snapshot IS
    'The filing as submitted, frozen by the fee_regulatory_filings_frozen trigger. Belt and braces over fee_structure_version_id, because a proposal may not correspond to any live version.';

ALTER TABLE fee_regulatory_filings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_regulatory_filings FORCE  ROW LEVEL SECURITY;

CREATE POLICY fee_regulatory_filings_tenant ON fee_regulatory_filings
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON fee_regulatory_filings TO app_user;


/* One head, one class, one instalment: proposed, and what came back approved.

   approved_paise is null until the committee decides, and stays null on a
   rejection. It is a separate column from proposed_paise rather than an
   overwrite because "approved with modification" is the interesting case and
   the school needs both numbers side by side: what we asked for, what we got,
   and — from invoice_lines — what we are actually charging. */
CREATE TABLE fee_regulatory_filing_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    filing_id       uuid NOT NULL,
    fee_head_id     uuid NOT NULL REFERENCES fee_heads(id) ON DELETE RESTRICT,
    -- Null means the head applies to every class in the filing.
    class_id        uuid REFERENCES classes(id) ON DELETE CASCADE,
    instalment_no   integer NOT NULL DEFAULT 1,

    proposed_paise  bigint NOT NULL,
    approved_paise  bigint,
    -- Why the committee cut it, in their words.
    modification_note text,

    CONSTRAINT fee_regulatory_filing_lines_proposed CHECK (proposed_paise >= 0),
    CONSTRAINT fee_regulatory_filing_lines_approved
        CHECK (approved_paise IS NULL OR approved_paise >= 0),
    CONSTRAINT fee_regulatory_filing_lines_instalment CHECK (instalment_no > 0),
    FOREIGN KEY (filing_id, institution_id)
        REFERENCES fee_regulatory_filings (id, institution_id) ON DELETE CASCADE
);

/* One line per head per class per instalment.

   THE NULLABLE-UNIQUE TRAP. class_id is nullable for a head that applies
   school-wide, and that is the common shape for admission and development
   fees. Bare, a school could file the same head twice and the total on the
   filing would double-count. */
CREATE UNIQUE INDEX fee_regulatory_filing_lines_one_per_head
    ON fee_regulatory_filing_lines (
        filing_id,
        fee_head_id,
        COALESCE(class_id, '00000000-0000-0000-0000-000000000000'::uuid),
        instalment_no);

CREATE INDEX fee_regulatory_filing_lines_filing
    ON fee_regulatory_filing_lines (institution_id, filing_id);

ALTER TABLE fee_regulatory_filing_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_regulatory_filing_lines FORCE  ROW LEVEL SECURITY;

CREATE POLICY fee_regulatory_filing_lines_tenant ON fee_regulatory_filing_lines
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON fee_regulatory_filing_lines TO app_user;


/* The supporting accounts.

   A filing without them is refused at the counter: the committee wants the
   audited balance sheet, the income and expenditure account, the salary
   statement and the fee proposal itself, and the checklist differs by state.
   So doc_type is free text with no CHECK list — a closed vocabulary would be
   wrong in the second state that adopted the product — and the required set
   is a client-side checklist rather than a constraint.

   file_id into files, following student_documents and employee_documents.
   ON DELETE CASCADE from the file because the row exists only to name a
   document: a document row whose file has gone is a dangling promise on a
   compliance screen. */
CREATE TABLE fee_regulatory_filing_documents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    filing_id       uuid NOT NULL,
    file_id         uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    doc_type        text NOT NULL,
    -- The period the document covers: "FY 2024-25" on a balance sheet. Free
    -- text because it is transcribed off the document, not computed.
    covers_period   text,
    notes           text,
    attached_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fee_regulatory_filing_documents_type CHECK (btrim(doc_type) <> ''),
    FOREIGN KEY (filing_id, institution_id)
        REFERENCES fee_regulatory_filings (id, institution_id) ON DELETE CASCADE
);

-- The same file attached twice under the same heading is a duplicate row on
-- the checklist and a reviewer wondering which one is current.
CREATE UNIQUE INDEX fee_regulatory_filing_documents_once
    ON fee_regulatory_filing_documents (filing_id, file_id);
CREATE INDEX fee_regulatory_filing_documents_filing
    ON fee_regulatory_filing_documents (institution_id, filing_id);

COMMENT ON TABLE fee_regulatory_filing_documents IS
    'Supporting accounts attached to a fee filing. Holds file_id into files, following student_documents — files.owner_type/owner_id are dead columns nothing in this codebase writes.';

ALTER TABLE fee_regulatory_filing_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_regulatory_filing_documents FORCE  ROW LEVEL SECURITY;

CREATE POLICY fee_regulatory_filing_documents_tenant ON fee_regulatory_filing_documents
    USING (institution_id = app_current_institution() OR app_is_platform_admin())
    WITH CHECK (institution_id = app_current_institution() OR app_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON fee_regulatory_filing_documents TO app_user;


/* What was filed stays filed.

   Once a filing is submitted, its snapshot, the version it cites and its
   proposed amounts are evidence. The committee holds a copy — a school whose
   own record has since been edited cannot explain the difference, and the
   difference is what an inspection will find.

   The decision fields stay writable — that is the whole point of the
   subsequent step — and so does a withdrawal. Everything else is frozen.
   Enforced by trigger, not in the handler, for the usual reason: a control
   that only one code path honours is not a control. */
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION fee_filing_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.status = 'draft' THEN
        RETURN NEW;
    END IF;
    IF NEW.filed_snapshot IS DISTINCT FROM OLD.filed_snapshot
       OR NEW.fee_structure_version_id IS DISTINCT FROM OLD.fee_structure_version_id
       OR NEW.submitted_on IS DISTINCT FROM OLD.submitted_on
       OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
       OR NEW.filing_no IS DISTINCT FROM OLD.filing_no THEN
        RAISE EXCEPTION 'this filing has been submitted; what was filed cannot be changed'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS fee_regulatory_filings_frozen ON fee_regulatory_filings;
CREATE TRIGGER fee_regulatory_filings_frozen
    BEFORE UPDATE ON fee_regulatory_filings
    FOR EACH ROW EXECUTE FUNCTION fee_filing_frozen();

/* And the lines with it. proposed_paise is part of what was filed.
   approved_paise and the committee's note are the reply and stay writable. */
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION fee_filing_line_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status FROM fee_regulatory_filings WHERE id = NEW.filing_id;
    IF v_status = 'draft' THEN
        RETURN NEW;
    END IF;
    IF NEW.proposed_paise IS DISTINCT FROM OLD.proposed_paise
       OR NEW.fee_head_id IS DISTINCT FROM OLD.fee_head_id
       OR NEW.class_id IS DISTINCT FROM OLD.class_id
       OR NEW.instalment_no IS DISTINCT FROM OLD.instalment_no THEN
        RAISE EXCEPTION 'this filing has been submitted; the amounts filed cannot be changed'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS fee_regulatory_filing_lines_frozen ON fee_regulatory_filing_lines;
CREATE TRIGGER fee_regulatory_filing_lines_frozen
    BEFORE UPDATE ON fee_regulatory_filing_lines
    FOR EACH ROW EXECUTE FUNCTION fee_filing_line_frozen();


-- +goose Down
DROP TRIGGER IF EXISTS fee_regulatory_filing_lines_frozen ON fee_regulatory_filing_lines;
DROP TRIGGER IF EXISTS fee_regulatory_filings_frozen ON fee_regulatory_filings;
DROP FUNCTION IF EXISTS fee_filing_line_frozen();
DROP FUNCTION IF EXISTS fee_filing_frozen();
DROP TABLE IF EXISTS fee_regulatory_filing_documents;
DROP TABLE IF EXISTS fee_regulatory_filing_lines;
DROP TABLE IF EXISTS fee_regulatory_filings;

DROP TRIGGER IF EXISTS evaluation_answers_scale ON evaluation_answers;
DROP FUNCTION IF EXISTS evaluation_answer_within_scale();
DROP TABLE IF EXISTS evaluation_answers;
DROP TABLE IF EXISTS evaluation_responses;
DROP TABLE IF EXISTS evaluation_invitations;
DROP TABLE IF EXISTS evaluation_reviewees;
DROP TABLE IF EXISTS evaluation_questions;
DROP TABLE IF EXISTS evaluation_cycles;

DROP TRIGGER IF EXISTS mdm_monthly_returns_frozen ON mdm_monthly_returns;
DROP FUNCTION IF EXISTS mdm_return_frozen();
DROP TABLE IF EXISTS mdm_monthly_returns;
DROP TABLE IF EXISTS mdm_foodgrain_receipts;
DROP TABLE IF EXISTS mdm_norms;

DROP TABLE IF EXISTS purchase_invoice_matches;
DROP TRIGGER IF EXISTS goods_receipt_lines_sync ON goods_receipt_lines;
DROP TRIGGER IF EXISTS goods_receipt_lines_to_stock ON goods_receipt_lines;
DROP FUNCTION IF EXISTS sync_po_line_receipts();
DROP FUNCTION IF EXISTS po_receipt_to_stock();
DROP TABLE IF EXISTS goods_receipt_lines;
DROP TABLE IF EXISTS goods_receipts;
DROP TABLE IF EXISTS purchase_order_lines;
DROP TABLE IF EXISTS purchase_orders;
DROP TABLE IF EXISTS purchase_requisition_lines;
DROP TABLE IF EXISTS purchase_requisitions;
DROP TABLE IF EXISTS purchase_approval_thresholds;

ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_id_institution;
