import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ClipboardList, TriangleAlert, Users } from 'lucide-react'
import { api, type List, type Klass } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  FormNotice, Select, Loading, ErrorState, EmptyState, useSort,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'

/* Who has not entered their marks yet.

   The question the examination controller asks every day of the fortnight
   after a paper, and the product could only answer it by opening each subject
   in turn. Completion is counted against the class roll rather than against
   the marks already entered, because counting entered rows against themselves
   makes every paper look finished.

   Approving is a separate act from entering, and the button refuses a paper
   that is still short. A half-marked paper signed off is how a result gets
   published with a class missing from it. */

interface Paper {
  exam_subject_id: string
  exam_id: string
  exam_name: string
  exam_kind: string
  class_name: string
  subject: string
  exam_date?: string
  max_marks: number
  pass_marks: number
  teachers?: string
  eligible: number
  entered: number
  absent: number
  approved: number
  failed: number
  average_percent: number
  published: boolean
  pending: number
  complete: boolean
  signed_off: boolean
  entry_percent: number
}

interface MonitorResponse {
  items: Paper[]
  summary: {
    papers: number
    complete: number
    signed_off: number
    marks_pending: number
    backlogs: number
    complete_percent: number
  }
}

export default function ExamMonitoring() {
  const qc = useQueryClient()
  const [classId, setClassId] = useState('')

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const monitor = useQuery({
    queryKey: ['exam-monitor', classId],
    queryFn: () =>
      api.get<MonitorResponse>(
        '/api/v1/academics/admin/exam-monitor' + (classId ? `?class_id=${classId}` : ''),
      ),
  })

  const approve = useMutation({
    mutationFn: (v: { exam_subject_id?: string; exam_id?: string }) =>
      api.post('/api/v1/academics/admin/exam-monitor/approve', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exam-monitor'] }),
  })

  const rows = monitor.data?.items ?? []
  const sort = useSort<Paper>(
    rows,
    (p, k) => (p as unknown as Record<string, string | number>)[k],
    { key: 'entry_percent' },
  )

  if (monitor.isLoading) return <Loading label="Counting what has been entered…" />
  if (monitor.error) return <ErrorState error={monitor.error} />

  const s = monitor.data?.summary
  const exams = [...new Set(rows.map((r) => r.exam_id))]

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Exams and marks monitoring"
        description="Entry progress paper by paper, the marks still waiting, and the sign-off that lets a result be published."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Papers complete"
            value={`${s?.complete ?? 0} / ${s?.papers ?? 0}`}
            icon={ClipboardList}
            delta={{
              value: `${s?.complete_percent ?? 0}% of papers fully entered`,
              positive: (s?.complete_percent ?? 0) >= 90,
            }}
          />
          <Stat label="Marks still to enter" value={s?.marks_pending ?? 0} icon={Users} />
          <Stat label="Signed off" value={s?.signed_off ?? 0} icon={CheckCircle2} />
          <Stat
            label="Backlogs"
            value={s?.backlogs ?? 0}
            icon={TriangleAlert}
            hint="Marks below the pass line"
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Papers"
            description="Entry counted against the class roll, not against the marks already in. A paper can only be signed off once it is complete."
            action={
              <div className="flex items-center gap-2">
                <Select
                  value={classId}
                  onChange={setClassId}
                  options={(classes.data?.items ?? []).map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                  placeholder="Every class"
                />
                {exams.length === 1 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={approve.isPending}
                    onClick={() => approve.mutate({ exam_id: exams[0] })}
                    title="Sign off every complete paper in this exam"
                  >
                    Sign off complete papers
                  </Button>
                )}
              </div>
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No papers scheduled"
              body="Create an exam and add its subjects; entry progress appears here as marks arrive."
            />
          ) : (
            <Table
              head={[
                { label: 'Exam', key: 'exam_name' },
                { label: 'Class', key: 'class_name' },
                { label: 'Subject', key: 'subject' },
                { label: 'Marked by', key: 'teachers' },
                { label: 'Entered', key: 'entry_percent' },
                { label: 'Average', key: 'average_percent' },
                { label: 'Below pass', key: 'failed' },
                { label: 'Status', key: 'signed_off' },
                '',
              ]}
              sort={sort}
            >
              {sort.sorted.map((p) => (
                <tr key={p.exam_subject_id}>
                  <Td className="font-medium">
                    {p.exam_name}
                    {p.exam_date && (
                      <span className="block text-[12px] text-muted-foreground">
                        {formatDate(p.exam_date)}
                      </span>
                    )}
                  </Td>
                  <Td>{p.class_name}</Td>
                  <Td>{p.subject}</Td>
                  <Td className="text-muted-foreground">{p.teachers ?? 'Unassigned'}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-20 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            p.complete ? 'bg-success' : 'bg-warning',
                          )}
                          style={{ width: `${Math.min(100, p.entry_percent)}%` }}
                        />
                      </div>
                      <span className="tabular-nums">
                        {p.entered}/{p.eligible}
                      </span>
                    </div>
                  </Td>
                  <Td className="tabular-nums">
                    {p.entered ? `${p.average_percent}%` : '—'}
                  </Td>
                  <Td className="tabular-nums">{p.failed || '—'}</Td>
                  <Td>
                    {p.signed_off ? (
                      <Badge tone="success">signed off</Badge>
                    ) : p.complete ? (
                      <Badge tone="warning">awaiting sign-off</Badge>
                    ) : (
                      <Badge tone="neutral">{p.pending} to enter</Badge>
                    )}
                  </Td>
                  <Td>
                    {p.complete && !p.signed_off && (
                      <Button
                        size="sm"
                        disabled={approve.isPending}
                        onClick={() => approve.mutate({ exam_subject_id: p.exam_subject_id })}
                      >
                        Sign off
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <div className="px-5 pb-5">
            <FormNotice error={approve.error} />
          </div>
        </Card>
      </PageBody>
    </>
  )
}
