import type { Ctx } from '../../router'
import { HttpError, badRequest, forbidden } from '../../http'
import { can } from '../../identity'
import { coded, resolveScope, type Resolved } from '../exams/common'
import { todayIST } from '../admissions/util'

/* Helpers shared by the hr-growth, people, rollups and report-builder ports. */

/** Drops null/undefined keys, the way `omitempty` on a pointer does. */
export function omitNull<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

/** Go nullString: the empty string is NULL, anything else is itself. */
export const nullString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
export const s = (v: unknown): string => (typeof v === 'string' ? v : '')
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
export const num0 = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0)
/** A JSON number from a request body, or null when absent. */
export const bodyNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const bodyInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)
export const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : [])

/** CAST of a numeric TEXT column, so SQLite compares it as a number rather than as text. */
export const n = (col: string) => `CAST(${col} AS REAL)`

/** A list bound as one JSON parameter: `x IN (SELECT value FROM json_each(?))`. D1 caps bound parameters at 100. */
export const inJSON = (col: string) => `${col} IN (SELECT value FROM json_each(?))`

/** A Postgres array column that became TEXT: JSON array, or a '{a,b}' literal from the converter. */
export function pgArray(raw: unknown): string[] {
  const t = typeof raw === 'string' ? raw.trim() : ''
  if (t === '' || t === '{}' || t === '[]') return []
  if (t.startsWith('[')) { try { const v = JSON.parse(t); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
  if (t.startsWith('{')) return t.slice(1, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)
  return []
}

export const round1 = (v: number) => Math.round(v * 10) / 10

/** Requires a second permission beyond the one the route was registered with (chi's nested RequirePermission). */
export function need(c: Ctx, perm: string): void {
  if (!can(c.id, perm)) throw forbidden()
}

/*
growthTxn's error mapping (hr_growth.go): the refusals a user can act on are
409s, a missing reference is a 400. D1 reports constraint failures by message.
*/
export function dbError(e: unknown): never {
  if (e instanceof HttpError) throw e
  const msg = e instanceof Error ? e.message : String(e)
  if (/UNIQUE constraint failed/i.test(msg)) throw coded(409, 'duplicate', 'that record already exists')
  if (/FOREIGN KEY constraint failed/i.test(msg)) throw badRequest('one of the ids in this request does not exist')
  if (/CHECK constraint failed/i.test(msg)) throw coded(409, 'refused', msg)
  throw e
}

/** Runs statements atomically, mapping constraint failures. */
export async function run(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  if (stmts.length === 0) return []
  try { return await db.batch(stmts) } catch (e) { dbError(e) }
}

export const changes = (r: D1Result | undefined): number => Number(r?.meta?.changes ?? 0)

// ---------------------------------------------------------------- csv

export const wantsCSV = (c: Ctx) => (c.url.searchParams.get('format') ?? '').toLowerCase() === 'csv'

function csvField(f: string): string {
  if (f === '') return f
  if (/[",\r\n]/.test(f) || f[0] === ' ' || f[0] === '\t') return '"' + f.replace(/"/g, '""') + '"'
  return f
}

/** writeRollupCSV: a UTF-8 BOM, a header, one line per row, named <name>-<today>.csv. */
export function csvResponse(name: string, header: string[], rows: string[][]): Response {
  const lines = [header, ...rows].map((r) => r.map(csvField).join(',')).join('\n') + '\n'
  return new Response('﻿' + lines, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}-${todayIST()}.csv"`,
    },
  })
}
export const rupeesCell = (p: number) => (p / 100).toFixed(2)
export const intCell = (v: number) => String(v)
export const pctCell = (v: number | null | undefined) => (v === null || v === undefined ? '' : v.toFixed(1))
export const strCell = (v: string | null | undefined) => v ?? ''

// ---------------------------------------------------------------- rollup boundary

/* rollupBoundary (admin_rollups.go): institution-wide for a platform admin
   or a holder of students.read.all / attendance.read.all, the caller's own
   departments and sections otherwise. */
export interface Boundary { all: boolean; depts: string[]; sections: string[]; res: Resolved }

export async function rollupBoundary(c: Ctx): Promise<Boundary> {
  const res = await resolveScope(c)
  return { all: res.platformAdmin || res.allStudents || res.allAttendance, depts: res.departmentIds, sections: res.sectionIds, res }
}
export const boundaryLabel = (b: Boundary) => (b.all ? 'institution' : 'department')

/** deptPredicate / sectionPredicate: TRUE, FALSE, or `col IN (json)` with its one argument. */
export function scopePred(b: Boundary, col: string, ids: string[]): { sql: string; args: unknown[] } {
  if (b.all) return { sql: '1', args: [] }
  if (ids.length === 0) return { sql: '0', args: [] }
  return { sql: inJSON(col), args: [JSON.stringify(ids)] }
}
