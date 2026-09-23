import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Library, Plus, Sparkles } from 'lucide-react'
import { api, actingInstitution, type List } from '@/lib/api'
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
  const [generating, setGenerating] = useState(false)
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

  const rows = list.data?.items ?? []
  /* A bank exists to be reused, and one that cannot be searched is one where
     the same question is typed again next term. Over the stem, the chapter and
     the subject — the three things somebody half-remembers about a question
     they know they have written before. Declared above the early returns so
     the hook count is the same on every render. */
  const { q: term, setQ: setTerm, shown } = useSearch(rows,
    (x) => [x.stem, x.chapter, x.subject, x.class_name, x.kind, x.difficulty])

  if (list.isLoading) return <SkeletonTable columns={9} />
  if (list.error) return <ErrorState error={list.error} />
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
          <>
            <Button variant="secondary" onClick={() => setGenerating((g) => !g)}>
              <Sparkles className="h-3.5 w-3.5" />
              {generating ? 'Close' : 'Generate from a lesson (PDF)'}
            </Button>
            <Button onClick={() => setComposing((c) => !c)}>
              <Plus className="h-3.5 w-3.5" />
              {composing ? 'Close' : 'Add a question'}
            </Button>
          </>
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

        {generating && <GenerateFromLesson onDone={() => setGenerating(false)} />}

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
                <SearchBox value={search} onChange={setSearch} placeholder="Search the stem" />
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
                  <Td>{q.chapter ?? '-'}</Td>
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
        description="Tag it now, a question nobody can find is a question nobody reuses."
      />
      <div className="px-5 pb-5 pt-4">
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
              Options, tick every correct one
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
                Tick the correct option, a question with no answer key can never be marked.
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

/* Generate questions from an uploaded lesson PDF.

   The teacher picks the subject, attaches a lesson or exercise PDF and a count,
   and the server sends it to the model and returns a PREVIEW — nothing is saved
   yet. Extraction from a PDF is imperfect, so every question comes back editable
   and ticked, and only what the teacher confirms is written to the bank. */

interface GenQuestion {
  text: string
  kind: string
  difficulty: string
  marks: number
  options: string[]
  answer: string
}
interface GenResult { questions: GenQuestion[]; class_subject_id: string }

interface EditRow {
  selected: boolean
  text: string
  kind: string
  difficulty: string
  marks: string
  options: string[]
  answer: string
}

/* Multipart cannot go through the JSON api helper (it forces a JSON
   Content-Type), so this one call is a plain fetch. FormData sets its own
   multipart boundary; we must not set Content-Type ourselves. */
async function generateFromPDF(form: FormData): Promise<GenResult> {
  const acting = actingInstitution()
  const res = await fetch('/api/v1/teaching/question-bank/generate', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(acting ? { 'X-Acting-Institution': acting } : {}) },
    body: form,
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error('The server answered in a form this screen could not read.')
  }
  if (!res.ok) throw new Error(body?.error?.message ?? 'Could not generate questions')
  return body as GenResult
}

function GenerateFromLesson({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const subjects = useTeachingSubjects()

  const [classSubjectID, setClassSubjectID] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [count, setCount] = useState('10')
  const [difficulty, setDifficulty] = useState('')
  const [rows, setRows] = useState<EditRow[]>([])

  const generate = useMutation({
    mutationFn: () => {
      const form = new FormData()
      form.append('class_subject_id', classSubjectID)
      if (file) form.append('file', file)
      form.append('count', String(Number(count) || 10))
      if (difficulty) form.append('difficulty', difficulty)
      return generateFromPDF(form)
    },
    onSuccess: (data) => {
      setRows(
        data.questions.map((q) => ({
          selected: true,
          text: q.text,
          kind: q.kind,
          difficulty: q.difficulty,
          marks: String(q.marks ?? 1),
          options: q.options ?? [],
          answer: q.answer ?? '',
        })),
      )
      if (data.questions.length === 0) {
        toast.error('The lesson produced no usable questions. Try a clearer PDF.')
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not generate'),
  })

  const save = useMutation({
    mutationFn: () =>
      api.post<{ saved: number }>('/api/v1/teaching/question-bank/generate/save', {
        class_subject_id: classSubjectID,
        questions: rows
          .filter((r) => r.selected && r.text.trim() !== '')
          .map((r) => ({
            text: r.text.trim(),
            kind: r.kind,
            difficulty: r.difficulty,
            marks: Number(r.marks) || 1,
            options: r.options,
            answer: r.answer,
          })),
      }),
    onSuccess: (res) => {
      toast.ok(`${res.saved} question${res.saved === 1 ? '' : 's'} added to the bank`)
      qc.invalidateQueries({ queryKey: ['question-bank'] })
      qc.invalidateQueries({ queryKey: ['question-bank-summary'] })
      onDone()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  })

  const setRow = (i: number, patch: Partial<EditRow>) =>
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))

  const selectedCount = rows.filter((r) => r.selected && r.text.trim() !== '').length

  return (
    <Card>
      <CardHeader
        title="Generate from a lesson (PDF)"
        description="Upload a lesson or exercise PDF and the assistant drafts questions you can review."
      />
      <div className="px-5 pb-5 pt-4">
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
          <Field label="How many" hint="Up to 50.">
            <Input value={count} onChange={setCount} placeholder="10" />
          </Field>
          <Field label="Difficulty">
            <Select
              value={difficulty}
              onChange={setDifficulty}
              placeholder="Any"
              options={DIFFICULTIES.map((d) => ({ value: d.value, label: d.label }))}
            />
          </Field>
          <Field label="Lesson PDF" required>
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
              className="block w-full text-[13px] text-secondary-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-[13px] file:text-secondary-foreground"
            />
          </Field>
        </FormGrid>

        <div className="mt-3 flex gap-2">
          <Button
            onClick={() => generate.mutate()}
            pending={generate.isPending}
            disabled={!classSubjectID || !file || generate.isPending}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {generate.isPending ? 'Reading the lesson…' : 'Generate questions'}
          </Button>
          <Button variant="secondary" onClick={onDone}>Close</Button>
        </div>

        {rows.length > 0 && (
          <div className="mt-5">
            <div className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] text-secondary-foreground">
              AI-generated, review each question before saving. Extraction can be
              imperfect: fix the marks, correct the wording, or untick a bad one.
            </div>
            <div className="grid gap-3">
              {rows.map((r, i) => (
                <div key={i} className="rounded-lg border border-border p-3">
                  <div className="flex items-start gap-3">
                    <div className="pt-1">
                      <Checkbox
                        checked={r.selected}
                        onChange={(v) => setRow(i, { selected: v })}
                        label=""
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Textarea
                        value={r.text}
                        onChange={(v) => setRow(i, { text: v })}
                        rows={2}
                      />
                      {r.options.length > 0 && (
                        <p className="mt-1 text-[12px] text-muted-foreground">
                          {r.options.join(' · ')}
                        </p>
                      )}
                      {r.answer && (
                        <p className="mt-1 text-[12px] text-muted-foreground">
                          Answer: {r.answer}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Select
                          value={r.kind}
                          onChange={(v) => setRow(i, { kind: v })}
                          options={QUESTION_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                        />
                        <Select
                          value={r.difficulty}
                          onChange={(v) => setRow(i, { difficulty: v })}
                          options={DIFFICULTIES.map((d) => ({ value: d.value, label: d.label }))}
                        />
                        <div className="w-24">
                          <Input
                            value={r.marks}
                            onChange={(v) => setRow(i, { marks: v })}
                            placeholder="Marks"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <FormNotice error={save.error} />
            <div className="mt-3 flex gap-2">
              <Button
                onClick={() => save.mutate()}
                pending={save.isPending}
                disabled={selectedCount === 0 || save.isPending}
              >
                Add selected to bank{selectedCount > 0 ? ` (${selectedCount})` : ''}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
