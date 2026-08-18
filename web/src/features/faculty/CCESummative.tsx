import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileCheck2 } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Checkbox, FormNotice, Input,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { formatDate } from '@/lib/utils'
import { numOrNull, type SummativePaper } from './teaching'

/* Summative assessment: the dated paper with a mark.

   Nothing new is stored for this half. A summative is exactly what the schema
   already models — an exam of kind 'summative', a paper per subject in
   exam_subjects, and a row per child in marks — and the grade is derived from
   the school's own grading scale on save. A parallel CCE marks table would
   have been a second place a child's SA1 lived, and the two would disagree the
   first time one was corrected.

   The formative half is a separate screen and a separate table, because four
   activities and a written observation cannot honestly be squeezed into one
   numeric column. The two meet again on the report card, keyed by the same
   student, subject and term. */

interface RosterRow {
  student_id: string
  admission_no: string
  full_name: string
  roll_no?: number
  marks_obtained?: number
  grade?: string
  is_absent?: boolean
}

export default function CCESummative() {
  const [openID, setOpenID] = useState('')

  const list = useQuery({
    queryKey: ['cce-summative'],
    queryFn: () => api.get<List<SummativePaper>>('/api/v1/teaching/cce/summative'),
  })

  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const rows = list.data?.items ?? []
  const done = rows.filter((p) => p.entered >= p.roll && p.roll > 0).length

  return (
    <>
      <PageHead
        eyebrow="Assessment schemes"
        title="CCE summative assessment"
        description="Enter marks for a summative paper. The grade comes from the school's grading scale, not from the keyboard."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Papers you can mark" value={rows.length} icon={FileCheck2} />
          <Stat label="Fully entered" value={`${done} of ${rows.length}`} />
          <Stat
            label="Still outstanding"
            value={rows.length - done}
            delta={{
              value: rows.length - done > 0 ? 'Marks pending' : 'All entered',
              positive: rows.length === done,
            }}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Papers"
            description="Summative and term papers for the subjects you teach."
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No papers to mark"
              body="A summative exam has to be scheduled by the examination office before marks can be entered."
            />
          ) : (
            <Table head={['Exam', 'Class', 'Subject', 'Sat', 'Out of', 'Entered', 'Average', '']}>
              {rows.map((p) => (
                <tr key={p.exam_subject_id}>
                  <Td>
                    <span className="font-medium">{p.exam_name}</span>
                    <span className="block text-[12px] text-muted-foreground">{p.kind}</span>
                  </Td>
                  <Td>{p.class_name}</Td>
                  <Td>{p.subject}</Td>
                  <Td>{p.exam_date ? formatDate(p.exam_date) : '—'}</Td>
                  <Td>{p.max_marks}</Td>
                  <Td>
                    {p.entered >= p.roll && p.roll > 0
                      ? <Badge tone="success">{p.entered} of {p.roll}</Badge>
                      : <Badge tone="warning">{p.entered} of {p.roll}</Badge>}
                  </Td>
                  <Td>{p.average != null ? p.average.toFixed(1) : '—'}</Td>
                  <Td>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setOpenID(openID === p.exam_subject_id ? '' : p.exam_subject_id)}
                    >
                      {openID === p.exam_subject_id ? 'Close' : 'Enter marks'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {openID && (
          <Entry paper={rows.find((p) => p.exam_subject_id === openID)!} />
        )}
      </PageBody>
    </>
  )
}

function Entry({ paper }: { paper: SummativePaper }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, { marks: string; absent: boolean }>>({})

  /* The roster comes from the assignments endpoint's shape: every child in the
     class, whether or not a mark exists. Reused rather than duplicated so the
     two marking screens cannot disagree about who is on roll. */
  const roster = useQuery({
    queryKey: ['cce-summative-roster', paper.exam_subject_id],
    queryFn: () =>
      api.get<List<RosterRow>>(
        `/api/v1/teaching/cce/summative/roster?exam_subject_id=${paper.exam_subject_id}`,
      ),
  })

  useEffect(() => setDraft({}), [paper.exam_subject_id])

  const save = useMutation({
    mutationFn: () => {
      const entries = Object.entries(draft)
        .filter(([, v]) => v.marks.trim() !== '' || v.absent)
        .map(([student_id, v]) => ({
          student_id,
          marks_obtained: v.absent ? null : numOrNull(v.marks),
          is_absent: v.absent,
        }))
      return api.put('/api/v1/teaching/cce/summative', {
        exam_subject_id: paper.exam_subject_id,
        entries,
      })
    },
    onSuccess: () => {
      toast.ok('Marks entered')
      setDraft({})
      qc.invalidateQueries({ queryKey: ['cce-summative'] })
      qc.invalidateQueries({ queryKey: ['cce-summative-roster', paper.exam_subject_id] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  })

  const rows = roster.data?.items ?? []

  return (
    <Card>
      <CardHeader
        title={`${paper.exam_name} — ${paper.class_name} ${paper.subject}`}
        description={`Out of ${paper.max_marks}, pass at ${paper.pass_marks}. Mark a child absent rather than entering zero — the two mean different things on a report card.`}
        action={
          <Button onClick={() => save.mutate()} disabled={Object.keys(draft).length === 0}>
            Save marks
          </Button>
        }
      />
      {roster.isLoading ? (
        <Loading />
      ) : roster.error ? (
        <ErrorState error={roster.error} />
      ) : rows.length === 0 ? (
        <EmptyState title="No children on this paper" />
      ) : (
        <Table head={['Roll', 'Child', 'Mark', 'Absent', 'Grade']}>
          {rows.map((r) => (
            <tr key={r.student_id}>
              <Td>{r.roll_no ?? '—'}</Td>
              <Td>
                <span className="font-medium">{r.full_name}</span>
                <span className="block text-[12px] text-muted-foreground">{r.admission_no}</span>
              </Td>
              <Td>
                <Input
                  value={draft[r.student_id]?.marks ?? (r.marks_obtained?.toString() ?? '')}
                  onChange={(v) =>
                    setDraft((d) => {
                      const cur = d[r.student_id] ?? { marks: '', absent: false }
                      return { ...d, [r.student_id]: { ...cur, marks: v } }
                    })
                  }
                  placeholder={`/${paper.max_marks}`}
                  className="w-20"
                />
              </Td>
              <Td>
                <Checkbox
                  checked={draft[r.student_id]?.absent ?? r.is_absent ?? false}
                  onChange={(v) =>
                    setDraft((d) => {
                      const cur = d[r.student_id] ?? { marks: '', absent: false }
                      return { ...d, [r.student_id]: { ...cur, absent: v } }
                    })
                  }
                  label=""
                  srLabel={`Mark ${r.full_name} absent`}
                />
              </Td>
              <Td>{r.grade ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
      <div className="px-5 pb-5">
        <FormNotice error={save.error} />
      </div>
    </Card>
  )
}
