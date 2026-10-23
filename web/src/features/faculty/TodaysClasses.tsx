import { useState } from 'react'
import { CalendarPlus } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '@/lib/api'
import { Badge, Button, Card, Loading, ErrorState, EmptyState, PageBody } from '@/components/ui'
import { PersonAvatar } from '@/components/ChatScreen'
import { useSession } from '@/lib/session'
import { featurePath, useActiveRole } from '@/lib/catalog'
import { useLayout } from '@/lib/layout'
import { staffLayoutOn } from '@/lib/staff-layout'
import type { List } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  notificationDay, notificationKind, useNotificationActions, useShownNotes, type Note,
} from '@/components/Notifications'

/* A teacher's own day, from their own timetable.

   THIS SCREEN USED TO BE FICTION. 190 lines, not one data call: it told every
   teacher who opened it that their next class was "Math (10th Grade)" in "Room
   304" with 26 of 28 present. A screen that invents data is worse than a
   screen that says it has none.

   Everything here comes from routes that already existed:
     /api/v1/timetable/periods                 the bell schedule (and its breaks)
     /api/v1/timetable/entries?teacher_id=me   this teacher's own lessons
     /api/v1/calendar/holiday-days             today a school holiday?
     /api/v1/me/pay                            the staff code (employee_code)
     /api/v1/profile/session-activity          today's sign-ins, when the school records them
     /api/v1/portal/notifications              the bell's own feed

   THE OWNER'S LAYOUT (2026-10-19): greeting and date with a compact profile
   block on the right; under it the day's timetable (wide) beside the
   notifications. One column on a phone, timetable first. Also the bento
   layout's faculty home, so every teacher sees the same screen. */

/** Monday is 1 in the timetable's weekday numbering; JS Sunday is 0. */
function todayWeekday(): number {
  const d = new Date().getDay()
  return d === 0 ? 7 : d
}

function minutesInto(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function clock(d: Date): string {
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min} min ago`
  if (min < 24 * 60 && notificationDay(iso) === 'Today') return `${Math.floor(min / 60)} h ago`
  return notificationDay(iso)
}


/* The left edge of a notification says what family it is from. */
const KIND_EDGE: Record<string, string> = {
  Fees: 'border-l-warning',
  Messages: 'border-l-primary',
  Message: 'border-l-primary',
  Attendance: 'border-l-success',
  Homework: 'border-l-info',
  Results: 'border-l-info',
  Lessons: 'border-l-info',
  Timetable: 'border-l-info',
  Notice: 'border-l-destructive',
}

type Row =
  | { kind: 'lesson'; key: string; start: number; end: number; label: string; title: string; room?: string; span: string }
  | { kind: 'break'; key: string; start: number; end: number; label: string; span: string }

export default function TodaysClasses() {
  const weekday = todayWeekday()
  const navigate = useNavigate()
  const session = useSession()
  const activeRole = useActiveRole()

  const periods = useQuery({
    /* Every schedule's periods: a week can span classes on different timings. */
    queryKey: ['periods', 'all'],
    queryFn: () => api.call('GET /timetable/periods', { query: { all: '1' } }),
  })
  const entries = useQuery({
    queryKey: ['timetable', 'me'],
    queryFn: () => api.call('GET /timetable/entries', { query: { teacher_id: 'me' } }),
  })

  /* A HOLIDAY HAS NO CLASSES (Yajur, 2026-10-19: "if the school is holiday
     by school calendar why showing this show holiday"). */
  const todayIso = localIso(new Date())
  const hol = useQuery({
    queryKey: ['holiday-days', 'today', todayIso],
    queryFn: () => api.get<List<{ date: string; name: string }>>(`/api/v1/calendar/holiday-days?from=${todayIso}&to=${todayIso}`),
    staleTime: 10 * 60_000, retry: false,
  })
  /* With the school's staff layout on, the greeting and profile are in the
     shell's top bar (components/StaffShell.tsx), so this screen leaves them out. */
  const { layout } = useLayout()
  const inShellHeader = layout !== 'bento' && staffLayoutOn(session, activeRole?.key)
  /* Same key as My pay, so the two share one request. */
  const pay = useQuery({
    queryKey: ['my-pay'],
    queryFn: () => api.get<{ employee_code?: string }>('/api/v1/me/pay'),
    staleTime: 10 * 60_000, retry: false, enabled: !inShellHeader,
  })
  /* Same key as the profile's Your sessions card. Empty unless the school
     records session activity; then the line is left out. */
  const activity = useQuery({
    queryKey: ['own-session-activity'],
    queryFn: () => api.get<{ recording: boolean; items: { signed_in_at: string }[] }>('/api/v1/profile/session-activity'),
    staleTime: 5 * 60_000, retry: false, enabled: !inShellHeader,
  })
  const notes = useShownNotes()
  const cover = useQuery({
    queryKey: ['cover-today'],
    queryFn: () => api.get<{ items: { kind: 'covering' | 'covered'; period: string; starts_at: string | null; section: string; subject: string; other: string }[] }>('/api/v1/timetable-cover/today'),
  })
  const [viewing, setViewing] = useState<string | null>(null)
  // The leave screen this person holds, wherever their role files it.
  const leaveSection = activeRole.sections?.find((s) => s.features.some((f) => f.slug === 'leave_self_service'))
  const leavePath = leaveSection ? featurePath(activeRole.key, leaveSection.slug, 'leave_self_service') : null
  const { linkFor } = useNotificationActions()
  const qc = useQueryClient()

  if (periods.isLoading || entries.isLoading) return <Loading label="Loading your timetable" />
  /* This home is also every staff member's at a school with the staff layout on
     (Yajur, 2026-10-19), so someone who holds no timetable is refused here; the
     panel then reads as no classes rather than the page turning into an error. */
  const refused = (e: unknown) => e instanceof ApiError && e.status === 403
  if (entries.error && !refused(entries.error)) return <ErrorState error={entries.error} />
  if (periods.error && !refused(periods.error)) return <ErrorState error={periods.error} />

  const holiday = hol.data?.items?.[0]?.name
  const bell = new Map((periods.data?.items ?? []).map((p) => [p.id, p]))
  const mine = (entries.data?.items ?? []).filter((e) => !holiday && e.weekday === weekday)

  /* Breaks from the same bell schedules today's lessons run on, between the
     first lesson and the last; a break from another schedule is not this
     teacher's. */
  const span = (a: string, b: string) => `${a.slice(0, 5)} – ${b.slice(0, 5)}`
  const lessonRows: Row[] = mine.map((e) => {
    const p = bell.get(e.period_id)
    return {
      kind: 'lesson', key: e.id,
      start: p ? minutesInto(p.starts_at) : 0, end: p ? minutesInto(p.ends_at) : 0,
      label: p?.name ?? e.period_name,
      title: `${e.subject_name} · ${e.class_name} ${e.section_name}`,
      room: e.room || undefined,
      span: p ? span(p.starts_at, p.ends_at) : '',
    }
  })
  const schedules = new Set(mine.map((e) => bell.get(e.period_id)?.bell_schedule_id ?? null))
  const firstStart = Math.min(...lessonRows.map((r) => r.start))
  const lastEnd = Math.max(...lessonRows.map((r) => r.end))
  const breakRows: Row[] = lessonRows.length === 0 ? [] : (periods.data?.items ?? [])
    .filter((p) => p.is_break && schedules.has(p.bell_schedule_id ?? null))
    .filter((p) => minutesInto(p.starts_at) >= firstStart && minutesInto(p.ends_at) <= lastEnd)
    .map((p) => ({
      kind: 'break', key: p.id, start: minutesInto(p.starts_at), end: minutesInto(p.ends_at),
      label: p.name, span: span(p.starts_at, p.ends_at),
    }))
  const rows = [...lessonRows, ...breakRows].sort((a, b) => a.start - b.start || a.end - b.end)

  /* Done, Now and Upcoming are read off the clock rather than stored, so the
     screen is right whenever it is opened. */
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const statusOf = (r: Row) => (r.end <= nowMin ? 'done' : r.start <= nowMin ? 'now' : 'upcoming')

  const hour = now.getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const fullName = session.user?.full_name ?? ''
  const first = fullName.split(/\s+/)[0]
  const dateLine = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const staffCode = pay.data?.employee_code
  const signIns = (activity.data?.items ?? [])
    .map((a) => new Date(a.signed_in_at))
    .filter((d) => !Number.isNaN(d.getTime()) && localIso(d) === todayIso)
    .sort((a, b) => a.getTime() - b.getTime())
  const signInLine = signIns.length === 0
    ? null
    : signIns.length === 1
      ? `Signed in ${clock(signIns[0])}`
      : `First sign-in ${clock(signIns[0])} · last ${clock(signIns[signIns.length - 1])}`

  const noteItems: Note[] = notes.items
  const unread = notes.items.filter((n) => !n.read_at).length

  return (
    <PageBody top width="full"><div className="flex flex-col gap-5">
      {!inShellHeader && <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-bold tracking-[-0.02em]">{greet}{first ? `, ${first}` : ''}</h1>
          <p className="text-[14px] text-muted-foreground">{dateLine}</p>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <PersonAvatar name={fullName || '?'} size={40} />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold">{fullName}</p>
            {staffCode && <p className="truncate text-[12.5px] text-muted-foreground tabular-nums">{staffCode}</p>}
            {signInLine && <p className="truncate text-[12.5px] text-muted-foreground tabular-nums">{signInLine}</p>}
          </div>
        </div>
      </div>}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Card className="flex min-w-0 flex-col lg:max-h-[calc(100dvh-14rem)]">
          <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
            <h2 className="text-[16px] font-bold">Today's timetable</h2>
            {!holiday && (
              <span className="text-[13px] text-muted-foreground">
                {lessonRows.length} {lessonRows.length === 1 ? 'period' : 'periods'}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 lg:overflow-y-auto">
            {holiday ? (
              <EmptyState title="Holiday" body={`${holiday}. No classes today.`} />
            ) : rows.length === 0 ? (
              <EmptyState
                title="No lessons timetabled today"
                body={weekday >= 6
                  ? 'Today is the weekend. Your full week is on My timetable.'
                  : 'If that is wrong, the timetable for your subjects may not be published yet; your whole week is on My timetable.'}
              />
            ) : (
              <ul>
                {rows.map((r) => {
                  if (r.kind === 'break') {
                    return (
                      <li key={r.key} className="flex items-center gap-3 px-5 py-1.5 text-[12px] text-muted-foreground">
                        <span className="h-px flex-1 bg-border" />
                        <span className="shrink-0">{r.label} · {r.span}</span>
                        <span className="h-px flex-1 bg-border" />
                      </li>
                    )
                  }
                  const st = statusOf(r)
                  return (
                    <li key={r.key}
                      className={cn('flex items-center gap-3 border-b border-l-2 border-l-transparent px-5 py-3 last:border-b-0',
                        st === 'now' && 'border-l-primary bg-primary/[0.07]')}>
                      <span className={cn('w-16 shrink-0 truncate text-[13px] font-semibold',
                        st === 'now' ? 'text-primary' : 'text-muted-foreground')}>{r.label}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14.5px] font-semibold">{r.title}</p>
                        <p className="truncate text-[12.5px] text-muted-foreground tabular-nums">
                          {r.span}{r.room ? ` · ${r.room}` : ''}
                        </p>
                      </div>
                      <Badge tone={st === 'now' ? 'primary' : st === 'done' ? 'neutral' : 'info'} className="shrink-0">
                        {st === 'now' ? 'Now' : st === 'done' ? 'Done' : 'Upcoming'}
                      </Badge>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </Card>

        <div className="flex min-w-0 flex-col gap-5">
        {/* Cover today (Yajur, 2026-10-23): the class this teacher goes to for
            an absent colleague, and who is taking their own class if they are away. */}
        {(cover.data?.items.length ?? 0) > 0 && (
          <Card className="min-w-0">
            <div className="border-b px-5 py-3"><h2 className="text-[16px] font-bold">Cover today</h2></div>
            <ul className="flex flex-col gap-2 p-3">
              {cover.data!.items.map((x, i) => (
                <li key={i} className={cn('rounded-lg border px-3 py-2.5', x.kind === 'covering' ? 'border-l-4 border-l-primary bg-primary/5' : 'border-l-2')}>
                  <p className="text-[14px] font-semibold">
                    {x.kind === 'covering' ? `Take ${x.section}, ${x.period}` : `${x.other} is taking your ${x.period}`}
                    {x.starts_at && <span className="font-normal text-muted-foreground"> · {x.starts_at}</span>}
                  </p>
                  <p className="text-[13px] text-muted-foreground">
                    {x.kind === 'covering' ? `${x.subject}, for ${x.other}` : `${x.section}, ${x.subject}`}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card className="flex min-w-0 flex-col lg:max-h-[calc(100dvh-22rem)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[16px] font-bold">Notifications</h2>
              {unread > 0 && <span className="text-[13px] text-muted-foreground">{unread} new</span>}
            </div>
          </div>
          <div className="min-h-0 flex-1 lg:overflow-y-auto">
            {notes.isLoading ? (
              <Loading label="Loading notifications" />
            ) : notes.error ? (
              <EmptyState title="Could not load notifications" body="Open the bell at the top to try again." />
            ) : noteItems.length === 0 ? (
              <EmptyState title="No notifications" body="New notices and messages for you appear here." />
            ) : (
              <ul className="flex flex-col gap-2 p-3">
                {/* Work owed first, and marked: a parent concern and a paper due
                    stay until done, so they lead the list and carry a tag. */}
                {noteItems.map((n) => {
                  const link = linkFor(n)
                  const family = notificationKind(n.kind).label
                  const urgent = n.pending
                  return (
                    <li key={n.id}
                      className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5',
                        urgent ? 'border-l-4 border-l-warning bg-warning/10' : cn('border-l-2', KIND_EDGE[family] ?? 'border-l-muted-foreground'))}>
                      <div className="min-w-0 flex-1">
                        {urgent && <Badge tone="warning" className="mb-1">Pending</Badge>}
                        <div className="flex items-baseline justify-between gap-2">
                          <p className={cn('min-w-0 truncate text-[14px]', n.read_at && !urgent ? 'font-medium' : 'font-semibold')}>{n.title}</p>
                          <span className="shrink-0 text-[12px] text-muted-foreground">{ago(n.created_at)}</span>
                        </div>
                        {n.body && <p className={cn('text-[13px] text-muted-foreground', viewing !== n.id && 'truncate')}>{n.body}</p>}
                      </div>
                      {/* View on every row: it opens the screen the notification is about, or,
                          where there is none, shows the whole message here. Viewed is gone
                          (owner, 2026-10-23: "after viewing don't show that message"), except
                          pending work, which stays until it is done. */}
                      <Button variant="secondary" size="sm" className="shrink-0"
                        onClick={() => {
                          const drop = () => {
                            if (urgent) return
                            void api.post(`/api/v1/portal/notifications/${n.id}/dismiss`, {})
                              .then(() => qc.invalidateQueries({ queryKey: ['notifications'] })).catch(() => {})
                          }
                          if (link) { drop(); navigate(link); return }
                          // Read in full here, and gone once closed.
                          if (viewing === n.id) { setViewing(null); drop(); return }
                          setViewing(n.id)
                          if (!n.read_at) void api.post(`/api/v1/portal/notifications/${n.id}/read`, {}).catch(() => {})
                        }}>
                        {!link && viewing === n.id ? 'Close' : 'View'}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </Card>
        {/* Apply for leave, the same width as the notifications above (Yajur, 2026-10-22). */}
        {leavePath && (
          <Card className="flex min-w-0 flex-row items-center justify-between gap-4 px-5 py-3.5">
            <div className="min-w-0">
              <h2 className="text-[16px] font-bold">Apply for leave</h2>
              <p className="text-[13px] text-muted-foreground">Ask for a day off or a half day, and see where your requests are.</p>
            </div>
            <Button size="sm" className="shrink-0" onClick={() => navigate(leavePath)}>
              <CalendarPlus className="h-3.5 w-3.5" /> Apply
            </Button>
          </Card>
        )}
        </div>
      </div>
    </div></PageBody>
  )
}
