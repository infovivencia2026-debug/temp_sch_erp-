import type { Ctx, Router } from '../../router'
import type { Env } from '../../env'
import { HttpError, badRequest, created, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { institutionById, tenantDb, type Institution } from '../../tenant'
import { computeSchoolHealth } from '../../services/background/health'
import { recordSellerAction } from '../../services/seller_audit'
import { billingSettings, daysBetween, notifySchool, rupees, schoolAdmin, todayIST } from './billing'
import { changeSubscription } from './tenants'
import { requirePlatformAdmin } from './common'

/* One school's account at a glance (School 360), the renewals coming up with
   a churn-risk flag, and bulk actions over chosen schools.

   Everything here is read from what already exists: the subscription and
   invoices in CONTROL, the health numbers (services/background/health.ts),
   backups, and counts from the school's own database. Nothing is estimated.

   The churn-risk rule, the same on the server and on screen: a school is at
   risk when its payment is overdue (past_due, or an unpaid invoice past its
   due date), when nobody has signed in for 14 days, or when fewer than one in
   five of its active users signed in during the last 7 days. */

const PERM = 'platform.tenants.write'
export const QUIET_DAYS = 14
export const LOW_ADOPTION_PCT = 20
export const RISK_RULE = `At risk when payment is overdue, nobody has signed in for ${QUIET_DAYS} days, or under ${LOW_ADOPTION_PCT}% of active users signed in this week.`

export interface RiskInput { past_due: boolean; last_sign_in: string | null; adoption_pct: number | null }
/** The reasons a school is at risk of not renewing; empty when it is not. */
export function churnRisk(s: RiskInput, at = Date.now()): string[] {
  const why: string[] = []
  if (s.past_due) why.push('Payment overdue')
  if (!s.last_sign_in || at - Date.parse(s.last_sign_in) > QUIET_DAYS * 86_400_000) why.push(`No sign-in for ${QUIET_DAYS} days`)
  if (s.adoption_pct !== null && s.adoption_pct < LOW_ADOPTION_PCT) why.push('Low use')
  return why
}

const openDb = (env: Env, inst: Institution): D1Database | null => { try { return tenantDb(env, inst) } catch { return null } }

/** Counts from the school's own database; null fields when it cannot be opened. */
async function schoolCounts(env: Env, inst: Institution) {
  const db = openDb(env, inst)
  if (!db) return null
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString()
  try {
    return await db.prepare(`SELECT
        (SELECT count(*) FROM students WHERE status = 'active') AS students,
        (SELECT count(*) FROM users WHERE status = 'active') AS users,
        COALESCE((SELECT sum(size_bytes) FROM files WHERE deleted_at IS NULL), 0) AS stored_bytes,
        (SELECT count(*) FROM message_log WHERE status = 'failed' AND failed_at >= ?) AS failed_messages_7d,
        (SELECT count(*) FROM support_tickets WHERE status <> 'closed' AND audience = 'vendor') AS open_tickets`).bind(since7)
      .first<{ students: number; users: number; stored_bytes: number; failed_messages_7d: number; open_tickets: number }>()
  } catch (e) { console.error('school360 counts', inst.slug, e); return null }
}

interface Money { unpaid_invoices: number; balance_paise: number; oldest_due_on: string | null; failed_payments_30d: number }
async function money(env: Env, instId: string): Promise<Money> {
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const r = await env.CONTROL.prepare(`SELECT
      (SELECT count(*) FROM billing_invoices WHERE institution_id = ?1 AND status IN ('issued','partial')) AS unpaid_invoices,
      COALESCE((SELECT sum(total_paise - paid_paise) FROM billing_invoices WHERE institution_id = ?1 AND status IN ('issued','partial')), 0) AS balance_paise,
      (SELECT min(due_on) FROM billing_invoices WHERE institution_id = ?1 AND status IN ('issued','partial')) AS oldest_due_on,
      (SELECT count(*) FROM billing_gateway_orders WHERE institution_id = ?1 AND status = 'failed' AND created_at >= ?2) AS failed_payments_30d`)
    .bind(instId, since30).first<Money>()
  return r ?? { unpaid_invoices: 0, balance_paise: 0, oldest_due_on: null, failed_payments_30d: 0 }
}

async function lastSignIn(env: Env, instId: string): Promise<string | null> {
  return (await env.CONTROL.prepare(`SELECT max(last_seen_at) AS at FROM sessions WHERE institution_id = ?`).bind(instId).first<{ at: string | null }>())?.at ?? null
}

async function subscriptionOf(env: Env, instId: string) {
  return env.CONTROL.prepare(`SELECT s.plan_code, p.name AS plan_name, s.status, s.renews_on, s.licensed_students,
      COALESCE(s.storage_gb, p.max_storage_gb) AS storage_limit_gb, p.max_students
      FROM subscriptions s LEFT JOIN plans p ON p.code = s.plan_code WHERE s.institution_id = ?`).bind(instId)
    .first<{ plan_code: string; plan_name: string | null; status: string; renews_on: string | null; licensed_students: number | null; storage_limit_gb: number | null; max_students: number | null }>()
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null)

/* --- bulk ------------------------------------------------------------------- */

type BulkAction = 'plan' | 'reminder' | 'announcement'
interface BulkReq { action?: string; institution_ids?: unknown; dry_run?: boolean; plan_code?: string; title?: string; body?: string; severity?: string }
interface BulkRow { id: string; name: string; change: string; skipped?: string; done?: boolean; error?: string }

async function bulk(c: Ctx, req: BulkReq): Promise<{ applied: boolean; action: BulkAction; schools: BulkRow[]; announcement_id?: string }> {
  const action = req.action as BulkAction
  if (!['plan', 'reminder', 'announcement'].includes(action)) throw badRequest('action must be plan, reminder or announcement')
  if (!Array.isArray(req.institution_ids) || req.institution_ids.length === 0) throw badRequest('choose at least one school')
  if (req.institution_ids.length > 200) throw badRequest('at most 200 schools at once')
  const ids = [...new Set(req.institution_ids.map((x) => uuidParam(String(x), 'institution_ids')))]
  const dry = !!req.dry_run
  let plan: { code: string; name: string } | null = null
  if (action === 'plan') {
    plan = await c.env.CONTROL.prepare(`SELECT code, name FROM plans WHERE code = ?`).bind(String(req.plan_code ?? '')).first<{ code: string; name: string }>()
    if (!plan) throw badRequest('choose a plan that exists')
  }
  const title = (req.title ?? '').trim(), body = (req.body ?? '').trim()
  const severity = req.severity || 'info'
  if (action === 'announcement') {
    if (!title) throw badRequest('an announcement needs a title')
    if (!['info', 'warning', 'critical'].includes(severity)) throw badRequest('severity must be info, warning or critical')
  }
  const settings = action === 'reminder' ? await billingSettings(c.env) : null
  const rows: BulkRow[] = []
  const reached: { id: string; name: string }[] = []
  for (const id of ids) {
    const inst = await institutionById(c.env, id)
    if (!inst) { rows.push({ id, name: '', change: '', skipped: 'no such school' }); continue }
    const sub = await subscriptionOf(c.env, id)
    const row: BulkRow = { id, name: inst.name, change: '' }
    try {
      if (action === 'plan') {
        const from = sub?.plan_name ?? sub?.plan_code ?? 'no plan'
        if (sub?.plan_code === plan!.code) { row.skipped = `already on ${plan!.name}`; rows.push(row); continue }
        row.change = `${from} to ${plan!.name}`
        if (!dry) await changeSubscription(c.env, id, { plan_code: plan!.code })
      } else if (action === 'reminder') {
        const db = openDb(c.env, inst)
        const admin = db ? await schoolAdmin(db) : null
        if (!admin) { row.skipped = 'no administrator with an email address'; rows.push(row); continue }
        const renews = sub?.renews_on?.slice(0, 10) ?? null
        if (!renews) { row.skipped = 'no renewal date set'; rows.push(row); continue }
        const m = await money(c.env, id)
        row.change = `Renewal reminder for ${renews} to ${admin.email}`
        if (!dry) {
          const res = await notifySchool(c.env, inst, 'billing.renewal', `billing.renewal:manual:${renews}:${todayIST()}`, {
            days: Math.max(0, daysBetween(todayIST(), renews)), renews_on: renews, plan: sub?.plan_name ?? 'school', seller_name: settings!.seller_name,
            balance_line: m.balance_paise > 0 ? `\n\nOutstanding on your account: ${rupees(m.balance_paise)}.` : '',
          })
          if (!res.queued) row.skipped = res.reason ?? 'not sent'
        }
      } else {
        row.change = `Shown to this school: ${title}`
        reached.push({ id, name: inst.name })
      }
      if (!dry && !row.skipped) row.done = true
    } catch (e) {
      row.error = e instanceof HttpError ? e.message : 'could not reach this school'
    }
    rows.push(row)
  }
  let announcement: string | undefined
  if (action === 'announcement' && !dry && reached.length) {
    announcement = uuid()
    const t = now()
    await c.env.CONTROL.batch([
      c.env.CONTROL.prepare(`INSERT INTO platform_broadcasts (id, severity, title, body, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`)
        .bind(announcement, severity, title, body, t, c.id.userId, t),
      c.env.CONTROL.prepare(`INSERT INTO platform_broadcast_targets (broadcast_id, target_kind, target_ids, audiences, updated_at) VALUES (?, 'schools', ?, '["admins","staff","parents"]', ?)`)
        .bind(announcement, JSON.stringify(reached.map((s) => s.id)), t),
    ])
  }
  // One audit row per school changed, which that school reads under Security, Vendor activity.
  if (!dry) {
    for (const row of rows.filter((x) => x.done)) {
      await recordSellerAction(c.env, { actor_id: c.id.userId, actor_name: c.id.fullName, actor_roles: c.id.roles, method: c.req.method, path: c.url.pathname,
        route: null, action: `seller.bulk.${action}`, institution_id: row.id, institution_name: row.name, target: action === 'plan' ? plan!.code : announcement ?? null,
        after: { change: row.change }, status: 200, ip: c.req.headers.get('cf-connecting-ip') })
    }
  }
  return { applied: !dry, action, schools: rows, ...(announcement ? { announcement_id: announcement } : {}) }
}

export function registerSellerAccounts(r: Router): void {
  r.get('/seller/school360/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inst = await institutionById(c.env, uuidParam(c.params.id))
    if (!inst) throw notFound('no such school')
    const [sub, counts, m, signIn, health, backup] = await Promise.all([
      subscriptionOf(c.env, inst.id), schoolCounts(c.env, inst), money(c.env, inst.id), lastSignIn(c.env, inst.id),
      computeSchoolHealth(c.env, inst).catch(() => null),
      c.env.CONTROL.prepare(`SELECT max(finished_at) AS at FROM backups WHERE institution_id = ? AND status = 'succeeded'`).bind(inst.id).first<{ at: string | null }>(),
    ])
    const today = todayIST()
    const active7 = health?.active_7d.total ?? 0
    const adoption = counts ? pct(active7, counts.users) : null
    const pastDue = sub?.status === 'past_due' || (!!m.oldest_due_on && m.oldest_due_on < today)
    const licensed = sub?.licensed_students ?? sub?.max_students ?? null
    return ok({
      school: { id: inst.id, name: inst.name, slug: inst.slug, status: inst.status },
      plan: sub ? { code: sub.plan_code, name: sub.plan_name, status: sub.status, renews_on: sub.renews_on?.slice(0, 10) ?? null,
        renews_in_days: sub.renews_on ? daysBetween(today, sub.renews_on.slice(0, 10)) : null } : null,
      students: { licensed, actual: counts?.students ?? null, over_by: licensed !== null && counts ? Math.max(0, counts.students - licensed) : 0 },
      last_sign_in: signIn,
      storage: { used_bytes: counts?.stored_bytes ?? null, limit_gb: sub?.storage_limit_gb ?? null },
      errors_24h: health?.errors_24h ?? 0, failed_jobs_24h: health?.jobs_failed_24h ?? 0,
      failed_payments_30d: m.failed_payments_30d, failed_messages_7d: counts?.failed_messages_7d ?? null,
      billing: { unpaid_invoices: m.unpaid_invoices, balance_paise: m.balance_paise, oldest_due_on: m.oldest_due_on, past_due: pastDue },
      open_tickets: counts?.open_tickets ?? null,
      last_backup_at: backup?.at ?? null,
      adoption: { active_users_7d: active7, users: counts?.users ?? null, pct: adoption },
      setup: health?.setup ?? null,
      risk: churnRisk({ past_due: pastDue, last_sign_in: signIn, adoption_pct: adoption }),
      risk_rule: RISK_RULE,
      reachable: counts !== null,
    })
  })

  // Schools renewing within 30, 60 or 90 days, soonest first, each with its risk.
  r.get('/seller/renewals', PERM, async (c) => {
    requirePlatformAdmin(c)
    const days = Number(c.url.searchParams.get('days') ?? 30)
    if (![30, 60, 90].includes(days)) throw badRequest('days is 30, 60 or 90')
    const today = todayIST()
    const until = new Date(Date.parse(today + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10)
    const subs = (await c.env.CONTROL.prepare(`SELECT s.institution_id, i.name, s.plan_code, p.name AS plan_name, s.status, substr(s.renews_on, 1, 10) AS renews_on,
        s.agreed_price_paise, p.price_paise, h.data AS health
        FROM subscriptions s JOIN institutions i ON i.id = s.institution_id LEFT JOIN plans p ON p.code = s.plan_code
        LEFT JOIN school_health h ON h.institution_id = i.id
        WHERE s.status NOT IN ('cancelled') AND s.renews_on IS NOT NULL AND substr(s.renews_on, 1, 10) BETWEEN ? AND ?
        ORDER BY s.renews_on, i.name`).bind(today, until)
      .all<{ institution_id: string; name: string; plan_code: string | null; plan_name: string | null; status: string; renews_on: string
        agreed_price_paise: number | null; price_paise: number | null; health: string | null }>()).results
    const items = await Promise.all(subs.map(async (s) => {
      const inst = await institutionById(c.env, s.institution_id)
      const [m, signIn, users] = await Promise.all([
        money(c.env, s.institution_id), lastSignIn(c.env, s.institution_id),
        (async () => {
          const db = inst ? openDb(c.env, inst) : null
          if (!db) return null
          try { return (await db.prepare(`SELECT count(*) AS n FROM users WHERE status = 'active'`).first<{ n: number }>())?.n ?? 0 } catch { return null }
        })(),
      ])
      let active7 = 0
      try { active7 = Number(JSON.parse(s.health ?? '{}')?.active_7d?.total ?? 0) } catch { /* no snapshot yet */ }
      const adoption = users === null ? null : pct(active7, users)
      const pastDue = s.status === 'past_due' || (!!m.oldest_due_on && m.oldest_due_on < today)
      return { institution_id: s.institution_id, name: s.name, plan_code: s.plan_code, plan_name: s.plan_name, status: s.status, renews_on: s.renews_on,
        renews_in_days: daysBetween(today, s.renews_on), value_paise: s.agreed_price_paise ?? s.price_paise ?? null, balance_paise: m.balance_paise,
        last_sign_in: signIn, adoption_pct: adoption, risk: churnRisk({ past_due: pastDue, last_sign_in: signIn, adoption_pct: adoption }) }
    }))
    return ok({ items, days, rule: RISK_RULE })
  })

  /* Bulk: a plan change, a renewal reminder or an announcement for the
     chosen schools. dry_run returns what would change, school by school,
     and changes nothing. */
  r.post('/seller/bulk', PERM, async (c) => {
    requirePlatformAdmin(c)
    const res = await bulk(c, await readJSON<BulkReq>(c.req))
    return res.applied ? created(res) : ok(res)
  })
}
