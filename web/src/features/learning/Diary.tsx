import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { api } from '@/lib/api'
import { SkeletonTiles, ErrorState, FormNotice } from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'
import { ChooseChild } from '@/features/portal/ChooseChild'

interface Entry {
  on_date: string
  kind: string
  title: string
  detail?: string
  starts_at?: string
  ends_at?: string
  ref_id?: string
  done: boolean
}
interface DiaryResponse {
  student_id: string
  class_name: string
  section_name: string
  from: string
  to: string
  items: Entry[]
}

/* MY PLANNER, PHONE FIRST (owner, 2026-10-10: "change my planner like this,
   for phone view", from their own Student Task Hub design). A progress card,
   a quick-add card with the kind as chips and ready-made suggestions, All /
   Pending / Done, and one card per item that is ticked by tapping it.

   Only what the student wrote themselves: lessons, homework, tests and
   school events are on My day, Homework, Timetable and the Calendar already.
   The notes stay private -- no teacher screen reads them. */

const KINDS = [
  { value: 'homework', label: 'Homework', emoji: '📚', badge: 'bg-[#e0e7ff] text-[#4338ca]' },
  { value: 'reminder', label: 'Reminder', emoji: '🔔', badge: 'bg-[#fef3c7] text-[#b45309]' },
  { value: 'revision', label: 'Exam prep', emoji: '🎯', badge: 'bg-[#fee2e2] text-[#b91c1c]' },
  { value: 'note', label: 'Note', emoji: '📝', badge: 'bg-[#f1f5f9] text-[#475569]' },
  { value: 'personal', label: 'Personal', emoji: '⭐', badge: 'bg-[#dcfce7] text-[#15803d]' },
] as const
const kindOf = (k?: string) => KINDS.find((x) => x.value === k) ?? KINDS[3]
const PRESETS = ['Pack PE kit', 'Finish maths homework', 'Get diary signed', 'Revise for the test', 'Return library book']

const iso = (d: Date) => d.toISOString().slice(0, 10)
const shift = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return iso(d) }

type Filter = 'all' | 'pending' | 'done'

export default function Diary() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [kind, setKind] = useState<string>('homework')
  const [body, setBody] = useState('')
  const [date, setDate] = useState(iso(new Date()))
  const [filter, setFilter] = useState<Filter>('all')
  const [popped, setPopped] = useState<string | null>(null)

  // A week back (so what is still undone is not lost) to a month ahead.
  const from = shift(-7)
  const to = shift(30)
  const diary = useQuery({
    queryKey: ['diary', studentId, from, to],
    queryFn: () => api.get<DiaryResponse>(`/api/v1/portal/diary${studentQuery(studentId, `from=${from}`, `to=${to}`)}`),
    enabled: ready,
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['diary'] })

  const write = useMutation({
    mutationFn: () => api.post('/api/v1/portal/diary/notes', { student_id: studentId || undefined, on_date: date, kind, body: body.trim() }),
    onSuccess: () => { setBody(''); refresh() },
  })
  const tick = useMutation({
    mutationFn: (v: { id: string; done: boolean }) => api.post(`/api/v1/portal/diary/notes/${v.id}`, { done: v.done }),
    onSuccess: refresh,
  })
  const drop = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/portal/diary/notes/${id}`),
    onSuccess: refresh,
  })

  if (diary.isLoading && ready) return <SkeletonTiles count={3} label="Reading your planner…" />
  if (diary.error) return <ErrorState error={diary.error} />

  const items = (diary.data?.items ?? []).filter((e) => e.kind === 'note' && e.ref_id)
  // Pending first, soonest first; done ones sink.
  const sorted = [...items].sort((a, b) => Number(a.done) - Number(b.done) || a.on_date.localeCompare(b.on_date))
  const shown = sorted.filter((e) => (filter === 'all' ? true : filter === 'done' ? e.done : !e.done))
  const done = items.filter((e) => e.done).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 0

  const toggle = (e: Entry) => {
    if (!e.done) { setPopped(e.ref_id!); window.setTimeout(() => setPopped(null), 450) }
    tick.mutate({ id: e.ref_id!, done: !e.done })
  }

  return (
    <div className="mx-auto w-full max-w-[560px] px-3 pb-6 pt-3 sm:px-4">
      <ChildBar kids={children} value={chosen} onChange={setChosen} />
      {!ready ? (
        <ChooseChild title="Choose a child" body="Each child has their own planner." />
      ) : (
        <div className="flex flex-col gap-3.5">
          {/* Header and progress */}
          <header className="rounded-[14px] border bg-card px-4 py-3.5 shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-[17px] font-extrabold">My planner</h1>
              {items.length > 0 && done === items.length ? (
                <span className="rounded-full border border-[#bbf7d0] bg-[#dcfce7] px-2.5 py-1 text-[11px] font-bold text-[#15803d]">🎉 All done</span>
              ) : (
                <span className="rounded-full border border-[#fde68a] bg-[#fef3c7] px-2.5 py-1 text-[11px] font-bold text-[#b45309]">
                  🔥 {items.length - done} to do
                </span>
              )}
            </div>
            <div className="mt-2.5 flex justify-between text-[11.5px] font-semibold text-muted-foreground">
              <span>{done} of {items.length} done</span>
              <span>{pct}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-[#16a34a] transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </div>
          </header>

          {/* Quick add */}
          <section className="flex flex-col gap-3 rounded-[14px] border bg-card px-4 py-3.5 shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="radiogroup" aria-label="Kind">
              {KINDS.map((k) => (
                <button key={k.value} type="button" role="radio" aria-checked={kind === k.value} onClick={() => setKind(k.value)}
                  className={cn('shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors',
                    kind === k.value ? 'border-[#4f46e5] bg-[#eef2ff] text-[#4f46e5]' : 'bg-card text-muted-foreground')}>
                  {k.emoji} {k.label}
                </button>
              ))}
            </div>
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {PRESETS.map((p) => (
                <button key={p} type="button" onClick={() => setBody(p)}
                  className="shrink-0 rounded-md border bg-muted/60 px-2.5 py-1 text-[11px] text-foreground/80">{p}</button>
              ))}
            </div>
            <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) write.mutate() }}>
              <input value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder="What needs to be done?"
                className="min-h-[44px] w-full rounded-lg border-[1.5px] bg-background px-3 text-[14px] outline-none focus:border-[#4f46e5]" />
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                className="min-h-[44px] w-full rounded-lg border-[1.5px] bg-background px-3 text-[14px] outline-none focus:border-[#4f46e5]" />
              <button type="submit" disabled={!body.trim() || write.isPending}
                className="min-h-[44px] w-full rounded-lg bg-[#4f46e5] text-[13.5px] font-bold text-white transition-opacity disabled:opacity-50">
                {write.isPending ? 'Adding…' : '+ Add item'}
              </button>
            </form>
            <FormNotice error={write.error} />
          </section>

          {/* All / Pending / Done */}
          <div className="flex gap-1 rounded-lg bg-muted p-[3px]" role="tablist" aria-label="Show">
            {(['all', 'pending', 'done'] as const).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                className={cn('flex-1 rounded-md py-1.5 text-[12px] font-semibold capitalize transition-colors',
                  filter === f ? 'bg-card text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.06)]' : 'text-muted-foreground')}>
                {f === 'done' ? 'Done' : f === 'pending' ? 'Pending' : 'All'}
              </button>
            ))}
          </div>

          {/* The items */}
          <div className="flex flex-col gap-2">
            {shown.length === 0 && (
              <p className="rounded-lg border border-dashed bg-card px-4 py-6 text-center text-[13px] text-muted-foreground">
                {items.length === 0 ? 'Nothing planned yet. Add your first item above.' : filter === 'done' ? 'Nothing ticked off yet.' : 'All done. Nice work!'}
              </p>
            )}
            {shown.map((e) => {
              const k = kindOf(e.detail)
              return (
                <div key={e.ref_id} role="button" tabIndex={0} aria-pressed={e.done}
                  onClick={() => toggle(e)} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(e) } }}
                  className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-lg border-[1.5px] px-3.5 py-3 transition-transform active:scale-[0.98]',
                    e.done ? 'border-[#bbf7d0] bg-[#f0fdf4]' : 'bg-card')}>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className={cn('grid size-[26px] shrink-0 place-items-center rounded-full border-2 transition-colors',
                      e.done ? 'border-[#16a34a] bg-[#16a34a] text-white' : 'border-[#cbd5e1] bg-card text-transparent',
                      popped === e.ref_id && 'animate-[planner-pop_.45s_ease]')}>
                      <Check className="size-3.5" strokeWidth={3.5} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="mb-0.5 flex items-center gap-1.5">
                        <span className={cn('rounded px-1.5 py-px text-[10px] font-bold uppercase', k.badge)}>{k.label}</span>
                        <span className="text-[11px] text-muted-foreground">{formatDate(e.on_date)}</span>
                      </div>
                      <p className={cn('text-[13.5px] font-medium leading-snug', e.done && 'text-muted-foreground line-through')}>{e.title}</p>
                    </div>
                  </div>
                  <button type="button" aria-label="Delete" disabled={drop.isPending}
                    onClick={(ev) => { ev.stopPropagation(); drop.mutate(e.ref_id!) }}
                    className="grid size-8 shrink-0 place-items-center rounded-full text-[#94a3b8] hover:bg-muted hover:text-foreground">
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </div>
              )
            })}
            <FormNotice error={tick.error ?? drop.error} />
          </div>
        </div>
      )}
      <style>{`@keyframes planner-pop{0%{transform:scale(1)}40%{transform:scale(1.35)}100%{transform:scale(1)}}`}</style>
    </div>
  )
}
