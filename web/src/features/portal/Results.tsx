import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Award, GraduationCap } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* Results, as a family sees them.

   The catalogue's "Exams & grades" and "Results & report cards" both opened
   the staff report-card generator, which 403s a parent on its first call. This
   is the same data from the other side: the cards the school has published,
   and the subject marks behind them.

   Nothing provisional appears. A report card exists from the moment marks are
   entered and stays wrong until the exam controller has checked it; a parent
   who sees a rank that later changes has been told something the school did
   not mean to say. */

interface Card_ {
  exam: string
  term?: string
  total_marks?: number
  max_marks?: number
  percentage?: number
  grade?: string
  gpa?: number
  rank_in_section?: number
  attendance_percent?: number
  class_teacher_remarks?: string
  published_at?: string
}
interface SubjectMark {
  exam: string
  subject: string
  marks_obtained?: number
  max_marks?: number
  grade?: string
  is_absent: boolean
}
interface ResultView {
  student_id: string
  cards: Card_[]
  subjects: SubjectMark[]
  published: boolean
}
interface Child {
  student_id: string
  full_name: string
  class_name?: string
  section_name?: string
}

export default function PortalResults() {
  const children = useQuery({
    queryKey: ['portal-children'],
    queryFn: () => api.get<List<Child>>('/api/v1/portal/students'),
  })
  const kids = children.data?.items ?? []
  const [picked, setPicked] = useState('')
  const child = picked || kids[0]?.student_id || ''

  const { data, isLoading, error } = useQuery({
    queryKey: ['portal-results', child],
    queryFn: () => api.get<ResultView>(`/api/v1/portal/results?student_id=${child}`),
    enabled: !!child,
  })

  /* A failed children request used to be indistinguishable from a slow one:
     `!child` held the spinner forever because the results query never starts
     without a child, and a query that never starts never stops being pending.
     A parent is owed the reason. */
  if (children.isLoading) return <Loading />
  if (children.error) return <ErrorState error={children.error} />
  if (!kids.length)
    return (
      <>
        <PageHead eyebrow="Results" title="Results" />
        <PageBody>
          <EmptyState
            title="No student record linked"
            body="Your account is not linked to a student yet. Ask the school office to connect it."
          />
        </PageBody>
      </>
    )
  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data)
    return (
      <>
        <PageHead eyebrow="Results" title="Results" />
        <PageBody>
          <EmptyState
            title="No results published yet"
            body="Your school has not released any results yet. They appear here as soon as it does — nothing provisional is shown."
          />
        </PageBody>
      </>
    )
  const d = data
  const latest = d.cards[0]
  const name = kids.find((k) => k.student_id === child)?.full_name ?? ''

  // Grouped by exam so a term reads as one block rather than as a flat list
  // of every subject the child has ever sat.
  const byExam = new Map<string, SubjectMark[]>()
  for (const m of d.subjects) {
    byExam.set(m.exam, [...(byExam.get(m.exam) ?? []), m])
  }

  return (
    <>
      <PageHead
        eyebrow="Results"
        title={d.published ? 'Published results' : 'No results published yet'}
        description={
          d.published
            ? `Report cards the school has released for ${name}.`
            : 'Your school has not released any results yet. They appear here as soon as it does — nothing provisional is shown.'
        }
        actions={
          kids.length > 1 && (
            <Select
              value={child}
              onChange={setPicked}
              options={kids.map((k) => ({
                value: k.student_id,
                label: `${k.full_name}${k.class_name ? ` · ${k.class_name}-${k.section_name ?? ''}` : ''}`,
              }))}
            />
          )
        }
      />
      <PageBody>
        {latest && (
          <CellGrid cols={4}>
            <Stat
              label="Latest"
              value={latest.percentage != null ? `${latest.percentage.toFixed(1)}%` : '—'}
              icon={GraduationCap}
              hint={latest.term ?? latest.exam}
            />
            <Stat label="Grade" value={latest.grade ?? '—'} icon={Award} />
            <Stat
              label="Rank in section"
              value={latest.rank_in_section ?? '—'}
              hint={latest.gpa != null ? `GPA ${latest.gpa.toFixed(1)}` : undefined}
            />
            <Stat
              label="Attendance"
              value={latest.attendance_percent != null ? `${Math.round(latest.attendance_percent)}%` : '—'}
              hint="On the report card"
            />
          </CellGrid>
        )}

        <Card>
          <CardHeader title="Report cards" description="Only what the school has released" />
          {d.cards.length === 0 ? (
            <EmptyState
              title="Nothing released yet"
              body="Marks may already be entered; they appear here once the school publishes the card."
            />
          ) : (
            <Table head={['Term', 'Total', 'Percentage', 'Grade', 'Rank', 'Published']}>
              {d.cards.map((c, i) => (
                <tr key={i}>
                  <Td className="font-medium">{c.term ?? c.exam}</Td>
                  <Td className="tabular-nums">
                    {c.total_marks != null ? `${c.total_marks} / ${c.max_marks ?? '—'}` : '—'}
                  </Td>
                  <Td className="tabular-nums">
                    {c.percentage != null ? `${c.percentage.toFixed(1)}%` : '—'}
                  </Td>
                  <Td>{c.grade ? <Badge tone="primary">{c.grade}</Badge> : '—'}</Td>
                  <Td className="tabular-nums">{c.rank_in_section ?? '—'}</Td>
                  <Td className="text-muted-foreground">{formatDate(c.published_at)}</Td>
                </tr>
              ))}
            </Table>
          )}
          {latest?.class_teacher_remarks && (
            <p className="border-t px-5 py-3 text-[14px]">
              <span className="eyebrow mr-2">Class teacher</span>
              {latest.class_teacher_remarks}
            </p>
          )}
        </Card>

        {[...byExam.entries()].map(([exam, marks]) => (
          <Card key={exam}>
            <CardHeader title={exam} description={`${marks.length} subjects`} />
            <Table head={['Subject', 'Marks', 'Out of', 'Grade']}>
              {marks.map((m, i) => (
                <tr key={i}>
                  <Td className="font-medium">{m.subject}</Td>
                  <Td className="tabular-nums">
                    {m.is_absent ? <Badge tone="danger">Absent</Badge> : (m.marks_obtained ?? '—')}
                  </Td>
                  <Td className="tabular-nums">{m.max_marks ?? '—'}</Td>
                  <Td>{m.grade ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        ))}
      </PageBody>
    </>
  )
}
