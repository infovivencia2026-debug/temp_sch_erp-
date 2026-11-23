/* Yajur Connect Events: the upcoming entries of the ERP's School Calendar
   (the holidays table: holidays, events, exams, PTMs) plus any published
   school_events, so the office can send a reminder to the right parents
   (owner, 2026-11-23: "in the school calendar there are events and
   reminders"). Read only: nothing is created, changed or scheduled here. */
import type { Router } from '../../router'
import { ok } from '../../http'

interface Row { id: string; name: string; kind: string; on_date: string; ends_on: string | null; starts_at: string | null; venue: string | null; section_id: string | null; who: string | null; applies_to: string | null }

/* applies_to on a calendar entry: 'all', or who it is for (students / staff / a class). */
const whoOf = (applies: string | null): string => {
  const a = (applies ?? '').trim().toLowerCase()
  if (!a || a === 'all') return 'Whole school'
  if (a === 'students') return 'Students'
  if (a === 'staff') return 'Staff'
  return applies!.trim()
}

export function registerYajurConnectEvents(r: Router, perm: string): void {
  r.get('/comms/yajur-connect/events', perm, async (c) => {
    const rows = await c.db.prepare(`
      SELECT h.id, h.name, h.kind, h.on_date, h.to_date AS ends_on, NULL AS starts_at, NULL AS venue, NULL AS section_id, NULL AS who, h.applies_to
        FROM holidays h
       WHERE coalesce(h.to_date, h.on_date) >= date('now')
      UNION ALL
      SELECT e.id, e.name, e.kind, e.on_date, e.ends_on, substr(e.starts_at, 1, 5), e.venue, e.section_id,
             CASE WHEN e.section_id IS NULL THEN NULL ELSE trim(coalesce(cl.name, '') || ' ' || coalesce(sec.name, '')) END, NULL
        FROM school_events e
        LEFT JOIN sections sec ON sec.id = e.section_id
        LEFT JOIN classes cl ON cl.id = sec.class_id
       WHERE e.is_published = 1 AND coalesce(e.ends_on, e.on_date) >= date('now')
      ORDER BY 4, 6, 2 LIMIT 200`).all<Row>()
    return ok({
      items: rows.results.map((e) => ({
        id: e.id, name: e.name, kind: e.kind, on_date: e.on_date, ends_on: e.ends_on, starts_at: e.starts_at || null, venue: e.venue || null,
        section_id: e.section_id, who: e.who || whoOf(e.applies_to),
      })),
    })
  })
}
