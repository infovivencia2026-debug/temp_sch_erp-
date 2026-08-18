import { useQuery } from '@tanstack/react-query'
import { ScrollText, CalendarCheck, Percent } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  PrintButton, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface RecordYear {
  academic_year: string
  class_name: string
  section_name: string
  roll_no?: number
  status: string
  enrolled_on: string
  percentage?: number
  grade?: string
  rank_in_section?: number
  attendance_percent?: number
  class_teacher_remarks?: string
  is_published: boolean
}
interface RecordResponse {
  student_id: string
  student_name: string
  admission_no: string
  apaar_id?: string
  lifetime_attendance_percent?: number
  years: RecordYear[]
}

const STATUS_TONE: Record<string, 'success' | 'info' | 'warning' | 'neutral'> = {
  active: 'info',
  promoted: 'success',
  completed: 'success',
  detained: 'warning',
  transferred: 'neutral',
  withdrawn: 'neutral',
}

/* The file, not this term's marks.

   The results screen already answers "how did I do in the last exam". This
   answers the question a next school asks: which class each year, whether the
   child was promoted, what the year came to and how much of it they attended.
   It is what a transfer certificate is copied from.

   A year whose report card has not been published shows the enrolment and
   nothing else. The year still happened; the result is simply not the child's
   to read yet. */
export default function AcademicRecord() {
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const record = useQuery({
    queryKey: ['academic-record', studentId],
    queryFn: () =>
      api.get<RecordResponse>(`/api/v1/portal/academic-record${studentQuery(studentId)}`),
    enabled: ready,
  })

  if (record.isLoading && ready) return <Loading label="Opening your record…" />
  if (record.error) return <ErrorState error={record.error} />

  const r = record.data
  const years = r?.years ?? []
  const withResults = years.filter((y) => y.percentage !== undefined && y.percentage !== null)
  const best = withResults.reduce<number | undefined>(
    (b, y) => (b === undefined || (y.percentage ?? 0) > b ? y.percentage : b),
    undefined,
  )

  return (
    <>
      <PageHead
        eyebrow="Exams and results"
        title="Academic record"
        description="Every year on the roll, in one place — the record a next school asks for."
        actions={<PrintButton label="Print record" />}
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="A record belongs to one child." />
        ) : (
          <>
            <CellGrid cols={4}>
              <Stat label="Years on the roll" value={years.length} icon={ScrollText} />
              <Stat
                label="Lifetime attendance"
                value={r?.lifetime_attendance_percent != null
                  ? `${r.lifetime_attendance_percent}%`
                  : '—'}
                icon={CalendarCheck}
                delta={
                  r?.lifetime_attendance_percent != null
                    ? {
                        value: r.lifetime_attendance_percent >= 75 ? 'Above the line' : 'Below 75%',
                        positive: r.lifetime_attendance_percent >= 75,
                      }
                    : undefined
                }
              />
              <Stat label="Best year" value={best != null ? `${best}%` : '—'} icon={Percent} />
              <Stat label="Admission number" value={r?.admission_no ?? '—'}
                hint={r?.apaar_id ? `APAAR ${r.apaar_id}` : 'No APAAR recorded'} />
            </CellGrid>

            <Card>
              <CardHeader
                title={r?.student_name ?? 'Record'}
                description="Most recent year first. A blank result means the school has not published that year's card."
              />
              <Table
                head={[
                  'Year', 'Class', { label: 'Roll', align: 'right' }, 'Outcome',
                  { label: 'Result', align: 'right' },
                  { label: 'Rank', align: 'right' },
                  { label: 'Attendance', align: 'right' },
                  'Class teacher',
                ]}
                empty={years.length === 0}
                emptyLabel="No enrolment on record yet."
              >
                {years.map((y) => (
                  <tr key={`${y.academic_year}-${y.class_name}-${y.enrolled_on}`}>
                    <Td>
                      <span className="font-medium">{y.academic_year}</span>
                      <span className="block text-[12px] text-muted-foreground">
                        from {formatDate(y.enrolled_on)}
                      </span>
                    </Td>
                    <Td>
                      {y.class_name}-{y.section_name}
                    </Td>
                    <Td className="text-right tabular-nums">{y.roll_no ?? '—'}</Td>
                    <Td>
                      <Badge tone={STATUS_TONE[y.status] ?? 'neutral'}>{y.status}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {y.percentage != null ? (
                        <>
                          {y.percentage}%
                          {y.grade && (
                            <span className="block text-[12px] text-muted-foreground">{y.grade}</span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">Not published</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{y.rank_in_section ?? '—'}</Td>
                    <Td className="text-right tabular-nums">
                      {y.attendance_percent != null ? `${y.attendance_percent}%` : '—'}
                    </Td>
                    <Td className="text-[13px] text-muted-foreground">
                      {y.class_teacher_remarks ?? '—'}
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
