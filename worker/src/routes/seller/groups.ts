import type { Ctx, Router } from '../../router'
import { HttpError, badRequest, conflict, created, forbidden, isUUID, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { institutionById, tenantDb, type Institution } from '../../tenant'
import type { Env } from '../../env'
import { requirePlatformAdmin } from './common'
import { grantBoardMember } from './tenants'

/* School groups: one organisation owning several schools ("Yajur Branch 1",
   "Yajur Branch 2"). New here, no Go original (Go's franchises are a brand and
   royalty contract, not ownership).

   Each school keeps its own D1 database. A group is a CONTROL label plus its
   admins: people who sign in at one of the group's schools and are a
   board member of every other one (the ordinary board_member grant, mirrored
   by grantBoardMember), so the header switcher reaches each school, and who
   may read the group's combined report.

   SECURITY. The combined report opens other schools' databases on the
   server's authority, so who may read it is decided here and only here:
   - platform operators (not support_admin) may read any group;
   - a school user may read a group only when school_group_admins names them
     with the home school their session signed in to, and then only the group's
     schools that they also hold a board membership in (or their home). A
     school that leaves the group, or a grant the seller revokes, drops out at
     once. Nothing a client sends widens that set. */

const PERM = 'platform.tenants.write'

interface Group { id: string; name: string; created_at: string }

/** The school's D1, or null when its binding is not deployed on this Worker. */
function openTenant(env: Env, inst: Institution): D1Database | null {
  try { return tenantDb(env, inst) } catch { return null }
}

async function groupOr404(env: Env, id: string): Promise<Group> {
  const g = await env.CONTROL.prepare(`SELECT id, name, created_at FROM school_groups WHERE id = ?`).bind(id).first<Group>()
  if (!g) throw notFound('no such group')
  return g
}

async function groupSchools(env: Env, groupId: string): Promise<Institution[]> {
  const r = await env.CONTROL.prepare(`SELECT i.* FROM school_group_members m JOIN institutions i ON i.id = m.institution_id
      WHERE m.group_id = ? ORDER BY i.name`).bind(groupId).all<Institution>()
  return r.results
}

function localDay(tz: string, d = new Date()): string {
  try { return d.toLocaleDateString('en-CA', { timeZone: tz }) } catch { return d.toISOString().slice(0, 10) }
}

interface Numbers {
  students: number; staff: number; collected_month_paise: number; outstanding_paise: number
  attendance_marked_today: number; attendance_present_today: number; attendance_pct?: number; reachable: boolean
}

/** One school's headline numbers, read from its own database. The month and "today" are the school's own. */
async function schoolNumbers(env: Env, inst: Institution): Promise<Numbers> {
  const out: Numbers = { students: 0, staff: 0, collected_month_paise: 0, outstanding_paise: 0, attendance_marked_today: 0, attendance_present_today: 0, reachable: false }
  const db = openTenant(env, inst)
  if (!db) return out
  const today = localDay(inst.timezone || 'Asia/Kolkata')
  const monthStart = today.slice(0, 8) + '01'
  try {
    const r = await db.prepare(`SELECT
        (SELECT count(*) FROM students WHERE status = 'active') AS students,
        (SELECT count(*) FROM employees WHERE status = 'active') AS staff,
        COALESCE((SELECT sum(amount_paise) FROM payments WHERE status = 'success' AND paid_on BETWEEN ?1 AND ?2), 0) AS collected,
        COALESCE((SELECT sum(net_paise - paid_paise) FROM invoices WHERE status IN ('unpaid','partial','overdue')), 0) AS outstanding,
        (SELECT count(*) FROM student_attendance WHERE on_date = ?2) AS marked,
        (SELECT count(*) FROM student_attendance WHERE on_date = ?2 AND status IN ('present','late')) AS present`)
      .bind(monthStart, today).first<Record<string, number | null>>()
    if (r) {
      out.students = Number(r.students ?? 0); out.staff = Number(r.staff ?? 0)
      out.collected_month_paise = Number(r.collected ?? 0); out.outstanding_paise = Number(r.outstanding ?? 0)
      out.attendance_marked_today = Number(r.marked ?? 0); out.attendance_present_today = Number(r.present ?? 0)
      if (out.attendance_marked_today) out.attendance_pct = Math.round((100 * out.attendance_present_today) / out.attendance_marked_today)
      out.reachable = true
    }
  } catch (e) { console.error('group numbers', inst.slug, e) }
  return out
}

function sum(rows: Numbers[]) {
  const t = { students: 0, staff: 0, collected_month_paise: 0, outstanding_paise: 0, attendance_marked_today: 0, attendance_present_today: 0 } as Record<string, number>
  for (const r of rows) for (const k of Object.keys(t)) t[k] += (r as unknown as Record<string, number>)[k]
  if (t.attendance_marked_today) t.attendance_pct = Math.round((100 * t.attendance_present_today) / t.attendance_marked_today)
  return t
}

/** Removes the board grants a group gave this user (in one school, or all of the group's). Tenant row first, then the index. */
async function revokeGroupGrants(env: Env, groupId: string, userId: string | null, instId: string | null): Promise<void> {
  const rows = await env.CONTROL.prepare(`SELECT user_id, institution_id FROM board_memberships WHERE via_group = ?1
      AND (?2 IS NULL OR user_id = ?2) AND (?3 IS NULL OR institution_id = ?3)`).bind(groupId, userId, instId)
    .all<{ user_id: string; institution_id: string }>()
  for (const r of rows.results) {
    const inst = await institutionById(env, r.institution_id)
    const db = inst ? openTenant(env, inst) : null
    if (db) {
      await db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role_id IN (SELECT id FROM roles WHERE key = 'board_member')`).bind(r.user_id).run()
    }
    await env.CONTROL.prepare(`DELETE FROM board_memberships WHERE user_id = ? AND institution_id = ?`).bind(r.user_id, r.institution_id).run()
  }
}

async function recordEvent(env: Env, inst: string | null, subject: string, detail: string, actor: string): Promise<void> {
  try {
    await env.CONTROL.prepare(`INSERT INTO platform_events (id, kind, ok, institution_id, subject, detail, actor_id, at) VALUES (?,?,1,?,?,?,?,?)`)
      .bind(uuid(), 'school_group', inst, subject, detail, actor, now()).run()
  } catch (e) { console.error('platform_events', e) }
}

async function admins(env: Env, groupId: string) {
  const r = await env.CONTROL.prepare(`SELECT a.user_id, a.home_institution_id, i.name AS home_school FROM school_group_admins a
      JOIN institutions i ON i.id = a.home_institution_id WHERE a.group_id = ?`).bind(groupId)
    .all<{ user_id: string; home_institution_id: string; home_school: string }>()
  return Promise.all(r.results.map(async (a) => {
    const inst = await institutionById(env, a.home_institution_id)
    const db = inst ? openTenant(env, inst) : null
    const u = db ? await db.prepare(`SELECT full_name, email, phone, status FROM users WHERE id = ?`).bind(a.user_id)
      .first<{ full_name: string; email: string | null; phone: string | null; status: string }>() : null
    return { user_id: a.user_id, full_name: u?.full_name ?? '(unknown)', email: u?.email ?? undefined, phone: u?.phone ?? undefined,
      status: u?.status ?? 'unknown', home_institution_id: a.home_institution_id, home_school: a.home_school }
  }))
}

/** Which groups this caller may read, and which of each group's schools. See the SECURITY note at the top. */
async function readableSchools(c: Ctx, groupId: string): Promise<Institution[]> {
  const schools = await groupSchools(c.env, groupId)
  if (c.id.platformAdmin) {
    if (c.id.restricted) throw forbidden('support accounts cannot read group reports')
    return schools
  }
  const home = c.id.homeInstitutionId
  if (!home) throw forbidden()
  const admin = await c.env.CONTROL.prepare(`SELECT 1 AS x FROM school_group_admins WHERE group_id = ? AND user_id = ? AND home_institution_id = ?`)
    .bind(groupId, c.id.userId, home).first()
  // Same answer for "no such group" and "not yours": ids cannot be probed.
  if (!admin) throw new HttpError(403, 'you are not an admin of that group', { code: 'not_a_group_admin' })
  const held = await c.env.CONTROL.prepare(`SELECT institution_id FROM board_memberships WHERE user_id = ? AND home_institution_id = ?`)
    .bind(c.id.userId, home).all<{ institution_id: string }>()
  const allowed = new Set(held.results.map((r) => r.institution_id).concat(home))
  return schools.filter((s) => allowed.has(s.id))
}

export function registerSchoolGroups(r: Router): void {
  // ---- seller side ----
  r.get('/seller/school-groups', PERM, async (c) => {
    requirePlatformAdmin(c)
    const groups = await c.env.CONTROL.prepare(`SELECT id, name, created_at FROM school_groups ORDER BY name`).all<Group>()
    const items = await Promise.all(groups.results.map(async (g) => {
      const schools = await groupSchools(c.env, g.id)
      const nums = await Promise.all(schools.map((s) => schoolNumbers(c.env, s)))
      return {
        ...g,
        schools: schools.map((s, i) => ({ id: s.id, name: s.name, short_name: s.short_name, status: s.status, ...nums[i] })),
        totals: sum(nums),
        admins: await admins(c.env, g.id),
      }
    }))
    const ungrouped = await c.env.CONTROL.prepare(`SELECT id, name FROM institutions WHERE id NOT IN (SELECT institution_id FROM school_group_members) ORDER BY name`)
      .all<{ id: string; name: string }>()
    return ok({ items, ungrouped: ungrouped.results })
  })

  r.post('/seller/school-groups', PERM, async (c) => {
    requirePlatformAdmin(c)
    const req = await readJSON<{ name?: string; institution_ids?: string[] }>(c.req)
    const name = (req.name ?? '').trim()
    if (!name || name.length > 120) throw badRequest('the group needs a name (at most 120 characters)')
    const ids = [...new Set((req.institution_ids ?? []).map(String))]
    for (const id of ids) if (!isUUID(id)) throw badRequest('each institution_id must be a uuid')
    const id = uuid(), t = now()
    try {
      await c.env.CONTROL.batch([
        c.env.CONTROL.prepare(`INSERT INTO school_groups (id, name, created_by, created_at, updated_at) VALUES (?,?,?,?,?)`).bind(id, name, c.id.userId, t, t),
        ...ids.map((i) => c.env.CONTROL.prepare(`INSERT INTO school_group_members (institution_id, group_id, created_at) VALUES (?,?,?)`).bind(i, id, t)),
      ])
    } catch (e) {
      if (e instanceof Error && /UNIQUE|PRIMARY KEY/i.test(e.message)) throw conflict('a group with that name exists, or one of those schools is already in a group')
      if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) throw badRequest('one of those schools does not exist')
      throw e
    }
    await recordEvent(c.env, null, name, `group created with ${ids.length} schools`, c.id.userId)
    return created({ id, name })
  })

  r.put('/seller/school-groups/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const g = await groupOr404(c.env, uuidParam(c.params.id))
    const req = await readJSON<{ name?: string }>(c.req)
    const name = (req.name ?? '').trim()
    if (!name || name.length > 120) throw badRequest('the group needs a name (at most 120 characters)')
    try {
      await c.env.CONTROL.prepare(`UPDATE school_groups SET name = ?, updated_at = ? WHERE id = ?`).bind(name, now(), g.id).run()
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message)) throw conflict('a group with that name exists')
      throw e
    }
    return ok({ id: g.id, name })
  })

  r.del('/seller/school-groups/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const g = await groupOr404(c.env, uuidParam(c.params.id))
    // What the group granted goes with it; the schools and their data stay.
    await revokeGroupGrants(c.env, g.id, null, null)
    await c.env.CONTROL.prepare(`DELETE FROM school_groups WHERE id = ?`).bind(g.id).run()
    await recordEvent(c.env, null, g.name, 'group deleted', c.id.userId)
    return ok({ removed: true })
  })

  r.post('/seller/school-groups/{id}/schools', PERM, async (c) => {
    requirePlatformAdmin(c)
    const g = await groupOr404(c.env, uuidParam(c.params.id))
    const req = await readJSON<{ institution_id?: string }>(c.req)
    if (!isUUID(req.institution_id)) throw badRequest('institution_id must be a uuid')
    const inst = await institutionById(c.env, req.institution_id)
    if (!inst) throw badRequest('that school does not exist')
    const other = await c.env.CONTROL.prepare(`SELECT g.name FROM school_group_members m JOIN school_groups g ON g.id = m.group_id WHERE m.institution_id = ?`)
      .bind(inst.id).first<{ name: string }>()
    if (other) throw new HttpError(409, `that school is already in ${other.name}; remove it there first`, { code: 'already_grouped' })
    await c.env.CONTROL.prepare(`INSERT INTO school_group_members (institution_id, group_id, created_at) VALUES (?,?,?)`).bind(inst.id, g.id, now()).run()
    // The group's admins now oversee this school too.
    for (const a of await admins(c.env, g.id)) {
      if (a.home_institution_id === inst.id || (!a.email && !a.phone)) continue
      await grantBoardMember(c.env, c.id.userId, { fullName: a.full_name, email: a.email, phone: a.phone, institutionIds: [a.home_institution_id, inst.id], viaGroup: g.id })
    }
    await recordEvent(c.env, inst.id, g.name, `${inst.name} joined the group`, c.id.userId)
    return created({ group_id: g.id, institution_id: inst.id })
  })

  r.del('/seller/school-groups/{id}/schools/{instID}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const g = await groupOr404(c.env, uuidParam(c.params.id))
    const instId = uuidParam(c.params.instID, 'instID')
    const home = await c.env.CONTROL.prepare(`SELECT 1 AS x FROM school_group_admins WHERE group_id = ? AND home_institution_id = ?`).bind(g.id, instId).first()
    if (home) throw new HttpError(409, 'a group admin signs in at that school; remove the admin first', { code: 'admin_home' })
    const res = await c.env.CONTROL.prepare(`DELETE FROM school_group_members WHERE group_id = ? AND institution_id = ?`).bind(g.id, instId).run()
    if (!res.meta.changes) throw notFound('that school is not in this group')
    await revokeGroupGrants(c.env, g.id, null, instId)
    await recordEvent(c.env, instId, g.name, 'school left the group', c.id.userId)
    return ok({ removed: true })
  })

  r.post('/seller/school-groups/{id}/admins', PERM, async (c) => {
    requirePlatformAdmin(c)
    const g = await groupOr404(c.env, uuidParam(c.params.id))
    const req = await readJSON<{ full_name?: string; email?: string; phone?: string; home_institution_id?: string }>(c.req)
    const schools = await groupSchools(c.env, g.id)
    if (schools.length === 0) throw badRequest('add schools to the group first')
    const homeId = req.home_institution_id ?? schools[0].id
    if (!schools.some((s) => s.id === homeId)) throw badRequest('the admin signs in at one of the group\'s schools')
    const resp = await grantBoardMember(c.env, c.id.userId, {
      fullName: req.full_name, email: req.email, phone: req.phone, viaGroup: g.id,
      institutionIds: [homeId, ...schools.map((s) => s.id).filter((s) => s !== homeId)],
    })
    const actualHome = String(resp.home_school)
    await c.env.CONTROL.prepare(`INSERT OR IGNORE INTO school_group_admins (group_id, user_id, home_institution_id, created_at) VALUES (?,?,?,?)`)
      .bind(g.id, String(resp.user_id), actualHome, now()).run()
    await recordEvent(c.env, actualHome, g.name, `group admin ${String(resp.full_name)} added`, c.id.userId)
    return created(resp)
  })

  r.del('/seller/school-groups/{id}/admins/{userID}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const g = await groupOr404(c.env, uuidParam(c.params.id))
    const userId = uuidParam(c.params.userID, 'userID')
    const res = await c.env.CONTROL.prepare(`DELETE FROM school_group_admins WHERE group_id = ? AND user_id = ?`).bind(g.id, userId).run()
    if (!res.meta.changes) throw notFound('that person is not an admin of this group')
    await revokeGroupGrants(c.env, g.id, userId, null)
    await recordEvent(c.env, null, g.name, 'group admin removed', c.id.userId)
    return ok({ removed: true })
  })

  // ---- group admin side ----
  r.get('/me/groups', 'auth', async (c) => {
    try {
      if (c.id.platformAdmin) {
        if (c.id.restricted) return ok({ items: [] })
        const all = await c.env.CONTROL.prepare(`SELECT id, name FROM school_groups ORDER BY name`).all<{ id: string; name: string }>()
        return ok({ items: all.results })
      }
      if (!c.id.homeInstitutionId) return ok({ items: [] })
      const mine = await c.env.CONTROL.prepare(`SELECT g.id, g.name FROM school_group_admins a JOIN school_groups g ON g.id = a.group_id
          WHERE a.user_id = ? AND a.home_institution_id = ? ORDER BY g.name`).bind(c.id.userId, c.id.homeInstitutionId).all<{ id: string; name: string }>()
      return ok({ items: mine.results })
    } catch { return ok({ items: [] }) } // control_school_groups.sql not applied yet
  })

  r.get('/groups/{id}/dashboard', 'auth', async (c) => {
    const id = uuidParam(c.params.id)
    const schools = await readableSchools(c, id)
    const g = await groupOr404(c.env, id)
    const nums = await Promise.all(schools.map((s) => schoolNumbers(c.env, s)))
    return ok({
      id: g.id, name: g.name,
      totals: { schools: schools.length, ...sum(nums) },
      schools: schools.map((s, i) => ({ id: s.id, name: s.name, short_name: s.short_name, status: s.status, ...nums[i] })),
    })
  })
}
