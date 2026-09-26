import type { Ctx, Router } from '../../router'
import { badRequest, isUUID, notFound, ok, readJSON, uuid } from '../../http'
import { all, alsoNeeds, campusReach, coded, denied, has, instId, nowISO, reachAllows, trimStr, uuidOr400, type CampusReach } from './common'
import {
  DRAFT_ENTRY_SELECT, DRAFT_SELECT, TEACHING_WEEKDAYS, draftEntryJSON, draftJSON, guardStmt, isGuardFailure, loadDraftIssues, loadPeriods,
  resolveYear, teachingCount, type DraftDbRow, type DraftEntryDb,
} from './tt_shared'

/* Port of master_timetable.go: /master-timetable/*, the whole-school desk
   over the draft model, and the hand edit of one draft cell.

   The Go handler checks every constraint inside a transaction holding the
   draft row FOR UPDATE. Here the checks are reads followed by one batch whose
   first statement re-asserts that the draft is still open; the draft's two
   unique indexes (section slot, teacher slot) remain the last line behind
   the checks, exactly as in Go. */

const READ = 'academics.timetable.read'
const WRITE = 'academics.timetable.write'

const outOfReach = () => denied('this draft belongs to a campus you are not posted to')
const draftClosed = () => coded(409, 'draft_closed', 'this draft has been published or discarded and can no longer be edited')
const sectionBusy = () => coded(409, 'section_busy', 'that class is already being taught something else in that period')
const teacherBusy = () => coded(409, 'teacher_busy', 'that teacher is already teaching in that period, here or in a section this draft does not cover')

async function getMasterTimetableOverview(c: Ctx): Promise<Response> {
  const re = await campusReach(c)
  const year = await resolveYear(c, c.url.searchParams.get('academic_year_id') ?? '', 'no academic year')
  const yr = await c.db.prepare(`SELECT name FROM academic_years WHERE id = ?`).bind(year).first<{ name: string }>()
  if (!yr) throw notFound()
  const periods = await loadPeriods(c)
  const drafts = await all<DraftDbRow>(c.db.prepare(`${DRAFT_SELECT} WHERE d.academic_year_id = ? AND d.status = 'draft' ORDER BY d.generated_at DESC`).bind(year))

  // LATERAL (the newest open draft covering each section) becomes a correlated pick of the draft id.
  const rows = await all<{ section_id: string; section_name: string; class_name: string; level: number; campus_id: string | null; required: number
    live: number; live_unstaffed: number; draft_id: string | null; draft_name: string | null; placed: number | null; unstaffed: number | null }>(c.db.prepare(`
    WITH pick AS (
      SELECT sec.id AS section_id,
             (SELECT d.id FROM timetable_drafts d
               WHERE d.status = 'draft' AND d.academic_year_id = ?1
                 AND EXISTS (SELECT 1 FROM timetable_draft_entries de WHERE de.draft_id = d.id AND de.section_id = sec.id)
               ORDER BY d.generated_at DESC LIMIT 1) AS draft_id
        FROM sections sec WHERE sec.academic_year_id = ?1
    )
    SELECT sec.id AS section_id, sec.name AS section_name, c.name AS class_name, c.level, sec.campus_id,
           COALESCE((SELECT sum(cs.periods_per_week) FROM class_subjects cs WHERE cs.class_id = sec.class_id), 0) AS required,
           (SELECT count(*) FROM timetable_entries te WHERE te.section_id = sec.id AND te.academic_year_id = ?1) AS live,
           (SELECT count(*) FROM timetable_entries te WHERE te.section_id = sec.id AND te.academic_year_id = ?1 AND te.teacher_user_id IS NULL) AS live_unstaffed,
           pick.draft_id, d.name AS draft_name,
           (SELECT count(*) FROM timetable_draft_entries de WHERE de.draft_id = pick.draft_id AND de.section_id = sec.id) AS placed,
           (SELECT count(*) FROM timetable_draft_entries de WHERE de.draft_id = pick.draft_id AND de.section_id = sec.id AND de.teacher_user_id IS NULL) AS unstaffed
      FROM sections sec
      JOIN classes c ON c.id = sec.class_id
      JOIN pick ON pick.section_id = sec.id
      LEFT JOIN timetable_drafts d ON d.id = pick.draft_id
     WHERE sec.academic_year_id = ?1
     ORDER BY c.level, sec.name`).bind(year))
  const sections: Record<string, unknown>[] = []
  let required = 0, live = 0, draftPlaced = 0, noGrid = 0, unstaffed = 0
  for (const v of rows) {
    if (!reachAllows(re, v.campus_id) && v.campus_id !== null) continue
    const o: Record<string, unknown> = { section_id: v.section_id, section_name: v.section_name, class_name: v.class_name, level: v.level }
    if (v.campus_id !== null) o.campus_id = v.campus_id
    const dp = v.draft_id ? v.placed ?? 0 : 0, du = v.draft_id ? v.unstaffed ?? 0 : 0
    Object.assign(o, { required_periods: v.required, live_periods: v.live, draft_periods: dp, live_unstaffed: v.live_unstaffed, draft_unstaffed: du })
    if (v.draft_id !== null) o.draft_id = v.draft_id
    if (v.draft_name !== null) o.draft_name = v.draft_name
    sections.push(o)
    required += v.required
    live += v.live
    draftPlaced += dp
    unstaffed += v.live_unstaffed
    if (v.live === 0) noGrid++
  }
  const summary: Record<string, unknown> = {
    sections: sections.length, sections_without_timetable: noGrid, live_periods: live, live_unstaffed: unstaffed,
    draft_periods: draftPlaced, open_drafts: drafts.length,
  }
  if (required > 0) summary.required_periods = required
  return ok({
    academic_year_id: year, academic_year: yr.name, weekdays: TEACHING_WEEKDAYS, periods, sections, open_drafts: drafts.map(draftJSON),
    may_edit: has(c, WRITE), cells_a_week: teachingCount(periods) * TEACHING_WEEKDAYS.length, summary,
  })
}

async function previewMasterPublish(c: Ctx): Promise<Response> {
  const draftID = uuidOr400(c.params.id)
  const re = await campusReach(c)
  const d = await c.db.prepare(`SELECT name, status, academic_year_id, campus_id, blocking_issues FROM timetable_drafts WHERE id = ?`).bind(draftID)
    .first<{ name: string; status: string; academic_year_id: string; campus_id: string | null; blocking_issues: number }>()
  if (!d) throw notFound()
  if (!reachAllows(re, d.campus_id) && d.campus_id !== null) throw outOfReach()
  const impact = await all<{ section_id: string; section_name: string; class_name: string; live_periods_now: number; draft_periods: number; draft_unstaffed: number }>(
    c.db.prepare(`
    SELECT sec.id AS section_id, sec.name AS section_name, c.name AS class_name,
           (SELECT count(*) FROM timetable_entries te WHERE te.section_id = sec.id AND te.academic_year_id = ?2) AS live_periods_now,
           count(*) AS draft_periods,
           sum(CASE WHEN de.teacher_user_id IS NULL THEN 1 ELSE 0 END) AS draft_unstaffed
      FROM timetable_draft_entries de
      JOIN sections sec ON sec.id = de.section_id
      JOIN classes c ON c.id = sec.class_id
     WHERE de.draft_id = ?1
     GROUP BY sec.id, sec.name, c.name, c.level
     ORDER BY c.level, sec.name`).bind(draftID, d.academic_year_id))
  const untouched = await c.db.prepare(`
    SELECT count(DISTINCT te.section_id) AS n FROM timetable_entries te
     WHERE te.academic_year_id = ?2 AND te.section_id NOT IN (SELECT section_id FROM timetable_draft_entries WHERE draft_id = ?1)`)
    .bind(draftID, d.academic_year_id).first<{ n: number }>()
  const clashes = await all<{ teacher_name: string; weekday: number; period_name: string; draft_section: string; live_section: string }>(c.db.prepare(`
    SELECT u.full_name AS teacher_name, de.weekday, p.name AS period_name, dsec.name AS draft_section, lsec.name AS live_section
      FROM timetable_draft_entries de
      JOIN periods p ON p.id = de.period_id
      JOIN sections dsec ON dsec.id = de.section_id
      JOIN users u ON u.id = de.teacher_user_id
      JOIN timetable_entries te ON te.academic_year_id = ?2 AND te.teacher_user_id = de.teacher_user_id
       AND te.weekday = de.weekday AND te.period_id = de.period_id
       AND te.section_id NOT IN (SELECT section_id FROM timetable_draft_entries WHERE draft_id = ?1)
      JOIN sections lsec ON lsec.id = te.section_id
     WHERE de.draft_id = ?1 AND de.teacher_user_id IS NOT NULL
     ORDER BY u.full_name, de.weekday, p.sequence`).bind(draftID, d.academic_year_id))
  const issues = await loadDraftIssues(c, draftID)
  let replaced = 0, writing = 0
  for (const i of impact) { replaced += i.live_periods_now; writing += i.draft_periods }
  return ok({
    draft_id: draftID, draft_name: d.name, status: d.status, publishable: d.status === 'draft', sections: impact, issues,
    blocking_issues: d.blocking_issues, requires_acknowledgement: d.blocking_issues > 0, periods_to_replace: replaced,
    periods_to_write: writing, sections_untouched: untouched?.n ?? 0, teacher_clashes: clashes,
  })
}

/** mdmText: absent leaves the value, an explicit empty string clears it. */
const textOr = (supplied: unknown, current: string | null): string | null => {
  if (supplied === undefined || supplied === null) return current
  const v = String(supplied).trim()
  return v === '' ? null : v
}

/** editMasterDraft: one path for a new cell and a moved one, re-checking every constraint the solver honoured. */
async function editMasterDraft(c: Ctx, entryID: string | null): Promise<Response> {
  const inst = instId(c)
  const draftID = uuidOr400(c.params.id)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const re: CampusReach = await campusReach(c)
  const d = await c.db.prepare(`SELECT status, academic_year_id, campus_id FROM timetable_drafts WHERE id = ?`).bind(draftID)
    .first<{ status: string; academic_year_id: string; campus_id: string | null }>()
  if (!d) throw notFound()
  if (!reachAllows(re, d.campus_id) && d.campus_id !== null) throw outOfReach()
  if (d.status !== 'draft') throw draftClosed()

  let sectionID: string, classSubjectID: string, weekday = 0, periodID = '', teacher: string | null = null, room: string | null = null
  if (entryID !== null) {
    const cur = await c.db.prepare(`SELECT section_id, class_subject_id, weekday, period_id, teacher_user_id, room
        FROM timetable_draft_entries WHERE id = ? AND draft_id = ?`).bind(entryID, draftID)
      .first<{ section_id: string; class_subject_id: string; weekday: number; period_id: string; teacher_user_id: string | null; room: string | null }>()
    if (!cur) throw notFound()
    sectionID = cur.section_id; classSubjectID = cur.class_subject_id; weekday = cur.weekday; periodID = cur.period_id
    teacher = cur.teacher_user_id; room = cur.room
  } else {
    sectionID = trimStr(req.section_id)
    if (!isUUID(sectionID)) throw badRequest('section_id must be a uuid')
    classSubjectID = trimStr(req.class_subject_id)
    if (!isUUID(classSubjectID)) throw badRequest('class_subject_id must be a uuid')
    if (req.weekday === undefined || req.weekday === null || req.period_id === undefined || req.period_id === null) {
      throw badRequest('a new period needs a weekday and a period')
    }
  }
  if (req.weekday !== undefined && req.weekday !== null) weekday = Math.trunc(Number(req.weekday))
  if (req.period_id !== undefined && req.period_id !== null) {
    periodID = trimStr(req.period_id)
    if (!isUUID(periodID)) throw badRequest('period_id must be a uuid')
  }
  if (req.teacher_id !== undefined && req.teacher_id !== null) {
    const v = trimStr(req.teacher_id)
    if (v === '') teacher = null
    else if (!isUUID(v)) throw badRequest('teacher_id must be a uuid')
    else teacher = v
  }
  if (req.room !== undefined && req.room !== null) room = textOr(req.room, room)
  if (!TEACHING_WEEKDAYS.includes(weekday)) throw badRequest('weekday must be 1 (Monday) to 6 (Saturday)')

  const self = entryID ?? '00000000-0000-0000-0000-000000000000'
  const offered = await c.db.prepare(`SELECT 1 AS x FROM class_subjects cs JOIN sections sec ON sec.class_id = cs.class_id WHERE cs.id = ? AND sec.id = ?`)
    .bind(classSubjectID, sectionID).first()
  if (!offered) throw badRequest('that subject is not offered to this class')
  const period = await c.db.prepare(`SELECT is_break FROM periods WHERE id = ?`).bind(periodID).first<{ is_break: number }>()
  if (!period) throw notFound()
  if (period.is_break) throw badRequest('that period is a break, not a teaching period')
  const secBusy = await c.db.prepare(`SELECT 1 AS x FROM timetable_draft_entries WHERE draft_id = ? AND section_id = ? AND weekday = ? AND period_id = ? AND id <> ?`)
    .bind(draftID, sectionID, weekday, periodID, self).first()
  if (secBusy) throw sectionBusy()

  if (teacher !== null) {
    const inDraft = await c.db.prepare(`SELECT 1 AS x FROM timetable_draft_entries WHERE draft_id = ? AND teacher_user_id = ? AND weekday = ? AND period_id = ? AND id <> ?`)
      .bind(draftID, teacher, weekday, periodID, self).first()
    if (inDraft) throw teacherBusy()
    const inLive = await c.db.prepare(`SELECT 1 AS x FROM timetable_entries te WHERE te.academic_year_id = ? AND te.teacher_user_id = ? AND te.weekday = ? AND te.period_id = ?
        AND te.section_id NOT IN (SELECT section_id FROM timetable_draft_entries WHERE draft_id = ?)`)
      .bind(d.academic_year_id, teacher, weekday, periodID, draftID).first()
    if (inLive) throw teacherBusy()
    const unavailable = await c.db.prepare(`SELECT 1 AS x FROM teacher_unavailability WHERE teacher_user_id = ? AND weekday = ? AND (period_id IS NULL OR period_id = ?)`)
      .bind(teacher, weekday, periodID).first()
    if (unavailable) throw coded(409, 'teacher_unavailable', 'that teacher is marked unavailable in that slot every week')
    const caps = await c.db.prepare(`SELECT COALESCE(lr.max_periods_per_day, 6) AS max_day, COALESCE(lr.max_periods_per_week, 35) AS max_week
        FROM users u LEFT JOIN teacher_load_rules lr ON lr.teacher_user_id = u.id WHERE u.id = ?`).bind(teacher)
      .first<{ max_day: number; max_week: number }>()
    if (!caps) throw notFound()
    const load = await c.db.prepare(`
      SELECT sum(CASE WHEN weekday = ?3 THEN 1 ELSE 0 END) AS on_day, count(*) AS on_week FROM (
        SELECT de.weekday FROM timetable_draft_entries de WHERE de.draft_id = ?1 AND de.teacher_user_id = ?2 AND de.id <> ?4
        UNION ALL
        SELECT te.weekday FROM timetable_entries te WHERE te.academic_year_id = ?5 AND te.teacher_user_id = ?2
           AND te.section_id NOT IN (SELECT section_id FROM timetable_draft_entries WHERE draft_id = ?1))`)
      .bind(draftID, teacher, weekday, self, d.academic_year_id).first<{ on_day: number | null; on_week: number }>()
    if ((load?.on_day ?? 0) + 1 > caps.max_day) throw coded(409, 'teacher_day_cap', 'that would put the teacher over their maximum periods for the day')
    if ((load?.on_week ?? 0) + 1 > caps.max_week) throw coded(409, 'teacher_week_cap', 'that would put the teacher over their maximum periods for the week')
  }

  const id = entryID ?? uuid()
  const write = entryID === null
    ? c.db.prepare(`INSERT INTO timetable_draft_entries (id, institution_id, draft_id, section_id, period_id, weekday, class_subject_id, teacher_user_id, room)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, inst, draftID, sectionID, periodID, weekday, classSubjectID, teacher, room)
    : c.db.prepare(`UPDATE timetable_draft_entries SET weekday = ?, period_id = ?, teacher_user_id = ?, room = ? WHERE id = ?`)
      .bind(weekday, periodID, teacher, room, id)
  try {
    await c.db.batch([
      guardStmt(c, `(SELECT status FROM timetable_drafts WHERE id = ?) = 'draft'`, [draftID]),
      write,
      markHandEdited(c, draftID),
    ])
  } catch (e) {
    if (isGuardFailure(e)) throw draftClosed()
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw /teacher_user_id/.test(e.message) ? teacherBusy() : sectionBusy()
    }
    throw e
  }
  const out = await c.db.prepare(`${DRAFT_ENTRY_SELECT} WHERE de.id = ?`).bind(id).first<DraftEntryDb>()
  if (!out) throw notFound()
  return ok(draftEntryJSON(out))
}

const markHandEdited = (c: Ctx, draftID: string) =>
  c.db.prepare(`UPDATE timetable_drafts SET hand_edits = hand_edits + 1, last_edited_at = ?, last_edited_by = ? WHERE id = ?`)
    .bind(nowISO(), c.id.platformAdmin ? null : c.id.userId, draftID)

async function clearMasterDraftPeriod(c: Ctx): Promise<Response> {
  const draftID = uuidOr400(c.params.id)
  const entryID = uuidOr400(c.params.entryID, 'entryID')
  const re = await campusReach(c)
  const d = await c.db.prepare(`SELECT status, campus_id FROM timetable_drafts WHERE id = ?`).bind(draftID).first<{ status: string; campus_id: string | null }>()
  if (!d) throw notFound()
  if (!reachAllows(re, d.campus_id) && d.campus_id !== null) throw outOfReach()
  if (d.status !== 'draft') throw draftClosed()
  let res: D1Result[]
  try {
    res = await c.db.batch([
      guardStmt(c, `(SELECT status FROM timetable_drafts WHERE id = ?) = 'draft'`, [draftID]),
      c.db.prepare(`DELETE FROM timetable_draft_entries WHERE id = ? AND draft_id = ?`).bind(entryID, draftID),
      c.db.prepare(`UPDATE timetable_drafts SET hand_edits = hand_edits + 1, last_edited_at = ?, last_edited_by = ?
          WHERE id = ? AND changes() > 0`).bind(nowISO(), c.id.platformAdmin ? null : c.id.userId, draftID),
    ])
  } catch (e) {
    if (isGuardFailure(e)) throw draftClosed()
    throw e
  }
  if (!res[1].meta.changes) throw notFound()
  return ok({ removed: true })
}

export function registerMaster(r: Router): void {
  r.get('/master-timetable/overview', READ, getMasterTimetableOverview)
  r.get('/master-timetable/drafts/{id}/publish-preview', READ, previewMasterPublish)
  r.post('/master-timetable/drafts/{id}/entries', WRITE, alsoNeeds(READ, (c) => editMasterDraft(c, null)))
  r.put('/master-timetable/drafts/{id}/entries/{entryID}', WRITE, alsoNeeds(READ, (c) => {
    const entryID = c.params.entryID
    if (!isUUID(entryID)) throw badRequest('entryID must be a uuid')
    return editMasterDraft(c, entryID)
  }))
  r.del('/master-timetable/drafts/{id}/entries/{entryID}', WRITE, alsoNeeds(READ, clearMasterDraftPeriod))
}
