import { cn, WEEKDAYS } from '@/lib/utils'
import { Badge } from '@/components/ui'
import { usePhone } from '@/lib/viewport'
import DayTimeline from '@/components/DayTimeline'
import type { Period } from '@/lib/api'

/* The week, as it is pinned to the staff-room wall.
 *
 * One grid, used by everybody who looks at a timetable: the principal reading
 * the whole school, a head of department checking a class or a teacher, the
 * class teacher who owns it, and the subject teacher reading their own week.
 * Each screen used to draw its own (a flat list, a transposed grid, a grid of
 * hand-tinted boxes), so the same information had to be re-learned on each
 * screen and none of them matched the rest of the app.
 *
 * Desk: periods down the side and days across the top, because that is the
 * shape every school already prints. Breaks run the full width. The table
 * scrolls sideways inside its own frame, never the page. Today's column is
 * tinted and the period running now is ringed.
 *
 * Phone: six columns do not fit 360px, so the week becomes one day at a time:
 * day buttons on top (today first chosen) and that day's periods as a list.
 *
 * Colours are tokens only: card, muted, border, primary for "yours" and
 * "now", warning for a period with nobody to teach it.
 */

export interface WeekPeriod {
  id: string
  name: string
  starts_at: string
  ends_at?: string
  is_break?: boolean
}

export interface WeekEntry {
  weekday: number
  period_id: string
  /** What is taught. A name, not a code — "General Science", not GSCI. */
  title: string
  /** Who teaches it, or which class it is, depending on whose week this is. */
  detail?: string | null
  /** Draws the detail as a warning: a period with nobody to teach it. */
  unstaffed?: boolean
  /** The viewer's own period, on somebody else's week. */
  mine?: boolean
  room?: string | null
}

const time = (p: WeekPeriod) =>
  p.ends_at ? `${p.starts_at.slice(0, 5)}–${p.ends_at.slice(0, 5)}` : p.starts_at.slice(0, 5)

function nowParts() {
  const now = new Date()
  return {
    today: ((now.getDay() + 6) % 7) + 1,
    hhmm: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  }
}

function Lesson({ e, live, className }: { e: WeekEntry; live: boolean; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5 rounded-md border bg-card px-2.5 py-2',
      e.mine && 'border-l-[3px] border-l-primary bg-primary/[0.06]',
      live && 'ring-2 ring-primary', className)}>
      <span className="truncate text-[13px] font-semibold leading-snug">{e.title}</span>
      {e.detail && (
        <span className={cn('truncate text-[12px] leading-snug', e.unstaffed ? 'text-warning' : 'text-muted-foreground')}>{e.detail}</span>
      )}
      {e.room && <Badge className="mt-1 w-fit">{e.room}</Badge>}
    </div>
  )
}

function Free({ live, className }: { live: boolean; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center rounded-md border border-dashed text-[12px] text-muted-foreground',
      live && 'ring-2 ring-primary', className)}>
      Free
    </div>
  )
}

export default function WeekGrid({
  entries,
  periods,
  weekdays,
  empty = 'Nothing timetabled yet.',
  id,
}: {
  entries: WeekEntry[]
  periods: WeekPeriod[]
  /** ISO weekdays the school runs, 1 = Monday. Defaults to Monday–Saturday. */
  weekdays?: number[]
  empty?: string
  /** For printing: the element printDocument() copies. */
  id?: string
}) {
  const phone = usePhone()
  const days = weekdays?.length ? weekdays : [1, 2, 3, 4, 5, 6]
  const { today, hhmm } = nowParts()

  // One lookup rather than a scan per cell.
  const at = new Map<string, WeekEntry>()
  for (const e of entries) at.set(`${e.weekday}:${e.period_id}`, e)

  if (!periods.some((p) => !p.is_break)) {
    return <p className="py-6 text-center text-[13.5px] text-muted-foreground">The school day has no periods yet, so there is nothing to lay a timetable on.</p>
  }
  if (entries.length === 0) return <p className="py-6 text-center text-[13.5px] text-muted-foreground">{empty}</p>

  const isLive = (d: number, p: WeekPeriod) =>
    d === today && !!p.ends_at && p.starts_at.slice(0, 5) <= hhmm && hhmm < p.ends_at.slice(0, 5)

  /* ON A PHONE, THE DAY AS A TIMELINE (Yajur, 2026-10-24: "timetable is not
     like timeline in phones"): the same day strip, times down the left and a
     card per period as the teacher's own timetable, for every week grid. */
  if (phone) {
    return (
      <div id={id}>
        <DayTimeline bare who="" where=""
          periods={periods.map((p) => ({ ...p, ends_at: p.ends_at ?? p.starts_at, bell_schedule_id: null }) as unknown as Period)}
          entries={entries.map((e) => ({ weekday: e.weekday, period_id: e.period_id, title: e.title, detail: [e.detail, e.room].filter(Boolean).join(' · ') || undefined }))} />
      </div>
    )
  }

  return (
    <div id={id} className="scroll-x rounded-lg border">
      <table className="w-full min-w-[48rem] table-fixed border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="w-28 border-b bg-muted/50 px-3 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Period</th>
            {days.map((d) => (
              <th key={d} className={cn('border-b border-l px-3 py-2.5 text-left text-[12px] font-medium',
                d === today ? 'bg-primary/[0.07] text-primary' : 'bg-muted/50 text-muted-foreground')}>
                {WEEKDAYS[d - 1] ?? `Day ${d}`}{d === today ? ' · today' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => p.is_break ? (
            <tr key={p.id}>
              <td colSpan={days.length + 1} className="border-b bg-muted/50 px-3 py-1.5 text-center text-[12px] text-muted-foreground">
                {p.name} · {time(p)}
              </td>
            </tr>
          ) : (
            <tr key={p.id} className="align-top">
              <td className="border-b px-3 py-2.5">
                <div className="font-semibold">{p.name}</div>
                <div className="text-[12px] tabular-nums text-muted-foreground">{time(p)}</div>
              </td>
              {days.map((d) => {
                const e = at.get(`${d}:${p.id}`)
                const live = isLive(d, p)
                return (
                  <td key={d} className={cn('border-b border-l p-1.5', d === today && 'bg-primary/[0.03]')}>
                    {e ? <Lesson e={e} live={live} className="min-h-[4rem]" /> : <Free live={live} className="min-h-[4rem]" />}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
