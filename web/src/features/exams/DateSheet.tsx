import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Card, CardHeader, ErrorState, FormNotice, Input, PrintButton, SkeletonTable, Table, Td } from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* THE DATE SHEET (owner, 2026-10-08): when each paper is written.

   One row per paper, grouped by class, with its date, start time and length.
   "Same for every paper" fills the start time and length in one go, because
   most schools write every paper at 09:30 for an hour and only the dates
   differ. Saving keeps it private; Publish tells every family in the exam's
   classes, and from then on the hall ticket, the family calendar and the
   parent's and student's exam screens show it. */

interface Row { id: string; class_name: string; subject: string; exam_date: string; start_time: string; duration_minutes: number | null; max_marks: number | null }
interface Sheet { exam: string; published_at: string | null; items: Row[] }
type Edit = { exam_date: string; start_time: string; duration: string }

const ends = (t: string, m: number | null) => {
  if (!t || !m) return ''
  const [h, mm] = t.split(':').map(Number)
  const x = h * 60 + mm + m
  return `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`
}

export default function DateSheet({ examId, onClose }: { examId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['date-sheet', examId], queryFn: () => api.get<Sheet>(`/api/v1/exams/${examId}/date-sheet`) })
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [allTime, setAllTime] = useState('09:30')
  const [allMins, setAllMins] = useState('60')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!q.data) return
    setEdits(Object.fromEntries(q.data.items.map((r) => [r.id, { exam_date: r.exam_date, start_time: r.start_time, duration: r.duration_minutes ? String(r.duration_minutes) : '' }])))
  }, [q.data])

  const rows = q.data?.items ?? []
  const byClass = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) m.set(r.class_name, [...(m.get(r.class_name) ?? []), r])
    return [...m.entries()]
  }, [rows])
  const set = (id: string, k: keyof Edit, v: string) => setEdits((e) => ({ ...e, [id]: { ...e[id], [k]: v } }))
  const changed = rows.some((r) => {
    const e = edits[r.id]
    return e && (e.exam_date !== r.exam_date || e.start_time !== r.start_time || e.duration !== (r.duration_minutes ? String(r.duration_minutes) : ''))
  })
  const undated = rows.filter((r) => !edits[r.id]?.exam_date).length

  const save = useMutation({
    mutationFn: () => api.put<{ saved: number }>(`/api/v1/exams/${examId}/date-sheet`, {
      items: rows.map((r) => ({ id: r.id, exam_date: edits[r.id]?.exam_date ?? '', start_time: edits[r.id]?.start_time ?? '', duration_minutes: Number(edits[r.id]?.duration) || null })),
    }),
    onSuccess: () => { setNote('Date sheet saved. Families see it once you publish.'); qc.invalidateQueries({ queryKey: ['date-sheet', examId] }) },
  })
  const publish = useMutation({
    mutationFn: async () => {
      if (changed) await save.mutateAsync()
      return api.post<{ told: number }>(`/api/v1/exams/${examId}/date-sheet/publish`, {})
    },
    onSuccess: (r) => { setNote(`Published. ${r.told} parent and student logins were told; the hall tickets now show every date and time.`); qc.invalidateQueries({ queryKey: ['date-sheet', examId] }) },
  })

  if (q.isLoading) return <SkeletonTable columns={5} />
  if (q.error) return <ErrorState error={q.error} />

  return (
    <Card>
      <div data-print-source="">
        <CardHeader
          title={`Date sheet · ${q.data?.exam ?? ''}`}
          description={q.data?.published_at ? `Published ${formatDate(q.data.published_at)}. Publish again after a change and families are told again.` : 'Not published yet. Families see nothing until you publish.'}
          action={<div className="flex flex-wrap gap-2">
            <PrintButton label="Print" scope="card" title={`Date sheet · ${q.data?.exam ?? ''}`} />
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>}
        />

        {/* Same time for every paper: the usual case, in one press. */}
        <div className="no-print flex flex-wrap items-end gap-3 border-b px-[var(--card-pad)] py-3 text-[13px]">
          <label className="flex flex-col gap-1">Every paper starts at<Input type="time" value={allTime} onChange={setAllTime} /></label>
          <label className="flex flex-col gap-1">and runs (minutes)<Input type="number" value={allMins} onChange={setAllMins} /></label>
          <Button variant="secondary" onClick={() => setEdits((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, { ...v, start_time: allTime, duration: allMins }])))}>
            Apply to all papers
          </Button>
          <span className="text-muted-foreground">Then set each paper's date below.</span>
        </div>

        {byClass.map(([cls, list]) => (
          <div key={cls}>
            <p className="border-b bg-muted/40 px-[var(--card-pad)] py-2 text-[13px] font-semibold">{cls}</p>
            <Table head={['Subject', 'Date', 'Starts', 'Minutes', 'Ends', 'Marks']}>
              {list.map((r) => {
                const e = edits[r.id] ?? { exam_date: '', start_time: '', duration: '' }
                return (
                  <tr key={r.id}>
                    <Td className="font-medium">{r.subject}</Td>
                    <Td><Input type="date" value={e.exam_date} onChange={(v) => set(r.id, 'exam_date', v)} /></Td>
                    <Td><Input type="time" value={e.start_time} onChange={(v) => set(r.id, 'start_time', v)} /></Td>
                    <Td><Input type="number" value={e.duration} onChange={(v) => set(r.id, 'duration', v)} /></Td>
                    <Td className="tabular-nums text-muted-foreground">{ends(e.start_time, Number(e.duration) || null) || '-'}</Td>
                    <Td className="tabular-nums">{r.max_marks ?? '-'}</Td>
                  </tr>
                )
              })}
            </Table>
          </div>
        ))}
      </div>

      <div className="no-print flex flex-wrap items-center gap-2 border-t px-[var(--card-pad)] py-3">
        <Button variant="secondary" disabled={!changed || save.isPending} onClick={() => { setNote(''); save.mutate() }}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button disabled={undated > 0 || publish.isPending} onClick={() => { setNote(''); publish.mutate() }}>
          {publish.isPending ? 'Publishing…' : q.data?.published_at ? 'Publish again' : 'Publish to families'}
        </Button>
        {undated > 0 && <span className="text-[13px] text-muted-foreground">{undated} paper{undated === 1 ? '' : 's'} still need a date before publishing.</span>}
      </div>
      <div className="px-[var(--card-pad)] pb-3">
        <FormNotice error={save.error ?? publish.error} ok={note} />
      </div>
    </Card>
  )
}
