import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, ChevronDown, GraduationCap, PartyPopper, Sun } from 'lucide-react'
import { api } from '@/lib/api'
import { ErrorState } from '@/components/ui'
import { cn } from '@/lib/utils'
import { Bone, HUE, PullToRefresh, StudentHeader, StudentPage, Tile, daysFrom, todayISO, type Hue } from './student-kit'

/* MY CALENDAR: what is coming for my class. The same merged year the portal
   calendar reads (terms, holidays, my class's exam papers, clubs), led by the
   next thing and a countdown, with the past folded away. */

interface Entry { on_date: string; to_date?: string; kind: string; title: string; detail?: string; all_day: boolean; starts_at?: string }
interface CalendarResponse { class_name: string; section_name: string; items: Entry[] }

const q = { queryKey: ['student-calendar-mine'], queryFn: () => api.get<CalendarResponse>('/api/v1/portal/calendar') }

const KIND: Record<string, { label: string; hue: Hue }> = {
  exam: { label: 'Exam', hue: 'rose' },
  holiday: { label: 'Holiday', hue: 'emerald' },
  vacation: { label: 'Holidays', hue: 'emerald' },
  event: { label: 'Event', hue: 'indigo' },
  club_event: { label: 'Club', hue: 'sky' },
  ptm: { label: 'Parents meet', hue: 'sky' },
  term: { label: 'Term', hue: 'slate' },
  working_day: { label: 'School day', hue: 'amber' },
}
const kindOf = (k: string) => KIND[k] ?? { label: k, hue: 'slate' as Hue }
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'exam', label: 'Exams' },
  { key: 'off', label: 'Holidays' },
  { key: 'event', label: 'Events' },
] as const
type Filter = (typeof FILTERS)[number]['key']
const matches = (f: Filter, k: string) => f === 'all' || (f === 'exam' ? k === 'exam' : f === 'off' ? k === 'holiday' || k === 'vacation' : k === 'event' || k === 'club_event' || k === 'ptm')

function when(iso: string) {
  const n = daysFrom(iso)
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  if (n < 7) return `In ${n} days`
  if (n < 14) return 'Next week'
  return `In ${Math.round(n / 7)} weeks`
}
/* The server's detail repeats the start time ("09:30 · 90 min · max 50");
   the time is shown once, beside the date, so it is taken off the front. */
function detailOf(e: Entry) {
  const d = e.detail ?? ''
  return e.starts_at && d.startsWith(e.starts_at) ? d.slice(e.starts_at.length).replace(/^\s*·\s*/, '') : d
}
const monthOf = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

export default function StudentCalendar() {
  const qc = useQueryClient()
  const r = useQuery(q)
  const [filter, setFilter] = useState<Filter>('all')
  const [showPast, setShowPast] = useState(false)
  const today = todayISO()
  const items = [...(r.data?.items ?? [])].filter((e) => e.kind !== 'term').sort((a, b) => a.on_date.localeCompare(b.on_date))
  const ahead = items.filter((e) => (e.to_date ?? e.on_date) >= today)
  const past = items.filter((e) => (e.to_date ?? e.on_date) < today).reverse()
  const next = ahead[0]
  const exams = ahead.filter((e) => e.kind === 'exam').length
  const off = ahead.filter((e) => e.kind === 'holiday' || e.kind === 'vacation').length
  const shown = ahead.filter((e) => matches(filter, e.kind))
  const months: [string, Entry[]][] = []
  for (const e of shown) { const m = monthOf(e.on_date); const last = months[months.length - 1]; if (last && last[0] === m) last[1].push(e); else months.push([m, [e]]) }

  return (
    <PullToRefresh onRefresh={() => qc.invalidateQueries({ queryKey: q.queryKey })}>
      <StudentPage>
        <StudentHeader title="Calendar" sub={r.data ? `What's coming up for ${r.data.class_name} ${r.data.section_name}` : undefined} />

        {r.error ? <ErrorState error={r.error} /> : !r.data ? (
          <div className="space-y-3"><Bone className="h-[104px] w-full rounded-2xl" /><div className="grid grid-cols-2 gap-3"><Bone className="h-[92px] rounded-2xl" /><Bone className="h-[92px] rounded-2xl" /></div><Bone className="h-[300px] w-full rounded-2xl" /></div>
        ) : (
          <>
            <section className="card stu-rise flex min-h-[104px] items-center gap-4 p-4" aria-label="Next up">
              {next ? (
                <>
                  <DateBlock iso={next.on_date} hue={kindOf(next.kind).hue} big />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Next up · {when(next.on_date)}</p>
                    <p className="text-[18px] font-semibold leading-snug [overflow-wrap:anywhere]">{next.title}</p>
                    <p className="truncate text-[13px] text-muted-foreground">{[next.starts_at, detailOf(next)].filter(Boolean).join(' · ') || kindOf(next.kind).label}</p>
                  </div>
                </>
              ) : (
                <>
                  <span className={cn('flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl', HUE.emerald.bg, HUE.emerald.fg)}><Sun className="h-6 w-6" strokeWidth={1.75} /></span>
                  <div><p className="text-[18px] font-semibold">Nothing planned yet</p><p className="text-[13px] text-muted-foreground">New exams and holidays appear here as the school adds them.</p></div>
                </>
              )}
            </section>

            <div className="grid grid-cols-2 gap-3">
              <Tile i={1} icon={GraduationCap} hue="rose" value={exams} label={exams === 1 ? 'exam coming' : 'exams coming'} />
              <Tile i={2} icon={PartyPopper} hue="emerald" value={off} label={off === 1 ? 'holiday coming' : 'holidays coming'} />
            </div>

            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Show">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}
                  className={cn('min-h-[44px] shrink-0 rounded-full border px-4 text-[14px] font-medium', filter === f.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-[var(--color-card,white)]')}>
                  {f.label}
                </button>
              ))}
            </div>

            {months.length === 0 ? (ahead.length === 0 ? null : 
              <div className="card px-4 py-8 text-center text-[15px] text-muted-foreground"><CalendarDays className="mx-auto mb-2 h-8 w-8" strokeWidth={1.5} />Nothing coming up here.</div>
            )) : months.map(([m, list], mi) => (
              <section key={m} className="card stu-rise overflow-hidden p-0" style={{ ['--i' as string]: mi + 3 }} aria-label={m}>
                <h2 className="px-4 pb-1 pt-3 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{m}</h2>
                <ul className="divide-y">{list.map((e, i) => <Row key={`${e.on_date}-${e.title}-${i}`} e={e} />)}</ul>
              </section>
            ))}

            {past.length > 0 && (
              <section>
                <button type="button" onClick={() => setShowPast(!showPast)} aria-expanded={showPast} className="flex min-h-[44px] w-full items-center gap-2 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Already happened ({past.length}) <ChevronDown className={cn('h-4 w-4 transition-transform', showPast && 'rotate-180')} />
                </button>
                {showPast && <ul className="card divide-y overflow-hidden p-0 opacity-80">{past.map((e, i) => <Row key={`p-${e.on_date}-${e.title}-${i}`} e={e} />)}</ul>}
              </section>
            )}
          </>
        )}
      </StudentPage>
    </PullToRefresh>
  )
}

function DateBlock({ iso, hue, big }: { iso: string; hue: Hue; big?: boolean }) {
  const d = new Date(iso + 'T00:00:00')
  return (
    <span className={cn('flex shrink-0 flex-col items-center justify-center rounded-2xl', HUE[hue].bg, HUE[hue].fg, big ? 'h-14 w-14' : 'h-12 w-12')}>
      <span className={cn('font-bold leading-none tabular-nums', big ? 'text-[22px]' : 'text-[18px]')}>{d.getDate()}</span>
      <span className="text-[12px] font-semibold leading-tight">{d.toLocaleDateString('en-IN', { weekday: 'short' })}</span>
    </span>
  )
}

function Row({ e }: { e: Entry }) {
  const k = kindOf(e.kind)
  const detail = detailOf(e)
  const until = e.to_date && e.to_date !== e.on_date ? `until ${new Date(e.to_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''
  return (
    <li className="flex min-h-[64px] items-center gap-3 px-4 py-2.5">
      <DateBlock iso={e.on_date} hue={k.hue} />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium leading-snug [overflow-wrap:anywhere]">{e.title}</span>
        <span className="block truncate text-[13px] text-muted-foreground">{[e.starts_at, detail, until].filter(Boolean).join(' · ') || k.label}</span>
      </span>
      <span className={cn('inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-[12px] font-semibold', HUE[k.hue].bg, HUE[k.hue].fg)}>{k.label}</span>
    </li>
  )
}
