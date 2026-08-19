import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, ScanLine, TriangleAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Field, FormGrid, FormNotice, Select,
  Loading, ErrorState, EmptyState, Panel,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { type GradableTest, type GradingKey, type ItemAnalysisRow } from './classroom'

/* Grading an objective paper without a scanner.

   No OMR means no special sheet and no hardware: a teacher with a stack of
   scripts types each child's answers against the key and the system marks
   them. A paper sat in the portal grades through exactly the same code, so
   the two never disagree.

   The item analysis is the half worth having. A mark sheet says who failed;
   this says whether the paper was fair. A question four children out of thirty
   got right, where the four are not the four who topped the paper, is the
   signature of a mis-keyed answer — and "check the key" is flagged in exactly
   that case, because the alternative reading is that thirty children failed
   the same idea on the same day, which is almost never true. */

const FLAG_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  too_easy: 'info',
  too_hard: 'warning',
  poor_discrimination: 'warning',
  check_key: 'danger',
}

const FLAG_LABEL: Record<string, string> = {
  ok: 'Sound',
  too_easy: 'Everyone got it',
  too_hard: 'Almost nobody got it',
  poor_discrimination: 'Does not discriminate',
  check_key: 'Check the answer key',
}

export default function ExamGrading() {
  const toast = useToast()
  const qc = useQueryClient()
  const [testID, setTestID] = useState('')
  const [studentID, setStudentID] = useState('')
  const [sheet, setSheet] = useState<Record<string, string>>({})

  const tests = useQuery({
    queryKey: ['classroom-gradable-tests'],
    queryFn: () => api.get<List<GradableTest>>('/api/v1/classroom/grading/tests'),
  })

  const key = useQuery({
    enabled: !!testID,
    queryKey: ['classroom-grading-key', testID],
    queryFn: () => api.get<GradingKey>(`/api/v1/classroom/grading/tests/${testID}/key`),
  })

  const analysis = useQuery({
    enabled: !!testID,
    queryKey: ['classroom-item-analysis', testID],
    queryFn: () =>
      api.get<List<ItemAnalysisRow>>(
        `/api/v1/classroom/grading/tests/${testID}/item-analysis`,
      ),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['classroom-grading-key', testID] })
    qc.invalidateQueries({ queryKey: ['classroom-item-analysis', testID] })
    qc.invalidateQueries({ queryKey: ['classroom-gradable-tests'] })
  }

  const enter = useMutation({
    mutationFn: () =>
      api.post<{ score: number; max_score: number; correct: number; wrong: number }>(
        `/api/v1/classroom/grading/tests/${testID}/attempts`,
        {
          student_id: studentID,
          // Every question is posted, including the blanks. An empty selection
          // is "attempted nothing" and must not be confused with a wrong
          // answer, which is what negative marking turns on.
          responses: (key.data?.questions ?? []).map((q) => ({
            test_question_id: q.test_question_id,
            selected_option_ids: sheet[q.test_question_id]
              ? [sheet[q.test_question_id]]
              : [],
          })),
        },
      ),
    onSuccess: (res) => {
      toast.ok(`Marked: ${res.score} of ${res.max_score}`)
      setSheet({})
      setStudentID('')
      invalidate()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not grade'),
  })

  const regrade = useMutation({
    mutationFn: () => api.post(`/api/v1/classroom/grading/tests/${testID}/regrade`, {}),
    onSuccess: () => {
      toast.ok('Every sheet re-marked')
      invalidate()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not regrade'),
  })

  if (tests.isLoading) return <Loading />
  if (tests.error) return <ErrorState error={tests.error} />

  const rows = analysis.data?.items ?? []
  const suspect = rows.filter((r) => r.flag === 'check_key').length
  const paper = (tests.data?.items ?? []).find((t) => t.id === testID)
  const pending = (key.data?.roster ?? []).filter((s) => !s.attempt_id).length

  return (
    <>
      <PageHead
        eyebrow="Question papers & online tests"
        title="No-OMR exam grading"
        description="Type answers against the key, or grade what the portal captured — then read the paper, not just the class."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Papers" value={tests.data?.items.length ?? 0} icon={ClipboardCheck} />
          <Stat label="Graded" value={paper?.graded_attempts ?? 0} icon={ScanLine} />
          <Stat label="Not yet entered" value={pending} />
          <Stat label="Questions to check" value={suspect} icon={TriangleAlert} />
        </CellGrid>

        <Card>
          <CardHeader
            title="The paper"
            action={
              testID ? (
                <Button
                  variant="ghost"
                  onClick={() => regrade.mutate()}
                  disabled={regrade.isPending}
                >
                  Re-mark every sheet
                </Button>
              ) : undefined
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="Test">
                <Select
                  value={testID}
                  onChange={(v) => {
                    setTestID(v)
                    setSheet({})
                    setStudentID('')
                  }}
                  placeholder="Choose a paper…"
                  options={(tests.data?.items ?? []).map((t) => ({
                    value: t.id,
                    label: `${t.section_name} · ${t.subject_name} · ${t.title}`,
                  }))}
                />
              </Field>
            </FormGrid>
          </div>
        </Card>

        {testID && key.isLoading && <Loading />}
        {key.error && <ErrorState error={key.error} />}

        {key.data && (
          <Card>
            <CardHeader
              title="Enter a script"
              description={`${key.data.questions.length} questions, ${key.data.max_score} marks${
                key.data.allow_partial_credit ? ', partial credit on multi-answer questions' : ''
              }.`}
            />
            <div className="p-5 space-y-5">
              <FormGrid>
                <Field label="Child">
                  <Select
                    value={studentID}
                    onChange={setStudentID}
                    placeholder="Choose a child…"
                    options={key.data.roster.map((s) => ({
                      value: s.student_id,
                      label: `${s.admission_no} · ${s.student_name}${
                        s.attempt_id ? ` (entered: ${s.score ?? '—'})` : ''
                      }`,
                    }))}
                  />
                </Field>
              </FormGrid>
            </div>
            <Table
              head={['#', 'Question', 'Answer', 'Marks', 'Negative']}
              empty={key.data.questions.length === 0}
              emptyLabel="No questions on this paper yet."
            >
              {key.data.questions.map((q) => (
                <tr key={q.test_question_id}>
                  <Td>{q.sequence}</Td>
                  <Td>{q.stem}</Td>
                  <Td>
                    <Select
                      value={sheet[q.test_question_id] ?? ''}
                      onChange={(v) =>
                        setSheet((s) => ({ ...s, [q.test_question_id]: v }))
                      }
                      placeholder="Not attempted"
                      options={q.options.map((o) => ({
                        value: o.id,
                        label: o.body,
                      }))}
                    />
                  </Td>
                  <Td>{q.marks}</Td>
                  <Td>{q.negative_marks ? `−${q.negative_marks}` : '—'}</Td>
                </tr>
              ))}
            </Table>
            <div className="p-5 space-y-5">
              <FormNotice error={enter.error} />
              <Button
                onClick={() => enter.mutate()}
                disabled={!studentID || enter.isPending}
              >
                Mark this script
              </Button>
              <Panel className="p-4 text-[13px] text-muted-foreground">
                A question left as "not attempted" scores nothing and is never negatively
                marked. That is the difference between a blank and a wrong answer, and it
                is what the totals below depend on.
              </Panel>
            </div>
          </Card>
        )}

        {testID && (
          <Card>
            <CardHeader
              title="Item analysis"
              description="Facility is the share of those who attempted it who got it right. Discrimination compares the strongest and weakest 27%."
            />
            <Table
              head={['#', 'Question', 'Attempted', 'Correct', 'Facility', 'Discrimination', 'Pulled most', 'Verdict']}
              empty={rows.length === 0}
              emptyLabel="Nothing graded yet — the analysis needs sat papers."
            >
              {rows.map((r) => (
                <tr key={r.test_question_id}>
                  <Td>{r.sequence}</Td>
                  <Td>{r.stem}</Td>
                  <Td>{r.attempted}</Td>
                  <Td>{r.correct}</Td>
                  <Td>{r.facility ?? '—'}</Td>
                  <Td>{r.discrimination ?? '—'}</Td>
                  <Td>
                    {r.top_distractor
                      ? `${r.top_distractor} (${r.top_distractor_count})`
                      : '—'}
                  </Td>
                  <Td>
                    <Badge tone={FLAG_TONE[r.flag] ?? 'neutral'}>
                      {FLAG_LABEL[r.flag] ?? r.flag}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {!testID && (
          <EmptyState
            title="Choose a paper"
            body="Its key, its roll and its item analysis are all per paper."
          />
        )}
      </PageBody>
    </>
  )
}
