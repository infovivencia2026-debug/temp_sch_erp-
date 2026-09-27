import type { Ctx, Router } from '../../router'
import type { Env } from '../../env'
import { badRequest, conflict, created, isUUID, notFound, now, ok, readJSON, uuid, uuidParam } from '../../http'
import { requirePlatformAdmin } from './common'

/* Targeted platform announcements: platform_broadcasts plus
   platform_broadcast_targets (who) and platform_broadcast_reads (seen /
   dismissed, per school user). See db/changes/control_features.sql. A
   broadcast with no target row is for every school and every audience, so
   the older /seller/broadcasts routes keep working unchanged. */

const PERM = 'platform.tenants.write'
const KINDS = ['all', 'group', 'plan', 'schools'] as const
const AUDIENCES = ['admins', 'staff', 'parents'] as const
type Kind = typeof KINDS[number]
type Audience = typeof AUDIENCES[number]

interface Row {
  id: string; severity: string; title: string; body: string; starts_at: string; ends_at: string | null
  retired_at: string | null; created_at: string; target_kind: string | null; target_ids: string | null; audiences: string | null
}
const SELECT = `SELECT b.id, b.severity, b.title, b.body, b.starts_at, b.ends_at, b.retired_at, b.created_at,
    t.target_kind, t.target_ids, t.audiences
  FROM platform_broadcasts b LEFT JOIN platform_broadcast_targets t ON t.broadcast_id = b.id`

const list = (s: string | null, def: string[]): string[] => {
  try { const v = JSON.parse(s ?? ''); return Array.isArray(v) ? v.map(String) : def } catch { return def }
}
const target = (r: Row) => ({
  kind: (r.target_kind ?? 'all') as Kind,
  ids: list(r.target_ids, []),
  audiences: list(r.audiences, [...AUDIENCES]) as Audience[],
})

/** Latest plan and group of every school, for reach and for matching. */
async function schoolFacts(env: Env): Promise<{ id: string; name: string; plan: string; group: string | null }[]> {
  const rows = await env.CONTROL.prepare(`SELECT i.id, i.name,
      COALESCE((SELECT s.plan_code FROM subscriptions s WHERE s.institution_id = i.id ORDER BY s.started_on DESC LIMIT 1), '') AS plan,
      (SELECT m.group_id FROM school_group_members m WHERE m.institution_id = i.id) AS grp
    FROM institutions i ORDER BY i.name`).all<{ id: string; name: string; plan: string; grp: string | null }>()
  return rows.results.map((r) => ({ id: r.id, name: r.name, plan: r.plan, group: r.grp }))
}
function reaches(t: ReturnType<typeof target>, s: { id: string; plan: string; group: string | null }): boolean {
  switch (t.kind) {
    case 'all': return true
    case 'group': return s.group !== null && t.ids.includes(s.group)
    case 'plan': return t.ids.includes(s.plan)
    case 'schools': return t.ids.includes(s.id)
  }
}

/* --- the school side --------------------------------------------------------- */

function audiencesOf(c: Ctx): Set<Audience> {
  if (c.id.platformAdmin) return new Set(AUDIENCES)
  const r = c.id.roles
  const out = new Set<Audience>()
  if (r.includes('parent') || r.includes('student')) out.add('parents')
  if (r.includes('institution_admin') || r.includes('principal')) out.add('admins')
  if (r.some((k) => k !== 'parent' && k !== 'student')) out.add('staff')
  return out
}

/** GET /platform-notices: what this user should see now, not yet dismissed. */
export async function liveAnnouncements(c: Ctx): Promise<Response> {
  const t = now()
  const rows = (await c.env.CONTROL.prepare(`${SELECT}
     WHERE b.retired_at IS NULL AND b.starts_at <= ? AND (b.ends_at IS NULL OR b.ends_at > ?)
     ORDER BY CASE b.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, b.starts_at DESC LIMIT 50`).bind(t, t).all<Row>()).results
  const inst = c.id.institution
  let fact: { id: string; plan: string; group: string | null } | null = null
  let reads = new Map<string, { seen: boolean; dismissed: boolean }>()
  if (inst) {
    fact = (await schoolFacts(c.env)).find((s) => s.id === inst.id) ?? { id: inst.id, plan: '', group: null }
    const r = await c.env.CONTROL.prepare(`SELECT broadcast_id, dismissed_at FROM platform_broadcast_reads WHERE institution_id = ? AND user_id = ?`)
      .bind(inst.id, c.id.userId).all<{ broadcast_id: string; dismissed_at: string | null }>()
    reads = new Map(r.results.map((x) => [x.broadcast_id, { seen: true, dismissed: x.dismissed_at !== null }]))
  }
  const mine = audiencesOf(c)
  const items = []
  for (const v of rows) {
    const tg = target(v)
    if (fact && !reaches(tg, fact)) continue
    if (!tg.audiences.some((a) => mine.has(a))) continue
    const rd = reads.get(v.id)
    if (rd?.dismissed) continue
    const o: Record<string, unknown> = { id: v.id, severity: v.severity, title: v.title }
    if (v.body) o.body = v.body
    o.starts_at = v.starts_at.slice(0, 16)
    if (v.ends_at !== null) o.ends_at = v.ends_at.slice(0, 16)
    o.live = true
    o.seen = !!rd?.seen
    items.push(o)
    if (items.length === 5) break
  }
  return ok({ items })
}

async function mark(c: Ctx, dismiss: boolean): Promise<Response> {
  const bid = uuidParam(c.params.id)
  const inst = c.id.institution
  if (!inst) return ok({ saved: false })
  const t = now()
  await c.env.CONTROL.prepare(`INSERT INTO platform_broadcast_reads (broadcast_id, institution_id, user_id, seen_at, dismissed_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM platform_broadcasts WHERE id = ?)
      ON CONFLICT (broadcast_id, institution_id, user_id) DO UPDATE SET dismissed_at = COALESCE(excluded.dismissed_at, dismissed_at)`)
    .bind(bid, inst.id, c.id.userId, t, dismiss ? t : null, bid).run()
  return ok({ saved: true })
}

/* --- the seller side ----------------------------------------------------------- */

interface Body { severity?: string; title?: string; body?: string; starts_at?: string; ends_at?: string | null
  target?: { kind?: string; ids?: string[] }; audiences?: string[] }

function when(v: string | null | undefined, name: string): string | null {
  const s = (v ?? '').trim()
  if (s === '') return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? s + ':00Z' : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s)
  if (Number.isNaN(d.getTime())) throw badRequest(name + ' must be a date and time')
  return d.toISOString()
}
function validate(req: Body) {
  const title = (req.title ?? '').trim()
  if (title === '') throw badRequest('an announcement needs a title')
  const severity = req.severity || 'info'
  if (!['info', 'warning', 'critical'].includes(severity)) throw badRequest('severity must be info, warning or critical')
  const kind = (req.target?.kind || 'all') as Kind
  if (!KINDS.includes(kind)) throw badRequest('target.kind must be all, group, plan or schools')
  const ids = kind === 'all' ? [] : [...new Set((req.target?.ids ?? []).map(String).filter(Boolean))]
  if (kind !== 'all' && ids.length === 0) throw badRequest('choose at least one ' + (kind === 'schools' ? 'school' : kind))
  const audiences = [...new Set(req.audiences ?? AUDIENCES)].filter((a): a is Audience => (AUDIENCES as readonly string[]).includes(a))
  if (audiences.length === 0) throw badRequest('choose at least one audience: admins, staff or parents')
  const starts = when(req.starts_at, 'starts_at') ?? now()
  const ends = when(req.ends_at, 'ends_at')
  if (ends !== null && ends <= starts) throw badRequest('that announcement ends before it starts')
  return { title, severity, kind, ids, audiences, starts, ends, body: (req.body ?? '').trim() }
}

export function registerSellerAnnouncements(r: Router): void {
  r.post('/platform-notices/{id}/seen', 'auth', (c) => mark(c, false))
  r.post('/platform-notices/{id}/dismiss', 'auth', (c) => mark(c, true))

  r.get('/seller/announcements', PERM, async (c) => {
    requirePlatformAdmin(c)
    const t = now()
    const [rows, schools, reads] = await Promise.all([
      c.env.CONTROL.prepare(`${SELECT} ORDER BY b.starts_at DESC LIMIT 100`).all<Row>(),
      schoolFacts(c.env),
      c.env.CONTROL.prepare(`SELECT broadcast_id, count(DISTINCT institution_id) AS schools, count(*) AS users,
          sum(dismissed_at IS NOT NULL) AS dismissed FROM platform_broadcast_reads GROUP BY broadcast_id`)
        .all<{ broadcast_id: string; schools: number; users: number; dismissed: number }>(),
    ])
    const rd = new Map(reads.results.map((x) => [x.broadcast_id, x]))
    return ok({ items: rows.results.map((v) => {
      const tg = target(v)
      const reach = schools.filter((s) => reaches(tg, s)).length
      const x = rd.get(v.id)
      const status = v.retired_at ? 'retired' : v.starts_at > t ? 'scheduled' : v.ends_at !== null && v.ends_at <= t ? 'ended' : 'live'
      return { id: v.id, severity: v.severity, title: v.title, body: v.body, starts_at: v.starts_at, ends_at: v.ends_at,
        retired_at: v.retired_at, created_at: v.created_at, status, target: { kind: tg.kind, ids: tg.ids }, audiences: tg.audiences,
        reach_schools: reach, seen_schools: x?.schools ?? 0, seen_users: x?.users ?? 0, dismissed_users: x?.dismissed ?? 0,
        read_rate: reach > 0 ? Math.round(((x?.schools ?? 0) / reach) * 100) : 0 }
    }), schools: schools.map((s) => ({ id: s.id, name: s.name, plan: s.plan, group_id: s.group })) })
  })

  r.post('/seller/announcements', PERM, async (c) => {
    requirePlatformAdmin(c)
    const v = validate(await readJSON<Body>(c.req))
    const id = uuid(), t = now()
    await c.env.CONTROL.batch([
      c.env.CONTROL.prepare(`INSERT INTO platform_broadcasts (id, severity, title, body, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, v.severity, v.title, v.body, v.starts, v.ends, c.id.userId, t),
      c.env.CONTROL.prepare(`INSERT INTO platform_broadcast_targets (broadcast_id, target_kind, target_ids, audiences, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(id, v.kind, JSON.stringify(v.ids), JSON.stringify(v.audiences), t),
    ])
    return created({ id })
  })

  r.put('/seller/announcements/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const id = uuidParam(c.params.id)
    const cur = await c.env.CONTROL.prepare(`SELECT retired_at FROM platform_broadcasts WHERE id = ?`).bind(id).first<{ retired_at: string | null }>()
    if (!cur) throw notFound('no such announcement')
    if (cur.retired_at) throw conflict('that announcement is retired; raise a new one')
    const v = validate(await readJSON<Body>(c.req))
    const t = now()
    await c.env.CONTROL.batch([
      c.env.CONTROL.prepare(`UPDATE platform_broadcasts SET severity = ?, title = ?, body = ?, starts_at = ?, ends_at = ? WHERE id = ?`)
        .bind(v.severity, v.title, v.body, v.starts, v.ends, id),
      c.env.CONTROL.prepare(`INSERT INTO platform_broadcast_targets (broadcast_id, target_kind, target_ids, audiences, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (broadcast_id) DO UPDATE SET target_kind = excluded.target_kind, target_ids = excluded.target_ids,
          audiences = excluded.audiences, updated_at = excluded.updated_at`)
        .bind(id, v.kind, JSON.stringify(v.ids), JSON.stringify(v.audiences), t),
    ])
    return ok({ saved: true })
  })

  r.post('/seller/announcements/{id}/retire', PERM, async (c) => {
    requirePlatformAdmin(c)
    const id = uuidParam(c.params.id)
    const res = await c.env.CONTROL.prepare(`UPDATE platform_broadcasts SET retired_at = ? WHERE id = ? AND retired_at IS NULL`).bind(now(), id).run()
    if ((res.meta.changes ?? 0) === 0) throw conflict('that announcement is already retired, or there is no such announcement')
    return ok({ retired: true })
  })

  // Per school: who has seen and dismissed it.
  r.get('/seller/announcements/{id}/reads', PERM, async (c) => {
    requirePlatformAdmin(c)
    const id = c.params.id
    if (!isUUID(id)) throw badRequest('invalid id')
    const b = await c.env.CONTROL.prepare(`${SELECT} WHERE b.id = ?`).bind(id).first<Row>()
    if (!b) throw notFound('no such announcement')
    const tg = target(b)
    const rows = await c.env.CONTROL.prepare(`SELECT institution_id, count(*) AS seen, sum(dismissed_at IS NOT NULL) AS dismissed, max(seen_at) AS last_seen
        FROM platform_broadcast_reads WHERE broadcast_id = ? GROUP BY institution_id`).bind(id)
      .all<{ institution_id: string; seen: number; dismissed: number; last_seen: string }>()
    const by = new Map(rows.results.map((x) => [x.institution_id, x]))
    const items = (await schoolFacts(c.env)).filter((s) => reaches(tg, s) || by.has(s.id)).map((s) => ({
      id: s.id, name: s.name, seen_users: by.get(s.id)?.seen ?? 0, dismissed_users: by.get(s.id)?.dismissed ?? 0, last_seen: by.get(s.id)?.last_seen ?? null }))
    return ok({ items })
  })
}
