import { useCallback, useEffect, useState } from 'react'
import JoinActivities from './JoinActivities'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PickerMenu } from '@/components/PickerMenu'
import { CalendarCheck, Wallet, Bell, FileText, CalendarDays, Users, Info, Check } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CellGrid, Stat, SkeletonTiles, ErrorState,
  EmptyState, Button,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { ScreenSkeleton } from './screen-state'
import { formatPaise, formatDate, cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import type { UseQueryResult } from '@tanstack/react-query'
import WeeklyNoteCard from '@/components/ai/WeeklyNoteCard'
import { SegToggle } from '@/components/SegToggle'
import { useChildProfile, useParentYear } from './parent-child'
import { ParentChildCard, SubjectCards } from './ParentChildCard'

interface PortalChild {
  student_id: string; admission_no: string; full_name: string
  class_name?: string; section_name?: string; roll_no?: number; relation?: string
}
interface PortalSummary {
  student_id: string; full_name: string
  attendance_pct: number; present_days: number; total_days: number; absent_days: number
  homework_due: number; next_homework_due?: string; next_homework_title?: string
  outstanding_paise: number; next_exam?: string
  latest_result_exam?: string; latest_result_pct?: number; latest_result_grade?: string
  today: TodayPeriod[]
  next_day?: { weekday: number; periods: TodayPeriod[] }
}
interface TodayPeriod {
  period: string; starts_at?: string; ends_at?: string
  subject: string; teacher?: string; room?: string
  is_break?: boolean
}
interface SchoolMessage {
  id: string
  title: string
  kind?: string
  body?: string
  published_at: string
  published_by?: string
  requires_ack: boolean
  acknowledged_by_me?: boolean
}
/** A bell entry, as /portal/notifications returns it; fee reminders and attendance messages reach the home through it. */
interface FamilyNote {
  id: string
  kind: string
  title: string
  body?: string
  link?: string
  created_at: string
}
interface AttendanceDay {
  date: string
  status: string
  /* Why the day was what it was. "Absent" and "Republic Day" are the same
     coloured square without it, and a parent reading a row of red has no way
     to tell a missed morning from a national holiday. */
  label?: string
  kind?: string
  on_leave?: boolean
}

const DOT: Record<string, string> = {
  /* Light tints: the owner found the solid forest green ugly. */
  present: 'bg-[#dcfce7] border-[#86efac] dark:bg-[#14532d] dark:border-[#22c55e] dark:text-[#dcfce7]',
  late: 'bg-[#fef3c7] border-[#fcd34d] dark:bg-[#713f12] dark:border-[#eab308] dark:text-[#fef3c7]',
  absent: 'bg-[#fee2e2] border-[#fca5a5] dark:bg-[#7f1d1d] dark:border-[#ef4444] dark:text-[#fee2e2]',
  half_day: 'bg-[#ffedd5] border-[#fdba74] dark:bg-[#7c2d12] dark:border-[#f97316] dark:text-[#ffedd5]',
  leave: 'bg-muted-foreground/40',
  holiday: 'bg-border',
}

/* One month, drawn as the month.

   A row of coloured dots says how many days were missed and never which ones.
   A parent reading it cannot tell a Monday from a Friday, cannot see that the
   two absences were the two days either side of a weekend, and cannot answer
   the question they actually opened the app with — "was he in on the 14th?"

   So: the calendar the dates already live in. Weekday columns, the month's
   real shape, and a day nobody marked left blank rather than coloured, because
   an unmarked day is not a present one and colouring it would quietly inflate
   the term.
*/
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

function MonthGrid({ days, ym, large = false }: { days: AttendanceDay[]; ym: string; large?: boolean }) {
  const byDate = new Map(days.map((d) => [d.date, d]))
  /* The month is named by the caller (YYYY-MM), not inferred from the first
     marked day: the current month at the start of term has no marks yet and
     must still draw as itself, empty, rather than not at all. */
  const first = new Date(ym + '-01T00:00:00')
  const year = first.getFullYear()
  const month = first.getMonth()
  const lastDay = new Date(year, month + 1, 0).getDate()

  /* Monday first, which is how a school week is read and printed here.
     getDay() counts from Sunday, so Sunday's 0 becomes the seventh column
     rather than the first. */
  const lead = (new Date(year, month, 1).getDay() + 6) % 7

  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: lastDay }, (_, i) => i + 1),
  ]

  /* Only the days worth naming, oldest first — a list in calendar order reads
     as the month, and one in fetch order reads as noise. */
  /* Today only (Yajur, 2026-10-24: "only show current days"): the month's
     whole list ran down the screen; the rest is on each day's tooltip. */
  const now = new Date()
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const named = days.filter((d) => d.label && d.date === todayIso)

  const iso = (day: number) =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  /* Held to a calendar's width.

     The grid filled whatever the card gave it, so on a desktop each day became
     a bar four inches wide and the month read as a bar chart of nothing. A
     month is a small object; it should look like one. */
  return (
    <div className={large ? 'mt-1' : 'mt-2'}>
      <div className={cn('grid grid-cols-7 text-center', large ? 'gap-1.5' : 'gap-1')}>
        {/* 11px, not 10. The cells below are 46px square and had room to
            spare; the header naming them was the smallest text on the parent's
            screen, set in tracked capitals at 10px in a muted grey. Nothing
            was gained by the extra pixel it saved. */}
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="pb-1 text-[11px] font-medium uppercase text-muted-foreground">
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`pad-${i}`} />
          const d = byDate.get(iso(day))
          const status = d?.status || undefined
          /* A Sunday nobody marked is a day the school is shut, and the key says so. */
          const sunday = !status && new Date(year, month, day).getDay() === 0
          return (
            <div
              key={day}
              title={[
                iso(day),
                status && status.replace('_', ' '),
                d?.label,
                // Said explicitly: a day the school approved is not the same
                // as a day somebody simply did not turn up.
                d?.on_leave && status !== 'leave' ? 'leave approved' : null,
              ].filter(Boolean).join(' · ')}
              className={cn(
                'relative flex items-center justify-center tabular-nums',
                /* The report fits one screen on a computer: fixed-height days
                   rather than squares as wide as the column. */
                large ? 'h-11 rounded-lg border text-[14px] font-medium' : 'aspect-square rounded text-[11px]',
                // The number stays legible on every ground: white on the solid
                // statuses, ordinary text on the pale ones and on a blank day.
                status ? DOT[status] ?? 'bg-muted' : sunday ? 'bg-border text-secondary-foreground' : 'text-muted-foreground',
                status === 'present' ? 'font-semibold text-[#15803d]'
                  : status === 'absent' ? 'font-semibold text-[#b91c1c]'
                  : status === 'late' || status === 'half_day' ? 'font-semibold text-[#b45309]'
                  : status ? 'text-foreground' : '',
              )}
            >
              {day}
              {/* A day with something written against it — a holiday, a
                  reason, an approved leave — carries a mark, or the tooltip
                  is a secret only the curious find. */}
              {(d?.label || d?.on_leave) && (
                <span className="absolute bottom-0.5 left-1/2 h-[2px] w-2.5 -translate-x-1/2 rounded-sm bg-current opacity-70" />
              )}
            </div>
          )
        })}
      </div>
      {/* The named days, spelled out.

          A tooltip is for confirming something you already suspect; a parent
          scanning the month wants to read "14 Aug — Independence Day" without
          hunting for it with a mouse they may not have. */}
      {named.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {named.map((d) => (
            <li key={d.date} className="flex gap-2 text-[12px] text-muted-foreground">
              {/* Wide enough for "31 Aug" on one line. At w-10 the month
                  wrapped under the date and every entry took two lines. */}
              <span className="w-14 shrink-0 whitespace-nowrap tabular-nums">
                {Number(d.date.slice(8, 10))} {first.toLocaleDateString('en-IN', { month: 'short' })}
              </span>
              <span className="min-w-0 flex-1">
                {d.label}
                {d.on_leave && d.status !== 'leave' && ' · leave approved'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* THE MONTH A PARENT IS ASKING ABOUT, AND ONLY THAT ONE.

   Every month of the register used to stack on one page, newest first — so on
   the 3rd of a month the top of the screen was LAST month, full, and this
   month sat under it as a nearly empty grid. A parent read the wrong month
   before noticing. Now one month shows at a time, picked from a menu, and the
   default is the month it actually is: the current one, drawn even when it
   has no marks yet, because an empty current month is information ("nothing
   marked yet") and a missing one is a bug.

   The month's events sit with its attendance rather than on another screen:
   the holidays and the days with a reason are the days a family asks about,
   and MonthGrid already spells them out under the calendar. */
function monthFacts(days: AttendanceDay[], ym: string) {
  const monthDays = days.filter((d) => d.date.slice(0, 7) === ym)
  let marked = 0, present = 0, absent = 0, late = 0, holidays = 0
  for (const d of monthDays) {
    if (d.status === 'holiday') { holidays++; continue }
    marked++
    if (d.status === 'present' || d.status === 'late') present++
    if (d.status === 'late') late++
    if (d.status === 'absent') absent++
  }
  /* Sundays that are not already a marked holiday: days the school is shut. */
  const first = new Date(ym + '-01T00:00:00')
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const holidayDates = new Set(monthDays.filter((d) => d.status === 'holiday').map((d) => d.date))
  for (let day = 1; day <= last; day++) {
    const dt = new Date(first.getFullYear(), first.getMonth(), day)
    const iso = `${ym}-${String(day).padStart(2, '0')}`
    if (dt.getDay() === 0 && !holidayDates.has(iso)) holidays++
  }
  return { monthDays, marked, present, absent, late, holidays, pct: marked ? Math.round((present / marked) * 100) : null }
}

const thisMonth = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}
const monthName = (m: string) =>
  new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

/* Every month from the earliest mark to now, newest first, so the home's
   calendar can be flipped back through the term. An empty register still
   gives the current month, so the picker is never blank. */

/* A stronger edge on the key, so each colour reads at a glance. */
const KEY: Record<string, string> = {
  present: 'border-[#16a34a]',
  late: 'border-[#d97706]',
  absent: 'border-[#dc2626]',
  half_day: 'border-[#f97316]',
  holiday: 'border-muted-foreground/40',
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-[14px] font-medium text-foreground">
      {Object.entries(DOT).filter(([k]) => k !== 'leave').map(([k, cls]) => (
        <span key={k} className="inline-flex items-center gap-2">
          {/* The same tint and edge as the day it names, big enough to see. */}
          <span className={cn('h-4 w-4 rounded-full border-2', cls, KEY[k])} />
          {k === 'holiday' ? 'holiday / Sunday' : k.replace('_', ' ')}
        </span>
      ))}
    </div>
  )
}

/* THE ATTENDANCE PAGE: the month's figures beside the month itself, and the
   year so far, so a parent reads "was he in on the 14th" and "how is the year
   going" on one screen. */
function AttendanceReport({ days, childLabel }: { days: AttendanceDay[]; childLabel?: string }) {
  const currentYm = thisMonth()
  /* Every month from the earliest mark (or eleven months back, whichever is
     later) to now, marked or not: an empty month draws as an empty grid and
     says so, rather than vanishing from the picker. */
  const earliest = days.length ? days.map((d) => d.date.slice(0, 7)).sort()[0] : currentYm
  const elevenBack = (() => {
    const d = new Date(currentYm + '-01T00:00:00')
    d.setMonth(d.getMonth() - 11)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })()
  const months: string[] = []
  {
    /* Every month back to the first mark: a year picker in front of the
       month keeps the list short, so the eleven-month cap is not needed. */
    const start = earliest < currentYm ? earliest : elevenBack
    const [fy, fm] = start.split('-').map(Number)
    const [ty, tm] = currentYm.split('-').map(Number)
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (m = 1, y++) : m++) {
      months.push(`${y}-${String(m).padStart(2, '0')}`)
    }
    months.reverse()
  }
  const [picked, setPicked] = useState<string>(currentYm)
  const ym = months.includes(picked) ? picked : currentYm
  const m = monthFacts(days, ym)
  let yMarked = 0, yPresent = 0
  for (const d of days) {
    if (d.status === 'holiday') continue
    yMarked++
    if (d.status === 'present' || d.status === 'late') yPresent++
  }
  const yearPct = yMarked ? Math.round((yPresent / yMarked) * 100) : null
  const mini = (label: string, value: string, tone?: string) => (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-[22px] font-bold tabular-nums', tone)}>{value}</div>
    </div>
  )
  const days1 = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="text-[17px] font-bold">Attendance report</h2>
          {childLabel && <p className="text-[13px] text-muted-foreground">{childLabel}</p>}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">
        {/* The year first, once there is more than one: three years of
            months in one list was too long to scroll. */}
        {new Set(months.map((x) => x.slice(0, 4))).size > 1 && (
          <PickerMenu
            value={ym.slice(0, 4)}
            ariaLabel="Year"
            align="end"
            onChange={(y) => setPicked(months.find((x) => x.startsWith(y)) ?? ym)}
            options={[...new Set(months.map((x) => x.slice(0, 4)))].map((y) => ({ value: y, label: y }))}
          />
        )}
        <PickerMenu
          value={ym}
          ariaLabel="Month"
          align="end"
          onChange={setPicked}
          options={months.filter((x) => x.startsWith(ym.slice(0, 4))).map((x) => ({ value: x, label: x === currentYm ? `${monthName(x)} · this month` : monthName(x) }))}
        />
        </div>
      </div>
      <div className="grid gap-5 px-5 py-4 lg:grid-cols-[220px_1fr]">
        <div className="grid content-start grid-cols-2 gap-3 lg:grid-cols-1">
          {mini('Present', days1(m.present), 'text-[#16a34a]')}
          {mini('Absent', days1(m.absent), m.absent ? 'text-destructive' : undefined)}
          {mini('This month', m.pct === null ? '-' : `${m.pct}%`)}
          {mini('Year so far', yearPct === null ? '-' : `${yearPct}%`)}
          {mini('Holidays & Sundays', days1(m.holidays), 'text-muted-foreground')}
          {m.late > 0 && mini('Late', days1(m.late), 'text-warning')}
        </div>
        <div className="min-w-0">
          {m.marked === 0 && (
            <p className="mb-2 text-[13px] text-muted-foreground">
              {ym === currentYm ? 'Nothing marked yet this month.' : 'No school days marked this month.'}
            </p>
          )}
          <MonthGrid days={m.monthDays} ym={ym} large />
          <div className="mt-4 border-t pt-3"><Legend /></div>
        </div>
      </div>
    </Card>
  )
}

/** "Grade 6-A · Roll 14 · ADM0007" — blank parts drop out rather than leaving
 *  stray separators, because a child admitted last week genuinely has no roll
 *  number yet. */
function childLine(c?: PortalChild) {
  if (!c) return undefined
  const parts = [
    c.class_name ? `${c.class_name}${c.section_name ? `-${c.section_name}` : ''}` : null,
    c.roll_no ? `Roll ${c.roll_no}` : null,
    c.admission_no || null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

/* How long is left to hand it in.
 *
 * The card used to read "Soonest in 5 days", which names the deadline and
 * leaves the parent to do the subtraction — and the thing a parent is actually
 * deciding is whether tonight has to be spent on it. So it counts down, and
 * says "overdue" plainly when the moment has passed rather than dressing a
 * missed deadline as a date. */

/* Anything inside two days is tonight's problem rather than next week's, and
   that is the whole reason the deadline sits next to the count. */

/**
 * Shared by the student and parent portals. The difference is entirely in the
 * resolved scope: a student's set is one record, a guardian's is their
 * children — so a parent gets a switcher and a student does not.
 */
/* Which child the parent was last looking at.

   The choice cannot live in component state alone. A parent with two children
   leaves this screen for the fee page and comes back, or follows a link from a
   notification, and the switcher has quietly snapped back to the first child —
   so every visit starts by re-picking, and a bookmarked or shared link shows
   the wrong child's attendance. The URL carries it so a link means what it
   says; localStorage carries it so a fresh visit resumes where they were. */
const LAST_CHILD_KEY = 'portal-last-child'

function rememberedChild(): string | null {
  try {
    return localStorage.getItem(LAST_CHILD_KEY)
  } catch {
    return null
  }
}

/* MESSAGES FROM SCHOOL, on the home.
 *
 * The five most recent circulars, newest first, each opening the Communication
 * screen's circulars tab where it can be read and acknowledged. A notice still
 * waiting for this parent's acknowledgement is marked, because that is the one
 * thing the school needs them to do. */
/* What a notice is about, read from its kind and title, so each row carries
   a tinted line icon a parent can scan by (owner design, 2026-11-19). */
function messageLook(m: SchoolMessage): { icon: typeof Bell; tone: string } {
  const t = `${m.kind ?? ''} ${m.title}`.toLowerCase()
  if (/clos|holiday|urgent|alert|leave/.test(t)) return { icon: Bell, tone: 'bg-destructive/10 text-destructive' }
  if (/exam|test|result|report|date sheet|marks/.test(t)) return { icon: FileText, tone: 'bg-primary/10 text-primary' }
  if (/meeting|ptm|parent-teacher/.test(t)) return { icon: Users, tone: 'bg-success/10 text-success' }
  if (/event|day|function|celebrat|trip|sports/.test(t)) return { icon: CalendarDays, tone: 'bg-success/10 text-success' }
  return { icon: Info, tone: 'bg-muted text-muted-foreground' }
}

/* Short date, and no full stop closing a line (owner, 2026-11-19). */
const shortDate = (d: string) => formatDate(d).replace(/\s*\d{4}$/, '')
const noStop = (t: string) => t.replace(/\s+/g, ' ').trim().replace(/\.+$/, '')

/* MESSAGES FROM SCHOOL, on the home.
 *
 * Every notice the school has sent this family, newest first, each a raised
 * card with an icon for what it is about. A notice waiting for this parent's
 * acknowledgement carries the Acknowledge button right on the card. On a wide
 * screen the card is as tall as the calendar beside it and the list scrolls
 * inside, with no bar drawn. */
/* WHAT THE SCHOOL SENT, OF THREE KINDS (owner, 2026-11-20): circulars, fee
   reminders and attendance messages, newest first, each labelled, each opening
   its own screen. Fee and attendance messages are the family's bell entries. */
type HomeItem =
  | { key: string; type: 'Circular'; at: string; c: SchoolMessage }
  | { key: string; type: 'Fees' | 'Attendance'; at: string; n: FamilyNote; link: string }

function noteType(n: FamilyNote): 'Fees' | 'Attendance' | null {
  const k = (n.kind ?? '').toLowerCase()
  if (k.startsWith('fee')) return 'Fees'
  if (k.startsWith('attendance') || k.startsWith('absen') || (k === 'messaging.direct' && n.title === 'Attendance')) return 'Attendance'
  return null
}

interface TodayHomework { id: string; title: string; subject?: string; instructions?: string; due_on?: string; assigned_on: string; student_id?: string }

function SchoolMessages({ query, notes, onOpen, onGo, homework, onHomework }: {
  query: UseQueryResult<List<SchoolMessage>>
  notes: FamilyNote[]
  onOpen: () => void
  onGo: (link: string) => void
  /** Today's homework for the child on screen (the Homework side of the toggle). */
  homework: { items: TodayHomework[]; loading: boolean }
  onHomework: () => void
}) {
  const qc = useQueryClient()
  /* Announcements first; Homework is today's work, each with its subject
     (owner, 2026-11-26). The toggle is the sign-in page's segmented control. */
  const [tab, setTab] = useState<'news' | 'homework'>('news')
  const items: HomeItem[] = [
    ...(query.data?.items ?? []).map((c): HomeItem => ({ key: 'c' + c.id, type: 'Circular', at: c.published_at, c })),
    ...notes.flatMap((n): HomeItem[] => {
      const type = noteType(n)
      if (!type) return []
      return [{ key: 'n' + n.id, type, at: n.created_at, n, link: n.link || (type === 'Fees' ? '/parent/fees/fees_payments' : '/parent/attendance/attendance') }]
    }),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const rows = items
  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/communication/circulars/${id}/ack`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['circulars'] }),
  })
  return (
    <Card className="flex min-h-[440px] flex-col lg:h-full lg:min-h-[480px]">
      {/* The toggle is the card's heading (owner, 2026-11-26): no title, and
          nothing about the child in this card. Taller on wide screens so more
          messages show; the child card beside it stretches to match. */}
      <div className="flex justify-center border-b px-4 pb-4 pt-5">
        <SegToggle value={tab} onChange={setTab} ariaLabel="Announcements"
          className="max-w-[360px]"
          options={[{ value: 'news', label: 'Announcements' }, { value: 'homework', label: 'Homework' }]} />
      </div>
      {tab === 'homework' ? (
        homework.loading ? <SkeletonTiles count={2} /> : homework.items.length === 0 ? (
          <EmptyState title="No homework today" body="Nothing was set today." />
        ) : (
          <ul className="space-y-2.5 px-3 pb-3 pt-1">
            {homework.items.map((h) => (
              <li key={`${h.id}:${h.student_id ?? ''}`}>
                <button type="button" onClick={onHomework}
                  className="flex min-h-[56px] w-full items-start gap-3 rounded-xl border bg-card px-3.5 py-3 text-left shadow-sm transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-md">
                  <span className="mt-0.5 shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[12px] font-semibold text-primary">{h.subject ?? 'Homework'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold leading-snug">{noStop(h.title)}</span>
                    {h.instructions && <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-muted-foreground">{noStop(h.instructions)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : query.isLoading && !query.data ? (
        <SkeletonTiles count={3} />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing yet" body="No notices yet." />
      ) : (
        <ul className="scroll-x max-h-[32rem] min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-3 pt-1 lg:max-h-none">
          {rows.map((item) => {
            const c = item.type === 'Circular' ? item.c : null
            const title = c ? c.title : item.type !== 'Circular' ? item.n.title : ''
            const body = c ? (c.body || c.published_by || 'School office') : item.type !== 'Circular' ? (item.n.body ?? '') : ''
            const needsMe = !!c && c.requires_ack && !c.acknowledged_by_me
            const done = !!c && c.requires_ack && c.acknowledged_by_me
            const { icon: Icon, tone } = c ? messageLook(c)
              : item.type === 'Fees' ? { icon: Wallet, tone: 'bg-warning/10 text-warning' } : { icon: CalendarCheck, tone: 'bg-success/10 text-success' }
            const open = () => (item.type === 'Circular' ? onOpen() : onGo(item.link))
            return (
              <li key={item.key}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
                  className="group flex w-full cursor-pointer items-start gap-3 rounded-xl border bg-card px-3.5 py-3 text-left shadow-sm transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                >
                  <span className={cn('mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl', tone)}>
                    <Icon className="h-5 w-5" strokeWidth={2.2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold group-hover:text-primary">{noStop(title)}</span>
                      <span className="shrink-0 text-[12px] font-medium text-muted-foreground">{shortDate(item.at)}</span>
                    </div>
                    <span className="mt-0.5 inline-block rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{item.type}</span>
                    <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
                      <p className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug text-muted-foreground">
                        {noStop(body)}
                      </p>
                      {needsMe && (
                        <span className="shrink-0 self-start sm:self-auto" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="shrink-0 rounded-full border-warning/50 bg-warning/15 text-warning hover:bg-warning/25"
                          disabled={ack.isPending && ack.variables === c!.id}
                          onClick={() => ack.mutate(c!.id)}
                        >
                          Acknowledge
                        </Button>
                        </span>
                      )}
                      {done && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-[11.5px] font-semibold text-success">
                          <Check className="h-3.5 w-3.5" /> Acknowledged
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

export default function Portal() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(
    () => params.get('student_id') ?? rememberedChild(),
  )
  /* The month the home's calendar is showing. The attendance figure above it
     reads the same month, so flipping the calendar back a month moves the
     percentage with it (Yajur, 2026-11-19). */
  /* One component serves the dashboard and the attendance register.

     The attendance page is asked one question — how often has this child been
     here — and a timetable underneath it answers a different one. The route
     is what distinguishes them; the component has no other way to know which
     of its two callers it is. */
  const { sectionSlug } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const isAttendance = sectionSlug === 'attendance'

  const children = useQuery({
    queryKey: ['portal-students'],
    queryFn: () => api.get<List<PortalChild>>('/api/v1/portal/students'),
  })

  const kidIDs = children.data?.items.map((c) => c.student_id)
  /* A remembered id that is no longer one of this parent's children — a child
     who has left, or a link from somebody else's portal — falls back to the
     first rather than querying for a student the server will refuse. */
  const remembered = selected && kidIDs?.includes(selected) ? selected : null
  const activeId = remembered ?? children.data?.items[0]?.student_id ?? null

  const chooseChild = useCallback(
    (id: string) => {
      setSelected(id)
      try {
        localStorage.setItem(LAST_CHILD_KEY, id)
        sessionStorage.setItem('portal-child', id)
      } catch {
        /* private window or blocked storage; the URL still carries the choice */
      }
    },
    [],
  )

  // Keep the address bar on the child actually being shown, so the link a
  // parent copies opens on the same child. Replace, not push: switching child
  // is not a step to press Back through.
  useEffect(() => {
    if (!activeId || params.get('student_id') === activeId) return
    const next = new URLSearchParams(params)
    next.set('student_id', activeId)
    setParams(next, { replace: true })
  }, [activeId, params, setParams])

  const summary = useQuery({
    queryKey: ['portal-summary', activeId],
    queryFn: () =>
      api.get<PortalSummary>(`/api/v1/portal/summary${activeId ? `?student_id=${activeId}` : ''}`),
    enabled: !!activeId,
  })

  /* The child card and Academics (owner, 2026-11-26), for the year picked in
     the card; the attendance calendar follows it too (2026-11-28). */
  const [year, setYear] = useParentYear()
  const attendance = useQuery({
    queryKey: ['portal-attendance', activeId, year],
    // The child must be named explicitly: the endpoint defaults to the first
    // linked student, so omitting it made the switcher change nothing.
    queryFn: () =>
      api.get<List<AttendanceDay>>(`/api/v1/portal/attendance?student_id=${activeId}${year ? `&academic_year_id=${year}` : ''}`),
    enabled: !!activeId,
  })

  /* The school's notices, newest first, shown on the home in place of the
     day's timetable (Yajur, 2026-11-19): what the school has said is what a
     parent opens the app for, not a period list they already know. */
  const circulars = useQuery({
    queryKey: ['circulars'],
    queryFn: () => api.get<List<SchoolMessage>>('/api/v1/communication/circulars'),
  })
  /* Fee reminders and attendance messages, from the family's bell. */
  const schoolNotes = useQuery({
    queryKey: ['portal-school-notes', selected],
    queryFn: () => api.get<{ items: FamilyNote[] }>(`/api/v1/portal/notifications${selected ? `?student_id=${selected}` : ''}`),
  })

  const profile = useChildProfile(activeId, year)
  const homework = useQuery({
    queryKey: ['homework', 'diary', false],
    queryFn: () => api.get<List<TodayHomework>>('/api/v1/homework'),
    enabled: !isAttendance,
  })
  /* For the subject cards on a wide screen: each subject's notes and latest marks
     (same keys as the Subject page, so the two share what they fetched). */
  const materials = useQuery({
    queryKey: ['portal-resources', activeId],
    queryFn: () => api.get<List<{ id: string; subject?: string }>>(`/api/v1/portal/learning/resources?student_id=${activeId}`),
    enabled: !isAttendance && !!activeId,
  })
  const results = useQuery({
    queryKey: ['portal-results', activeId, year],
    queryFn: () => api.get<{ subjects: { exam: string; subject: string; marks_obtained?: number; max_marks?: number; is_absent: boolean }[] }>(`/api/v1/portal/results?student_id=${activeId}${year ? `&academic_year_id=${year}` : ''}`),
    enabled: !isAttendance && !!activeId,
  })

  if (children.isLoading && !children.data) return <ScreenSkeleton />
  if (children.error && !children.data) return <ScreenError error={children.error} />

  const kids = children.data?.items ?? []
  if (!kids.length) {
    return (
      <>
        <PageHead eyebrow={t('portal.portal.eyebrow')} title={t('portal.portal.title')} />
        <PageBody>
          <EmptyState
            title={t('portal.portal.no_link_title')}
            body={t('portal.portal.no_link_body')}
          />
        </PageBody>
      </>
    )
  }

  const s = summary.data
  const days = attendance.data?.items ?? []
  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const todayMark = days.find((d) => d.date === todayIso)
  const todayStatus = !todayMark ? 'Not marked'
    : todayMark.on_leave ? 'On leave'
      : todayMark.status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  const todayHomework = (homework.data?.items ?? [])
    .filter((h) => (!h.student_id || h.student_id === activeId) && h.assigned_on.slice(0, 10) === todayIso)
  const academicsHref = (extra: string) => `/${location.pathname.split('/')[1] || 'parent'}/academics/homework_academics?${extra}${activeId ? `&student_id=${activeId}` : ''}${year ? `&ay=${year}` : ''}`
  /* Each figure opens its own screen, in whichever workspace this is (parent or student). */
  const role = location.pathname.split('/')[1] || 'parent'
  const go = (rest: string) => () => navigate(`/${role}/${rest}${activeId ? `?student_id=${activeId}` : ''}`)

  const head = (
    <PageHead
      eyebrow={t('portal.portal.eyebrow')}
      title={s?.full_name ?? t('portal.portal.title')}
      titleAfter={
        kids.length > 1 ? (
          <PickerMenu
            value={activeId ?? ''}
            ariaLabel={t('bento.parent_week.switch_child')}
            align="start"
            onChange={chooseChild}
            options={kids.map((c) => ({ value: c.student_id, label: c.full_name }))}
          />
        ) : undefined
      }
      description={childLine(kids.find((c) => c.student_id === activeId)) ?? t('portal.portal.description')}
    />
  )

  /* THE ATTENDANCE REGISTER keeps its own heading, the child's name, and the
     month-by-month calendar. */
  if (isAttendance) {
    return (
      <>
        {head}
        <PageBody>
          {summary.isLoading && !summary.data ? <SkeletonTiles count={5} />
            : summary.error && !summary.data ? <ErrorState error={summary.error} />
              : !s ? <EmptyState title={t('portal.portal.empty_title')} body={t('portal.portal.empty_body')} />
                : <AttendanceReport days={days} childLabel={[s.full_name, childLine(kids.find((c) => c.student_id === activeId))].filter(Boolean).join(' · ')} />}
        </PageBody>
      </>
    )
  }

  /* THE PARENT'S HOME (owner, 2026-11-26): no greeting and no name heading.
     The child card (photo, class, joined, academic year, child switcher),
     then Fee outstanding and Today side by side, the school's messages with
     the Announcements / Homework toggle, and the child's subjects. The month
     calendar lives on the Attendance screen. */
  const subjects = profile.data?.subjects ?? []
  /* Nothing to read today (owner, 2026-11-28): no empty box, and Subjects
     takes its place (beside the child card on a wide screen). */
  const showMessages = circulars.isLoading || schoolNotes.isLoading || homework.isLoading || !!circulars.error
    || (circulars.data?.items.length ?? 0) > 0 || (schoolNotes.data?.items ?? []).some((n) => noteType(n)) || todayHomework.length > 0
  const subjectsBlock = subjects.length > 0 ? (
        <section aria-label="Subjects" className="space-y-3">
          <h2 className="text-[18px] font-bold">Subjects</h2>
          <SubjectCards subjects={subjects} hrefFor={(x) => academicsHref(`view=subject&cs=${x.class_subject_id}`)}
            stats={(x) => {
              const last = (results.data?.subjects ?? []).filter((m) => m.subject === x.subject && !m.is_absent && m.marks_obtained != null && m.max_marks).at(-1)
              return {
                homework: homework.isLoading ? '…' : todayHomework.filter((h) => h.subject === x.subject).length,
                notes: materials.isLoading ? '…' : (materials.data?.items ?? []).filter((m) => m.subject === x.subject).length,
                marks: last ? `${last.marks_obtained}/${last.max_marks}` : '–',
              }
            }} />
        </section>
  ) : null
  return (
    <PageBody top width="full">
      {/* Two columns on a wide screen, as the month calendar sat beside the
          messages: Fee + Today over the messages on the left, the child card
          the full height on the right. On a phone the child comes first. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className={cn('min-w-0 lg:order-2', showMessages ? 'lg:[&>*]:h-full' : 'lg:sticky lg:top-4 lg:self-start')}>
        <ParentChildCard profile={profile.data} kids={kids} activeId={activeId}
          onChild={chooseChild} year={year} onYear={setYear} loading={profile.isLoading}
          stats={(() => {
            const ym = todayIso.slice(0, 7)
            const month = days.filter((d) => d.date.startsWith(ym) && (d.status === 'present' || d.status === 'absent' || d.status === 'late'))
            const att = month.length ? `${Math.round(month.filter((d) => d.status !== 'absent').length / month.length * 100)}%` : '–'
            return [['Attendance', att], ['Subjects', subjects.length], ['Homework today', todayHomework.length]]
          })()} />
      </div>
      <div className="flex min-w-0 flex-col gap-4 md:gap-6 lg:order-1">
      {summary.error && !summary.data ? <ErrorState error={summary.error} /> : (
        <div className="parent-mini"><CellGrid cols={2}>
          <Stat
            label="Fee outstanding"
            value={s ? formatPaise(s.outstanding_paise) : '…'}
            icon={Wallet}
            hint={s ? (s.outstanding_paise ? t('portal.portal.fees_payable') : t('portal.portal.fees_settled')) : undefined}
            onClick={go('fees/fees_payments')}
          />
          <Stat
            label="Today"
            value={attendance.isLoading && !attendance.data ? '…' : todayStatus}
            icon={CalendarCheck}
            onClick={go('attendance/attendance')}
          />
        </CellGrid></div>
      )}
      {showMessages ? (
      <SchoolMessages
        query={circulars}
        notes={schoolNotes.data?.items ?? []}
        onGo={(link) => navigate(link + (activeId && !link.includes('?') ? `?student_id=${activeId}` : ''))}
        onOpen={() => navigate(`/${role}/communication/circulars_from_school${activeId ? `?student_id=${activeId}` : ''}`)}
        homework={{ items: todayHomework, loading: homework.isLoading }}
        onHomework={() => navigate(academicsHref(''))}
      />
      ) : subjectsBlock}
      </div>
      </div>
      {activeId && <WeeklyNoteCard studentId={activeId} />}
      {showMessages && subjectsBlock}
      <JoinActivities studentId={activeId ?? undefined} />
    </PageBody>
  )
}
