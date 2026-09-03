import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Library, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Checkbox, Field, FormGrid, FormNotice, Input, Select, Textarea,
  SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
import { useToast } from '@/components/Toast'
import {
  BLOOM_LEVELS, DIFFICULTIES, OBJECTIVE_KINDS, QUESTION_KINDS,
  useTeachingSubjects, label,
  type BankQuestion, type BankSummary,
} from './teaching'

/* The question bank.

   Tagged by chapter, difficulty and Bloom's level, because the three questions
   a teacher actually asks of a bank are "what covers chapter 4", "have I got
   enough hard ones", and "is this paper all recall". The summary answers the
   last two at a glance; without it a bank is a list nobody audits. */

export default function QuestionBank() {
  const [composing, setComposing] = useState(false)
  const [subject, setSubject] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [bloom, setBloom] = useState('')
  const [search, setSearch] = useState('')

  const query = new URLSearchParams()
  if (subject) query.set('class_subject_id', subject)
  if (difficulty) query.set('difficulty', difficulty)
  if (bloom) query.set('bloom_level', bloom)
  if (search.trim()) query.set('search', search.trim())
  const qs = query.toString()

  const list = useQuery({
    queryKey: ['question-bank', qs],
    queryFn: () =>
      api.get<List<BankQuestion>>(`/api/v1/teaching/question-bank${qs ? `?${qs}` : ''}`),
  })
  const summary = useQuery({
    queryKey: ['question-bank-summary'],
    queryFn: () => api.get<List<BankSummary>>('/api/v1/teaching/question-bank/summary'),
  })
  const subjects = useTeachingSubjects()

  const toast = useToast()
  const qc = useQueryClient()
  const retire = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/teaching/question-bank/${id}`),
    onSuccess: () => {
      toast.ok('Question retired')
      qc.invalidateQueries({ queryKey: ['question-bank'] })
      qc.invalidateQueries({ queryKey: ['question-bank-summary'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not retire'),
  })

  if (list.isLoading) return <SkeletonTable columns={9} />
  if (list.error) return <ErrorState error={list.error} />
  const rows = list.data?.items ?? []
  /* A bank exists to be reused, and one that cannot be searched is one where
     the same question is typed again next term. Over the stem, the chapter and
     the subject — the three things somebody half-remembers about a question
     they know they have written before. */
  const { q: term, setQ: setTerm, shown } = useSearch(rows,
    (x) => [x.stem, x.chapter, x.subject, x.class_name, x.kind, x.difficulty])
  const banks = summary.data?.items ?? []
  const total = banks.reduce((n, b) => n + b.total, 0)
  const higher = banks.reduce((n, b) => n + b.higher_order, 0)

  return (
    <>
      <PageHead
        eyebrow="Question papers & online tests"
        title="Question bank"
        description="Questions tagged by chapter, difficulty and Bloom's level, ready to build a paper from."
        actions={
          <Button onClick={() => setComposing((c) => !c)}>
            <Plus className="h-3.5 w-3.5" />
            {composing ? 'Close' : 'Add a question'}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Questions banked" value={total} icon={Library} />
          <Stat
            label="Auto-markable"
            value={banks.reduce((n, b) => n + b.objective, 0)}
            hint="Multiple choice, true/false and fill-in-the-blank"
          />
          <Stat
            label="Above recall"
            value={higher}
            delta={{
              value: total > 0 && higher * 3 < total ? 'Mostly recall' : 'Reasonable spread',
              positive: !(total > 0 && higher * 3 < total),
            }}
          />
        </CellGrid>

        {composing && <Compose onDone={() => setComposing(false)} />}

        <Card>
          <CardHeader
            title="By subject"
            description="Whether each bank is deep enough, and of the right kind"
          />
          {banks.length === 0 ? (
            <EmptyState title="No subjects" />
          ) : (
            <Table head={['Class', 'Subject', 'Total', 'Objective', 'Easy', 'Medium', 'Hard', 'Above recall', 'Chapters']}>
              {banks.map((b) => (
                <tr key={b.class_subject_id}>
                  <Td>{b.class_name}</Td>
                  <Td>{b.subject}</Td>
                  <Td>{b.total}</Td>
                  <Td>{b.objective}</Td>
                  <Td>{b.easy}</Td>
                  <Td>{b.medium}</Td>
                  <Td>{b.hard}</Td>
                  <Td>{b.higher_order}</Td>
                  <Td>{b.chapters_covered}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Questions"
            action={
              <>
                <Input value={search} onChange={setSearch} placeholder="Search the stem" />
                <Select
                  value={subject}
                  onChange={setSubject}
                  placeholder="Any subject"
                  options={(subjects.data?.items ?? []).map((s) => ({
                    value: s.class_subject_id,
                    label: `${s.class_name} · ${s.subject}`,
                  }))}
                />
                <Select
                  value={difficulty}
                  onChange={setDifficulty}
                  placeholder="Any difficulty"
                  options={DIFFICULTIES.map((d) => ({ value: d.value, label: d.label }))}
                />
                <Select
                  value={bloom}
                  onChange={setBloom}
                  placeholder="Any level"
                  options={BLOOM_LEVELS.map((b) => ({ value: b.value, label: b.label }))}
                />
              </>
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No questions match"
              body="Add one, or widen the filters."
            />
          ) : (
            <>
            <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
              <SearchBox value={term} onChange={setTerm} placeholder="Stem, chapter or subject" />
              <Showing shown={shown.length} total={rows.length} noun="questions" />
              <ExportRows
                rows={shown}
                name="question-bank"
                columns={[
                  { header: 'Question', value: (x) => x.stem },
                  { header: 'Class', value: (x) => x.class_name },
                  { header: 'Subject', value: (x) => x.subject },
                  { header: 'Chapter', value: (x) => x.chapter },
                  { header: 'Kind', value: (x) => x.kind },
                  { header: 'Difficulty', value: (x) => x.difficulty },
                  { header: 'Bloom level', value: (x) => x.bloom_level },
                  { header: 'Marks', value: (x) => x.default_marks },
                  { header: 'Times used', value: (x) => x.used_on_tests },
                  { header: 'Answer', value: (x) => x.options.join(' | ') },
                ]}
              />
            </div>
            <Table head={['Question', 'Class', 'Subject', 'Chapter', 'Kind', 'Difficulty', "Bloom's", 'Marks', 'Used', '']}>
              {shown.map((q) => (
                <tr key={q.id}>
                  <Td>
                    <span className="font-medium">{q.stem}</span>
                    {q.options.length > 0 && (
                      <span className="block text-[12px] text-muted-foreground">
                        {q.options.join(' · ')}
                      </span>
                    )}
                  </Td>
                  <Td>{q.class_name}</Td>
                  <Td>{q.subject}</Td>
                  <Td>{q.chapter ?? '—'}</Td>
                  <Td>
                    {q.objective
                      ? <Badge tone="success">{label(QUESTION_KINDS, q.kind)}</Badge>
                      : <Badge tone="neutral">{label(QUESTION_KINDS, q.kind)}</Badge>}
                  </Td>
                  <Td>{label(DIFFICULTIES, q.difficulty)}</Td>
                  <Td>{label(BLOOM_LEVELS, q.bloom_level)}</Td>
                  <Td>{q.default_marks}</Td>
                  <Td>{q.used_on_tests}</Td>
                  <Td>
                    <Button variant="secondary" size="sm" onClick={() => retire.mutate(q.id)}>
                      Retire
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
            </>
          )}
        </Card>
      </PageBody>
    </>
  )
}

interface DraftOption { body: string; is_correct: boolean }

function Compose({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const subjects = useTeachingSubjects()

  const [classSubjectID, setClassSubjectID] = useState('')
  const [kind, setKind] = useState('mcq')
  const [difficulty, setDifficulty] = useState('medium')
  const [bloom, setBloom] = useState('understand')
  const [stem, setStem] = useState('')
  const [marks, setMarks] = useState('1')
  const [explanation, setExplanation] = useState('')
  const [options, setOptions] = useState<DraftOption[]>([
    { body: '', is_correct: false },
    { body: '', is_correct: false },
    { body: '', is_correct: false },
    { body: '', is_correct: false },
  ])

  const objective = OBJECTIVE_KINDS.includes(kind)

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/teaching/question-bank', {
        class_subject_id: classSubjectID,
        kind,
        difficulty,
        bloom_level: bloom,
        stem,
        default_marks: Number(marks) || 1,
        explanation: explanation || undefined,
        options: objective
          ? options.filter((o) => o.body.trim() !== '')
          : undefined,
      }),
    onSuccess: () => {
      toast.ok('Question banked')
      setStem('')
      setExplanation('')
      setOptions(options.map(() => ({ body: '', is_correct: false })))
      qc.invalidateQueries({ queryKey: ['question-bank'] })
      qc.invalidateQueries({ queryKey: ['question-bank-summary'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  })

  const setOption = (i: number, patch: Partial<DraftOption>) =>
    setOptions((o) => o.map((v, n) => (n === i ? { ...v, ...patch } : v)))

  const filled = options.filter((o) => o.body.trim() !== '')
  const hasKey = filled.some((o) => o.is_correct)

  return (
    <Card>
      <CardHeader
        title="Add a question"
        description="Tag it now — a question nobody can find is a question nobody reuses."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Subject" required>
            <Select
              value={classSubjectID}
              onChange={setClassSubjectID}
              placeholder="Choose a subject"
              options={(subjects.data?.items ?? []).map((s) => ({
                value: s.class_subject_id,
                label: `${s.class_name} · ${s.subject}`,
              }))}
            />
          </Field>
          <Field label="Kind">
            <Select
              value={kind}
              onChange={setKind}
              options={QUESTION_KINDS.map((k) => ({ value: k.value, label: k.label }))}
            />
          </Field>
          <Field label="Difficulty">
            <Select
              value={difficulty}
              onChange={setDifficulty}
              options={DIFFICULTIES.map((d) => ({ value: d.value, label: d.label }))}
            />
          </Field>
          <Field label="Bloom's level">
            <Select
              value={bloom}
              onChange={setBloom}
              options={BLOOM_LEVELS.map((b) => ({ value: b.value, label: b.label }))}
            />
          </Field>
          <Field label="Marks">
            <Input value={marks} onChange={setMarks} placeholder="1" />
          </Field>
        </FormGrid>

        <Field label="Question" required>
          <Textarea value={stem} onChange={setStem} rows={2} placeholder="What is 7 × 8?" />
        </Field>

        {objective && (
          <div className="mt-4">
            <p className="mb-2 text-[13px] font-medium text-secondary-foreground">
              Options — tick every correct one
            </p>
            <div className="grid gap-2">
              {options.map((o, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Input
                    value={o.body}
                    onChange={(v) => setOption(i, { body: v })}
                    placeholder={`Option ${i + 1}`}
                  />
                  <Checkbox
                    checked={o.is_correct}
                    onChange={(v) => setOption(i, { is_correct: v })}
                    label="Correct"
                  />
                </div>
              ))}
            </div>
            {filled.length > 0 && !hasKey && (
              <p className="mt-2 text-[13px] text-destructive">
                Tick the correct option — a question with no answer key can never be marked.
              </p>
            )}
          </div>
        )}

        <Field label="Explanation" hint="Shown to the child after the test closes.">
          <Textarea value={explanation} onChange={setExplanation} rows={2} />
        </Field>

        <FormNotice error={save.error} />
        <div className="mt-3 flex gap-2">
          <Button
            onClick={() => save.mutate()}
            disabled={
              !classSubjectID || !stem.trim() || (objective && (filled.length < 2 || !hasKey))
            }
          >
            Bank the question
          </Button>
          <Button variant="secondary" onClick={onDone}>Close</Button>
        </div>
      </div>
    </Card>
  )
}
