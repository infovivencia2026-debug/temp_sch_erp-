import type { Router } from '../../router'
import { HttpError, badRequest, forbidden, ok, readJSON } from '../../http'
import { instId, str } from './common'
import { auditStmt } from '../admin/common'
import { isSchoolAdmin } from '../admin/users'
import { requireFresh } from '../fees/common'

/* Port of school_reset.go: emptying a school so real data can go in.

   Postgres discovered the delete order by trying every table under a
   savepoint and going round again. SQLite has no savepoints on D1 and no
   information_schema, so the tables are read from sqlite_master, and a
   foreign key that still protects a row is a failed statement that is
   simply retried on the next pass. */

const keptTables = new Set(['institutions', 'campuses', 'academic_years', 'terms', 'users', 'roles', 'user_roles', 'role_permissions',
  'module_settings', 'institution_settings', 'branding_profiles', 'bell_schedules', 'periods', 'import_runs', 'import_run_rows', 'goose_db_version',
  /* The audit trail is never wiped: it is the record of this very reset. */
  'audit_log'])

/* A school "in use" cannot be emptied from here: a fee taken or billed, more
   than a trial class of children, or attendance on more than a few days.
   Emptying a live school is a job for the vendor, from a backup. */
export const LIVE_STUDENTS = 50
export const LIVE_ATTENDANCE_DAYS = 5
async function liveReasons(c: Parameters<typeof instId>[0]): Promise<string[]> {
  const id = instId(c)
  const n = async (sql: string) => {
    try { return Number((await c.db.prepare(sql).bind(id).first<{ n: number }>())?.n ?? 0) } catch { return 0 }
  }
  const out: string[] = []
  const pay = await n(`SELECT count(*) AS n FROM payments WHERE institution_id = ?`)
  const inv = await n(`SELECT count(*) AS n FROM invoices WHERE institution_id = ?`)
  const stu = await n(`SELECT count(*) AS n FROM students WHERE institution_id = ?`)
  const days = await n(`SELECT count(DISTINCT on_date) AS n FROM student_attendance WHERE institution_id = ?`)
  if (pay > 0) out.push(pay + ' payment(s)')
  if (inv > 0) out.push(inv + ' invoice(s)')
  if (stu > LIVE_STUDENTS) out.push(stu + ' students')
  if (days > LIVE_ATTENDANCE_DAYS) out.push('attendance on ' + days + ' days')
  return out
}

export function registerReset(r: Router): void {
  r.post('/setup/reset', 'institution.settings.write', async (c) => {
    if (!isSchoolAdmin(c)) throw forbidden('only a school administrator can empty the school')
    await requireFresh(c)
    const req = await readJSON<{ confirm?: string }>(c.req)
    const inst = await c.db.prepare(`SELECT name FROM institutions WHERE id = ?`).bind(instId(c)).first<{ name: string }>()
    if (!inst) throw new Error('institution row missing')
    if (str(req.confirm).trim().toLowerCase() !== inst.name.trim().toLowerCase()) {
      throw badRequest("type the school's name exactly to confirm. Nothing has been deleted.")
    }
    const live = await liveReasons(c)
    if (live.length > 0) {
      await auditStmt(c, 'school.reset.refused', 'institution', instId(c), null, { reasons: live }).run()
      throw new HttpError(409, 'This school is in use (' + live.join(', ') + '), so it cannot be emptied from here. Nothing has been deleted. Ask XULO support if it really must be cleared.', { code: 'school_in_use' })
    }
    /* Written before anything goes, so the attempt is on record even if the delete stops part-way. */
    await auditStmt(c, 'school.reset', 'institution', instId(c), null, { school: inst.name }).run()
    const all = await c.db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ name: string; sql: string }>()
    const tables = all.results
      .filter((t) => /"institution_id"|\binstitution_id\b/.test(t.sql) && !keptTables.has(t.name))
      .map((t) => t.name).sort()
    const total = new Map<string, number>()
    let remaining = tables
    for (let pass = 0; pass < 12 && remaining.length > 0; pass++) {
      const blocked: string[] = []
      let progress = false
      for (const t of remaining) {
        try {
          const res = await c.db.prepare(`DELETE FROM "${t}" WHERE institution_id = ?`).bind(instId(c)).run()
          const n = Number(res.meta.changes ?? 0)
          if (n > 0) { total.set(t, (total.get(t) ?? 0) + n); progress = true }
        } catch {
          blocked.push(t)
        }
      }
      remaining = blocked
      if (!progress) break
    }
    const out = [...total.entries()].map(([table, rows]) => ({ table, rows })).sort((a, b) => b.rows - a.rows)
    const deleted = out.reduce((s, x) => s + x.rows, 0)
    return ok({ school: inst.name, deleted, tables: out, could_not_clear: remaining })
  })
}
