import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Plus, Shuffle, Trash2 } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { Badge, Button, Dialog, EmptyState, Field, FormNotice, Input, Select, Table, Td } from '@/components/ui'
import { DIFFICULTIES, QUESTION_KINDS, label, useTeachingSubjects, type BankQuestion } from '@/features/faculty/teaching'
import type { Box } from '../lib/box'
import { bankItemBox, sectionBox, type BankItem } from '../lib/bankbox'
import { collectImageIds, lookupImages, type ImageAsset } from '../lib/images'

/* A paper drawn from the bank by blueprint.

   Not a generator: nothing is written. Each row says how many questions of
   what shape, and the bank supplies them at random. A row the bank cannot
   fill comes back short and says by how many: that is the number of
   questions still to write. Draw again until it reads well, then add it to
   the paper, one section per row, and edit it like anything else there. */

interface Row { difficulty: string; kind: string; syllabus_unit_id: string; marks: string; count: string }
interface Drawn {
  sections: { row: { difficulty: string; kind: string; marks: number; count: number }; wanted: number; found: number; questions: (BankItem & { marks: number })[] }[]
  total_marks: number
  questions: number
  short: number
}

const blankRow: Row = { difficulty: '', kind: '', syllabus_unit_id: '', marks: '', count: '5' }

export default function FillFromBank({ subjectHint, onAdd, onClose }: {
  subjectHint?: string
  onAdd: (boxes: Box[], images: Record<string, ImageAsset>) => void
  onClose: () => void
}) {
  const subjects = useTeachingSubjects()
  const [subject, setSubject] = useState(subjectHint ?? '')
  const [rows, setRows] = useState<Row[]>([{ ...blankRow }])
  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)))

  // Chapters come from the bank itself: the units that have questions.
  const bank = useQuery({
    queryKey: ['question-bank', `class_subject_id=${subject}`],
    queryFn: () => api.get<List<BankQuestion>>(`/api/v1/teaching/question-bank?class_subject_id=${subject}`),
    enabled: !!subject,
  })
  const chapters = useMemo(() => {
    const m = new Map<string, string>()
    for (const q of bank.data?.items ?? []) if (q.syllabus_unit_id && q.chapter) m.set(q.syllabus_unit_id, q.chapter)
    return [...m.entries()].map(([value, l]) => ({ value, label: l }))
  }, [bank.data])

  const draw = useMutation({
    mutationFn: () => api.post<Drawn>('/api/v1/teaching/question-bank/compose', {
      class_subject_id: subject,
      rows: rows.map((r) => ({ difficulty: r.difficulty, kind: r.kind, syllabus_unit_id: r.syllabus_unit_id, marks: Number(r.marks) || 0, count: Number(r.count) || 0 })),
    }),
  })
  const add = useMutation({
    mutationFn: async (d: Drawn) => {
      const boxes = d.sections.filter((s) => s.questions.length).map((s, i) => sectionBox(`Section ${String.fromCharCode(65 + i)}`, s.questions.map((q) => bankItemBox(q))))
      return { boxes, images: await lookupImages(collectImageIds(boxes)) }
    },
    onSuccess: ({ boxes, images }) => onAdd(boxes, images),
  })

  const ready = !!subject && rows.every((r) => Number(r.count) >= 1 && Number(r.count) <= 50)
  const d = draw.data

  return (
    <Dialog
      title="Fill from the bank"
      description="Say how many questions of each kind; the bank supplies them at random. Each row becomes a section of the paper."
      size="xl"
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" disabled={!ready || draw.isPending} pending={draw.isPending} onClick={() => draw.mutate()}>
          <Shuffle className="size-4" /> {d ? 'Draw again' : 'Draw'}
        </Button>
        <Button disabled={!d || d.questions === 0 || add.isPending} pending={add.isPending} onClick={() => d && add.mutate(d)}>Add to the paper</Button>
      </>}
    >
      <div className="space-y-4">
        <div className="max-w-sm">
          <Field label="Subject" required>
            <Select value={subject} onChange={setSubject} placeholder="Choose"
              options={(subjects.data?.items ?? []).map((s) => ({ value: s.class_subject_id, label: `${s.class_name} · ${s.subject}` }))} />
          </Field>
        </div>
        <Table head={['Difficulty', 'Kind', 'Chapter', 'Marks each', 'How many', '']}>
          {rows.map((r, i) => (
            <tr key={i}>
              <Td label="Difficulty"><Select value={r.difficulty} onChange={(v) => setRow(i, { difficulty: v })} options={[{ value: '', label: 'Any' }, ...DIFFICULTIES]} /></Td>
              <Td label="Kind"><Select value={r.kind} onChange={(v) => setRow(i, { kind: v })} options={[{ value: '', label: 'Any' }, ...QUESTION_KINDS]} /></Td>
              <Td label="Chapter"><Select value={r.syllabus_unit_id} onChange={(v) => setRow(i, { syllabus_unit_id: v })} options={[{ value: '', label: 'Any' }, ...chapters]} /></Td>
              <Td label="Marks each"><Input type="number" value={r.marks} onChange={(v) => setRow(i, { marks: v })} placeholder="Any" srLabel="Marks each" /></Td>
              <Td label="How many"><Input type="number" min={1} max={50} value={r.count} onChange={(v) => setRow(i, { count: v })} srLabel="How many" /></Td>
              <Td>
                <Button size="sm" variant="ghost" title="Remove this row" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, k) => k !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
        <Button size="sm" variant="secondary" disabled={rows.length >= 20} onClick={() => setRows([...rows, { ...blankRow }])}><Plus className="size-4" /> Add a row</Button>
        <FormNotice error={draw.error ?? add.error} />
        {d && (d.questions === 0 ? (
          <EmptyState title="The bank has nothing that matches." body="Loosen a row, or bank more questions for this subject first." />
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
              <span className="font-medium">{d.questions} questions · {d.total_marks} marks</span>
              {d.short > 0 ? <Badge tone="warning">{d.short} short</Badge> : <Badge tone="success">Every row filled</Badge>}
            </div>
            <ol className="space-y-1 text-[13px] text-muted-foreground">
              {d.sections.map((s, i) => (
                <li key={i}>
                  Section {String.fromCharCode(65 + i)}: {s.found} of {s.wanted}
                  {' · '}{s.row.difficulty ? label(DIFFICULTIES, s.row.difficulty) : 'any difficulty'}
                  {' · '}{s.row.kind ? label(QUESTION_KINDS, s.row.kind) : 'any kind'}
                  {s.found < s.wanted && <span className="text-warning"> · {s.wanted - s.found} still to write</span>}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </Dialog>
  )
}
