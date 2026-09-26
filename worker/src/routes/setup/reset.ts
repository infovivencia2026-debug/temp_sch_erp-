import type { Router } from '../../router'
import { badRequest, ok, readJSON } from '../../http'
import { instId, str } from './common'

/* Port of school_reset.go: emptying a school so real data can go in.

   Postgres discovered the delete order by trying every table under a
   savepoint and going round again. SQLite has no savepoints on D1 and no
   information_schema, so the tables are read from sqlite_master, and a
   foreign key that still protects a row is a failed statement that is
   simply retried on the next pass. */

const keptTables = new Set(['institutions', 'campuses', 'academic_years', 'terms', 'users', 'roles', 'user_roles', 'role_permissions',
  'module_settings', 'institution_settings', 'branding_profiles', 'bell_schedules', 'periods', 'import_runs', 'import_run_rows', 'goose_db_version'])

export function registerReset(r: Router): void {
  r.post('/setup/reset', 'institution.settings.write', async (c) => {
    const req = await readJSON<{ confirm?: string }>(c.req)
    const inst = await c.db.prepare(`SELECT name FROM institutions WHERE id = ?`).bind(instId(c)).first<{ name: string }>()
    if (!inst) throw new Error('institution row missing')
    if (str(req.confirm).trim().toLowerCase() !== inst.name.trim().toLowerCase()) {
      throw badRequest("type the school's name exactly to confirm. Nothing has been deleted.")
    }
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
