import type { Ctx, Router } from '../../router'
import { badRequest, bool, isUUID, notFound, now, ok, readJSON, uuid } from '../../http'
import { coded, nameOf } from '../exams/common'
import { like } from '../../http'
import { s } from './common'
import { school } from '../school'

/* Port of people_search.go (GET /people/search) and person_groups.go
   (mountPersonGroups): finding a person, and the school's own groupings. */

const READ = 'students.read', WRITE = 'students.write'

/** concat_ws(sep, ...) then trim(): NULLs skipped, empty strings kept. */
const concatWS = (sep: string, ...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => p !== null && p !== undefined).join(sep).trim()
const nullIf = (v: string | null | undefined, x: string) => (v === x ? null : v ?? null)
const initcap = (v: string) => v.toLowerCase().replace(/(^|[^a-z0-9])([a-z])/g, (_, a, b) => a + b.toUpperCase())

// ---------------------------------------------------------------- person groups

interface GroupRule { field: string; op: string; value?: string }

/* The whitelist: every field a rule may name, and its SQL against the aliases
   the member query establishes (st, c, sec for a child; e, d, dep for staff). */
const studentFields: Record<string, string> = {
  class: 'c.name', section: 'sec.name', gender: 'st.gender', status: 'st.status', blood_group: 'st.blood_group', medium: 'st.medium',
  mother_tongue: 'st.mother_tongue', city: 'st.city', state: 'st.state', admission_no: 'st.admission_no', person_code: 'st.person_code',
  name: nameOf('st'),
}
const staffFields: Record<string, string> = {
  designation: "COALESCE(d.name,'')", department: "COALESCE(dep.name,'')", employment_type: 'e.employment_type', status: 'e.status',
  employee_code: 'e.employee_code', person_code: 'e.person_code', name: nameOf('e', false),
}
const groupOps: Record<string, (col: string) => string> = {
  is: (col) => `lower(${col}) = lower(?)`,
  is_not: (col) => `lower(${col}) <> lower(?)`,
  contains: (col) => `${col} LIKE '%' || ? || '%'`,
  starts: (col) => `${col} LIKE ? || '%'`,
  is_set: (col) => `COALESCE(CAST(${col} AS TEXT),'') <> ''`,
  is_empty: (col) => `COALESCE(CAST(${col} AS TEXT),'') = ''`,
}

const customField = (table: string) =>
  `(SELECT j.value FROM json_each(CASE WHEN json_valid(${table}.custom_fields) THEN ${table}.custom_fields END) j WHERE j.key = ?)`

/** buildRules: the office's choices as a WHERE fragment and its arguments; '' for no rules. */
function buildRules(kind: string, rules: GroupRule[]): { sql: string; args: unknown[] } {
  const fields = kind === 'staff' ? staffFields : studentFields
  const parts: string[] = []
  const args: unknown[] = []
  for (const rule of rules) {
    const name = s(rule.field).trim()
    const opName = s(rule.op).trim()
    const op = groupOps[opName]
    if (!op) throw new Error(`unknown filter ${JSON.stringify(s(rule.op))}`)
    let column: string
    if (name.startsWith('custom:')) {
      const label = name.slice('custom:'.length).trim()
      if (label === '') throw new Error('that field cannot be filtered on')
      column = customField(kind === 'staff' ? 'e' : 'st')
      args.push(label)
    } else {
      const col = fields[name]
      if (!col) throw new Error(`that field cannot be filtered on: ${name}`)
      column = col
    }
    if (rule.op === 'is_set' || rule.op === 'is_empty') { parts.push(op(column)); continue }
    const value = s(rule.value).trim()
    if (value === '') throw new Error(`the ${name} filter needs a value`)
    parts.push(op(column))
    args.push(value)
  }
  return parts.length ? { sql: '(' + parts.join(' AND ') + ')', args } : { sql: '', args: [] }
}

function memberQuery(kind: string, where: string): string {
  if (kind === 'staff') return `
    SELECT DISTINCT e.id, ${nameOf('e', false)} AS name, COALESCE(e.person_code,'') AS person_code, COALESCE(e.employee_code,'') AS ref,
           COALESCE(d.name,'') AS detail, (m.group_id IS NOT NULL) AS picked
      FROM employees e
      LEFT JOIN designations d ON d.id = e.designation_id
      LEFT JOIN departments dep ON dep.id = e.department_id
      LEFT JOIN person_group_members m ON m.employee_id = e.id AND m.group_id = ?
     WHERE m.group_id IS NOT NULL${where}
     ORDER BY 2`
  return `
    SELECT DISTINCT st.id, ${nameOf('st')} AS name, COALESCE(st.person_code,'') AS person_code, st.admission_no AS ref,
           TRIM(COALESCE(c.name,'') || ' ' || COALESCE(sec.name,'')) AS detail, (m.group_id IS NOT NULL) AS picked
      FROM students st
      LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
      LEFT JOIN sections sec ON sec.id = en.section_id
      LEFT JOIN classes c ON c.id = sec.class_id
      LEFT JOIN person_group_members m ON m.student_id = st.id AND m.group_id = ?
     WHERE m.group_id IS NOT NULL${where}
     ORDER BY 2`
}

function rulesOf(raw: unknown): GroupRule[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) ? v.map((x) => ({ field: s(x?.field), op: s(x?.op), ...(s(x?.value) !== '' ? { value: s(x.value) } : {}) })) : []
  } catch { return [] }
}

const groupID = (c: Ctx) => {
  const id = c.params.id
  if (!isUUID(id)) throw badRequest('invalid group id')
  return id
}

async function saveGroup(c: Ctx, existing: string): Promise<Response> {
  const req = await readJSON(c.req)
  const name = s(req.name).trim()
  if (name === '') throw badRequest('a group needs a name')
  const kind = s(req.kind)
  if (kind !== 'student' && kind !== 'staff') throw badRequest('kind must be student or staff')
  const rules = rulesOf(Array.isArray(req.rules) ? req.rules : [])
  try { buildRules(kind, rules) } catch (e) { throw badRequest((e as Error).message) }
  const raw = JSON.stringify(rules)
  const inst = school(c).id, t = now()
  if (existing !== '') {
    const cur = await c.db.prepare(`SELECT kind FROM person_groups WHERE id = ?`).bind(existing).first<{ kind: string }>()
    if (!cur) throw notFound('resource not found')
    // person_groups_institution_kind_name, which D1 does not carry.
    if (await c.db.prepare(`SELECT 1 FROM person_groups WHERE institution_id = ? AND kind = ? AND lower(name) = lower(?) AND id <> ?`)
      .bind(inst, cur.kind, name, existing).first()) throw coded(409, 'group_exists', 'this school already has a group with that name')
    await c.db.prepare(`UPDATE person_groups SET name = ?, note = NULLIF(?,''), rules = ?, updated_at = ? WHERE id = ?`)
      .bind(name, s(req.note), raw, t, existing).run()
    return ok({ id: existing, name })
  }
  if (await c.db.prepare(`SELECT 1 FROM person_groups WHERE institution_id = ? AND kind = ? AND lower(name) = lower(?)`).bind(inst, kind, name).first()) {
    throw coded(409, 'group_exists', 'this school already has a group with that name')
  }
  const id = uuid()
  await c.db.prepare(`INSERT INTO person_groups (id, institution_id, kind, name, note, rules, created_by, created_at, updated_at)
      VALUES (?,?,?,?,NULLIF(?,''),?,?,?,?)`).bind(id, inst, kind, name, s(req.note), raw, c.id.userId, t, t).run()
  return ok({ id, name })
}

export function registerPeople(r: Router) {
  /* searchPeople: children, parents and colleagues in one ranked list. Two
     characters minimum; fewer is an empty list, not a 400. */
  r.get('/people/search', READ, async (c) => {
    const q = (c.url.searchParams.get('q') ?? '').trim()
    if (new TextEncoder().encode(q).length < 2) return ok({ items: [] })
    const contains = like(q)
    const prefix = q.replace(/[%_\\]/g, (x) => '\\' + x) + '%'
    const rows = await c.db.prepare(`
      SELECT * FROM (
        SELECT 'student' AS kind, st.id AS id, ${nameOf('st')} AS name,
               TRIM(COALESCE(c.name,'') || ' ' || COALESCE(sec.name,'')) AS d1, c.name AS cname, sec.name AS sname,
               st.admission_no AS d2, COALESCE(st.person_code,'') AS d3, st.status AS d4, NULL AS d5,
               st.id AS student_id,
               CASE WHEN lower(st.admission_no) = lower(?1) OR lower(COALESCE(st.person_code,'')) = lower(?1) THEN 0
                    WHEN TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')) LIKE ?3 ESCAPE '\\' THEN 1
                    ELSE 3 END AS rank
          FROM students st
          LEFT JOIN enrollments en ON en.student_id = st.id AND en.status = 'active'
          LEFT JOIN sections sec ON sec.id = en.section_id
          LEFT JOIN classes c ON c.id = sec.class_id
         WHERE ${nameOf('st')} LIKE ?2 ESCAPE '\\' OR st.admission_no LIKE ?2 ESCAPE '\\' OR COALESCE(st.person_code,'') LIKE ?2 ESCAPE '\\'
        UNION ALL
        SELECT 'guardian', g.id, g.full_name, g.relation, NULL, NULL,
               (SELECT group_concat(nm, ', ') FROM (SELECT TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')) AS nm
                  FROM student_guardians sg JOIN students st ON st.id = sg.student_id WHERE sg.guardian_id = g.id ORDER BY st.first_name)),
               COALESCE(g.phone,''), NULL, NULL,
               (SELECT st.id FROM student_guardians sg JOIN students st ON st.id = sg.student_id WHERE sg.guardian_id = g.id ORDER BY st.admission_no LIMIT 1),
               CASE WHEN g.phone = ?1 THEN 0 WHEN g.full_name LIKE ?3 ESCAPE '\\' THEN 2 ELSE 4 END
          FROM guardians g
         WHERE EXISTS (SELECT 1 FROM student_guardians sg JOIN students st ON st.id = sg.student_id WHERE sg.guardian_id = g.id)
           AND (g.full_name LIKE ?2 ESCAPE '\\' OR COALESCE(g.phone,'') LIKE ?2 ESCAPE '\\' OR COALESCE(g.email,'') LIKE ?2 ESCAPE '\\')
        UNION ALL
        SELECT 'staff', u.id, u.full_name, COALESCE(e.employee_code, ''), NULL, NULL,
               COALESCE(NULLIF(e.phone, ''), NULLIF(u.phone, ''), 'Staff'), NULL, NULL, NULL, '',
               CASE WHEN u.full_name LIKE ?3 ESCAPE '\\' THEN 1 ELSE 3 END
          FROM users u
          LEFT JOIN employees e ON e.user_id = u.id
         WHERE u.status = 'active' AND u.id <> ?4
           AND (e.id IS NOT NULL OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                                             WHERE ur.user_id = u.id AND ro.key NOT IN ('student','parent')))
           AND (u.full_name LIKE ?2 ESCAPE '\\' OR COALESCE(u.phone,'') LIKE ?2 ESCAPE '\\' OR COALESCE(u.email,'') LIKE ?2 ESCAPE '\\'
                OR COALESCE(e.employee_code,'') LIKE ?2 ESCAPE '\\')
      ) ORDER BY rank, name LIMIT 15`).bind(q, contains, prefix, c.id.userId).all<Record<string, string | null>>()
    return ok({ items: rows.results.map((v) => {
      let detail: string
      if (v.kind === 'student') {
        const cls = v.cname === null && v.sname === null ? '' : [v.cname, v.sname].filter((x) => x !== null).join(' ')
        detail = concatWS(' · ', cls === '' ? null : cls, v.d2, v.d3, nullIf(v.d4, 'active'))
      } else if (v.kind === 'guardian') {
        detail = concatWS(' · ', v.d1 ? (initcap(v.d1) || null) : null, v.d2 === '' ? null : v.d2, v.d3 === '' ? null : v.d3)
      } else {
        detail = concatWS(' · ', v.d1 === '' ? null : v.d1, v.d2)
      }
      return { kind: v.kind, id: v.id, name: v.name, detail, student_id: v.student_id ?? '' }
    }) })
  })

  // ---------------------------------------------------------------- groups
  r.get('/people/groups', READ, async (c) => {
    const kind = (c.url.searchParams.get('kind') ?? '').trim()
    if (kind !== 'student' && kind !== 'staff') throw badRequest('kind must be student or staff')
    const rows = await c.db.prepare(`SELECT g.id, g.kind, g.name, g.note, g.rules,
        (SELECT count(*) FROM person_group_members m WHERE m.group_id = g.id) AS picked
        FROM person_groups g WHERE g.kind = ? ORDER BY lower(g.name)`).bind(kind).all<Record<string, unknown>>()
    // members is never filled by the Go handler (it counts only the hand-picked half), so it is 0 here too.
    return ok({ items: rows.results.map((g) => ({ id: g.id, kind: g.kind, name: g.name, ...(g.note !== null ? { note: g.note } : {}),
      rules: rulesOf(g.rules), members: 0, picked: Number(g.picked) })) })
  })

  r.get('/people/group-fields', READ, async (c) => {
    const kind = (c.url.searchParams.get('kind') ?? '').trim()
    if (kind !== 'student' && kind !== 'staff') throw badRequest('kind must be student or staff')
    const table = kind === 'staff' ? 'employees' : 'students'
    const rows = await c.db.prepare(`SELECT DISTINCT k.key AS k FROM ${table} t,
        json_each(CASE WHEN json_valid(t.custom_fields) AND json_type(t.custom_fields) = 'object' THEN t.custom_fields END) k
        ORDER BY 1 LIMIT 60`).all<{ k: string }>()
    return ok({ fields: Object.keys(kind === 'staff' ? staffFields : studentFields), custom_fields: rows.results.map((x) => x.k),
      ops: Object.keys(groupOps) })
  })

  r.get('/people/groups/{id}/members', READ, async (c) => {
    const gid = groupID(c)
    const g = await c.db.prepare(`SELECT kind, rules FROM person_groups WHERE id = ?`).bind(gid).first<{ kind: string; rules: string }>()
    if (!g) throw notFound('resource not found')
    const built = buildRules(g.kind, rulesOf(g.rules))
    const rows = await c.db.prepare(memberQuery(g.kind, built.sql ? ' OR ' + built.sql : '')).bind(gid, ...built.args).all<Record<string, unknown>>()
    const items = rows.results.map((m) => ({ id: m.id, name: m.name, person_code: m.person_code, ref: m.ref ?? '', detail: m.detail, picked: bool(m.picked) }))
    return ok({ items, count: items.length })
  })

  r.post('/people/groups', WRITE, (c) => saveGroup(c, ''))
  r.put('/people/groups/{id}', WRITE, (c) => {
    if (!isUUID(c.params.id)) throw new Error('invalid UUID length')
    return saveGroup(c, c.params.id)
  })

  r.del('/people/groups/{id}', WRITE, async (c) => {
    const gid = groupID(c)
    await c.db.prepare(`DELETE FROM person_groups WHERE id = ?`).bind(gid).run()
    return ok({ deleted: true })
  })

  r.post('/people/groups/{id}/members', WRITE, async (c) => {
    const gid = groupID(c)
    const req = await readJSON(c.req)
    const g = await c.db.prepare(`SELECT kind FROM person_groups WHERE id = ?`).bind(gid).first<{ kind: string }>()
    if (!g) throw notFound('resource not found')
    const column = g.kind === 'staff' ? 'employee_id' : 'student_id'
    const inst = school(c).id, t = now()
    const ids = [...new Set((Array.isArray(req.ids) ? req.ids : []).map((x: unknown) => String(x).trim()).filter(isUUID))]
    if (ids.length === 0) return ok({ added: 0 })
    // ON CONFLICT DO NOTHING on the partial unique indexes D1 does not carry.
    const res = await c.db.batch(ids.map((pid) => c.db.prepare(`INSERT INTO person_group_members (group_id, institution_id, ${column}, added_at, added_by)
        SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM person_group_members WHERE group_id = ? AND ${column} = ?)`)
      .bind(gid, inst, pid, t, c.id.userId, gid, pid)))
    return ok({ added: res.reduce((a, x) => a + Number(x.meta?.changes ?? 0), 0) })
  })

  r.del('/people/groups/{id}/members/{personID}', WRITE, async (c) => {
    const gid = groupID(c)
    const pid = c.params.personID
    if (!isUUID(pid)) throw badRequest('invalid person id')
    await c.db.prepare(`DELETE FROM person_group_members WHERE group_id = ?1 AND (student_id = ?2 OR employee_id = ?2)`)
      .bind(gid, pid).run()
    return ok({ removed: true })
  })
}
