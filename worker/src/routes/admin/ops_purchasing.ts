import type { Router, Ctx } from '../../router'
import { created, isUUID, now, ok, readJSON, uuid } from '../../http'
import { can } from '../../identity'
import { institutionId } from './common'
import { arr, denied, fmtPaise, mustFirst, nextNumber, nz, om, optDate, optUUID, pathUUID, qStr, qUUID, refuse, runOps, todayIST, tr } from './ops_common'

/* Purchasing under /admin-ops, from internal/api/admin_ops.go:
   requisition -> approval -> order -> receipt -> three-way match.

   Triggers re-implemented here (migrations/00053_admin_ops.sql):
     goods_receipt_lines_to_stock  a receipt line against an inventory item
                                   writes an inventory_movements 'receipt' row
                                   and links it (plus inventory_movements_sync
                                   from 00005, which recomputes on_hand);
     goods_receipt_lines_sync      the order line's received/rejected roll-up
                                   and the order's status ladder.
   Generated columns re-computed on write: purchase_order_lines.taxable_paise
   (quantity * unit_price_paise), purchase_invoice_matches.variance_paise
   (invoiced - received). */

const STORES_READ = 'operations.inventory.read'
const STORES_WRITE = 'operations.inventory.write'
const SPEND_CONFIG = 'institution.settings.write'
const PAY_AUTH = 'finance.invoices.write'

interface Band { label: string; up_to_paise?: number; approver_permission: string; sort_order: number; id?: string }
const FALLBACK: Band[] = [
  { label: 'Stores (up to ₹50,000)', up_to_paise: 5000000, approver_permission: STORES_WRITE, sort_order: 1 },
  { label: 'Finance (above ₹50,000)', approver_permission: PAY_AUTH, sort_order: 2 },
]

async function resolveBand(c: Ctx, total: number): Promise<Band> {
  const b = await c.db.prepare(`SELECT label, up_to_paise, approver_permission FROM purchase_approval_thresholds
      WHERE up_to_paise IS NULL OR up_to_paise >= ? ORDER BY (up_to_paise IS NULL), up_to_paise LIMIT 1`).bind(total)
    .first<{ label: string; up_to_paise: number | null; approver_permission: string }>()
  if (b) return { label: b.label, up_to_paise: om(b.up_to_paise), approver_permission: b.approver_permission, sort_order: 0 }
  for (const f of FALLBACK) if (f.up_to_paise === undefined || f.up_to_paise >= total) return f
  return FALLBACK[FALLBACK.length - 1]
}

// SQL for the money on an order (prcOrderValueSQL): total and the received part.
const LINE_TAXABLE = `COALESCE(l.taxable_paise, l.quantity * l.unit_price_paise)`
const ORDER_VALUE = `
  COALESCE((SELECT sum(${LINE_TAXABLE} + ${LINE_TAXABLE} * l.tax_rate_bp / 10000)
              FROM purchase_order_lines l WHERE l.purchase_order_id = o.id), 0) + o.other_charges_paise AS total_paise,
  COALESCE((SELECT sum(l.received_qty * l.unit_price_paise * (10000 + l.tax_rate_bp) / 10000)
              FROM purchase_order_lines l WHERE l.purchase_order_id = o.id), 0) AS received_paise`

type Row = Record<string, unknown>
const reqRow = (v: Row) => ({
  id: v.id, requisition_no: v.requisition_no, department: om(v.department), requested_by: om(v.requested_by),
  raised_on: v.raised_on, needed_by: om(v.needed_by), status: v.status, estimated_total_paise: Number(v.estimated_total_paise),
  approval_band: om(v.approval_band), approval_permission: om(v.approval_permission), decided_by: om(v.decided_by),
  decision_note: om(v.decision_note), line_count: Number(v.line_count ?? 0), order_no: om(v.order_no),
})
const orderRow = (v: Row) => ({
  id: v.id, po_no: v.po_no, vendor: v.vendor, vendor_id: v.vendor_id, requisition_no: om(v.requisition_no),
  order_date: v.order_date, expected_on: om(v.expected_on), status: v.status, total_paise: Number(v.total_paise),
  received_paise: Number(v.received_paise), line_count: Number(v.line_count ?? 0), outstanding_lines: Number(v.outstanding_lines ?? 0),
  invoice_matched: !!Number(v.invoice_matched),
})

export function registerOpsPurchasing(r: Router): void {
  r.get('/admin-ops/purchasing/thresholds', STORES_READ, async (c) => {
    const rows = await c.db.prepare(`SELECT id, label, up_to_paise, approver_permission, sort_order FROM purchase_approval_thresholds
        ORDER BY sort_order, (up_to_paise IS NULL), up_to_paise`).all<Row>()
    const items = rows.results.map((v) => ({ id: om(v.id), label: v.label, up_to_paise: om(v.up_to_paise as number | null),
      approver_permission: v.approver_permission, sort_order: Number(v.sort_order) }))
    return ok({ items, using_default: items.length === 0, default: FALLBACK })
  })

  r.put('/admin-ops/purchasing/thresholds', SPEND_CONFIG, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ bands?: { label?: string; up_to_paise?: number | null; approver_permission?: string }[] }>(c.req)
    const bands = arr<{ label?: string; up_to_paise?: number | null; approver_permission?: string }>(req.bands)
    if (bands.length === 0) throw refuse('a ladder needs at least one band')
    const known = new Set((await c.db.prepare(`SELECT key FROM permissions`).all<{ key: string }>()).results.map((p) => p.key))
    let unbounded = 0
    for (const b of bands) {
      if (tr(b.label) === '') throw refuse('every band needs a label')
      if (!known.has(b.approver_permission ?? '')) throw refuse('unknown permission: ' + (b.approver_permission ?? ''))
      if (b.up_to_paise === null || b.up_to_paise === undefined) unbounded++
      else if (b.up_to_paise <= 0) throw refuse('a ceiling must be more than zero')
    }
    if (unbounded !== 1) throw refuse('exactly one band must be the top one, with no ceiling')
    const t = now()
    await runOps(c, [
      c.db.prepare(`DELETE FROM purchase_approval_thresholds WHERE institution_id = ?`).bind(inst),
      ...bands.map((b, i) => c.db.prepare(`INSERT INTO purchase_approval_thresholds (id, institution_id, label, up_to_paise, approver_permission, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, tr(b.label), b.up_to_paise ?? null, b.approver_permission, i + 1, t, t)),
    ])
    return ok({ bands: bands.length })
  })

  // --- requisitions -----------------------------------------------------------

  r.get('/admin-ops/purchasing/requisitions', STORES_READ, async (c) => {
    const status = qStr(c.url.searchParams.get('status'))
    const rows = await c.db.prepare(`SELECT rq.id, rq.requisition_no, d.name AS department, u.full_name AS requested_by,
          substr(rq.raised_on,1,10) AS raised_on, substr(rq.needed_by,1,10) AS needed_by, rq.status, rq.estimated_total_paise,
          rq.approval_band, rq.approval_permission, du.full_name AS decided_by, rq.decision_note,
          (SELECT count(*) FROM purchase_requisition_lines l WHERE l.requisition_id = rq.id) AS line_count,
          (SELECT po.po_no FROM purchase_orders po WHERE po.requisition_id = rq.id ORDER BY po.order_date LIMIT 1) AS order_no
        FROM purchase_requisitions rq
        LEFT JOIN departments d ON d.id = rq.department_id
        LEFT JOIN users u ON u.id = rq.requested_by
        LEFT JOIN users du ON du.id = rq.decided_by
       WHERE (?1 IS NULL OR rq.status = ?1)
       ORDER BY rq.raised_on DESC, rq.requisition_no DESC LIMIT 300`).bind(status).all<Row>()
    return ok({ items: rows.results.map(reqRow) })
  })

  r.get('/admin-ops/purchasing/requisitions/{id}', STORES_READ, async (c) => {
    const id = pathUUID(c)
    const head = await mustFirst<Row>(c.db.prepare(`SELECT rq.id, rq.requisition_no, d.name AS department, u.full_name AS requested_by,
          substr(rq.raised_on,1,10) AS raised_on, substr(rq.needed_by,1,10) AS needed_by, rq.status, rq.estimated_total_paise,
          rq.approval_band, rq.approval_permission, du.full_name AS decided_by, rq.decision_note, rq.justification
        FROM purchase_requisitions rq
        LEFT JOIN departments d ON d.id = rq.department_id
        LEFT JOIN users u ON u.id = rq.requested_by
        LEFT JOIN users du ON du.id = rq.decided_by
       WHERE rq.id = ?`).bind(id))
    const lines = (await c.db.prepare(`SELECT l.id, l.line_no, l.item_id, i.code AS item_code, l.description, l.quantity, l.unit, l.estimated_unit_paise
        FROM purchase_requisition_lines l LEFT JOIN inventory_items i ON i.id = l.item_id
       WHERE l.requisition_id = ? ORDER BY l.line_no`).bind(id).all<Row>()).results.map((v) => ({
      id: v.id, line_no: Number(v.line_no), item_id: om(v.item_id), item_code: om(v.item_code), description: v.description,
      quantity: Number(v.quantity), unit: v.unit, rate_paise: Number(v.estimated_unit_paise) }))
    const requisition = { ...reqRow(head), line_count: lines.length }
    return ok({ requisition, justification: head.justification ?? null, lines })
  })

  r.post('/admin-ops/purchasing/requisitions', STORES_WRITE, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ id?: string; requisition_no?: string; department_id?: string; needed_by?: string; justification?: string;
      lines?: { item_id?: string; description?: string; quantity?: number; unit?: string; rate_paise?: number }[] }>(c.req)
    const lines = arr<{ item_id?: string; description?: string; quantity?: number; unit?: string; rate_paise?: number }>(req.lines)
    if (lines.length === 0) throw refuse('a requisition needs at least one line')
    let total = 0
    for (const l of lines) {
      if (tr(l.description) === '') throw refuse('every line needs a description')
      if (!((l.quantity ?? 0) > 0)) throw refuse('every line needs a quantity above zero')
      if ((l.rate_paise ?? 0) < 0) throw refuse('a rate cannot be negative')
      total += (l.quantity ?? 0) * (l.rate_paise ?? 0)
    }
    const dept = optUUID(req.department_id)
    const needed = optDate(req.needed_by, 'needed_by must be a date, as YYYY-MM-DD')
    const items = lines.map((l) => optUUID(l.item_id))
    const t = now()
    const stmts: D1PreparedStatement[] = []
    let reqID: string
    let no: string
    if (tr(req.id) !== '') {
      if (!isUUID(tr(req.id))) throw refuse('malformed requisition id')
      reqID = tr(req.id)
      const cur = await mustFirst<{ status: string; requisition_no: string }>(
        c.db.prepare(`SELECT status, requisition_no FROM purchase_requisitions WHERE id = ?`).bind(reqID))
      no = cur.requisition_no
      if (cur.status !== 'draft') throw refuse('this requisition has been submitted and can no longer be edited')
      stmts.push(c.db.prepare(`UPDATE purchase_requisitions SET department_id = ?, needed_by = ?, justification = ?, estimated_total_paise = ?, updated_at = ?
          WHERE id = ? AND status = 'draft'`).bind(dept, needed, nz(req.justification), total, t, reqID))
      stmts.push(c.db.prepare(`DELETE FROM purchase_requisition_lines WHERE requisition_id = ?`).bind(reqID))
    } else {
      no = tr(req.requisition_no) || await nextNumber(c, 'purchase_requisitions', 'requisition_no', 'PR')
      reqID = uuid()
      stmts.push(c.db.prepare(`INSERT INTO purchase_requisitions (id, institution_id, requisition_no, department_id, requested_by, raised_on, needed_by, justification,
          estimated_total_paise, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
        .bind(reqID, inst, no, dept, c.id.userId, todayIST(), needed, nz(req.justification), total, t, t))
    }
    lines.forEach((l, i) => stmts.push(c.db.prepare(`INSERT INTO purchase_requisition_lines (id, institution_id, requisition_id, item_id, description, quantity, unit, estimated_unit_paise, line_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, reqID, items[i], tr(l.description), l.quantity, tr(l.unit) || 'nos', l.rate_paise ?? 0, i + 1)))
    await runOps(c, stmts)
    return ok({ id: reqID, requisition_no: no, estimated_total_paise: total })
  })

  r.post('/admin-ops/purchasing/requisitions/{id}/submit', STORES_WRITE, async (c) => {
    const id = pathUUID(c)
    const cur = await mustFirst<{ status: string; estimated_total_paise: number; justification: string | null; lines: number }>(
      c.db.prepare(`SELECT rq.status, rq.estimated_total_paise, rq.justification,
          (SELECT count(*) FROM purchase_requisition_lines l WHERE l.requisition_id = rq.id) AS lines
        FROM purchase_requisitions rq WHERE rq.id = ?`).bind(id))
    if (cur.status !== 'draft') throw refuse('only a draft requisition can be submitted')
    if (Number(cur.lines) === 0) throw refuse('a requisition needs at least one line')
    if (tr(cur.justification) === '') throw refuse('say why this is needed before submitting it')
    const band = await resolveBand(c, Number(cur.estimated_total_paise))
    const t = now()
    await runOps(c, [c.db.prepare(`UPDATE purchase_requisitions SET status = 'submitted', submitted_at = ?, approval_band = ?, approval_permission = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'`).bind(t, band.label, band.approver_permission, t, id)])
    return ok({ status: 'submitted', approval_band: band.label, approval_permission: band.approver_permission })
  })

  // Gated in the handler: the permission needed is the band's.
  r.post('/admin-ops/purchasing/requisitions/{id}/decide', 'auth', async (c) => {
    const id = pathUUID(c)
    const req = await readJSON<{ decision?: string; note?: string }>(c.req)
    if (req.decision !== 'approve' && req.decision !== 'reject') throw refuse('decision must be approve or reject')
    if (req.decision === 'reject' && tr(req.note) === '') throw refuse('say why it is being rejected')
    const cur = await mustFirst<{ status: string; approval_permission: string | null; approval_band: string | null; requested_by: string | null; estimated_total_paise: number }>(
      c.db.prepare(`SELECT status, approval_permission, approval_band, requested_by, estimated_total_paise FROM purchase_requisitions WHERE id = ?`).bind(id))
    if (cur.status !== 'submitted') throw refuse('only a submitted requisition can be decided')
    let needPerm: string, bandLabel = ''
    if (tr(cur.approval_permission) === '') {
      const b = await resolveBand(c, Number(cur.estimated_total_paise))
      needPerm = b.approver_permission; bandLabel = b.label
    } else { needPerm = cur.approval_permission!; bandLabel = cur.approval_band ?? '' }
    if (cur.requested_by && cur.requested_by === c.id.userId) throw denied('you raised this requisition, so you cannot approve it')
    if (!can(c.id, needPerm)) throw denied(`a requisition of this value sits in the ${JSON.stringify(bandLabel)} band, which needs ${needPerm}`)
    const t = now()
    await runOps(c, [c.db.prepare(`UPDATE purchase_requisitions SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
        WHERE id = ? AND status = 'submitted'`).bind(req.decision === 'reject' ? 'rejected' : 'approved', c.id.userId, t, nz(req.note), t, id)])
    return ok({ decision: req.decision })
  })

  // --- purchase orders ----------------------------------------------------------

  r.get('/admin-ops/purchasing/orders', STORES_READ, async (c) => {
    const q = c.url.searchParams
    const rows = await c.db.prepare(`SELECT o.id, o.po_no, v.name AS vendor, o.vendor_id, rq.requisition_no,
          substr(o.order_date,1,10) AS order_date, substr(o.expected_on,1,10) AS expected_on, o.status, ${ORDER_VALUE},
          (SELECT count(*) FROM purchase_order_lines l WHERE l.purchase_order_id = o.id) AS line_count,
          (SELECT count(*) FROM purchase_order_lines l WHERE l.purchase_order_id = o.id AND l.received_qty < l.quantity) AS outstanding_lines,
          EXISTS (SELECT 1 FROM purchase_invoice_matches m WHERE m.purchase_order_id = o.id) AS invoice_matched
        FROM purchase_orders o JOIN vendors v ON v.id = o.vendor_id
        LEFT JOIN purchase_requisitions rq ON rq.id = o.requisition_id
       WHERE (?1 IS NULL OR o.status = ?1) AND (?2 IS NULL OR o.vendor_id = ?2)
       ORDER BY o.order_date DESC, o.po_no DESC LIMIT 300`).bind(qStr(q.get('status')), qUUID(q.get('vendor_id'))).all<Row>()
    return ok({ items: rows.results.map(orderRow) })
  })

  r.get('/admin-ops/purchasing/orders/{id}', STORES_READ, async (c) => {
    const id = pathUUID(c)
    const head = await mustFirst<Row>(c.db.prepare(`SELECT o.id, o.po_no, v.name AS vendor, o.vendor_id, rq.requisition_no,
          substr(o.order_date,1,10) AS order_date, substr(o.expected_on,1,10) AS expected_on, o.status, ${ORDER_VALUE},
          o.terms, o.notes, o.closed_reason,
          EXISTS (SELECT 1 FROM purchase_invoice_matches m WHERE m.purchase_order_id = o.id) AS invoice_matched
        FROM purchase_orders o JOIN vendors v ON v.id = o.vendor_id
        LEFT JOIN purchase_requisitions rq ON rq.id = o.requisition_id WHERE o.id = ?`).bind(id))
    const [lr, gr] = await c.db.batch<Row>([
      c.db.prepare(`SELECT l.id, l.line_no, l.item_id, i.code AS item_code, l.description, l.quantity, l.unit, l.unit_price_paise, l.tax_rate_bp,
          l.received_qty, l.rejected_qty FROM purchase_order_lines l LEFT JOIN inventory_items i ON i.id = l.item_id
         WHERE l.purchase_order_id = ? ORDER BY l.line_no`).bind(id),
      c.db.prepare(`SELECT g.id, g.grn_no, substr(g.received_on,1,10) AS received_on, g.challan_no, u.full_name AS received_by, g.remarks,
          count(l.id) AS line_count, COALESCE(sum(l.quantity_received),0) AS units_received, COALESCE(sum(l.quantity_rejected),0) AS units_rejected,
          count(l.inventory_movement_id) AS stock_movements
        FROM goods_receipts g LEFT JOIN users u ON u.id = g.received_by LEFT JOIN goods_receipt_lines l ON l.goods_receipt_id = g.id
       WHERE g.purchase_order_id = ? GROUP BY g.id ORDER BY g.received_on DESC, g.grn_no DESC`).bind(id),
    ])
    const lines = lr.results.map((v) => ({ id: v.id, line_no: Number(v.line_no), item_id: om(v.item_id), item_code: om(v.item_code),
      description: v.description, quantity: Number(v.quantity), unit: v.unit, unit_price_paise: Number(v.unit_price_paise), tax_rate_bp: Number(v.tax_rate_bp),
      received_qty: Number(v.received_qty), rejected_qty: Number(v.rejected_qty), outstanding_qty: Number(v.quantity) - Number(v.received_qty) }))
    const receipts = gr.results.map((v) => ({ id: v.id, grn_no: v.grn_no, received_on: v.received_on, challan_no: om(v.challan_no), received_by: om(v.received_by),
      remarks: om(v.remarks), line_count: Number(v.line_count), units_received: Number(v.units_received), units_rejected: Number(v.units_rejected),
      stock_movements: Number(v.stock_movements) }))
    const order = { ...orderRow(head), line_count: lines.length, outstanding_lines: lines.filter((l) => l.outstanding_qty > 0).length }
    return ok({ order, terms: head.terms ?? null, notes: head.notes ?? null, closed_reason: head.closed_reason ?? null, lines, receipts })
  })

  r.post('/admin-ops/purchasing/orders', STORES_WRITE, async (c) => {
    const inst = institutionId(c)
    type L = { item_id?: string; description?: string; quantity?: number; unit?: string; unit_price_paise?: number; tax_rate_bp?: number }
    const req = await readJSON<{ id?: string; po_no?: string; vendor_id?: string; requisition_id?: string; expected_on?: string;
      other_charges_paise?: number; terms?: string; notes?: string; lines?: L[] }>(c.req)
    const lines = arr<L>(req.lines)
    if (lines.length === 0) throw refuse('a purchase order needs at least one line')
    for (const l of lines) {
      if (tr(l.description) === '') throw refuse('every line needs a description')
      if (!((l.quantity ?? 0) > 0)) throw refuse('every line needs a quantity above zero')
      if ((l.unit_price_paise ?? 0) < 0) throw refuse('a price cannot be negative')
      const tx = l.tax_rate_bp ?? 0
      if (tx < 0 || tx > 10000) throw refuse('a GST rate is between 0 and 10000 basis points')
    }
    const other = req.other_charges_paise ?? 0
    if (other < 0) throw refuse('other charges cannot be negative')
    if (!isUUID(tr(req.vendor_id))) throw refuse('choose the vendor this order goes to')
    const vendor = tr(req.vendor_id).toLowerCase()
    const reqRef = optUUID(req.requisition_id)
    const expected = optDate(req.expected_on, 'expected_on must be a date, as YYYY-MM-DD')
    const items = lines.map((l) => optUUID(l.item_id))
    const t = now()
    const stmts: D1PreparedStatement[] = []
    let poID: string, no: string
    if (tr(req.id) !== '') {
      if (!isUUID(tr(req.id))) throw refuse('malformed order id')
      poID = tr(req.id)
      const cur = await mustFirst<{ status: string; po_no: string }>(c.db.prepare(`SELECT status, po_no FROM purchase_orders WHERE id = ?`).bind(poID))
      no = cur.po_no
      if (cur.status === 'cancelled' || cur.status === 'closed') throw refuse('this order is ' + cur.status + ' and cannot be edited')
      // purchase_order_lines_not_below_received, which the database no longer checks.
      const received = await c.db.prepare(`SELECT line_no, received_qty FROM purchase_order_lines WHERE purchase_order_id = ? AND received_qty > 0`).bind(poID).all<{ line_no: number; received_qty: number }>()
      for (const rl of received.results) {
        const nl = lines[rl.line_no - 1]
        if (!nl || (nl.quantity ?? 0) < rl.received_qty) throw refuse('goods have already been received against this line, so the order cannot be cut below what arrived')
      }
      stmts.push(c.db.prepare(`UPDATE purchase_orders SET vendor_id = ?, requisition_id = ?, expected_on = ?, other_charges_paise = ?, terms = ?, notes = ?, updated_at = ?
          WHERE id = ?`).bind(vendor, reqRef, expected, other, nz(req.terms), nz(req.notes), t, poID))
      stmts.push(c.db.prepare(`DELETE FROM purchase_order_lines WHERE purchase_order_id = ? AND received_qty = 0 AND rejected_qty = 0`).bind(poID))
    } else {
      no = tr(req.po_no) || await nextNumber(c, 'purchase_orders', 'po_no', 'PO')
      poID = uuid()
      stmts.push(c.db.prepare(`INSERT INTO purchase_orders (id, institution_id, po_no, vendor_id, requisition_id, order_date, expected_on, status,
          other_charges_paise, terms, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`)
        .bind(poID, inst, no, vendor, reqRef, todayIST(), expected, other, nz(req.terms), nz(req.notes), c.id.userId, t, t))
      if (reqRef) stmts.push(c.db.prepare(`UPDATE purchase_requisitions SET status = 'ordered', updated_at = ? WHERE id = ? AND status = 'approved'`).bind(t, reqRef))
    }
    lines.forEach((l, i) => {
      const qty = l.quantity ?? 0, price = l.unit_price_paise ?? 0
      stmts.push(c.db.prepare(`INSERT INTO purchase_order_lines (id, institution_id, purchase_order_id, item_id, description, quantity, unit, unit_price_paise, tax_rate_bp, line_no, taxable_paise, received_qty, rejected_qty)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
          ON CONFLICT (purchase_order_id, line_no) DO UPDATE SET item_id = excluded.item_id, description = excluded.description, quantity = excluded.quantity,
            unit = excluded.unit, unit_price_paise = excluded.unit_price_paise, tax_rate_bp = excluded.tax_rate_bp, taxable_paise = excluded.taxable_paise`)
        .bind(uuid(), inst, poID, items[i], tr(l.description), qty, tr(l.unit) || 'nos', price, l.tax_rate_bp ?? 0, i + 1, qty * price))
    })
    await runOps(c, stmts)
    return ok({ id: poID, po_no: no })
  })

  r.post('/admin-ops/purchasing/orders/{id}/issue', STORES_WRITE, async (c) => {
    const id = pathUUID(c)
    const cur = await mustFirst<{ status: string; lines: number }>(c.db.prepare(`SELECT o.status,
        (SELECT count(*) FROM purchase_order_lines l WHERE l.purchase_order_id = o.id) AS lines FROM purchase_orders o WHERE o.id = ?`).bind(id))
    if (cur.status !== 'draft') throw refuse('only a draft order can be issued')
    if (Number(cur.lines) === 0) throw refuse('an order needs at least one line before it goes to a vendor')
    const t = now()
    await runOps(c, [c.db.prepare(`UPDATE purchase_orders SET status = 'issued', issued_by = ?, issued_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'`)
      .bind(c.id.userId, t, t, id)])
    return ok({ status: 'issued' })
  })

  r.post('/admin-ops/purchasing/orders/{id}/close', STORES_WRITE, async (c) => {
    const id = pathUUID(c)
    const req = await readJSON<{ reason?: string }>(c.req)
    if (tr(req.reason) === '') throw refuse('say why the balance is being written off')
    const [res] = await runOps(c, [c.db.prepare(`UPDATE purchase_orders SET status = 'closed', closed_reason = ?, updated_at = ?
        WHERE id = ? AND status IN ('issued','partly_received','received')`).bind(tr(req.reason), now(), id)])
    if ((res.meta.changes ?? 0) === 0) throw refuse('only an issued order can be short-closed')
    return ok({ status: 'closed' })
  })

  r.post('/admin-ops/purchasing/orders/{id}/receipts', STORES_WRITE, async (c) => {
    const inst = institutionId(c)
    const poID = pathUUID(c)
    type L = { purchase_order_line_id?: string; quantity_received?: number; quantity_rejected?: number; rejection_reason?: string }
    const req = await readJSON<{ grn_no?: string; received_on?: string; challan_no?: string; remarks?: string; lines?: L[] }>(c.req)
    const lines = arr<L>(req.lines)
    if (lines.length === 0) throw refuse('record at least one line that arrived')
    const received = optDate(req.received_on, 'received_on must be a date, as YYYY-MM-DD') ?? todayIST()
    const po = await mustFirst<{ status: string }>(c.db.prepare(`SELECT status FROM purchase_orders WHERE id = ?`).bind(poID))
    if (po.status === 'draft') throw refuse('this order has not been issued to the vendor yet')
    if (po.status === 'cancelled' || po.status === 'closed') throw refuse('this order is ' + po.status + '; goods cannot be received against it')

    const no = tr(req.grn_no) || await nextNumber(c, 'goods_receipts', 'grn_no', 'GRN')
    const grnID = uuid(), t = now()
    const stmts: D1PreparedStatement[] = [c.db.prepare(`INSERT INTO goods_receipts (id, institution_id, purchase_order_id, grn_no, received_on, challan_no, received_by, remarks, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(grnID, inst, poID, no, received, nz(req.challan_no), c.id.userId, nz(req.remarks), t)]
    const touchedLines: string[] = [], touchedItems = new Set<string>()
    const pending = new Map<string, number>()
    let stocked = 0
    for (const l of lines) {
      const lineID = tr(l.purchase_order_line_id)
      if (!isUUID(lineID)) throw refuse('purchase_order_line_id must be a uuid')
      const rec = l.quantity_received ?? 0, rej = l.quantity_rejected ?? 0
      if (rec < 0 || rej < 0) throw refuse('a quantity cannot be negative')
      if (rec === 0 && rej === 0) continue
      if (rej > 0 && tr(l.rejection_reason) === '') throw refuse('say why the rejected units were rejected')
      const pl = await mustFirst<{ quantity: number; received_qty: number; line_no: number; purchase_order_id: string; item_id: string | null; unit_price_paise: number }>(
        c.db.prepare(`SELECT quantity, received_qty, line_no, purchase_order_id, item_id, unit_price_paise FROM purchase_order_lines WHERE id = ?`).bind(lineID))
      if (pl.purchase_order_id !== poID) throw refuse('that line belongs to a different purchase order')
      const already = pl.received_qty + (pending.get(lineID) ?? 0)
      if (already + rec > pl.quantity) throw refuse(`line ${pl.line_no}: ${pl.quantity} ordered, ${already} already received. You cannot receive ${rec} more`)
      pending.set(lineID, (pending.get(lineID) ?? 0) + rec)
      // goods_receipt_lines_to_stock
      let moveID: string | null = null
      if (rec > 0 && pl.item_id) {
        moveID = uuid(); stocked++; touchedItems.add(pl.item_id)
        stmts.push(c.db.prepare(`INSERT INTO inventory_movements (id, institution_id, item_id, kind, quantity, unit_cost_paise, reference, moved_on, remarks, created_by, created_at)
            VALUES (?, ?, ?, 'receipt', ?, ?, ?, ?, 'Goods receipt against purchase order', ?, ?)`).bind(moveID, inst, pl.item_id, rec, pl.unit_price_paise, no, received, c.id.userId, t))
      }
      stmts.push(c.db.prepare(`INSERT INTO goods_receipt_lines (id, institution_id, goods_receipt_id, purchase_order_line_id, quantity_received, quantity_rejected, rejection_reason, inventory_movement_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uuid(), inst, grnID, lineID, rec, rej, nz(l.rejection_reason), moveID, t))
      if (!touchedLines.includes(lineID)) touchedLines.push(lineID)
    }
    // inventory_movements_sync
    for (const item of touchedItems) stmts.push(c.db.prepare(`UPDATE inventory_items SET on_hand = COALESCE((
        SELECT sum(CASE WHEN m.kind IN ('receipt','return') THEN m.quantity WHEN m.kind = 'issue' THEN -m.quantity ELSE m.quantity END)
          FROM inventory_movements m WHERE m.item_id = ?1), 0) WHERE id = ?1`).bind(item))
    // goods_receipt_lines_sync
    for (const line of touchedLines) stmts.push(c.db.prepare(`UPDATE purchase_order_lines SET
        received_qty = COALESCE((SELECT sum(g.quantity_received) FROM goods_receipt_lines g WHERE g.purchase_order_line_id = ?1), 0),
        rejected_qty = COALESCE((SELECT sum(g.quantity_rejected) FROM goods_receipt_lines g WHERE g.purchase_order_line_id = ?1), 0)
       WHERE id = ?1`).bind(line))
    if (touchedLines.length > 0) stmts.push(syncOrderStatus(c, poID))
    await runOps(c, stmts)
    return created({ id: grnID, grn_no: no, stock_movements: stocked })
  })

  // --- three-way match ------------------------------------------------------------

  r.get('/admin-ops/purchasing/orders/{id}/match', STORES_READ, async (c) => {
    const id = pathUUID(c)
    const bill = qUUID(c.url.searchParams.get('vendor_bill_id'))
    const po = await mustFirst<Row>(c.db.prepare(`SELECT o.po_no, v.name AS vendor, o.vendor_id, ${ORDER_VALUE}
        FROM purchase_orders o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = ?`).bind(id))
    const bills = (await c.db.prepare(`SELECT b.id, b.bill_no, substr(b.bill_date,1,10) AS bill_date, COALESCE(b.total_paise, b.taxable_paise + b.tax_paise) AS total_paise, b.status,
          EXISTS (SELECT 1 FROM purchase_invoice_matches m WHERE m.vendor_bill_id = b.id) AS taken
        FROM vendor_bills b WHERE b.vendor_id = ?1 AND b.status <> 'cancelled' AND (?2 IS NULL OR b.id = ?2)
       ORDER BY b.bill_date DESC LIMIT 100`).bind(po.vendor_id, bill).all<Row>()).results.map((v) => ({
      id: v.id, bill_no: v.bill_no, bill_date: v.bill_date, total_paise: Number(v.total_paise), status: v.status, already_matched: !!Number(v.taken) }))
    return ok({ po_no: po.po_no, vendor: po.vendor, ordered_paise: Number(po.total_paise), received_paise: Number(po.received_paise), bills,
      note: 'Variance is measured against what was received, not what was ordered. An invoice covering goods still in transit is the case this stops.' })
  })

  r.post('/admin-ops/purchasing/orders/{id}/match', PAY_AUTH, async (c) => {
    const inst = institutionId(c)
    const poID = pathUUID(c)
    const req = await readJSON<{ vendor_bill_id?: string; decision?: string; note?: string }>(c.req)
    const billID = tr(req.vendor_bill_id)
    if (!isUUID(billID)) throw refuse('choose the vendor bill to match against')
    const status = ({ match: 'matched', accept_variance: 'variance_accepted', block: 'blocked' } as Record<string, string>)[req.decision ?? '']
    if (!status) throw refuse('decision must be match, accept_variance or block')
    if (status === 'variance_accepted' && tr(req.note) === '') throw refuse('say why the difference is being accepted')
    const po = await mustFirst<Row>(c.db.prepare(`SELECT o.vendor_id, ${ORDER_VALUE} FROM purchase_orders o WHERE o.id = ?`).bind(poID))
    const b = await mustFirst<{ vendor_id: string; total_paise: number; status: string }>(c.db.prepare(
      `SELECT vendor_id, COALESCE(total_paise, taxable_paise + tax_paise) AS total_paise, status FROM vendor_bills WHERE id = ?`).bind(billID))
    const ordered = Number(po.total_paise), receivedVal = Number(po.received_paise), invoiced = Number(b.total_paise)
    if (b.vendor_id !== po.vendor_id) throw refuse('that bill is from a different vendor than the order')
    if (b.status === 'cancelled') throw refuse('that bill has been cancelled')
    if (status === 'matched' && invoiced !== receivedVal) {
      throw refuse(`the bill is ${fmtPaise(invoiced)} and the goods received come to ${fmtPaise(receivedVal)}. Accept the variance, with a reason, or block it`)
    }
    const t = now()
    await runOps(c, [c.db.prepare(`INSERT INTO purchase_invoice_matches (id, institution_id, purchase_order_id, vendor_bill_id, ordered_paise, received_paise, invoiced_paise,
        variance_paise, status, matched_on, decided_by, decided_at, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (institution_id, vendor_bill_id) DO UPDATE SET purchase_order_id = excluded.purchase_order_id, ordered_paise = excluded.ordered_paise,
        received_paise = excluded.received_paise, invoiced_paise = excluded.invoiced_paise, variance_paise = excluded.variance_paise, status = excluded.status,
        decided_by = excluded.decided_by, decided_at = excluded.decided_at, note = excluded.note, updated_at = excluded.updated_at`)
      .bind(uuid(), inst, poID, billID, ordered, receivedVal, invoiced, invoiced - receivedVal, status, todayIST(), c.id.userId,
        status !== 'blocked' ? t : null, nz(req.note), t, t)])
    return ok({ status, ordered_paise: ordered, received_paise: receivedVal, invoiced_paise: invoiced, variance_paise: invoiced - receivedVal })
  })

  r.get('/admin-ops/purchasing/matches', STORES_READ, async (c) => {
    const rows = await c.db.prepare(`SELECT m.id, o.po_no, v.name AS vendor, b.bill_no, substr(b.bill_date,1,10) AS bill_date,
          m.ordered_paise, m.received_paise, m.invoiced_paise, COALESCE(m.variance_paise, m.invoiced_paise - m.received_paise) AS variance_paise,
          m.status, substr(m.matched_on,1,10) AS matched_on, u.full_name AS decided_by, m.note
        FROM purchase_invoice_matches m JOIN purchase_orders o ON o.id = m.purchase_order_id
        JOIN vendor_bills b ON b.id = m.vendor_bill_id JOIN vendors v ON v.id = o.vendor_id
        LEFT JOIN users u ON u.id = m.decided_by
       WHERE (?1 IS NULL OR m.status = ?1)
       ORDER BY abs(COALESCE(m.variance_paise, m.invoiced_paise - m.received_paise)) DESC, m.matched_on DESC LIMIT 300`)
      .bind(qStr(c.url.searchParams.get('status'))).all<Row>()
    return ok({ items: rows.results.map((v) => ({ id: v.id, po_no: v.po_no, vendor: v.vendor, bill_no: v.bill_no, bill_date: v.bill_date,
      ordered_paise: Number(v.ordered_paise), received_paise: Number(v.received_paise), invoiced_paise: Number(v.invoiced_paise),
      variance_paise: Number(v.variance_paise), status: v.status, matched_on: v.matched_on, decided_by: om(v.decided_by), note: om(v.note) })) })
  })
}

/** The order half of sync_po_line_receipts: the status ladder, leaving draft/closed/cancelled alone. */
function syncOrderStatus(c: Ctx, poID: string): D1PreparedStatement {
  return c.db.prepare(`UPDATE purchase_orders SET status = CASE
        WHEN NOT EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.purchase_order_id = ?1 AND l.received_qty < l.quantity) THEN 'received'
        WHEN EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.purchase_order_id = ?1 AND l.received_qty > 0) THEN 'partly_received'
        ELSE 'issued' END, updated_at = ?2
      WHERE id = ?1 AND status IN ('issued','partly_received','received')`).bind(poID, now())
}
