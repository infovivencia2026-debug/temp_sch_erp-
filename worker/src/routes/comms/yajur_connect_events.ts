/* Yajur Connect Events: the upcoming published school events (made in the
   ERP's School Calendar) so the office can send a reminder to the right
   parents. Read only: nothing is created, changed or scheduled here. */
import type { Router } from '../../router'
import { ok } from '../../http'

export function registerYajurConnectEvents(r: Router, perm: string): void {
  r.get('/comms/yajur-connect/events', perm, async (c) => {
    const rows = await c.db.prepare(`SELECT e.id, e.name, e.kind, e.on_date, e.ends_on, substr(e.starts_at, 1, 5) AS starts_at, e.venue, e.section_id,
          CASE WHEN e.section_id IS NULL THEN 'Whole school' ELSE trim(coalesce(cl.name, '') || ' ' || coalesce(sec.name, '')) END AS who
        FROM school_events e
        LEFT JOIN sections sec ON sec.id = e.section_id
        LEFT JOIN classes cl ON cl.id = sec.class_id
        WHERE e.is_published = 1 AND coalesce(e.ends_on, e.on_date) >= date('now')
        ORDER BY e.on_date, e.starts_at, e.name LIMIT 100`)
      .all<{ id: string; name: string; kind: string; on_date: string; ends_on: string | null; starts_at: string | null; venue: string | null; section_id: string | null; who: string }>()
    return ok({
      items: rows.results.map((e) => ({
        id: e.id, name: e.name, kind: e.kind, on_date: e.on_date, ends_on: e.ends_on, starts_at: e.starts_at || null, venue: e.venue || null,
        section_id: e.section_id, who: e.who || 'Whole school',
      })),
    })
  })
}
