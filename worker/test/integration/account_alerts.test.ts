/* The admin board's account alerts: storage and the student licence against
   the plan, message credits, the subscription, the provider's invoices,
   feature trials, backups, bus papers and staff medical certificates. Each
   fires at its threshold, stays quiet below it, and is not shown to a role
   without the permission. The nightly job tells admins once per level. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { seed, api, IDS, E, isoDay, type Who } from './fixture'
import { runUsageAlerts } from '../../src/services/background/health'

beforeAll(seed)

const C = () => E.CONTROL, T = () => E.TENANT_TEST
const sub = (sql: string, ...args: unknown[]) => C().prepare(`UPDATE subscriptions SET ${sql} WHERE institution_id = ?`).bind(...args, IDS.school).run()

async function items(who: Who): Promise<any[]> {
  const r = await api(who, 'GET', '/attention')
  expect(r.status).toBe(200)
  return r.body.items
}
const find = async (key: string, who: Who = 'admin') => (await items(who)).find((i) => i.key === key)

afterEach(async () => {
  await sub(`status = 'active', trial_ends_on = '2999-12-31', renews_on = NULL, licensed_students = NULL, storage_gb = NULL`)
  await C().batch([
    C().prepare(`DELETE FROM billing_invoices WHERE institution_id = ?`).bind(IDS.school),
    C().prepare(`DELETE FROM school_feature_overrides WHERE institution_id = ?`).bind(IDS.school),
    C().prepare(`DELETE FROM backups WHERE institution_id = ?`).bind(IDS.school),
  ])
  await T().batch([
    T().prepare(`DELETE FROM files WHERE purpose = 'alert_test'`),
    T().prepare(`DELETE FROM message_credits`),
    T().prepare(`DELETE FROM vehicles WHERE registration_no LIKE 'ALERT-%'`),
    T().prepare(`DELETE FROM medical_fitness_certificates WHERE purpose = 'alert_test'`),
  ])
})

const addFile = (bytes: number) => T().prepare(`INSERT INTO files (institution_id, object_key, original_name, content_type, size_bytes, purpose)
    VALUES (?, ?, 'x.jpg', 'image/jpeg', ?, 'alert_test')`).bind(IDS.school, crypto.randomUUID(), bytes).run()
const GB = 1024 ** 3

describe('storage', () => {
  it('warns at 80% and names used of limit', async () => {
    await sub(`storage_gb = 1`); await addFile(0.88 * GB)
    const a = await find('plan.storage')
    expect(a).toMatchObject({ severity: 'warning', headline: 'Storage 88% used: 0.9 GB of 1 GB', href: 'class_status' })
  })
  it('is critical when full', async () => {
    await sub(`storage_gb = 1`); await addFile(1.1 * GB)
    expect(await find('plan.storage')).toMatchObject({ severity: 'critical', headline: 'Storage full: 1.1 GB of 1 GB used' })
  })
  it('is quiet below 80%', async () => {
    await sub(`storage_gb = 1`); await addFile(0.5 * GB)
    expect(await find('plan.storage')).toBeUndefined()
  })
})

describe('student licence', () => {
  it('is critical at the licence and quiet well below it', async () => {
    const roll = Number((await T().prepare(`SELECT count(*) AS n FROM students WHERE status = 'active'`).first<{ n: number }>())!.n)
    await sub(`licensed_students = ?`, roll)
    expect(await find('plan.students')).toMatchObject({ severity: 'critical', headline: `Student licence full: ${roll} of ${roll} on roll` })
    await sub(`licensed_students = ?`, roll * 10)
    expect(await find('plan.students')).toBeUndefined()
  })
})

describe('message credits', () => {
  const credits = (ch: string, balance: number, low = 100) => T().prepare(`INSERT INTO message_credits (institution_id, channel, balance, low_water) VALUES (?, ?, ?, ?)
      ON CONFLICT (institution_id, channel) DO UPDATE SET balance = excluded.balance, low_water = excluded.low_water`).bind(IDS.school, ch, balance, low).run()
  it('warns below the low mark, is critical at zero, quiet above', async () => {
    await credits('sms', 40)
    expect(await find('messaging.credits')).toMatchObject({ severity: 'warning', headline: '40 SMS credits left', href: 'message_channels' })
    await credits('whatsapp', 0)
    expect(await find('messaging.credits')).toMatchObject({ severity: 'critical', headline: '40 SMS credits left, WhatsApp credits used up', count: 2 })
    await credits('sms', 500); await credits('whatsapp', 500)
    expect(await find('messaging.credits')).toBeUndefined()
  })
})

describe('subscription', () => {
  it('warns of a trial ending within 14 days, not one further out', async () => {
    await sub(`status = 'trial', trial_ends_on = ?`, isoDay(5))
    const a = await find('plan.trial')
    expect(a?.severity).toBe('warning')
    expect(a?.headline).toMatch(/^Trial ends in [45] days$/)
    await sub(`trial_ends_on = ?`, isoDay(40))
    expect(await find('plan.trial')).toBeUndefined()
  })
  it('warns of a renewal within 30 days, critical once past', async () => {
    await sub(`renews_on = ?`, isoDay(10))
    expect((await find('plan.renewal'))?.severity).toBe('warning')
    await sub(`renews_on = ?`, isoDay(-3))
    expect((await find('plan.renewal'))?.headline).toMatch(/^Subscription renewal was due on /)
    await sub(`renews_on = ?`, isoDay(60))
    expect(await find('plan.renewal')).toBeUndefined()
  })
  it('shows an unpaid provider invoice, critical once overdue', async () => {
    let seq = 900
    const inv = (due: string, status = 'issued') => C().prepare(`INSERT INTO billing_invoices (id, institution_id, number, fy, seq, issued_on, due_on, description,
        amount_paise, gst_rate_bp, gst_paise, total_paise, status, created_at, updated_at) VALUES (?, ?, ?, 'T-ALERT', ?, ?, ?, 'Plan', 5000000, 1800, 900000, 5900000, ?, ?, ?)`)
      .bind(crypto.randomUUID(), IDS.school, 'INV-' + crypto.randomUUID().slice(0, 8), ++seq, isoDay(-1), due, status, new Date().toISOString(), new Date().toISOString()).run()
    await inv(isoDay(-60), 'paid')
    expect(await find('plan.invoice')).toBeUndefined()
    await inv(isoDay(10))
    expect(await find('plan.invoice')).toMatchObject({ severity: 'warning', headline: '₹59.0K unpaid on 1 provider invoice', amount_paise: 5900000 })
    await inv(isoDay(-2))
    expect(await find('plan.invoice')).toMatchObject({ severity: 'critical', headline: '₹59.0K overdue on 1 provider invoice' })
  })
})

describe('feature trials', () => {
  it('counts trials ending within 7 days only', async () => {
    const ov = (feature: string, days: number) => C().prepare(`INSERT INTO school_feature_overrides (institution_id, feature_id, enabled, ends_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
      .bind(IDS.school, feature, new Date(Date.now() + days * 86_400_000).toISOString(), new Date().toISOString()).run()
    await ov('library.catalogue', 20)
    expect(await find('plan.feature_trials')).toBeUndefined()
    await ov('transport.vehicles', 3)
    expect(await find('plan.feature_trials')).toMatchObject({ severity: 'warning', count: 1, headline: '1 feature trial ends within 7 days' })
  })
})

describe('backups', () => {
  const backup = (status: string, hoursAgo: number) => {
    const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
    return C().prepare(`INSERT INTO backups (id, institution_id, backup_date, object_key, status, started_at, finished_at) VALUES (?, ?, ?, 'k', ?, ?, ?)`)
      .bind(crypto.randomUUID(), IDS.school, at.slice(0, 10), status, at, at).run()
  }
  it('says nothing for a school with no backups yet, or a fresh one', async () => {
    expect(await find('plan.backup')).toBeUndefined()
    await backup('succeeded', 5)
    expect(await find('plan.backup')).toBeUndefined()
  })
  it('is critical when the last one failed or none succeeded in 48 hours', async () => {
    await backup('succeeded', 30); await backup('failed', 2)
    expect(await find('plan.backup')).toMatchObject({ severity: 'critical', headline: 'Last backup failed' })
    await C().prepare(`DELETE FROM backups WHERE status = 'failed' AND institution_id = ?`).bind(IDS.school).run()
    await backup('succeeded', 72)
    await C().prepare(`DELETE FROM backups WHERE institution_id = ? AND started_at > ?`).bind(IDS.school, new Date(Date.now() - 48 * 3_600_000).toISOString()).run()
    expect(await find('plan.backup')).toMatchObject({ severity: 'critical', headline: 'No backup in the last 2 days' })
  })
})

describe('papers that lapse', () => {
  it('counts bus papers expired and due within 30 days', async () => {
    const campus = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
    const bus = (reg: string, ins: string | null, fit: string | null, puc: string | null) => T().prepare(`INSERT INTO vehicles (institution_id, campus_id, registration_no, insurance_expiry, fitness_expiry, puc_expiry)
        VALUES (?, ?, ?, ?, ?, ?)`).bind(IDS.school, campus, reg, ins, fit, puc).run()
    await bus('ALERT-1', isoDay(200), isoDay(90), null)
    expect(await find('transport.papers')).toBeUndefined()
    await bus('ALERT-2', isoDay(10), isoDay(200), null)
    expect(await find('transport.papers')).toMatchObject({ severity: 'warning', headline: '1 bus paper due for renewal within 30 days' })
    await bus('ALERT-3', isoDay(-1), isoDay(-5), isoDay(20))
    expect(await find('transport.papers')).toMatchObject({ severity: 'critical', count: 4, headline: '2 bus papers expired, 2 more due within 30 days' })
  })

  it('counts only the latest medical certificate of each member of staff', async () => {
    const campus = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
    const emp = crypto.randomUUID()
    await T().prepare(`INSERT INTO employees (id, institution_id, campus_id, employee_code, first_name) VALUES (?, ?, ?, ?, 'Mira')`)
      .bind(emp, IDS.school, campus, 'ALERT-' + emp.slice(0, 6)).run()
    const cert = (issued: string, until: string) => T().prepare(`INSERT INTO medical_fitness_certificates (institution_id, employee_id, purpose, issued_on, valid_until) VALUES (?, ?, 'alert_test', ?, ?)`)
      .bind(IDS.school, emp, issued, until).run()
    await cert(isoDay(-400), isoDay(-30))
    expect(await find('hr.medical_fitness')).toMatchObject({ severity: 'critical', headline: '1 staff medical certificate expired' })
    await cert(isoDay(-10), isoDay(15))
    expect(await find('hr.medical_fitness')).toMatchObject({ severity: 'warning', headline: '1 staff medical certificate due for renewal within 30 days' })
    await cert(isoDay(-5), isoDay(300))
    expect(await find('hr.medical_fitness')).toBeUndefined()
  })
})

describe('who sees them', () => {
  it('a teacher and an accountant get none of the account alerts', async () => {
    await sub(`storage_gb = 1, renews_on = ?`, isoDay(5)); await addFile(1.2 * GB)
    await T().prepare(`INSERT INTO message_credits (institution_id, channel, balance, low_water) VALUES (?, 'sms', 0, 100)`).bind(IDS.school).run()
    const campus = (await T().prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>())!.id
    await T().prepare(`INSERT INTO vehicles (institution_id, campus_id, registration_no, insurance_expiry) VALUES (?, ?, 'ALERT-9', ?)`).bind(IDS.school, campus, isoDay(-1)).run()
    expect((await items('admin')).map((i) => i.key)).toEqual(expect.arrayContaining(['plan.storage', 'plan.renewal', 'messaging.credits']))
    for (const who of ['teacher', 'finance'] as const) {
      const keys = (await items(who)).map((i) => i.key)
      expect(keys.filter((k) => /^(plan|messaging|transport|hr)\./.test(k))).toEqual([])
    }
  })
})

describe('nightly bell', () => {
  it('tells each admin once per level about the subscription', async () => {
    await sub(`status = 'trial', trial_ends_on = ?`, isoDay(6))
    await runUsageAlerts(E)
    await runUsageAlerts(E)
    const rows = await T().prepare(`SELECT title, source_id, link FROM notifications WHERE user_id = ? AND source_kind = 'usage_alert' AND source_id LIKE 'trial:%'`)
      .bind(IDS.admin).all<{ title: string; source_id: string; link: string }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]).toMatchObject({ source_id: 'trial:80', link: '/go/dashboard' })
    expect(rows.results[0].title).toMatch(/^Trial ends in [56] days$/)
    // The plan-limit banner keeps to plan limits.
    const banner = await api('admin', 'GET', '/usage-alerts')
    expect(banner.body.items.map((a: any) => a.metric)).not.toContain('trial')
  })
})
