import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  MessageSquareWarning, NotebookPen, ShieldAlert, CalendarOff, Clock, IndianRupee,
  GraduationCap, Megaphone, MessageCircle, Wallet, KeyRound, Award, ListChecks, LogIn,
  BookOpenCheck, PencilLine, BookUser, DoorOpen, FileText, BookOpen, Repeat, Radio, type LucideIcon,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Card, CardHeader, ErrorState, Field, Input, Loading, SEG_BAR, segClass } from '@/components/ui'
import { SearchBox } from '@/components/rows'
import { formatDate, cn } from '@/lib/utils'

/* EVERYTHING THAT HAPPENED, ON ONE LINE (owner, 2026-10-22; the school-wide
   view and its filters 2026-10-23).

   One component for every timeline: Student 360 and Staff 360 point it at
   their record's endpoint, School activity at the whole school's. The
   endpoint unions the tables behind it into one list, newest first. Here it
   is grouped by day (Today, Yesterday, then dates); each event is a coloured
   dot with its icon, a title, one line of detail, who did it and when, and a
   link to the screen it came from (the /go/ links notifications use). On the
   school-wide list a chip says whether a student, a parent or staff acted,
   and the filters (who, what, when, a name) are offered. */

export interface TimelineEvent {
  id: string
  type: string
  at: string
  title: string
  detail: string
  by: string
  link: string | null
  who?: 'student' | 'parent' | 'staff' | 'system'
}

interface TimelinePage { items: TimelineEvent[]; next: string | null; types: string[] }

/* Literal class names, so Tailwind sees every one of them. */
const KINDS: Record<string, { label: string; icon: LucideIcon; dot: string; ink: string }> = {
  signin: { label: 'Sign-ins', icon: LogIn, dot: 'bg-[hsl(var(--sys-gray))]', ink: 'text-[hsl(var(--sys-gray-ink))]' },
  concern: { label: 'Concerns', icon: MessageSquareWarning, dot: 'bg-[hsl(var(--sys-red))]', ink: 'text-[hsl(var(--sys-red-ink))]' },
  remark: { label: 'Remarks', icon: NotebookPen, dot: 'bg-[hsl(var(--sys-indigo))]', ink: 'text-[hsl(var(--sys-indigo-ink))]' },
  behaviour: { label: 'Behaviour', icon: ShieldAlert, dot: 'bg-[hsl(var(--sys-orange))]', ink: 'text-[hsl(var(--sys-orange-ink))]' },
  leave: { label: 'Leave', icon: CalendarOff, dot: 'bg-[hsl(var(--sys-teal))]', ink: 'text-[hsl(var(--sys-teal-ink))]' },
  attendance: { label: 'Attendance', icon: Clock, dot: 'bg-[hsl(var(--sys-orange))]', ink: 'text-[hsl(var(--sys-orange-ink))]' },
  fee: { label: 'Fees', icon: IndianRupee, dot: 'bg-[hsl(var(--sys-green))]', ink: 'text-[hsl(var(--sys-green-ink))]' },
  homework: { label: 'Homework', icon: BookOpenCheck, dot: 'bg-[hsl(var(--sys-teal))]', ink: 'text-[hsl(var(--sys-teal-ink))]' },
  marks: { label: 'Results', icon: GraduationCap, dot: 'bg-[hsl(var(--sys-blue))]', ink: 'text-[hsl(var(--sys-blue-ink))]' },
  notice: { label: 'Notices', icon: Megaphone, dot: 'bg-[hsl(var(--sys-gray))]', ink: 'text-[hsl(var(--sys-gray-ink))]' },
  message: { label: 'Messages', icon: MessageCircle, dot: 'bg-[hsl(var(--sys-blue))]', ink: 'text-[hsl(var(--sys-blue-ink))]' },
  payroll: { label: 'Pay', icon: Wallet, dot: 'bg-[hsl(var(--sys-green))]', ink: 'text-[hsl(var(--sys-green-ink))]' },
  role: { label: 'Roles', icon: KeyRound, dot: 'bg-[hsl(var(--sys-purple))]', ink: 'text-[hsl(var(--sys-purple-ink))]' },
  appraisal: { label: 'Appraisals', icon: Award, dot: 'bg-[hsl(var(--sys-pink))]', ink: 'text-[hsl(var(--sys-pink-ink))]' },
  task: { label: 'Tasks', icon: ListChecks, dot: 'bg-[hsl(var(--sys-indigo))]', ink: 'text-[hsl(var(--sys-indigo-ink))]' },
  change: { label: 'Changes', icon: PencilLine, dot: 'bg-[hsl(var(--sys-purple))]', ink: 'text-[hsl(var(--sys-purple-ink))]' },
  service: { label: 'Service book', icon: BookUser, dot: 'bg-[hsl(var(--sys-purple))]', ink: 'text-[hsl(var(--sys-purple-ink))]' },
  exit: { label: 'Exit', icon: DoorOpen, dot: 'bg-[hsl(var(--sys-red))]', ink: 'text-[hsl(var(--sys-red-ink))]' },
  document: { label: 'Documents', icon: FileText, dot: 'bg-[hsl(var(--sys-gray))]', ink: 'text-[hsl(var(--sys-gray-ink))]' },
  teaching: { label: 'Teaching', icon: BookOpen, dot: 'bg-[hsl(var(--sys-blue))]', ink: 'text-[hsl(var(--sys-blue-ink))]' },
  substitution: { label: 'Covers', icon: Repeat, dot: 'bg-[hsl(var(--sys-teal))]', ink: 'text-[hsl(var(--sys-teal-ink))]' },
  status: { label: 'Status', icon: Radio, dot: 'bg-[hsl(var(--sys-pink))]', ink: 'text-[hsl(var(--sys-pink-ink))]' },
}
const FALLBACK = KINDS.notice

const WHO: Record<NonNullable<TimelineEvent['who']>, { label: string; chip: string }> = {
  student: { label: 'Student', chip: 'bg-[hsl(var(--sys-blue)/0.12)] text-[hsl(var(--sys-blue-ink))]' },
  parent: { label: 'Parent', chip: 'bg-[hsl(var(--sys-green)/0.12)] text-[hsl(var(--sys-green-ink))]' },
  staff: { label: 'Staff', chip: 'bg-[hsl(var(--sys-purple)/0.12)] text-[hsl(var(--sys-purple-ink))]' },
  system: { label: 'System', chip: 'bg-muted text-muted-foreground' },
}

/* A day-only event (an absence, a punch) is stored at midnight UTC and has
   no time worth showing; everything else shows when it happened. */
const timeOf = (at: string) => (at.endsWith('T00:00:00.000Z') ? ''
  : new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(at)))
const dayKey = (at: string) => new Date(at).toLocaleDateString('en-CA')
function dayLabel(at: string) {
  const k = dayKey(at)
  if (k === dayKey(new Date().toISOString())) return 'Today'
  if (k === dayKey(new Date(Date.now() - 86_400_000).toISOString())) return 'Yesterday'
  return formatDate(at)
}

/** The search box waits for a pause in typing before it asks the server. */
function useSettled(v: string, ms = 350) {
  const [s, setS] = useState(v)
  useEffect(() => { const t = setTimeout(() => setS(v), ms); return () => clearTimeout(t) }, [v, ms])
  return s
}

export default function Timeline({ url, title = 'Timeline', description = 'Everything recorded about them, newest first.', filters = false }: {
  /** The timeline endpoint, e.g. /api/v1/students/{id}/timeline. */
  url: string
  title?: string
  description?: string
  /** Offer who, date and name filters (the school-wide list). */
  filters?: boolean
}) {
  const [type, setType] = useState('')
  const [who, setWho] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [text, setText] = useState('')
  const name = useSettled(text.trim())
  const q = useInfiniteQuery({
    queryKey: ['timeline', url, type, who, from, to, name],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams()
      if (type) p.set('types', type)
      if (who) p.set('who', who)
      if (from) p.set('from', from)
      if (to) p.set('to', to)
      if (name) p.set('q', name)
      if (pageParam) p.set('cursor', pageParam)
      const qs = p.toString()
      return api.get<TimelinePage>(qs ? `${url}?${qs}` : url)
    },
    getNextPageParam: (last) => last.next ?? undefined,
  })

  const events = q.data?.pages.flatMap((p) => p.items) ?? []
  /* The chips are the kinds this reader can see at all, from the first page,
     so a type the server leaves out (pay, for someone without payroll) never
     offers a filter that can only come back empty. */
  const types = q.data?.pages[0]?.types ?? []
  const days: { key: string; at: string; items: TimelineEvent[] }[] = []
  for (const e of events) {
    const k = dayKey(e.at)
    const last = days[days.length - 1]
    if (last && last.key === k) last.items.push(e)
    else days.push({ key: k, at: e.at, items: [e] })
  }
  const narrowed = !!(type || who || from || to || name)
  const clear = () => { setType(''); setWho(''); setFrom(''); setTo(''); setText('') }

  return (
    <Card>
      <CardHeader title={title} description={description} />
      {/* pt: the header draws a line under the title, and the filters sat on it. */}
      <div className="space-y-3 px-[var(--card-pad)] pb-3 pt-3">
        {filters && (
          <div className="flex flex-wrap items-end gap-3">
            <div className={SEG_BAR} role="group" aria-label="Who">
              {([['', 'Everyone'], ['student', 'Students'], ['parent', 'Parents'], ['staff', 'Staff']] as const).map(([k, label]) => (
                <button key={k || 'all'} type="button" aria-pressed={who === k} className={segClass(who === k)} onClick={() => setWho(k)}>{label}</button>
              ))}
            </div>
            <div className="w-[11.5rem]"><Field label="From"><Input type="date" value={from} max={to || undefined} onChange={setFrom} /></Field></div>
            <div className="w-[11.5rem]"><Field label="To"><Input type="date" value={to} min={from || undefined} onChange={setTo} /></Field></div>
            <SearchBox value={text} onChange={setText} placeholder="Name or what happened" />
            {narrowed && <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button>}
          </div>
        )}
        {types.length > 1 && (
          <div className={cn(SEG_BAR, 'max-w-full')} role="group" aria-label="Show">
            {[['', 'All'] as const, ...types.map((t) => [t, KINDS[t]?.label ?? t] as const)].map(([k, label]) => {
              const Icon = k ? KINDS[k]?.icon : null
              return (
                <button key={k || 'all'} type="button" aria-pressed={type === k} className={cn(segClass(type === k), 'inline-flex items-center gap-1.5')}
                  onClick={() => setType(k)}>
                  {Icon && <Icon className={cn('h-3.5 w-3.5', KINDS[k].ink)} aria-hidden />}
                  {label}
                </button>
              )
            })}
          </div>
        )}
        {events.length > 0 && (
          <p className="text-[12px] text-muted-foreground" aria-live="polite">
            Showing {events.length}{q.hasNextPage ? '+' : ''} {events.length === 1 ? 'event' : 'events'}{narrowed ? ' that match' : ''}.
          </p>
        )}
      </div>
      {q.isLoading ? (
        <div className="p-[var(--card-pad)]"><Loading shape="inline" /></div>
      ) : q.error ? (
        <div className="p-[var(--card-pad)]"><ErrorState error={q.error} /></div>
      ) : events.length === 0 ? (
        <div className="px-[var(--card-pad)] pb-6 pt-2 text-[13.5px] text-muted-foreground">
          <p>{narrowed ? 'Nothing matches these filters.' : 'Nothing recorded yet.'}</p>
          {narrowed && <Button size="sm" variant="secondary" onClick={clear} className="mt-3">Clear filters</Button>}
        </div>
      ) : (
        <div className="px-[var(--card-pad)] pb-[var(--card-pad)]">
          {days.map((d) => (
            <section key={d.key} className="mt-2 first:mt-0">
              <h3 className="eyebrow sticky top-0 z-[1] flex items-baseline justify-between bg-card py-2 text-muted-foreground">
                <span>{dayLabel(d.at)}</span>
                <span className="text-[11px] font-normal normal-case tracking-normal">{d.items.length} {d.items.length === 1 ? 'event' : 'events'}</span>
              </h3>
              <ol className="relative ms-[11px] border-s ps-0">
                {d.items.map((e) => {
                  const k = KINDS[e.type] ?? FALLBACK
                  const Icon = k.icon
                  const w = e.who ? WHO[e.who] : null
                  const body = (
                    <>
                      <p className="flex min-w-0 items-baseline gap-2">
                        <Icon className={cn('h-3.5 w-3.5 shrink-0 self-center', k.ink)} aria-hidden />
                        <span className="min-w-0 truncate text-[14px] font-medium">{e.title}</span>
                      </p>
                      {e.detail && <p className="mt-0.5 line-clamp-2 break-words text-[13px] text-muted-foreground">{e.detail}</p>}
                      {(e.by || timeOf(e.at) || w) && (
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
                          {w && <span className={cn('rounded-full px-2 py-px text-[11px] font-medium', w.chip)}>{w.label}</span>}
                          <span className="min-w-0 truncate">{[e.by, timeOf(e.at)].filter(Boolean).join(' · ')}</span>
                        </p>
                      )}
                    </>
                  )
                  return (
                    <li key={e.id} className="relative ps-5 pb-3 last:pb-1">
                      <span aria-hidden className={cn('absolute -start-[5px] top-[7px] h-2.5 w-2.5 rounded-full ring-4 ring-card', k.dot)} />
                      {e.link ? (
                        <Link to={e.link} className="block min-w-0 rounded-md px-2 py-1 -mx-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {body}
                        </Link>
                      ) : (
                        <div className="-mx-2 min-w-0 px-2 py-1">{body}</div>
                      )}
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}
          {q.hasNextPage && (
            <div className="pt-2">
              <Button variant="secondary" size="sm" pending={q.isFetchingNextPage} disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
