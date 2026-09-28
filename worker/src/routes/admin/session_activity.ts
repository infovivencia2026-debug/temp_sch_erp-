import type { Router, Ctx } from '../../router'
import { badRequest, forbidden, isUUID, like, notFound, now, ok, readJSON } from '../../http'
import { auditStmt, inList, institutionId, parseJSON } from './common'
import { activitySettings, DEFAULT_RETENTION_DAYS, MODULE } from '../../services/session_activity'

/* Session activity: the school's switch and what it recorded
   (services/session_activity.ts). Reading needs admin.audit.read, the key the
   existing sign-in and audit screens use; switching recording on or off needs
   institution.settings.write; ending a live session stays on the existing
   DELETE /admin/sessions/{id} (access.sessions.revoke). */

interface Row {
  session_id: string; user_id: string; via: string | null; signed_in_at: string; signed_out_at: string | null; ended_reason: string | null
  ip: string | null; device: string | null; browser: string | null; os: string | null; city: string | null; region: string | null; country: string | null
  last_active_at: string | null; active_seconds: number; screens: number; changes: number; full_name: string | null
}

async function listRows(c: Ctx, max: number) {
  const q = c.url.searchParams
  const user = (q.get('user') ?? '').trim()
  if (user && !isUUID(user)) throw badRequest('invalid user id')
  const day = (k: string) => {
    const v = (q.get(k) ?? '').trim()
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`${k} must be YYYY-MM-DD`)
    return v || null
  }
  const from = day('from'), to = day('to')
  const name = (q.get('q') ?? '').trim()
  const status = q.get('status') ?? ''
  const rows = await c.db.prepare(`SELECT a.*, u.full_name,
      (SELECT count(*) FROM session_activity_views v WHERE v.session_id = a.session_id) AS screens,
      (SELECT count(*) FROM audit_log l WHERE l.session_id = a.session_id) AS changes
      FROM session_activity a LEFT JOIN users u ON u.id = a.user_id
      WHERE (?1 IS NULL OR a.user_id = ?1) AND (?2 IS NULL OR a.signed_in_at >= ?2) AND (?3 IS NULL OR a.signed_in_at < date(?3, '+1 day'))
        AND (?4 IS NULL OR u.full_name LIKE ?4 ESCAPE '\\')
      ORDER BY a.signed_in_at DESC LIMIT ?5`)
    .bind(user || null, from, to, name ? like(name) : null, max).all<Row>()
  // Whether each is still live is CONTROL's to say (sessions).
  const ids = rows.results.map((r) => r.session_id)
  const iq = inList(ids)
  const live = ids.length ? await c.env.CONTROL.prepare(`SELECT id, revoked_at, ended_reason, expires_at, last_seen_at FROM sessions WHERE institution_id = ? AND id IN ${iq.sql}`)
    .bind(institutionId(c), ...iq.args).all<{ id: string; revoked_at: string | null; ended_reason: string | null; expires_at: string; last_seen_at: string }>() : { results: [] }
  const byId = new Map(live.results.map((s) => [s.id, s]))
  const t = now()
  const items = rows.results.map((r) => {
    const s = byId.get(r.session_id)
    const isLive = !!s && !s.revoked_at && s.expires_at > t && !r.signed_out_at
    const ended = r.signed_out_at ?? s?.revoked_at ?? (s && s.expires_at <= t ? s.expires_at : null)
    return {
      session_id: r.session_id, user_id: r.user_id, full_name: r.full_name ?? '(deleted user)', via: r.via ?? undefined,
      signed_in_at: r.signed_in_at, signed_out_at: ended ?? undefined, ended_reason: r.ended_reason ?? s?.ended_reason ?? (ended ? 'expired' : undefined),
      live: isLive, ip: r.ip ?? undefined, device: r.device ?? undefined, browser: r.browser ?? undefined, os: r.os ?? undefined,
      location: [r.city, r.region, r.country].filter(Boolean).join(', ') || undefined,
      last_active_at: [r.last_active_at, s?.last_seen_at].filter((x): x is string => !!x).sort().at(-1),
      active_seconds: r.active_seconds, screens: r.screens, changes: r.changes,
    }
  }).filter((r) => status === 'live' ? r.live : status === 'ended' ? !r.live : true)
  return items
}

const csvCell = (v: unknown) => {
  let s = v === undefined || v === null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s // no formulas in a spreadsheet
  return '"' + s.replace(/"/g, '""') + '"'
}

export function registerSessionActivity(r: Router): void {
  r.get('/admin/session-activity/settings', 'admin.audit.read', async (c) => {
    return ok({ ...(await activitySettings(c.env, institutionId(c), c.db)), default_retention_days: DEFAULT_RETENTION_DAYS })
  })

  r.put('/admin/session-activity/settings', 'institution.settings.write', async (c) => {
    const inst = institutionId(c)
    const b = await readJSON<{ enabled?: unknown; retention_days?: unknown }>(c.req)
    const cur = await activitySettings(c.env, inst, c.db)
    const enabled = typeof b.enabled === 'boolean' ? b.enabled : cur.enabled
    const days = b.retention_days === undefined ? cur.retention_days : Number(b.retention_days)
    if (!Number.isInteger(days) || days < 7 || days > 730) throw badRequest('retention_days must be a whole number from 7 to 730')
    if (enabled && cur.seller_blocked) throw forbidden('Session activity recording is not available for this school. Contact us to have it allowed.')
    await c.db.batch([
      c.db.prepare(`INSERT INTO module_settings (institution_id, module, enabled, config) VALUES (?, ?, ?, ?)
          ON CONFLICT (institution_id, module) DO UPDATE SET enabled = excluded.enabled, config = excluded.config`)
        .bind(inst, MODULE, enabled ? 1 : 0, JSON.stringify({ retention_days: days })),
      auditStmt(c, 'update', 'session_activity_settings', null, { enabled: cur.enabled, retention_days: cur.retention_days }, { enabled, retention_days: days }),
    ])
    return ok({ ...(await activitySettings(c.env, inst, c.db)), default_retention_days: DEFAULT_RETENTION_DAYS })
  })

  r.get('/admin/session-activity', 'admin.audit.read', async (c) => {
    return ok({ items: await listRows(c, 500) })
  })

  r.get('/admin/session-activity/export', 'admin.audit.read', async (c) => {
    const items = await listRows(c, 5000)
    const head = ['Name', 'Signed in', 'Signed out', 'How it ended', 'Live', 'Last active', 'Active minutes', 'Screens', 'Changes', 'Device', 'Browser', 'OS', 'IP', 'Approximate location', 'Session']
    const lines = [head.map(csvCell).join(',')]
    for (const x of items) lines.push([x.full_name, x.signed_in_at, x.signed_out_at, x.ended_reason, x.live ? 'yes' : 'no', x.last_active_at,
      Math.round(x.active_seconds / 60), x.screens, x.changes, x.device, x.browser, x.os, x.ip, x.location, x.session_id].map(csvCell).join(','))
    return new Response(lines.join('\r\n') + '\r\n', { headers: {
      'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="session-activity-${now().slice(0, 10)}.csv"` } })
  })

  r.get('/admin/session-activity/{id}', 'admin.audit.read', async (c) => {
    if (!isUUID(c.params.id)) throw badRequest('invalid session id')
    const a = await c.db.prepare(`SELECT a.*, u.full_name FROM session_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.session_id = ?`)
      .bind(c.params.id).first<Row>()
    if (!a) throw notFound('no activity recorded for this session')
    const s = await c.env.CONTROL.prepare(`SELECT revoked_at, ended_reason, expires_at, last_seen_at FROM sessions WHERE id = ? AND institution_id = ?`)
      .bind(c.params.id, institutionId(c)).first<{ revoked_at: string | null; ended_reason: string | null; expires_at: string; last_seen_at: string }>()
    const [views, changes] = await c.db.batch<Record<string, unknown>>([
      c.db.prepare(`SELECT id, screen, path, started_at, seconds FROM session_activity_views WHERE session_id = ? ORDER BY started_at, id LIMIT 2000`).bind(a.session_id),
      c.db.prepare(`SELECT id, created_at, action, entity_type, entity_id, before, after FROM audit_log WHERE session_id = ? ORDER BY id LIMIT 500`).bind(a.session_id),
    ])
    const t = now()
    const live = !!s && !s.revoked_at && s.expires_at > t && !a.signed_out_at
    return ok({
      session: {
        session_id: a.session_id, user_id: a.user_id, full_name: a.full_name ?? '(deleted user)', via: a.via ?? undefined,
        signed_in_at: a.signed_in_at, signed_out_at: a.signed_out_at ?? s?.revoked_at ?? undefined, ended_reason: a.ended_reason ?? s?.ended_reason ?? undefined,
        live, ip: a.ip ?? undefined, device: a.device ?? undefined, browser: a.browser ?? undefined, os: a.os ?? undefined,
        location: [a.city, a.region, a.country].filter(Boolean).join(', ') || undefined,
        last_active_at: [a.last_active_at, s?.last_seen_at].filter((x): x is string => !!x).sort().at(-1), active_seconds: a.active_seconds,
      },
      views: views.results,
      changes: changes.results.map((x) => ({ id: x.id, at: x.created_at, action: x.action, entity_type: x.entity_type, entity_id: x.entity_id ?? undefined,
        request: parseJSON<unknown>(x.before, undefined), response: parseJSON<unknown>(x.after, undefined) })),
    })
  })
}
