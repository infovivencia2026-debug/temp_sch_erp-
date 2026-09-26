import type { Ctx } from '../../router'
import { badRequest } from '../../http'
import { workingYear } from '../misc/shell'
import { all, utcSeconds } from './common'

/* The pieces of timetable_ops.go that master_timetable.go reads as well:
   the day's periods, the draft head row, the issue list, and a uuid made
   inside SQL for INSERT ... SELECT copies of whole grids. */

export const TEACHING_WEEKDAYS = [1, 2, 3, 4, 5, 6]

/** A v4 uuid produced by SQLite, for rows copied set-wise (publish, whole-range cover). */
export const UUID_SQL = `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))`

export interface GridPeriod { id: string; name: string; sequence: number; starts_at: string; ends_at: string; is_break: boolean }

export async function loadPeriods(c: Ctx): Promise<GridPeriod[]> {
  const rows = await all<{ id: string; name: string; sequence: number; starts_at: string | null; ends_at: string | null; is_break: number }>(
    c.db.prepare(`SELECT id, name, sequence, starts_at, ends_at, is_break FROM periods ORDER BY sequence`))
  return rows.map((p) => ({ id: p.id, name: p.name, sequence: p.sequence, starts_at: (p.starts_at ?? '').slice(0, 5),
    ends_at: (p.ends_at ?? '').slice(0, 5), is_break: !!p.is_break }))
}
export const teachingCount = (ps: GridPeriod[]) => ps.filter((p) => !p.is_break).length

/** resolveYear: the named year, else the caller's working year, else the latest. Throws Go's sentence when there is none. */
export async function resolveYear(c: Ctx, want: string, missing = 'no academic year. Create one before generating a timetable'): Promise<string> {
  const y = await workingYear(c, want)
  if (!y) throw badRequest(missing)
  return y
}

export const DRAFT_SELECT = `
  SELECT d.id, d.name, d.status, d.seed, d.academic_year_id, ay.name AS year_name,
         d.periods_required, d.periods_placed, d.blocking_issues, d.warning_issues,
         gu.full_name AS generated_by, d.generated_at, pu.full_name AS published_by, d.published_at,
         (SELECT count(DISTINCT de.section_id) FROM timetable_draft_entries de WHERE de.draft_id = d.id) AS sections
    FROM timetable_drafts d
    JOIN academic_years ay ON ay.id = d.academic_year_id
    LEFT JOIN users gu ON gu.id = d.generated_by
    LEFT JOIN users pu ON pu.id = d.published_by`

export interface DraftDbRow {
  id: string; name: string; status: string; seed: number; academic_year_id: string; year_name: string
  periods_required: number; periods_placed: number; blocking_issues: number; warning_issues: number
  generated_by: string | null; generated_at: string; published_by: string | null; published_at: string | null; sections: number
}

/** draftRow's JSON, with its three omitempty fields left out when empty. */
export function draftJSON(v: DraftDbRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: v.id, name: v.name, status: v.status, seed: Number(v.seed), academic_year_id: v.academic_year_id, academic_year: v.year_name,
    periods_required: v.periods_required, periods_placed: v.periods_placed, blocking_issues: v.blocking_issues,
    warning_issues: v.warning_issues,
  }
  if (v.generated_by) out.generated_by = v.generated_by
  out.generated_at = utcSeconds(v.generated_at) ?? ''
  if (v.published_by) out.published_by = v.published_by
  const pub = utcSeconds(v.published_at)
  if (pub) out.published_at = pub
  out.sections = v.sections
  return out
}

/** The report on a draft, blocking first (timetable_draft_issues). */
export async function loadDraftIssues(c: Ctx, draftID: string): Promise<Record<string, unknown>[]> {
  const rows = await all<{ kind: string; severity: string; section_name: string | null; subject_name: string | null; teacher_name: string | null
    periods_required: number; periods_placed: number; detail: string }>(c.db.prepare(`
    SELECT i.kind, i.severity, sec.name AS section_name, sub.name AS subject_name, u.full_name AS teacher_name,
           i.periods_required, i.periods_placed, i.detail
      FROM timetable_draft_issues i
      LEFT JOIN sections sec ON sec.id = i.section_id
      LEFT JOIN class_subjects cs ON cs.id = i.class_subject_id
      LEFT JOIN subjects sub ON sub.id = cs.subject_id
      LEFT JOIN users u ON u.id = i.teacher_user_id
     WHERE i.draft_id = ?
     ORDER BY (i.severity = 'blocking') DESC, sec.name IS NOT NULL, sec.name, sub.name`).bind(draftID))
  return rows.map((v) => {
    const o: Record<string, unknown> = { kind: v.kind, severity: v.severity }
    if (v.section_name !== null) o.section_name = v.section_name
    if (v.subject_name !== null) o.subject_name = v.subject_name
    if (v.teacher_name !== null) o.teacher_name = v.teacher_name
    o.periods_required = v.periods_required
    o.periods_placed = v.periods_placed
    o.detail = v.detail
    return o
  })
}

export const DRAFT_ENTRY_SELECT = `
  SELECT de.id, de.section_id, sec.name AS section_name, c.name AS class_name,
         de.period_id, p.name AS period_name, de.weekday, sub.name AS subject_name, sub.code AS subject_code,
         de.teacher_user_id, u.full_name AS teacher_name, de.room
    FROM timetable_draft_entries de
    JOIN sections sec ON sec.id = de.section_id
    JOIN classes c ON c.id = sec.class_id
    JOIN periods p ON p.id = de.period_id
    JOIN class_subjects cs ON cs.id = de.class_subject_id
    JOIN subjects sub ON sub.id = cs.subject_id
    LEFT JOIN users u ON u.id = de.teacher_user_id`

export interface DraftEntryDb {
  id: string; section_id: string; section_name: string; class_name: string; period_id: string; period_name: string
  weekday: number; subject_name: string; subject_code: string | null; teacher_user_id: string | null; teacher_name: string | null; room: string | null
}
export function draftEntryJSON(v: DraftEntryDb): Record<string, unknown> {
  const o: Record<string, unknown> = { id: v.id, section_id: v.section_id, section_name: v.section_name, class_name: v.class_name,
    period_id: v.period_id, period_name: v.period_name, weekday: v.weekday, subject_name: v.subject_name, subject_code: v.subject_code ?? '' }
  if (v.teacher_user_id !== null) o.teacher_id = v.teacher_user_id
  if (v.teacher_name !== null) o.teacher_name = v.teacher_name
  if (v.room !== null) o.room = v.room
  return o
}

/** Batch-time guard: fails the whole batch (UNIQUE on institutions.id) when cond is false. */
export const guardStmt = (c: Ctx, cond: string, args: unknown[] = []): D1PreparedStatement =>
  c.db.prepare(`INSERT INTO institutions SELECT * FROM institutions WHERE NOT (${cond}) LIMIT 1`).bind(...args)
export const isGuardFailure = (e: unknown): boolean => e instanceof Error && /institutions\.id/.test(e.message)

/** Rows written set-wise from one JSON parameter, chunked so no statement grows past D1's limits. */
export function jsonInsert(c: Ctx, sql: string, rows: unknown[], fixed: unknown[], chunk = 400): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = []
  for (let i = 0; i < rows.length; i += chunk) {
    out.push(c.db.prepare(sql).bind(...fixed, JSON.stringify(rows.slice(i, i + chunk))))
  }
  return out
}
