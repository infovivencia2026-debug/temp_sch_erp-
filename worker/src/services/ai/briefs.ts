import type { Env } from '../../env'
import { HttpError } from '../../http'
import { addDays, fullNameSQL, isodow } from '../../routes/students/common'
import { registerJob, type Job } from '../jobs'
import { jobSchool } from '../background/schools'
import { Messenger } from '../messaging'
import { AI_MODEL, aiConfigured, aiGenerate, aiSettings, inputsHash, parseJsonObject, schoolToday } from './llm'
import { safe, snapshotText, studentSnapshot } from './context'

/* Generated briefs, stored in the school's ai_briefs with the hash of their
   inputs: the principal's morning brief (07:00 school time by cron, or on
   demand), the Student 360 paragraph (on demand, cached until the student's
   data changes) and the weekly parent note per child (Saturday morning,
   in-app notification; SMS / email only when the school turns them on in
   module_settings 'ai'). Everything is labelled as AI output on screen,
   editable, and never sent anywhere except the in-app notice and, when the
   school enabled it, the brief e-mail queued through messaging. */

export type BriefKind = 'principal_morning' | 'student_360' | 'parent_weekly'
export interface Brief {
  id: string; kind: BriefKind; subject_id: string; period_key: string; body: string
  facts: Record<string, unknown>; model: string; ai: boolean; label: string
  inputs_hash: string; generated_by: string | null; created_at: string; updated_at: string
}
interface BriefRow { id: string; kind: BriefKind; subject_id: string; period_key: string; body: string; facts: string; model: string; inputs_hash: string; generated_by: string | null; created_at: string; updated_at: string }

const LABEL: Record<BriefKind, string> = { principal_morning: 'AI summary', student_360: 'AI summary', parent_weekly: 'AI summary' }
function toBrief(r: BriefRow): Brief {
  let facts: Record<string, unknown> = {}
  try { facts = JSON.parse(r.facts || '{}') } catch { /* keep {} */ }
  return { ...r, facts, ai: r.model !== 'none', label: r.model === 'none' ? 'Summary (AI off)' : LABEL[r.kind] }
}

export async function storedBrief(db: D1Database, kind: BriefKind, subject: string, period: string): Promise<Brief | null> {
  const r = await db.prepare(`SELECT * FROM ai_briefs WHERE kind = ? AND subject_id = ? AND period_key = ?`).bind(kind, subject, period).first<BriefRow>()
  return r ? toBrief(r) : null
}
export async function latestBrief(db: D1Database, kind: BriefKind, subject: string): Promise<Brief | null> {
  const r = await db.prepare(`SELECT * FROM ai_briefs WHERE kind = ? AND subject_id = ? ORDER BY period_key DESC, updated_at DESC LIMIT 1`).bind(kind, subject).first<BriefRow>()
  return r ? toBrief(r) : null
}

async function saveBrief(db: D1Database, inst: string, b: { kind: BriefKind; subject_id: string; period_key: string; body: string; facts: unknown; model: string; hash: string; by: string | null }): Promise<Brief> {
  const at = new Date().toISOString()
  await db.prepare(`INSERT INTO ai_briefs (id, institution_id, kind, subject_id, period_key, inputs_hash, body, facts, model, generated_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (kind, subject_id, period_key) DO UPDATE SET inputs_hash = excluded.inputs_hash, body = excluded.body, facts = excluded.facts,
        model = excluded.model, generated_by = excluded.generated_by, updated_at = excluded.updated_at`)
    .bind(crypto.randomUUID(), inst, b.kind, b.subject_id, b.period_key, b.hash, b.body, JSON.stringify(b.facts ?? {}), b.model, b.by, at, at).run()
  return (await storedBrief(db, b.kind, b.subject_id, b.period_key))!
}

/** Reuse a stored brief when its inputs are unchanged (and it was written by the model, or the model is still off). */
async function reusable(prev: Brief | null, hash: string, env: Env): Promise<boolean> {
  return !!prev && prev.inputs_hash === hash && (prev.ai || !(await aiConfigured(env)))
}

// --- principal morning brief -------------------------------------------------------------------

const ADMIN = '/institution_admin'
export interface PrincipalFacts {
  date: string
  attendance: { marked: number; present: number; absent: number; percent: number | null; usual_percent: number | null; sections_unmarked: number }
  staff_absent: { names: string[]; count: number }
  uncovered_periods: { count: number; sample: string[] }
  fees: { collected_today_paise: number; collected_month_paise: number; overdue_paise: number; overdue_invoices: number }
  approvals: { leave: number; report_cards: number; attendance_corrections: number; concessions: number }
  admissions: { new_applications_7d: number; offered_7d: number; accepted_7d: number; rejected_7d: number; open_enquiries: number }
  incidents: { discipline: string[]; transport: number; infirmary_today: number }
  events: { on: string; name: string }[]
}

const one = async (db: D1Database, sql: string, ...a: unknown[]) => Number(Object.values((await db.prepare(sql).bind(...a).first<Record<string, number>>()) ?? { n: 0 })[0] ?? 0)

export async function principalFacts(db: D1Database, today: string): Promise<PrincipalFacts> {
  const week = addDays(today, -7), month = today.slice(0, 8) + '01'
  const att = await safe('att today', () => db.prepare(`SELECT COUNT(DISTINCT student_id) AS marked,
      COUNT(DISTINCT CASE WHEN status IN ('present','late','half_day') THEN student_id END) AS present,
      COUNT(DISTINCT CASE WHEN status = 'absent' THEN student_id END) AS absent
      FROM student_attendance WHERE on_date = ? AND period_id IS NULL`).bind(today).first<{ marked: number; present: number; absent: number }>(), null)
  const usual = await safe('att usual', () => db.prepare(`SELECT AVG(p) AS p FROM (
      SELECT on_date, 100.0 * SUM(CASE WHEN status IN ('present','late','half_day') THEN 1 ELSE 0 END) / COUNT(*) AS p
        FROM student_attendance WHERE on_date < ? AND on_date >= ? AND period_id IS NULL GROUP BY on_date ORDER BY on_date DESC LIMIT 20)`)
    .bind(today, addDays(today, -45)).first<{ p: number | null }>(), null)
  const unmarked = await safe('unmarked', () => one(db, `SELECT COUNT(*) FROM sections s JOIN academic_years ay ON ay.id = s.academic_year_id AND ay.is_current = 1
      WHERE NOT EXISTS (SELECT 1 FROM student_attendance sa WHERE sa.section_id = s.id AND sa.on_date = ?)`, today), 0)
  const staff = await safe('staff absent', async () => (await db.prepare(`
      SELECT DISTINCT u.id, u.full_name FROM users u WHERE u.id IN (
        SELECT user_id FROM staff_attendance WHERE on_date = ?1 AND status IN ('absent','leave','on_leave')
        UNION SELECT e.user_id FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
         WHERE lr.status = 'approved' AND lr.from_date <= ?1 AND lr.to_date >= ?1 AND e.user_id IS NOT NULL)
      ORDER BY u.full_name`).bind(today).all<{ id: string; full_name: string }>()).results, [])
  const uncovered = await safe('uncovered', async () => staff.length === 0 ? [] : (await db.prepare(`
      SELECT p.name AS period, c.name || ' ' || s.name AS section, u.full_name AS teacher
        FROM timetable_entries te JOIN periods p ON p.id = te.period_id JOIN sections s ON s.id = te.section_id
        JOIN classes c ON c.id = s.class_id JOIN academic_years ay ON ay.id = te.academic_year_id AND ay.is_current = 1
        LEFT JOIN users u ON u.id = te.teacher_user_id
       WHERE te.weekday = ? AND te.teacher_user_id IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM substitutions sb WHERE sb.timetable_entry_id = te.id AND sb.on_date = ?)
       ORDER BY p.name LIMIT 60`).bind(isodow(today), JSON.stringify(staff.map((x) => x.id)), today)
    .all<{ period: string; section: string; teacher: string }>()).results, [])
  const [collectedToday, collectedMonth, overdue, overdueN, leave, rcs, corr, conc, apps, offered, accepted, rejected, enq, transport, infirmary] = await Promise.all([
    safe('paid today', () => one(db, `SELECT COALESCE(SUM(amount_paise),0) FROM payments WHERE paid_on = ? AND status = 'success'`, today), 0),
    safe('paid month', () => one(db, `SELECT COALESCE(SUM(amount_paise),0) FROM payments WHERE paid_on >= ? AND paid_on <= ? AND status = 'success'`, month, today), 0),
    safe('overdue', () => one(db, `SELECT COALESCE(SUM(COALESCE(net_paise, gross_paise - discount_paise + fine_paise) - paid_paise),0) FROM invoices
        WHERE due_on < ? AND status NOT IN ('paid','cancelled')`, today), 0),
    safe('overdue n', () => one(db, `SELECT COUNT(*) FROM invoices WHERE due_on < ? AND status NOT IN ('paid','cancelled')`, today), 0),
    safe('leave', () => one(db, `SELECT COUNT(*) FROM leave_requests WHERE status = 'pending'`), 0),
    safe('rc', () => one(db, `SELECT COUNT(*) FROM report_cards WHERE status = 'submitted'`), 0),
    safe('corr', () => one(db, `SELECT COUNT(*) FROM attendance_corrections WHERE status = 'pending'`), 0),
    safe('conc', () => one(db, `SELECT COUNT(*) FROM fee_concessions WHERE status = 'pending'`), 0),
    safe('apps', () => one(db, `SELECT COUNT(*) FROM applications WHERE created_at >= ?`, week), 0),
    safe('offered', () => one(db, `SELECT COUNT(*) FROM applications WHERE status = 'offered' AND decided_at >= ?`, week), 0),
    safe('accepted', () => one(db, `SELECT COUNT(*) FROM applications WHERE status = 'accepted' AND updated_at >= ?`, week), 0),
    safe('rejected', () => one(db, `SELECT COUNT(*) FROM applications WHERE status = 'rejected' AND decided_at >= ?`, week), 0),
    safe('enquiries', () => one(db, `SELECT COUNT(*) FROM enquiries WHERE status IN ('new','open','follow_up')`), 0),
    safe('transport', () => one(db, `SELECT COUNT(*) FROM transport_incidents WHERE created_at >= ?`, addDays(today, -1)), 0),
    safe('infirmary', () => one(db, `SELECT COUNT(*) FROM infirmary_visits WHERE substr(created_at,1,10) = ?`, today), 0),
  ])
  const discipline = await safe('discipline', async () => (await db.prepare(`SELECT d.category, d.severity, ${fullNameSQL('st')} AS name FROM discipline_records d
      JOIN students st ON st.id = d.student_id WHERE d.is_positive = 0 AND d.occurred_on >= ? ORDER BY d.occurred_on DESC LIMIT 5`)
    .bind(addDays(today, -1)).all<{ category: string; severity: string; name: string }>()).results.map((d) => `${d.category} (${d.severity}), ${d.name}`), [])
  const events = await safe('events', async () => (await db.prepare(`SELECT on_date AS "on", name FROM school_events WHERE on_date >= ? AND on_date <= ?
      ORDER BY on_date LIMIT 6`).bind(today, addDays(today, 7)).all<{ on: string; name: string }>()).results, [])
  const a = att ?? { marked: 0, present: 0, absent: 0 }
  return {
    date: today,
    attendance: { marked: Number(a.marked), present: Number(a.present), absent: Number(a.absent),
      percent: Number(a.marked) ? Math.round(1000 * Number(a.present) / Number(a.marked)) / 10 : null,
      usual_percent: usual?.p == null ? null : Math.round(Number(usual.p) * 10) / 10, sections_unmarked: unmarked },
    staff_absent: { names: staff.slice(0, 8).map((s) => s.full_name), count: staff.length },
    uncovered_periods: { count: uncovered.length, sample: uncovered.slice(0, 5).map((u) => `${u.period} ${u.section} (${u.teacher})`) },
    fees: { collected_today_paise: collectedToday, collected_month_paise: collectedMonth, overdue_paise: overdue, overdue_invoices: overdueN },
    approvals: { leave, report_cards: rcs, attendance_corrections: corr, concessions: conc },
    admissions: { new_applications_7d: apps, offered_7d: offered, accepted_7d: accepted, rejected_7d: rejected, open_enquiries: enq },
    incidents: { discipline, transport, infirmary_today: infirmary },
    events,
  }
}

const rs = (p: number) => 'Rs ' + Math.round(p / 100).toLocaleString('en-IN')
export interface Bullet { text: string; link?: string; topic: string }

/** The same brief without a model: one plain bullet per topic that has something to say. */
export function plainBullets(f: PrincipalFacts): Bullet[] {
  const out: Bullet[] = []
  const a = f.attendance
  if (a.marked > 0) out.push({ topic: 'attendance', link: `${ADMIN}/academics/student_absentees`,
    text: `Attendance ${a.percent}% today (${a.absent} absent)${a.usual_percent !== null ? `, usual ${a.usual_percent}%` : ''}${a.sections_unmarked ? `; ${a.sections_unmarked} section(s) not marked yet` : ''}.` })
  else out.push({ topic: 'attendance', link: `${ADMIN}/academics/student_absentees`, text: `No attendance marked yet today${a.sections_unmarked ? ` (${a.sections_unmarked} sections)` : ''}.` })
  if (f.staff_absent.count) out.push({ topic: 'staff', link: `${ADMIN}/academics/substitutions`,
    text: `${f.staff_absent.count} staff away (${f.staff_absent.names.join(', ')})${f.uncovered_periods.count ? `; ${f.uncovered_periods.count} period(s) without a substitute` : ''}.` })
  out.push({ topic: 'fees', link: `${ADMIN}/fees/fee_default`,
    text: `Fees: ${rs(f.fees.collected_today_paise)} collected today, ${rs(f.fees.collected_month_paise)} this month; ${rs(f.fees.overdue_paise)} overdue on ${f.fees.overdue_invoices} invoice(s).` })
  const ap = f.approvals, apN = ap.leave + ap.report_cards + ap.attendance_corrections + ap.concessions
  if (apN) out.push({ topic: 'approvals', link: `${ADMIN}/approvals/approvals`,
    text: `${apN} waiting on approval: ${[ap.leave && `${ap.leave} leave`, ap.report_cards && `${ap.report_cards} report cards`, ap.attendance_corrections && `${ap.attendance_corrections} attendance corrections`, ap.concessions && `${ap.concessions} concessions`].filter(Boolean).join(', ')}.` })
  const ad = f.admissions
  if (ad.new_applications_7d + ad.offered_7d + ad.accepted_7d + ad.rejected_7d + ad.open_enquiries) out.push({ topic: 'admissions', link: `${ADMIN}/admissions/admissions_pipeline`,
    text: `Admissions this week: ${ad.new_applications_7d} new application(s), ${ad.offered_7d} offered, ${ad.accepted_7d} accepted, ${ad.rejected_7d} declined; ${ad.open_enquiries} open enquiries.` })
  const inc = f.incidents
  if (inc.discipline.length || inc.transport || inc.infirmary_today) out.push({ topic: 'incidents',
    text: `Incidents: ${[inc.discipline.length && `${inc.discipline.length} conduct (${inc.discipline.join('; ')})`, inc.transport && `${inc.transport} transport`, inc.infirmary_today && `${inc.infirmary_today} infirmary visit(s) today`].filter(Boolean).join(', ')}.` })
  if (f.events.length) out.push({ topic: 'events', link: `${ADMIN}/academics/school_calendar`, text: `Coming up: ${f.events.map((e) => `${e.name} (${e.on})`).join(', ')}.` })
  return out
}

const TOPIC_LINKS = (f: PrincipalFacts) => Object.fromEntries(plainBullets(f).filter((b) => b.link).map((b) => [b.topic, b.link!]))

export async function generatePrincipalBrief(env: Env, db: D1Database, inst: { id: string; timezone?: string }, o: { by?: string | null; force?: boolean } = {}): Promise<Brief> {
  const today = schoolToday(inst.timezone || 'Asia/Kolkata')
  const facts = await principalFacts(db, today)
  const hash = await inputsHash(facts)
  const prev = await storedBrief(db, 'principal_morning', '', today)
  if (!o.force && prev && (await reusable(prev, hash, env))) return prev
  const links = TOPIC_LINKS(facts)
  let bullets: Bullet[] = plainBullets(facts), model = 'none'
  if ((await aiConfigured(env)) && (await aiSettings(db)).enabled) {
    const system = 'You write the principal\'s morning brief for an Indian school. From the JSON facts, write 5 to 8 short bullets, most important first: ' +
      'call out anything unusual (attendance below the usual, uncovered periods, overdue fees, approvals piling up, incidents). Plain words, figures from the facts only, no invention. ' +
      `Each bullet has a topic from: ${Object.keys(links).concat('incidents').join(', ')}. Return JSON only: {"bullets":[{"topic":"...","text":"..."}]}.`
    try {
      const raw = await aiGenerate(env, db, system, JSON.stringify(facts), { maxTokens: 1200, today })
      const parsed = parseJsonObject<{ bullets?: { topic?: string; text?: string }[] }>(raw)
      const got = (parsed?.bullets ?? []).filter((b) => typeof b.text === 'string' && b.text.trim()).slice(0, 8)
        .map((b) => ({ topic: String(b.topic ?? ''), text: b.text!.trim(), link: links[String(b.topic ?? '')] }))
      if (got.length) { bullets = got; model = AI_MODEL }
    } catch (e) {
      console.error('principal brief: model failed, keeping the plain brief', e)
      if (prev && prev.inputs_hash === hash) return prev
    }
  }
  return saveBrief(db, inst.id, { kind: 'principal_morning', subject_id: '', period_key: today, body: bullets.map((b) => '• ' + b.text).join('\n'),
    facts: { bullets, facts }, model, hash, by: o.by ?? null })
}

// --- Student 360 ------------------------------------------------------------------------------

export async function student360Inputs(db: D1Database, sid: string) {
  const since = addDays(schoolToday(), -120)
  const snap = await studentSnapshot(db, sid, since.slice(0, 7) + '-01')
  if (!snap) return null
  return { snap, hash: await inputsHash({ snapshotText: snapshotText(snap, { fees: true }) }) }
}

export async function generateStudent360(env: Env, db: D1Database, inst: string, sid: string, by: string | null): Promise<{ brief: Brief; cached: boolean }> {
  const inp = await student360Inputs(db, sid)
  if (!inp) throw new HttpError(404, 'no such student')
  const prev = await storedBrief(db, 'student_360', sid, '')
  if (prev && prev.inputs_hash === inp.hash && prev.ai) return { brief: prev, cached: true }
  const system = 'You write a one-paragraph "Student 360" summary for school staff: academics (trend, strongest and weakest subjects), attendance, homework, conduct and anything that needs attention, in 70-110 words. ' +
    'Facts only from the input; if something is not recorded, say nothing about it. Plain text, no markdown.'
  const body = await aiGenerate(env, db, system, snapshotText(inp.snap, { fees: true }), { maxTokens: 600 })
  const brief = await saveBrief(db, inst, { kind: 'student_360', subject_id: sid, period_key: '', body, facts: { attendance: inp.snap.attendance }, model: AI_MODEL, hash: inp.hash, by })
  return { brief, cached: false }
}

// --- weekly parent note -------------------------------------------------------------------------

/** ISO week key, "2026-W39", for a yyyy-mm-dd date. */
export function isoWeek(date: string): string {
  const d = new Date(date + 'T00:00:00Z')
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const y = d.getUTCFullYear()
  const wk = Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7)
  return `${y}-W${String(wk).padStart(2, '0')}`
}

export async function generateParentWeekly(env: Env, db: D1Database, inst: string, sid: string, today: string): Promise<{ brief: Brief | null; fresh: boolean }> {
  const week = isoWeek(today)
  const snap = await studentSnapshot(db, sid, addDays(today, -7), { family: true })
  if (!snap) return { brief: null, fresh: false }
  const text = snapshotText(snap)
  const hash = await inputsHash({ text, week })
  const prev = await storedBrief(db, 'parent_weekly', sid, week)
  if (prev && prev.inputs_hash === hash) return { brief: prev, fresh: false }
  const system = 'You write a short weekly note to a parent about their child\'s week at school: attendance, homework, any marks, and notes from teachers. ' +
    'Warm, plain, 60-100 words, addressed to the parent, using the child\'s first name. Only facts from the input (the last 7 days); do not invent. ' +
    'End with one practical suggestion for home if the facts support one. Plain text, no markdown.'
  const body = await aiGenerate(env, db, system, text, { maxTokens: 500, today })
  const brief = await saveBrief(db, inst, { kind: 'parent_weekly', subject_id: sid, period_key: week, body,
    facts: { attendance: snap.attendance, homework: snap.homework, name: snap.first_name }, model: AI_MODEL, hash, by: null })
  return { brief, fresh: true }
}

/** Guardian logins of a child who may use the portal. */
async function guardianUsers(db: D1Database, sid: string, today: string): Promise<string[]> {
  const r = await db.prepare(`SELECT DISTINCT g.user_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
      WHERE sg.student_id = ? AND g.user_id IS NOT NULL AND sg.portal_blocked = 0 AND (sg.access_until IS NULL OR sg.access_until >= ?)`)
    .bind(sid, today).all<{ user_id: string }>()
  return r.results.map((x) => x.user_id)
}

/** The weekly sweep for one school: a note per active child with a guardian login, until the cap stops it. */
export async function weeklySweep(env: Env, db: D1Database, inst: { id: string; timezone?: string }, limit = 400): Promise<{ written: number; skipped: number; stopped: string | null }> {
  const res = { written: 0, skipped: 0, stopped: null as string | null }
  if (!(await aiConfigured(env))) { res.stopped = 'ai_not_configured'; return res }
  const settings = await aiSettings(db)
  if (!settings.enabled) { res.stopped = 'ai_disabled'; return res }
  const today = schoolToday(inst.timezone || 'Asia/Kolkata')
  const kids = await db.prepare(`SELECT DISTINCT st.id, st.first_name FROM students st JOIN student_guardians sg ON sg.student_id = st.id
      JOIN guardians g ON g.id = sg.guardian_id AND g.user_id IS NOT NULL WHERE st.status = 'active' ORDER BY st.id LIMIT ?`).bind(limit).all<{ id: string; first_name: string }>()
  const ms = new Messenger({ env, db, inst: inst.id })
  for (const k of kids.results) {
    let out: { brief: Brief | null; fresh: boolean }
    try { out = await generateParentWeekly(env, db, inst.id, k.id, today) } catch (e) {
      if (e instanceof HttpError && (e.status === 429 || e.status === 503 || e.status === 403)) { res.stopped = String((e.extra as { code?: string } | undefined)?.code ?? e.status); break }
      console.error('parent weekly', k.id, e); res.skipped++; continue
    }
    if (!out.brief || !out.fresh) { res.skipped++; continue }
    res.written++
    const users = await guardianUsers(db, k.id, today)
    const title = `${k.first_name}'s week at school`
    const at = new Date().toISOString()
    if (users.length) await db.batch(users.map((u) => db.prepare(`INSERT INTO notifications (id, institution_id, user_id, student_id, kind, title, body, link, created_at, source_kind, source_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), inst.id, u, k.id, 'ai.weekly_note', title, '(AI summary) ' + out.brief!.body.slice(0, 300),
        '/parent', at, 'ai_brief', out.brief!.id)))
    for (const u of users) for (const ch of [settings.parent_weekly_sms && 'sms', settings.parent_weekly_email && 'email'].filter(Boolean) as string[]) {
      try {
        await ms.queue({ channel: ch, template_code: 'messaging.direct', to_user_id: u, student_id: k.id, source_kind: 'ai_brief', source_id: out.brief.id,
          occurrence_key: `ai_weekly:${out.brief.id}:${u}:${ch}`, vars: { subject: title, text: out.brief.body } })
      } catch (e) { console.error('parent weekly send', ch, e) }
    }
  }
  await ms.kick().catch((e) => console.error('kick', e))
  return res
}

/** Queue the morning brief by e-mail to the principal / school admins, when the school turned it on. */
async function emailBrief(env: Env, db: D1Database, inst: string, b: Brief): Promise<void> {
  const users = await safe('brief recipients', async () => (await db.prepare(`SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE r.key IN ('principal','institution_admin')`).all<{ user_id: string }>()).results.map((x) => x.user_id), [])
  const ms = new Messenger({ env, db, inst })
  for (const u of users) {
    try {
      await ms.queue({ channel: 'email', template_code: 'messaging.direct', to_user_id: u, source_kind: 'ai_brief', source_id: b.id,
        occurrence_key: `ai_brief:${b.id}:${b.period_key}:${u}`,
        vars: { subject: `Morning brief, ${b.period_key} (${b.label})`, text: `${b.label}. Check the figures on the dashboard before acting.\n\n${b.body}` } })
    } catch (e) { console.error('brief email', e) }
  }
  await ms.kick()
}

registerJob('ai:principal_brief', async (env, job: Job) => {
  const { inst, db } = await jobSchool(env, job)
  const b = await generatePrincipalBrief(env, db, inst)
  if ((await aiSettings(db)).email_principal_brief) await emailBrief(env, db, inst.id, b)
})
registerJob('ai:parent_weekly', async (env, job: Job) => {
  const { inst, db } = await jobSchool(env, job)
  console.log('ai weekly parent notes', inst.slug, await weeklySweep(env, db, inst))
})
