import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { PickerMenu } from '@/components/PickerMenu'
import { CalendarCheck, BookMarked, Wallet, GraduationCap, ArrowRight } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, SkeletonTiles, ErrorState,
  EmptyState, Button,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { ChildSwitch } from './ChildSwitch'
import { formatPaise, cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import WeeklyNoteCard from '@/components/ai/WeeklyNoteCard'

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
}
interface TodayPeriod {
  period: string; starts_at?: string; ends_at?: string
  subject: string; teacher?: string; room?: string
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
  present: 'bg-[#dcfce7] border-[#86efac]',
  late: 'bg-[#fef3c7] border-[#fcd34d]',
  absent: 'bg-[#fee2e2] border-[#fca5a5]',
  half_day: 'bg-[#ffedd5] border-[#fdba74]',
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
  const named = days
    .filter((d) => d.label)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))

  const iso = (day: number) =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  /* Held to a calendar's width.

     The grid filled whatever the card gave it, so on a desktop each day became
     a bar four inches wide and the month read as a bar chart of nothing. A
     month is a small object; it should look like one. */
  return (
    <div className={large ? 'mt-1' : 'mt-2 max-w-[22rem]'}>
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
                status ? DOT[status] ?? 'bg-muted' : sunday ? 'bg-border text-muted-foreground' : 'text-muted-foreground',
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

function Legend() {
  return (
    <div className="flex flex-wrap gap-3 text-[12px] text-muted-foreground">
      {Object.entries(DOT).filter(([k]) => k !== 'leave').map(([k, cls]) => (
        <span key={k} className="inline-flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-sm', cls)} />
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
    const start = earliest < elevenBack ? elevenBack : earliest
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
    <div className="rounded-xl border bg-card px-4 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('text-[19px] font-bold tabular-nums', tone)}>{value}</div>
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
        <PickerMenu
          value={ym}
          ariaLabel="Month"
          align="end"
          onChange={setPicked}
          options={months.map((x) => ({ value: x, label: x === currentYm ? `${monthName(x)} · this month` : monthName(x) }))}
        />
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
function submissionLeft(iso: string) {
  const days = Math.round(
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  )
  if (days < 0) return `${-days} ${-days === 1 ? 'day' : 'days'} overdue`
  if (days === 0) return 'Submission due today'
  if (days === 1) return '1 day left to submit'
  return `${days} days left to submit`
}

/* Anything inside two days is tonight's problem rather than next week's, and
   that is the whole reason the deadline sits next to the count. */
function isUrgent(iso: string) {
  return (
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000 <= 2
  )
}

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

export default function Portal() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(
    () => params.get('student_id') ?? rememberedChild(),
  )
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

  const attendance = useQuery({
    queryKey: ['portal-attendance', activeId],
    // The child must be named explicitly: the endpoint defaults to the first
    // linked student, so omitting it made the switcher change nothing.
    queryFn: () =>
      api.get<List<AttendanceDay>>(`/api/v1/portal/attendance?student_id=${activeId}`),
    enabled: !!activeId,
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
  const month = monthFacts(days, thisMonth())
  /* Each figure opens its own screen, in whichever workspace this is (parent or student). */
  const role = location.pathname.split('/')[1] || 'parent'
  const go = (rest: string) => () => navigate(`/${role}/${rest}${activeId ? `?student_id=${activeId}` : ''}`)
  const hhmm = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
  const nowPeriod = s?.today.find((c) => c.starts_at && c.ends_at && c.starts_at <= hhmm && hhmm < c.ends_at)

  return (
    <>
      <PageHead
        eyebrow={t('portal.portal.eyebrow')}
        title={s?.full_name ?? t('portal.portal.title')}
        /* Class, section and roll number under the name. It is how a parent
           recognises their own child on a class list and what the office asks
           for on the telephone, and it was the one thing this page did not
           say. */
        description={childLine(kids.find((c) => c.student_id === activeId)) ?? t('portal.portal.description')}
        actions={
          /* The same control the home board uses, so the switcher is one
             thing across the parent's screens: pills on a desk, one small
             "Switch child" button on a phone. Only a guardian of several
             ever sees it. */
          <ChildSwitch
            kids={kids}
            activeId={activeId}
            onChoose={chooseChild}
            label={t('portal.portal.title')}
            switchLabel={t('bento.parent_week.switch_child')}
          />
        }
      />
      <Freshness query={summary} />
      <PageBody>
        {/* The weekly AI note about this child, once one has been written. */}
        {activeId && <WeeklyNoteCard studentId={activeId} />}
        {/* One dashboard rather than three tabs of it. What needs attention
            comes first: an unpaid fee or an absence to explain is the reason a
            parent opened the application at all, and making them find it on a
            second screen is how it goes unread. */}
        {/* The shell already draws "Needs your attention" above every page,
            so drawing it again here gave a parent the same two rows twice on
            one screen — the second copy reading as a different list until you
            compared them line by line. */}
        {/* ONCE THERE ARE FIGURES, THEY STAY ON SCREEN.

            This was `summary.isLoading`, which is true again for every reload
            of the query, not only the first -- so each refresh tore the report
            down to a skeleton and built it back. That is the blinking: the
            page flashing grey and filling in, over and over, with nothing
            wrong and nothing changing.

            It also lost the month. AttendanceReport holds the chosen month in
            its own state, and a component that unmounts does not hold
            anything: every reload put a parent back on the current month a
            moment after they had picked another, which reads exactly like a
            picker that does not work.

            So the skeleton is for the first load only -- when there is nothing
            to show yet. A reload keeps the figures up while it runs, and the
            freshness line says one is in flight. */}
        {summary.isLoading && !summary.data ? (
          <SkeletonTiles count={5} />
        ) : summary.error && !summary.data ? (
          /* `!s` used to fall through to the spinner, so a summary that came
             back 403 or 500 left a parent watching "Loading…" for the rest of
             the session. The failure has a message; show it. */
          <ErrorState error={summary.error} />
        ) : !s ? (
          <EmptyState
            title={t('portal.portal.empty_title')}
            body={t('portal.portal.empty_body')}
          />
        ) : (
          <>
            {isAttendance ? (
              <AttendanceReport days={days} childLabel={[s.full_name, childLine(kids.find((c) => c.student_id === activeId))].filter(Boolean).join(' · ')} />
            ) : (
            <>
            {/* THE PARENT'S HOME: four figures, each opening its own screen,
                then today's classes beside what needs paying and this month's
                attendance. On a phone the column that needs action comes first. */}
            <CellGrid cols={4}>
              <Stat
                label={t('portal.portal.stat_attendance')}
                value={`${s.attendance_pct}%`}
                icon={CalendarCheck}
                delta={{ value: `${s.present_days} of ${s.total_days} days attended`, positive: s.attendance_pct >= 75 }}
                onClick={go('attendance/attendance')}
              />
              <Stat
                label={t('portal.portal.stat_homework')}
                value={t('portal.portal.stat_homework_value', { count: s.homework_due })}
                icon={BookMarked}
                delta={
                  s.homework_due === 0
                    ? { value: t('portal.portal.homework_none'), positive: true }
                    : s.next_homework_due
                      ? { value: submissionLeft(s.next_homework_due), positive: !isUrgent(s.next_homework_due) }
                      : undefined
                }
                hint={s.homework_due > 0 ? s.next_homework_title : undefined}
                onClick={go('academics/homework_academics')}
              />
              {s.latest_result_pct != null ? (
                <Stat
                  label="Latest result"
                  value={`${s.latest_result_pct.toFixed(1)}%`}
                  icon={GraduationCap}
                  hint={[s.latest_result_grade && `Grade ${s.latest_result_grade}`, s.latest_result_exam].filter(Boolean).join(' · ')}
                  onClick={go('academics/results_report_cards')}
                />
              ) : (
                <Stat label={t('portal.portal.stat_next_exam')} value={s.next_exam ?? '-'} icon={GraduationCap} />
              )}
              <Stat
                label={t('portal.portal.stat_fees')}
                value={formatPaise(s.outstanding_paise)}
                icon={Wallet}
                hint={s.outstanding_paise ? t('portal.portal.fees_payable') : t('portal.portal.fees_settled')}
                onClick={go('fees/fees_payments')}
              />
            </CellGrid>

            <div className="grid items-start gap-6 lg:grid-cols-[1fr_380px]">
              <div className="order-2 lg:order-1">
                <Card>
                  <CardHeader
                    title={t('portal.portal.today_title')}
                    description={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })}
                    action={nowPeriod ? <span className="rounded-full bg-primary/10 px-3 py-1 text-[12px] font-semibold text-primary">{nowPeriod.period} in progress</span> : undefined}
                  />
                  {s.today.length === 0 ? (
                    <EmptyState title={t('portal.portal.today_empty_title')} body={t('portal.portal.today_empty_body')} />
                  ) : (
                    <ul className="space-y-2 p-4">
                      {s.today.map((c, i) => {
                        const live = nowPeriod === c
                        return (
                          <li key={`${c.period}-${i}`}
                            className={cn('flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3',
                              live ? 'border-primary/40 bg-primary/10' : 'border-transparent bg-muted/50')}>
                            <span className={cn('w-28 shrink-0 whitespace-nowrap text-[12.5px] font-semibold tabular-nums', live ? 'text-primary' : 'text-muted-foreground')}>
                              {c.starts_at ?? '-'}{c.ends_at ? `–${c.ends_at}` : ''}
                            </span>
                            <span className="min-w-[8rem] flex-1 text-[14px] font-semibold">{c.subject}</span>
                            <span className="text-[12.5px] text-muted-foreground">
                              {c.period}{c.teacher ? ` · ${c.teacher}` : ''}{c.room ? ` · ${c.room}` : ''}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </Card>
              </div>

              <div className="order-1 space-y-6 lg:order-2">
                {s.outstanding_paise > 0 && (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                    <div className="min-w-0">
                      <div className="text-[15px] font-bold text-destructive">{formatPaise(s.outstanding_paise)} due</div>
                      <div className="text-[12.5px] text-muted-foreground">{t('portal.portal.fees_payable')}</div>
                    </div>
                    <Button onClick={go('fees/fees_payments')}>Pay now <ArrowRight className="h-3.5 w-3.5" /></Button>
                  </div>
                )}
                <Card>
                  <CardHeader
                    title={monthName(thisMonth())}
                    action={month.pct !== null ? (
                      <span className={cn('text-[12.5px] font-semibold', month.pct >= 75 ? 'text-success' : 'text-destructive')}>{month.pct}% present</span>
                    ) : undefined}
                  />
                  <div className="px-5 pb-4">
                    <MonthGrid days={month.monthDays} ym={thisMonth()} />
                    <div className="mt-3"><Legend /></div>
                    <button type="button" onClick={go('attendance/attendance')}
                      className="mt-3 text-[12.5px] font-medium text-primary hover:underline">
                      Full attendance report
                    </button>
                  </div>
                </Card>
              </div>
            </div>
            </>
            )}
          </>
        )}
      </PageBody>
    </>
  )
}
