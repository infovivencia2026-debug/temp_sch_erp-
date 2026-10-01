/* How many D1 statements each hot request prepares, on the TENANT and the
   CONTROL binding, counted by wrapping the bindings' prepare(). The ceilings
   are the figures measured after the request-path work of 2026-10 (one
   scope read shared by every module's resolver, the bootstrap building its
   session part from the identity it already has, the feature switches
   served from memory under CONTROL institutions.features_version). A change
   that adds a read per row, or reads the switches or the session again, pushes
   a figure over its ceiling and fails here; a change that saves reads should
   lower the ceiling it beats.

   The N+1 rule is separate from the ceilings: no statement text is prepared
   more than twice in one request, whatever the row count. */
import { describe, it, expect, beforeAll } from 'vitest'
import { seed, api, call, as, signIn, E, IDS, isoDay } from './fixture'

type Who = 'admin' | 'teacher' | 'parent' | 'finance' | 'student'
const log: { key: 'T' | 'C'; sql: string }[] = []

/* The binding is a real D1Database inside workerd: its prepare and
   withSession are replaced on the object so the Worker (which imports the
   same binding from env) goes through the counter. */
const wrap = (db: D1Database, key: 'T' | 'C') => {
  const d = db as unknown as Record<string, unknown>
  const prepare = db.prepare.bind(db), withSession = db.withSession.bind(db)
  d.prepare = (sql: string) => { log.push({ key, sql }); return prepare(sql) }
  d.withSession = (constraint?: string) => {
    const s = withSession(constraint as never)
    return { prepare: (sql: string) => { log.push({ key, sql }); return s.prepare(sql) }, batch: (x: D1PreparedStatement[]) => s.batch(x), getBookmark: () => s.getBookmark() }
  }
}

let student = ''
beforeAll(async () => {
  await seed()
  wrap(E.TENANT_TEST, 'T'); wrap(E.CONTROL, 'C')
  // A student login, so the portal's own routes are measured as a child sees them.
  await api('admin', 'PUT', '/admin/student-logins', { enabled: true, min_level: 5 })
  const b = await api('admin', 'POST', '/setup/logins/bulk', { kind: 'students', section_id: IDS.section })
  const row = b.body.rows.find((r: { admission_no: string }) => r.admission_no === 'A001')
  const s = await signIn(row.sign_in_as, row.password)
  student = s.cookie!
  await call('/api/v1/profile/password', { method: 'POST', cookie: student, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current_password: row.password, new_password: 'perf-password-xyz-1' }) })
  await Promise.all([as('admin'), as('teacher'), as('parent'), as('finance')])
  await api('teacher', 'POST', '/attendance', { section_id: IDS.section, on_date: isoDay(0), marks: [{ student_id: IDS.child, status: 'present' }, { student_id: IDS.otherChild, status: 'absent' }] })
})

const cookie = async (who: Who) => (who === 'student' ? student : as(who))
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()

/** Runs the request twice (the first warms the per-isolate caches: the switches, the reference lists) and counts the second. */
async function measure(who: Who, path: string) {
  const c = await cookie(who)
  await call('/api/v1' + path, { cookie: c })
  log.length = 0
  const res = await call('/api/v1' + path, { cookie: c })
  const tenant = log.filter((x) => x.key === 'T').length, control = log.filter((x) => x.key === 'C').length
  const repeats = new Map<string, number>()
  for (const x of log) repeats.set(x.key + ' ' + norm(x.sql), (repeats.get(x.key + ' ' + norm(x.sql)) ?? 0) + 1)
  const nPlusOne = [...repeats].filter(([, n]) => n > 2).map(([k, n]) => `${n}x ${k.slice(0, 120)}`)
  return { status: res.status, tenant, control, nPlusOne, statements: log.map((x) => x.key + ' ' + norm(x.sql).slice(0, 120)) }
}

/* [name, who, path, tenant ceiling, control ceiling]. CONTROL is the session,
   the cache versions, the institutions row and the subscription on every
   request (4); the bootstrap adds the client's bookmark on its own (5). */
const cases: [string, Who, string, number, number][] = [
  ['bootstrap, admin', 'admin', '/bootstrap', 52, 5],
  ['bootstrap, teacher', 'teacher', '/bootstrap', 29, 5],
  ['bootstrap, parent', 'parent', '/bootstrap', 23, 5],
  ['bootstrap, student', 'student', '/bootstrap', 23, 5],
  ['portal notifications, parent', 'parent', '/portal/notifications', 15, 4],
  ['portal notifications, student', 'student', '/portal/notifications', 15, 4],
  ['status feed, parent', 'parent', '/status/feed', 14, 4],
  ['status feed, teacher', 'teacher', '/status/feed', 14, 4],
  ['principal dashboard', 'admin', '/principal/dashboard', 12, 4],
  ['teaching today', 'teacher', '/teaching/today', 5, 4],
  ['teaching my-work', 'teacher', '/teaching/my-work', 15, 4],
  ['students list, admin', 'admin', '/students', 12, 4],
  ['students list, class teacher', 'teacher', '/students?mine=class_teacher', 12, 4],
  ['attendance register', 'teacher', `/attendance?on_date=${isoDay(0)}&section_id=${IDS.section}`, 8, 4],
  ['lms course, teacher', 'teacher', `/lms/course?section_id=${IDS.section}&class_subject_id=${IDS.classSubject}`, 18, 4],
  ['lms course, student', 'student', `/portal/lms/course?class_subject_id=${IDS.classSubject}`, 27, 4],
  ['portal lms home, student', 'student', '/portal/lms/home', 19, 4],
]

describe('D1 statements per request', () => {
  for (const [name, who, path, tenantMax, controlMax] of cases) {
    it(`${name}: at most ${tenantMax} tenant and ${controlMax} control statements, none more than twice`, async () => {
      const m = await measure(who, path)
      expect(m.status).toBe(200)
      const detail = `\n${m.statements.join('\n')}`
      expect(m.nPlusOne, `a statement repeats in ${path}: ${m.nPlusOne.join('; ')}${detail}`).toEqual([])
      expect(m.tenant, `tenant statements for ${path}${detail}`).toBeLessThanOrEqual(tenantMax)
      expect(m.control, `control statements for ${path}${detail}`).toBeLessThanOrEqual(controlMax)
    })
  }

  it('a second request in the same isolate reads no feature switches', async () => {
    const m = await measure('parent', '/status/feed')
    expect(m.statements.some((s) => /FROM school_feature_overrides/.test(s))).toBe(false)
  })
})
