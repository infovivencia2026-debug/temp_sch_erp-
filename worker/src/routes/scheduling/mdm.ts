import type { Ctx, Router } from '../../router'
import { badRequest, isUUID, notFound, ok, readJSON, uuid } from '../../http'
import {
  all, alsoNeeds, campusReach, coded, denied, indiaWall, instId, isDate, isUniqueViolation, nowISO, nullStr, reachAllows, reachFilter, trimStr,
  utcSeconds, uuidOr400,
} from './common'
import { guardStmt, isGuardFailure } from './tt_shared'

/* Port of mdm.go: /mdm-register/*, the daily cooked-meal register.

   Postgres enforced two things this schema no longer does: the CHECK that a
   line serves no more meals than it had children, and the non-negative
   counts. Both are checked here before anything is written, with the
   sentences mdmPgError mapped them to. The one-day-per-campus rule is still
   a unique index (mdm_registers_one_per_day) and is mapped the same way. */

const READ = 'admin.reports.read'
const WRITE = 'institution.write'

const outOfReach = () => denied('this register belongs to a campus you are not posted to')
const closedErr = () => coded(409, 'register_closed', 'this day has been closed; reopen it with a reason before correcting it')
const noReason = () => coded(409, 'reason_required', 'say why no meal was served, or why this day is being corrected')
const lineSum = () => badRequest('a section cannot be served more meals than it had children present')

interface RegisterDb {
  id: string; on_date: string; campus_id: string | null; campus_name: string | null; enrolled: number; present: number; meals_served: number
  rice_kg: string | null; cost_paise: number; menu: string | null; cook_name: string | null; not_served_reason: string | null; status: string
  closed_at: string | null; closed_by: string | null; recorded_by: string | null; line_count: number; amendment_count: number
}

const REGISTER_SELECT = `
  SELECT m.id, m.on_date, m.campus_id, cp.name AS campus_name, m.enrolled, m.present, m.meals_served, m.rice_kg, m.cost_paise, m.menu,
         m.cook_name, m.not_served_reason, m.status, m.closed_at, cu.full_name AS closed_by, ru.full_name AS recorded_by,
         (SELECT count(*) FROM mdm_register_lines l WHERE l.register_id = m.id) AS line_count,
         (SELECT count(*) FROM mdm_register_amendments a WHERE a.register_id = m.id) AS amendment_count
    FROM mdm_registers m
    LEFT JOIN campuses cp ON cp.id = m.campus_id
    LEFT JOIN users cu ON cu.id = m.closed_by
    LEFT JOIN users ru ON ru.id = m.recorded_by`

/** mdmDayIssues: the utilisation return's own checks, on one day. */
function dayIssues(v: { meals_served: number; present: number; enrolled: number; cost_paise: number; rice: number | null; not_served_reason: string | null }): string[] {
  const out: string[] = []
  if (v.meals_served > v.present && v.present > 0) out.push('more meals served than children present')
  if (v.meals_served > v.enrolled && v.enrolled > 0) out.push('more meals served than children on roll')
  if (v.meals_served > 0 && v.cost_paise === 0) out.push('meals served with no cooking cost recorded')
  if (v.meals_served > 0 && (v.rice === null || v.rice === 0)) out.push('meals served with no foodgrain recorded')
  if (v.meals_served === 0 && (v.not_served_reason === null || v.not_served_reason.trim() === '')) out.push('no meal served and no reason recorded')
  return out
}

function registerJSON(v: RegisterDb, lines?: unknown[], amendments?: unknown[]): Record<string, unknown> {
  const rice = v.rice_kg === null ? null : Number(v.rice_kg)
  const o: Record<string, unknown> = { id: v.id, on_date: v.on_date.slice(0, 10) }
  if (v.campus_id !== null) o.campus_id = v.campus_id
  if (v.campus_name !== null) o.campus_name = v.campus_name
  o.enrolled = v.enrolled
  o.present = v.present
  o.meals_served = v.meals_served
  if (rice !== null) o.rice_kg = rice
  o.cost_paise = Number(v.cost_paise)
  if (v.menu !== null) o.menu = v.menu
  if (v.cook_name !== null) o.cook_name = v.cook_name
  if (v.not_served_reason !== null) o.not_served_reason = v.not_served_reason
  o.status = v.status
  const closed = utcSeconds(v.closed_at)
  if (closed) o.closed_at = closed
  if (v.closed_by !== null) o.closed_by = v.closed_by
  if (v.recorded_by !== null) o.recorded_by = v.recorded_by
  o.line_count = v.line_count
  o.amendment_count = v.amendment_count
  o.issues = dayIssues({ ...v, cost_paise: Number(v.cost_paise), rice })
  if (lines && lines.length) o.lines = lines
  if (amendments && amendments.length) o.amendments = amendments
  return o
}

async function loadLines(c: Ctx, dayID: string) {
  return all<{ section_id: string; section_name: string; class_name: string; present: number; meals_served: number }>(c.db.prepare(`
    SELECT l.section_id, sec.name AS section_name, c.name AS class_name, l.present, l.meals_served
      FROM mdm_register_lines l JOIN sections sec ON sec.id = l.section_id JOIN classes c ON c.id = sec.class_id
     WHERE l.register_id = ? ORDER BY c.level, sec.name`).bind(dayID))
}

async function readRegister(c: Ctx, dayID: string): Promise<Record<string, unknown>> {
  const row = await c.db.prepare(`${REGISTER_SELECT} WHERE m.id = ?`).bind(dayID).first<RegisterDb>()
  if (!row) throw notFound()
  return registerJSON(row, await loadLines(c, dayID))
}

/** aoMonth: YYYY-MM, or last month when absent. */
function aoMonth(v: string): { first: string; last: string } {
  v = v.trim()
  let y: number, m: number
  if (v === '') {
    const n = indiaWall()
    y = n.getUTCFullYear(); m = n.getUTCMonth() - 1
    if (m < 0) { m = 11; y-- }
  } else {
    const mm = /^(\d{4})-(\d{2})$/.exec(v)
    if (!mm || Number(mm[2]) < 1 || Number(mm[2]) > 12) throw badRequest('month must be YYYY-MM')
    y = Number(mm[1]); m = Number(mm[2]) - 1
  }
  const first = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
  const last = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10)
  return { first, last }
}

async function listDays(c: Ctx): Promise<Response> {
  const { first, last } = aoMonth(c.url.searchParams.get('month') ?? '')
  const re = await campusReach(c)
  const f = reachFilter(re, 'm.campus_id')
  const rows = await all<RegisterDb>(c.db.prepare(`${REGISTER_SELECT} WHERE m.on_date BETWEEN ? AND ? AND (${f.sql}) ORDER BY m.on_date DESC`)
    .bind(first, last, ...f.args))
  let meals = 0, present = 0, enrolled = 0, served = 0, rice = 0, cost = 0
  for (const d of rows) {
    meals += d.meals_served; present += d.present; enrolled += d.enrolled; cost += Number(d.cost_paise)
    if (d.rice_kg !== null) rice += Number(d.rice_kg)
    if (d.meals_served > 0) served++
  }
  return ok({
    month: first.slice(0, 7), days: rows.map((r) => registerJSON(r)),
    totals: { days_recorded: rows.length, days_meals_served: served, meals_served: meals, present, enrolled, rice_kg: rice, cooking_cost_paise: cost },
  })
}

async function getDay(c: Ctx): Promise<Response> {
  const dayID = uuidOr400(c.params.id)
  const re = await campusReach(c)
  const row = await c.db.prepare(`${REGISTER_SELECT} WHERE m.id = ?`).bind(dayID).first<RegisterDb>()
  if (!row) throw notFound()
  if (!reachAllows(re, row.campus_id)) throw outOfReach()
  const lines = await loadLines(c, dayID)
  const am = await all<{ action: string; reason: string; by: string | null; at: string; before: string | null; after: string | null }>(c.db.prepare(`
    SELECT a.action, a.reason, u.full_name AS by, a.amended_at AS at, a.before, a.after
      FROM mdm_register_amendments a LEFT JOIN users u ON u.id = a.amended_by
     WHERE a.register_id = ? ORDER BY a.amended_at DESC`).bind(dayID))
  const amendments = am.map((a) => {
    const o: Record<string, unknown> = { action: a.action, reason: a.reason }
    if (a.by !== null) o.amended_by = a.by
    o.amended_at = utcSeconds(a.at) ?? ''
    if (a.before !== null) o.before = a.before
    if (a.after !== null) o.after = a.after
    return o
  })
  return ok(registerJSON(row, lines, amendments))
}

async function getContext(c: Ctx): Promise<Response> {
  const re = await campusReach(c)
  const f = reachFilter(re, 'cp.id')
  const campuses = await all<{ id: string; name: string }>(c.db.prepare(`SELECT id, name FROM campuses cp WHERE ${f.sql} ORDER BY name`).bind(...f.args))
  const secs = await all<{ id: string; name: string; class_name: string; campus_id: string | null; strength: number }>(c.db.prepare(`
    SELECT sec.id, sec.name, c.name AS class_name, sec.campus_id,
           (SELECT count(*) FROM enrollments e WHERE e.section_id = sec.id AND e.status = 'active') AS strength
      FROM sections sec JOIN classes c ON c.id = sec.class_id JOIN academic_years y ON y.id = sec.academic_year_id
     WHERE y.is_current ORDER BY c.level, sec.name`))
  const sections = secs.filter((v) => reachAllows(re, v.campus_id) || v.campus_id === null).map((v) => {
    const o: Record<string, unknown> = { id: v.id, name: v.name, class_name: v.class_name }
    if (v.campus_id !== null) o.campus_id = v.campus_id
    o.strength = v.strength
    return o
  })
  return ok({ campuses, sections, may_file_institution_wide: re.all })
}

/** mdmText: absent keeps the stored value, an explicit empty string clears it. */
const textOr = (supplied: unknown, current: string | null): string | null => {
  if (supplied === undefined || supplied === null) return current
  const v = String(supplied).trim()
  return v === '' ? null : v
}
/** mdmInt: absent keeps the stored figure on an existing day, and is refused on a new one. */
function intField(supplied: unknown, current: number, exists: boolean, field: string): number {
  if (supplied !== undefined && supplied !== null) return Math.trunc(Number(supplied))
  if (exists) return current
  throw badRequest(field + ' is required')
}
const snapshot = (v: { enrolled: number; present: number; meals: number; rice: number | null; cost: number; menu: string | null; cook: string | null; notServed: string | null }) =>
  JSON.stringify({ cook_name: v.cook, cost_paise: v.cost, enrolled: v.enrolled, meals_served: v.meals, menu: v.menu, not_served_reason: v.notServed, present: v.present, rice_kg: v.rice })

async function saveDay(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const onDate = trimStr(req.on_date)
  if (!isDate(onDate)) throw badRequest('on_date must be YYYY-MM-DD')
  if (Date.parse(onDate + 'T00:00:00Z') > Date.now() + 86_400_000) throw badRequest('a register cannot be written for a future date')
  const campus = nullStr(req.campus_id)
  if (campus !== null && !isUUID(campus)) throw badRequest('campus_id must be a uuid')
  const re = await campusReach(c)
  if (!reachAllows(re, campus)) throw denied('you are not posted to that campus')

  const cur = await c.db.prepare(`
    SELECT id, status, enrolled, present, meals_served, rice_kg, cost_paise, menu, cook_name, not_served_reason, updated_at,
           (SELECT count(*) FROM mdm_register_amendments a WHERE a.register_id = m.id) AS amendments
      FROM mdm_registers m
     WHERE on_date = ? AND COALESCE(campus_id, '00000000-0000-0000-0000-000000000000') = COALESCE(?, '00000000-0000-0000-0000-000000000000')`)
    .bind(onDate, campus).first<{ id: string; status: string; enrolled: number; present: number; meals_served: number; rice_kg: string | null
      cost_paise: number; menu: string | null; cook_name: string | null; not_served_reason: string | null; updated_at: string; amendments: number }>()
  const exists = !!cur
  if (cur && cur.status === 'closed') throw closedErr()
  const amending = exists && (cur?.amendments ?? 0) > 0
  if (amending && trimStr(req.reason) === '') throw noReason()

  const curRice = cur?.rice_kg === null || cur?.rice_kg === undefined ? null : Number(cur.rice_kg)
  const enrolled = intField(req.enrolled, cur?.enrolled ?? 0, exists, 'enrolled')
  let present = intField(req.present, cur?.present ?? 0, exists, 'present')
  let meals = intField(req.meals_served, cur?.meals_served ?? 0, exists, 'meals_served')
  const cost = req.cost_paise !== undefined && req.cost_paise !== null ? Math.trunc(Number(req.cost_paise)) : Number(cur?.cost_paise ?? 0)
  const rice = req.rice_kg !== undefined && req.rice_kg !== null ? Number(req.rice_kg) : curRice
  const menu = textOr(req.menu, cur?.menu ?? null)
  const cook = textOr(req.cook_name, cur?.cook_name ?? null)
  const notServed = textOr(req.not_served_reason, cur?.not_served_reason ?? null)
  if (enrolled < 0 || present < 0 || meals < 0 || cost < 0) throw badRequest('counts and cost cannot be negative')
  if (rice !== null && rice < 0) throw badRequest('foodgrain cannot be negative')

  let lines: { section_id: string; present: number; meals_served: number }[] | null = null
  if (req.lines !== undefined && req.lines !== null) {
    if (!Array.isArray(req.lines)) throw badRequest('malformed JSON body')
    lines = []
    const seen = new Set<string>()
    let sumPresent = 0, sumMeals = 0
    for (const l of req.lines as Record<string, unknown>[]) {
      const sid = trimStr(l?.section_id)
      if (!isUUID(sid)) throw badRequest('every line needs a section')
      if (seen.has(String(l.section_id))) throw badRequest('the same section appears twice')
      seen.add(String(l.section_id))
      if (l.present === undefined || l.present === null || l.meals_served === undefined || l.meals_served === null) {
        throw badRequest('every line needs both a headcount and a meal count')
      }
      const p = Math.trunc(Number(l.present)), m = Math.trunc(Number(l.meals_served))
      if (p < 0 || m < 0) throw badRequest('a line cannot be negative')
      if (m > p) throw lineSum()
      sumPresent += p; sumMeals += m
      lines.push({ section_id: String(l.section_id), present: p, meals_served: m })
    }
    if (lines.length > 0) { present = sumPresent; meals = sumMeals }
  } else if (cur) {
    const s = await c.db.prepare(`SELECT count(*) AS n, COALESCE(sum(present), 0) AS p, COALESCE(sum(meals_served), 0) AS m
        FROM mdm_register_lines WHERE register_id = ?`).bind(cur.id).first<{ n: number; p: number; m: number }>()
    if (s && s.n > 0) { present = s.p; meals = s.m }
  }

  const ts = nowISO()
  const actor = c.id.platformAdmin ? null : c.id.userId
  const dayID = cur?.id ?? uuid()
  const stmts: D1PreparedStatement[] = []
  if (cur) {
    // Nobody closed or rewrote it between the read and the write (the Go FOR UPDATE).
    stmts.push(guardStmt(c, `(SELECT status || '|' || updated_at FROM mdm_registers WHERE id = ?) = ?`, [dayID, `${cur.status}|${cur.updated_at}`]))
    stmts.push(c.db.prepare(`UPDATE mdm_registers SET enrolled = ?, present = ?, meals_served = ?, rice_kg = ?, cost_paise = ?, menu = ?, cook_name = ?,
        not_served_reason = ?, recorded_by = ?, updated_at = ? WHERE id = ?`)
      .bind(enrolled, present, meals, rice === null ? null : String(rice), cost, menu, cook, notServed, actor, ts, dayID))
  } else {
    stmts.push(c.db.prepare(`INSERT INTO mdm_registers (id, institution_id, campus_id, on_date, enrolled, present, meals_served, rice_kg, cost_paise, menu,
        cook_name, not_served_reason, status, recorded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
      .bind(dayID, inst, campus, onDate, enrolled, present, meals, rice === null ? null : String(rice), cost, menu, cook, notServed, actor, ts, ts))
  }
  if (lines !== null) {
    stmts.push(c.db.prepare(`DELETE FROM mdm_register_lines WHERE register_id = ?`).bind(dayID))
    for (const l of lines) {
      stmts.push(c.db.prepare(`INSERT INTO mdm_register_lines (id, institution_id, register_id, section_id, present, meals_served) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), inst, dayID, l.section_id, l.present, l.meals_served))
    }
  }
  if (amending && cur) {
    const before = snapshot({ enrolled: cur.enrolled, present: cur.present, meals: cur.meals_served, rice: curRice, cost: Number(cur.cost_paise),
      menu: cur.menu, cook: cur.cook_name, notServed: cur.not_served_reason })
    const after = snapshot({ enrolled, present, meals, rice, cost, menu, cook, notServed })
    stmts.push(c.db.prepare(`INSERT INTO mdm_register_amendments (id, institution_id, register_id, action, reason, before, after, amended_by, amended_at)
        VALUES (?, ?, ?, 'amend', ?, ?, ?, ?, ?)`).bind(uuid(), inst, dayID, trimStr(req.reason), before, after, actor, ts))
  }
  try {
    await c.db.batch(stmts)
  } catch (e) {
    if (isGuardFailure(e)) throw closedErr()
    if (isUniqueViolation(e)) {
      if (/mdm_register_lines/.test((e as Error).message)) throw badRequest('the same section appears twice')
      throw badRequest('this day is already in the register for that campus')
    }
    throw e
  }
  return ok(await readRegister(c, dayID))
}

async function closeDay(c: Ctx): Promise<Response> {
  const dayID = uuidOr400(c.params.id)
  const re = await campusReach(c)
  const d = await c.db.prepare(`SELECT status, campus_id, meals_served, not_served_reason FROM mdm_registers WHERE id = ?`).bind(dayID)
    .first<{ status: string; campus_id: string | null; meals_served: number; not_served_reason: string | null }>()
  if (!d) throw notFound()
  if (!reachAllows(re, d.campus_id)) throw outOfReach()
  if (d.status === 'closed') throw closedErr()
  if (d.meals_served === 0 && (d.not_served_reason === null || d.not_served_reason.trim() === '')) throw noReason()
  const ts = nowISO()
  const r = await c.db.prepare(`UPDATE mdm_registers SET status = 'closed', closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ? AND status <> 'closed'`)
    .bind(ts, c.id.platformAdmin ? null : c.id.userId, ts, dayID).run()
  if (!r.meta.changes) throw closedErr()
  return ok(await readRegister(c, dayID))
}

async function reopenDay(c: Ctx): Promise<Response> {
  const inst = instId(c)
  const dayID = uuidOr400(c.params.id)
  const req = await readJSON<Record<string, unknown>>(c.req)
  const reason = trimStr(req.reason)
  if (reason === '') throw badRequest('say why this day is being reopened')
  const re = await campusReach(c)
  const d = await c.db.prepare(`SELECT status, campus_id, enrolled, present, meals_served, rice_kg, cost_paise, menu, cook_name, not_served_reason
      FROM mdm_registers WHERE id = ?`).bind(dayID)
    .first<{ status: string; campus_id: string | null; enrolled: number; present: number; meals_served: number; rice_kg: string | null
      cost_paise: number; menu: string | null; cook_name: string | null; not_served_reason: string | null }>()
  if (!d) throw notFound()
  if (!reachAllows(re, d.campus_id)) throw outOfReach()
  if (d.status !== 'closed') throw coded(409, 'register_open', 'this day is not closed')
  const snap = snapshot({ enrolled: d.enrolled, present: d.present, meals: d.meals_served, rice: d.rice_kg === null ? null : Number(d.rice_kg),
    cost: Number(d.cost_paise), menu: d.menu, cook: d.cook_name, notServed: d.not_served_reason })
  const ts = nowISO()
  try {
    await c.db.batch([
      guardStmt(c, `(SELECT status FROM mdm_registers WHERE id = ?) = 'closed'`, [dayID]),
      c.db.prepare(`INSERT INTO mdm_register_amendments (id, institution_id, register_id, action, reason, before, amended_by, amended_at)
          VALUES (?, ?, ?, 'reopen', ?, ?, ?, ?)`).bind(uuid(), inst, dayID, reason, snap, c.id.platformAdmin ? null : c.id.userId, ts),
      c.db.prepare(`UPDATE mdm_registers SET status = 'open', closed_at = NULL, closed_by = NULL, updated_at = ? WHERE id = ?`).bind(ts, dayID),
    ])
  } catch (e) {
    if (isGuardFailure(e)) throw coded(409, 'register_open', 'this day is not closed')
    throw e
  }
  return ok(await readRegister(c, dayID))
}

export function registerMDM(r: Router): void {
  r.get('/mdm-register/days', READ, listDays)
  r.post('/mdm-register/days', WRITE, alsoNeeds(READ, saveDay))
  r.get('/mdm-register/context', READ, getContext)
  r.get('/mdm-register/days/{id}', READ, getDay)
  r.post('/mdm-register/days/{id}/close', WRITE, alsoNeeds(READ, closeDay))
  r.post('/mdm-register/days/{id}/reopen', WRITE, alsoNeeds(READ, reopenDay))
}
