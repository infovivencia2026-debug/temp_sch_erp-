import type { Ctx } from '../../router'
import type { Probe, ProbeResult } from './loose'
import { addDays } from '../students/common'

/* The school's own account on the admin's board: storage and the student
   licence against the plan, message credits, the subscription and the
   provider's invoices, feature trials, backups, and the papers that lapse
   (bus insurance, fitness and PUC; staff medical certificates).

   Everything is computed live. The CONTROL facts are one query and the
   tenant's usage another, each run at most once per request however many
   probes read them. */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from)) / 86_400_000)
const inDays = (n: number) => (n <= 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`)
function rupees(paise: number): string {
  const r = paise / 100
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`
  if (r >= 1000) return `₹${(r / 1000).toFixed(1)}K`
  return `₹${r.toFixed(0)}`
}

/** Thresholds shared with the nightly bell notifications (services/background/health.ts). */
export const TRIAL_WARN_DAYS = 14, RENEWAL_WARN_DAYS = 30, FEATURE_TRIAL_DAYS = 7, PAPERS_DAYS = 30, BACKUP_STALE_HOURS = 48

export interface AccountFacts {
  status: string | null; renews_on: string | null; trial_ends_on: string | null
  licensed: number | null; storage_gb: number | null
  open_n: number; open_paise: number; overdue_n: number; overdue_paise: number
  trials_n: number; trials_soonest: string | null
  backups_n: number; last_status: string | null; last_good: string | null
}

/** One CONTROL round trip for every account fact of one school. */
export async function accountFacts(control: D1Database, institutionId: string, today: string, nowISO: string): Promise<AccountFacts> {
  const r = await control.prepare(`
    SELECT s.status, s.renews_on, s.trial_ends_on,
           COALESCE(s.licensed_students, p.max_students) AS licensed, COALESCE(s.storage_gb, p.max_storage_gb) AS storage_gb,
           (SELECT count(*) FROM billing_invoices b WHERE b.institution_id = ?1 AND b.status IN ('issued','partial')) AS open_n,
           (SELECT COALESCE(sum(b.total_paise - b.paid_paise), 0) FROM billing_invoices b WHERE b.institution_id = ?1 AND b.status IN ('issued','partial')) AS open_paise,
           (SELECT count(*) FROM billing_invoices b WHERE b.institution_id = ?1 AND b.status IN ('issued','partial') AND b.due_on < ?2) AS overdue_n,
           (SELECT COALESCE(sum(b.total_paise - b.paid_paise), 0) FROM billing_invoices b WHERE b.institution_id = ?1 AND b.status IN ('issued','partial') AND b.due_on < ?2) AS overdue_paise,
           (SELECT count(*) FROM school_feature_overrides f WHERE f.institution_id = ?1 AND f.enabled = 1 AND f.ends_at >= ?3 AND f.ends_at <= ?4) AS trials_n,
           (SELECT min(f.ends_at) FROM school_feature_overrides f WHERE f.institution_id = ?1 AND f.enabled = 1 AND f.ends_at >= ?3 AND f.ends_at <= ?4) AS trials_soonest,
           (SELECT count(*) FROM backups k WHERE k.institution_id = ?1) AS backups_n,
           (SELECT k.status FROM backups k WHERE k.institution_id = ?1 AND k.status IN ('succeeded','failed','pruned','replaced')
             ORDER BY k.started_at DESC LIMIT 1) AS last_status,
           (SELECT max(k.finished_at) FROM backups k WHERE k.institution_id = ?1 AND k.status IN ('succeeded','pruned','replaced')) AS last_good
      FROM (SELECT 1) one
      LEFT JOIN subscriptions s ON s.institution_id = ?1
      LEFT JOIN plans p ON p.code = s.plan_code`)
    .bind(institutionId, today, nowISO, new Date(Date.parse(nowISO) + FEATURE_TRIAL_DAYS * 86_400_000).toISOString())
    .first<Record<string, unknown>>()
  const n = (v: unknown) => Number(v ?? 0)
  const s = (v: unknown) => (v == null ? null : String(v))
  return {
    status: s(r?.status), renews_on: s(r?.renews_on), trial_ends_on: s(r?.trial_ends_on),
    licensed: r?.licensed == null ? null : n(r.licensed), storage_gb: r?.storage_gb == null ? null : n(r.storage_gb),
    open_n: n(r?.open_n), open_paise: n(r?.open_paise), overdue_n: n(r?.overdue_n), overdue_paise: n(r?.overdue_paise),
    trials_n: n(r?.trials_n), trials_soonest: s(r?.trials_soonest),
    backups_n: n(r?.backups_n), last_status: s(r?.last_status), last_good: s(r?.last_good),
  }
}

/* The subscription, trial, renewal and invoice states, each as a level (80
   warning, 100 critical) with its words. The board and the nightly bell read
   the same function, so they never disagree. A suspended, past-due or lapsed
   trial school is not here: the subscription gate already replaces every
   screen with its own notice, so neither the board nor the bell is seen. */
export interface AccountAlert { metric: 'trial' | 'renewal' | 'invoice'; level: 80 | 100; title: string; detail: string; amount?: number }

export function subscriptionAlerts(f: AccountFacts, today: string): AccountAlert[] {
  const out: AccountAlert[] = []
  if (f.status === 'trial' && f.trial_ends_on) {
    const left = daysBetween(today, f.trial_ends_on)
    if (left >= 0 && left <= TRIAL_WARN_DAYS) out.push({ metric: 'trial', level: 80, title: `Trial ends ${inDays(left)}`, detail: `Ends on ${day(f.trial_ends_on)}. Ask your provider to start the subscription.` })
  }
  if (f.status === 'active' && f.renews_on) {
    const left = daysBetween(today, f.renews_on)
    if (left < 0) out.push({ metric: 'renewal', level: 100, title: `Subscription renewal was due on ${day(f.renews_on)}`, detail: 'Ask your provider to renew it.' })
    else if (left <= RENEWAL_WARN_DAYS) out.push({ metric: 'renewal', level: 80, title: `Subscription renews ${inDays(left)}`, detail: `Renews on ${day(f.renews_on)}.` })
  }
  if (f.overdue_n > 0) {
    out.push({ metric: 'invoice', level: 100, amount: f.overdue_paise, title: `${rupees(f.overdue_paise)} overdue on ${plural(f.overdue_n, 'provider invoice', 'provider invoices')}`,
      detail: 'Pay it to avoid the account being suspended.' })
  } else if (f.open_n > 0) {
    out.push({ metric: 'invoice', level: 80, amount: f.open_paise, title: `${rupees(f.open_paise)} unpaid on ${plural(f.open_n, 'provider invoice', 'provider invoices')}`,
      detail: 'Not yet past its due date.' })
  }
  return out
}

/* Per request memo: probes run concurrently, so they share the promise. */
const factsMemo = new WeakMap<Ctx, Promise<AccountFacts | null>>()
const usageMemo = new WeakMap<Ctx, Promise<TenantFacts>>()

function factsOf(c: Ctx, today: string): Promise<AccountFacts | null> {
  let p = factsMemo.get(c)
  if (!p) {
    const inst = c.id.institution
    p = inst ? accountFacts(c.env.CONTROL, inst.id, today, new Date().toISOString()) : Promise.resolve(null)
    factsMemo.set(c, p)
  }
  return p
}

interface Credit { channel: string; balance: number; low_water: number }
interface TenantFacts { students: number; bytes: number; credits: Credit[]; papers: [number, number]; medical: [number, number] }

/* Every tenant figure the account probes read, in one statement: the roll,
   the bytes stored, the low credit balances, and the expired and soon-due
   bus papers and medical certificates (only each person's latest certificate
   of each kind counts, since a renewed one replaces the old). */
function usageOf(c: Ctx, today: string): Promise<TenantFacts> {
  let p = usageMemo.get(c)
  if (!p) {
    p = c.db.prepare(`
      WITH papers AS (
        SELECT insurance_expiry AS d FROM vehicles WHERE status = 'active'
        UNION ALL SELECT fitness_expiry FROM vehicles WHERE status = 'active'
        UNION ALL SELECT puc_expiry FROM vehicles WHERE status = 'active'),
      med AS (
        SELECT max(m.valid_until) AS v FROM medical_fitness_certificates m JOIN employees e ON e.id = m.employee_id
         WHERE e.status = 'active' GROUP BY m.employee_id, m.purpose)
      SELECT (SELECT count(*) FROM students WHERE status = 'active') AS students,
             COALESCE((SELECT sum(size_bytes) FROM files WHERE deleted_at IS NULL), 0) AS bytes,
             (SELECT json_group_array(json_object('channel', channel, 'balance', balance, 'low_water', low_water)) FROM
               (SELECT channel, balance, low_water FROM message_credits WHERE channel IN ('sms','whatsapp') AND balance <= low_water ORDER BY channel)) AS credits,
             (SELECT count(*) FROM papers WHERE d IS NOT NULL AND d <> '' AND d < ?1) AS papers_expired,
             (SELECT count(*) FROM papers WHERE d IS NOT NULL AND d <> '' AND d >= ?1 AND d <= ?2) AS papers_soon,
             (SELECT count(*) FROM med WHERE v < ?1) AS med_expired,
             (SELECT count(*) FROM med WHERE v >= ?1 AND v <= ?2) AS med_soon`)
      .bind(today, addDays(today, PAPERS_DAYS)).first<Record<string, unknown>>()
      .then((r) => {
        const n = (k: string) => Number(r?.[k] ?? 0)
        let credits: Credit[] = []
        try { credits = JSON.parse(String(r?.credits ?? '[]')) } catch { /* none */ }
        return { students: n('students'), bytes: n('bytes'), credits,
          papers: [n('papers_expired'), n('papers_soon')], medical: [n('med_expired'), n('med_soon')] }
      })
    usageMemo.set(c, p)
  }
  return p
}

const NONE: ProbeResult = { count: 0 }
const ADMIN = 'institution.settings.write'
const gb = (bytes: number) => {
  const v = bytes / 1024 ** 3
  return v >= 10 ? v.toFixed(0) : v.toFixed(1)
}

/* A pair of "already lapsed" and "lapsing soon" counts in one line. */
function lapsing(expired: number, soon: number, what: [string, string], days: number): ProbeResult {
  const total = expired + soon
  if (!total) return NONE
  const headline = expired && soon ? `${plural(expired, what[0], what[1])} expired, ${soon} more due within ${days} days`
    : expired ? `${plural(expired, what[0], what[1])} expired`
    : `${plural(soon, what[0], what[1])} due for renewal within ${days} days`
  return { count: total, severity: expired ? 'critical' : 'warning', headline }
}

export const ACCOUNT_PROBES: Probe[] = [
  { key: 'plan.storage', needs: ADMIN, severity: 'warning', action: 'Free up space', href: 'class_status',
    headline: () => '',
    run: async (c, _sc, today) => {
      const [f, u] = await Promise.all([factsOf(c, today), usageOf(c, today)])
      if (!f?.storage_gb) return NONE
      const pct = Math.floor((100 * u.bytes) / (f.storage_gb * 1024 ** 3))
      if (pct < 80) return NONE
      const full = pct >= 100
      return { count: pct, severity: full ? 'critical' : 'warning',
        headline: full ? `Storage full: ${gb(u.bytes)} GB of ${f.storage_gb} GB used` : `Storage ${pct}% used: ${gb(u.bytes)} GB of ${f.storage_gb} GB`,
        detail: 'Delete old photos and videos, or ask your provider for more space.' }
    } },
  { key: 'plan.students', needs: ADMIN, severity: 'warning', action: '', href: '',
    headline: () => '',
    run: async (c, _sc, today) => {
      const [f, u] = await Promise.all([factsOf(c, today), usageOf(c, today)])
      if (!f?.licensed) return NONE
      const pct = Math.floor((100 * u.students) / f.licensed)
      if (pct < 80) return NONE
      const full = pct >= 100
      return { count: u.students, severity: full ? 'critical' : 'warning',
        headline: full ? `Student licence full: ${u.students} of ${f.licensed} on roll` : `${u.students} of ${f.licensed} licensed students on roll (${pct}%)`,
        detail: 'Ask your provider to raise the licence before admitting more.' }
    } },
  { key: 'messaging.credits', needs: 'institution.integrations.write', severity: 'warning', action: 'Buy credits', href: 'message_channels',
    headline: () => '',
    run: async (c, _sc, today) => {
      const results = (await usageOf(c, today)).credits
      if (!results.length) return NONE
      const name = (ch: string) => (ch === 'sms' ? 'SMS' : 'WhatsApp')
      const out = results.some((r) => r.balance <= 0)
      const parts = results.map((r) => r.balance <= 0 ? `${name(r.channel)} credits used up` : `${r.balance} ${name(r.channel)} credits left`)
      return { count: results.length, severity: out ? 'critical' : 'warning', headline: parts.join(', '),
        detail: out ? 'Messages on that channel will not send until credits are added.' : `Below the low mark of ${results[0].low_water}.` }
    } },
  ...(['trial', 'renewal', 'invoice'] as const).map((metric): Probe => ({
    key: `plan.${metric}`, needs: ADMIN, severity: 'warning', action: '', href: '',
    headline: () => '',
    run: async (c, _sc, today) => {
      const f = await factsOf(c, today)
      const a = f && subscriptionAlerts(f, today).find((x) => x.metric === metric)
      if (!a) return NONE
      return { count: 1, severity: a.level === 100 ? 'critical' : 'warning', headline: a.title, detail: a.detail, ...(a.amount ? { amount: a.amount } : {}) }
    },
  })),
  { key: 'plan.feature_trials', needs: ADMIN, severity: 'warning', action: '', href: '',
    headline: (n) => `${plural(n, 'feature trial', 'feature trials')} ${n === 1 ? 'ends' : 'end'} within ${FEATURE_TRIAL_DAYS} days`,
    run: async (c, _sc, today) => {
      const f = await factsOf(c, today)
      if (!f?.trials_n) return NONE
      return { count: f.trials_n, detail: f.trials_soonest ? `The first ends on ${day(f.trials_soonest)}.` : '' }
    } },
  { key: 'plan.backup', needs: ADMIN, severity: 'critical', action: '', href: '',
    headline: () => '',
    run: async (c, _sc, today) => {
      const f = await factsOf(c, today)
      // A school whose backups have never run (not set up yet) gets no alarm.
      if (!f?.backups_n) return NONE
      const since = f.last_good ? (Date.now() - Date.parse(f.last_good)) / 3_600_000 : Infinity
      const detail = f.last_good ? `Last good backup ${day(f.last_good)}. Your provider runs backups; tell them.` : 'No backup has succeeded yet. Your provider runs backups; tell them.'
      if (f.last_status === 'failed') return { count: 1, headline: 'Last backup failed', detail }
      if (since > BACKUP_STALE_HOURS) return { count: 1, headline: `No backup in the last ${BACKUP_STALE_HOURS / 24} days`, detail }
      return NONE
    } },
  { key: 'transport.papers', needs: 'operations.transport.read', severity: 'warning', action: 'Update papers', href: 'vehicles vehicles_routes transport_office',
    headline: () => '',
    run: async (c, _sc, today) => {
      const [expired, soon] = (await usageOf(c, today)).papers
      const res = lapsing(expired, soon, ['bus paper', 'bus papers'], PAPERS_DAYS)
      return res.count ? { ...res, detail: 'Insurance, fitness and PUC certificates.' } : res
    } },
  { key: 'hr.medical_fitness', needs: 'hr.employees.read', severity: 'warning', action: 'Open records', href: 'service_book_qualifications',
    headline: () => '',
    run: async (c, _sc, today) => {
      const [expired, soon] = (await usageOf(c, today)).medical
      return lapsing(expired, soon, ['staff medical certificate', 'staff medical certificates'], PAPERS_DAYS)
    } },
]
