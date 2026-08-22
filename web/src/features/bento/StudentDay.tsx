import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { formatPaise } from '@/lib/utils'
import { BentoError, BentoLoading, Meter, useFeatureHref } from './bento-kit'
import { DotStrip, Figure, PersonaPage, WhoCell, hhmm, useNowMinutes } from './persona-kit'
import { Widget } from './WidgetLayer'

/* The student's day, in the Bento language.

   RE-LAID-OUT, NOT RE-FETCHED. Every figure comes from the two endpoints the
   classic student home already reads: `/api/v1/portal/students` for who the
   record is about, and `/api/v1/portal/summary` for the day, the attendance,
   the homework and the balance. No handler was added and none was needed — a
   Bento cell is a second rendering of a figure the account may already see,
   and anything it may not see the API still refuses. A student's resolved
   scope is one record, so there is no other child's day this screen could
   show even if it asked for one, and it does not ask: no `student_id` is sent,
   because a student asked which of themselves they meant is a portal built for
   somebody else.

   THE ANCHOR is the timetable, because "which lesson is now and what is next"
   is the question a child opens this page to answer. It re-reads the clock
   every half minute, so it is still true at half past ten.

   ONE DARK CELL, and it is attendance — a proportion, whose shape is the
   point. Everything else is read as text and stays on a light ground. */

interface PortalChild {
  student_id: string
  admission_no: string
  full_name: string
  class_name?: string
  section_name?: string
  roll_no?: number
}
interface TodayPeriod {
  period: string
  starts_at?: string
  ends_at?: string
  subject: string
  teacher?: string
  room?: string
}
interface PortalSummary {
  student_id: string
  full_name: string
  attendance_pct: number
  present_days: number
  total_days: number
  absent_days: number
  homework_due: number
  next_homework_due?: string
  next_homework_title?: string
  outstanding_paise: number
  next_exam?: string
  today: TodayPeriod[]
}

/** Days from today to a yyyy-mm-dd. Negative is overdue. */
function daysUntil(iso: string) {
  return Math.round(
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  )
}

export default function StudentDay() {
  const t = useT()
  const now = useNowMinutes()

  // The cues, resolved against the catalogue rather than hard-coded, so a cell
  // never offers a screen this account cannot open.
  const toTimetable = useFeatureHref('student.timetable.timetable')
  const toAttendance = useFeatureHref('student.attendance.attendance')
  const toHomework = useFeatureHref('student.homework.homework_assignments')
  const toFees = useFeatureHref('student.fees.fees')

  const children = useQuery({
    queryKey: ['portal-students'],
    queryFn: () => api.get<List<PortalChild>>('/api/v1/portal/students'),
  })
  const summary = useQuery({
    queryKey: ['portal-summary', 'self'],
    queryFn: () => api.get<PortalSummary>('/api/v1/portal/summary'),
  })

  if (children.isLoading || summary.isLoading) {
    return <BentoLoading message={t('bento.student_day.loading')} />
  }
  /* A failed query is an error, never an empty state. "Nothing due today" read
     off a 500 is a sentence a child will act on by not doing the homework. */
  if (children.error || summary.error || !summary.data) {
    return <BentoError message={t('bento.student_day.failed')} />
  }

  const me = children.data?.items[0]
  const s = summary.data
  const form = [
    me?.class_name ? `${me.class_name}${me.section_name ? `-${me.section_name}` : ''}` : null,
    me?.roll_no ? t('bento.common.roll', { roll: me.roll_no }) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  /* Which lesson is now, and which is next. The list arrives ordered by period,
     so "now" is the one whose window contains the minute and "next" is the
     first that has not started. */
  const periods = s.today
  const idxNow = periods.findIndex((p) => {
    const a = hhmm(p.starts_at)
    const b = hhmm(p.ends_at)
    return a !== null && b !== null && now >= a && now < b
  })
  const idxNext = periods.findIndex((p) => {
    const a = hhmm(p.starts_at)
    return a !== null && a > now
  })
  const current = idxNow >= 0 ? periods[idxNow] : undefined
  const next = idxNext >= 0 ? periods[idxNext] : undefined
  const finished = periods.length > 0 && !current && !next

  const dots = periods.map((p, i) => {
    const ends = hhmm(p.ends_at)
    const past = ends !== null && ends <= now
    return {
      key: `${p.period}-${i}`,
      title: `${p.period} · ${p.subject}${p.starts_at ? ` · ${p.starts_at}` : ''} · ${
        i === idxNow
          ? t('bento.student_day.dot_now')
          : past
            ? t('bento.student_day.dot_done')
            : t('bento.student_day.dot_later')
      }`,
      className: i === idxNow ? 'bg-info' : past ? 'bg-muted-foreground/40' : 'bg-muted',
    }
  })

  const hwDays = s.next_homework_due ? daysUntil(s.next_homework_due) : undefined
  const homeworkNote =
    s.homework_due === 0
      ? t('bento.student_day.homework_none')
      : hwDays === undefined
        ? undefined
        : hwDays < 0
          ? t('bento.student_day.homework_overdue', { days: -hwDays })
          : hwDays === 0
            ? t('bento.student_day.homework_today')
            : t('bento.student_day.homework_days', { days: hwDays })

  return (
    <PersonaPage
      eyebrow={t('bento.student_day.eyebrow')}
      title={s.full_name}
      description={form || undefined}
      dashboard="student_day"
    >
      {/* THE ANCHOR — 2x2, and light, because it is read as words. */}
      <Widget id="now" label={t('bento.student_day.now_label')} size="large" index={0}>
        {(span) => (
      <WhoCell
        span={span}
        label={current ? t('bento.student_day.now_label') : t('bento.student_day.next_label')}
        to={toTimetable}
        cue={t('bento.student_day.now_cue')}
      >
        {periods.length === 0 ? (
          <Figure
            span={span}
            value={t('bento.student_day.no_lessons')}
            note={t('bento.student_day.no_lessons_note')}
          />
        ) : finished ? (
          <Figure
            span={span}
            value={t('bento.student_day.finished')}
            note={t('bento.student_day.finished_note', { count: periods.length })}
          />
        ) : (
          <>
            <p className="text-[40px] font-semibold leading-none">
              {(current ?? next)!.subject}
            </p>
            <p className="mt-2 text-[13.5px] text-secondary-foreground">
              {current
                ? t('bento.student_day.until', {
                    period: current.period,
                    ends: current.ends_at ?? '—',
                  })
                : t('bento.student_day.starts', {
                    period: next!.period,
                    at: next!.starts_at ?? '—',
                  })}
              {(current ?? next)!.room ? ` · ${(current ?? next)!.room}` : ''}
            </p>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              {current
                ? next
                  ? t('bento.student_day.then', {
                      subject: next.subject,
                      at: next.starts_at ?? '—',
                    })
                  : t('bento.student_day.last_lesson')
                : t('bento.student_day.not_started')}
            </p>
          </>
        )}
        {periods.length > 0 && (
          <DotStrip
            dots={dots}
            srLabel={t('bento.student_day.strip_sr', { count: periods.length })}
          />
        )}
      </WhoCell>
        )}
      </Widget>

      {/* THE ONE DARK CELL — attendance, whose point is the proportion. The
          meter is left on a light cell instead: --success was darkened for a
          light card and would sink into this ground, so the figure carries it
          here and the bar lives on the absence cell below. */}
      <Widget id="attendance" label={t('bento.student_day.attendance')} size="small" index={1}>
        {(span) => (
      <WhoCell
        dark
        span={span}
        label={t('bento.student_day.attendance')}
        to={toAttendance}
        cue={t('bento.student_day.attendance_cue')}
      >
        <Figure
          dark
          value={`${s.attendance_pct}%`}
          note={t('bento.student_day.attendance_note', {
            present: s.present_days,
            total: s.total_days,
          })}
        />
      </WhoCell>
        )}
      </Widget>

      <Widget id="homework" label={t('bento.student_day.homework')} size="small" index={2}>
        {(span) => (
      <WhoCell
        span={span}
        label={t('bento.student_day.homework')}
        to={toHomework}
        cue={t('bento.student_day.homework_cue')}
      >
        <Figure value={s.homework_due} note={homeworkNote} />
      </WhoCell>
        )}
      </Widget>

      <Widget id="fees" label={t('bento.student_day.fees')} size="small" index={3}>
        {(span) => (
      <WhoCell
        span={span}
        label={t('bento.student_day.fees')}
        to={toFees}
        cue={t('bento.student_day.fees_cue')}
      >
        <Figure
          value={formatPaise(s.outstanding_paise)}
          note={
            s.outstanding_paise > 0
              ? t('bento.student_day.fees_owed')
              : t('bento.student_day.fees_settled')
          }
        />
      </WhoCell>
        )}
      </Widget>

      <Widget id="absent" label={t('bento.student_day.absent')} size="small" index={4}>
        {(span) => (
      <WhoCell
        span={span}
        label={t('bento.student_day.absent')}
        to={toAttendance}
        cue={t('bento.student_day.absent_cue')}
      >
        <Figure
          value={s.absent_days}
          note={t('bento.student_day.absent_note', { total: s.total_days })}
        />
        <div className="mt-3">
          <Meter
            value={s.present_days}
            total={s.total_days}
            tone={s.absent_days > 0 ? 'warning' : 'success'}
            srLabel={t('bento.student_day.absent_sr', {
              present: s.present_days,
              total: s.total_days,
            })}
          />
        </div>
      </WhoCell>
        )}
      </Widget>
    </PersonaPage>
  )
}
