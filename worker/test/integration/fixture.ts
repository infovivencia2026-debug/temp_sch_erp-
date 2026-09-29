/* The integration fixture: CONTROL and one school database built from the
   real db/control.sql and db/tenant.sql, a small seeded school, and sign-in
   through the real POST /login.

   The school is created the way the seller console creates one
   (services/provision.ts runProvision), with the Cloudflare API replaced by
   the local TENANT_TEST binding, so the roles and permissions are the real
   seed. Everything else (classes, students, fees, an exam) is inserted with
   fixed ids so each test file can refer to it by name.

   Miniflare may give each test file its own storage or share it; seed() is
   idempotent either way (it checks for the school first). */
import { env, exports } from 'cloudflare:workers'
import controlSql from '../../db/control.sql?raw'
import tenantSql from '../../db/tenant.sql?raw'
import { runProvision } from '../../src/services/provision'
import { hashPassword } from '../../src/auth/password'
import type { CfD1Api, Stmt } from '../../src/services/d1http'
import type { Env } from '../../src/env'

export const E = env as unknown as Env & { TENANT_TEST: D1Database }
export const BASE = 'https://erp.test'

/* Fixed ids: readable in failures, stable across files. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const IDS = {
  school: id(1), admin: id(2), teacher: id(3), parent: id(4), otherParent: id(5), finance: id(6),
  year: id(10), klass: id(12), section: id(13),
  child: id(20), otherChild: id(21), guardian: id(22), otherGuardian: id(23),
  subject: id(30), classSubject: id(31), exam: id(32), paper: id(33),
  feeHead: id(40), invoice: id(41), otherInvoice: id(42),
} as const

export const PASSWORD = 'correct horse battery staple'
export const USERS = {
  admin: 'admin@test.school', teacher: 'teacher@test.school', parent: 'parent@test.school',
  otherParent: 'other.parent@test.school', finance: 'accounts@test.school',
} as const
export type Who = keyof typeof USERS

/** Statements of a .sql file, keeping CREATE TRIGGER ... END; whole. */
export function statements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let inTrigger = false
  for (const line of sql.split(/\r?\n/)) {
    if (!cur && (/^\s*--/.test(line) || !line.trim())) continue
    cur += line + '\n'
    if (/^\s*CREATE\s+TRIGGER/i.test(line)) inTrigger = true
    const end = inTrigger ? /(^|\s)END\s*;\s*$/i.test(line) : /;\s*(--.*)?$/.test(line)
    if (end) {
      const s = cur.trim()
      if (!/^PRAGMA\b/i.test(s)) out.push(s)
      cur = ''
      inTrigger = false
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

async function applySchema(db: D1Database, sql: string): Promise<void> {
  const stmts = statements(sql).map((s) => db.prepare(s))
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200))
}

/** The Cloudflare D1 API, answered by the local TENANT_TEST binding. */
function localCf(db: D1Database): CfD1Api {
  const one = async (s: Stmt) => {
    const r = await db.prepare(s.sql).bind(...(s.params as unknown[])).all()
    return { results: r.results as Record<string, unknown>[], success: true, meta: r.meta as unknown as Record<string, unknown> }
  }
  return {
    findDatabase: async () => 'local-tenant-test',
    createDatabase: async () => 'local-tenant-test',
    deleteDatabase: async () => {},
    query: async (_id, stmts) => {
      if (stmts.length === 1) return [await one(stmts[0])]
      const rs = await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...(s.params as unknown[]))))
      return rs.map((r) => ({ results: r.results as Record<string, unknown>[], success: true, meta: r.meta as unknown as Record<string, unknown> }))
    },
    exec: async (_id, sql) => applySchema(db, sql),
  }
}

export const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

let seeded: Promise<void> | null = null
/** Builds CONTROL and the school once per storage. */
export function seed(): Promise<void> {
  return (seeded ??= doSeed())
}

async function doSeed(): Promise<void> {
  const C = E.CONTROL, T = E.TENANT_TEST
  const have = await C.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'institutions'`).first()
  if (have && await C.prepare('SELECT 1 FROM institutions WHERE id = ?').bind(IDS.school).first()) return
  await applySchema(C, controlSql)
  await applySchema(T, tenantSql)

  const t = new Date().toISOString()
  const hash = await hashPassword(E.PASSWORD_PEPPER, PASSWORD)
  await C.prepare(`INSERT INTO plans (code, name, price_paise, modules, sequence) VALUES ('test', 'Test plan', 0, '[]', 1)`).run()
  await C.prepare(`INSERT INTO provisioning (id, slug, country, name, short_name, plan_code, trial_days, admin_name, admin_email,
      admin_password_hash, branding, institution_id, admin_user_id, db_name, d1_binding, stage, created_at, updated_at)
      VALUES (?, 'test', 'in', 'Test Public School', 'TPS', 'test', 30, 'Asha Admin', ?, ?, '{}', ?, ?, 'tenant-test', 'TENANT_TEST', 'queued', ?, ?)`)
    .bind(id(99), USERS.admin, hash, IDS.school, IDS.admin, t, t).run()
  const p = await runProvision({ control: C, cf: localCf(T), schemaSql: '', hasBinding: () => true }, id(99))
  if (p?.stage !== 'ready') throw new Error(`provisioning did not finish: ${p?.stage} ${p?.failed_stage}: ${p?.error}`)

  const campus = await T.prepare('SELECT id FROM campuses LIMIT 1').first<{ id: string }>()
  const role = async (key: string) => (await T.prepare('SELECT id FROM roles WHERE key = ?').bind(key).first<{ id: string }>())!.id
  const [ct, parent, fin] = [await role('class_teacher'), await role('parent'), await role('finance')]
  const s = { ...IDS, campus: campus!.id }
  const from = isoDay(-150), to = isoDay(210)
  const user = (uid: string, email: string, name: string) =>
    T.prepare(`INSERT INTO users (id, institution_id, email, full_name, password_hash, status, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`).bind(uid, s.school, email, name, hash, t, t)
  const grant = (uid: string, rid: string) => T.prepare(`INSERT INTO user_roles (id, institution_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), s.school, uid, rid, t)

  await T.batch([
    T.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').bind(s.admin),
    user(s.teacher, USERS.teacher, 'Tara Teacher'), grant(s.teacher, ct),
    user(s.parent, USERS.parent, 'Pavan Parent'), grant(s.parent, parent),
    user(s.otherParent, USERS.otherParent, 'Olga Other'), grant(s.otherParent, parent),
    user(s.finance, USERS.finance, 'Farah Finance'), grant(s.finance, fin),
    T.prepare(`INSERT INTO academic_years (id, institution_id, campus_id, name, starts_on, ends_on, is_current) VALUES (?, ?, ?, 'Current year', ?, ?, 1)`)
      .bind(s.year, s.school, s.campus, from, to),
    T.prepare(`INSERT INTO classes (id, institution_id, campus_id, name, level) VALUES (?, ?, ?, 'Class 5', 5)`).bind(s.klass, s.school, s.campus),
    T.prepare(`INSERT INTO sections (id, institution_id, campus_id, class_id, academic_year_id, name, class_teacher_id) VALUES (?, ?, ?, ?, ?, 'A', ?)`)
      .bind(s.section, s.school, s.campus, s.klass, s.year, s.teacher),
    ...[[s.child, 'A001', 'Chirag', s.guardian, s.parent, 'Pavan Parent', '9000000001'],
        [s.otherChild, 'A002', 'Diya', s.otherGuardian, s.otherParent, 'Olga Other', '9000000002']].flatMap(([sid, adm, name, gid, uid, gname, phone], i) => [
      T.prepare(`INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, last_name, admission_date) VALUES (?, ?, ?, ?, ?, 'Test', ?)`)
        .bind(sid, s.school, s.campus, adm, name, from),
      T.prepare(`INSERT INTO enrollments (id, institution_id, student_id, academic_year_id, class_id, section_id, roll_no, enrolled_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), s.school, sid, s.year, s.klass, s.section, i + 1, from),
      T.prepare(`INSERT INTO guardians (id, institution_id, full_name, relation, phone, email, user_id) VALUES (?, ?, ?, 'father', ?, ?, ?)`)
        .bind(gid, s.school, gname, phone, i ? USERS.otherParent : USERS.parent, uid),
      T.prepare(`INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary) VALUES (?, ?, ?, 1)`).bind(sid, gid, s.school),
    ]),
    T.prepare(`INSERT INTO subjects (id, institution_id, campus_id, name, code) VALUES (?, ?, ?, 'Mathematics', 'MATH')`).bind(s.subject, s.school, s.campus),
    T.prepare(`INSERT INTO class_subjects (id, institution_id, class_id, subject_id) VALUES (?, ?, ?, ?)`).bind(s.classSubject, s.school, s.klass, s.subject),
    T.prepare(`INSERT INTO exams (id, institution_id, campus_id, academic_year_id, name, kind, starts_on, ends_on) VALUES (?, ?, ?, ?, 'Half yearly', 'term', ?, ?)`)
      .bind(s.exam, s.school, s.campus, s.year, isoDay(-10), isoDay(-5)),
    T.prepare(`INSERT INTO exam_subjects (id, institution_id, exam_id, class_subject_id, max_marks, pass_marks) VALUES (?, ?, ?, ?, '100', '33')`)
      .bind(s.paper, s.school, s.exam, s.classSubject),
    T.prepare(`INSERT INTO fee_heads (id, institution_id, name, code) VALUES (?, ?, 'Tuition', 'TUI')`).bind(s.feeHead, s.school),
    ...[[s.invoice, s.child, 'INV-1'], [s.otherInvoice, s.otherChild, 'INV-2']].flatMap(([iid, sid, no]) => [
      T.prepare(`INSERT INTO invoices (id, institution_id, campus_id, student_id, academic_year_id, invoice_no, issued_on, due_on, gross_paise, net_paise, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 500000, 500000, 'unpaid')`).bind(iid, s.school, s.campus, sid, s.year, no, isoDay(-30), isoDay(30)),
      T.prepare(`INSERT INTO invoice_lines (institution_id, invoice_id, fee_head_id, description, amount_paise) VALUES (?, ?, ?, 'Tuition', 500000)`)
        .bind(s.school, iid, s.feeHead),
    ]),
  ])
  await C.batch(([['teacher', s.teacher], ['parent', s.parent], ['otherParent', s.otherParent], ['finance', s.finance]] as const).map(([who, uid]) =>
    C.prepare(`INSERT INTO login_index (kind, value, institution_id, user_id, created_at) VALUES ('email', ?, ?, ?, ?)`).bind(USERS[who], s.school, uid, t)))
}

// --- HTTP through the real Worker -------------------------------------------

const worker = () => (exports as unknown as { default: Fetcher }).default

export function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  return worker().fetch(new Request(BASE + path, { ...init, headers, redirect: 'manual' }))
}

/** Signs in through GET + POST /login as a browser would; returns the session cookie. */
export async function signIn(identifier: string, password = PASSWORD): Promise<{ res: Response; cookie: string | null }> {
  const page = await call('/login')
  const csrfCookie = (page.headers.get('set-cookie') ?? '').match(/erp_csrf=([^;]+)/)?.[1]
  const html = await page.text()
  const token = html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1] ?? html.match(/value="([^"]+)"\s+name="csrf_token"/)?.[1]
  if (!csrfCookie || !token) throw new Error('no CSRF token on the sign-in page')
  const form = new URLSearchParams({ identifier, password, csrf_token: token, next: '/' })
  const res = await call('/login', {
    method: 'POST', body: form, cookie: `erp_csrf=${csrfCookie}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.' + Math.floor(Math.random() * 250) },
  })
  const cookie = (res.headers.get('set-cookie') ?? '').match(/erp_session=([^;]+)/)?.[1]
  return { res, cookie: cookie ? `erp_session=${cookie}` : null }
}

const sessions = new Map<Who, string>()
/** A signed-in session for one of the seeded people, reused within a file. */
export async function as(who: Who): Promise<string> {
  const have = sessions.get(who)
  if (have) return have
  const { res, cookie } = await signIn(USERS[who])
  if (!cookie) throw new Error(`sign-in as ${who} failed: ${res.status}`)
  sessions.set(who, cookie)
  return cookie
}

/** JSON API call as someone; returns status and parsed body. */
export async function api<T = any>(who: Who | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await call('/api/v1' + path, {
    method, cookie: who ? await as(who) : undefined,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed as T }
}
