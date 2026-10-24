/* The seller console's sales and accounts side: leads (create, search,
   filter, pages, stage moves and the race guard), quotes and their GST,
   resellers' commission and payouts, demo schools and their expiry, School
   360, renewals with the churn-risk rule, bulk actions with a dry run, the
   area roles (sales, billing, onboarding, support lead) and what each is
   refused, the health board, the onboarding nudge, the schools list and the
   entitlements switch going through the Controls allow-list. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, call, signIn, IDS, E, PASSWORD, isoDay } from './fixture'
import { hashPassword } from '../../src/auth/password'
import { suspendExpiredDemos } from '../../src/routes/seller/sales'
import { churnRisk } from '../../src/routes/seller/accounts'
import { DEMO_STUDENTS_PER_CLASS, seedDemoSchool } from '../../src/services/demo_seed'

const OWNER = { id: '00000000-0000-4000-8000-0000000000b1', email: 'seller.owner@vendor.test' }
let owner = ''

const json = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await call('/api/v1' + path, {
    method, cookie,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}

beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  if (!(await C.prepare('SELECT 1 FROM platform_users WHERE id = ?').bind(OWNER.id).first())) {
    const t = new Date().toISOString()
    const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
    await C.batch([
      C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, 'Sita Seller', ?, 'active', ?, ?)`)
        .bind(OWNER.id, OWNER.email, hash, t, t),
      C.prepare(`INSERT INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, 'seller_admin', ?)`).bind(OWNER.id, t),
      C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(OWNER.email, OWNER.id, t),
      C.prepare(`INSERT OR IGNORE INTO plans (code, name, price_paise, modules, sequence) VALUES ('test_pro', 'Test pro', 0, '[]', 2)`),
    ])
  }
  const s = await signIn(OWNER.email)
  if (!s.cookie) throw new Error(`owner sign-in failed: ${s.res.status}`)
  owner = s.cookie
})

/** A platform login holding one area role, made through the Staff screen's route. */
async function staffLogin(role: string): Promise<{ id: string; cookie: string }> {
  const email = `${role}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@vendor.test`
  const r = await json(owner, 'POST', '/seller/staff', { full_name: `Test ${role}`, email, role })
  expect(r.status).toBe(201)
  const s = await signIn(email, r.body.temporary_password)
  expect(s.cookie).toBeTruthy()
  return { id: r.body.user_id, cookie: s.cookie! }
}

describe('leads', () => {
  const tag = `Lead${Date.now()}`
  let leadId = ''

  it('creates a lead by hand, and refuses one it cannot reach or name', async () => {
    const r = await json(owner, 'POST', '/seller/enquiries', { school_name: `${tag} Vidyalaya`, contact_name: 'Ravi Contact', phone: '9800000001',
      students: 400, value_paise: 100000, owner_user_id: OWNER.id, next_follow_up: isoDay(2) })
    expect(r.status).toBe(201)
    leadId = r.body.id
    expect((await json(owner, 'POST', '/seller/enquiries', { school_name: 'X', contact_name: 'Y' })).status).toBe(400)
    expect((await json(owner, 'POST', '/seller/enquiries', { contact_name: 'Y', phone: '1' })).status).toBe(400)
    expect((await json(owner, 'POST', '/seller/enquiries', { school_name: 'X', contact_name: 'Y', email: 'not-an-email' })).status).toBe(400)
    expect((await json(owner, 'POST', '/seller/enquiries', { school_name: 'X', contact_name: 'Y', phone: '1', plan_code: 'nope' })).status).toBe(400)
    expect((await json(owner, 'POST', '/seller/enquiries', { school_name: 'X', contact_name: 'Y', phone: '1', owner_user_id: IDS.admin })).status).toBe(400)
  })

  it('searches, filters by owner and stage, and pages past the first page', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await json(owner, 'POST', '/seller/enquiries', { school_name: `${tag} Extra ${i}`, contact_name: 'C', email: `x${i}@lead.test` })).status).toBe(201)
    }
    const all = await json(owner, 'GET', `/seller/enquiries?q=${encodeURIComponent(tag.toLowerCase())}`)
    expect(all.status).toBe(200)
    expect(all.body.total).toBe(4)
    expect(all.body.owners.some((o: any) => o.id === OWNER.id)).toBe(true)
    const mine = await json(owner, 'GET', `/seller/enquiries?q=${tag}&owner=${OWNER.id}`)
    expect(mine.body.items.map((x: any) => x.id)).toEqual([leadId])
    const nobody = await json(owner, 'GET', `/seller/enquiries?q=${tag}&owner=none`)
    expect(nobody.body.total).toBe(3)
    const page1 = await json(owner, 'GET', `/seller/enquiries?q=${tag}&limit=2&offset=0`)
    const page2 = await json(owner, 'GET', `/seller/enquiries?q=${tag}&limit=2&offset=2`)
    expect(page1.body.items).toHaveLength(2)
    expect(page1.body.has_more).toBe(true)
    expect(page2.body.items).toHaveLength(2)
    expect(page2.body.has_more).toBe(false)
    const ids = new Set([...page1.body.items, ...page2.body.items].map((x: any) => x.id))
    expect(ids.size).toBe(4)
    expect((await json(owner, 'GET', `/seller/enquiries?q=${tag}&stage=contacted`)).body.total).toBe(0)
    expect((await json(owner, 'GET', '/seller/enquiries?stage=bogus')).status).toBe(400)
    expect((await json(owner, 'GET', '/seller/enquiries?owner=bogus')).status).toBe(400)
  })

  it('moves a lead only along the allowed stages, and the second of two racing moves loses', async () => {
    expect((await json(owner, 'PUT', `/seller/enquiries/${leadId}`, { from: 'new', status: 'won' })).status).toBe(400)
    expect((await json(owner, 'PUT', `/seller/enquiries/${leadId}`, { from: 'new', status: 'lost' })).status).toBe(400)
    expect((await json(owner, 'PUT', `/seller/enquiries/${leadId}`, { from: 'new', status: 'contacted', note: 'Rang them' })).status).toBe(200)
    // Someone else read it at 'new' and presses now: refused, nothing written.
    expect((await json(owner, 'PUT', `/seller/enquiries/${leadId}`, { from: 'new', status: 'contacted', note: 'stale' })).status).toBe(409)
    const notes = await json(owner, 'GET', `/seller/enquiries/${leadId}/notes`)
    expect(notes.body.items.some((n: any) => n.body === 'stale')).toBe(false)
    expect(notes.body.items.some((n: any) => n.kind === 'stage' && n.body === 'new -> contacted')).toBe(true)
    expect((await json(owner, 'GET', `/seller/enquiries?q=${tag}&stage=contacted`)).body.total).toBe(1)
  })

  it('a demo school needs the lead in demo_booked; then one is set up with an expiry', async () => {
    expect((await json(owner, 'POST', '/seller/demos', { enquiry_id: leadId })).status).toBe(409)
    expect((await json(owner, 'PUT', `/seller/enquiries/${leadId}`, { from: 'contacted', status: 'demo_booked' })).status).toBe(200)
    expect((await json(owner, 'POST', '/seller/demos', { enquiry_id: leadId, days: 99 })).status).toBe(400)
    const r = await json(owner, 'POST', '/seller/demos', { enquiry_id: leadId, days: 7 })
    expect(r.status).toBe(201)
    expect(r.body.expires_on).toBe(isoDay(7))
    expect(r.body.name).toMatch(/\(demo\)$/)
    expect(r.body.password).toBeTruthy()
    const list = await json(owner, 'GET', `/seller/demos?enquiry_id=${leadId}`)
    expect(list.body.items).toHaveLength(1)
    expect((await json(owner, 'POST', '/seller/demos', { enquiry_id: leadId })).status).toBe(409)
  })

  it('setting up the school for a lead is refused until it is won', async () => {
    const r = await json(owner, 'POST', '/seller/provisioning', { school_name: 'Won School', admin_name: 'A', admin_username: `won.${Date.now()}`, enquiry_id: leadId })
    expect(r.status).toBe(409)
  })
})

describe('demo expiry', () => {
  it('suspends a demo school once its date has passed, and leaves a live one', async () => {
    const C = E.CONTROL, t = new Date().toISOString()
    const old = crypto.randomUUID(), live = crypto.randomUUID()
    for (const [id, slug] of [[old, `demo-old-${Date.now()}`], [live, `demo-live-${Date.now()}`]]) {
      await C.prepare(`INSERT INTO institutions (id, name, short_name, slug, status, d1_database_id, d1_binding, created_at, updated_at) VALUES (?, ?, 'DEMO', ?, 'active', 'none', 'TENANT_NONE', ?, ?)`)
        .bind(id, `Demo ${slug}`, slug, t, t).run()
    }
    await C.batch([
      C.prepare(`INSERT INTO seller_demos (provisioning_id, institution_id, expires_on, created_at) VALUES (?, ?, ?, ?)`).bind(crypto.randomUUID(), old, isoDay(-1), t),
      C.prepare(`INSERT INTO seller_demos (provisioning_id, institution_id, expires_on, created_at) VALUES (?, ?, ?, ?)`).bind(crypto.randomUUID(), live, isoDay(3), t),
    ])
    const done = await suspendExpiredDemos(E)
    expect(done).toContain(old)
    expect(done).not.toContain(live)
    const st = async (id: string) => (await C.prepare('SELECT status FROM institutions WHERE id = ?').bind(id).first<{ status: string }>())!.status
    expect(await st(old)).toBe('suspended')
    expect(await st(live)).toBe('active')
    expect(await suspendExpiredDemos(E)).not.toContain(old)
  })
})

describe('demo seed', () => {
  it('fills a new school with plainly invented classes and children, once', async () => {
    const T = E.TENANT_TEST, inst = crypto.randomUUID(), t = new Date().toISOString()
    await T.batch([
      T.prepare(`INSERT INTO institutions (id, name, short_name, slug, status, created_at, updated_at) VALUES (?, 'Seed Demo', 'SD', ?, 'active', ?, ?)`).bind(inst, `seed-demo-${Date.now()}`, t, t),
      T.prepare(`INSERT INTO campuses (id, institution_id, name, code, created_at, updated_at) VALUES (?, ?, 'Main Campus', 'MAIN', ?, ?)`).bind(crypto.randomUUID(), inst, t, t),
    ])
    try {
      await seedDemoSchool(T, inst, '2026-10-24')
      await seedDemoSchool(T, inst, '2026-10-24')
      const n = async (sql: string) => (await T.prepare(sql).bind(inst).first<{ n: number }>())!.n
      expect(await n('SELECT count(*) AS n FROM students WHERE institution_id = ?')).toBe(3 * DEMO_STUDENTS_PER_CLASS)
      expect(await n(`SELECT count(*) AS n FROM students WHERE institution_id = ? AND (first_name <> 'Demo' OR admission_no NOT LIKE 'DEMO-%')`)).toBe(0)
      expect(await n('SELECT count(*) AS n FROM enrollments WHERE institution_id = ?')).toBe(3 * DEMO_STUDENTS_PER_CLASS)
      expect(await n('SELECT count(*) AS n FROM class_subjects WHERE institution_id = ?')).toBe(9)
      const year = await T.prepare('SELECT name, starts_on, is_current FROM academic_years WHERE institution_id = ?').bind(inst).first()
      expect(year).toMatchObject({ name: '2026-27', starts_on: '2026-06-01', is_current: 1 })
    } finally {
      for (const tbl of ['enrollments', 'students', 'class_subjects', 'sections', 'classes', 'subjects', 'academic_years', 'campuses', 'institutions']) {
        await T.prepare(`DELETE FROM ${tbl} WHERE ${tbl === 'institutions' ? 'id' : 'institution_id'} = ?`).bind(inst).run()
      }
    }
  })
})

describe('quotes, invoices and commission', () => {
  let leadId = '', quoteId = '', partnerId = ''

  it('a quote carries GST at the billing rate and refuses a lead with no value', async () => {
    const bare = await json(owner, 'POST', '/seller/enquiries', { school_name: 'No Value School', contact_name: 'C', phone: '9800000009' })
    expect((await json(owner, 'POST', '/seller/quotes', { enquiry_id: bare.body.id })).status).toBe(400)
    const lead = await json(owner, 'POST', '/seller/enquiries', { school_name: 'Quote School', contact_name: 'C', phone: '9800000010', value_paise: 123457 })
    leadId = lead.body.id
    const q = await json(owner, 'POST', '/seller/quotes', { enquiry_id: leadId })
    expect(q.status).toBe(201)
    quoteId = q.body.id
    expect(q.body.amount_paise).toBe(123457)
    expect(q.body.gst_rate_bp).toBe(1800)
    expect(q.body.gst_paise).toBe(22222) // 123457 * 0.18 = 22222.26
    expect(q.body.total_paise).toBe(145679)
    expect(q.body.number).toMatch(/^QT\/\d{4}-\d{2}\/\d{4}$/)
    expect(q.body.valid_until).toBe(isoDay(30))
    const pdf = await call(`/api/v1/seller/quotes/${quoteId}/pdf`, { cookie: owner })
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toContain('pdf')
  })

  it('converting needs a school; then it issues one invoice for the quoted amount, once', async () => {
    const none = await json(owner, 'POST', `/seller/quotes/${quoteId}/convert`, {})
    expect(none.status).toBe(409)
    const r = await json(owner, 'POST', `/seller/quotes/${quoteId}/convert`, { institution_id: IDS.school })
    expect(r.status).toBe(201)
    expect(r.body.invoice.total_paise).toBe(145679)
    expect(r.body.quote.status).toBe('converted')
    expect(r.body.quote.invoice_number).toBe(r.body.invoice.number)
    expect((await json(owner, 'POST', `/seller/quotes/${quoteId}/convert`, { institution_id: IDS.school })).status).toBe(409)
    expect((await json(owner, 'POST', `/seller/quotes/${quoteId}/void`)).status).toBe(409)
    // Paid without a partner: nothing accrues.
    const paid = await json(owner, 'POST', `/seller/billing/invoices/${r.body.invoice.id}/payments`, { amount_paise: 145679, method: 'neft', reference: 'UTR0001' })
    expect(paid.status).toBe(201)
    expect((await E.CONTROL.prepare('SELECT count(*) AS n FROM partner_commissions WHERE invoice_id = ?').bind(r.body.invoice.id).first<{ n: number }>())!.n).toBe(0)
  })

  it('a partner earns its rate on the taxable value of each fully paid invoice, and a payout settles it once', async () => {
    expect((await json(owner, 'POST', '/seller/partners', { name: 'P', commission_bp: 9000 })).status).toBe(400)
    const p = await json(owner, 'POST', '/seller/partners', { name: 'Reseller One', email: 'one@partner.test', commission_bp: 1250 })
    expect(p.status).toBe(201)
    partnerId = p.body.id
    expect((await json(owner, 'POST', `/seller/partners/${partnerId}/schools`, { institution_id: IDS.school })).status).toBe(200)
    const inv = await json(owner, 'POST', '/seller/billing/invoices', { institution_id: IDS.school, billing_period: 'one_off', amount_paise: 100001, description: 'Training' })
    expect(inv.status).toBe(201)
    // Part paid: nothing yet.
    await json(owner, 'POST', `/seller/billing/invoices/${inv.body.id}/payments`, { amount_paise: 50000, method: 'upi', reference: 'UPI1' })
    let detail = await json(owner, 'GET', `/seller/partners/${partnerId}`)
    expect(detail.body.commissions).toHaveLength(0)
    await json(owner, 'POST', `/seller/billing/invoices/${inv.body.id}/payments`, { amount_paise: inv.body.total_paise - 50000, method: 'upi', reference: 'UPI2' })
    detail = await json(owner, 'GET', `/seller/partners/${partnerId}`)
    expect(detail.body.commissions).toHaveLength(1)
    expect(detail.body.commissions[0].base_paise).toBe(100001)
    expect(detail.body.commissions[0].commission_paise).toBe(12500) // 100001 * 12.5% = 12500.125
    const list = await json(owner, 'GET', '/seller/partners')
    expect(list.body.items.find((x: any) => x.id === partnerId)).toMatchObject({ schools: 1, accrued_paise: 12500, owed_paise: 12500, paid_paise: 0 })
    expect((await json(owner, 'POST', `/seller/partners/${partnerId}/payouts`, { reference: '' })).status).toBe(400)
    const pay = await json(owner, 'POST', `/seller/partners/${partnerId}/payouts`, { reference: 'NEFT-778' })
    expect(pay.status).toBe(201)
    expect(pay.body.amount_paise).toBe(12500)
    expect((await json(owner, 'POST', `/seller/partners/${partnerId}/payouts`, { reference: 'NEFT-779' })).status).toBe(409)
    expect((await json(owner, 'GET', '/seller/partners')).body.items.find((x: any) => x.id === partnerId)).toMatchObject({ owed_paise: 0, paid_paise: 12500 })
    // Unlinked so later invoices in other files accrue nothing.
    expect((await json(owner, 'DELETE', `/seller/partners/${partnerId}/schools/${IDS.school}`)).status).toBe(200)
  })
})

describe('school 360, renewals and bulk actions', () => {
  it('School 360 reads the plan, the children counted, money and the risk rule', async () => {
    const r = await json(owner, 'GET', `/seller/school360/${IDS.school}`)
    expect(r.status).toBe(200)
    expect(r.body.school.id).toBe(IDS.school)
    expect(r.body.students.actual).toBeGreaterThanOrEqual(2)
    expect(r.body.reachable).toBe(true)
    expect(Array.isArray(r.body.risk)).toBe(true)
    expect(r.body.risk_rule).toMatch(/14 days/)
    expect((await json(owner, 'GET', `/seller/school360/${crypto.randomUUID()}`)).status).toBe(404)
  })

  it('the churn-risk rule uses only the three signals', () => {
    const recent = new Date().toISOString()
    expect(churnRisk({ past_due: false, last_sign_in: recent, adoption_pct: 60 })).toEqual([])
    expect(churnRisk({ past_due: true, last_sign_in: recent, adoption_pct: 60 })).toEqual(['Payment overdue'])
    expect(churnRisk({ past_due: false, last_sign_in: new Date(Date.now() - 15 * 86_400_000).toISOString(), adoption_pct: 60 })).toEqual(['No sign-in for 14 days'])
    expect(churnRisk({ past_due: false, last_sign_in: null, adoption_pct: 10 })).toEqual(['No sign-in for 14 days', 'Low use'])
  })

  it('renewals lists a school renewing inside the window, and refuses an odd window', async () => {
    await E.CONTROL.prepare(`UPDATE subscriptions SET renews_on = ? WHERE institution_id = ?`).bind(isoDay(20), IDS.school).run()
    const r = await json(owner, 'GET', '/seller/renewals?days=30')
    expect(r.status).toBe(200)
    const row = r.body.items.find((x: any) => x.institution_id === IDS.school)
    expect(row.renews_in_days).toBe(20)
    expect(Array.isArray(row.risk)).toBe(true)
    expect(r.body.rule).toMatch(/overdue/)
    expect((await json(owner, 'GET', '/seller/renewals?days=45')).status).toBe(400)
  })

  it('a bulk plan change shows a dry run first, then changes and audits each school', async () => {
    const before = (await E.CONTROL.prepare('SELECT plan_code FROM subscriptions WHERE institution_id = ?').bind(IDS.school).first<{ plan_code: string }>())!.plan_code
    expect((await json(owner, 'POST', '/seller/bulk', { action: 'plan', institution_ids: [IDS.school], plan_code: 'nope', dry_run: true })).status).toBe(400)
    expect((await json(owner, 'POST', '/seller/bulk', { action: 'delete', institution_ids: [IDS.school] })).status).toBe(400)
    const dry = await json(owner, 'POST', '/seller/bulk', { action: 'plan', institution_ids: [IDS.school], plan_code: 'test_pro', dry_run: true })
    expect(dry.status).toBe(200)
    expect(dry.body.applied).toBe(false)
    expect(dry.body.schools[0].change).toMatch(/to Test pro$/)
    expect((await E.CONTROL.prepare('SELECT plan_code FROM subscriptions WHERE institution_id = ?').bind(IDS.school).first<{ plan_code: string }>())!.plan_code).toBe(before)
    const done = await json(owner, 'POST', '/seller/bulk', { action: 'plan', institution_ids: [IDS.school], plan_code: 'test_pro' })
    expect(done.status).toBe(201)
    expect(done.body.schools[0].done).toBe(true)
    expect((await E.CONTROL.prepare('SELECT plan_code FROM subscriptions WHERE institution_id = ?').bind(IDS.school).first<{ plan_code: string }>())!.plan_code).toBe('test_pro')
    const audit = await E.CONTROL.prepare(`SELECT count(*) AS n FROM seller_audit WHERE action = 'seller.bulk.plan' AND institution_id = ?`).bind(IDS.school).first<{ n: number }>()
    expect(audit!.n).toBeGreaterThanOrEqual(1)
    await json(owner, 'POST', '/seller/bulk', { action: 'plan', institution_ids: [IDS.school], plan_code: before })
  })

  it('a bulk announcement reaches only the chosen schools', async () => {
    const r = await json(owner, 'POST', '/seller/bulk', { action: 'announcement', institution_ids: [IDS.school], title: 'Bulk notice test' })
    expect(r.status).toBe(201)
    const t = await E.CONTROL.prepare('SELECT target_kind, target_ids FROM platform_broadcast_targets WHERE broadcast_id = ?').bind(r.body.announcement_id).first<{ target_kind: string; target_ids: string }>()
    expect(t).toEqual({ target_kind: 'schools', target_ids: JSON.stringify([IDS.school]) })
    await json(owner, 'POST', `/seller/announcements/${r.body.announcement_id}/retire`)
  })
})

describe('area roles', () => {
  it('the Staff screen assigns the new roles and refuses an unknown one', async () => {
    const s = await staffLogin('sales')
    expect((await json(owner, 'POST', `/seller/staff/${s.id}/role`, { role: 'billing' })).status).toBe(200)
    expect((await json(owner, 'POST', `/seller/staff/${s.id}/role`, { role: 'overlord' })).status).toBe(400)
    const roles = await E.CONTROL.prepare('SELECT role_key FROM platform_user_roles WHERE user_id = ?').bind(s.id).all<{ role_key: string }>()
    expect(roles.results.map((r) => r.role_key)).toEqual(['billing'])
  })

  it('sales works leads but cannot suspend, restore or change a plan, or act in bulk', async () => {
    const { cookie } = await staffLogin('sales')
    expect((await json(cookie, 'GET', '/seller/enquiries')).status).toBe(200)
    expect((await json(cookie, 'POST', '/seller/enquiries', { school_name: 'Sales Made', contact_name: 'C', phone: '9800000077' })).status).toBe(201)
    expect((await json(cookie, 'GET', '/seller/tenants')).status).toBe(200)
    expect((await json(cookie, 'GET', `/seller/school360/${IDS.school}`)).status).toBe(200)
    for (const status of ['suspended', 'active']) {
      expect((await json(cookie, 'PUT', `/seller/tenants/${IDS.school}/subscription`, { status })).status).toBe(403)
    }
    expect((await json(cookie, 'PUT', `/seller/tenants/${IDS.school}/subscription`, { plan_code: 'test_pro' })).status).toBe(403)
    expect((await json(cookie, 'POST', '/seller/bulk', { action: 'plan', institution_ids: [IDS.school], plan_code: 'test_pro', dry_run: true })).status).toBe(403)
    expect((await json(cookie, 'GET', '/seller/billing/invoices')).status).toBe(403)
    expect((await json(cookie, 'GET', '/seller/staff')).status).toBe(403)
    const cat = await json(cookie, 'GET', '/catalog')
    const keys: string[] = cat.body.roles.flatMap((r: any) => r.sections.flatMap((s: any) => s.features.map((f: any) => f.key)))
    expect(keys).toContain('seller_admin.sales.leads')
    expect(keys).not.toContain('seller_admin.subscriptions_billing.subscription_ledger')
    expect(keys).not.toContain('seller_admin.support.support_team')
  })

  it('billing changes a plan and bills, but cannot enter a school or provision one', async () => {
    const { cookie } = await staffLogin('billing')
    expect((await json(cookie, 'GET', '/seller/billing/invoices')).status).toBe(200)
    expect((await json(cookie, 'GET', '/seller/partners')).status).toBe(200)
    const sub = await json(cookie, 'PUT', `/seller/tenants/${IDS.school}/subscription`, { licensed_students: 500 })
    expect(sub.status).toBe(200)
    const imp = await json(cookie, 'POST', '/admin/platform/impersonation', { institution_id: IDS.school, reason: 'billing should not get in here', minutes: 10 })
    expect(imp.status).toBe(403)
    expect((await json(cookie, 'POST', '/seller/provisioning', { school_name: 'X', admin_name: 'Y', admin_username: 'billing.try' })).status).toBe(403)
    expect((await json(cookie, 'POST', '/seller/announcements', { title: 'nope' })).status).toBe(403)
  })

  it('onboarding sets schools up but cannot bill or change a plan', async () => {
    const { cookie } = await staffLogin('onboarding')
    expect((await json(cookie, 'GET', '/seller/onboarding')).status).toBe(200)
    expect((await json(cookie, 'GET', '/seller/health')).status).toBe(200)
    expect((await json(cookie, 'PUT', `/seller/tenants/${IDS.school}/subscription`, { plan_code: 'test_pro' })).status).toBe(403)
    expect((await json(cookie, 'POST', '/seller/billing/invoices', { institution_id: IDS.school, amount_paise: 100 })).status).toBe(403)
    expect((await json(cookie, 'POST', '/admin/platform/impersonation', { institution_id: IDS.school, reason: 'onboarding should not get in', minutes: 10 })).status).toBe(403)
  })

  it('a support lead runs the desk and may open a recorded session, but cannot bill', async () => {
    const { cookie } = await staffLogin('support_lead')
    expect((await json(cookie, 'GET', '/seller/tickets')).status).toBe(200)
    expect((await json(cookie, 'GET', '/seller/announcements')).status).toBe(200)
    const imp = await json(cookie, 'POST', '/admin/platform/impersonation', { institution_id: IDS.school, reason: 'reproducing a reported fault', minutes: 10 })
    expect(imp.status).toBe(201)
    await json(cookie, 'POST', `/admin/platform/impersonation/${imp.body.id}/end`)
    expect((await json(cookie, 'GET', '/seller/billing/invoices')).status).toBe(403)
    expect((await json(cookie, 'PUT', `/seller/tenants/${IDS.school}/subscription`, { status: 'suspended' })).status).toBe(403)
  })

  it('seller_admin keeps every area', async () => {
    expect((await json(owner, 'GET', '/seller/billing/invoices')).status).toBe(200)
    expect((await json(owner, 'GET', '/seller/staff')).status).toBe(200)
  })
})

describe('health, onboarding, the schools list and entitlements', () => {
  it('the health board and one school', async () => {
    expect((await json(owner, 'GET', '/seller/health')).status).toBe(200)
    const one = await json(owner, 'GET', `/seller/health/${IDS.school}`)
    expect(one.status).toBe(200)
    expect(one.body.id).toBe(IDS.school)
    expect((await json(owner, 'GET', `/seller/health/${crypto.randomUUID()}`)).status).toBe(404)
    expect((await json(owner, 'GET', '/seller/health/not-a-uuid')).status).toBe(400)
  })

  it('the onboarding nudge names the steps left, and refuses an unknown school', async () => {
    const r = await json(owner, 'POST', `/seller/onboarding/${IDS.school}/nudge`)
    if (r.status === 400) expect(String(r.body.error?.message ?? r.body.error)).toMatch(/every milestone/)
    else {
      expect(r.status).toBe(200)
      expect(Array.isArray(r.body.checklist)).toBe(true)
      expect(r.body.development).toBe(true)
      expect(r.body.queued).toBe(false)
    }
    expect((await json(owner, 'POST', `/seller/onboarding/${crypto.randomUUID()}/nudge`)).status).toBe(404)
    expect((await json(owner, 'POST', '/seller/onboarding/nope/nudge')).status).toBe(400)
  })

  it('the schools list counts the children', async () => {
    const r = await json(owner, 'GET', '/seller/tenants')
    expect(r.status).toBe(200)
    const s = r.body.items.find((x: any) => x.id === IDS.school)
    expect(s.students).toBeGreaterThanOrEqual(2)
    expect(s).toHaveProperty('setup_percent')
  })

  it('the entitlements switch takes only a vendor-editable setting, wants a reason and tells the school', async () => {
    expect((await json(owner, 'PUT', '/admin/platform/entitlements', { institution_id: IDS.school, module: 'not_a_module', enabled: false, reason: 'testing it' })).status).toBe(400)
    expect((await json(owner, 'PUT', '/admin/platform/entitlements', { institution_id: IDS.school, module: 'session_activity', enabled: true, reason: 'testing it' })).status).toBe(403)
    expect((await json(owner, 'PUT', '/admin/platform/entitlements', { institution_id: IDS.school, module: 'class_status', enabled: false })).status).toBe(400)
    const r = await json(owner, 'PUT', '/admin/platform/entitlements', { institution_id: IDS.school, module: 'class_status', enabled: false, reason: 'asked by the principal' })
    expect(r.status).toBe(200)
    expect(r.body.applied).toBe(true)
    const notice = await E.CONTROL.prepare(`SELECT b.title FROM platform_broadcasts b JOIN platform_broadcast_targets t ON t.broadcast_id = b.id
        WHERE t.target_ids = ? AND b.title LIKE 'Support changed a setting%' ORDER BY b.created_at DESC LIMIT 1`).bind(JSON.stringify([IDS.school])).first<{ title: string }>()
    expect(notice?.title).toMatch(/Class Status/)
    await json(owner, 'PUT', '/admin/platform/entitlements', { institution_id: IDS.school, module: 'class_status', enabled: true, reason: 'put back after the test' })
  })
})
