import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { api } from '@/lib/api'
import { SkeletonTiles, ErrorState, FormNotice } from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'
import { ChooseChild } from '@/features/portal/ChooseChild'

/* MY PLANNER (owner, 2026-10-10: "change my planner like this, for phone
   view", from their own Student Task Hub design). A progress card with the
   streak, a quick-add card (kind chips, suggestions, date, Normal / Urgent),
   All / Pending / Done, and one card per item that is ticked by tapping it --
   with coloured paper when it is. On a computer it is two columns.

   Only what the student wrote themselves: lessons, homework, tests and
   school events are on My day, Homework, Timetable and the Calendar already.
   The notes stay private -- no teacher screen reads them. */

interface PlanItem { id: string; on_date: string; kind: string; body: string; priority: 'urgent' | 'normal'; done_at: string | null }
interface PlannerResponse { items: PlanItem[]; streak: number }

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

/* Coloured paper when something is ticked off (owner, 2026-10-10: "after
   tick, the colour papers will show"). Plain DOM, no library; gone in about
   a second, and not at all for somebody who asked for less motion. */
function confetti(x: number, y: number) {
  if (typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const colours = ['#4f46e5', '#16a34a', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899']
  for (let i = 0; i < 28; i++) {
    const p = document.createElement('span')
    const a = Math.random() * Math.PI * 2
    const v = 60 + Math.random() * 110
    Object.assign(p.style, {
      position: 'fixed', left: `${x}px`, top: `${y}px`, width: '7px', height: '11px', zIndex: '9999',
      background: colours[i % colours.length], borderRadius: '2px', pointerEvents: 'none',
    })
    document.body.appendChild(p)
    const anim = p.animate?.([
      { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${Math.cos(a) * v}px,${Math.sin(a) * v - 60}px) rotate(${Math.random() * 540}deg)`, opacity: 1, offset: 0.6 },
      { transform: `translate(${Math.cos(a) * v * 1.2}px,${Math.sin(a) * v + 80}px) rotate(${Math.random() * 720}deg)`, opacity: 0 },
    ], { duration: 900 + Math.random() * 300, easing: 'cubic-bezier(.2,.7,.4,1)' })
    if (anim) anim.onfinish = () => p.remove()
    else window.setTimeout(() => p.remove(), 50)
  }
}

type Filter = 'all' | 'pending' | 'done'

export default function Diary() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [kind, setKind] = useState<string>('homework')
  const [body, setBody] = useState('')
  const [date, setDate] = useState(iso(new Date()))
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal')
  const [filter, setFilter] = useState<Filter>('all')
  const [popped, setPopped] = useState<string | null>(null)

  // A week back (so what is still undone is not lost) to a month ahead.
  const from = shift(-7)
  const to = shift(30)
  const planner = useQuery({
    queryKey: ['planner', studentId, from, to],
    queryFn: () => api.get<PlannerResponse>(`/api/v1/portal/planner${studentQuery(studentId, `from=${from}`, `to=${to}`)}`),
    enabled: ready,
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['planner'] })

  const write = useMutation({
    mutationFn: () => api.post('/api/v1/portal/diary/notes', { student_id: studentId || undefined, on_date: date, kind, body: body.trim(), priority }),
    onSuccess: () => { setBody(''); setPriority('normal'); refresh() },
  })
  /* THE BOX FILLS WITH THE PAPER, NOT AFTER IT (owner, 2026-10-10: "the
     paper popup is fast and the tick box is late").

     The confetti fired the instant the card was pressed, while the tick
     itself waited for the POST and then for the refetch behind it -- two
     network round trips on a school's line. So the celebration arrived
     first and the thing being celebrated a half second later, which reads
     as two unrelated events and makes the tick feel broken.

     The row is flipped in the cache on the press, in the same frame as the
     confetti, and the server is told afterwards. If the server refuses, the
     cache is put back exactly as it was and the row un-ticks -- which is
     the honest outcome, and visible, rather than a tick that quietly
     disagrees with what was saved.

     Not refetched on success: the row already shows the right thing, and
     pulling the whole planner back only to redraw the same state is what
     made this slow. The next natural invalidation (adding or deleting an
     item) brings the list up to date. */
  const tick = useMutation({
    mutationFn: (v: { id: string; done: boolean }) => api.post(`/api/v1/portal/diary/notes/${v.id}`, { done: v.done }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['planner'] })
      const before = qc.getQueriesData<PlannerResponse>({ queryKey: ['planner'] })
      const at = new Date().toISOString()
      qc.setQueriesData<PlannerResponse>({ queryKey: ['planner'] }, (old) => old && {
        ...old,
        items: old.items.map((x) => (x.id === v.id ? { ...x, done_at: v.done ? at : null } : x)),
      })
      return { before }
    },
    onError: (_e, _v, ctx) => {
      for (const [key, data] of ctx?.before ?? []) qc.setQueryData(key, data)
    },
  })
  const drop = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/portal/diary/notes/${id}`),
    onSuccess: refresh,
  })

  if (planner.isLoading && ready) return <SkeletonTiles count={3} label="Reading your planner…" />
  if (planner.error) return <ErrorState error={planner.error} />

  const items = (planner.data?.items ?? []).map((x) => ({ ...x, done: !!x.done_at }))
  const streak = planner.data?.streak ?? 0
  // Pending first; urgent before normal; soonest first. Done ones sink.
  const sorted = [...items].sort((a, b) => Number(a.done) - Number(b.done)
    || Number(b.priority === 'urgent') - Number(a.priority === 'urgent')
    || a.on_date.localeCompare(b.on_date))
  const shown = sorted.filter((e) => (filter === 'all' ? true : filter === 'done' ? e.done : !e.done))
  const done = items.filter((e) => e.done).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 0

  /* The paper bursts from the middle of the screen, in every view (owner,
     2026-10-10: "paper popup should be center in all views"). */
  const toggle = (e: { id: string; done: boolean }) => {
    if (!e.done) {
      setPopped(e.id)
      window.setTimeout(() => setPopped(null), 450)
      confetti(window.innerWidth / 2, window.innerHeight / 2)
    }
    tick.mutate({ id: e.id, done: !e.done })
  }

  /* Phone: the Student Task Hub design (compact cards, one column).
     Computer (lg): the owner's Planner Dashboard design (2026-10-10) -- a
     header with the progress box on the right, then Add item (5/12) beside
     the list (7/12), with labels, wrapped chips and dark pill tabs. */
  const card = 'rounded-[14px] border bg-card px-4 py-3.5 shadow-[0_2px_8px_rgba(15,23,42,0.04)] lg:rounded-2xl lg:border-slate-200/80 lg:p-6 lg:shadow-sm'
  const field = 'min-h-[44px] w-full rounded-lg border-[1.5px] bg-background px-3 text-[14px] outline-none focus:border-[#4f46e5] lg:min-h-[42px] lg:rounded-xl lg:border lg:bg-slate-50 lg:px-3.5 lg:text-[14px] lg:focus:ring-2 lg:focus:ring-indigo-500/20'
  const chips = '-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0'
  const label = 'hidden text-[12px] font-semibold text-slate-600 lg:mb-1 lg:block'
  const streakChip = streak > 0 ? (
    <span className="rounded-full border border-[#fde68a] bg-[#fef3c7] px-2.5 py-1 text-[11px] font-bold text-[#b45309] lg:py-0.5 lg:text-[12px] lg:font-semibold">
      🔥 {streak}-day streak
    </span>
  ) : items.length > 0 && done === items.length ? (
    <span className="rounded-full border border-[#bbf7d0] bg-[#dcfce7] px-2.5 py-1 text-[11px] font-bold text-[#15803d] lg:py-0.5 lg:text-[12px]">🎉 All done</span>
  ) : (
    <span className="rounded-full border bg-muted px-2.5 py-1 text-[11px] font-bold text-muted-foreground lg:py-0.5 lg:text-[12px] lg:font-semibold">Tick one to start a streak</span>
  )

  return (
    <div className="mx-auto w-full max-w-[560px] px-3 pb-6 pt-3 sm:px-4 lg:max-w-6xl lg:px-6 lg:pt-8">
      <ChildBar kids={children} value={chosen} onChange={setChosen} />
      {!ready ? (
        <ChooseChild title="Choose a child" body="Each child has their own planner." />
      ) : (
        <div className="flex flex-col gap-3.5 lg:gap-6">
          {/* Header: compact on a phone; icon, title, streak and a progress box on a computer. */}
          <header className={cn(card, 'lg:flex lg:items-center lg:justify-between lg:gap-5')}>
            <div className="flex items-center justify-between gap-3 lg:justify-start lg:gap-4">
              <div className="hidden size-12 shrink-0 place-items-center rounded-2xl border border-indigo-100/80 bg-indigo-50 text-xl lg:grid" aria-hidden="true">📅</div>
              <div className="flex min-w-0 flex-1 items-center justify-between gap-3 lg:block">
                <div className="flex items-center gap-2.5">
                  <h1 className="text-[17px] font-extrabold lg:text-[20px] lg:font-bold lg:tracking-tight">My planner</h1>
                  <span className="hidden lg:inline-flex">{streakChip}</span>
                </div>
                <p className="mt-0.5 hidden text-[12px] text-slate-500 lg:block">Manage tasks, deadlines, and study priorities</p>
                <span className="lg:hidden">{streakChip}</span>
              </div>
            </div>
            {/* Progress: a bar under the title on a phone, a box on the right on a computer. */}
            <div className="mt-2.5 lg:mt-0 lg:flex lg:shrink-0 lg:items-center lg:gap-4 lg:rounded-xl lg:border lg:border-slate-200/60 lg:bg-slate-50 lg:px-4 lg:py-3">
              <div className="flex justify-between text-[11.5px] font-semibold text-muted-foreground lg:block lg:text-right">
                <span className="hidden text-[11px] font-semibold uppercase tracking-wider text-slate-400 lg:block">Today&apos;s progress</span>
                <span className="lg:text-[14px] lg:font-bold lg:text-slate-800">{done} of {items.length} done</span>
                <span className="lg:hidden">{pct}%</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted lg:mt-0 lg:h-2 lg:w-28 lg:bg-slate-200/70">
                <div className="h-full rounded-full bg-[#16a34a] transition-[width] duration-300 lg:bg-emerald-500" style={{ width: `${pct}%` }} />
              </div>
              <span className="hidden rounded-md bg-emerald-100/80 px-2 py-0.5 font-mono text-[12px] font-bold text-emerald-700 lg:inline">{pct}%</span>
            </div>
          </header>

          <div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-12 lg:items-start lg:gap-6">
            {/* Add item */}
            <section className={cn(card, 'flex flex-col gap-3 lg:col-span-5 lg:gap-5')}>
              <div className="hidden items-center justify-between border-b border-slate-100 pb-3 lg:flex">
                <h2 className="text-[12px] font-bold uppercase tracking-wider text-slate-400">Add item</h2>
                <span className="text-[11px] font-medium text-slate-400">Quick entry</span>
              </div>
              <div>
                <span className={label}>Category</span>
                <div className={chips} role="radiogroup" aria-label="Category">
                  {KINDS.map((k) => (
                    <button key={k.value} type="button" role="radio" aria-checked={kind === k.value} onClick={() => setKind(k.value)}
                      className={cn('shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors lg:rounded-lg lg:font-medium',
                        kind === k.value ? 'border-[#4f46e5] bg-[#eef2ff] text-[#4f46e5] lg:border-indigo-200 lg:bg-indigo-50 lg:text-indigo-700' : 'bg-card text-muted-foreground lg:text-slate-600 lg:hover:bg-slate-50')}>
                      {k.emoji} {k.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className={label}>Suggestions</span>
                <div className={chips}>
                  {PRESETS.map((p) => (
                    <button key={p} type="button" onClick={() => setBody(p)}
                      className="shrink-0 rounded-md border bg-muted/60 px-2.5 py-1 text-[11px] text-foreground/80 lg:border-0 lg:bg-slate-100 lg:text-[12px] lg:text-slate-600 lg:hover:bg-slate-200">{p}</button>
                  ))}
                </div>
              </div>
              <form className="flex flex-col gap-2 lg:gap-4" onSubmit={(e) => { e.preventDefault(); if (body.trim()) write.mutate() }}>
                <div>
                  <span className={label}>Title</span>
                  <input value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder="What needs to be done?" aria-label="Title" className={field} />
                </div>
                <div className="grid grid-cols-2 gap-2 lg:gap-3">
                  <div>
                    <span className={label}>Date</span>
                    <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" className={field} />
                  </div>
                  <div>
                    <span className={label}>Priority</span>
                    <div className="flex min-h-[44px] rounded-lg border-[1.5px] p-[3px] lg:min-h-[42px] lg:gap-1.5 lg:border-0 lg:p-0" role="radiogroup" aria-label="Priority">
                      {(['normal', 'urgent'] as const).map((p) => (
                        <button key={p} type="button" role="radio" aria-checked={priority === p} onClick={() => setPriority(p)}
                          className={cn('flex-1 rounded-md text-[12.5px] font-semibold transition-colors lg:rounded-xl lg:border',
                            priority === p
                              ? (p === 'urgent' ? 'bg-[#fee2e2] text-[#b91c1c] lg:border-rose-200' : 'bg-[#dcfce7] text-[#15803d] lg:border-emerald-200')
                              : 'text-muted-foreground lg:border-slate-200 lg:bg-white lg:text-slate-600')}>
                          {p === 'urgent' ? '🔥 Urgent' : 'Normal'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <button type="submit" disabled={!body.trim() || write.isPending}
                  className="min-h-[44px] w-full rounded-lg bg-[#4f46e5] text-[13.5px] font-bold text-white transition-opacity disabled:opacity-50 lg:rounded-xl lg:bg-indigo-500 lg:text-[14px] lg:font-semibold lg:hover:bg-indigo-600">
                  {write.isPending ? 'Adding…' : '+ Add item'}
                </button>
              </form>
              <FormNotice error={write.error} />
            </section>

            {/* The list */}
            <section className="flex flex-col gap-3.5 lg:col-span-7 lg:gap-4 lg:rounded-2xl lg:border lg:border-slate-200/80 lg:bg-card lg:p-6 lg:shadow-sm">
              <div className="flex gap-1 rounded-lg bg-muted p-[3px] lg:gap-1.5 lg:rounded-none lg:border-b lg:border-slate-100 lg:bg-transparent lg:p-0 lg:pb-3" role="tablist" aria-label="Show">
                {(['all', 'pending', 'done'] as const).map((f) => (
                  <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                    className={cn('flex-1 rounded-md py-1.5 text-[12px] font-semibold transition-colors lg:flex-none lg:rounded-lg lg:px-3',
                      filter === f
                        ? 'bg-card text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.06)] lg:bg-slate-900 lg:text-white lg:shadow-none'
                        : 'text-muted-foreground lg:text-slate-600 lg:hover:bg-slate-100')}>
                    {f === 'done' ? `Done (${done})` : f === 'pending' ? `Pending (${items.length - done})` : `All (${items.length})`}
                  </button>
                ))}
              </div>

              <div className="flex flex-col gap-2 lg:min-h-[360px] lg:gap-2.5">
                {shown.length === 0 && (
                  <p className="rounded-lg border border-dashed bg-card px-4 py-8 text-center text-[13px] text-muted-foreground">
                    {items.length === 0 ? 'Nothing planned yet. Add your first item.' : filter === 'done' ? 'Nothing ticked off yet.' : 'All done. Nice work!'}
                  </p>
                )}
                {shown.map((e) => {
                  const k = kindOf(e.kind)
                  return (
                    <div key={e.id} role="button" tabIndex={0} aria-pressed={e.done}
                      onClick={() => toggle(e)}
                      onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(e) } }}
                      /* BIGGER ON A DESK (owner, 2026-10-10: "make the
                         cards big"). The list sits in half a 1900px screen
                         and the cards were phone-sized inside it: a 26px
                         tick, 14px type and 14px of padding, three of them
                         adrift in a column of empty white. A card in a
                         column that wide can afford the room, and the thing
                         being pressed is the whole card, so a bigger card is
                         also an easier target. The phone keeps its own
                         sizes -- there the cards already fill the screen. */
                      className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-lg border-[1.5px] px-3.5 py-3 transition-transform active:scale-[0.98] lg:gap-4 lg:rounded-2xl lg:border lg:px-5 lg:py-[18px]',
                        e.done ? 'border-[#bbf7d0] bg-[#f0fdf4] lg:border-emerald-200 lg:bg-emerald-50/60' : 'bg-card lg:border-slate-200 lg:hover:border-slate-300')}>
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span className={cn('grid size-[26px] shrink-0 place-items-center rounded-full border-2 transition-colors lg:size-8',
                          e.done ? 'border-[#16a34a] bg-[#16a34a] text-white lg:border-emerald-500 lg:bg-emerald-500' : 'border-[#cbd5e1] bg-card text-transparent',
                          popped === e.id && 'animate-[planner-pop_.45s_ease]')}>
                          <Check className="size-3.5 lg:size-[18px]" strokeWidth={3.5} aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                          <div className="mb-0.5 flex items-center gap-1.5 lg:gap-2">
                            <span className={cn('rounded px-1.5 py-px text-[10px] font-bold uppercase lg:rounded-md lg:px-2 lg:py-0.5 lg:text-[11px] lg:tracking-wider', k.badge)}>{k.label}</span>
                            <span className="text-[11px] text-muted-foreground lg:text-[13px] lg:font-medium">{formatDate(e.on_date)}</span>
                            {e.priority === 'urgent'
                              ? <span className="text-[10px] font-semibold text-rose-600">🔥 Urgent</span>
                              : <span className="size-1.5 rounded-full bg-[#16a34a] lg:hidden" title="Normal" aria-label="Normal" />}
                          </div>
                          <p className={cn('text-[13.5px] font-medium leading-snug lg:text-[16px] lg:font-semibold lg:text-slate-800', e.done && 'text-muted-foreground line-through lg:opacity-75')}>{e.body}</p>
                        </div>
                      </div>
                      <button type="button" aria-label="Delete" title="Delete" disabled={drop.isPending}
                        onClick={(ev) => { ev.stopPropagation(); drop.mutate(e.id) }}
                        className="grid size-8 shrink-0 place-items-center rounded-full text-[#94a3b8] hover:bg-muted hover:text-rose-500 lg:size-10 lg:rounded-xl">
                        <X className="size-4 lg:size-[18px]" aria-hidden="true" />
                      </button>
                    </div>
                  )
                })}
                <FormNotice error={tick.error ?? drop.error} />
              </div>
            </section>
          </div>
        </div>
      )}
      <style>{'@keyframes planner-pop{0%{transform:scale(1)}40%{transform:scale(1.35)}100%{transform:scale(1)}}'}</style>
    </div>
  )
}
