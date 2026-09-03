import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LineChart, TrendingDown, TrendingUp } from 'lucide-react'
import { api, type List, type Klass } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Select,
  SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* Growth against the cohort's own earlier performance.

   The basis is printed on the screen, not buried in a tooltip. A percentage
   with no stated basis is a number nobody can defend to a trustee, and the
   first question anybody asks of a growth figure is what it was measured
   against.

   Movement is in percentage points throughout. "Up four points" is a statement
   about the class; "up nine per cent" invites the reader to think a child's
   mark rose by nine. */

interface Point {
  exam_id: string
  exam_name: string
  on?: string
  students: number
  average_percent?: number
}

interface Cohort {
  class_id: string
  class_name: string
  level: number
  baseline?: Point
  latest?: Point
  delta_points?: number
  trend: Point[]
  note?: string
}

interface Movement {
  name: string
  baseline_percent?: number
  latest_percent?: number
  delta_points?: number
  admission_no?: string
  student_id?: string
}

interface Analysis {
  basis: string
  cohorts: Cohort[]
  subjects: Movement[]
  students: Movement[]
}

function Delta({ value }: { value?: number }) {
  if (value === undefined || value === null) return <span className="text-muted-foreground">—</span>
  const tone = value > 0 ? 'success' : value < 0 ? 'danger' : 'neutral'
  return (
    <Badge tone={tone}>
      {value > 0 ? '+' : ''}{value} pts
    </Badge>
  )
}

export default function BaselineAnalysis() {
  const [classId, setClassId] = useState('')

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const analysis = useQuery({
    queryKey: ['baseline-analysis', classId],
    queryFn: () =>
      api.get<Analysis>(
        `/api/v1/exams/board/analysis/baseline${classId ? `?class_id=${classId}` : ''}`,
      ),
  })

  if (analysis.isLoading) return <SkeletonTable columns={7} label="Reading the marks register…" />
  if (analysis.error) return <ErrorState error={analysis.error} />

  const d = analysis.data
  const cohorts = d?.cohorts ?? []
  const measured = cohorts.filter((c) => c.delta_points !== undefined && c.delta_points !== null)
  const improving = measured.filter((c) => (c.delta_points ?? 0) > 0).length
  const best = measured.slice().sort((a, b) => (b.delta_points ?? 0) - (a.delta_points ?? 0))[0]
  const worst = measured.slice().sort((a, b) => (a.delta_points ?? 0) - (b.delta_points ?? 0))[0]

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Baseline performance analysis"
        description={d?.basis}
        actions={
          <Select
            value={classId}
            onChange={setClassId}
            options={(classes.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
            placeholder="Every class"
          />
        }
      />
      <PageBody width="wide">
        <CellGrid cols={3}>
          <Stat label="Cohorts measured" value={measured.length} icon={LineChart} hint={`${cohorts.length} with marks this year`} />
          <Stat
            label="Improving"
            value={improving}
            icon={TrendingUp}
            hint={best ? `${best.class_name} best at ${best.delta_points} pts` : undefined}
          />
          <Stat
            label="Falling back"
            value={measured.length - improving}
            icon={TrendingDown}
            hint={worst && (worst.delta_points ?? 0) < 0 ? `${worst.class_name} at ${worst.delta_points} pts` : undefined}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Each cohort against its own baseline"
            description="Both ends are named. Anyone can reproduce the figure from the marks register."
          />
          {cohorts.length === 0 ? (
            <EmptyState
              title="No marks yet this year"
              body="Growth needs two assessments to measure between. Enter a paper and the first baseline appears here."
            />
          ) : (
            <Table head={['Class', 'Baseline exam', 'Baseline', 'Latest exam', 'Latest', 'Movement', 'Assessments']}>
              {cohorts.map((c) => (
                <tr key={c.class_id}>
                  <Td className="font-medium">{c.class_name}</Td>
                  <Td>
                    {c.baseline?.exam_name ?? '—'}
                    {c.baseline?.on && (
                      <span className="block text-[12px] text-muted-foreground">{formatDate(c.baseline.on)}</span>
                    )}
                  </Td>
                  <Td className="tabular-nums">{c.baseline?.average_percent ?? '—'}%</Td>
                  <Td>
                    {c.latest?.exam_name ?? '—'}
                    {c.latest?.on && (
                      <span className="block text-[12px] text-muted-foreground">{formatDate(c.latest.on)}</span>
                    )}
                  </Td>
                  <Td className="tabular-nums">{c.latest ? `${c.latest.average_percent}%` : '—'}</Td>
                  <Td><Delta value={c.delta_points} /></Td>
                  <Td className="text-muted-foreground">
                    {c.trend.length}
                    {c.note && <span className="block text-[12px]">{c.note}</span>}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {classId && (d?.subjects.length ?? 0) > 0 && (
          <Card>
            <CardHeader
              title="Where the movement is"
              description="Subject by subject, between the same two assessments as above."
            />
            <Table head={['Subject', 'Baseline', 'Latest', 'Movement']}>
              {(d?.subjects ?? []).map((m) => (
                <tr key={m.name}>
                  <Td className="font-medium">{m.name}</Td>
                  <Td className="tabular-nums">{m.baseline_percent ?? '—'}%</Td>
                  <Td className="tabular-nums">{m.latest_percent ?? '—'}%</Td>
                  <Td><Delta value={m.delta_points} /></Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {classId && (d?.students.length ?? 0) > 0 && (
          <Card>
            <CardHeader
              title="Child by child"
              description="A cohort average hides the child who fell twenty points while the class rose four."
            />
            <Table head={['Child', 'Admission no', 'Baseline', 'Latest', 'Movement']}>
              {(d?.students ?? []).map((m) => (
                <tr key={m.student_id}>
                  <Td className="font-medium">{m.name}</Td>
                  <Td>{m.admission_no}</Td>
                  <Td className="tabular-nums">{m.baseline_percent ?? '—'}%</Td>
                  <Td className="tabular-nums">{m.latest_percent ?? '—'}%</Td>
                  <Td><Delta value={m.delta_points} /></Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {!classId && (
          <Card>
            {/* The sentence is the whole card, so it goes in the body.

                Card descriptions are no longer drawn, so a card whose only
                content was one rendered as a heading over an empty box —
                which reads as a screen that failed to load rather than as
                an explanation. */}
            <EmptyState
              title="Choose a class for the detail"
              body="Subject and per-child movement are shown one cohort at a time; across the whole school they are thousands of rows and no conclusion."
            />
          </Card>
        )}
      </PageBody>
    </>
  )
}
