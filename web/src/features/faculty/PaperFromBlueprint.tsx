import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Plus, Shuffle, Trash2 } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, Select, Input, Field,
  FormNotice, PrintButton, SkeletonForm, ErrorState, EmptyState,
} from '@/components/ui'
import {
  DIFFICULTIES, QUESTION_KINDS, useTeachingSubjects, label, type BankQuestion,
} from './teaching'

/* A paper drawn from the bank by blueprint.

   Not a generator: nothing is written. Each row of the blueprint says how many
   questions of what shape, and the bank supplies them at random. A row the
   bank cannot fill comes back short and says by how many — that is the number
   of questions still to write. Redraw until the paper reads well, then print,
   or build the online test from the same bank. */

interface Row {
  difficulty: string
  kind: string
  syllabus_unit_id: string
  marks: string
  count: string
}

interface Composed {
  id: string
  stem: string
  kind: string
  difficulty: string
  bloom_level: string
  chapter: string | null
  marks: number
  options: string[]
}

interface Section {
  row: { difficulty: string; kind: string; syllabus_unit_id: string; marks: number; count: number }
  wanted: number
  found: number
  questions: Composed[]
}

interface Paper {
  sections: Section[]
  total_marks: number
  questions: number
  short: number
}

const blankRow: Row = { difficulty: '', kind: '', syllabus_unit_id: '', marks: '', count: '5' }

export default function PaperFromBlueprint() {
  const subjects = useTeachingSubjects()
  const [subject, setSubject] = useState('')
  const [rows, setRows] = useState<Row[]>([{ ...blankRow }])

  // Chapters come from the bank itself: the units that have questions.
  const bank = useQuery({
    queryKey: ['question-bank', `class_subject_id=${subject}`],
    queryFn: () => api.get<List<BankQuestion>>(`/api/v1/teaching/question-bank?class_subject_id=${subject}`),
    enabled: !!subject,
  })
  const chapters = useMemo(() => {
    const m = new Map<string, string>()
    for (const q of bank.data?.items ?? []) {
      if (q.syllabus_unit_id && q.chapter) m.set(q.syllabus_unit_id, q.chapter)
    }
    return [...m.entries()].map(([value, l]) => ({ value, label: l }))
  }, [bank.data])

  const draw = useMutation({
    mutationFn: () =>
      api.post<Paper>('/api/v1/teaching/question-bank/compose', {
        class_subject_id: subject,
        rows: rows.map((r) => ({
          difficulty: r.difficulty,
          kind: r.kind,
          syllabus_unit_id: r.syllabus_unit_id,
          marks: Number(r.marks) || 0,
          count: Number(r.count) || 0,
        })),
      }),
  })

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)))

  const subjectOptions = (subjects.data?.items ?? []).map((s) => ({
    value: s.class_subject_id,
    label: `${s.class_name} · ${s.subject}`,
  }))
  const ready = !!subject && rows.every((r) => Number(r.count) >= 1)
  const paper = draw.data

  return (
    <>
      <PageHead
        eyebrow="Assessments"
        title="Paper from blueprint"
        actions={paper ? <PrintButton label="Print the paper" /> : undefined}
      />
      <PageBody>
        <Card className="print:hidden">
          <CardHeader
            title="Blueprint"
            action={
              <Button size="sm" variant="secondary" onClick={() => setRows([...rows, { ...blankRow }])}>
                <Plus className="h-3.5 w-3.5" /> Add a row
              </Button>
            }
          />
          {subjects.isLoading ? (
            <SkeletonForm fields={2} />
          ) : subjects.error ? (
            <ErrorState error={subjects.error} />
          ) : subjectOptions.length === 0 ? (
            <EmptyState title="No subjects assigned" body="A paper is drawn for a class you teach." />
          ) : (
            <div className="space-y-4 px-5 py-4">
              <div className="max-w-sm">
                <Field label="Subject" required>
                  <Select value={subject} onChange={setSubject} options={subjectOptions} placeholder="Choose" />
                </Field>
              </div>
              <Table head={['Difficulty', 'Kind', 'Chapter', 'Marks each', 'How many', '']}>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <Td label="Difficulty">
                      <Select value={r.difficulty} onChange={(v) => setRow(i, { difficulty: v })}
                        options={[{ value: '', label: 'Any' }, ...DIFFICULTIES]} />
                    </Td>
                    <Td label="Kind">
                      <Select value={r.kind} onChange={(v) => setRow(i, { kind: v })}
                        options={[{ value: '', label: 'Any' }, ...QUESTION_KINDS]} />
                    </Td>
                    <Td label="Chapter">
                      <Select value={r.syllabus_unit_id} onChange={(v) => setRow(i, { syllabus_unit_id: v })}
                        options={[{ value: '', label: 'Any' }, ...chapters]} />
                    </Td>
                    <Td label="Marks each">
                      <Input type="number" value={r.marks} onChange={(v) => setRow(i, { marks: v })} placeholder="Any" />
                    </Td>
                    <Td label="How many">
                      <Input type="number" value={r.count} onChange={(v) => setRow(i, { count: v })} />
                    </Td>
                    <Td>
                      <Button size="sm" variant="ghost" title="Remove row" disabled={rows.length === 1}
                        onClick={() => setRows(rows.filter((_, k) => k !== i))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </Td>
                  </tr>
                ))}
              </Table>
              <FormNotice error={draw.error} />
              <Button disabled={!ready || draw.isPending} onClick={() => draw.mutate()}>
                <Shuffle className="h-3.5 w-3.5" /> {paper ? 'Redraw' : 'Draw the paper'}
              </Button>
            </div>
          )}
        </Card>

        {paper && (
          <Card>
            <CardHeader
              title={`${paper.questions} questions · ${paper.total_marks} marks`}
              action={paper.short > 0 ? <Badge tone="warning">{paper.short} short</Badge> : <Badge tone="success">Filled</Badge>}
            />
            {paper.questions === 0 ? (
              <EmptyState title="The bank has nothing matching" body="Loosen a row, or add questions to the bank first." />
            ) : (
              <ol className="space-y-5 px-5 py-4">
                {paper.sections.map((s, si) => (
                  <li key={si}>
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                      <span>Section {String.fromCharCode(65 + si)}</span>
                      <span>· {s.row.difficulty ? label(DIFFICULTIES, s.row.difficulty) : 'Any difficulty'}</span>
                      <span>· {s.row.kind ? label(QUESTION_KINDS, s.row.kind) : 'Any kind'}</span>
                      {s.found < s.wanted && (
                        <span className="text-warning">· {s.wanted - s.found} still to write</span>
                      )}
                    </div>
                    <ol className="space-y-3">
                      {s.questions.map((q, qi) => (
                        <li key={q.id} className="flex gap-3">
                          <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{qi + 1}.</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-[14px]">{q.stem}</p>
                            {q.options.length > 0 && (
                              <ol className="mt-1 grid gap-x-6 gap-y-0.5 text-[13px] sm:grid-cols-2">
                                {q.options.map((o, oi) => (
                                  <li key={oi}>({String.fromCharCode(97 + oi)}) {o}</li>
                                ))}
                              </ol>
                            )}
                            <p className="mt-1 text-[12px] text-muted-foreground print:hidden">
                              {label(DIFFICULTIES, q.difficulty)}{q.chapter ? ` · ${q.chapter}` : ''} · {q.bloom_level}
                            </p>
                          </div>
                          <span className="shrink-0 tabular-nums text-[13px] text-muted-foreground">[{q.marks}]</span>
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        )}
      </PageBody>
    </>
  )
}
