import type { Env } from '../env'
import type { Ctx } from '../router'
import { Messenger, MessagingError, type MsgScope } from './messaging'
import { gate, loadPlans, matches, subjects as planSubjects, type Plan } from '../routes/admin/msg_plans'

/* Trigger rules and reminder plans: EmitMessageEvent, applyRule, audienceFor,
   sendAtFor, runTriggerRules and the knownEvents finders of
   internal/api/messaging.go, and runPlans / cancelSettled / RunMessagePlans of
   message_rules.go. The plan finders (fee chase numbering, one absence per
   child per day) are the ones routes/admin/msg_plans.ts already ported for
   the preview, so the preview and the run cannot disagree. */

const IST_MS = 330 * 60_000

export interface MessageSubject {
  student_id?: string | null
  employee_id?: string | null
  occurrence_key: string
  /** Epoch ms of the occurrence, or null. */
  at?: number | null
  facts: Record<string, unknown>
  vars: Record<string, unknown>
}

export interface TriggerRule {
  id: string; name: string; event: string; condition: Record<string, unknown>; audience: string
  channel: string; template_code: string; lead_minutes: number; quiet_from: string | null; quiet_to: string | null
}

interface RuleOutcome { queued: number; duplicates: number; blocked: string }

const trunc = (v: string, n: number) => { v = v.trim(); return v.length <= n ? v : v.slice(0, n) }
const dbCtx = (db: D1Database) => ({ db } as unknown as Ctx)

function parseClock(s: string): number | null {
  const p = s.trim().split(':')
  if (p.length < 2 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) return null
  const h = Number(p[0]), m = Number(p[1])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

function afterQuiet(at: number, from: string, to: string): number {
  const f = parseClock(from), t = parseClock(to)
  if (f === null || t === null || f === t) return at
  const w = new Date(at + IST_MS)
  const mins = w.getUTCHours() * 60 + w.getUTCMinutes()
  const inWindow = f < t ? mins >= f && mins < t : mins >= f || mins < t
  if (!inWindow) return at
  let out = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), Math.trunc(t / 60), t % 60) - IST_MS
  if (out <= at) out += 86_400_000
  return out
}

/** sendAtFor: ISO send_after, or null to send at the next dispatch. */
export function sendAtFor(rule: { lead_minutes: number; quiet_from: string | null; quiet_to: string | null }, subAt?: number | null): string | null {
  const now = Date.now()
  let at = now
  if (subAt && rule.lead_minutes > 0) at = subAt - rule.lead_minutes * 60_000
  if (at < now) at = now
  if (rule.quiet_from !== null && rule.quiet_to !== null) at = afterQuiet(at, rule.quiet_from, rule.quiet_to)
  if (at - now < 60_000) return null
  return new Date(at).toISOString()
}

interface Person { user_id: string | null; address: string; name: string }

const istToday = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10)

/** audienceFor. */
async function audienceFor(db: D1Database, rule: { audience: string; channel: string }, sub: MessageSubject): Promise<Person[]> {
  const wantEmail = rule.channel === 'email'
  const aud = rule.audience
  if (aud === 'guardians') {
    if (!sub.student_id) return []
    const today = istToday()
    const rows = await db.prepare(`SELECT g.user_id, g.email, g.phone, g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
       WHERE sg.student_id = ?1 AND NOT sg.portal_blocked AND (sg.access_until IS NULL OR sg.access_until >= ?2)
         AND (sg.is_primary OR NOT (SELECT i.alerts_primary_only FROM institutions i WHERE i.id = sg.institution_id)
              OR NOT EXISTS (SELECT 1 FROM student_guardians p WHERE p.student_id = sg.student_id AND p.is_primary AND NOT p.portal_blocked
                              AND (p.access_until IS NULL OR p.access_until >= ?2)))
       ORDER BY sg.is_primary DESC, g.full_name`).bind(sub.student_id, today)
      .all<{ user_id: string | null; email: string | null; phone: string | null; full_name: string }>()
    return rows.results.map((g) => ({ user_id: g.user_id, address: (wantEmail ? g.email : g.phone) ?? '', name: g.full_name }))
  }
  if (aud === 'family') {
    if (!sub.student_id) return []
    return [...await audienceFor(db, { ...rule, audience: 'guardians' }, sub), ...await audienceFor(db, { ...rule, audience: 'student' }, sub)]
  }
  if (aud === 'student') {
    if (!sub.student_id) return []
    const s = await db.prepare(`SELECT user_id, trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM students WHERE id = ?`)
      .bind(sub.student_id).first<{ user_id: string | null; name: string }>()
    return s ? [{ user_id: s.user_id, address: '', name: s.name }] : []
  }
  if (aud === 'staff') {
    if (!sub.employee_id) return []
    const e = await db.prepare(`SELECT user_id, email, phone, trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM employees WHERE id = ?`)
      .bind(sub.employee_id).first<{ user_id: string | null; email: string | null; phone: string | null; name: string }>()
    return e ? [{ user_id: e.user_id, address: (wantEmail ? e.email : e.phone) ?? '', name: e.name }] : []
  }
  if (aud.startsWith('role:')) {
    const rows = await db.prepare(`SELECT u.id, u.full_name FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE u.status = 'active' AND r.key = ?`).bind(aud.slice(5)).all<{ id: string; full_name: string }>()
    return rows.results.map((u) => ({ user_id: u.id, address: '', name: u.full_name }))
  }
  return []
}

/** applyRule: configuration problems are recorded, never thrown. */
async function applyRule(ms: Messenger, rule: TriggerRule, subs: MessageSubject[]): Promise<RuleOutcome> {
  const out: RuleOutcome = { queued: 0, duplicates: 0, blocked: '' }
  const p = (await ms.providers(rule.template_code))[rule.channel]
  if (!p) { out.blocked = 'unknown channel ' + rule.channel; return out }
  if (!p.configured) { out.blocked = 'cannot send: ' + p.why; return out }
  for (const sub of subs) {
    if (!matches(rule.condition, sub.facts)) continue
    const people = await audienceFor(ms.m.db, rule, sub)
    const when = sendAtFor(rule, sub.at)
    for (const person of people) {
      try {
        const res = await ms.queue({
          channel: rule.channel, template_code: rule.template_code,
          vars: { ...sub.vars, recipient_name: person.name, rule_name: rule.name },
          to_user_id: person.user_id, student_id: sub.student_id ?? null, recipient: person.address,
          source_kind: 'trigger_rule', source_id: rule.id, occurrence_key: sub.occurrence_key, send_after: when,
        })
        if (res.duplicate) out.duplicates++; else out.queued++
      } catch (e) {
        if (e instanceof MessagingError && e.code === 'no_recipient') continue
        if (e instanceof MessagingError && e.code === 'provider_not_configured') { out.blocked = trunc(e.message, 300); return out }
        throw e
      }
    }
  }
  return out
}

async function recordRuleRun(db: D1Database, rule: string, out: RuleOutcome): Promise<void> {
  await db.prepare(`UPDATE message_trigger_rules SET last_run_at = ?, last_queued = ?, last_error = NULLIF(?, '') WHERE id = ?`)
    .bind(new Date().toISOString(), out.queued, out.blocked, rule).run()
}

async function loadRules(db: D1Database, event: string, only: string | null): Promise<TriggerRule[]> {
  const rows = await db.prepare(`SELECT id, name, event, condition, audience, channel, template_code, lead_minutes, quiet_from, quiet_to
      FROM message_trigger_rules WHERE is_active = 1 AND plan_kind IS NULL AND (?1 IS NULL OR event = ?1) AND (?2 IS NULL OR id = ?2)
      ORDER BY name`).bind(event.trim() === '' ? null : event, only).all<Record<string, unknown>>()
  return rows.results.map((v) => {
    let cond: Record<string, unknown> = {}
    try { const c = JSON.parse(String(v.condition ?? '{}')); if (c && typeof c === 'object') cond = c } catch { /* as Go */ }
    return { id: String(v.id), name: String(v.name), event: String(v.event), condition: cond, audience: String(v.audience), channel: String(v.channel),
      template_code: String(v.template_code), lead_minutes: Number(v.lead_minutes ?? 0), quiet_from: (v.quiet_from as string | null) ?? null,
      quiet_to: (v.quiet_to as string | null) ?? null }
  })
}

/**
 * EmitMessageEvent: evaluate every active rule on an event against these
 * occurrences. Returns how many messages were queued; throws only on a
 * database fault. Kicks the dispatcher when anything was queued.
 */
export async function emitMessageEvent(m: MsgScope, event: string, subjects: MessageSubject[]): Promise<number> {
  const rules = await loadRules(m.db, event, null)
  if (rules.length === 0) return 0
  const ms = new Messenger(m)
  let total = 0
  for (const rule of rules) {
    const out = await applyRule(ms, rule, subjects)
    total += out.queued
    await recordRuleRun(m.db, rule.id, out)
  }
  await ms.kick()
  return total
}

// --- the pull half: knownEvents ---------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const goDate = (d: string) => `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000)
const istMidnight = (ymd: string, mins = 0) => Date.parse(ymd + 'T00:00:00Z') + mins * 60_000 - IST_MS
type Row = Record<string, unknown>

async function findAbsences(db: D1Database): Promise<MessageSubject[]> {
  const today = istToday()
  const rows = await db.prepare(`SELECT sa.id, sa.student_id, substr(sa.on_date,1,10) AS on_date,
      trim(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')) AS name,
      COALESCE((SELECT trim(c.name || ' ' || COALESCE(sec.name,'')) FROM enrollments en JOIN classes c ON c.id = en.class_id
                 LEFT JOIN sections sec ON sec.id = en.section_id WHERE en.student_id = sa.student_id AND en.status = 'active'
                ORDER BY en.enrolled_on DESC LIMIT 1), '') AS class_name
    FROM student_attendance sa JOIN students st ON st.id = sa.student_id
   WHERE sa.status = 'absent' AND sa.on_date > ? ORDER BY sa.on_date DESC LIMIT 2000`).bind(addDays(today, -14)).all<Row>()
  return rows.results.map((v) => {
    const on = String(v.on_date)
    return { student_id: String(v.student_id), occurrence_key: String(v.id), at: istMidnight(on),
      facts: { days_ago: daysBetween(on, today) }, vars: { student_name: v.name, on_date: goDate(on), class_name: v.class_name } }
  })
}

const NET = 'COALESCE(inv.net_paise, inv.gross_paise - inv.discount_paise + inv.fine_paise)'

async function findOverdueInvoices(db: D1Database): Promise<MessageSubject[]> {
  const today = istToday()
  const rows = await db.prepare(`SELECT inv.id, inv.student_id, inv.invoice_no, substr(inv.due_on,1,10) AS due_on, (${NET} - inv.paid_paise) AS due_paise,
      trim(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')) AS name
    FROM invoices inv JOIN students st ON st.id = inv.student_id
   WHERE inv.status <> 'cancelled' AND inv.due_on IS NOT NULL AND substr(inv.due_on,1,10) < ? AND ${NET} > inv.paid_paise
   ORDER BY inv.due_on LIMIT 2000`).bind(today).all<Row>()
  return rows.results.map((v) => {
    const due = String(v.due_on), paise = Number(v.due_paise)
    return { student_id: (v.student_id as string | null) ?? null, occurrence_key: String(v.id), at: Date.now(),
      facts: { days_overdue: daysBetween(due, today), amount_due_paise: paise },
      vars: { student_name: v.name, amount_rs: (paise / 100).toFixed(2), fee_name: 'school', invoice_no: v.invoice_no, due_on: goDate(due),
        amount_due: `₹${(paise / 100).toFixed(2)}` } }
  })
}

async function findUpcomingMeetings(db: D1Database): Promise<MessageSubject[]> {
  const today = istToday()
  const rows = await db.prepare(`SELECT a.id, a.student_id, a.with_employee_id, substr(a.on_date,1,10) AS on_date, a.starts_at,
      COALESCE(CASE WHEN st.id IS NULL THEN NULL ELSE trim(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')) END, a.visitor_name) AS name
    FROM appointments a LEFT JOIN students st ON st.id = a.student_id
   WHERE a.status = 'booked' AND substr(a.on_date,1,10) BETWEEN ? AND ? ORDER BY a.on_date, a.starts_at LIMIT 2000`)
    .bind(today, addDays(today, 14)).all<Row>()
  return rows.results.map((v) => {
    const on = String(v.on_date), starts = String(v.starts_at ?? '').slice(0, 5)
    const mins = parseClock(starts) ?? 0
    return { student_id: (v.student_id as string | null) ?? null, employee_id: (v.with_employee_id as string | null) ?? null,
      occurrence_key: String(v.id), at: istMidnight(on, mins), facts: { days_ahead: daysBetween(today, on) },
      vars: { student_name: v.name, on_date: goDate(on), starts_at: starts } }
  })
}

async function findAnnouncements(db: D1Database): Promise<MessageSubject[]> {
  const now = new Date().toISOString(), weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const rows = await db.prepare(`SELECT id, title, substr(body, 1, 500) AS body, publish_at FROM announcements
    WHERE audience_role IN ('all','parents') AND publish_at <= ? AND publish_at > ? ORDER BY publish_at DESC LIMIT 200`).bind(now, weekAgo).all<Row>()
  return rows.results.map((v) => {
    const at = Date.parse(String(v.publish_at))
    return { occurrence_key: String(v.id), at, facts: { days_ago: Math.floor((Date.now() - at) / 86_400_000) }, vars: { title: v.title, body: v.body } }
  })
}

export const KNOWN_EVENTS: Record<string, (db: D1Database) => Promise<MessageSubject[]>> = {
  'student.absent': findAbsences,
  'invoice.overdue': findOverdueInvoices,
  'ptm.upcoming': findUpcomingMeetings,
  'announcement.published': findAnnouncements,
}

export interface SweepResult { rule_id: string; rule: string; event: string; occurrences: number; queued: number; already_sent: number; error?: string }

/** runTriggerRules: every active rule (or one) against what is live now. */
export async function runTriggerRules(m: MsgScope, only: string | null): Promise<SweepResult[]> {
  const rules = await loadRules(m.db, '', only)
  const ms = new Messenger(m)
  const out: SweepResult[] = []
  for (const rule of rules) {
    const res: SweepResult = { rule_id: rule.id, rule: rule.name, event: rule.event, occurrences: 0, queued: 0, already_sent: 0 }
    const find = KNOWN_EVENTS[rule.event]
    if (!find) { res.error = 'no sweep for this event. It fires only when a feature reports it'; out.push(res); continue }
    let subs: MessageSubject[]
    try { subs = await find(m.db) } catch (e) { res.error = trunc((e as Error).message, 300); out.push(res); continue }
    res.occurrences = subs.length
    const o = await applyRule(ms, rule, subs)
    res.queued = o.queued; res.already_sent = o.duplicates
    if (o.blocked) res.error = o.blocked
    await recordRuleRun(m.db, rule.id, o)
    out.push(res)
  }
  await ms.kick()
  return out
}

// --- reminder plans ------------------------------------------------------------

export interface PlanRun { rule_id: string; name: string; kind: string; occurrences: number; queued: number; already_sent: number; withdrawn: number; skipped?: string; error?: string }

const UUIDISH = /^[0-9a-fA-F-]{36}$/

/** cancelSettled: withdraw queued plan messages whose reason stopped being true. */
async function cancelSettled(db: D1Database, p: Plan): Promise<number> {
  if (p.kind !== 'fee_reminder' && !(p.kind === 'absence_alert' && p.skip_explained)) return 0
  const pending = (await db.prepare(`SELECT id, occurrence_key FROM message_log WHERE source_kind = 'trigger_rule' AND source_id = ? AND status = 'queued'`)
    .bind(p.id).all<{ id: string; occurrence_key: string | null }>()).results
  const stmts: D1PreparedStatement[] = []
  for (const r of pending) {
    const k = r.occurrence_key ?? ''
    if (p.kind === 'fee_reminder') {
      const m = /^(.{36})#([0-9]+)$/.exec(k)
      if (!m || !UUIDISH.test(m[1])) continue
      stmts.push(db.prepare(`UPDATE message_log SET status = 'cancelled', send_after = NULL, error = ?
          WHERE id = ? AND status = 'queued' AND EXISTS (SELECT 1 FROM invoices inv WHERE inv.id = ?
            AND (inv.paid_paise >= ${NET} OR inv.status IN ('paid','cancelled')))`)
        .bind('withdrawn: the invoice was settled before this reminder went out', r.id, m[1]))
    } else {
      const m = /^(.{36}):([0-9]{4}-[0-9]{2}-[0-9]{2})$/.exec(k)
      if (!m || !UUIDISH.test(m[1])) continue
      stmts.push(db.prepare(`UPDATE message_log SET status = 'cancelled', send_after = NULL, error = ?
          WHERE id = ? AND status = 'queued' AND EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.subject_kind = 'student'
            AND lr.student_id = ? AND lr.status IN ('pending','approved') AND ? BETWEEN lr.from_date AND lr.to_date)`)
        .bind('withdrawn: the parent explained this absence before the alert went out', r.id, m[1], m[2]))
    }
  }
  let n = 0
  for (let i = 0; i < stmts.length; i += 50) for (const res of await db.batch(stmts.slice(i, i + 50))) n += res.meta.changes ?? 0
  return n
}

/** runPlans for one school; `force` ignores the send-at gate (Run now). */
export async function runPlans(m: MsgScope, only: string | null, force: boolean): Promise<PlanRun[]> {
  const c = dbCtx(m.db)
  const plans = await loadPlans(c, '', only)
  const ms = new Messenger(m)
  const out: PlanRun[] = []
  for (const p of plans) {
    const run: PlanRun = { rule_id: p.id, name: p.name, kind: p.kind, occurrences: 0, queued: 0, already_sent: 0, withdrawn: 0 }
    run.withdrawn = await cancelSettled(m.db, p)
    if (!p.active) { run.skipped = 'paused'; out.push(run); continue }
    const why = gate(p)
    if (why && !force) { run.skipped = why; out.push(run); continue }
    let subs: MessageSubject[]
    try {
      subs = (await planSubjects(c, p)).map((s) => ({ student_id: s.studentId, occurrence_key: s.key, at: Date.now(), facts: s.facts, vars: s.vars }))
    } catch (e) { run.error = trunc((e as Error).message, 300); out.push(run); continue }
    run.occurrences = subs.length
    const rule: TriggerRule = { id: p.id, name: p.name, event: p.event, condition: p.condition, audience: p.audience, channel: p.channel,
      template_code: p.template_code, lead_minutes: 0, quiet_from: p.quiet_from, quiet_to: p.quiet_to }
    const o = await applyRule(ms, rule, subs)
    run.queued = o.queued; run.already_sent = o.duplicates
    if (o.blocked) run.error = o.blocked
    await recordRuleRun(m.db, p.id, o)
    out.push(run)
  }
  await ms.kick()
  return out
}

/** RunMessagePlans: the cron's way in ('message:plans'). */
export async function runMessagePlans(env: Env, inst: string, db: D1Database): Promise<void> {
  await runPlans({ env, db, inst }, null, false)
}
