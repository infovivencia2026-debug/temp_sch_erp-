/* Seller Controls (routes/seller/controls.ts, services/settings_registry.ts):
   the vendor sees and changes a school's configuration, sets the defaults
   new schools start with, edits and pushes role templates, and never reaches
   a school's records this way. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, signIn, IDS, E, PASSWORD } from './fixture'
import { hashPassword } from '../../src/auth/password'
import { STORAGE_TABLES, settingDefs } from '../../src/services/settings_registry'
import registrySrc from '../../src/services/settings_registry.ts?raw'

const OWNER = { id: '00000000-0000-4000-8000-0000000000c1', email: 'controls.owner@vendor.test' }
const SUPPORT = { id: '00000000-0000-4000-8000-0000000000c2', email: 'controls.support@vendor.test' }
const OTHER = '00000000-0000-4000-8000-0000000000c9' // a second school in CONTROL only (branding and features live there)
let owner = '', support = ''

const json = async (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await call('/api/v1' + path, {
    method, cookie,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}
const setting = async (key: string, school = IDS.school) => {
  const r = await json(owner, 'GET', `/seller/controls/schools/${school}`)
  expect(r.status).toBe(200)
  return r.body.settings.find((s: any) => s.key === key)
}

beforeAll(async () => {
  await seed()
  const C = E.CONTROL
  const t = new Date().toISOString()
  const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
  for (const [u, role, name] of [[OWNER, 'seller_admin', 'Cora Controls'], [SUPPORT, 'support_admin', 'Sid Support']] as const) {
    if (await C.prepare('SELECT 1 FROM platform_users WHERE id = ?').bind(u.id).first()) continue
    await C.batch([
      C.prepare(`INSERT INTO platform_users (id, email, full_name, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`).bind(u.id, u.email, name, hash, t, t),
      C.prepare(`INSERT INTO platform_user_roles (user_id, role_key, created_at) VALUES (?, ?, ?)`).bind(u.id, role, t),
      C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, NULL, ?, ?)`).bind(u.email, u.id, t),
    ])
  }
  await C.prepare(`INSERT OR IGNORE INTO institutions (id, name, short_name, slug, status, primary_color, d1_database_id, d1_binding, created_at, updated_at)
      VALUES (?, 'Second Test School', 'STS', 'second-test', 'active', '#1e40af', 'tenant-test', 'TENANT_TEST', ?, ?)`).bind(OTHER, t, t).run()
  owner = (await signIn(OWNER.email)).cookie!
  support = (await signIn(SUPPORT.email)).cookie!
  expect(owner && support).toBeTruthy()
})

describe('effective values and where they come from', () => {
  const KEY = 'class_status.max_video_seconds'
  it('nothing stored: the built-in value, from built-in', async () => {
    const s = await setting(KEY)
    expect(s).toMatchObject({ value: 30, source: 'built-in', default_source: 'built-in', vendor_editable: true })
  })

  it('a platform default, then a plan default, become what a reset sets; the school keeps running on what it has until then', async () => {
    expect((await json(owner, 'PUT', '/seller/controls/defaults', { scope: 'platform', key: KEY, value: 45 })).status).toBe(200)
    expect(await setting(KEY)).toMatchObject({ value: 30, source: 'built-in', default_value: 45, default_source: 'platform' })
    expect((await json(owner, 'PUT', '/seller/controls/defaults', { scope: 'plan:test', key: KEY, value: 50 })).status).toBe(200)
    expect(await setting(KEY)).toMatchObject({ default_value: 50, default_source: 'plan' })
    const reset = await json(owner, 'POST', `/seller/controls/schools/${IDS.school}/reset`, { keys: [KEY], reason: 'start from the plan' })
    expect(reset.status).toBe(200)
    expect(reset.body.schools[0].changes).toEqual([{ key: KEY, label: expect.any(String), before: 30, after: 50 }])
    expect(await setting(KEY)).toMatchObject({ value: 50, source: 'plan' })
  })

  it('a school value wins and says so; the school\'s own screen reads the same value', async () => {
    const r = await json(owner, 'PUT', `/seller/controls/schools/${IDS.school}`, { changes: [{ key: KEY, value: 20 }], reason: 'asked by the principal' })
    expect(r.status).toBe(200)
    expect(await setting(KEY)).toMatchObject({ value: 20, source: 'school' })
    const own = await api('admin', 'GET', '/status/settings')
    expect(own.status).toBe(200)
    expect(own.body.max_video_seconds).toBe(20)
    // Clean up: defaults gone, reset to the built-in.
    await json(owner, 'DELETE', `/seller/controls/defaults?scope=platform&key=${KEY}`)
    await json(owner, 'DELETE', `/seller/controls/defaults?scope=plan:test&key=${KEY}`)
    await json(owner, 'POST', `/seller/controls/schools/${IDS.school}/reset`, { keys: [KEY], reason: 'tidy up' })
    expect(await setting(KEY)).toMatchObject({ value: 30, source: 'built-in' })
  })

  it('a feature switch takes its default from the plan and resets to it', async () => {
    const key = 'feature.communication.class_status'
    expect(await setting(key)).toMatchObject({ source: 'plan' })
    await json(owner, 'PUT', `/seller/controls/schools/${IDS.school}`, { changes: [{ key, value: false }], reason: 'trial ended' })
    expect(await setting(key)).toMatchObject({ value: false, source: 'school' })
    await json(owner, 'POST', `/seller/controls/schools/${IDS.school}/reset`, { keys: [key], reason: 'back to the plan' })
    expect(await setting(key)).toMatchObject({ source: 'plan' })
  })

  it('refuses bad values and needs a reason', async () => {
    const bad = await json(owner, 'PUT', `/seller/controls/schools/${IDS.school}`, { changes: [{ key: 'class_status.max_video_seconds', value: 600 }], reason: 'x long' })
    expect(bad.status).toBe(400)
    const noReason = await json(owner, 'PUT', `/seller/controls/schools/${IDS.school}`, { changes: [{ key: 'messaging.daily_cap', value: 5 }] })
    expect(noReason.status).toBe(400)
  })
})

describe('audit and the school\'s notice', () => {
  it('records the change for the vendor and the school, and puts a notice on the school\'s board', async () => {
    const r = await json(owner, 'PUT', `/seller/controls/schools/${IDS.school}`, { changes: [{ key: 'class_status.who', value: 'class_teachers' }], reason: 'principal asked by phone' })
    expect(r.status).toBe(200)
    const audit = await E.CONTROL.prepare(`SELECT action, institution_id, after_summary FROM seller_audit WHERE actor_id = ? AND action = 'controls.set' ORDER BY at DESC LIMIT 1`).bind(OWNER.id).first<any>()
    expect(audit).toMatchObject({ institution_id: IDS.school })
    expect(audit.after_summary).toContain('principal asked by phone')
    const seen = await api('admin', 'GET', '/admin/security/seller-audit?action=controls.set')
    expect(seen.status).toBe(200)
    expect(seen.body.items.some((x: any) => x.institution_id === IDS.school)).toBe(true)
    const notice = await E.CONTROL.prepare(`SELECT b.title, b.body FROM platform_broadcasts b JOIN platform_broadcast_targets t ON t.broadcast_id = b.id
        WHERE t.target_kind = 'schools' AND t.target_ids LIKE ? AND b.title LIKE '%Who may post%'`).bind(`%${IDS.school}%`).first<any>()
    expect(notice?.body).toContain('principal asked by phone')
    await json(owner, 'POST', `/seller/controls/schools/${IDS.school}/reset`, { keys: ['class_status.who'], reason: 'tidy up' })
  })
})

describe('many schools at once', () => {
  it('previews, then applies, with a result per school and one audit row each', async () => {
    const body = { changes: [{ key: 'branding.tagline', value: 'Learning together' }], institution_ids: [IDS.school, OTHER] }
    const preview = await json(owner, 'POST', '/seller/controls/apply', { ...body, dry_run: true })
    expect(preview.status).toBe(200)
    expect(preview.body.applied).toBe(false)
    expect(preview.body.schools.map((s: any) => s.changes.length)).toEqual([1, 1])
    expect((await setting('branding.tagline')).value).toBeNull()
    const done = await json(owner, 'POST', '/seller/controls/apply', { ...body, reason: 'new term wording' })
    expect(done.body.applied).toBe(true)
    expect((await setting('branding.tagline')).value).toBe('Learning together')
    expect((await setting('branding.tagline', OTHER)).value).toBe('Learning together')
    const rows = await E.CONTROL.prepare(`SELECT count(DISTINCT institution_id) AS n FROM seller_audit WHERE action = 'controls.set' AND target LIKE '%branding.tagline%'`).first<{ n: number }>()
    expect(rows!.n).toBeGreaterThanOrEqual(2)
    const again = await json(owner, 'POST', '/seller/controls/apply', { ...body, dry_run: true })
    expect(again.body.schools.every((s: any) => s.changes.length === 0)).toBe(true)
  })

  it('compares two schools', async () => {
    await json(owner, 'PUT', `/seller/controls/schools/${OTHER}`, { changes: [{ key: 'branding.primary_color', value: '#0f766e' }], reason: 'their new colour' })
    const r = await json(owner, 'GET', `/seller/controls/compare?a=${IDS.school}&b=${OTHER}`)
    expect(r.status).toBe(200)
    expect(r.body.rows.find((x: any) => x.key === 'branding.primary_color')).toMatchObject({ differs: true, b: '#0f766e' })
    expect(r.body.rows.find((x: any) => x.key === 'branding.tagline')).toMatchObject({ differs: false })
  })
})

describe('configuration templates', () => {
  it('export holds settings only, and importing it puts them back', async () => {
    const ex = await json(owner, 'GET', `/seller/controls/schools/${IDS.school}/export`)
    expect(ex.status).toBe(200)
    expect(ex.body.format).toBe('xulo-config/1')
    const keys = new Set(settingDefs().map((d) => d.key))
    expect(Object.keys(ex.body.settings).every((k) => keys.has(k))).toBe(true)
    expect(JSON.stringify(ex.body)).not.toMatch(/Chirag|Pavan|INV-1|A001/)
    await json(owner, 'PUT', `/seller/controls/schools/${IDS.school}`, { changes: [{ key: 'messaging.daily_cap', value: 9 }, { key: 'branding.tagline', value: 'Changed' }], reason: 'try it' })
    const pre = await json(owner, 'POST', `/seller/controls/schools/${IDS.school}/import`, { template: ex.body, dry_run: true })
    expect(pre.status).toBe(200)
    expect(pre.body.schools[0].changes.map((c: any) => c.key).sort()).toEqual(['branding.tagline', 'messaging.daily_cap'])
    const done = await json(owner, 'POST', `/seller/controls/schools/${IDS.school}/import`, { template: ex.body, reason: 'restore' })
    expect(done.body.applied).toBe(true)
    expect((await setting('messaging.daily_cap')).value).toBe(ex.body.settings['messaging.daily_cap'])
    expect((await setting('branding.tagline')).value).toBe(ex.body.settings['branding.tagline'])
  })
})

describe('role templates', () => {
  const ROLE = 'hr'
  it('pushes to schools that kept the built-in role and skips one that customised it unless named', async () => {
    const list = await json(owner, 'GET', '/seller/controls/roles')
    const tpl = list.body.roles.find((r: any) => r.key === ROLE)
    expect(tpl.source).toBe('built-in')
    const dropped = tpl.permissions[tpl.permissions.length - 1]
    const perms = tpl.permissions.filter((p: string) => p !== dropped)
    expect((await json(owner, 'PUT', `/seller/controls/roles/${ROLE}`, { permissions: perms })).status).toBe(200)

    const pre = await json(owner, 'POST', `/seller/controls/roles/${ROLE}/push`, { dry_run: true, institution_ids: [IDS.school] })
    expect(pre.body.schools[0]).toMatchObject({ status: 'updated', removed: 1, added: 0 })
    const T = E.TENANT_TEST
    await T.prepare(`UPDATE roles SET customised_at = ? WHERE key = ?`).bind(new Date().toISOString(), ROLE).run()
    const skip = await json(owner, 'POST', `/seller/controls/roles/${ROLE}/push`, { institution_ids: [IDS.school], reason: 'tighter librarian' })
    expect(skip.body.schools[0].status).toBe('customised')
    const has = async () => !!(await T.prepare(`SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = ? AND rp.permission_key = ?`).bind(ROLE, dropped).first())
    expect(await has()).toBe(true)
    const forced = await json(owner, 'POST', `/seller/controls/roles/${ROLE}/push`, { institution_ids: [IDS.school], include_customised: [IDS.school], reason: 'school agreed' })
    expect(forced.body.schools[0].status).toBe('updated')
    expect(await has()).toBe(false)

    // Back to the built-in list everywhere.
    await json(owner, 'DELETE', `/seller/controls/roles/${ROLE}`)
    await json(owner, 'POST', `/seller/controls/roles/${ROLE}/push`, { institution_ids: [IDS.school], reason: 'tidy up' })
    expect(await has()).toBe(true)
  })

  it('refuses permissions that do not exist', async () => {
    const r = await json(owner, 'PUT', `/seller/controls/roles/${ROLE}`, { permissions: ['students.read', 'made.up.permission'] })
    expect(r.status).toBe(400)
  })
})

describe('privacy: configuration only', () => {
  it('refuses any key the registry does not declare, including record tables', async () => {
    for (const key of ['students.first_name', 'marks.value', 'payments.amount_paise', 'module_settings.config', '../users']) {
      const r = await json(owner, 'PUT', `/seller/controls/schools/${IDS.school}`, { changes: [{ key, value: 'x' }], reason: 'probe' })
      expect(r.status).toBe(400)
    }
    const imp = await json(owner, 'POST', `/seller/controls/schools/${IDS.school}/import`, { template: { format: 'xulo-config/1', settings: { 'guardians.phone': '1' } }, reason: 'probe' })
    expect(imp.status).toBe(400)
  })

  it('refuses a setting that is the school\'s own decision', async () => {
    const r = await json(owner, 'PUT', `/seller/controls/schools/${IDS.school}`, { changes: [{ key: 'security.activity_recording', value: true }], reason: 'probe' })
    expect(r.status).toBe(403)
  })

  it('the registry\'s SQL touches only settings tables', () => {
    const PRIVATE = ['students', 'guardians', 'student_guardians', 'employees', 'users', 'marks', 'exam_marks', 'attendance', 'attendance_records', 'invoices',
      'payments', 'receipts', 'messages', 'files', 'documents', 'status_posts', 'enrollments', 'leave_requests', 'payslips']
    for (const t of STORAGE_TABLES) expect(PRIVATE).not.toContain(t)
    const touched = new Set([...registrySrc.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]))
    expect(touched.size).toBeGreaterThan(0)
    // subscriptions and plans: read only, to know the school's plan.
    for (const t of touched) expect([...STORAGE_TABLES, 'subscriptions', 'plans']).toContain(t)
  })

  it('a seller session reaches school records only by standing inside the school', async () => {
    const r = await json(owner, 'GET', '/students')
    expect(r.status).not.toBe(200)
    // A support login naming a school without a recorded, time-limited grant is outside every school.
    const s = await json(support, 'GET', '/students', undefined, { 'x-acting-institution': IDS.school })
    expect(s.status).not.toBe(200)
  })

  it('support reads the controls and cannot change them; a school admin cannot reach them', async () => {
    const sr = await json(support, 'GET', `/seller/controls/schools/${IDS.school}`)
    expect(sr.status).toBe(200)
    const w = await json(support, 'PUT', `/seller/controls/schools/${IDS.school}`, { changes: [{ key: 'messaging.daily_cap', value: 7 }], reason: 'probe' })
    expect(w.status).toBe(403)
    expect((await api('admin', 'GET', `/seller/controls/schools/${IDS.school}`)).status).toBe(403)
  })
})
