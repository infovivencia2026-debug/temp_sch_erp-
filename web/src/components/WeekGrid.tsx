import { cn, WEEKDAYS } from '@/lib/utils'

/* The week, as it is pinned to the staff-room wall.
 *
 * One grid, used by everybody who looks at a timetable: the principal reading
 * the whole school, a head of department checking a class, the class teacher
 * who owns it, and the subject teacher reading their own week. They were three
 * different layouts before — a flat list of rows on the master timetable, a
 * transposed grid on the teacher's own screen with days down the side, and
 * nothing at all for a class teacher — so the same information had to be
 * re-learned on each screen.
 *
 * Periods down the side and days across the top, because that is the shape
 * every school in the country already prints. Breaks run the full width: lunch
 * is not something that happens to one class, and drawing it as a row of
 * identical cells is six copies of one fact.
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
}

export default function WeekGrid({
  entries,
  periods,
  weekdays,
  empty = 'Nothing timetabled yet.',
}: {
  entries: WeekEntry[]
  periods: WeekPeriod[]
  /** ISO weekdays the school runs, 1 = Monday. Defaults to Monday–Saturday. */
  weekdays?: number[]
  empty?: string
}) {
  // One lookup rather than a scan per cell: six days by nine periods is
  // fifty-four scans of a list that can hold a school's whole week.
  const at = new Map<string, WeekEntry>()
  for (const e of entries) at.set(`${e.weekday}:${e.period_id}`, e)

  const days = weekdays?.length ? weekdays : [1, 2, 3, 4, 5, 6]
  const teaching = periods.filter((p) => !p.is_break)

  if (teaching.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-[13.5px] text-muted-foreground">
        The school day has no periods yet, so there is nothing to lay a timetable on.
      </p>
    )
  }
  if (entries.length === 0) {
    return <p className="px-1 py-6 text-center text-[13.5px] text-muted-foreground">{empty}</p>
  }

  const time = (p: WeekPeriod) =>
    p.ends_at ? `${p.starts_at.slice(0, 5)}–${p.ends_at.slice(0, 5)}` : p.starts_at.slice(0, 5)

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-[13px]">
        <thead>
          <tr className="text-muted-foreground">
            <th className="w-28 border-b px-3 py-2 text-left font-medium">Period</th>
            {days.map((d) => (
              <th key={d} className="border-b px-3 py-2 text-left font-medium">
                {WEEKDAYS[d - 1] ?? `Day ${d}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p) =>
            p.is_break ? (
              <tr key={p.id}>
                <td
                  colSpan={days.length + 1}
                  className="border-b bg-muted/40 px-3 py-1.5 text-center text-[12px] text-muted-foreground"
                >
                  {p.name} · {time(p)}
                </td>
              </tr>
            ) : (
              <tr key={p.id} className="align-top">
                <td className="border-b px-3 py-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="block text-[11.5px] text-muted-foreground">{time(p)}</span>
                </td>
                {days.map((d) => {
                  const e = at.get(`${d}:${p.id}`)
                  return (
                    <td key={d} className="border-b px-3 py-2">
                      {e ? (
                        <>
                          <span className="font-medium">{e.title}</span>
                          {e.detail && (
                            <span
                              className={cn(
                                'block text-[11.5px]',
                                e.unstaffed ? 'text-warning' : 'text-muted-foreground',
                              )}
                            >
                              {e.detail}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  )
}
