import type { Ctx } from '../../router'
import { all } from './common'

/* WHICH BELL A CLASS RUNS TO (owner, 2026-10-13: "let them edit the timings
   per class while creating a timetable").

   One rule, read in one place:

     the section's own schedule, else its class's, else the school day.

   "The school day" is the default bell schedule: the one marked is_default,
   else the oldest, which is the one PUT /setup/periods has always edited.
   A schedule left with no periods is treated as not set, so a half-made
   schedule never empties a class's timetable.

   Every screen that lists a class's periods -- the grid, the generator, the
   teacher's day, the child's week -- asks here. A school with one bell gets
   exactly the periods it always got. */

export interface BellPeriod {
  id: string; name: string; sequence: number; starts_at: string; ends_at: string; is_break: boolean; bell_schedule_id: string
}

/** The school day's schedule id, as SQL. */
export const DEFAULT_SCHEDULE_SQL = `(SELECT b.id FROM bell_schedules b ORDER BY b.is_default DESC, b.created_at LIMIT 1)`

/** The schedule a section runs to, as SQL. `s` is an alias of sections. Ignores a schedule with no periods. */
export const sectionScheduleSQL = (s: string) => `COALESCE(
  (SELECT ${s}.bell_schedule_id WHERE EXISTS (SELECT 1 FROM periods bp WHERE bp.bell_schedule_id = ${s}.bell_schedule_id)),
  (SELECT bc.bell_schedule_id FROM classes bc WHERE bc.id = ${s}.class_id
      AND EXISTS (SELECT 1 FROM periods bp WHERE bp.bell_schedule_id = bc.bell_schedule_id)),
  ${DEFAULT_SCHEDULE_SQL})`

/** The schedule a class runs to (its sections may still have their own), as SQL. `cl` is an alias of classes. */
export const classScheduleSQL = (cl: string) => `COALESCE(
  (SELECT ${cl}.bell_schedule_id WHERE EXISTS (SELECT 1 FROM periods bp WHERE bp.bell_schedule_id = ${cl}.bell_schedule_id)),
  ${DEFAULT_SCHEDULE_SQL})`

type Row = { id: string; name: string; sequence: number; starts_at: string | null; ends_at: string | null; is_break: number; bell_schedule_id: string }
const shape = (p: Row): BellPeriod => ({
  id: p.id, name: p.name, sequence: p.sequence, starts_at: (p.starts_at ?? '').slice(0, 5), ends_at: (p.ends_at ?? '').slice(0, 5),
  is_break: !!p.is_break, bell_schedule_id: p.bell_schedule_id,
})
const PERIOD_COLS = `p.id, p.name, p.sequence, p.starts_at, p.ends_at, p.is_break, p.bell_schedule_id`

export async function defaultScheduleId(c: Ctx): Promise<string | null> {
  const r = await c.db.prepare(`SELECT ${DEFAULT_SCHEDULE_SQL} AS id`).first<{ id: string | null }>()
  return r?.id ?? null
}

/** One schedule's periods, in order. */
export async function periodsOfSchedule(c: Ctx, scheduleId: string | null): Promise<BellPeriod[]> {
  if (!scheduleId) return []
  return (await all<Row>(c.db.prepare(`SELECT ${PERIOD_COLS} FROM periods p WHERE p.bell_schedule_id = ? ORDER BY p.sequence`).bind(scheduleId))).map(shape)
}

/** The school day's periods. A school with periods but no schedule row at all (never seen, but cheap) gets every period. */
export async function schoolDayPeriods(c: Ctx): Promise<BellPeriod[]> {
  const id = await defaultScheduleId(c)
  if (id) return periodsOfSchedule(c, id)
  return (await all<Row>(c.db.prepare(`SELECT ${PERIOD_COLS} FROM periods p ORDER BY p.sequence`))).map(shape)
}

/** Every period of every schedule, schedule by schedule. */
export async function allPeriods(c: Ctx): Promise<BellPeriod[]> {
  return (await all<Row>(c.db.prepare(`SELECT ${PERIOD_COLS} FROM periods p ORDER BY p.sequence, p.bell_schedule_id`))).map(shape)
}

export async function scheduleOfSection(c: Ctx, sectionId: string): Promise<string | null> {
  const r = await c.db.prepare(`SELECT ${sectionScheduleSQL('s')} AS id FROM sections s WHERE s.id = ?`).bind(sectionId).first<{ id: string | null }>()
  return r ? r.id : defaultScheduleId(c)
}

export async function scheduleOfClass(c: Ctx, classId: string): Promise<string | null> {
  const r = await c.db.prepare(`SELECT ${classScheduleSQL('cl')} AS id FROM classes cl WHERE cl.id = ?`).bind(classId).first<{ id: string | null }>()
  return r ? r.id : defaultScheduleId(c)
}

/** The periods a section's timetable is laid on. */
export async function periodsForSection(c: Ctx, sectionId: string): Promise<BellPeriod[]> {
  return periodsOfSchedule(c, await scheduleOfSection(c, sectionId))
}

/** Section id to schedule id, for every section of a year (or every section). */
export async function sectionSchedules(c: Ctx, year?: string | null): Promise<Map<string, string>> {
  const rows = await all<{ id: string; sched: string | null }>(c.db.prepare(
    `SELECT s.id, ${sectionScheduleSQL('s')} AS sched FROM sections s WHERE (?1 IS NULL OR s.academic_year_id = ?1)`).bind(year ?? null))
  const out = new Map<string, string>()
  for (const r of rows) if (r.sched) out.set(r.id, r.sched)
  return out
}

/** Each schedule's periods, keyed by schedule id. */
export async function periodsBySchedule(c: Ctx): Promise<Map<string, BellPeriod[]>> {
  const out = new Map<string, BellPeriod[]>()
  for (const p of await allPeriods(c)) {
    const list = out.get(p.bell_schedule_id) ?? []
    list.push(p)
    out.set(p.bell_schedule_id, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.sequence - b.sequence)
  return out
}

/** The periods of OTHER schedules that overlap each period in time. Empty when the school runs one bell. */
export function crossScheduleOverlaps(periods: BellPeriod[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const schedules = new Set(periods.map((p) => p.bell_schedule_id))
  if (schedules.size < 2) return out
  for (const p of periods) {
    const hits = [p.id]
    for (const q of periods) {
      if (q.bell_schedule_id === p.bell_schedule_id) continue
      if (q.starts_at < p.ends_at && p.starts_at < q.ends_at) hits.push(q.id)
    }
    out.set(p.id, hits)
  }
  return out
}

/** What a grid screen needs to draw each class on its own bell: every schedule with its periods, and which one each section runs to. */
export async function scheduleBundle(c: Ctx, year?: string | null): Promise<{
  schedules: { id: string; name: string; is_default: boolean; periods: BellPeriod[] }[]
  section_schedules: Record<string, string>
}> {
  const heads = await all<{ id: string; name: string; is_default: number }>(c.db.prepare(
    `SELECT b.id, b.name, (b.id = ${DEFAULT_SCHEDULE_SQL}) AS is_default FROM bell_schedules b ORDER BY (b.id = ${DEFAULT_SCHEDULE_SQL}) DESC, b.name`))
  const by = await periodsBySchedule(c)
  return {
    schedules: heads.map((h) => ({ id: h.id, name: h.name, is_default: !!h.is_default, periods: by.get(h.id) ?? [] })),
    section_schedules: Object.fromEntries(await sectionSchedules(c, year)),
  }
}
