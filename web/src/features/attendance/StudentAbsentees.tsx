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

/** One child marked present that day — the Present tab's row. */
interface Present {
  student_id: string
  name: string
  admission_no: string
  section_id: string
  section_name: string
  class_name: string
}

interface AbsenteesResponse {
  date: string
  sections: AbsenteeSection[]
  present: Present[]
}

/** One absentee, flattened out of its section for the single table. */
interface Row extends Absentee {
  section_id: string
  section_name: string
  class_name: string
}

type Tab = 'present' | 'absent'

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

export default function StudentAbsentees({ embedded = false }: { embedded?: boolean } = {}) {
  const [onDate, setOnDate] = useState(today)
  const [sectionId, setSectionId] = useState('')
  // Find one child across the day's list by name or admission number.
  const [nameQ, setNameQ] = useState('')
  // Default to Absent — that is the actionable side of the day.
  const [tab, setTab] = useState<Tab>('absent')

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
    if (!sectionId && data) {
      // Draw the section list from BOTH tabs' rows, so a section that had
      // everyone present (no absentees) is still selectable.
      const seen = new Map<string, string>()
      for (const s of data.sections ?? []) seen.set(s.section_id, `${s.class_name} ${s.section_name}`)
      for (const p of data.present ?? []) seen.set(p.section_id, `${p.class_name} ${p.section_name}`)
      setAllSections(
        [...seen.entries()]
          .map(([value, label]) => ({ value, label }))
          .sort((a, b) => a.label.localeCompare(b.label)),
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

  const allPresent = data?.present ?? []

  const nq = nameQ.trim().toLowerCase()
  const matchName = (name: string, adm: string) =>
    !nq || name.toLowerCase().includes(nq) || adm.toLowerCase().includes(nq)

  const rows = allRows.filter((r) => matchName(r.name, r.admission_no))
  const presentRows = allPresent.filter((p) => matchName(p.name, p.admission_no))

  const total = allRows.length
  const pending = allRows.filter((r) => !isCalled(r.call_status)).length
  const called = total - pending
  const presentTotal = allPresent.length

  const empty = tab === 'present' ? presentTotal === 0 : total === 0

  /* The date / section / search controls, kept together so the hub can show
     them at the top of the tab body while the standalone screen keeps them in
     the PageHead. Either way they are the same controls. */
  const controls = (
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
  )

  const content = (
    <>
        {/* Two views of the same day, sharing the date / section / search above.
            Plain buttons styled as a segmented control — no new dependency, and
            it renders on the oldest browser we support. */}
        <div
          role="tablist"
          aria-label="Present or absent"
          className="mx-auto mb-3 flex w-fit gap-1 rounded-md border bg-muted p-1"
        >
          {(['absent', 'present'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={
                tab === t
                  ? 'rounded-sm bg-card px-3 py-1 text-[13px] font-medium text-foreground shadow-sm [@media(pointer:coarse)]:py-2.5'
                  : 'rounded-sm px-3 py-1 text-[13px] text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:py-2.5'
              }
            >
              {t === 'absent' ? `Absent (${total})` : `Present (${presentTotal})`}
            </button>
          ))}
        </div>

        {isLoading ? (
          <SkeletonTable columns={tab === 'present' ? 4 : 7} />
        ) : error ? (
          <ErrorState error={error} />
        ) : empty ? (
          tab === 'present' ? (
            <EmptyState
              title="Nobody marked present for this day."
              body="Once the register is taken, every child marked present appears here."
            />
          ) : (
            <EmptyState
              title="Nobody is marked absent for this day."
              body="Once attendance is taken and a child is marked away, they appear here so the follow-up can be watched."
            />
          )
        ) : tab === 'present' ? (
          <Card>
            <CardHeader title="Present" description={`${presentTotal} present`} />
            <Table
              head={['Student', 'Admission No', 'Class', 'Section']}
              empty={presentRows.length === 0}
              emptyLabel={nq ? `No present child matches “${nameQ}” on this day.` : 'Nobody marked present for this day.'}
            >
              {presentRows.map((p) => (
                <tr key={p.student_id}>
                  <Td className="font-medium">{p.name}</Td>
                  <Td className="font-mono text-[12px] text-muted-foreground">{p.admission_no}</Td>
                  <Td>{p.class_name}</Td>
                  <Td>{p.section_name}</Td>
                </tr>
              ))}
            </Table>
          </Card>
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
    </>
  )

  return (
    <>
      {/* Embedded in the Attendance hub, this screen drops its own PageHead —
          the hub carries the one title (and its own PageBody) — but keeps its
          controls, shown as a row above the body instead. */}
      {embedded ? (
        <>
          {/* Full-width stacked on a phone so Date / Section / Search each get a
              whole line and a comfortable field; the desktop row (sm+) is the
              flex-wrap it always was. */}
          <div className="mb-3 grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end">{controls}</div>
          {content}
        </>
      ) : (
        <>
          <PageHead
            eyebrow="Attendance"
            title="Present & absent"
            description="Who came in and who is away today, and where the call home stands — updates live as the office records each call."
            actions={controls}
          />
          <PageBody>{content}</PageBody>
        </>
      )}
    </>
  )
}
