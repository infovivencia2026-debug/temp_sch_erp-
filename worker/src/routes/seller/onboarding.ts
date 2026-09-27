import type { Router } from '../../router'
import type { Env } from '../../env'
import { badRequest, isUUID, notFound, now, ok } from '../../http'
import { institutionById, tenantDb, type Institution } from '../../tenant'
import { SENT_BY_PLATFORM } from '../../services/messaging'
import { BUILTIN_TEMPLATES } from '../admin/msg_templates'
import { registerJob } from '../../services/jobs'
import { SCHEDULES } from '../../services/cron'
import { requirePlatformAdmin } from './common'
import { daysBetween, isDevelopment, notifySchool, todayIST } from './billing'

/* Onboarding tracker (Seller → Schools → Setup).

   Each school's progress through nine milestones, from its creation to the
   first parent signing in. The dates are read from the school's own D1 by the
   onboarding:scan job (every six hours, and on demand from the screen), with
   a bounded parallel fan-out, and kept in CONTROL.onboarding_progress. A date
   once recorded is never moved, so deleting the only student does not undo
   "students imported".

   Stalled: within its first 60 days, a school that has not reached every
   milestone and has made no progress for more than 7 days. The nudge emails
   the school's administrator a checklist of what is left, through the
   platform's email channel; nothing is sent outside production. */

const PERM = 'platform.tenants.write'
const FAN_OUT = 6
const STALL_DAYS = 7
const WINDOW_DAYS = 60

export const MILESTONES: { key: string; col: string | null; label: string; step: string }[] = [
  { key: 'created', col: null, label: 'Created', step: '' },
  { key: 'admin_signed_in', col: 'admin_signed_in_at', label: 'Admin signed in', step: 'Sign in with the administrator account you were given, and set your own password.' },
  { key: 'profile_complete', col: 'profile_complete_at', label: 'Profile complete', step: 'Complete the school profile: board, state and district (Settings → School → School setup).' },
  { key: 'classes_set_up', col: 'classes_set_up_at', label: 'Classes set up', step: 'Set up your classes and sections for the current academic year.' },
  { key: 'students_imported', col: 'students_imported_at', label: 'Students imported', step: 'Import your students, from a spreadsheet or one by one.' },
  { key: 'staff_added', col: 'staff_added_at', label: 'Staff added', step: 'Add your teachers and staff so they can sign in.' },
  { key: 'first_attendance', col: 'first_attendance_at', label: 'First attendance', step: 'Mark attendance for one class, to see the day\'s register fill in.' },
  { key: 'first_fee', col: 'first_fee_at', label: 'First fee collected', step: 'Set up the fee structure and record the first fee payment.' },
  { key: 'first_parent', col: 'first_parent_signed_in_at', label: 'First parent signed in', step: 'Invite parents to sign in to the parent app or portal.' },
]
const COLS = MILESTONES.filter((m) => m.col).map((m) => m.col!)

BUILTIN_TEMPLATES['onboarding.nudge'] = {
  subject: '{{school_name}}: your next steps to get started',
  body: 'Dear {{admin_name}},\n\n{{school_name}} is {{done}} of {{total}} steps into getting started. Here is what is left:\n\n{{checklist}}\n\n' +
    'Reply to this email if you would like us to help with any of them.\n\n{{seller_name}}',
}
SENT_BY_PLATFORM['onboarding.nudge'] = true

type Found = Record<string, string | null>

/** The first date of each milestone, as the school's own database knows it. */
async function readMilestones(env: Env, inst: Institution): Promise<Found> {
  const db = tenantDb(env, inst)
  const r = await db.prepare(`SELECT
      (SELECT MIN(u.last_login_at) FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE r.key = 'institution_admin') AS admin_login,
      (SELECT updated_at FROM institutions WHERE id = ?1 AND COALESCE(affiliation_board, '') <> '' AND COALESCE(state, '') <> ''
        AND COALESCE(district, '') <> '') AS profile,
      (SELECT MIN(created_at) FROM sections) AS classes,
      (SELECT MIN(created_at) FROM students) AS students,
      (SELECT MIN(created_at) FROM employees) AS staff,
      (SELECT MIN(marked_at) FROM student_attendance) AS attendance,
      (SELECT MIN(created_at) FROM payments WHERE status = 'success') AS fee,
      (SELECT MIN(u.last_login_at) FROM guardians g JOIN users u ON u.id = g.user_id WHERE u.last_login_at IS NOT NULL) AS parent`)
    .bind(inst.id).first<Record<string, string | null>>()
  // The first administrator session still on record is earlier than last_login_at, which moves.
  const admins = (await db.prepare(`SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.key = 'institution_admin'`)
    .all<{ user_id: string }>()).results.map((x) => x.user_id)
  let firstSession: string | null = null
  if (admins.length) {
    const s = await env.CONTROL.prepare(`SELECT MIN(created_at) AS at FROM sessions WHERE institution_id = ? AND user_id IN (${admins.slice(0, 50).map(() => '?').join(',')})`)
      .bind(inst.id, ...admins.slice(0, 50)).first<{ at: string | null }>()
    firstSession = s?.at ?? null
  }
  const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b)
  return {
    admin_signed_in_at: earliest(firstSession, r?.admin_login ?? null),
    profile_complete_at: r?.profile ?? null,
    classes_set_up_at: r?.classes ?? null,
    students_imported_at: r?.students ?? null,
    staff_added_at: r?.staff ?? null,
    first_attendance_at: r?.attendance ?? null,
    first_fee_at: r?.fee ?? null,
    first_parent_signed_in_at: r?.parent ?? null,
  }
}

async function scanOne(env: Env, inst: Institution): Promise<boolean> {
  const t = now()
  let found: Found = {}, error: string | null = null
  try { found = await readMilestones(env, inst) } catch (e) { error = String((e as Error)?.message ?? e).slice(0, 300) }
  // COALESCE(existing, new): the first date seen is kept.
  await env.CONTROL.prepare(`INSERT INTO onboarding_progress (institution_id, ${COLS.join(', ')}, scan_error, checked_at)
      VALUES (?, ${COLS.map(() => '?').join(', ')}, ?, ?)
      ON CONFLICT (institution_id) DO UPDATE SET ${COLS.map((c) => `${c} = COALESCE(onboarding_progress.${c}, excluded.${c})`).join(', ')},
        scan_error = excluded.scan_error, checked_at = excluded.checked_at`)
    .bind(inst.id, ...COLS.map((c) => found[c] ?? null), error, t).run()
  return !error
}

/** Reads every active school (or one), FAN_OUT at a time. */
export async function scanOnboarding(env: Env, only?: string): Promise<{ schools: number; failed: number }> {
  const schools = only
    ? [await institutionById(env, only)].filter((x): x is Institution => !!x)
    : (await env.CONTROL.prepare(`SELECT * FROM institutions WHERE status = 'active' ORDER BY created_at`).all<Institution>()).results
  let next = 0, failed = 0
  const worker = async () => {
    while (next < schools.length) {
      const inst = schools[next++]
      try { if (!(await scanOne(env, inst))) failed++ } catch (e) { failed++; console.error('onboarding scan', inst.slug, e) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(FAN_OUT, schools.length) }, worker))
  return { schools: schools.length, failed }
}

registerJob('onboarding:scan', async (env) => { await scanOnboarding(env) })
SCHEDULES.push({ name: 'onboarding_scan', spec: '10 */6 * * *', kind: 'onboarding:scan', perInstitution: false, payload: () => ({}) })

interface Row extends Record<string, unknown> {
  institution_id: string; school: string; slug: string; created_at: string; status: string
  checked_at: string | null; scan_error: string | null; last_nudged_at: string | null; nudge_count: number | null
}

function shape(r: Row, today: string) {
  const created = r.created_at.slice(0, 10)
  const milestones = MILESTONES.map((m) => ({ key: m.key, label: m.label, at: m.col ? ((r[m.col] as string | null) ?? null) : r.created_at }))
  const done = milestones.filter((m) => m.at).length
  const last = milestones.reduce<string>((a, m) => (m.at && m.at > a ? m.at : a), r.created_at)
  const age = daysBetween(created, today)
  const since = daysBetween(last.slice(0, 10), today)
  const complete = done === milestones.length
  const next = MILESTONES.filter((m) => m.col && !r[m.col]).map((m) => m.label)
  return {
    institution_id: r.institution_id, school: r.school, slug: r.slug, status: r.status, created_at: r.created_at,
    milestones, done, total: milestones.length, complete, last_progress_at: last, days_since_progress: since, age_days: age,
    stalled: !complete && age <= WINDOW_DAYS && since > STALL_DAYS, next_steps: next,
    checked_at: r.checked_at, scan_error: r.scan_error, last_nudged_at: r.last_nudged_at, nudge_count: r.nudge_count ?? 0,
  }
}

async function rows(env: Env, where = '', binds: unknown[] = []): Promise<Row[]> {
  return (await env.CONTROL.prepare(`SELECT i.id AS institution_id, i.name AS school, i.slug, i.created_at, i.status,
      o.${COLS.join(', o.')}, o.checked_at, o.scan_error, o.last_nudged_at, o.nudge_count
      FROM institutions i LEFT JOIN onboarding_progress o ON o.institution_id = i.id ${where} ORDER BY i.created_at DESC`).bind(...binds).all<Row>()).results
}

export function registerSellerOnboarding(r: Router): void {
  r.get('/seller/onboarding', PERM, async (c) => {
    requirePlatformAdmin(c)
    const today = todayIST()
    const items = (await rows(c.env)).map((x) => shape(x, today))
    return ok({
      items, milestones: MILESTONES.map((m) => ({ key: m.key, label: m.label })),
      stalled: items.filter((x) => x.stalled).length, stall_days: STALL_DAYS, window_days: WINDOW_DAYS,
      checked_at: items.reduce<string | null>((a, x) => (x.checked_at && (!a || x.checked_at > a) ? x.checked_at : a), null),
    })
  })

  // Re-reads the schools now (all, or ?institution_id=).
  r.post('/seller/onboarding/scan', PERM, async (c) => {
    requirePlatformAdmin(c)
    const one = c.url.searchParams.get('institution_id') ?? ''
    if (one && !isUUID(one)) throw badRequest('invalid institution_id')
    return ok(await scanOnboarding(c.env, one || undefined))
  })

  // Emails the school's administrator a checklist of the steps left.
  r.post('/seller/onboarding/{id}/nudge', PERM, async (c) => {
    requirePlatformAdmin(c)
    if (!isUUID(c.params.id)) throw badRequest('invalid institution id')
    const inst = await institutionById(c.env, c.params.id)
    if (!inst) throw notFound('no such school')
    await scanOne(c.env, inst)
    const [row] = await rows(c.env, 'WHERE i.id = ?', [inst.id])
    const s = shape(row, todayIST())
    if (s.complete) throw badRequest('this school has reached every milestone; there is nothing to nudge about')
    const steps = MILESTONES.filter((m) => m.col && !row[m.col])
    const checklist = steps.map((m, i) => `${i + 1}. ${m.step}`).join('\n')
    const seller = await c.env.CONTROL.prepare(`SELECT seller_name FROM billing_settings WHERE id = 1`).first<{ seller_name: string }>()
    const res = await notifySchool(c.env, inst, 'onboarding.nudge', `onboarding.nudge:${Date.now()}`, {
      done: s.done, total: s.total, checklist, seller_name: seller?.seller_name ?? '',
    })
    if (res.queued) {
      await c.env.CONTROL.prepare(`UPDATE onboarding_progress SET last_nudged_at = ?, nudge_count = nudge_count + 1 WHERE institution_id = ?`)
        .bind(now(), inst.id).run()
    }
    return ok({ ...res, development: isDevelopment(c.env), checklist: steps.map((m) => m.step) })
  })
}
