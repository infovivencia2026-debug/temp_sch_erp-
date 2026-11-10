import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ChevronDown, Plus } from 'lucide-react'
import { Badge, Button, Card, EmptyState, ErrorState, Field, FormNotice, Input, Select, SkeletonTable } from '@/components/ui'

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

/* "1.NUMBER AND PLACE VALUE (10P)" reads "NUMBER AND PLACE VALUE (10 sessions)"
   (owner, 2026-11-10): the syllabus's own numbering is dropped, the card
   numbers the chapters itself. */
const cleanTitle = (t: string) =>
  t.replace(/^\s*\d+(\.\d+)*\s*[.)-]?\s*/, '')
    .replace(/\(\s*(\d+)\s*p(eriods?|\.)?\s*\)/gi, '($1 periods)')
    .replace(/\b(\d+)\s*p\b\.?/gi, '$1 periods')
/* What a row under a chapter is (owner, 2026-11-10): a sub-topic, an
   activity, questions, a revision, or a kind the teacher names. Kept as a
   "Kind: " prefix on the title, so no new column is needed; a plain title
   is a sub-topic. */
const KINDS = ['Sub-topic', 'Activity', 'Questions', 'Revision'] as const
function splitKind(t: string): { kind: string; name: string } {
  const m = /^\[([^\]]{1,40})\]\s*(.*)$/.exec(t)
  return m ? { kind: m[1], name: m[2] } : { kind: 'Sub-topic', name: t }
}
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
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (q.isError) return <ErrorState error={q.error} />
  if (q.isPending) return <SkeletonTable />
  const items = q.data.items
  if (!items.length) return <EmptyState title="No chapters yet" body="This subject has no chapters in its syllabus. Add them in Academics, Syllabus." />
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
                    {dates && <span className="rounded-full bg-muted px-2.5 py-0.5 text-center text-[12.5px] font-semibold tabular-nums text-foreground">{dates}</span>}
                    <Badge tone={tone(c.status)}>{label(c.status)}</Badge>
                    <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <Bar pct={c.progress} />
                  <span className="w-12 shrink-0 whitespace-nowrap text-right text-[13px] tabular-nums text-muted-foreground">{c.progress}%</span>
                </div>
              </button>
              {expanded && <SubtopicList chapter={c} sectionId={sectionId} queryKey={key} />}
            </Card>
          )
        })}
      </div>
    </>
  )
}

/* THE CHAPTER OPENED IN PLACE (owner, 2026-11-10): every sub-topic with its
   from and to dates and status, each saved as it changes. Adding one stays
   hidden until "Add sub-topic" is pressed. */
function SubtopicList({ chapter, sectionId, queryKey }: { chapter: Chapter; sectionId: string; queryKey: unknown[] }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey })
  const [adding, setAdding] = useState<string | null>(null)
  const [kind, setKind] = useState('Sub-topic')
  const [other, setOther] = useState(false)
  const [nFrom, setNFrom] = useState('')
  const [nTo, setNTo] = useState('')
  const [nStatus, setNStatus] = useState<Status>('not_completed')
  const save = useMutation({
    mutationFn: (v: { sub: Sub; from_date?: string; to_date?: string; status?: Status }) =>
      api.put('/api/v1/academics/chapter-plan/progress', {
        section_id: sectionId, unit_id: v.sub.id,
        status: v.status ?? v.sub.status, from_date: v.from_date ?? v.sub.from_date, to_date: v.to_date ?? v.sub.to_date,
      }),
    onSuccess: refresh,
  })
  const add = useMutation({
    /* Added with its dates and status in one go (owner, 2026-11-10). */
    mutationFn: async () => {
      const r = await api.post<{ id: string }>('/api/v1/academics/chapter-plan/subtopics', { chapter_id: chapter.id, section_id: sectionId, title: kind === 'Sub-topic' ? (adding ?? '').trim() : `[${kind.trim()}] ${(adding ?? '').trim()}` })
      if (nFrom || nTo || nStatus !== 'not_completed') {
        await api.put('/api/v1/academics/chapter-plan/progress', { section_id: sectionId, unit_id: r.id, status: nStatus, from_date: nFrom, to_date: nTo })
      }
    },
    onSuccess: () => { setAdding(null); setNFrom(''); setNTo(''); setNStatus('not_completed'); refresh() },
  })
  return (
    <div className="mt-4 space-y-2 border-t pt-4">
      {chapter.subtopics.length === 0 && <p className="text-[14px] text-muted-foreground">No sub-topics yet.</p>}
      {chapter.subtopics.map((s, i) => (
        <div key={s.id} className="grid items-end gap-2 rounded-xl border p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_190px_190px_180px]">
          <p className="flex items-center gap-2 self-center text-[14px] font-medium">
            <span>{i + 1}. {cleanTitle(splitKind(s.title).name)}</span>
            {splitKind(s.title).kind !== 'Sub-topic' && <Badge tone="info">{splitKind(s.title).kind}</Badge>}
          </p>
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
          {KINDS.map((k) => (
            <Button key={k} variant="secondary" onClick={() => { setKind(k); setOther(false); setAdding('') }}><Plus className="h-4 w-4" /> Add {k.toLowerCase()}</Button>
          ))}
          <Button variant="secondary" onClick={() => { setKind(''); setOther(true); setAdding('') }}><Plus className="h-4 w-4" /> Other</Button>
        </div>
      ) : (
        <div className="grid items-end gap-2 rounded-xl border border-primary/40 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_190px_190px_180px]">
          {other && <Field label="What is it?"><Input value={kind} onChange={setKind} placeholder="e.g. Quiz, Project, Field trip" autoFocus /></Field>}
          <Field label={other ? 'Name' : `New ${kind.toLowerCase()}`}><Input value={adding} onChange={setAdding} placeholder={`Name of the ${other ? 'item' : kind.toLowerCase()}`} autoFocus={!other} /></Field>
          <Field label="From"><Input type="date" value={nFrom} onChange={setNFrom} /></Field>
          <Field label="To"><Input type="date" value={nTo} min={nFrom || undefined} onChange={setNTo} /></Field>
          <Field label="Status"><Select value={nStatus} onChange={(v) => setNStatus(v as Status)} options={STATUS} /></Field>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-4 sm:justify-end">
            <Button variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
            <Button onClick={() => add.mutate()} pending={add.isPending} disabled={!adding.trim() || (other && !kind.trim()) || (!!nFrom && !!nTo && nTo < nFrom)}>Add</Button>
          </div>
        </div>
      )}
      <FormNotice error={add.error} />
    </div>
  )
}
