import type { Router, Ctx } from '../../router'
import { badRequest, isUUID, now, ok, readJSON, uuid } from '../../http'
import { inList } from './common'

/* FEATURES OFF, IN BULK (owner, 2026-10-10: "let them choose to remove for a
   single person, whole school or class wise ... make a filter to choose in
   bulk"). The per-login editor on Logins & access can only ADD features beyond
   a role, one login at a time. This turns student or parent features OFF for
   the whole school, chosen classes, chosen sections or chosen people at once.
   Sign-in subtracts the keys (identity.ts), so a role's own features can be
   taken away too. Same guard as that editor. */

type Portal = 'student' | 'parent'
type Scope = 'school' | 'class' | 'section' | 'person'
const PORTALS: Portal[] = ['student', 'parent']
const SCOPES: Scope[] = ['school', 'class', 'section', 'person']
type Row = { id: string; portal: Portal; feature_key: string; scope: Scope; target_id: string; created_at: string }

async function labels(c: Ctx, rows: Row[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = (s: Scope) => [...new Set(rows.filter((r) => r.scope === s && r.target_id).map((r) => r.target_id))]
  const look = async (list: string[], sql: (inSql: string) => string) => {
    if (!list.length) return
    const q = inList(list)
    const res = await c.db.prepare(sql(q.sql)).bind(...q.args).all<{ id: string; name: string }>()
    for (const r of res.results ?? []) out.set(r.id, r.name)
  }
  await look(ids('class'), (q) => `SELECT id, name FROM classes WHERE id IN ${q}`)
  await look(ids('section'), (q) => `SELECT s.id, cl.name || ' ' || s.name AS name FROM sections s JOIN classes cl ON cl.id = s.class_id WHERE s.id IN ${q}`)
  await look(ids('person'), (q) => `SELECT id, full_name AS name FROM users WHERE id IN ${q}`)
  return out
}

export function registerFeatureBlocks(r: Router): void {
  /* What is off now, with a readable name for each target. */
  r.get('/admin/feature-blocks', 'access.users.read', async (c) => {
    const rows = (await c.db.prepare(`SELECT id, portal, feature_key, scope, target_id, created_at FROM feature_blocks ORDER BY created_at DESC LIMIT 2000`)
      .all<Row>()).results ?? []
    const names = await labels(c, rows)
    return ok({ items: rows.map((x) => ({ ...x, target_name: x.scope === 'school' ? 'Whole school' : names.get(x.target_id) ?? 'No longer here' })) })
  })

  /* The classes and sections to choose from. */
  r.get('/admin/feature-blocks/targets', 'access.users.read', async (c) => {
    const classes = (await c.db.prepare(`SELECT id, name FROM classes ORDER BY name`).all<{ id: string; name: string }>()).results ?? []
    const sections = (await c.db.prepare(`SELECT s.id, s.name, s.class_id, cl.name AS class_name FROM sections s JOIN classes cl ON cl.id = s.class_id ORDER BY cl.name, s.name`)
      .all<{ id: string; name: string; class_id: string; class_name: string }>()).results ?? []
    return ok({ classes, sections })
  })

  /* People who have a login, filtered by class, section and name. */
  r.get('/admin/feature-blocks/people', 'access.users.read', async (c) => {
    const p = c.url.searchParams
    const portal = p.get('portal') as Portal
    if (!PORTALS.includes(portal)) throw badRequest('portal is student or parent')
    const cls = p.get('class_id') || null
    const sec = p.get('section_id') || null
    const name = `%${(p.get('q') ?? '').trim().toLowerCase()}%`
    const sql = portal === 'student'
      ? `SELECT u.id AS user_id, u.full_name AS name, min(cl.name || ' ' || s2.name) AS class_name
           FROM students st JOIN users u ON u.id = st.user_id AND u.status = 'active'
           LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
           LEFT JOIN classes cl ON cl.id = e.class_id LEFT JOIN sections s2 ON s2.id = e.section_id
          WHERE (?1 IS NULL OR e.class_id = ?1) AND (?2 IS NULL OR e.section_id = ?2) AND lower(u.full_name) LIKE ?3
          GROUP BY u.id ORDER BY class_name, u.full_name LIMIT 500`
      : `SELECT u.id AS user_id, u.full_name AS name, group_concat(DISTINCT cl.name || ' ' || s2.name) AS class_name
           FROM guardians g JOIN users u ON u.id = g.user_id AND u.status = 'active'
           JOIN student_guardians sg ON sg.guardian_id = g.id
           LEFT JOIN enrollments e ON e.student_id = sg.student_id AND e.status = 'active'
           LEFT JOIN classes cl ON cl.id = e.class_id LEFT JOIN sections s2 ON s2.id = e.section_id
          WHERE (?1 IS NULL OR e.class_id = ?1) AND (?2 IS NULL OR e.section_id = ?2) AND lower(u.full_name) LIKE ?3
          GROUP BY u.id ORDER BY u.full_name LIMIT 500`
    const rows = (await c.db.prepare(sql).bind(cls, sec, name).all<{ user_id: string; name: string; class_name: string | null }>()).results ?? []
    return ok({ items: rows })
  })

  /* Turn keys off for targets: every key x every target, duplicates ignored. */
  r.post('/admin/feature-blocks', 'access.users.write', async (c) => {
    const b = await readJSON<{ portal?: string; keys?: string[]; scope?: string; target_ids?: string[]; record_ids?: string[] }>(c.req)
    const portal = b.portal as Portal
    const scope = b.scope as Scope
    if (!PORTALS.includes(portal)) throw badRequest('portal is student or parent')
    if (!SCOPES.includes(scope)) throw badRequest('choose whole school, classes, sections or people')
    const keys = [...new Set((b.keys ?? []).filter((k) => typeof k === 'string' && k.startsWith(portal + '.')))]
    if (!keys.length) throw badRequest('choose at least one feature')
    const targets = scope === 'school'
      ? ['']
      : [...new Set((b.target_ids ?? []).filter((t) => typeof t === 'string' && isUUID(t)).map((t) => t.toLowerCase()))]
    /* From a class list: the rows are student or guardian records, so their
       logins are looked up here; a record with no login is skipped. */
    if (scope === 'person' && b.record_ids?.length) {
      const rec = [...new Set(b.record_ids.filter((t) => typeof t === 'string' && isUUID(t)).map((t) => t.toLowerCase()))]
      const q = inList(rec)
      const table = portal === 'student' ? 'students' : 'guardians'
      const found = (await c.db.prepare(`SELECT DISTINCT user_id FROM ${table} WHERE id IN ${q.sql} AND user_id IS NOT NULL`).bind(...q.args).all<{ user_id: string }>()).results ?? []
      for (const u of found) if (!targets.includes(u.user_id)) targets.push(u.user_id)
    }
    if (!targets.length) throw badRequest('choose who it is turned off for (people need a login first)')
    if (keys.length * targets.length > 5000) throw badRequest('too many at once; choose fewer features or people')
    const at = now()
    const stmts = []
    for (const k of keys) {
      for (const t of targets) {
        stmts.push(c.db.prepare(`INSERT OR IGNORE INTO feature_blocks (id, portal, feature_key, scope, target_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(uuid(), portal, k, scope, t, c.id.userId, at))
      }
    }
    for (let i = 0; i < stmts.length; i += 100) await c.db.batch(stmts.slice(i, i + 100))
    return ok({ added: stmts.length, note: 'They lose these the next time they open the app.' })
  })

  /* Switch back on: one or many rows. */
  r.post('/admin/feature-blocks/remove', 'access.users.write', async (c) => {
    const b = await readJSON<{ ids?: string[] }>(c.req)
    const ids = (b.ids ?? []).filter((x) => typeof x === 'string' && isUUID(x)).map((x) => x.toLowerCase())
    if (!ids.length) throw badRequest('nothing chosen')
    const q = inList(ids)
    const res = await c.db.prepare(`DELETE FROM feature_blocks WHERE id IN ${q.sql}`).bind(...q.args).run()
    return ok({ removed: res.meta?.changes ?? 0 })
  })
}
