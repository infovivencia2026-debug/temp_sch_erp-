import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'

interface Paper {
  id: string; label: string; max_marks: number
  marks_entered: number; students: number
}

interface Row {
  student_id: string; admission_no: string; full_name: string
  marks_obtained?: number; max_marks: number; grade?: string; is_absent: boolean
}

/** Marks entry. The grade is computed server-side from the exam's grading
    scale — the teacher enters marks, never a grade. */
export default function Gradebook() {
  const qc = useQueryClient()
  const [esID, setESID] = useState('')

  // A teacher picks the paper from a list. Asking them to paste a UUID was the
  // single worst thing left in the interface.
  const papers = useQuery({
    queryKey: ['exam-subjects'],
    queryFn: () => api.get<List<Paper>>('/api/v1/exams/subjects'),
  })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [absent, setAbsent] = useState<Set<string>>(new Set())


  const book = useQuery({
    queryKey: ['gradebook', esID],
    queryFn: () => api.get<List<Row>>(`/api/v1/exams/gradebook?exam_subject_id=${esID}`),
    enabled: !!esID,
  })

  const toast = useToast()

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/exams/marks', {
        exam_subject_id: esID,
        entries: (book.data?.items ?? [])
          .filter((r) => draft[r.student_id] !== undefined || absent.has(r.student_id))
          .map((r) => ({
            student_id: r.student_id,
            marks_obtained: absent.has(r.student_id) ? null : parseFloat(draft[r.student_id] ?? '0'),
            is_absent: absent.has(r.student_id),
          })),
      }),
    onSuccess: () => {
      // Counted before the draft is cleared: the mutation builds its own
      // payload, so there is nothing handed back to count.
      const entered = new Set([...Object.keys(draft), ...absent]).size
      setDraft({}); setAbsent(new Set())
      qc.invalidateQueries({ queryKey: ['gradebook', esID] })
      toast.ok(`${entered} mark${entered === 1 ? '' : 's'} entered`)
    },
  })

  const rows = book.data?.items ?? []
  const entered = rows.filter((r) => r.marks_obtained != null).length
  const max = rows[0]?.max_marks ?? 0
  const avg = entered
    ? Math.round(rows.reduce((a, r) => a + (r.marks_obtained ?? 0), 0) / entered)
    : 0

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Marks entry"
        description="Enter marks for a paper. Grades are derived from the exam's grading scale, not typed."
        actions={
          <Select
            value={esID}
            onChange={setESID}
            placeholder="Choose a paper"
            options={(papers.data?.items ?? []).map((p) => ({
              value: p.id,
              label: `${p.label} — ${p.marks_entered}/${p.students} entered`,
            }))}
          />
        }
      />
      <PageBody>
        {!esID ? (
          <EmptyState
            title="Choose a paper"
            body={
              papers.data?.items.length
                ? 'Pick a paper above to start entering marks.'
                : 'No exam papers exist yet. Create an exam in setup first.'
            }
          />
        ) : book.isLoading ? (
          <Loading />
        ) : book.error ? (
          <ErrorState error={book.error} />
        ) : (
          <>
            <CellGrid cols={4}>
              <Stat label="Students" value={rows.length} />
              <Stat label="Marks entered" value={`${entered}/${rows.length}`} />
              <Stat label="Class average" value={entered ? `${avg}/${max}` : '—'} />
              <Stat label="Pending" value={rows.length - entered} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Gradebook"
                description={`Out of ${max}`}
                action={
                  <Button
                    disabled={save.isPending || (!Object.keys(draft).length && !absent.size)}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? 'Saving…' : 'Save marks'}
                  </Button>
                }
              />
              <Table head={['Admission no.', 'Student', 'Marks', 'Absent', 'Grade']} empty={!rows.length}>
                {rows.map((r) => (
                  <tr key={r.student_id}>
                    <Td className="font-mono text-[12px]">{r.admission_no}</Td>
                    <Td className="font-medium">{r.full_name}</Td>
                    <Td>
                      <input
                        type="number" min={0} max={r.max_marks}
                        disabled={absent.has(r.student_id)}
                        value={draft[r.student_id] ?? r.marks_obtained ?? ''}
                        onChange={(e) => setDraft({ ...draft, [r.student_id]: e.target.value })}
                        className="field w-24 disabled:opacity-40"
                      />
                    </Td>
                    <Td>
                      <input
                        type="checkbox"
                        checked={absent.has(r.student_id) || r.is_absent}
                        onChange={() => {
                          const n = new Set(absent)
                          n.has(r.student_id) ? n.delete(r.student_id) : n.add(r.student_id)
                          setAbsent(n)
                        }}
                        aria-label={`Mark ${r.full_name} absent`}
                      />
                    </Td>
                    <Td>{r.grade ? <Badge tone="primary">{r.grade}</Badge> : '—'}</Td>
                  </tr>
                ))}
              </Table>
              {save.isError && (
                <p className="border-t px-5 py-2.5 text-[13px] text-destructive">
                  {save.error instanceof Error ? save.error.message : 'Could not save marks'}
                </p>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
