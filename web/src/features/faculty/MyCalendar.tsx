import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { PageHead, PageBody } from '@/components/ui'
import { MonthGrid, type CalendarEntry } from '../shared/MonthGrid'

/* A MEMBER OF STAFF'S OWN MONTH.

   Parents and students each had a calendar. Staff had none, and their dates
   were spread across four screens: the exam timetable, the duty roster, the
   homework they set, and whatever leave they had been granted. The clash
   between two of them was found by being in the wrong room.

   Deliberately not the weekly timetable. A teacher teaches five periods a day,
   every day, and three hundred of them on a month grid buries the four dates
   that actually matter under the one thing they already know by heart. What
   goes on here is what varies.
*/
export default function MyCalendar() {
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)

  const feed = useQuery({
    // Not fetched until the grid says which six weeks it is drawing: the
    // server requires from and to, and guessing a window here would mean two
    // requests for the first month every time the screen opens.
    enabled: range !== null,
    queryKey: ['staff-calendar', range?.from, range?.to],
    queryFn: () =>
      api.get<List<CalendarEntry>>(
        `/api/v1/me/calendar?from=${range?.from}&to=${range?.to}`,
      ),
    // The month on screen stays while the next one loads, rather than the page
    // dropping to empty on every arrow press.
    placeholderData: (prev) => prev,
  })

  return (
    <>
      <PageHead
        eyebrow="My work"
        title="My calendar"
        description="Exams, the duties you are rostered on, the homework you set falling due, and your own leave."
      />
      <PageBody>
        <MonthGrid
          entries={feed.data?.items ?? []}
          loading={feed.isFetching || range === null}
          error={feed.error}
          onRange={(from, to) => setRange({ from, to })}
          description="Your own month. A day the school is closed to staff is shaded; a day only the children are off is not, because it is still a working day for you."
        />
      </PageBody>
    </>
  )
}
