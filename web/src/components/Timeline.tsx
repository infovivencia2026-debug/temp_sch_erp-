import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  MessageSquareWarning, NotebookPen, ShieldAlert, CalendarOff, Clock, IndianRupee,
  GraduationCap, Megaphone, MessageCircle, Wallet, KeyRound, Award, ListChecks,
  BookUser, DoorOpen, FileText, BookOpen, Repeat, Radio, type LucideIcon,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Card, CardHeader, ErrorState, Loading, SEG_BAR, segClass } from '@/components/ui'
import { formatDate, cn } from '@/lib/utils'

/* EVERYTHING THAT HAPPENED, ON ONE LINE (owner, 2026-10-22).

   The shared timeline every 360 wears: Student 360 and Staff 360 each point
   it at their own endpoint, which unions the tables behind the record
   (concerns, remarks, leave, attendance, fees, results, notices, roles,
   appraisals, tasks) into one list, newest first. Grouped by day; each event
   is a coloured dot with its icon, a title, one line of detail, who did it,
   and a link to the screen it came from (the same /go/ links notifications
   use, so it lands on whatever screen the reader holds for it). */

export interface TimelineEvent {
  id: string
  type: string
  at: string
  title: string
  detail: string
  by: string
  link: string | null
}

interface TimelinePage { items: TimelineEvent[]; next: string | null; types: string[] }

/* Literal class names, so Tailwind sees every one of them. */
const KINDS: Record<string, { label: string; icon: LucideIcon; dot: string; ink: string }> = {
  concern: { label: 'Concerns', icon: MessageSquareWarning, dot: 'bg-[hsl(var(--sys-red))]', ink: 'text-[hsl(var(--sys-red-ink))]' },
  remark: { label: 'Remarks', icon: NotebookPen, dot: 'bg-[hsl(var(--sys-indigo))]', ink: 'text-[hsl(var(--sys-indigo-ink))]' },
  behaviour: { label: 'Behaviour', icon: ShieldAlert, dot: 'bg-[hsl(var(--sys-orange))]', ink: 'text-[hsl(var(--sys-orange-ink))]' },
  leave: { label: 'Leave', icon: CalendarOff, dot: 'bg-[hsl(var(--sys-teal))]', ink: 'text-[hsl(var(--sys-teal-ink))]' },
  attendance: { label: 'Attendance', icon: Clock, dot: 'bg-[hsl(var(--sys-orange))]', ink: 'text-[hsl(var(--sys-orange-ink))]' },
  fee: { label: 'Fees', icon: IndianRupee, dot: 'bg-[hsl(var(--sys-green))]', ink: 'text-[hsl(var(--sys-green-ink))]' },
  marks: { label: 'Results', icon: GraduationCap, dot: 'bg-[hsl(var(--sys-blue))]', ink: 'text-[hsl(var(--sys-blue-ink))]' },
  notice: { label: 'Notices', icon: Megaphone, dot: 'bg-[hsl(var(--sys-gray))]', ink: 'text-[hsl(var(--sys-gray-ink))]' },
  message: { label: 'Messages', icon: MessageCircle, dot: 'bg-[hsl(var(--sys-blue))]', ink: 'text-[hsl(var(--sys-blue-ink))]' },
  payroll: { label: 'Pay', icon: Wallet, dot: 'bg-[hsl(var(--sys-green))]', ink: 'text-[hsl(var(--sys-green-ink))]' },
  role: { label: 'Roles', icon: KeyRound, dot: 'bg-[hsl(var(--sys-purple))]', ink: 'text-[hsl(var(--sys-purple-ink))]' },
  appraisal: { label: 'Appraisals', icon: Award, dot: 'bg-[hsl(var(--sys-pink))]', ink: 'text-[hsl(var(--sys-pink-ink))]' },
  task: { label: 'Tasks', icon: ListChecks, dot: 'bg-[hsl(var(--sys-indigo))]', ink: 'text-[hsl(var(--sys-indigo-ink))]' },
  service: { label: 'Service book', icon: BookUser, dot: 'bg-[hsl(var(--sys-purple))]', ink: 'text-[hsl(var(--sys-purple-ink))]' },
  exit: { label: 'Exit', icon: DoorOpen, dot: 'bg-[hsl(var(--sys-red))]', ink: 'text-[hsl(var(--sys-red-ink))]' },
  document: { label: 'Documents', icon: FileText, dot: 'bg-[hsl(var(--sys-gray))]', ink: 'text-[hsl(var(--sys-gray-ink))]' },
  teaching: { label: 'Teaching', icon: BookOpen, dot: 'bg-[hsl(var(--sys-blue))]', ink: 'text-[hsl(var(--sys-blue-ink))]' },
  substitution: { label: 'Covers', icon: Repeat, dot: 'bg-[hsl(var(--sys-teal))]', ink: 'text-[hsl(var(--sys-teal-ink))]' },
  status: { label: 'Status', icon: Radio, dot: 'bg-[hsl(var(--sys-pink))]', ink: 'text-[hsl(var(--sys-pink-ink))]' },
}
const FALLBACK = KINDS.notice

/* A day-only event (an absence, a punch) is stored at midnight UTC and has
   no time worth showing; everything else shows when it happened. */
const timeOf = (at: string) => (at.endsWith('T00:00:00.000Z') ? ''
  : new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(at)))
const dayKey = (at: string) => new Date(at).toLocaleDateString('en-CA')

export default function Timeline({ url, title = 'Timeline' }: {
  /** The record's timeline endpoint, e.g. /api/v1/students/{id}/timeline. */
  url: string
  title?: string
}) {
  const [type, setType] = useState('')
  const q = useInfiniteQuery({
    queryKey: ['timeline', url, type],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams()
      if (type) p.set('types', type)
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

  return (
    <Card>
      <CardHeader title={title} description="Everything recorded about them, newest first." />
      {types.length > 1 && (
        /* pt: the header draws a line under the title, and the filters sat on it. */
        <div className="px-[var(--card-pad)] pb-3 pt-3">
          <div className={SEG_BAR} role="group" aria-label="Show">
            {[['', 'All'] as const, ...types.map((t) => [t, KINDS[t]?.label ?? t] as const)].map(([k, label]) => (
              <button key={k || 'all'} type="button" aria-pressed={type === k} className={segClass(type === k)}
                onClick={() => setType(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {q.isLoading ? (
        <div className="p-[var(--card-pad)]"><Loading shape="inline" /></div>
      ) : q.error ? (
        <div className="p-[var(--card-pad)]"><ErrorState error={q.error} /></div>
      ) : events.length === 0 ? (
        <p className="m-0 px-[var(--card-pad)] pb-6 pt-2 text-[13.5px] text-muted-foreground">
          {type ? 'Nothing of this kind recorded yet.' : 'Nothing recorded yet.'}
        </p>
      ) : (
        <div className="px-[var(--card-pad)] pb-[var(--card-pad)]">
          {days.map((d) => (
            <section key={d.key} className="mt-2 first:mt-0">
              <h3 className="eyebrow sticky top-0 z-[1] bg-card py-2 text-muted-foreground">{formatDate(d.at)}</h3>
              <ol className="relative ms-[11px] border-s ps-0">
                {d.items.map((e) => {
                  const k = KINDS[e.type] ?? FALLBACK
                  const Icon = k.icon
                  const body = (
                    <>
                      <p className="flex min-w-0 items-baseline gap-2">
                        <Icon className={cn('h-3.5 w-3.5 shrink-0 self-center', k.ink)} aria-hidden />
                        <span className="min-w-0 truncate text-[14px] font-medium">{e.title}</span>
                      </p>
                      {e.detail && <p className="mt-0.5 line-clamp-2 break-words text-[13px] text-muted-foreground">{e.detail}</p>}
                      {(e.by || timeOf(e.at)) && (
                        <p className="mt-0.5 text-[12px] text-muted-foreground">
                          {[e.by, timeOf(e.at)].filter(Boolean).join(' · ')}
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
              <Button variant="secondary" size="sm" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
