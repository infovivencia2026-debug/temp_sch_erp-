import type { Ctx, Router } from '../../router'
import { badRequest, isUUID, notFound, ok, readJSON, uuid } from '../../http'
import { all, alsoNeeds, campusReach, coded, denied, instId, reachAllows, trimStr, uuidOr400 } from './common'
import { TEACHING_WEEKDAYS, resolveYear } from './tt_shared'
import { sectionScheduleSQL } from './bell'
import { auditStmt } from '../admin/common'
import { publishTopic } from '../../services/live'

/* The live timetable, edited one cell at a time (owner, 2026-10-28: "In
   Master timetable I should be able to edit the one I uploaded ... class-wise
   with a filter, and staff-wise too").

   Drafts stay the way a whole new timetable is made. These routes change the
   grid that is in use now: timetable_entries. Every write is checked here
   before it is made -- the section's slot, the teacher's slot at the same
   time on any bell, a break, the class's own timings -- and the refusal names
   the class and subject in the way. The teacher-slot trigger (0121) and the
   section-slot unique index stay behind the checks. A combined class (one
   teacher, the same subject, two sections at once) is allowed, as 0121 says.

   A cleared period takes its cover with it: its substitutions and open cover
   requests are deleted in the same batch, so the cover board never points at
   a period that no longer exists. A period whose teacher changes loses its
   cover from today on, which was arranged for the teacher who is no longer
   there. Every write is in audit_log and hints the 'timetable' topic, so open
   timetables refetch. */

const READ = 'academics.timetable.read'
const WRITE = 'academics.timetable.write'

const SAME_TIME = `(SELECT q.id FROM periods q, periods me WHERE me.id = ?
  AND (q.id = me.id OR (q.bell_schedule_id <> me.bell_schedule_id AND q.starts_at < me.ends_at AND me.starts_at < q.ends_at)))`

const ENTRY_SELECT = `
  SELECT te.id, te.section_id, sec.name AS section_name, cl.name AS class_name, te.period_id, p.name AS period_name,
         te.weekday, te.class_subject_id, sub.name AS subject_name, te.teacher_user_id AS teacher_id, u.full_name AS teacher_name, te.room
    FROM timetable_entries te
    JOIN sections sec ON sec.id = te.section_id
    JOIN classes cl ON cl.id = sec.class_id
    JOIN periods p ON p.id = te.period_id
    JOIN class_subjects cs ON cs.id = te.class_subject_id
    JOIN subjects sub ON sub.id = cs.subject_id
    LEFT JOIN users u ON u.id = te.teacher_user_id`

interface EntryRow {
  id: string; section_id: string; section_name: string; class_name: string; period_id: string; period_name: string
  weekday: number; class_subject_id: string; subject_name: string; teacher_id: string | null; teacher_name: string | null; room: string | null
}

const label = (r: { class_name: string; section_name: string }) => `${r.class_name} ${r.section_name}`.trim()

async function readLive(c: Ctx): Promise<Response> {
  const q = c.url.searchParams
  const section = q.get('section_id') ?? ''
  const teacher = q.get('teacher_id') ?? ''
  if (!section && !teacher) throw badRequest('give section_id or teacher_id')
  if (section && !isUUID(section)) throw badRequest('section_id must be a uuid')
  if (teacher && !isUUID(teacher)) throw badRequest('teacher_id must be a uuid')
  const year = await resolveYear(c, q.get('academic_year_id') ?? '', 'no academic year')
  const rows = await all<EntryRow>(c.db.prepare(`${ENTRY_SELECT}
      WHERE te.academic_year_id = ?1 AND (?2 = '' OR te.section_id = ?2) AND (?3 = '' OR te.teacher_user_id = ?3)
      ORDER BY te.weekday, p.starts_at, cl.name, sec.name`).bind(year, section, teacher))
  return ok({ academic_year_id: year, items: rows })
}

/* What a cell's dialog needs: the class's subjects, every teacher, and who
   is already teaching at that time (so a busy teacher shows where). */
async function readSlot(c: Ctx): Promise<Response> {
  const q = c.url.searchParams
  const periodRaw = q.get('period_id') ?? ''
  const period = periodRaw === '' ? '' : uuidOr400(periodRaw, 'period_id')
  const weekday = Number(q.get('weekday'))
  if (period !== '' && !TEACHING_WEEKDAYS.includes(weekday)) throw badRequest('weekday must be 1 (Monday) to 6 (Saturday)')
  const section = q.get('section_id') ?? ''
  if (section && !isUUID(section)) throw badRequest('section_id must be a uuid')
  const year = await resolveYear(c, q.get('academic_year_id') ?? '', 'no academic year')
  const busy = period === '' ? [] : await all<EntryRow>(c.db.prepare(`${ENTRY_SELECT}
      WHERE te.academic_year_id = ? AND te.weekday = ? AND te.period_id IN ${SAME_TIME} ORDER BY cl.name, sec.name`).bind(year, weekday, period))
  const subjects = section
    ? await all<{ id: string; name: string }>(c.db.prepare(`SELECT cs.id, sub.name FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id
        JOIN sections sec ON sec.class_id = cs.class_id WHERE sec.id = ? ORDER BY sub.name`).bind(section))
    : []
  const teachers = await all<{ id: string; name: string }>(c.db.prepare(`SELECT DISTINCT u.id, u.full_name AS name FROM employees e JOIN users u ON u.id = e.user_id
      WHERE e.status = 'active' AND u.status = 'active' ORDER BY u.full_name`))
  return ok({ busy, subjects, teachers })
}

async function saveCell(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const entryID = req.entry_id === undefined || req.entry_id === null || req.entry_id === '' ? null : trimStr(req.entry_id)
  if (entryID !== null && !isUUID(entryID)) throw badRequest('entry_id must be a uuid')
  const sectionID = trimStr(req.section_id), periodID = trimStr(req.period_id), csID = trimStr(req.class_subject_id)
  if (!isUUID(sectionID)) throw badRequest('section_id must be a uuid')
  if (!isUUID(periodID)) throw badRequest('period_id must be a uuid')
  if (!isUUID(csID)) throw badRequest('choose a subject')
  const weekday = Number(req.weekday)
  if (!TEACHING_WEEKDAYS.includes(weekday)) throw badRequest('weekday must be 1 (Monday) to 6 (Saturday)')
  const tRaw = req.teacher_id === undefined || req.teacher_id === null ? '' : trimStr(req.teacher_id)
  if (tRaw !== '' && !isUUID(tRaw)) throw badRequest('teacher_id must be a uuid')
  const teacher = tRaw === '' ? null : tRaw
  const roomRaw = typeof req.room === 'string' ? req.room.trim() : ''
  if (roomRaw.length > 60) throw badRequest('room is at most 60 characters')
  const room = roomRaw === '' ? null : roomRaw

  const sec = await c.db.prepare(`SELECT sec.id, sec.name AS section_name, cl.name AS class_name, sec.campus_id, sec.academic_year_id
      FROM sections sec JOIN classes cl ON cl.id = sec.class_id WHERE sec.id = ?`).bind(sectionID)
    .first<{ section_name: string; class_name: string; campus_id: string | null; academic_year_id: string }>()
  if (!sec) throw notFound()
  if (!reachAllows(await campusReach(c), sec.campus_id)) throw denied('that class belongs to a campus you are not posted to')
  const year = sec.academic_year_id

  const before = entryID ? await c.db.prepare(`${ENTRY_SELECT} WHERE te.id = ?`).bind(entryID).first<EntryRow>() : null
  if (entryID && !before) throw notFound()

  const offered = await c.db.prepare(`SELECT 1 AS x FROM class_subjects cs JOIN sections sec ON sec.class_id = cs.class_id WHERE cs.id = ? AND sec.id = ?`)
    .bind(csID, sectionID).first()
  if (!offered) throw badRequest('that subject is not taught to this class')
  const period = await c.db.prepare(`SELECT is_break FROM periods WHERE id = ?`).bind(periodID).first<{ is_break: number }>()
  if (!period) throw notFound()
  if (period.is_break) throw badRequest('that period is a break, not a teaching period')
  const ownBell = await c.db.prepare(`SELECT (p.bell_schedule_id = ${sectionScheduleSQL('s')}) AS ok FROM periods p, sections s WHERE p.id = ? AND s.id = ?`)
    .bind(periodID, sectionID).first<{ ok: number }>()
  if (!ownBell?.ok) throw badRequest("that period is not in this class's timings")

  const self = entryID ?? '00000000-0000-0000-0000-000000000000'
  const taken = await c.db.prepare(`${ENTRY_SELECT} WHERE te.section_id = ? AND te.weekday = ? AND te.period_id = ? AND te.id <> ?`)
    .bind(sectionID, weekday, periodID, self).first<EntryRow>()
  if (taken) {
    throw coded(409, 'section_busy', `${label(sec)} already has ${taken.subject_name}${taken.teacher_name ? ` with ${taken.teacher_name}` : ''} in that period. Edit that period instead.`)
  }
  if (teacher !== null) {
    const clash = await c.db.prepare(`${ENTRY_SELECT}
        WHERE te.academic_year_id = ? AND te.teacher_user_id = ? AND te.weekday = ? AND te.period_id IN ${SAME_TIME} AND te.id <> ?
          AND cs.subject_id <> (SELECT subject_id FROM class_subjects WHERE id = ?) LIMIT 1`)
      .bind(year, teacher, weekday, periodID, self, csID).first<EntryRow>()
    if (clash) {
      throw coded(409, 'teacher_busy', `${clash.teacher_name ?? 'That teacher'} is already teaching ${clash.subject_name} to ${label(clash)} in that period.`)
    }
  }

  const id = entryID ?? uuid()
  const write = entryID === null
    ? c.db.prepare(`INSERT INTO timetable_entries (id, institution_id, academic_year_id, section_id, period_id, weekday, class_subject_id, teacher_user_id, room)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, inst, year, sectionID, periodID, weekday, csID, teacher, room)
    : c.db.prepare(`UPDATE timetable_entries SET section_id = ?, period_id = ?, weekday = ?, class_subject_id = ?, teacher_user_id = ?, room = ? WHERE id = ?`)
      .bind(sectionID, periodID, weekday, csID, teacher, room, id)
  const stmts: D1PreparedStatement[] = [write]
  // Cover arranged for whoever taught it before no longer fits a changed period.
  const moved = before && (before.teacher_id !== teacher || before.period_id !== periodID || before.weekday !== weekday || before.section_id !== sectionID)
  if (moved) stmts.push(...dropCover(c, id, true))
  const after = { section_id: sectionID, period_id: periodID, weekday, class_subject_id: csID, teacher_id: teacher, room }
  stmts.push(auditStmt(c, before ? 'timetable.entry.update' : 'timetable.entry.create', 'timetable_entry', id, before, after))
  try {
    await c.db.batch(stmts)
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw /teacher_user_id/.test(e.message)
        ? coded(409, 'teacher_busy', 'that teacher is already teaching another subject in that period')
        : coded(409, 'section_busy', `${label(sec)} already has a subject in that period`)
    }
    throw e
  }
  await hint(c, id)
  const out = await c.db.prepare(`${ENTRY_SELECT} WHERE te.id = ?`).bind(id).first<EntryRow>()
  if (!out) throw notFound()
  return ok(out)
}

/** Its cover: every date, or from today on (a changed period keeps its past). */
function dropCover(c: Ctx, entryID: string, fromToday: boolean): D1PreparedStatement[] {
  const today = new Date().toISOString().slice(0, 10)
  const cut = fromToday ? today : '0000-00-00'
  return [
    c.db.prepare(`DELETE FROM substitution_request_periods WHERE timetable_entry_id = ? AND on_date >= ?`).bind(entryID, cut),
    c.db.prepare(`DELETE FROM substitutions WHERE timetable_entry_id = ? AND on_date >= ?`).bind(entryID, cut),
  ]
}

async function clearCell(c: Ctx): Promise<Response> {
  const id = uuidOr400(c.params.id)
  const before = await c.db.prepare(`${ENTRY_SELECT} WHERE te.id = ?`).bind(id).first<EntryRow>()
  if (!before) throw notFound()
  const sec = await c.db.prepare(`SELECT campus_id FROM sections WHERE id = ?`).bind(before.section_id).first<{ campus_id: string | null }>()
  if (!reachAllows(await campusReach(c), sec?.campus_id ?? null)) throw denied('that class belongs to a campus you are not posted to')
  await c.db.batch([
    ...dropCover(c, id, false),
    c.db.prepare(`DELETE FROM timetable_entries WHERE id = ?`).bind(id),
    auditStmt(c, 'timetable.entry.delete', 'timetable_entry', id, before, null),
  ])
  await hint(c, id)
  return ok({ removed: true })
}

const hint = (c: Ctx, entry: string) =>
  publishTopic(c.env, c.id.institution?.id, { topic: 'timetable', type: 'timetable', keys: { entry } })

export function registerLiveEdit(r: Router): void {
  r.get('/master-timetable/live', READ, readLive)
  r.get('/master-timetable/live/slot', READ, readSlot)
  r.put('/master-timetable/live/cell', WRITE, alsoNeeds(READ, saveCell))
  r.del('/master-timetable/live/entries/{id}', WRITE, alsoNeeds(READ, clearCell))
}
