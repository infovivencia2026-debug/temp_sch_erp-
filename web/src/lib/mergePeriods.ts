/* ONE ROW PER PERIOD, HOWEVER MANY BELL SCHEDULES (Yajur, 2026-10-24).

   A school with several bell schedules has a "Period 1 09:15-10:00" in each,
   and a timetable fed every period of every schedule drew each as its own
   row: Assembly six times, Period 1 six times, mostly "Free". Same rule as
   Staff 360 on the server (worker/src/routes/hr/staff_record.ts): periods with
   the same name, start, end and break flag are one row. When there are
   entries, only the schedules those entries use are kept, so another
   group's periods never show as Free. Every entry is remapped to its row. */

export interface MergeablePeriod {
  id: string
  name: string
  starts_at: string
  ends_at?: string
  is_break?: boolean | number
  bell_schedule_id?: string | null
  sequence?: number
}

export function periodShape(p: MergeablePeriod): string {
  return `${p.name.trim().toLowerCase()}|${p.starts_at.slice(0, 5)}|${(p.ends_at ?? '').slice(0, 5)}|${p.is_break ? 1 : 0}`
}

export function mergePeriods<P extends MergeablePeriod, E extends { period_id: string }>(
  periods: P[],
  entries: E[],
): { periods: P[]; entries: E[] } {
  const used = new Set(entries.map((e) => e.period_id))
  const schedules = new Set(periods.filter((p) => used.has(p.id)).map((p) => p.bell_schedule_id ?? ''))
  // Without schedule ids (or entries) every period counts.
  const keep = (p: P) => used.has(p.id) || schedules.size === 0 || schedules.has(p.bell_schedule_id ?? '')
  const sorted = [...periods].sort((a, b) =>
    a.starts_at.localeCompare(b.starts_at) || (a.sequence ?? 0) - (b.sequence ?? 0))
  const rowOf = new Map<string, P>()
  const byShape = new Map<string, P>()
  const out: P[] = []
  for (const p of sorted) {
    if (rowOf.has(p.id) || !keep(p)) continue
    const k = periodShape(p)
    let row = byShape.get(k)
    if (!row) { row = p; byShape.set(k, p); out.push(p) }
    rowOf.set(p.id, row)
  }
  // Periods dropped as another schedule's still map, so no entry is lost.
  for (const p of sorted) if (!rowOf.has(p.id)) rowOf.set(p.id, byShape.get(periodShape(p)) ?? p)
  return {
    periods: out,
    entries: entries.map((e) => {
      const row = rowOf.get(e.period_id)
      return row && row.id !== e.period_id ? { ...e, period_id: row.id } : e
    }),
  }
}
