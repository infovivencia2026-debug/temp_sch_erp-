import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button,
  Input, Textarea, Field, FormGrid, FormNotice, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useRouteFeature } from '@/lib/catalog'
import { formatDate } from '@/lib/utils'

/* Marks, read a paper at a time.
 *
 * The gradebook shows one paper student by student, which is the right shape
 * for entering marks and the wrong shape for the question a head of department
 * asks after an exam: is this paper out of line with the others. That question
 * is about the paper — its average, its spread, how many failed — so this
 * screen counts rather than lists.
 *
 * The adjustment is written to grace marks, not folded into what the teacher
 * marked. Two different facts: what the child scored, and what the department
 * added because the paper was harsh. Adding them together loses the second one
 * and makes the next moderation compound on the first.
 */

interface Row {
  exam_subject_id: string
  exam_name: string
  class: string
  subject: string
  max_marks: string
  pass_marks: string
  entered: number
  absent: number
  failing: number
  average_pct: string | null
  highest_pct: string | null
  lowest_pct: string | null
  /* Marks on this paper above the paper's own maximum. Absent when there are
     none, which is every paper that has not got the fault. While it is set,
     the three percentages above are arithmetically correct and physically
     impossible — 50 on a paper out of 20 is an honest 250% — so they are not
     printed. They are not clamped either: a mark somebody actually typed is
     evidence, and 100% in its place is a number nobody would ever question. */
  marks_above_max?: number
  adjustment: string | null
  reason: string | null
  moderated_by: string | null
  moderated_at: string | null
}

export default function MarkModeration() {
  const nav = useRouteFeature()
  const qc = useQueryClient()
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [adjustment, setAdjustment] = useState('0')
  const [reason, setReason] = useState('')
  const [done, setDone] = useState('')

  const q = useQuery({
    queryKey: ['mark-moderation'],
    queryFn: () =>
      api.get<{ items: Row[]; whole_school: boolean }>('/api/v1/exams/moderation'),
  })

  const save = useMutation({
    mutationFn: (v: { exam_subject_id: string; adjustment: number; reason: string }) =>
      api.post<{ students: number }>('/api/v1/exams/moderation', v),
    onSuccess: (r) => {
      setDone(
        Number(adjustment) === 0
          ? 'Recorded as read, with no change to the marks.'
          : `Applied to ${r.students} students.`,
      )
      setOpenRow(null)
      setReason('')
      setAdjustment('0')
      qc.invalidateQueries({ queryKey: ['mark-moderation'] })
    },
  })

  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data!

  return (
    <>
      {/* The breadcrumb every other screen carries, from the catalogue —
          which is also the name in the menu and the name search matches. */}
      <PageHead
        eyebrow={nav.section?.name}
        title={nav.feature?.name ?? 'Mark moderation'}
        description={
          d.whole_school
            ? 'Every paper in the school that has marks entered.'
            : "Papers in your department that have marks entered."
        }
      />
      <PageBody>
        {done && <FormNotice ok={done} />}
        {save.error && <FormNotice error={save.error} />}

        <Card>
          <CardHeader title="Papers" description="Unmoderated papers are listed first." />
          {d.items.length === 0 ? (
            <EmptyState
              title="No marks have been entered yet."
              body="A paper appears here once a teacher has entered marks against it."
            />
          ) : (
            <Table
              head={['Paper', 'Marked', 'Average', 'Range', 'Below pass', 'Moderation', '']}
            >
              {d.items.map((r) => {
                const moderated = r.adjustment !== null
                const overMax = r.marks_above_max ?? 0
                return (
                  <tr key={r.exam_subject_id}>
                    <Td>
                      {r.class} · {r.subject}
                      <span className="block text-[11.5px] text-muted-foreground">
                        {r.exam_name} · out of {r.max_marks}
                      </span>
                    </Td>
                    <Td>
                      {r.entered}
                      {r.absent > 0 && (
                        <span className="block text-[11.5px] text-muted-foreground">
                          {r.absent} absent
                        </span>
                      )}
                    </Td>
                    <Td>
                      {overMax > 0
                        ? '—'
                        : r.average_pct
                          ? `${r.average_pct}%`
                          : '—'}
                    </Td>
                    <Td>
                      {overMax > 0 ? (
                        <Badge tone="danger">
                          {overMax === 1
                            ? '1 mark above the paper maximum'
                            : `${overMax} marks above the paper maximum`}
                        </Badge>
                      ) : r.lowest_pct && r.highest_pct ? (
                        <span className="num">{r.lowest_pct}–{r.highest_pct}%</span>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>
                      {/* Failures are the number somebody acts on, so they are
                          drawn as a state and not just a count. */}
                      {r.failing > 0 ? (
                        <Badge tone="warning">{r.failing}</Badge>
                      ) : (
                        <span className="text-muted-foreground">none</span>
                      )}
                    </Td>
                    <Td>
                      {moderated ? (
                        <>
                          <Badge tone={Number(r.adjustment) === 0 ? 'neutral' : 'success'}>
                            {Number(r.adjustment) === 0
                              ? 'Read, no change'
                              : `${Number(r.adjustment) > 0 ? '+' : ''}${r.adjustment}`}
                          </Badge>
                          <span className="block text-[11.5px] text-muted-foreground">
                            {r.moderated_by}
                            {r.moderated_at ? ` · ${formatDate(r.moderated_at)}` : ''}
                            {r.reason ? ` · ${r.reason}` : ''}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">not read yet</span>
                      )}
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const next = openRow === r.exam_subject_id ? null : r.exam_subject_id
                          setOpenRow(next)
                          setAdjustment(r.adjustment ?? '0')
                          setReason(r.reason ?? '')
                        }}
                      >
                        {moderated ? 'Change' : 'Moderate'}
                      </Button>
                      {openRow === r.exam_subject_id && (
                        <div className="mt-2 space-y-2">
                          <FormGrid>
                            <Field
                              label="Marks to add or take off"
                              hint="Leave at 0 to record that you read it and changed nothing."
                            >
                              <Input type="number" value={adjustment} onChange={setAdjustment} />
                            </Field>
                            <Field label="Why">
                              <Textarea
                                rows={2}
                                value={reason}
                                onChange={setReason}
                                placeholder="Question 7 was outside the syllabus, so the whole section lost 4 marks."
                              />
                            </Field>
                          </FormGrid>
                          <p className="text-[11.5px] text-muted-foreground">
                            Added as grace marks, so what the teacher marked is kept. Nobody
                            goes above {r.max_marks} or below zero, and students marked absent
                            are left alone.
                          </p>
                          <Button
                            size="sm"
                            onClick={() =>
                              save.mutate({
                                exam_subject_id: r.exam_subject_id,
                                adjustment: Number(adjustment),
                                reason,
                              })
                            }
                            disabled={!reason.trim() || save.isPending}
                          >
                            Save
                          </Button>
                        </div>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
