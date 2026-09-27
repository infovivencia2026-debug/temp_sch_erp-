import type { Ctx } from '../../../router'
import { can } from '../../../identity'
import { isUUID, now } from '../../../http'
import { auditStmt } from '../../admin/common'
import { indiaToday, isClassTeacherOf, resolveScope } from '../../students/common'
import { ASSISTANT_ACTIONS, ActionRefusal, dispatch, type ProposedAction } from './actions'
import { filterDefaulters } from './tools'
import { findSection, isDate, readAs, refusal, rowsOf, rupees, str, strs, num } from './read'

/* THE ACTION REGISTRY THE MODEL PROPOSES FROM.

   The six Go actions (actions.ts) plus six more. Each is the same three steps:
   the model PROPOSES with typed arguments, preview() validates them under the
   asker's own identity and pins every id, and the chat draws a card with who
   and what will change. execute() runs only when Confirm is pressed
   (POST /assistant/confirm), re-checks the permission, and writes through the
   screen's own route wherever there is one, so a message is queued by the
   same code the screen uses, and never before the card is confirmed. */

type Params = Record<string, unknown>
const refuse = (m: string) => new ActionRefusal(m)

export interface Change { label: string; before?: string; after: string }
export interface AgentProposal extends ProposedAction {
  /** Lines of the diff the card draws: what each thing is, and becomes. */
  changes?: Change[]
  /** Headline numbers: recipients, rows, amount. */
  counts?: { label: string; value: string | number }[]
}

interface Param { type: 'STRING' | 'INTEGER' | 'NUMBER' | 'BOOLEAN' | 'ARRAY'; description: string; enum?: string[]; items?: { type: 'STRING' } }
export interface AgentAction {
  kind: string
  /** Any one of these lets the person propose and confirm it (the route re-checks its own). */
  perms: string[]
  description: string
  params: Record<string, Param>
  required?: string[]
  preview: (c: Ctx, p: Params) => Promise<AgentProposal>
  execute: (c: Ctx, p: Params) => Promise<string>
}

const refusalOf = (d: Record<string, unknown>, fallback: string) =>
  typeof d.error === 'string' ? d.error : (d.error as { message?: string } | undefined)?.message ?? fallback
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

// --- notice / circular ------------------------------------------------------------------------
const AUDIENCES = ['parents', 'students', 'staff', 'everyone', 'all']

async function sectionsOf(c: Ctx, labels: string[]): Promise<{ ids: string[]; names: string[] }> {
  const ids: string[] = [], names: string[] = []
  for (const l of labels.slice(0, 40)) {
    const s = await findSection(c, l, '')
    if (s.one) { ids.push(s.one.id); names.push(s.one.label); continue }
    if (s.classOnly) {
      const all = await c.db.prepare(`SELECT s.id, c.name || ' ' || s.name AS label FROM sections s JOIN classes c ON c.id = s.class_id WHERE c.id = ? ORDER BY s.name`)
        .bind(s.classOnly.id).all<{ id: string; label: string }>()
      for (const r of all.results) { ids.push(r.id); names.push(r.label) }
      continue
    }
    throw refuse(s.error ?? `no class "${l}"`)
  }
  return { ids, names }
}

const noticeSend: AgentAction = {
  kind: 'notice.send', perms: ['comms.announcements.write'],
  description: 'Publish a notice/circular to parents, students, staff or everyone, optionally only some classes. Recipients see it in the app; nothing goes out until confirmed.',
  params: {
    title: { type: 'STRING', description: 'Short title' }, body: { type: 'STRING', description: 'The full text' },
    audience: { type: 'STRING', description: 'Who receives it', enum: AUDIENCES },
    classes: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Classes or sections like "6", "7B" (optional; all when empty)' },
    requires_ack: { type: 'BOOLEAN', description: 'Ask readers to acknowledge (optional)' },
  },
  required: ['title', 'body', 'audience'],
  async preview(c, p) {
    const title = str(p, 'title'), body = str(p, 'body')
    if (!title || !body) throw refuse('a notice needs a title and a body')
    const audience = (str(p, 'audience') || 'parents').toLowerCase()
    if (!AUDIENCES.includes(audience)) throw refuse('send it to parents, students, staff or everyone')
    const { ids, names } = audience === 'staff' ? { ids: [], names: [] } : await sectionsOf(c, strs(p, 'classes'))
    let n = 0
    if (audience === 'staff') n = (await c.db.prepare(`SELECT count(*) AS n FROM employees WHERE status = 'active'`).first<{ n: number }>())?.n ?? 0
    else n = (await c.db.prepare(`SELECT count(DISTINCT st.id) AS n FROM students st JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
        WHERE st.status = 'active' AND (? OR e.section_id IN (SELECT value FROM json_each(?)))`).bind(ids.length ? 0 : 1, JSON.stringify(ids)).first<{ n: number }>())?.n ?? 0
    const who = audience === 'staff' ? plural(n, 'staff member') : `${audience === 'students' ? '' : 'the families of '}${plural(n, 'student')}`
    const where = names.length ? ` in ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}` : ''
    return {
      kind: 'notice.send', title: 'Send a notice', sensitive: true,
      summary: `Publish “${title}” to ${audience}${where}.`,
      before: 'not sent', after: `${who} will see it in the app`,
      changes: [{ label: 'Title', after: title }, { label: 'Text', after: body.length > 280 ? body.slice(0, 280) + '…' : body },
        { label: 'Audience', after: audience + (where || ', whole school') }, ...(p.requires_ack ? [{ label: 'Acknowledgement', after: 'requested' }] : [])],
      counts: [{ label: audience === 'staff' ? 'Staff' : 'Students', value: n }],
      params: { title, body, audience, section_ids: ids, requires_ack: p.requires_ack === true },
    }
  },
  async execute(c, p) {
    const ids = Array.isArray(p.section_ids) ? (p.section_ids as unknown[]).map(String).filter(isUUID) : []
    const r = await dispatch(c, 'POST', '/communication/circulars', JSON.stringify({
      title: str(p, 'title'), body: str(p, 'body'), kind: 'circular', audience_role: str(p, 'audience'), section_ids: ids, requires_ack: p.requires_ack === true,
    }), 'application/json')
    if (r.status !== 200 && r.status !== 201) throw refuse(refusalOf(r.data, 'the notice could not be published'))
    return `Published “${str(p, 'title')}” to ${plural(Number(r.data.recipients ?? 0), 'recipient')}.`
  },
}

// --- fee reminders ------------------------------------------------------------------------------
const feeReminder: AgentAction = {
  kind: 'fee.reminder', perms: ['finance.fees.write'],
  description: 'Remind the families of fee defaulters (filter by class, minimum balance, days overdue). In-app always; SMS, WhatsApp or email only if asked.',
  params: {
    class: { type: 'STRING', description: 'Class (optional)' }, min_balance: { type: 'NUMBER', description: 'Rupees (optional)' },
    min_days_overdue: { type: 'INTEGER', description: 'Days (optional)' },
    channels: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Extra channels: sms, whatsapp, email (optional)' },
  },
  async preview(c, p) {
    const g = await readAs(c, '/fees/defaulters')
    if (g.status !== 200) throw refuse(refusal(g))
    const rows = filterDefaulters(rowsOf(g.data), p).slice(0, 500)
    if (rows.length === 0) throw refuse('no family matches those filters, so there is nobody to remind')
    const channels = strs(p, 'channels').map((x) => x.toLowerCase()).filter((x) => ['sms', 'whatsapp', 'email'].includes(x))
    const total = rows.reduce((s, r) => s + Number(r.balance_paise ?? 0), 0)
    return {
      kind: 'fee.reminder', title: 'Send fee reminders', sensitive: true,
      summary: `Remind ${plural(rows.length, 'family', 'families')} who owe ${rupees(total)} in all.`,
      before: 'not reminded', after: 'in-app notice' + (channels.length ? ' + ' + channels.join(', ') : ''),
      changes: rows.slice(0, 8).map((r) => ({ label: String(r.full_name), before: r.last_reminded ? 'last reminded ' + String(r.last_reminded).slice(0, 10) : 'never reminded', after: rupees(r.balance_paise) + ' due' })),
      counts: [{ label: 'Families', value: rows.length }, { label: 'Outstanding', value: rupees(total) }],
      params: { student_ids: rows.map((r) => String(r.student_id)), channels },
    }
  },
  async execute(c, p) {
    const ids = Array.isArray(p.student_ids) ? (p.student_ids as unknown[]).map(String).filter(isUUID) : []
    if (ids.length === 0) throw refuse('nobody to remind')
    const r = await dispatch(c, 'POST', '/fees/reminders/send', JSON.stringify({ student_ids: ids, channels: strs(p, 'channels') }), 'application/json')
    if (r.status !== 200) throw refuse(refusalOf(r.data, 'the reminders could not be sent'))
    return `Sent ${plural(ids.length, 'reminder')}: ${plural(Number(r.data.told ?? 0), 'parent')} told in the app` +
      (Number(r.data.messages_queued ?? 0) ? `, ${r.data.messages_queued} messages queued.` : '.')
  },
}

// --- leave --------------------------------------------------------------------------------------
const leaveDecide: AgentAction = {
  kind: 'leave.decide', perms: ['hr.leave.approve', 'academics.attendance.write'],
  description: 'Approve or reject one pending leave request, found by its id or the person on leave.',
  params: {
    who: { type: 'STRING', description: 'Name of the person on leave, or the request id' },
    decision: { type: 'STRING', description: 'approved or rejected', enum: ['approved', 'rejected'] },
    note: { type: 'STRING', description: 'A note (optional)' },
  },
  required: ['who', 'decision'],
  async preview(c, p) {
    const decision = str(p, 'decision').toLowerCase().replace(/^approve$/, 'approved').replace(/^reject$/, 'rejected')
    if (decision !== 'approved' && decision !== 'rejected') throw refuse('say approve or reject')
    const g = await readAs(c, '/hr/leave', { status: 'pending', for: can(c.id, 'hr.leave.approve') ? undefined : 'student' })
    if (g.status !== 200) throw refuse(refusal(g))
    const who = str(p, 'who').toLowerCase()
    const hits = rowsOf(g.data).filter((r) => r.id === str(p, 'who') || String(r.who ?? '').toLowerCase().includes(who))
    if (hits.length === 0) throw refuse(`no pending leave request for "${str(p, 'who')}" that you can decide`)
    if (hits.length > 1) throw refuse(`${hits.length} pending requests match "${str(p, 'who')}": ${hits.slice(0, 4).map((h) => `${h.who} ${h.from_date}`).join(', ')}; say which`)
    const h = hits[0]
    return {
      kind: 'leave.decide', title: decision === 'approved' ? 'Approve leave' : 'Reject leave', sensitive: false,
      summary: `${decision === 'approved' ? 'Approve' : 'Reject'} ${h.who}'s ${h.leave_type ?? 'leave'}, ${h.from_date} to ${h.to_date} (${h.days} days).`,
      before: 'pending', after: decision,
      changes: [{ label: String(h.who), before: 'pending', after: decision }, ...(h.reason ? [{ label: 'Reason given', after: String(h.reason) }] : [])],
      params: { leave_id: h.id, decision, note: str(p, 'note'), who: h.who },
    }
  },
  async execute(c, p) {
    const id = str(p, 'leave_id')
    if (!isUUID(id)) throw refuse('the request could not be identified')
    const r = await dispatch(c, 'POST', `/workflow/leave/${id}/decide`, JSON.stringify({ decision: str(p, 'decision'), note: str(p, 'note') }), 'application/json')
    if (r.status !== 200) throw refuse(refusalOf(r.data, 'the decision could not be saved'))
    return `${str(p, 'decision') === 'approved' ? 'Approved' : 'Rejected'} ${str(p, 'who')}'s leave.`
  },
}

// --- homework -----------------------------------------------------------------------------------
const homeworkCreate: AgentAction = {
  kind: 'homework.create', perms: ['academics.homework.write'],
  description: 'Set homework for one class section, optionally for a subject, with a due date. Families see it in the app.',
  params: {
    class: { type: 'STRING', description: 'Class, e.g. "6"' }, section: { type: 'STRING', description: 'Section, e.g. "A"' },
    subject: { type: 'STRING', description: 'Subject (optional)' }, title: { type: 'STRING', description: 'Short title' },
    instructions: { type: 'STRING', description: 'What to do (optional)' }, due_on: { type: 'STRING', description: 'YYYY-MM-DD (optional)' },
  },
  required: ['class', 'title'],
  async preview(c, p) {
    const s = await findSection(c, str(p, 'class'), str(p, 'section'))
    if (!s.one) throw refuse(s.error!)
    if (!isClassTeacherOf(await resolveScope(c), s.one.id)) throw refuse(`you can set homework only for your own sections, not ${s.one.label}`)
    const title = str(p, 'title')
    if (!title) throw refuse('the homework needs a title')
    const due = str(p, 'due_on')
    if (due && !isDate(due)) throw refuse('the due date must be YYYY-MM-DD')
    let classSubject = '', subjectName = ''
    if (str(p, 'subject')) {
      const r = await c.db.prepare(`SELECT cs.id, sub.name FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id
          WHERE cs.class_id = ? AND (lower(sub.name) LIKE '%' || lower(?) || '%' OR lower(sub.code) = lower(?)) LIMIT 1`)
        .bind(s.one.class_id, str(p, 'subject'), str(p, 'subject')).first<{ id: string; name: string }>()
      if (!r) throw refuse(`no subject "${str(p, 'subject')}" in ${s.one.label}`)
      classSubject = r.id; subjectName = r.name
    }
    const n = (await c.db.prepare(`SELECT count(*) AS n FROM enrollments WHERE section_id = ? AND status = 'active'`).bind(s.one.id).first<{ n: number }>())?.n ?? 0
    return {
      kind: 'homework.create', title: 'Set homework', sensitive: false,
      summary: `Set “${title}” for ${s.one.label}${subjectName ? ' in ' + subjectName : ''}${due ? ', due ' + due : ''}.`,
      before: 'no such homework', after: `published to ${plural(n, 'student')}`,
      changes: [{ label: 'Class', after: s.one.label }, ...(subjectName ? [{ label: 'Subject', after: subjectName }] : []), { label: 'Title', after: title },
        ...(str(p, 'instructions') ? [{ label: 'Instructions', after: str(p, 'instructions') }] : []), { label: 'Due', after: due || 'no date' }],
      counts: [{ label: 'Students', value: n }],
      params: { section_id: s.one.id, class_subject_id: classSubject, title, instructions: str(p, 'instructions'), due_on: due, label: s.one.label },
    }
  },
  async execute(c, p) {
    const body: Record<string, unknown> = { section_id: str(p, 'section_id'), title: str(p, 'title'), kind: 'homework' }
    if (str(p, 'class_subject_id')) body.class_subject_id = str(p, 'class_subject_id')
    if (str(p, 'instructions')) body.instructions = str(p, 'instructions')
    if (str(p, 'due_on')) body.due_on = str(p, 'due_on')
    const r = await dispatch(c, 'POST', '/homework', JSON.stringify(body), 'application/json')
    if (r.status !== 200 && r.status !== 201) throw refuse(refusalOf(r.data, 'the homework could not be set'))
    return `Set “${str(p, 'title')}” for ${str(p, 'label')}.`
  },
}

// --- bulk attendance: "all present except ..." ------------------------------------------------------
const MARKS = ['present', 'absent', 'late', 'half_day', 'leave']
const attendanceBulk: AgentAction = {
  kind: 'attendance.bulk', perms: ['academics.attendance.write'],
  description: 'Mark a whole section for a day: everyone present except the students named as absent, late or on leave.',
  params: {
    class: { type: 'STRING', description: 'Class' }, section: { type: 'STRING', description: 'Section' },
    date: { type: 'STRING', description: 'YYYY-MM-DD, default today' },
    absent: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Names or admission numbers of absent students' },
    late: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Late students (optional)' },
    leave: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Students on leave (optional)' },
  },
  required: ['class'],
  async preview(c, p) {
    const s = await findSection(c, str(p, 'class'), str(p, 'section'))
    if (!s.one) throw refuse(s.error!)
    if (!isClassTeacherOf(await resolveScope(c), s.one.id)) throw refuse(`you can mark attendance only for your own sections, not ${s.one.label}`)
    const date = str(p, 'date') || indiaToday()
    if (!isDate(date)) throw refuse('the date must be YYYY-MM-DD')
    if (date > indiaToday()) throw refuse('attendance cannot be marked for a future day')
    const roster = await readAs(c, '/students', { section_id: s.one.id, limit: 200, with_total: 0 })
    if (roster.status !== 200) throw refuse(refusal(roster))
    const kids = rowsOf(roster.data).map((r) => ({ id: String(r.id), name: String(r.full_name), adm: String(r.admission_no ?? '') }))
    if (kids.length === 0) throw refuse(`${s.one.label} has no students`)
    const status = new Map(kids.map((k) => [k.id, 'present']))
    for (const mark of ['absent', 'late', 'leave']) {
      for (const who of strs(p, mark)) {
        const w = who.toLowerCase(), toks = w.split(/\s+/)
        const m = kids.filter((k) => k.adm.toLowerCase() === w || toks.every((t) => k.name.toLowerCase().includes(t)))
        if (m.length === 0) throw refuse(`nobody in ${s.one.label} matches "${who}"`)
        if (m.length > 1) throw refuse(`"${who}" matches ${m.map((x) => x.name).join(' and ')}; use the full name or admission number`)
        status.set(m[0].id, mark)
      }
    }
    const cur = await readAs(c, '/attendance', { section_id: s.one.id, on_date: date })
    const before = new Map(rowsOf(cur.data).map((r) => [String(r.student_id), String(r.status)]))
    const tally: Record<string, number> = {}
    for (const v of status.values()) tally[v] = (tally[v] ?? 0) + 1
    const changes: { label: string; before?: string; after: string }[] = []
    let changed = 0
    for (const k of kids) {
      const b = before.get(k.id), a = status.get(k.id)!
      if (b !== a) changed++
      if (a !== 'present' || (b && b !== a)) changes.push({ label: k.name, before: b ?? 'not marked', after: a })
    }
    return {
      kind: 'attendance.bulk', title: 'Mark the register', sensitive: false,
      summary: `Mark ${s.one.label} for ${date}: ${Object.entries(tally).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}.` + (tally.absent ? ' Parents of absent children are told, as from the register.' : ''),
      before: before.size ? `${before.size} already marked` : 'not marked', after: `${kids.length} marked, ${changed} changed`,
      changes: changes.slice(0, 20),
      counts: Object.entries(tally).map(([k, v]) => ({ label: k.replace('_', ' '), value: v })),
      params: { section_id: s.one.id, date, entries: kids.map((k) => ({ student_id: k.id, status: status.get(k.id) })), label: s.one.label },
    }
  },
  async execute(c, p) {
    const entries = Array.isArray(p.entries) ? (p.entries as { student_id?: unknown; status?: unknown }[])
      .filter((e) => isUUID(e.student_id) && MARKS.includes(String(e.status))).map((e) => ({ student_id: String(e.student_id), status: String(e.status) })) : []
    if (entries.length === 0) throw refuse('nobody to mark')
    const r = await dispatch(c, 'POST', '/attendance', JSON.stringify({ section_id: str(p, 'section_id'), on_date: str(p, 'date'), entries }), 'application/json')
    if (r.status !== 200 && r.status !== 201) throw refuse(refusalOf(r.data, 'the register could not be saved'))
    return `Marked ${str(p, 'label')} for ${str(p, 'date')}: ${plural(Number(r.data.written ?? entries.length), 'mark')} saved` +
      (Number(r.data.parents_told ?? 0) ? `, ${r.data.parents_told} parents told.` : '.')
  },
}

// --- PTM slots ------------------------------------------------------------------------------------
const ptmSchedule: AgentAction = {
  kind: 'ptm.schedule', perms: ['academics.attendance.write'],
  description: "Open parent-teacher meeting slots in the asker's own diary for a section on a date; families book them from the app.",
  params: {
    class: { type: 'STRING', description: 'Class' }, section: { type: 'STRING', description: 'Section' },
    date: { type: 'STRING', description: 'YYYY-MM-DD' }, start: { type: 'STRING', description: 'First slot, HH:MM (24h)' },
    slots: { type: 'INTEGER', description: 'How many slots, default 10' }, minutes: { type: 'INTEGER', description: 'Minutes each, default 10' },
    mode: { type: 'STRING', description: 'in_person or online', enum: ['in_person', 'online'] }, location: { type: 'STRING', description: 'Room or link (optional)' },
  },
  required: ['class', 'date', 'start'],
  async preview(c, p) {
    const s = await findSection(c, str(p, 'class'), str(p, 'section'))
    if (!s.one) throw refuse(s.error!)
    const sc = await resolveScope(c)
    if (!isClassTeacherOf(sc, s.one.id) && !sc.sectionIds.includes(s.one.id)) throw refuse(`${s.one.label} is not one of your sections`)
    const emp = await c.db.prepare(`SELECT id FROM employees WHERE user_id = ? AND status = 'active'`).bind(c.id.userId).first<{ id: string }>()
    if (!emp) throw refuse('meeting slots go in a staff member’s own diary, and you have no staff record')
    const date = str(p, 'date'), start = str(p, 'start')
    if (!isDate(date)) throw refuse('the date must be YYYY-MM-DD')
    if (date < indiaToday()) throw refuse('that date has passed')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) throw refuse('the start time must be HH:MM, 24-hour')
    const n = Math.max(1, Math.min(40, num(p, 'slots') ?? 10)), mins = Math.max(5, Math.min(60, num(p, 'minutes') ?? 10))
    const times: string[] = []
    let t = Number(start.slice(0, 2)) * 60 + Number(start.slice(3))
    for (let i = 0; i < n && t + mins <= 22 * 60; i++, t += mins) times.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`)
    const taken = await c.db.prepare(`SELECT substr(starts_at, 1, 5) AS t FROM ptm_slots WHERE employee_id = ? AND on_date = ?`).bind(emp.id, date).all<{ t: string }>()
    const clash = new Set(taken.results.map((r) => r.t))
    const fresh = times.filter((x) => !clash.has(x))
    if (fresh.length === 0) throw refuse('you already have slots at all of those times')
    const mode = str(p, 'mode') === 'online' ? 'online' : 'in_person'
    return {
      kind: 'ptm.schedule', title: 'Open PTM slots', sensitive: false,
      summary: `Open ${plural(fresh.length, 'slot')} of ${mins} minutes for ${s.one.label} on ${date}, ${fresh[0]} to ${fresh[fresh.length - 1]}.`,
      before: taken.results.length ? `${taken.results.length} slots already that day` : 'no slots that day', after: `${fresh.length} bookable slots`,
      changes: [{ label: 'Times', after: fresh.join(', ') }, { label: 'Mode', after: mode.replace('_', ' ') + (str(p, 'location') ? ', ' + str(p, 'location') : '') },
        ...(times.length > fresh.length ? [{ label: 'Skipped', after: `${times.length - fresh.length} already booked in your diary` }] : [])],
      counts: [{ label: 'Slots', value: fresh.length }],
      params: { section_id: s.one.id, date, times: fresh, minutes: mins, mode, location: str(p, 'location'), label: s.one.label },
    }
  },
  async execute(c, p) {
    const sectionId = str(p, 'section_id'), date = str(p, 'date')
    if (!isUUID(sectionId) || !isDate(date)) throw refuse('the slots could not be identified')
    const sc = await resolveScope(c)
    if (!isClassTeacherOf(sc, sectionId) && !sc.sectionIds.includes(sectionId)) throw refuse('that section is not one of yours')
    const emp = await c.db.prepare(`SELECT id, campus_id FROM employees WHERE user_id = ? AND status = 'active'`).bind(c.id.userId).first<{ id: string; campus_id: string | null }>()
    if (!emp) throw refuse('you have no staff record')
    const times = (Array.isArray(p.times) ? p.times as unknown[] : []).map(String).filter((x) => /^\d{2}:\d{2}$/.test(x)).slice(0, 40)
    const inst = c.id.institution!.id, ts = now()
    const stmts = times.map((t) => c.db.prepare(`INSERT OR IGNORE INTO ptm_slots (id, institution_id, campus_id, employee_id, section_id, on_date, starts_at, minutes, mode, location, is_open, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,NULLIF(?,''),1,?,?)`).bind(crypto.randomUUID(), inst, emp.campus_id, emp.id, sectionId, date, t + ':00', Number(p.minutes ?? 10), str(p, 'mode') || 'in_person', str(p, 'location'), c.id.userId, ts))
    if (stmts.length === 0) throw refuse('no times to open')
    const res = await c.db.batch([...stmts, auditStmt(c, 'ptm.slots.create', 'ptm_slots', sectionId, null, { date, times })])
    const made = res.slice(0, stmts.length).reduce((s, r) => s + Number(r.meta?.changes ?? 0), 0)
    return `Opened ${plural(made, 'PTM slot')} for ${str(p, 'label')} on ${date}.`
  },
}

// --- the six from Go, with typed arguments ------------------------------------------------------
const S = (description: string): Param => ({ type: 'STRING', description })
const go = (kind: string, description: string, params: Record<string, Param>, required: string[]): AgentAction => {
  const spec = ASSISTANT_ACTIONS[kind]
  return {
    kind, perms: [spec.perm], description, params, required,
    preview: async (c, p) => ({ ...(await spec.preview(c, p)), sensitive: spec.sensitive }),
    execute: spec.execute,
  }
}
const GO_ACTIONS: AgentAction[] = [
  go('attendance.mark', 'Mark ONE student present, absent, late, half_day, leave or holiday for a day.',
    { student: S('Name or admission number'), date: S('YYYY-MM-DD, default today'), status: { type: 'STRING', description: 'The mark', enum: ['present', 'absent', 'late', 'half_day', 'leave', 'holiday'] } }, ['student', 'status']),
  go('marks.enter', "Set one student's mark for a subject in an exam.",
    { student: S('Name or admission number'), exam: S('Exam name'), subject: S('Subject'), marks: { type: 'NUMBER', description: 'Marks' }, is_absent: { type: 'BOOLEAN', description: 'Sat no paper' } }, ['student', 'exam', 'subject']),
  go('student.create', 'Admit a new student into a section.',
    { name: S('Full name'), class: S('Class'), section: S('Section'), guardian_name: S('Parent name (optional)'), guardian_phone: S('Parent phone (optional)') }, ['name']),
  go('guardian.set_phone', "Add or correct a guardian's phone for a student.",
    { student: S('Name or admission number'), phone: S('New phone'), guardian_name: S('Which parent (optional)'), relation: S('father, mother, guardian or other (optional)') }, ['student', 'phone']),
  go('fee.payment', 'Record an ordinary counter fee payment.',
    { student: S('Name or admission number'), amount: { type: 'NUMBER', description: 'Rupees' }, mode: { type: 'STRING', description: 'Mode', enum: ['cash', 'upi', 'card', 'neft', 'cheque', 'dd', 'netbanking'] }, head: S('What it is for (optional)'), reference_no: S('Reference, required for cheque or DD') }, ['student', 'amount']),
  go('enquiry.create', 'Log an admissions enquiry.',
    { student_name: S('Child name'), class_sought: S('Class sought'), parent_name: S('Parent name (optional)'), phone: S('Parent phone'), source: { type: 'STRING', description: 'Source', enum: ['walk_in', 'phone', 'website', 'referral', 'campaign', 'other'] } }, ['student_name', 'phone']),
]

export const AGENT_ACTIONS: AgentAction[] = [...GO_ACTIONS, noticeSend, feeReminder, leaveDecide, homeworkCreate, attendanceBulk, ptmSchedule]
export const actionByKind = (kind: string) => AGENT_ACTIONS.find((a) => a.kind === kind)
export const mayPropose = (c: Ctx, a: AgentAction) => a.perms.some((p) => can(c.id, p))
/** The function name the model calls to propose an action. */
export const proposeName = (kind: string) => 'propose_' + kind.replace(/\./g, '_')
