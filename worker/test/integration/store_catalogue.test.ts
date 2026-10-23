/* One list for the store (Yajur, 2026-10-22): an item on the stores register
   marked "Show in parent store" appears in the parent catalogue with its
   price and In stock / Out of stock, never the count; and the parent's menu
   carries the Store. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api } from './fixture'

let shown = ''
let hiddenItem = ''

beforeAll(async () => {
  await seed()
  const a = await api('admin', 'POST', '/ops/inventory/items', { code: 'NB-200', name: 'Notebook, 200 pages', category: 'stationery', sale_price_paise: 6500, in_store: true })
  expect(a.status).toBe(201)
  shown = a.body.id
  const b = await api('admin', 'POST', '/ops/inventory/items', { code: 'CHK-01', name: 'Chalk, white' })
  expect(b.status).toBe(201)
  hiddenItem = b.body.id
})

describe('parent store catalogue', () => {
  it('lists an inventory item marked for the store, out of stock until a receipt', async () => {
    const r = await api('parent', 'GET', '/store/catalogue')
    expect(r.status).toBe(200)
    const nb = r.body.items.find((i: { code: string }) => i.code === 'NB-200')
    expect(nb).toMatchObject({ name: 'Notebook, 200 pages', price: 6500, in_stock: false })
    expect(r.body.items.some((i: { code: string }) => i.code === 'CHK-01')).toBe(false)
  })

  it('shows In stock after a receipt, and no quantity anywhere', async () => {
    expect((await api('admin', 'POST', '/ops/inventory/movements', { item_id: shown, kind: 'receipt', quantity: 40 })).status).toBe(201)
    const r = await api('parent', 'GET', '/store/catalogue')
    const nb = r.body.items.find((i: { code: string }) => i.code === 'NB-200')
    expect(nb.in_stock).toBe(true)
    expect(JSON.stringify(r.body)).not.toMatch(/"(stock|on_hand)"/)
  })

  it('an edit can put an item in the store, and takes it out again', async () => {
    expect((await api('admin', 'PATCH', `/ops/inventory/items/${hiddenItem}`, { name: 'Chalk, white', sale_price_paise: 1000, in_store: true })).status).toBe(200)
    let r = await api('parent', 'GET', '/store/catalogue')
    expect(r.body.items.some((i: { code: string }) => i.code === 'CHK-01')).toBe(true)
    expect((await api('admin', 'PATCH', `/ops/inventory/items/${hiddenItem}`, { name: 'Chalk, white', sale_price_paise: 1000, in_store: false })).status).toBe(200)
    r = await api('parent', 'GET', '/store/catalogue')
    expect(r.body.items.some((i: { code: string }) => i.code === 'CHK-01')).toBe(false)
  })

  it('refuses the store without a price, a negative price, and a parent editing', async () => {
    expect((await api('admin', 'PATCH', `/ops/inventory/items/${hiddenItem}`, { name: 'Chalk, white', in_store: true })).status).toBe(400)
    expect((await api('admin', 'POST', '/ops/inventory/items', { code: 'X-1', name: 'X', sale_price_paise: -5 })).status).toBe(400)
    expect((await api('parent', 'PATCH', `/ops/inventory/items/${hiddenItem}`, { name: 'Chalk' })).status).toBe(403)
  })

  it('the parent menu carries the Store', async () => {
    const r = await api('parent', 'GET', '/catalog')
    const keys = r.body.roles.flatMap((ro: { sections: { features: { key: string }[] }[] }) => ro.sections.flatMap((s) => s.features.map((f) => f.key)))
    expect(keys).toContain('parent.store.product_catalogue')
  })
})
