import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { Button, Card, CardHeader, ErrorState, FormNotice, Input, SkeletonTable } from '@/components/ui'

/* EXAM PARTS (owner, 2026-10-13): "some schools give marks for project
   assessment, notebook completion and overall performance, shown on the
   report card; build it, but all should be editable".

   An exam may be marked in parts, Written 80, Project 10 and so on. Every
   paper of the exam is then out of the parts added together, and its mark is
   the sum of the part marks. Nothing here is permanent: a part can be
   renamed, resized, moved or removed after marks exist, and the totals follow.
   No parts at all is how most exams are marked, and stays the default. */

export interface ExamPart { id: string; name: string; max_marks: number; sequence: number }
type Draft = { id?: string; name: string; max: string }

const SUGGEST = ['Written', 'Project', 'Notebook', 'Overall performance']

export default function ExamParts({ examId, examName, onClose }: { examId: string; examName: string; onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['exam-parts', examId], queryFn: () => api.get<List<ExamPart>>(`/api/v1/exams/${examId}/parts`) })
  const [rows, setRows] = useState<Draft[]>([])
  const [note, setNote] = useState('')

  useEffect(() => {
    if (q.data) setRows(q.data.items.map((p) => ({ id: p.id, name: p.name, max: String(p.max_marks) })))
  }, [q.data])

  const set = (i: number, k: 'name' | 'max', v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  const move = (i: number, d: -1 | 1) => setRows((r) => {
    const j = i + d
    if (j < 0 || j >= r.length) return r
    const n = [...r]; [n[i], n[j]] = [n[j], n[i]]
    return n
  })
  const total = rows.reduce((a, r) => a + (Number(r.max) || 0), 0)
  const bad = rows.some((r) => !r.name.trim() || !(Number(r.max) > 0))
  const removing = (q.data?.items ?? []).filter((p) => !rows.some((r) => r.id === p.id))

  const save = useMutation({
    mutationFn: () => api.put<{ parts: ExamPart[] }>(`/api/v1/exams/${examId}/parts`, {
      parts: rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), max_marks: Number(r.max) })),
    }),
    onSuccess: () => {
      setNote(rows.length ? `Saved. Every paper of ${examName} is now out of ${total}, and marks already entered were added up again.` : 'Saved. This exam is marked as one figure per paper again.')
      qc.invalidateQueries({ queryKey: ['exam-parts', examId] })
      qc.invalidateQueries({ queryKey: ['exams-list'] })
      qc.invalidateQueries({ queryKey: ['exam-subjects'] })
      qc.invalidateQueries({ queryKey: ['gradebook'] })
    },
    onError: () => setNote(''),
  })

  if (q.isLoading) return <SkeletonTable columns={3} />
  if (q.error) return <ErrorState error={q.error} />

  return (
    <Card>
      <CardHeader
        title={`Parts · ${examName}`}
        description={rows.length ? `Out of ${total}. Each paper is marked part by part and its total is the parts added together.` : 'No parts: each paper gets one mark. Add parts if this exam also marks project work, notebooks and the like.'}
        action={<Button variant="ghost" onClick={onClose}>Close</Button>}
      />
      <div className="space-y-3 px-5 pb-5">
        {note && <FormNotice ok={note} />}
        {save.error && <FormNotice error={save.error} />}
        {rows.map((r, i) => (
          <div key={r.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2">
            <Input value={r.name} onChange={(v) => set(i, 'name', v)} placeholder={SUGGEST[i] ?? 'Part name'} srLabel={`Part ${i + 1} name`} className="w-56" />
            <Input type="number" min={1} value={r.max} onChange={(v) => set(i, 'max', v)} placeholder="Out of" srLabel={`Part ${i + 1} out of`} className="w-24" />
            <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" aria-hidden /></Button>
            <Button size="sm" variant="ghost" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" aria-hidden /></Button>
            <Button size="sm" variant="ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        {removing.length > 0 && (
          <p className="text-[13px] text-destructive">
            Saving removes {removing.map((p) => p.name).join(', ')} and the marks given for {removing.length === 1 ? 'it' : 'them'}; the totals are added up again without {removing.length === 1 ? 'it' : 'them'}.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setRows((x) => [...x, { name: '', max: '' }])}>Add part</Button>
          <Button disabled={save.isPending || bad} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          {rows.length > 0 && <span className="text-[13px] text-muted-foreground">Out of {total}</span>}
        </div>
      </div>
    </Card>
  )
}
