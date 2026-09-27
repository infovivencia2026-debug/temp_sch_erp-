import type { Router } from '../../router'
import { notFound, ok, uuidParam } from '../../http'
import type { Institution } from '../../tenant'
import { requirePlatformAdmin } from './common'
import { computeSchoolHealth, refreshHealthSnapshot, runUsageAlerts } from '../../services/background/health'

/* School health board (seller) and the school admin's usage banner.
   The board reads the CONTROL.school_health snapshot; the detail view
   recomputes one school live. */

const PERM = 'platform.tenants.write'

export function registerSchoolHealth(r: Router): void {
  r.get('/seller/health', PERM, async (c) => {
    requirePlatformAdmin(c)
    const rows = await c.env.CONTROL.prepare(`SELECT h.data, h.computed_at FROM school_health h JOIN institutions i ON i.id = h.institution_id
        WHERE i.status = 'active' ORDER BY i.name`).all<{ data: string; computed_at: string }>()
    const items = rows.results.map((x) => ({ ...JSON.parse(x.data), computed_at: x.computed_at }))
    const computed_at = rows.results.reduce<string | null>((m, x) => (!m || x.computed_at < m ? x.computed_at : m), null)
    return ok({ items, computed_at })
  })

  r.post('/seller/health/refresh', PERM, async (c) => {
    requirePlatformAdmin(c)
    const n = await refreshHealthSnapshot(c.env)
    return ok({ refreshed: n })
  })

  r.post('/seller/health/usage-alerts/run', PERM, async (c) => {
    requirePlatformAdmin(c)
    await runUsageAlerts(c.env)
    await refreshHealthSnapshot(c.env)
    return ok({ ok: true })
  })

  r.get('/seller/health/{id}', PERM, async (c) => {
    requirePlatformAdmin(c)
    const inst = await c.env.CONTROL.prepare(`SELECT * FROM institutions WHERE id = ?`).bind(uuidParam(c.params.id)).first<Institution>()
    if (!inst) throw notFound('no such school')
    const h = await computeSchoolHealth(c.env, inst)
    await c.env.CONTROL.prepare(`INSERT INTO school_health (institution_id, data, computed_at) VALUES (?, ?, ?)
        ON CONFLICT (institution_id) DO UPDATE SET data = excluded.data, computed_at = excluded.computed_at`)
      .bind(inst.id, JSON.stringify(h), new Date().toISOString()).run()
    return ok(h)
  })

  // The school admin's banner: this school's open plan-limit alerts.
  r.get('/usage-alerts', 'auth', async (c) => {
    const inst = c.id.institution
    if (!inst || !c.id.roles.includes('institution_admin')) return ok({ items: [] })
    const rows = await c.env.CONTROL.prepare(`SELECT metric, level, pct, message, raised_at FROM usage_alerts WHERE institution_id = ? ORDER BY level DESC`)
      .bind(inst.id).all()
    return ok({ items: rows.results })
  })
}
