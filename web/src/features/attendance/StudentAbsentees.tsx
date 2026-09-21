import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useVisibleInterval } from '@/lib/visible'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Select, Input,
  Field, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'

/* Student absentees — the monitoring view.
 *
 * Absentee follow-up (AbsenceFollowup.tsx) is where the office does the work:
 * it rings each absent child's home and writes down the outcome. This screen is
 * the other side of that glass — a read-only, day-wise list of every child
 * marked away across the school (or across the sections the caller may see),
 * showing at a glance whether each has been called, WHO made the call, and what
 * the parent said. There are no controls that change anything; acting on a row
 * stays on Absentee follow-up.
 *
 * It reads the same endpoint the action screen does
 * (/api/v1/attendance/absentees), which is scoped server-side, so a class
 * teacher sees their own sections and a read.all holder sees the whole school —
 * the same rows, laid out as one flat table rather than per-section action
 * cards.
 *
 * LIVE. As a colleague records a call on the follow-up screen, this table
 * refreshes on its own: the query polls while the tab is visible
 * (useVisibleInterval, the same low-end-safe polling every live screen in the
 * product uses — no SSE, no WebSocket) and refetches on window focus. The
 * shared revision poll in lib/live.ts also invalidates it, so a change lands
 * within a tick either way. */

interface Absentee {
  student_id: string
  name: string
  admission_no: string
  call_status: 'not_called' | 'called' | 'no_answer' | 'reached'
  parent_response?: string
  /** The staff member who last recorded this child's follow-up; '' if none. */
  called_by?: string
  /** When that follow-up was recorded; null until somebody acts. */
  called_at?: string | null
}

interface AbsenteeSection {
  section_id: string
  section_name: string
  class_name: string
  students: Absentee[]
}

interface AbsenteesResponse {
  date: string
  sections: AbsenteeSection[]
}

/** One student, flattened out of its section for the single table. */
interface Row extends Absentee {
  section_id: string
  section_name: string
  class_name: string
}

/** Today, as YYYY-MM-DD in the browser's own timezone. */
function today(): string {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10)
}

/* Two states on this screen: pending or called. Older rows may carry the
   'no_answer'/'reached' the dropdown used to offer; they count and read as
   "called" here, since the point of this view is "has the family been reached
   yet", not the fine grain of the outcome. */
function isCalled(status: Absentee['call_status']): boolean {
  return status !== 'not_called'
}

export default function StudentAbsentees() {
  const [onDate, setOnDate] = useState(today)
  const [sectionId, setSectionId] = useState('')
  // Find one child across the day's absentees by name or admission number.
  const [nameQ, setNameQ] = useState('')

  const params = new URLSearchParams({ on_date: onDate })
  if (sectionId) params.set('section_id', sectionId)

  const { data, isLoading, error } = useQuery({
    queryKey: ['absentees', onDate, sectionId],
    queryFn: () => api.get<AbsenteesResponse>(`/api/v1/attendance/absentees?${params}`),
    // Poll while the tab is looked at, so a colleague's call appears without a
    // reload; false while hidden so a background tab costs nothing.
    refetchInterval: useVisibleInterval(15_000),
    refetchOnWindowFocus: true,
  })

  /* The section picker is built from the full day. A filtered fetch returns
     only the one section, which would collapse the dropdown to that single
     choice — so the full list is remembered from the last unfiltered load,
     exactly as the action screen does. */
  const [allSections, setAllSections] = useState<{ value: string; label: string }[]>([])
  useEffect(() => {
    if (!sectionId && data?.sections) {
      setAllSections(
        data.sections.map((s) => ({
          value: s.section_id,
          label: `${s.class_name} ${s.section_name}`,
        })),
      )
    }
  }, [data, sectionId])

  const sections = data?.sections ?? []
  const allRows: Row[] = sections.flatMap((s) =>
    s.students.map((st) => ({
      ...st,
      section_id: s.section_id,
      section_name: s.section_name,
      class_name: s.class_name,
    })),
  )

  const nq = nameQ.trim().toLowerCase()
  const rows = nq
    ? allRows.filter(
        (r) =>
          r.name.toLowerCase().includes(nq) ||
          r.admission_no.toLowerCase().includes(nq),
      )
    : allRows

  const total = allRows.length
  const pending = allRows.filter((r) => !isCalled(r.call_status)).length
  const called = total - pending

  return (
    <>
      <PageHead
        eyebrow="Attendance"
        title="Student absentees"
        description="Who is away today and where the call home stands — updates live as the office records each call."
        actions={
          <>
            <Field label="Date">
              <Input type="date" value={onDate} onChange={setOnDate} />
            </Field>
            <Field label="Section">
              <Select
                value={sectionId}
                onChange={setSectionId}
                placeholder="All sections"
                options={allSections}
              />
            </Field>
            <Field label="Search">
              <Input value={nameQ} onChange={setNameQ} placeholder="Name or admission no." />
            </Field>
          </>
        }
      />
      <PageBody>
        {isLoading ? (
          <SkeletonTable columns={7} />
        ) : error ? (
          <ErrorState error={error} />
        ) : total === 0 ? (
          <EmptyState
            title="Nobody is marked absent for this day."
            body="Once attendance is taken and a child is marked away, they appear here so the follow-up can be watched."
          />
        ) : (
          <Card>
            <CardHeader
              title="Absentees"
              description={`${total} absent · ${pending} pending · ${called} called`}
            />
            <Table
              head={['Student', 'Admission No', 'Class', 'Section', 'Status', 'Called by', 'Parent response']}
              empty={rows.length === 0}
              emptyLabel={nq ? `No absentee matches “${nameQ}” on this day.` : 'Nobody is marked absent for this day.'}
            >
              {rows.map((r) => {
                const done = isCalled(r.call_status)
                return (
                  <tr key={r.student_id}>
                    <Td className="font-medium">{r.name}</Td>
                    <Td className="font-mono text-[12px] text-muted-foreground">{r.admission_no}</Td>
                    <Td>{r.class_name}</Td>
                    <Td>{r.section_name}</Td>
                    <Td>
                      <Badge tone={done ? 'success' : 'danger'}>
                        {done ? 'Called' : 'Pending'}
                      </Badge>
                    </Td>
                    <Td className="text-muted-foreground">{r.called_by || ''}</Td>
                    <Td className="text-muted-foreground">{r.parent_response || ''}</Td>
                  </tr>
                )
              })}
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  )
}
