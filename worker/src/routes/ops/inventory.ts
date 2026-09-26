import type { Router } from '../../router'
import { badRequest, bool, created, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { instId } from './common'

/* Port of the inventory pair in internal/api/mod_ops.go: the stock list and
   the movement ledger. Postgres kept inventory_items.on_hand in step with a
   trigger (sync_inventory_on_hand, migration 00005); here the handler
   recomputes it from the ledger in the same batch. */
export function registerInventory(r: Router) {
  r.get('/ops/inventory/stock', 'operations.inventory.read', async (c) => {
    const rows = await c.db.prepare(`SELECT id, code, name, category, unit, on_hand, reorder_level,
        on_hand <= reorder_level AS below_reorder FROM inventory_items ORDER BY name`).all<Record<string, unknown>>()
    return ok({ items: rows.results.map((v) => ({
      id: v.id, code: v.code, name: v.name, category: v.category ?? undefined, unit: v.unit,
      on_hand: v.on_hand, reorder_level: v.reorder_level, below_reorder: bool(v.below_reorder) })) })
  })

  r.post('/ops/inventory/movements', 'operations.inventory.write', async (c) => {
    const req = await readJSON<{ item_id?: string; kind?: string; quantity?: number; reference?: string; remarks?: string }>(c.req)
    if (!isUUID(req.item_id)) throw badRequest('item_id must be a uuid')
    if (!['receipt', 'issue', 'adjustment', 'return'].includes(req.kind ?? '')) throw badRequest('kind must be receipt, issue, adjustment or return')
    const qty = Number(req.quantity ?? 0)
    if (!Number.isInteger(qty) || qty === 0) throw badRequest('quantity must not be zero')

    const item = await c.db.prepare('SELECT on_hand FROM inventory_items WHERE id = ?').bind(req.item_id).first<{ on_hand: number }>()
    if (!item) throw notFound('item not found')
    if (req.kind === 'issue' && qty > item.on_hand) throw badRequest(`only ${item.on_hand} in stock`)

    const ts = now()
    const results = await c.db.batch([
      c.db.prepare(`INSERT INTO inventory_movements (id, institution_id, item_id, kind, quantity, reference, remarks, moved_on, created_by, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(uuid(), instId(c), req.item_id, req.kind, qty, req.reference || null, req.remarks || null, ts.slice(0, 10), c.id.userId, ts),
      // What the trigger did: on_hand is the sum of the ledger, never a running counter.
      c.db.prepare(`UPDATE inventory_items SET on_hand = COALESCE((
          SELECT SUM(CASE WHEN m.kind IN ('receipt','return') THEN m.quantity WHEN m.kind = 'issue' THEN -m.quantity ELSE m.quantity END)
            FROM inventory_movements m WHERE m.item_id = ?), 0) WHERE id = ?`).bind(req.item_id, req.item_id),
      c.db.prepare('SELECT on_hand FROM inventory_items WHERE id = ?').bind(req.item_id),
    ])
    const after = (results[2].results as { on_hand: number }[])[0]
    return created({ on_hand: after?.on_hand ?? 0 })
  })
}
