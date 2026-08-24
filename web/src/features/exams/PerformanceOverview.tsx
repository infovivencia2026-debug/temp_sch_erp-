import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Award, GraduationCap, TriangleAlert, Users } from 'lucide-react'
import { api, type List, type Klass } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Select,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* Pass rate, subject performance, at-risk children and the backlog.

   Two numbers that are usually conflated are kept apart here. A pass is a
   child at or above the pass mark in every paper they sat; a backlog is one
   subject below it. Counting passes per paper instead would let a child who
   failed two subjects appear in the pass rate twice, and the figure the school
   quotes to parents would flatter it by ten points.

   The board's own verdict sits beside the school's rather than replacing it.
   The gap between what the school's papers say and what the state says is the
   most useful number on the page. */

interface Exam { id: string; name: string; kind: string }

interface SubjectRow {
  subject: string
  class_name: string
  exam_name: string
  entered: number
  average_percent?: number
  below_pass: number
  pass_rate?: number
  /* Marks entered above this paper's own maximum. Absent when there are none.
     While it is set, `average_percent` is honest arithmetic over dishonest
     data — 50 on a paper out of 20 gives 250% — and is not printed. */
  marks_above_max?: number
}

interface AtRisk {
  student_id: string
  name: string
  admission_no: string
  class_name: string
  percent?: number
  backlogs: number
  papers: number
}

interface Overview {
  summary: {
    candidates: number
    passed: number
    pass_rate?: number
    average_percent?: number
    distinctions: number
    backlogs: number
    at_risk: number
    papers: number
    /* Marks above their paper's maximum anywhere in this cut, summed from the
       by-subject rows so the headline and the table agree about whether they
       can be believed. Absent when there are none. */
    marks_above_max?: number
  }
  by_subject: SubjectRow[]
  at_risk: AtRisk[]
  board: {
    exam_name?: string
    candidates?: number
    passed?: number
    pass_rate?: number
    published_on?: string
  }
  definitions: Record<string, string>
}

export default function PerformanceOverview() {
  const [examId, setExamId] = useState('')
  const [classId, setClassId] = useState('')

  const exams = useQuery({
    queryKey: ['exam-list'],
    queryFn: () => api.get<List<Exam>>('/api/v1/exams/list'),
  })
  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const overview = useQuery({
    queryKey: ['board-performance', examId, classId],
    queryFn: () => {
      const q = new URLSearchParams()
      if (examId) q.set('exam_id', examId)
      if (classId) q.set('class_id', classId)
      const s = q.toString()
      return api.get<Overview>(`/api/v1/exams/board/performance${s ? `?${s}` : ''}`)
    },
  })

  if (overview.isLoading) return <Loading label="Counting results…" />
  if (overview.error) return <ErrorState error={overview.error} />

  const d = overview.data
  const s = d?.summary
  const board = d?.board ?? {}
  const gap =
    board.pass_rate !== undefined && s?.pass_rate !== undefined
      ? Math.round((board.pass_rate - s.pass_rate) * 10) / 10
      : undefined

  /* Marks above their paper's maximum in this cut. The server sends the count
     when there are any; the `> 100` tests below stand on their own as well,
     because a share of a paper above 100% is impossible on its own evidence
     and needs no second opinion from the server to be refused. */
  const overMax = s?.marks_above_max ?? 0

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Performance overview"
        description={`Pass means ${d?.definitions.pass ?? 'at or above the pass mark in every paper sat'}. A backlog is ${d?.definitions.backlog ?? 'one subject below the pass mark'}.`}
        actions={
          <div className="flex items-center gap-2">
            <Select
              value={examId}
              onChange={setExamId}
              options={(exams.data?.items ?? []).map((e) => ({ value: e.id, label: e.name }))}
              placeholder="Every exam this year"
            />
            <Select
              value={classId}
              onChange={setClassId}
              options={(classes.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Every class"
            />
          </div>
        }
      />
      <PageBody width="wide">
        {/* AN AVERAGE OVER 100% IS NOT A GOOD RESULT.
          *
          * This page read "Average 169%" while the papers behind it were
          * marked out of 20 and carried marks up to 50. The percentage is the
          * arithmetic working correctly on data that is wrong. It is withheld
          * and the fault is named — never clamped to 100, which would turn a
          * fixable typing error into a plausible number nobody questions. */}
        {overMax > 0 && (
          <p className="rounded-md border border-danger/40 bg-danger/5 p-3 text-[13px] text-muted-foreground">
            <span className="font-medium text-foreground">
              {overMax === 1
                ? 'One mark is above the maximum printed on its paper.'
                : `${overMax} marks are above the maximum printed on their papers.`}
            </span>{' '}
            Percentages taken against that maximum come out above 100%, so they
            are not shown. Nothing has been rounded down to hide it: correct the
            marks, or the paper&rsquo;s maximum, in mark entry, and the averages
            come back on their own.
          </p>
        )}

        <CellGrid cols={4}>
          <Stat
            label="Pass rate"
            value={s?.pass_rate !== undefined && s?.pass_rate !== null ? `${s.pass_rate}%` : '—'}
            icon={GraduationCap}
            delta={
              s?.candidates
                ? { value: `${s.passed} of ${s.candidates} cleared every paper`, positive: (s.pass_rate ?? 0) >= 90 }
                : undefined
            }
          />
          <Stat
            label="Average"
            value={
              overMax > 0 || (s?.average_percent ?? 0) > 100
                ? '—'
                : s?.average_percent != null
                  ? `${s.average_percent}%`
                  : '—'
            }
            icon={Users}
            hint={overMax > 0 ? 'Withheld — marks above the paper maximum' : `${s?.papers ?? 0} papers`}
          />
          <Stat label="Distinctions" value={s?.distinctions ?? 0} icon={Award} hint="75% and above" />
          <Stat
            label="Children at risk"
            value={s?.at_risk ?? 0}
            icon={TriangleAlert}
            hint={`${s?.backlogs ?? 0} subject backlogs between them`}
          />
        </CellGrid>

        {board.exam_name && (
          <Card>
            <CardHeader
              title="What the board said"
              description="From the most recent result file imported. Shown beside the school's own figure rather than merged into it."
            />
            <div className="p-5">
              <CellGrid cols={4}>
                <Stat label="Board examination" value={board.exam_name} />
                <Stat label="Candidates in the file" value={board.candidates ?? 0} />
                <Stat label="Board pass rate" value={board.pass_rate != null ? `${board.pass_rate}%` : '—'} />
                <Stat
                  label="Against our own papers"
                  value={gap != null ? `${gap > 0 ? '+' : ''}${gap} pts` : '—'}
                  hint={board.published_on ? `published ${formatDate(board.published_on)}` : 'not published to parents yet'}
                />
              </CellGrid>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Subject performance"
            description="Where a cohort is losing marks, paper by paper."
          />
          {(d?.by_subject.length ?? 0) === 0 ? (
            <EmptyState title="No marks entered yet" body="Subject performance appears as papers are marked." />
          ) : (
            <Table head={['Class', 'Subject', 'Exam', 'Marked', 'Average', 'Pass rate', 'Below pass']}>
              {(d?.by_subject ?? []).map((r) => (
                <tr key={`${r.class_name}-${r.subject}-${r.exam_name}`}>
                  <Td>{r.class_name}</Td>
                  <Td className="font-medium">{r.subject}</Td>
                  <Td className="text-muted-foreground">{r.exam_name}</Td>
                  <Td className="tabular-nums">{r.entered}</Td>
                  <Td className="tabular-nums">
                    {(r.marks_above_max ?? 0) > 0 || (r.average_percent ?? 0) > 100
                      ? '—'
                      : r.average_percent != null
                        ? `${r.average_percent}%`
                        : '—'}
                  </Td>
                  <Td>
                    <Badge tone={(r.pass_rate ?? 0) >= 90 ? 'success' : (r.pass_rate ?? 0) >= 70 ? 'warning' : 'danger'}>
                      {r.pass_rate ?? '—'}%
                    </Badge>
                  </Td>
                  <Td className="tabular-nums">{r.below_pass || '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Children carrying a backlog"
            description="Worst first: most subjects below the pass mark, then lowest overall. This is the remedial list, not a ranking."
          />
          {(d?.at_risk.length ?? 0) === 0 ? (
            <EmptyState title="Nobody is below the pass mark" />
          ) : (
            <Table head={['Child', 'Admission no', 'Class', 'Papers', 'Backlogs', 'Overall']}>
              {(d?.at_risk ?? []).map((a) => (
                <tr key={a.student_id}>
                  <Td className="font-medium">{a.name}</Td>
                  <Td>{a.admission_no}</Td>
                  <Td>{a.class_name}</Td>
                  <Td className="tabular-nums">{a.papers}</Td>
                  <Td><Badge tone={a.backlogs > 2 ? 'danger' : 'warning'}>{a.backlogs}</Badge></Td>
                  <Td className="tabular-nums">
                    {(a.percent ?? 0) > 100
                      ? '—'
                      : a.percent != null
                        ? `${a.percent}%`
                        : '—'}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
