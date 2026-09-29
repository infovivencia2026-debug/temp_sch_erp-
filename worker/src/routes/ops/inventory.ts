import type { Router } from '../../router'
import { badRequest, bool, conflict, created, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
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

  /* THE ITEM ITSELF, WHICH NOTHING COULD CREATE.

     The stores screen could record a receipt, an issue, a return and a
     correction -- against items that had to already exist. Nothing in the
     product made one: the only INSERT into inventory_items in either backend
     was the demo seeder. So a real school could open the screen, see an empty
     list, and have no way to put its first box of chalk in it, and because
     the shop's catalogue reads stock through this table, it could not stock
     the shop either.

     No opening balance is taken here. A count is a movement -- a receipt --
     and letting an item be born holding forty of something would put a number
     in the balance that no line of the ledger accounts for, which is the one
     thing the movements design is careful never to do. The item starts at
     zero and the first receipt says where the forty came from. */
  r.post('/ops/inventory/items', 'operations.inventory.write', async (c) => {
    const req = await readJSON<{ code?: string; name?: string; category?: string; unit?: string; reorder_level?: number }>(c.req)
    const code = (req.code ?? '').trim()
    const name = (req.name ?? '').trim()
    if (!code) throw badRequest('every item needs a code, it is what a stores register is read by')
    if (!name) throw badRequest('every item needs a name')
    const reorder = Number(req.reorder_level ?? 0)
    if (!Number.isInteger(reorder) || reorder < 0) throw badRequest('the reorder level must be zero or more')

    // Named, not merely refused: the clerk needs to know it is already there.
    const clash = await c.db.prepare('SELECT name FROM inventory_items WHERE institution_id = ? AND code = ?')
      .bind(instId(c), code).first<{ name: string }>()
    if (clash) throw conflict(`the code ${code} is already ${clash.name}`)

    const id = uuid()
    await c.db.prepare(`INSERT INTO inventory_items (id, institution_id, code, name, category, unit, reorder_level, on_hand)
                        VALUES (?,?,?,?,?,?,?,0)`)
      .bind(id, instId(c), code, name, (req.category ?? '').trim() || null, (req.unit ?? '').trim() || 'nos', reorder)
      .run()
    return created({ id, code, name, category: (req.category ?? '').trim() || undefined,
      unit: (req.unit ?? '').trim() || 'nos', reorder_level: reorder, on_hand: 0, below_reorder: reorder >= 0 })
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
