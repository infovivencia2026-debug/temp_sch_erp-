import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CalendarCheck, BookMarked, Wallet, GraduationCap } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
   Button, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise, cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import ParentAttention from './ParentAttention'

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
  present: 'bg-success',
  late: 'bg-warning',
  absent: 'bg-destructive',
  half_day: 'bg-warning/60',
  leave: 'bg-muted-foreground/40',
  holiday: 'bg-border',
}

/** Days between today and a yyyy-mm-dd, in the reader's own words. */
/** Attendance grouped into months, newest last, each with its own count.
 *  Absence is a pattern — three Mondays running matters and three days across
 *  a term does not — and a pattern needs the calendar around it. */
function groupByMonth(days: { date: string; status: string }[]) {
  const out: { label: string; days: typeof days; present: number; absent: number; marked: number }[] = []
  for (const d of days) {
    const label = new Date(d.date + 'T00:00:00').toLocaleDateString('en-IN', {
      month: 'long', year: 'numeric',
    })
    let bucket = out.find((b) => b.label === label)
    if (!bucket) { bucket = { label, days: [], present: 0, absent: 0, marked: 0 }; out.push(bucket) }
    bucket.days.push(d)
    // Holidays are not attendance and must not drag the percentage down.
    if (d.status !== 'holiday') {
      bucket.marked++
      if (d.status === 'present' || d.status === 'late') bucket.present++
      if (d.status === 'absent') bucket.absent++
    }
  }
  return out
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

function MonthGrid({ days }: { days: AttendanceDay[] }) {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const first = new Date(days[0].date + 'T00:00:00')
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

  return (
    <div className="mt-2">
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="pb-1 text-[10px] font-medium uppercase text-muted-foreground">
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`pad-${i}`} />
          const d = byDate.get(iso(day))
          const status = d?.status || undefined
          const marked = status && status !== 'holiday'
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
              ].filter(Boolean).join(' — ')}
              className={cn(
                'relative flex h-7 items-center justify-center rounded text-[11px] tabular-nums',
                // The number stays legible on every ground: white on the solid
                // statuses, ordinary text on the pale ones and on a blank day.
                status ? DOT[status] ?? 'bg-muted' : 'text-muted-foreground',
                marked && (status === 'present' || status === 'absent')
                  ? 'font-medium text-white'
                  : status ? 'text-foreground' : '',
              )}
            >
              {day}
              {/* A day with something written against it — a holiday, a
                  reason, an approved leave — carries a mark, or the tooltip
                  is a secret only the curious find. */}
              {(d?.label || d?.on_leave) && (
                <span className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-current opacity-70" />
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
              <span className="w-10 shrink-0 tabular-nums">
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
export default function Portal() {
  const t = useT()
  const [selected, setSelected] = useState<string | null>(null)
  /* One component serves the dashboard and the attendance register.

     The attendance page is asked one question — how often has this child been
     here — and a timetable underneath it answers a different one. The route
     is what distinguishes them; the component has no other way to know which
     of its two callers it is. */
  const { sectionSlug } = useParams()
  const isAttendance = sectionSlug === 'attendance'

  const children = useQuery({
    queryKey: ['portal-students'],
    queryFn: () => api.get<List<PortalChild>>('/api/v1/portal/students'),
  })

  const activeId = selected ?? children.data?.items[0]?.student_id ?? null

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

  if (children.isLoading) return <Loading />
  if (children.error) return <ErrorState error={children.error} />

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
          kids.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {kids.map((c) => (
                <Button
                  key={c.student_id}
                  size="sm"
                  variant={c.student_id === activeId ? 'ink' : 'outline'}
                  onClick={() => setSelected(c.student_id)}
                >
                  {c.full_name.split(' ')[0]}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      />
      <PageBody>
        {/* One dashboard rather than three tabs of it. What needs attention
            comes first: an unpaid fee or an absence to explain is the reason a
            parent opened the application at all, and making them find it on a
            second screen is how it goes unread. */}
        {!isAttendance && <ParentAttention />}
        {summary.isLoading ? (
          <Loading />
        ) : summary.error ? (
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
            {/* Three across, not four.

                Six figures in a four-wide grid leaves two empty cells, and an
                empty cell in a bordered grid does not read as spare room — it
                reads as a card that failed to load. Three across fills two
                rows exactly. */}
            <CellGrid cols={3}>
              <Stat
                label={t('portal.portal.stat_attendance')}
                value={`${s.attendance_pct}%`}
                icon={CalendarCheck}
                delta={{ value: t('portal.portal.stat_attendance_delta', { count: s.total_days }), positive: s.attendance_pct >= 75 }}
              />
              <Stat label={t('portal.portal.stat_present')} value={t('portal.portal.stat_days', { count: s.present_days })} />
              <Stat label={t('portal.portal.stat_absent')} value={t('portal.portal.stat_days', { count: s.absent_days })} />
              {/* The attendance page is asked one question and should answer
                  that one. Homework, fees and the next exam are the
                  dashboard's business; here they are three numbers a family
                  has to read past to find the one they came for. */}
              {!isAttendance && (
              <>
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
              />
              <Stat
                label={t('portal.portal.stat_fees')}
                value={formatPaise(s.outstanding_paise)}
                icon={Wallet}
                hint={s.outstanding_paise ? t('portal.portal.fees_payable') : t('portal.portal.fees_settled')}
              />
              {/* A result that exists beats an exam that is coming.

                  This card read "Next exam: Formative Assessment 1" while that
                  exam's marks were in and its report card was published — it
                  was answering a question the family had stopped asking three
                  days earlier. Once results are out, the card shows them; the
                  next exam comes back the moment one is scheduled and no newer
                  result has been released. */}
              {s.latest_result_pct != null ? (
                <Stat
                  label="Latest result"
                  value={`${s.latest_result_pct.toFixed(1)}%`}
                  icon={GraduationCap}
                  hint={[s.latest_result_exam, s.latest_result_grade && `grade ${s.latest_result_grade}`]
                    .filter(Boolean).join(' · ')}
                />
              ) : (
                <Stat label={t('portal.portal.stat_next_exam')} value={s.next_exam ?? '—'} icon={GraduationCap} />
              )}
              </>
              )}
            </CellGrid>

            {!isAttendance && (
            <Card>
              <CardHeader
                title={t('portal.portal.today_title')}
                description={
                  s.today.length
                    ? t('portal.portal.today_description')
                    : t('portal.portal.today_none_description')
                }
              />
              {s.today.length === 0 ? (
                <EmptyState
                  title={t('portal.portal.today_empty_title')}
                  body={t('portal.portal.today_empty_body')}
                />
              ) : (
                <ul className="divide-y">
                  {s.today.map((c, i) => (
                    <li key={`${c.period}-${i}`} className="flex flex-wrap items-baseline gap-3 px-4 py-2.5">
                      {/* A period is one time, not two lines.

                          96px of monospace holds "09:00–09:45" only just, and
                          overflow-wrap:anywhere — which stops a long email
                          address shoving a card sideways — was happy to break
                          it at the dash. A clock reading is not a word. */}
                      <span className="w-28 shrink-0 whitespace-nowrap font-mono text-[13px] tabular-nums text-muted-foreground">
                        {c.starts_at ?? '—'}
                        {c.ends_at ? `–${c.ends_at}` : ''}
                      </span>
                      <span className="min-w-[8rem] flex-1 font-medium">{c.subject}</span>
                      <span className="text-[13px] text-muted-foreground">
                        {c.period}
                        {c.teacher ? ` · ${c.teacher}` : ''}
                        {c.room ? ` · ${c.room}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            )}


            <Card>
              <CardHeader
                title={t('portal.portal.history_title')}
                description={t('portal.portal.history_description')}
              />
              <div className="p-5">
                {!days.length ? (
                  <p className="py-6 text-center text-[14px] text-muted-foreground">
                    {t('portal.portal.history_empty')}
                  </p>
                ) : (
                  <>
                    {/* Grouped by month with a running count, rather than one
                        undated row of squares. A parent looking at this is
                        asking "how bad was it, and when" — a flat strip
                        answers neither without hovering every square. */}
                    <div className="space-y-4">
                      {/* Newest month first: a parent opening this in August
                          is asking about August, and scrolling past March to
                          reach it is the wrong way round. */}
                      {groupByMonth(days).slice().reverse().map((m) => (
                        <div key={m.label}>
                          <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                            <p className="text-[13px] font-medium">{m.label}</p>
                            <p className="text-[12px] text-muted-foreground tabular-nums">
                              {m.present}/{m.marked} present
                              {m.absent > 0 && ` · ${m.absent} absent`}
                              {m.marked > 0 && ` · ${Math.round((m.present / m.marked) * 100)}%`}
                            </p>
                          </div>
                          <MonthGrid days={m.days} />
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3 text-[12px] text-muted-foreground">
                      {Object.entries(DOT).map(([k, cls]) => (
                        <span key={k} className="inline-flex items-center gap-1.5">
                          <span className={cn('h-2.5 w-2.5 rounded-sm', cls)} />
                          {k.replace('_', ' ')}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
