import type { Router, Ctx } from '../../router'
import { HttpError, badRequest, created, isUUID, notFound, ok, readJSON, uuid, uuidParam, now } from '../../http'
import { instId, ensureCampus, str, isUniqueViolation, batch } from './common'
import { all } from '../scheduling/common'
import { DEFAULT_SCHEDULE_SQL, defaultScheduleId, periodsOfSchedule, sectionScheduleSQL } from '../scheduling/bell'

/* TIMINGS PER CLASS (owner, 2026-10-13: "let them edit the timings per class
   while creating a timetable").

   A bell schedule is a named set of periods. The school day is the default
   one, edited on the setup step as it always was; a class or one section may
   run to another (scheduling/bell.ts has the rule). These routes list, make,
   edit and delete schedules and say which class runs to which.

   A class that already has a timetable keeps it when its timings change:
   lessons are matched to the new periods by their place in the day (period
   1 to period 1). Anything that has no place to go -- the new day is shorter,
   or that slot is now a break -- is named first and only dropped once the
   person says so (confirm: true). Periods that attendance has been marked
   against are never deleted. */

const READ = 'academics.read'
const WRITE = 'academics.write'

interface PeriodIn { name: string; sequence: number; starts_at: string; ends_at: string; is_break: boolean }
interface Dropped { section: string; weekday: number; period: string; subject: string; draft: boolean }

function readPeriods(raw: unknown): PeriodIn[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
  if (list.length === 0) throw badRequest('at least one period is required')
  const seen = new Set<number>()
  const out = list.map((p, i): PeriodIn => {
    const name = str(p.name).trim(), startsAt = str(p.starts_at).slice(0, 5), endsAt = str(p.ends_at).slice(0, 5)
    if (name === '' || startsAt === '' || endsAt === '') throw badRequest('every period needs a name, a start time and an end time')
    if (startsAt >= endsAt) throw badRequest(name + ' ends before it starts')
    const seq = p.sequence === undefined || p.sequence === null ? i + 1 : Math.trunc(Number(p.sequence))
    if (!Number.isFinite(seq) || seq < 1) throw badRequest('sequence must be a positive number')
    if (seen.has(seq)) throw badRequest('two periods share the same sequence number')
    seen.add(seq)
    return { name, sequence: seq, starts_at: startsAt, ends_at: endsAt, is_break: p.is_break === true }
  })
  if (!out.some((p) => !p.is_break)) throw badRequest('the day needs at least one teaching period')
  return out
}

const refusedDrop = (dropped: Dropped[]) => new HttpError(409,
  `${dropped.length} timetable ${dropped.length === 1 ? 'slot has' : 'slots have'} no place in the new timings and would be removed`,
  { code: 'slots_dropped', dropped })

/** The sections whose day comes from this schedule (their own, their class's, or the school day). */
async function sectionsOn(c: Ctx, scheduleId: string): Promise<string[]> {
  return (await all<{ id: string }>(c.db.prepare(`SELECT s.id FROM sections s WHERE ${sectionScheduleSQL('s')} = ?`).bind(scheduleId))).map((r) => r.id)
}

/* Moves these sections' lessons (live and in open drafts) onto the target
   periods by sequence. Returns the statements and what has nowhere to go. */
async function remap(c: Ctx, sectionIds: string[], target: { id: string; sequence: number; is_break: boolean }[], onlyFrom?: Set<string>): Promise<{ stmts: D1PreparedStatement[]; dropped: Dropped[] }> {
  if (sectionIds.length === 0) return { stmts: [], dropped: [] }
  const ids = JSON.stringify(sectionIds)
  const bySeq = new Map(target.map((p) => [p.sequence, p]))
  const targetIds = JSON.stringify(target.map((p) => p.id))
  type Row = { kind: string; id: string; section_id: string; weekday: number; teacher: string | null; scope: string; period_id: string; sequence: number
    period_name: string; section_name: string; subject: string }
  const rows = await all<Row>(c.db.prepare(`
    SELECT 'live' AS kind, te.id, te.section_id, te.weekday, te.teacher_user_id AS teacher, te.academic_year_id AS scope, te.period_id, p.sequence,
           p.name AS period_name, cl.name || '-' || sec.name AS section_name, COALESCE(sub.name, '') AS subject
      FROM timetable_entries te JOIN periods p ON p.id = te.period_id JOIN sections sec ON sec.id = te.section_id JOIN classes cl ON cl.id = sec.class_id
      LEFT JOIN class_subjects cs ON cs.id = te.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id
     WHERE te.section_id IN (SELECT value FROM json_each(?1))
    UNION ALL
    SELECT 'draft', de.id, de.section_id, de.weekday, de.teacher_user_id, de.draft_id, de.period_id, p.sequence,
           p.name, cl.name || '-' || sec.name, COALESCE(sub.name, '')
      FROM timetable_draft_entries de JOIN timetable_drafts d ON d.id = de.draft_id AND d.status = 'draft'
      JOIN periods p ON p.id = de.period_id JOIN sections sec ON sec.id = de.section_id JOIN classes cl ON cl.id = sec.class_id
      LEFT JOIN class_subjects cs ON cs.id = de.class_subject_id LEFT JOIN subjects sub ON sub.id = cs.subject_id
     WHERE de.section_id IN (SELECT value FROM json_each(?1))
     ORDER BY 1, 4, 8`).bind(ids))
  // Who is already where on the target periods, outside the sections being moved.
  const taken = new Set<string>()
  const others = await all<{ kind: string; scope: string; teacher: string; weekday: number; period_id: string }>(c.db.prepare(`
    SELECT 'live' AS kind, academic_year_id AS scope, teacher_user_id AS teacher, weekday, period_id FROM timetable_entries
     WHERE teacher_user_id IS NOT NULL AND period_id IN (SELECT value FROM json_each(?1)) AND section_id NOT IN (SELECT value FROM json_each(?2))
    UNION ALL
    SELECT 'draft', draft_id, teacher_user_id, weekday, period_id FROM timetable_draft_entries
     WHERE teacher_user_id IS NOT NULL AND period_id IN (SELECT value FROM json_each(?1)) AND section_id NOT IN (SELECT value FROM json_each(?2))`)
    .bind(targetIds, ids))
  for (const o of others) taken.add(`t|${o.kind}|${o.scope}|${o.teacher}|${o.weekday}|${o.period_id}`)
  // Lessons already on a target period stay put and hold their slot.
  const onTarget = new Set(target.map((p) => p.id))
  for (const r of rows) {
    if (!onTarget.has(r.period_id)) continue
    taken.add(`s|${r.kind}|${r.scope}|${r.section_id}|${r.weekday}|${r.period_id}`)
    if (r.teacher) taken.add(`t|${r.kind}|${r.scope}|${r.teacher}|${r.weekday}|${r.period_id}`)
  }
  const deletes: D1PreparedStatement[] = [], updates: D1PreparedStatement[] = []
  const dropped: Dropped[] = []
  const table = (k: string) => (k === 'live' ? 'timetable_entries' : 'timetable_draft_entries')
  for (const r of rows) {
    if (onlyFrom && !onlyFrom.has(r.period_id)) continue
    if (onTarget.has(r.period_id)) {
      const p = target.find((t) => t.id === r.period_id)
      if (!p?.is_break) continue
    }
    const to = bySeq.get(r.sequence)
    const sKey = to && `s|${r.kind}|${r.scope}|${r.section_id}|${r.weekday}|${to.id}`
    const tKey = to && r.teacher ? `t|${r.kind}|${r.scope}|${r.teacher}|${r.weekday}|${to.id}` : ''
    if (!to || to.is_break || taken.has(sKey!) || (tKey && taken.has(tKey))) {
      dropped.push({ section: r.section_name, weekday: r.weekday, period: r.period_name, subject: r.subject, draft: r.kind === 'draft' })
      deletes.push(c.db.prepare(`DELETE FROM ${table(r.kind)} WHERE id = ?`).bind(r.id))
      continue
    }
    if (to.id === r.period_id) continue
    taken.add(sKey!)
    if (tKey) taken.add(tKey)
    updates.push(c.db.prepare(`UPDATE ${table(r.kind)} SET period_id = ? WHERE id = ?`).bind(to.id, r.id))
  }
  // Deletes first, so a freed slot is free before a lesson moves into it.
  return { stmts: [...deletes, ...updates], dropped }
}

/** Refuses when attendance has been marked against any of these periods. */
async function guardAttendance(c: Ctx, periodIds: string[]): Promise<void> {
  if (periodIds.length === 0) return
  const hit = await c.db.prepare(`SELECT p.name FROM student_attendance a JOIN periods p ON p.id = a.period_id
      WHERE a.period_id IN (SELECT value FROM json_each(?)) LIMIT 1`).bind(JSON.stringify(periodIds)).first<{ name: string }>()
  if (hit) throw new HttpError(409, `attendance has been marked in ${hit.name}, so it cannot be removed. Keep it, or rename it`, { code: 'period_in_use' })
}

async function scheduleHead(c: Ctx, id: string): Promise<{ id: string; name: string; is_default: number }> {
  const row = await c.db.prepare(`SELECT id, name, (id = ${DEFAULT_SCHEDULE_SQL}) AS is_default FROM bell_schedules WHERE id = ?`).bind(id)
    .first<{ id: string; name: string; is_default: number }>()
  if (!row) throw notFound('that schedule no longer exists')
  return row
}

const periodRows = (c: Ctx, inst: string, campus: string, schedule: string, ps: PeriodIn[]) => ps.map((p) =>
  c.db.prepare(`INSERT INTO periods (id, institution_id, campus_id, bell_schedule_id, name, sequence, starts_at, ends_at, is_break)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (bell_schedule_id, sequence) DO UPDATE SET name = excluded.name,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, is_break = excluded.is_break`)
    .bind(uuid(), inst, campus, schedule, p.name, p.sequence, p.starts_at, p.ends_at, p.is_break ? 1 : 0))

async function listSchedules(c: Ctx): Promise<Response> {
  const heads = await all<{ id: string; name: string; is_default: number }>(c.db.prepare(
    `SELECT b.id, b.name, (b.id = ${DEFAULT_SCHEDULE_SQL}) AS is_default FROM bell_schedules b ORDER BY (b.id = ${DEFAULT_SCHEDULE_SQL}) DESC, b.name`))
  const classes = await all<{ id: string; name: string; bell_schedule_id: string | null }>(c.db.prepare(
    `SELECT id, name, bell_schedule_id FROM classes ORDER BY level, name`))
  const sections = await all<{ id: string; name: string; class_id: string; class_name: string; bell_schedule_id: string | null }>(c.db.prepare(`
    SELECT s.id, s.name, s.class_id, cl.name AS class_name, s.bell_schedule_id FROM sections s JOIN classes cl ON cl.id = s.class_id
     WHERE s.academic_year_id = COALESCE((SELECT id FROM academic_years WHERE is_current ORDER BY starts_on DESC LIMIT 1), s.academic_year_id)
     ORDER BY cl.level, s.name`))
  const items = []
  for (const h of heads) {
    items.push({
      id: h.id, name: h.name, is_default: !!h.is_default, periods: await periodsOfSchedule(c, h.id),
      classes: classes.filter((x) => x.bell_schedule_id === h.id).map((x) => ({ id: x.id, name: x.name })),
      sections: sections.filter((x) => x.bell_schedule_id === h.id).map((x) => ({ id: x.id, name: x.name, class_id: x.class_id, class_name: x.class_name })),
    })
  }
  return ok({
    items,
    // Every class and section with the schedule set on it (null = follows the class, or the school day).
    classes: classes.map((x) => ({ id: x.id, name: x.name, bell_schedule_id: x.bell_schedule_id })),
    sections: sections.map((x) => ({ id: x.id, name: x.name, class_id: x.class_id, class_name: x.class_name, bell_schedule_id: x.bell_schedule_id })),
  })
}

async function createSchedule(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  const name = str(req.name).trim()
  if (name === '') throw badRequest('give the timings a name')
  let periods: PeriodIn[]
  if (req.periods !== undefined) periods = readPeriods(req.periods)
  else {
    // A copy of another schedule (or the school day) to start from.
    const from = str(req.copy_from)
    const src = await periodsOfSchedule(c, isUUID(from) ? from : await defaultScheduleId(c))
    if (src.length === 0) throw badRequest('set the school day first, then copy it')
    periods = src.map((p) => ({ name: p.name, sequence: p.sequence, starts_at: p.starts_at, ends_at: p.ends_at, is_break: p.is_break }))
  }
  const inst = instId(c), campus = await ensureCampus(c)
  const id = uuid()
  try {
    await batch(c, [
      c.db.prepare(`INSERT INTO bell_schedules (id, institution_id, campus_id, name, is_default, created_at) VALUES (?, ?, ?, ?, 0, ?)`)
        .bind(id, inst, campus, name, now()),
      ...periodRows(c, inst, campus, id, periods),
    ])
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, `there are already timings called ${name}`)
    throw e
  }
  return created({ id, name, periods: periods.length })
}

async function updateSchedule(c: Ctx): Promise<Response> {
  const id = uuidParam(c.params.id)
  const head = await scheduleHead(c, id)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const stmts: D1PreparedStatement[] = []
  const name = req.name === undefined ? '' : str(req.name).trim()
  if (req.name !== undefined && name === '') throw badRequest('give the timings a name')
  if (name !== '' && name !== head.name) stmts.push(c.db.prepare(`UPDATE bell_schedules SET name = ? WHERE id = ?`).bind(name, id))
  let dropped: Dropped[] = []
  if (req.periods !== undefined) {
    const periods = readPeriods(req.periods)
    const before = await periodsOfSchedule(c, id)
    const keep = new Set(periods.map((p) => p.sequence))
    const gone = before.filter((p) => !keep.has(p.sequence))
    await guardAttendance(c, gone.map((p) => p.id))
    // The lessons of the classes on this schedule, matched to the new day by sequence.
    const target = periods.map((p) => ({ id: before.find((b) => b.sequence === p.sequence)?.id ?? '', sequence: p.sequence, is_break: p.is_break }))
    const moved = await remap(c, await sectionsOn(c, id), target.filter((t) => t.id !== ''), new Set(before.map((p) => p.id)))
    dropped = moved.dropped
    const inst = instId(c), campus = await ensureCampus(c)
    stmts.push(...moved.stmts)
    for (const g of gone) stmts.push(c.db.prepare(`DELETE FROM periods WHERE id = ?`).bind(g.id))
    stmts.push(...periodRows(c, inst, campus, id, periods))
  }
  if (dropped.length > 0 && req.confirm !== true) throw refusedDrop(dropped)
  try {
    await batch(c, stmts)
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, `there are already timings called ${name}`)
    throw e
  }
  return ok({ id, dropped: dropped.length })
}

async function deleteSchedule(c: Ctx): Promise<Response> {
  const id = uuidParam(c.params.id)
  const head = await scheduleHead(c, id)
  if (head.is_default) throw badRequest('the school day cannot be deleted. Edit it on the setup step instead')
  const confirm = c.url.searchParams.get('confirm') === '1'
  // Its classes go back to the school day; their lessons follow by sequence.
  const affected = await sectionsOn(c, id)
  const schoolDay = await periodsOfSchedule(c, await defaultScheduleId(c))
  const own = await periodsOfSchedule(c, id)
  const moved = await remap(c, affected, schoolDay)
  if (moved.dropped.length > 0 && !confirm) throw refusedDrop(moved.dropped)
  // Attendance marked in its periods moves to the school day's period of the same place; a place the school day lacks keeps the schedule.
  const bySeq = new Map(schoolDay.map((p) => [p.sequence, p.id]))
  await guardAttendance(c, own.filter((p) => !bySeq.has(p.sequence)).map((p) => p.id))
  const stmts = [...moved.stmts]
  for (const p of own) {
    const to = bySeq.get(p.sequence)
    if (to) stmts.push(c.db.prepare(`UPDATE OR IGNORE student_attendance SET period_id = ? WHERE period_id = ?`).bind(to, p.id))
  }
  stmts.push(
    c.db.prepare(`UPDATE classes SET bell_schedule_id = NULL WHERE bell_schedule_id = ?`).bind(id),
    c.db.prepare(`UPDATE sections SET bell_schedule_id = NULL WHERE bell_schedule_id = ?`).bind(id),
    c.db.prepare(`DELETE FROM bell_schedules WHERE id = ?`).bind(id),
  )
  await batch(c, stmts)
  return ok({ id, deleted: true, dropped: moved.dropped.length })
}

async function assignSchedule(c: Ctx): Promise<Response> {
  const req = await readJSON<Record<string, unknown>>(c.req)
  const classId = str(req.class_id), sectionId = str(req.section_id)
  if (!isUUID(classId) === !isUUID(sectionId)) throw badRequest('name one class_id or one section_id')
  const raw = req.bell_schedule_id
  const sched = raw === null || raw === undefined || raw === '' ? null : str(raw)
  if (sched !== null) {
    if (!isUUID(sched)) throw badRequest('bell_schedule_id must be a uuid')
    await scheduleHead(c, sched)
  }
  const table = sectionId ? 'sections' : 'classes'
  const target = sectionId || classId
  const exists = await c.db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`).bind(target).first()
  if (!exists) throw notFound(sectionId ? 'that section no longer exists' : 'that class no longer exists')
  // Which sections this touches, and the schedule each will run to afterwards.
  const affected = sectionId
    ? [sectionId]
    : (await all<{ id: string }>(c.db.prepare(`SELECT id FROM sections WHERE class_id = ? AND bell_schedule_id IS NULL`).bind(classId))).map((r) => r.id)
  const write = c.db.prepare(`UPDATE ${table} SET bell_schedule_id = ? WHERE id = ?`).bind(sched, target)
  let after: string | null = sched
  if (after === null) {
    // Back to the school day, or (for a section) to its class's timings.
    const r = sectionId
      ? await c.db.prepare(`SELECT COALESCE((SELECT cl.bell_schedule_id FROM classes cl WHERE cl.id = s.class_id), ${DEFAULT_SCHEDULE_SQL}) AS id FROM sections s WHERE s.id = ?`).bind(sectionId).first<{ id: string | null }>()
      : await c.db.prepare(`SELECT ${DEFAULT_SCHEDULE_SQL} AS id`).first<{ id: string | null }>()
    after = r?.id ?? null
  }
  const periods = await periodsOfSchedule(c, after)
  if (periods.length === 0) throw badRequest('those timings have no periods yet')
  const moved = await remap(c, affected, periods)
  if (moved.dropped.length > 0 && req.confirm !== true) throw refusedDrop(moved.dropped)
  await batch(c, [write, ...moved.stmts])
  return ok({ updated: true, sections: affected.length, dropped: moved.dropped.length })
}

export function registerBellSchedules(r: Router): void {
  r.get('/setup/bell-schedules', READ, listSchedules)
  r.post('/setup/bell-schedules', WRITE, createSchedule)
  r.put('/setup/bell-schedules/assign', WRITE, assignSchedule)
  r.put('/setup/bell-schedules/{id}', WRITE, updateSchedule)
  r.del('/setup/bell-schedules/{id}', WRITE, deleteSchedule)
}
