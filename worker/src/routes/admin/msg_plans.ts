import type { Router, Ctx } from '../../router'
import { badRequest, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { institutionId, notImplemented, parseJSON, requireAny } from './common'
import { CHANNELS, isoZ, knownChannel, loadProviders } from './providers'
import { loadGuard, permits } from './msg_guard'
import { scopeOf } from '../../services/messaging'
import { runPlans } from '../../services/message_rules'

/* Reminder plans, /admin/messaging/plans, from internal/api/message_rules.go.
   list, save, delete, the dry-run preview and "Run now" (services/message_rules.ts). */

const READ = 'institution.read'
const CONFIG = 'institution.settings.write'
const SEND = 'comms.messages.send'
const NIL = '00000000-0000-0000-0000-000000000000'
type Row = Record<string, unknown>

const CATALOGUE = [
  { kind: 'fee_reminder', label: 'Fee reminder', event: 'invoice.overdue', template_code: 'fees.overdue', audience: 'family',
    description: 'Chase an overdue invoice, and stop the moment it is settled.' },
  { kind: 'absence_alert', label: 'Absence alert', event: 'student.absent', template_code: 'attendance.absent', audience: 'guardians',
    description: 'Tell a guardian their child is marked absent today, once, after the register is taken.' },
]
const eventFor = (kind: string) => CATALOGUE.find((d) => d.kind === kind)?.event ?? ''

export interface Plan { id: string; name: string; event: string; condition: Record<string, unknown>; audience: string; channel: string; template_code: string
  quiet_from: string | null; quiet_to: string | null; kind: string; repeat_days: number; max_attempts: number; send_at_time: string | null; skip_explained: boolean; active: boolean }

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') { const f = parseFloat(v); return Number.isNaN(f) ? 0 : f }
  return 0
}
function parseClock(s: string): number | null {
  const p = s.trim().split(':')
  if (p.length < 2) return null
  const h = Number(p[0]), m = Number(p[1])
  if (!/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1]) || h > 23 || m > 59) return null
  return h * 60 + m
}
const firstAfter = (p: Plan) => (p.kind === 'absence_alert' ? 0 : 'min_days_overdue' in p.condition ? Math.trunc(toNum(p.condition.min_days_overdue)) : 0)
const clockOnly = (v: string | null) => (v === null ? '' : v.trim().length >= 5 ? v.trim().slice(0, 5) : v.trim())

/** India wall clock, for the send-after gate and CURRENT_DATE. */
function istNow(): Date { return new Date(Date.now() + 5.5 * 3_600_000) }
export function gate(p: Plan): string {
  if (!p.send_at_time || p.send_at_time.trim() === '') return ''
  const mins = parseClock(p.send_at_time)
  if (mins === null) return ''
  const n = istNow()
  if (n.getUTCHours() * 60 + n.getUTCMinutes() >= mins) return ''
  return `waiting until ${String(Math.trunc(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

export async function loadPlans(c: Ctx, kind: string, only: string | null): Promise<Plan[]> {
  const rows = await c.db.prepare(`SELECT id, name, event, condition, audience, channel, template_code, quiet_from, quiet_to, plan_kind, repeat_days,
      max_attempts, send_at_time, skip_explained, is_active FROM message_trigger_rules
     WHERE plan_kind IS NOT NULL AND (?1 IS NULL OR plan_kind = ?1) AND (?2 IS NULL OR id = ?2) ORDER BY name`).bind(kind || null, only).all<Row>()
  return rows.results.map((v) => ({ id: String(v.id), name: String(v.name), event: String(v.event), condition: parseJSON<Record<string, unknown>>(v.condition, {}),
    audience: String(v.audience), channel: String(v.channel), template_code: String(v.template_code), quiet_from: v.quiet_from as string | null,
    quiet_to: v.quiet_to as string | null, kind: String(v.plan_kind), repeat_days: Number(v.repeat_days), max_attempts: Number(v.max_attempts),
    send_at_time: v.send_at_time as string | null, skip_explained: !!v.skip_explained, active: !!v.is_active }))
}

// --- the finders ---------------------------------------------------------------

export interface Subject { studentId: string | null; key: string; facts: Record<string, unknown>; vars: Record<string, unknown> }

function chaseNumber(days: number, first: number, repeat: number, max: number): number | null {
  if (days < first) return null
  const attempt = repeat > 0 ? Math.trunc((days - first) / repeat) : 0
  if (attempt >= Math.max(1, max)) return null
  return attempt
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const goDate = (d: string) => `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000)

export async function subjects(c: Ctx, p: Plan): Promise<Subject[]> {
  const today = istNow().toISOString().slice(0, 10)
  if (p.kind === 'fee_reminder') {
    const until = new Date(Date.parse(today + 'T00:00:00Z') + 60 * 86_400_000).toISOString().slice(0, 10)
    const rows = await c.db.prepare(`SELECT inv.id, inv.student_id, inv.invoice_no, substr(inv.due_on,1,10) AS due_on,
        (COALESCE(inv.net_paise, inv.gross_paise - inv.discount_paise + inv.fine_paise) - inv.paid_paise) AS due_paise,
        (st.first_name || COALESCE(' ' || st.last_name, '')) AS name
      FROM invoices inv JOIN students st ON st.id = inv.student_id
     WHERE inv.status NOT IN ('cancelled','draft','paid') AND inv.due_on IS NOT NULL AND inv.due_on <= ?
       AND COALESCE(inv.net_paise, inv.gross_paise - inv.discount_paise + inv.fine_paise) > inv.paid_paise
     ORDER BY inv.due_on LIMIT 5000`).bind(until).all<Row>()
    const first = firstAfter(p)
    const out: Subject[] = []
    for (const v of rows.results) {
      const due = String(v.due_on), days = daysBetween(due, today), paise = Number(v.due_paise)
      const attempt = chaseNumber(days, first, p.repeat_days, p.max_attempts)
      if (attempt === null) continue
      out.push({ studentId: String(v.student_id), key: `${v.id}#${attempt}`,
        facts: { days_overdue: days, amount_due_paise: paise, chase_no: attempt + 1 },
        vars: { student_name: v.name, invoice_no: v.invoice_no, due_on: goDate(due), days_overdue: days, chase_no: attempt + 1,
          amount_due: `₹${(paise / 100).toFixed(2)}`, amount_rs: (paise / 100).toFixed(2), fee_name: 'school' } })
    }
    return out
  }
  if (p.kind === 'absence_alert') {
    const from = new Date(Date.parse(today + 'T00:00:00Z') - 2 * 86_400_000).toISOString().slice(0, 10)
    const rows = await c.db.prepare(`SELECT sa.student_id, substr(sa.on_date,1,10) AS on_date, count(*) AS periods,
        (st.first_name || COALESCE(' ' || st.last_name, '')) AS name,
        COALESCE((SELECT c.name || COALESCE(' ' || sec.name, '') FROM enrollments en JOIN classes c ON c.id = en.class_id
                   LEFT JOIN sections sec ON sec.id = en.section_id WHERE en.student_id = sa.student_id AND en.status = 'active'
                  ORDER BY en.enrolled_on DESC LIMIT 1), '') AS class_name,
        EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.subject_kind = 'student' AND lr.student_id = sa.student_id
                  AND lr.status IN ('pending','approved') AND substr(sa.on_date,1,10) BETWEEN lr.from_date AND lr.to_date) AS explained
      FROM student_attendance sa JOIN students st ON st.id = sa.student_id
     WHERE sa.status = 'absent' AND sa.on_date >= ?
     GROUP BY sa.student_id, substr(sa.on_date,1,10) ORDER BY sa.on_date DESC, st.first_name LIMIT 5000`).bind(from).all<Row>()
    const out: Subject[] = []
    for (const v of rows.results) {
      if (Number(v.explained) && p.skip_explained) continue
      const on = String(v.on_date)
      out.push({ studentId: String(v.student_id), key: `${v.student_id}:${on}`,
        facts: { days_ago: daysBetween(on, today), periods_absent: Number(v.periods) },
        vars: { student_name: v.name, on_date: goDate(on), periods_absent: Number(v.periods), class_name: v.class_name } })
    }
    return out
  }
  throw new Error(`unknown plan kind "${p.kind}"`)
}

export function matches(cond: Record<string, unknown>, facts: Record<string, unknown>): boolean {
  for (const [key, want] of Object.entries(cond)) {
    if (key.startsWith('min_')) { const k = key.slice(4); if (!(k in facts) || toNum(facts[k]) < toNum(want)) return false }
    else if (key.startsWith('max_')) { const k = key.slice(4); if (!(k in facts) || toNum(facts[k]) > toNum(want)) return false }
    else if (!(key in facts) || String(facts[key]) !== String(want)) return false
  }
  return true
}

interface Person { userId: string | null; address: string; name: string }

/** audienceFor, for the audiences a plan can carry (guardians, family). */
async function audience(c: Ctx, aud: string, channel: string, studentId: string | null): Promise<Person[]> {
  if (!studentId) return []
  const wantEmail = channel === 'email'
  const out: Person[] = []
  if (aud === 'guardians' || aud === 'family') {
    const today = istNow().toISOString().slice(0, 10)
    const rows = await c.db.prepare(`SELECT g.user_id, g.email, g.phone, g.full_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
       WHERE sg.student_id = ?1 AND NOT sg.portal_blocked AND (sg.access_until IS NULL OR sg.access_until >= ?2)
         AND (sg.is_primary OR NOT (SELECT i.alerts_primary_only FROM institutions i WHERE i.id = sg.institution_id)
              OR NOT EXISTS (SELECT 1 FROM student_guardians p WHERE p.student_id = sg.student_id AND p.is_primary AND NOT p.portal_blocked
                              AND (p.access_until IS NULL OR p.access_until >= ?2)))
       ORDER BY sg.is_primary DESC, g.full_name`).bind(studentId, today).all<{ user_id: string | null; email: string | null; phone: string | null; full_name: string }>()
    for (const g of rows.results) out.push({ userId: g.user_id, address: (wantEmail ? g.email : g.phone) ?? '', name: g.full_name })
  }
  if (aud === 'student' || aud === 'family') {
    const s = await c.db.prepare(`SELECT user_id, (first_name || COALESCE(' ' || last_name, '')) AS name FROM students WHERE id = ?`).bind(studentId)
      .first<{ user_id: string | null; name: string }>()
    if (s) out.push({ userId: s.user_id, address: '', name: s.name })
  }
  return out
}

async function addressFor(c: Ctx, user: string, channel: string): Promise<string> {
  const u = await c.db.prepare(`SELECT email, phone FROM users WHERE id = ?`).bind(user).first<{ email: string | null; phone: string | null }>()
  if (!u) return ''
  if (channel === 'email') return u.email ?? ''
  if (channel === 'sms' || channel === 'whatsapp') return u.phone ?? ''
  if (channel === 'in_app') return user
  return ''
}

function maskAddress(v: string): string {
  v = v.trim()
  if (v === '') return ''
  const at = v.lastIndexOf('@')
  if (at > 0) {
    const local = v.slice(0, at)
    return local.length <= 2 ? '••' + v.slice(at) : local[0] + '•'.repeat(local.length - 1) + v.slice(at)
  }
  if (v.length <= 4) return '•'.repeat(v.length)
  return '•'.repeat(v.length - 4) + v.slice(-4)
}
const RANK: Record<string, number> = { 'would send': 0, suppressed: 1, 'no address': 2, covered: 3 }

async function preview(c: Ctx, p: Plan) {
  const view = { rule_id: p.id, name: p.name, kind: p.kind, channel: p.channel, channel_ready: false, channel_reason: undefined as string | undefined,
    gate: undefined as string | undefined, occurrences: 0, matched: 0, students: 0, would_send: 0, already_sent: 0, suppressed: 0, no_address: 0,
    collapsed: 0, guard_mode: '', guard_note: undefined as string | undefined, sample: [] as Record<string, unknown>[], truncated: 0 }
  const set = await loadProviders(c)
  const prov = set[p.channel]
  if (prov) { view.channel_ready = prov.configured; view.channel_reason = prov.why || undefined } else view.channel_reason = 'unknown channel ' + p.channel
  const guard = await loadGuard(c)
  view.guard_mode = guard.mode
  if (guard.mode !== 'everyone') view.guard_note = 'This school is in allowlist mode: only recipients on the messaging allowlist are sent to, and everything else is logged as suppressed.'
  const g = gate(p)
  if (g) view.gate = g
  const subs = await subjects(c, p)
  view.occurrences = subs.length
  const sentRows = await c.db.prepare(`SELECT occurrence_key, COALESCE(user_id, '${NIL}') AS u, COALESCE(student_id, '${NIL}') AS s FROM message_log
      WHERE source_kind = 'trigger_rule' AND source_id = ? AND channel = ? AND status <> 'cancelled'`).bind(p.id, p.channel).all<{ occurrence_key: string; u: string; s: string }>()
  const sent = new Set(sentRows.results.map((x) => `${x.occurrence_key}|${x.u}|${x.s}`))
  const students = new Set<string>(), seen = new Set<string>()
  for (const sub of subs) {
    if (!matches(p.condition, sub.facts)) continue
    view.matched++
    if (sub.studentId) students.add(sub.studentId)
    for (const person of await audience(c, p.audience, p.channel, sub.studentId)) {
      let detail = ''
      if (p.kind === 'fee_reminder') detail = `${sub.vars.amount_due} overdue since ${sub.vars.due_on} (chase ${sub.vars.chase_no})`
      else if (p.kind === 'absence_alert') detail = `absent ${sub.vars.on_date}`
      const row: Record<string, unknown> = { name: person.name, student: String(sub.vars.student_name) || undefined, address: maskAddress(person.address), detail: detail || undefined }
      let address = person.address
      if (address === '' && person.userId) { address = await addressFor(c, person.userId, p.channel); row.address = maskAddress(address) }
      const key = `${sub.key}|${person.userId ?? NIL}|${sub.studentId ?? NIL}`
      if (sent.has(key)) { view.already_sent++; row.outcome = 'already sent'; row.reason = 'this plan has already covered this occurrence for this person' }
      else if (seen.has(key)) {
        view.collapsed++; row.outcome = 'covered'
        row.reason = 'shares a message with another guardian of the same child. Neither has a portal login, so the send is keyed on the child'
      } else if (address.trim() === '') {
        view.no_address++; row.outcome = 'no address'; row.reason = 'no ' + (p.channel === 'email' ? 'email address' : 'mobile number') + ' on file for this guardian'
      } else {
        seen.add(key)
        const [okay, why] = permits(guard, p.channel, address)
        if (!okay) { view.suppressed++; row.outcome = 'suppressed'; row.reason = why } else { view.would_send++; row.outcome = 'would send' }
      }
      if (view.sample.length < 40) view.sample.push(row); else view.truncated++
    }
  }
  view.students = students.size
  view.sample.sort((a, b) => (RANK[String(a.outcome)] ?? 4) - (RANK[String(b.outcome)] ?? 4))
  return view
}

export function registerMessagePlans(r: Router): void {
  r.get('/admin/messaging/plans', READ, async (c) => {
    const kind = (c.url.searchParams.get('kind') ?? '').trim()
    if (kind !== '' && eventFor(kind) === '') throw badRequest('unknown plan kind')
    const set = await loadProviders(c)
    const guard = await loadGuard(c)
    const plans = await loadPlans(c, kind, null)
    const items = []
    for (const p of plans) {
      const [meta, counts] = await c.db.batch<Row>([
        c.db.prepare(`SELECT ${isoZ('last_run_at')} AS last_run_at, last_queued, last_error FROM message_trigger_rules WHERE id = ?`).bind(p.id),
        c.db.prepare(`SELECT sum(CASE WHEN status IN ('sent','delivered','read') THEN 1 ELSE 0 END) AS sent, sum(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS waiting,
            sum(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS withdrawn FROM message_log WHERE source_kind = 'trigger_rule' AND source_id = ?`).bind(p.id),
      ])
      const m = meta.results[0] ?? {}, k = counts.results[0] ?? {}
      const prov = set[p.channel]
      const g = gate(p)
      items.push({ id: p.id, kind: p.kind, name: p.name, channel: p.channel, template_code: p.template_code, audience: p.audience, is_active: p.active,
        first_after_days: firstAfter(p), min_amount_paise: 'min_amount_due_paise' in p.condition ? Math.trunc(toNum(p.condition.min_amount_due_paise)) : 0,
        repeat_days: p.repeat_days, max_attempts: p.max_attempts, send_at_time: clockOnly(p.send_at_time), skip_explained: p.skip_explained,
        quiet_from: p.quiet_from ?? '', quiet_to: p.quiet_to ?? '',
        channel_ready: prov ? prov.configured : false, channel_reason: prov ? (prov.why || undefined) : 'unknown channel ' + p.channel,
        last_run_at: m.last_run_at ?? undefined, last_queued: Number(m.last_queued ?? 0), last_error: m.last_error ?? undefined, gate: g || undefined,
        withdrawn: Number(k.withdrawn ?? 0), sent_total: Number(k.sent ?? 0), waiting: Number(k.waiting ?? 0) })
    }
    const codes = (await c.db.prepare(`SELECT DISTINCT code FROM message_templates WHERE is_active = 1 ORDER BY code`).all<{ code: string }>()).results.map((x) => x.code)
    for (const d of CATALOGUE) if (!codes.includes(d.template_code)) codes.push(d.template_code)
    codes.sort()
    return ok({ items, kinds: CATALOGUE, channels: CHANNELS, templates: codes, guard_mode: guard.mode })
  })

  r.post('/admin/messaging/plans', CONFIG, async (c) => {
    const inst = institutionId(c)
    const req = await readJSON<{ id?: string; kind?: string; name?: string; channel?: string; template_code?: string; is_active?: boolean; first_after_days?: number;
      min_amount_paise?: number; repeat_days?: number; max_attempts?: number; send_at_time?: string; skip_explained?: boolean; quiet_from?: string; quiet_to?: string }>(c.req)
    const kind = req.kind ?? ''
    const event = eventFor(kind)
    if (event === '') throw badRequest('unknown plan kind')
    const name = (req.name ?? '').trim()
    if (name === '') throw badRequest('give the plan a name. It is what appears beside every message it sends')
    if (!knownChannel(req.channel)) throw badRequest('unknown channel')
    const tpl = (req.template_code ?? '').trim()
    if (tpl === '') throw badRequest('name a template')
    let max = req.max_attempts ?? 0, repeat = req.repeat_days ?? 0
    const first = req.first_after_days ?? 0, minAmt = req.min_amount_paise ?? 0
    let sendAt = req.send_at_time ?? ''
    const qf = req.quiet_from ?? '', qt = req.quiet_to ?? ''
    if (max < 1) max = 1
    if (max > 12) throw badRequest('twelve chases is the most this will send. Beyond that it is not a reminder')
    if (repeat < 0 || repeat > 365) throw badRequest('repeat must be between 0 and 365 days')
    if (repeat > 0 && max < 2) throw badRequest('a repeat with one attempt only ever sends once. Either raise the cap or set the repeat to 0')
    if (first < 0 || first > 365) throw badRequest('the first reminder must be between 0 and 365 days')
    if (minAmt < 0) throw badRequest('the minimum amount cannot be negative')
    if ((qf === '') !== (qt === '')) throw badRequest('set both ends of the quiet window, or neither')
    if (sendAt !== '' && parseClock(sendAt) === null) throw badRequest('send-after time must be HH:MM')
    const condition: Record<string, number> = {}
    if (kind === 'fee_reminder') {
      if (first > 0) condition.min_days_overdue = first
      if (minAmt > 0) condition.min_amount_due_paise = minAmt
      sendAt = ''
    } else { condition.max_days_ago = 0; repeat = 0; max = 1 }
    const cond = JSON.stringify(condition), t = now()
    const nz = (s: string) => (s === '' ? null : s)
    if (!req.id) {
      const id = uuid()
      await c.db.prepare(`INSERT INTO message_trigger_rules (id, institution_id, name, event, condition, audience, channel, template_code, lead_minutes, quiet_from, quiet_to,
          is_active, last_queued, plan_kind, repeat_days, max_attempts, send_at_time, skip_explained, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'guardians', ?, ?, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, inst, name, event, cond, req.channel, tpl, nz(qf), nz(qt), req.is_active ? 1 : 0, kind, repeat, max, nz(sendAt), req.skip_explained ? 1 : 0, t, t).run()
        .catch((e: Error) => { throw badRequest(e.message) })
      return ok({ id })
    }
    if (!isUUID(req.id)) throw notFound()
    const res = await c.db.prepare(`UPDATE message_trigger_rules SET name = ?, condition = ?, channel = ?, template_code = ?, quiet_from = ?, quiet_to = ?, is_active = ?,
        repeat_days = ?, max_attempts = ?, send_at_time = ?, skip_explained = ?, updated_at = ? WHERE id = ? AND plan_kind = ?`)
      .bind(name, cond, req.channel, tpl, nz(qf), nz(qt), req.is_active ? 1 : 0, repeat, max, nz(sendAt), req.skip_explained ? 1 : 0, t, req.id, kind).run()
      .catch((e: Error) => { throw badRequest(e.message) })
    if ((res.meta.changes ?? 0) === 0) throw notFound()
    return ok({ id: req.id })
  })

  r.del('/admin/messaging/plans/{id}', CONFIG, async (c) => {
    const id = c.params.id
    if (!isUUID(id)) throw notFound()
    const exists = await c.db.prepare(`SELECT 1 AS x FROM message_trigger_rules WHERE id = ? AND plan_kind IS NOT NULL`).bind(id).first()
    if (!exists) throw notFound()
    const [w] = await c.db.batch([
      c.db.prepare(`UPDATE message_log SET status = 'cancelled', send_after = NULL, error = 'withdrawn: the reminder plan behind it was deleted'
          WHERE source_kind = 'trigger_rule' AND source_id = ? AND status = 'queued'`).bind(id),
      c.db.prepare(`DELETE FROM message_trigger_rules WHERE id = ? AND plan_kind IS NOT NULL`).bind(id),
    ])
    return ok({ deleted: true, withdrawn: w.meta.changes ?? 0 })
  })

  r.post('/admin/messaging/plans/{id}/preview', 'auth', async (c) => {
    requireAny(c, CONFIG, SEND)
    const id = c.params.id
    if (!isUUID(id)) throw notFound()
    const plans = await loadPlans(c, '', id)
    if (plans.length === 0) throw notFound()
    return ok(await preview(c, plans[0]))
  })

  r.post('/admin/messaging/plans/{id}/run', SEND, async (c) => {
    const id = c.params.id
    if (!isUUID(id)) throw notFound()
    const plans = await loadPlans(c, '', id)
    if (plans.length === 0) throw notFound()
    return ok({ runs: await runPlans(scopeOf(c), id, true) })
  })

}
