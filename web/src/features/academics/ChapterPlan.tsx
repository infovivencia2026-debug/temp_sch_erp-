import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ChevronDown, Plus } from 'lucide-react'
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, FormNotice, Input, Select, SkeletonTable, Textarea } from '@/components/ui'

/* THE LESSON PLAN BY CHAPTER (owner, 2026-11-04). Every chapter of the
   subject's syllabus for one class-section, with the days it should take and
   a progress bar. A chapter opens to its sub-topics: pick one from the list,
   rename it or add a new one, set the from and to dates and move the status
   forward (never back). Each chapter takes a note. */

type Status = 'not_completed' | 'ongoing' | 'completed'
interface Sub { id: string; title: string; status: Status; from_date: string; to_date: string }
interface Chapter { id: string; title: string; days: number; status: Status; note: string; progress: number; subtopics: Sub[] }

const STATUS: { value: Status; label: string }[] = [
  { value: 'not_completed', label: 'Not completed' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'completed', label: 'Completed' },
]
const RANK: Record<Status, number> = { not_completed: 0, ongoing: 1, completed: 2 }
// Only the current status and the ones after it: the status never goes back.
const forward = (s: Status) => STATUS.filter((x) => RANK[x.value] >= RANK[s])
const tone = (s: Status) => (s === 'completed' ? 'success' : s === 'ongoing' ? 'warning' : 'neutral') as 'success' | 'warning' | 'neutral'
const label = (s: Status) => STATUS.find((x) => x.value === s)!.label
const daysTaken = (from: string, to: string) =>
  from && to && to >= from ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 : null

/* "1.NUMBER AND PLACE VALUE (10P)" reads "NUMBER AND PLACE VALUE (10 sessions)"
   (owner, 2026-11-10): the syllabus's own numbering is dropped, the card
   numbers the chapters itself. */
const cleanTitle = (t: string) =>
  t.replace(/^\s*\d+(\.\d+)*\s*[.)-]?\s*/, '').replace(/\(\s*(\d+)\s*p\s*\)/gi, '($1 sessions)')
const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
/* A chapter's dates are its sub-topics' span: the earliest from, the latest to. */
function span(subs: Sub[]): string {
  const f = subs.map((s) => s.from_date).filter(Boolean).sort()[0]
  const t = subs.map((s) => s.to_date).filter(Boolean).sort().pop()
  if (!f && !t) return ''
  return `${f ? fmt(f) : '…'} – ${t ? fmt(t) : '…'}`
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function ChapterPlan({ sectionId, classSubjectId }: { sectionId: string; classSubjectId: string }) {
  const key = ['chapter-plan', sectionId, classSubjectId]
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ items: Chapter[] }>(`/api/v1/academics/chapter-plan?section_id=${sectionId}&class_subject_id=${classSubjectId}`),
  })
  const [openId, setOpenId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (q.isError) return <ErrorState error={q.error} />
  if (q.isPending) return <SkeletonTable />
  const items = q.data.items
  if (!items.length) return <EmptyState title="No chapters yet" body="This subject has no chapters in its syllabus. Add them in Academics, Syllabus." />
  const open = items.find((c) => c.id === openId) ?? null
  const done = items.filter((c) => c.status === 'completed').length

  return (
    <>
      <p className="text-[14px] text-muted-foreground">{done} of {items.length} chapters completed</p>
      <div className="grid gap-3">
        {items.map((c, i) => {
          const expanded = expandedId === c.id
          const dates = span(c.subtopics)
          return (
            <Card key={c.id} className="p-4">
              <button type="button" className="block w-full text-left" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : c.id)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{i + 1}. {cleanTitle(c.title)}</p>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      {c.days} {c.days === 1 ? 'day' : 'days'} to complete
                      {c.subtopics.length > 0 && ` · ${c.subtopics.length} sub-topics`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {dates && <span className="text-[13px] tabular-nums text-muted-foreground">{dates}</span>}
                    <Badge tone={tone(c.status)}>{label(c.status)}</Badge>
                    <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <Bar pct={c.progress} />
                  <span className="w-12 shrink-0 whitespace-nowrap text-right text-[13px] tabular-nums text-muted-foreground">{c.progress}%</span>
                </div>
              </button>
              {expanded && <SubtopicList chapter={c} sectionId={sectionId} queryKey={key} onChapter={() => setOpenId(c.id)} />}
            </Card>
          )
        })}
      </div>
      {open && <ChapterDialog chapter={open} sectionId={sectionId} onClose={() => setOpenId(null)} queryKey={key} />}
    </>
  )
}

function ChapterDialog({ chapter, sectionId, onClose, queryKey }: { chapter: Chapter; sectionId: string; onClose: () => void; queryKey: unknown[] }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey })
  const [subId, setSubId] = useState(chapter.subtopics[0]?.id ?? '')
  const sub = chapter.subtopics.find((s) => s.id === subId) ?? null
  const [title, setTitle] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [status, setStatus] = useState<Status>('not_completed')
  const [adding, setAdding] = useState('')
  const [note, setNote] = useState(chapter.note)
  const [chStatus, setChStatus] = useState<Status>(chapter.status)
  const [saved, setSaved] = useState('')

  useEffect(() => {
    setTitle(sub?.title ?? ''); setFrom(sub?.from_date ?? ''); setTo(sub?.to_date ?? ''); setStatus(sub?.status ?? 'not_completed')
  }, [sub?.id, sub?.title, sub?.from_date, sub?.to_date, sub?.status])

  const saveSub = useMutation({
    mutationFn: async () => {
      if (!sub) return
      if (title.trim() && title.trim() !== sub.title) {
        await api.patch(`/api/v1/academics/chapter-plan/subtopics/${sub.id}`, { title: title.trim(), section_id: sectionId })
      }
      await api.put('/api/v1/academics/chapter-plan/progress', { section_id: sectionId, unit_id: sub.id, status, from_date: from, to_date: to })
    },
    onSuccess: () => { setSaved('Sub-topic saved.'); refresh() },
  })
  const add = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/v1/academics/chapter-plan/subtopics', { chapter_id: chapter.id, section_id: sectionId, title: adding.trim() }),
    onSuccess: (r) => { setAdding(''); setSubId(r.id); setSaved('Sub-topic added.'); refresh() },
  })
  const saveChapter = useMutation({
    mutationFn: () => api.put('/api/v1/academics/chapter-plan/progress', { section_id: sectionId, unit_id: chapter.id, status: chStatus, note }),
    onSuccess: () => { setSaved('Chapter saved.'); refresh() },
  })
  const taken = daysTaken(from, to)

  return (
    <Dialog open onClose={onClose} title={cleanTitle(chapter.title)} description={`${chapter.days} days to complete · ${chapter.progress}% done`} size="lg">
      <div className="space-y-5">
        <section className="space-y-3">
          <p className="eyebrow">Sub-topics</p>
          {chapter.subtopics.length > 0 ? (
            <>
              <Field label="Sub-topic">
                <Select value={subId} onChange={(v) => { setSubId(v); setSaved('') }}
                  options={chapter.subtopics.map((s, i) => ({ value: s.id, label: `${i + 1}. ${s.title} · ${label(s.status)}` }))} />
              </Field>
              {sub && (
                <div className="space-y-3 rounded-lg border p-3">
                  <Field label="Name"><Input value={title} onChange={setTitle} /></Field>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="From"><Input type="date" value={from} onChange={setFrom} /></Field>
                    <Field label="To"><Input type="date" value={to} onChange={setTo} min={from || undefined} /></Field>
                    <Field label="Status">
                      <Select value={status} onChange={(v) => setStatus(v as Status)} options={forward(sub.status)} />
                    </Field>
                  </div>
                  {taken !== null && <p className="text-[13px] text-muted-foreground">Took {taken} {taken === 1 ? 'day' : 'days'}.</p>}
                  <Button onClick={() => saveSub.mutate()} pending={saveSub.isPending} disabled={!!from && !!to && to < from}>Save sub-topic</Button>
                  <FormNotice error={saveSub.error} />
                </div>
              )}
            </>
          ) : <p className="text-[14px] text-muted-foreground">No sub-topics yet. Add the first one below.</p>}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1"><Field label="Add a sub-topic"><Input value={adding} onChange={setAdding} placeholder="Name of the sub-topic" /></Field></div>
            <Button variant="secondary" onClick={() => add.mutate()} pending={add.isPending} disabled={!adding.trim()}>Add</Button>
          </div>
          <FormNotice error={add.error} />
        </section>

        <section className="space-y-3 border-t pt-4">
          <p className="eyebrow">Chapter</p>
          <Field label="Chapter status">
            <Select value={chStatus} onChange={(v) => setChStatus(v as Status)} options={forward(chapter.status)} />
          </Field>
          <Field label="Note"><Textarea value={note} onChange={setNote} placeholder="Anything to remember about this chapter" /></Field>
          <Button variant="secondary" onClick={() => saveChapter.mutate()} pending={saveChapter.isPending}>Save chapter</Button>
          <FormNotice error={saveChapter.error} ok={saved || undefined} />
        </section>
      </div>
    </Dialog>
  )
}

/* THE CHAPTER OPENED IN PLACE (owner, 2026-11-10): every sub-topic with its
   from and to dates and status, each saved as it changes. Adding one stays
   hidden until "Add sub-topic" is pressed. */
function SubtopicList({ chapter, sectionId, queryKey, onChapter }: { chapter: Chapter; sectionId: string; queryKey: unknown[]; onChapter: () => void }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey })
  const [adding, setAdding] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (v: { sub: Sub; from_date?: string; to_date?: string; status?: Status }) =>
      api.put('/api/v1/academics/chapter-plan/progress', {
        section_id: sectionId, unit_id: v.sub.id,
        status: v.status ?? v.sub.status, from_date: v.from_date ?? v.sub.from_date, to_date: v.to_date ?? v.sub.to_date,
      }),
    onSuccess: refresh,
  })
  const add = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/v1/academics/chapter-plan/subtopics', { chapter_id: chapter.id, section_id: sectionId, title: (adding ?? '').trim() }),
    onSuccess: () => { setAdding(null); refresh() },
  })
  return (
    <div className="mt-4 space-y-2 border-t pt-4">
      {chapter.subtopics.length === 0 && <p className="text-[14px] text-muted-foreground">No sub-topics yet.</p>}
      {chapter.subtopics.map((s, i) => (
        <div key={s.id} className="grid items-end gap-2 rounded-xl border p-3 sm:grid-cols-[minmax(0,1fr)_150px_150px_160px]">
          <p className="self-center text-[14px] font-medium">{i + 1}. {cleanTitle(s.title)}</p>
          <Field label="From"><Input type="date" value={s.from_date} onChange={(v) => save.mutate({ sub: s, from_date: v })} /></Field>
          <Field label="To"><Input type="date" value={s.to_date} min={s.from_date || undefined} onChange={(v) => save.mutate({ sub: s, to_date: v })} /></Field>
          <Field label="Status">
            <Select value={s.status} onChange={(v) => save.mutate({ sub: s, status: v as Status })} options={forward(s.status)} />
          </Field>
        </div>
      ))}
      <FormNotice error={save.error} />
      {adding === null ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="secondary" onClick={() => setAdding('')}><Plus className="h-4 w-4" /> Add sub-topic</Button>
          <Button variant="ghost" onClick={onChapter}>Chapter status and note</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <div className="min-w-0 flex-1"><Field label="New sub-topic"><Input value={adding} onChange={setAdding} placeholder="Name of the sub-topic" autoFocus /></Field></div>
          <Button onClick={() => add.mutate()} pending={add.isPending} disabled={!adding.trim()}>Add</Button>
          <Button variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
        </div>
      )}
      <FormNotice error={add.error} />
    </div>
  )
}
