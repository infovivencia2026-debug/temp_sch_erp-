import type { Period } from '@/lib/api'
import type { DayEntry } from '@/components/DayTimeline'

/** A summary's "today" row (portal summary): no period id, just names and times. */
export interface SummaryPeriod {
  period: string; starts_at?: string; ends_at?: string
  subject: string; teacher?: string; room?: string
}

/* The portal summary lists today's periods flat. DayTimeline wants periods and
   entries, so build both from it: one period per row, one entry on today's
   weekday. Parent and student homes then show the same timeline as the
   teacher home (Yajur, 2026-10-24). */
export function todayTimeline(rows: SummaryPeriod[], now = new Date()): { periods: Period[]; entries: DayEntry[] } {
  const weekday = now.getDay() === 0 ? 7 : now.getDay()
  const periods: Period[] = []
  const entries: DayEntry[] = []
  rows.forEach((r, i) => {
    const id = `today-${i}`
    periods.push({ id, name: r.period, sequence: i + 1, starts_at: r.starts_at ?? '', ends_at: r.ends_at ?? '', is_break: false })
    entries.push({
      weekday, period_id: id, title: r.subject,
      detail: [r.teacher, r.room].filter(Boolean).join(' · ') || undefined,
    })
  })
  return { periods, entries }
}
