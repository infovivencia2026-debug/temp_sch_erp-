/* Seller billing and onboarding with fakes: CONTROL and one school database
   are in-memory node:sqlite databases carrying the real db/control.sql and
   db/tenant.sql. APP_ENV=development, so nothing is queued or sent, and no
   payment gateway is called: the gateway signature is computed locally.

   Run from worker/: scripts/test-billing.sh (esbuild bundle, node --test). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { Router } from '../src/router'
import { financialYear, rupees, reconcile, billingSettings, runBillingDaily, registerSellerBilling, signPayment, addDays, todayIST } from '../src/routes/seller/billing'
import { registerSellerOnboarding, scanOnboarding } from '../src/routes/seller/onboarding'

type Row = Record<string, unknown>
const bindable = (vs: unknown[]) => vs.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)) as never[]
const returnsRows = (sql: string) => /^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql)

/** node:sqlite does not bind ?NNN from an array; D1 does. Rewritten to plain ?s. */
function numbered(sql: string, params: unknown[]): [string, unknown[]] {
  if (!/\?\d/.test(sql)) return [sql, params]
  const out: unknown[] = []
  return [sql.replace(/\?(\d+)/g, (_, n) => { out.push(params[Number(n) - 1]); return '?' }), out]
}

function exec1(db: DatabaseSync, sql0: string, params0: unknown[]) {
  const [sql, params] = numbered(sql0, params0)
  if (returnsRows(sql)) return { results: (db.prepare(sql).all(...bindable(params)) as Row[]).map((r) => ({ ...r })), success: true, meta: { changes: 0 } }
  const r = db.prepare(sql).run(...bindable(params))
  return { results: [], success: true, meta: { changes: Number(r.changes) } }
}

function d1(db: DatabaseSync): D1Database {
  const mk = (sql: string, params: unknown[] = []): any => ({
    sql, params,
    bind: (...v: unknown[]) => mk(sql, v),
    first: async (col?: string) => { const r = exec1(db, sql, params).results[0] as Row | undefined; return r ? (col ? r[col] : r) : null },
    all: async () => exec1(db, sql, params),
    run: async () => exec1(db, sql, params),
  })
  return {
    prepare: (sql: string) => mk(sql),
    batch: async (stmts: any[]) => {
      db.exec('BEGIN')
      try { const out = stmts.map((s) => exec1(db, s.sql, s.params)); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e }
    },
    exec: async (sql: string) => { db.exec(sql); return { count: 0, duration: 0 } },
  } as unknown as D1Database
}

const INST = '11111111-1111-4111-8111-111111111111'
const ADMIN = '22222222-2222-4222-8222-222222222222'

function setup() {
  const control = new DatabaseSync(':memory:'); control.exec(readFileSync('db/control.sql', 'utf8'))
  const school = new DatabaseSync(':memory:'); school.exec(readFileSync('db/tenant.sql', 'utf8'))
  const t = new Date(Date.now() - 20 * 86_400_000).toISOString()
  control.exec(`INSERT INTO plans (code, name, price_paise, price_monthly_paise) VALUES ('standard', 'Standard', 5000000, 500000)`)
  control.prepare(`INSERT INTO institutions (id, name, short_name, slug, d1_database_id, d1_binding, created_at, updated_at)
    VALUES (?, 'Test School', 'TS', 'test', 'x', 'TENANT_TEST', ?, ?)`).run(INST, t, t)
  control.prepare(`INSERT INTO subscriptions (institution_id, plan_code, status, started_on, renews_on, updated_at) VALUES (?, 'standard', 'active', ?, ?, ?)`)
    .run(INST, t.slice(0, 10), addDays(todayIST(), 7), t)
  school.prepare(`INSERT INTO institutions (id, name, short_name, slug) VALUES (?, 'Test School', 'TS', 'test')`).run(INST)
  school.prepare(`INSERT INTO users (id, institution_id, email, full_name) VALUES (?, ?, 'admin@test.example', 'Asha Admin')`).run(ADMIN, INST)
  school.prepare(`INSERT INTO roles (id, institution_id, key, name) VALUES ('33333333-3333-4333-8333-333333333333', ?, 'institution_admin', 'Admin')`).run(INST)
  school.prepare(`INSERT INTO user_roles (institution_id, user_id, role_id) VALUES (?, ?, '33333333-3333-4333-8333-333333333333')`).run(INST, ADMIN)
  const env = { CONTROL: d1(control), TENANT_TEST: d1(school), APP_ENV: 'development', PAYMENT_GATEWAY_SECRET: 'test-secret' } as any
  return { control, school, env }
}

function caller(env: any, platform: boolean) {
  const r = new Router()
  registerSellerBilling(r); registerSellerOnboarding(r)
  return async (method: string, path: string, body?: unknown) => {
    const url = new URL('https://x/api/v1' + path)
    const hit = r.match(method, url.pathname)
    if (!hit) throw new Error('no route ' + method + ' ' + path)
    const id = platform
      ? { platformAdmin: true, restricted: false, userId: null, roles: ['super_admin'], permissions: new Set(), institution: null }
      : { platformAdmin: false, userId: ADMIN, roles: ['institution_admin'], permissions: new Set(), institution: { id: INST } }
    const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    try {
      const res = await hit.route.handler({ req, env, url, params: hit.params, id, db: env.TENANT_TEST } as any)
      const type = res.headers.get('content-type') ?? ''
      return { status: res.status, body: type.includes('json') ? await res.json() as any : await res.arrayBuffer() }
    } catch (e: any) { return { status: e.status ?? 500, body: { error: e.message } } }
  }
}

test('financial year and rupees', () => {
  assert.equal(financialYear('2026-09-27'), '2026-27')
  assert.equal(financialYear('2027-03-31'), '2026-27')
  assert.equal(financialYear('2027-04-01'), '2027-28')
  assert.equal(rupees(12345678), 'Rs 1,23,456.78')
  assert.equal(rupees(500), 'Rs 5.00')
})

test('invoice numbering, GST, payment, PDF', async () => {
  const { env } = setup()
  const seller = caller(env, true)
  let r = await seller('PUT', '/seller/billing/settings', { seller_name: 'Wisen', seller_gstin: '36ABCDE1234F1Z5', gst_rate_bp: 1800 })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal((await seller('PUT', '/seller/billing/settings', { seller_gstin: 'nope' })).status, 400)

  r = await seller('POST', '/seller/billing/invoices', { institution_id: INST, issued_on: '2026-09-27' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.number, 'INV/2026-27/0001')
  assert.equal(r.body.amount_paise, 5000000)
  assert.equal(r.body.gst_paise, 900000)
  assert.equal(r.body.total_paise, 5900000)
  assert.equal(r.body.seller_gstin, '36ABCDE1234F1Z5')
  const inv1 = r.body
  r = await seller('POST', '/seller/billing/invoices', { institution_id: INST, billing_period: 'monthly', issued_on: '2026-10-01', amount_paise: 100000 })
  assert.equal(r.body.number, 'INV/2026-27/0002')
  r = await seller('POST', '/seller/billing/invoices', { institution_id: INST, billing_period: 'one_off', issued_on: '2027-04-02', amount_paise: 100 })
  assert.equal(r.body.number, 'INV/2027-28/0001')

  r = await seller('POST', `/seller/billing/invoices/${inv1.id}/payments`, { amount_paise: 1000000, method: 'neft' })
  assert.equal(r.status, 400) // reference required
  r = await seller('POST', `/seller/billing/invoices/${inv1.id}/payments`, { amount_paise: 1000000, method: 'neft', reference: 'UTR1' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.invoice.status, 'partial')
  r = await seller('POST', `/seller/billing/invoices/${inv1.id}/payments`, { amount_paise: 99999999, method: 'upi', reference: 'X' })
  assert.equal(r.status, 400) // more than the balance
  r = await seller('POST', `/seller/billing/invoices/${inv1.id}/payments`, { method: 'cheque', reference: 'CHQ 001' })
  assert.equal(r.body.invoice.status, 'paid')

  r = await seller('GET', `/seller/billing/invoices/${inv1.id}/pdf`)
  assert.equal(r.status, 200)
  assert.equal(new TextDecoder().decode((r.body as ArrayBuffer).slice(0, 5)), '%PDF-')

  r = await seller('GET', '/seller/billing/schools')
  assert.equal(r.body.items[0].outstanding_paise, 100000 * 1.18 + 118)
})

test('past_due, suspended, back to active on payment', async () => {
  const { env, control } = setup()
  const seller = caller(env, true)
  const today = todayIST()
  const s = await billingSettings(env)
  const issued = addDays(today, -60)
  const r = await seller('POST', '/seller/billing/invoices', { institution_id: INST, issued_on: issued, due_on: addDays(today, -(s.grace_days + 1)) })
  const status = () => (control.prepare(`SELECT status FROM subscriptions WHERE institution_id = ?`).get(INST) as any).status
  await reconcile(env, INST, s, today)
  assert.equal(status(), 'past_due')
  await reconcile(env, INST, s, addDays(today, s.suspend_after_days + 1))
  assert.equal(status(), 'suspended')
  // The school pays online; the gate lifts.
  const school = caller(env, false)
  const co = await school('POST', `/school-billing/invoices/${r.body.id}/checkout`)
  assert.equal(co.status, 201, JSON.stringify(co.body))
  const bad = await school('POST', `/school-billing/checkout/${co.body.order_ref}/callback`, { payment_ref: 'pay_x', signature: 'forged' })
  assert.equal(bad.status, 400)
  const sig = await signPayment('test-secret', co.body.order_ref, 'pay_abc')
  const good = await school('POST', `/school-billing/checkout/${co.body.order_ref}/callback`, { payment_ref: 'pay_abc', signature: sig })
  assert.equal(good.status, 200, JSON.stringify(good.body))
  assert.equal(status(), 'active')
  // A second callback does not pay twice.
  const again = await school('POST', `/school-billing/checkout/${co.body.order_ref}/callback`, { payment_ref: 'pay_abc', signature: sig })
  assert.equal(again.body.status, 'paid')
  assert.equal((control.prepare(`SELECT COUNT(*) AS n FROM billing_payments`).get() as any).n, 1)
  // A status the seller set by hand is not undone by the engine.
  control.prepare(`UPDATE subscriptions SET status = 'suspended' WHERE institution_id = ?`).run(INST)
  await reconcile(env, INST, s, today)
  assert.equal(status(), 'suspended')
})

test('renewal reminder in development sends nothing and records nothing', async () => {
  const { env, control } = setup()
  const res = await runBillingDaily(env)
  assert.equal(res.reminders.length, 1)
  assert.equal(res.reminders[0].days_before, 7)
  assert.equal(res.reminders[0].queued, false)
  assert.equal((control.prepare(`SELECT COUNT(*) AS n FROM billing_reminders`).get() as any).n, 0)
})

test('onboarding scan and stalled flag', async () => {
  const { env, school } = setup()
  school.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(new Date(Date.now() - 15 * 86_400_000).toISOString(), ADMIN)
  const out = await scanOnboarding(env)
  assert.deepEqual(out, { schools: 1, failed: 0 })
  const seller = caller(env, true)
  const r = await seller('GET', '/seller/onboarding')
  const row = r.body.items[0]
  assert.equal(row.done, 2)
  assert.equal(row.stalled, true)
  assert.ok(row.next_steps.includes('Profile complete'))
  const n = await seller('POST', `/seller/onboarding/${INST}/nudge`)
  assert.equal(n.status, 200, JSON.stringify(n.body))
  assert.equal(n.body.queued, false)
  assert.equal(n.body.recipient, 'admin@test.example')
})
