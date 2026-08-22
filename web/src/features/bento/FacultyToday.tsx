import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { BentoError, BentoLoading, Meter, useFeatureHref } from './bento-kit'
import { DotStrip, Figure, PersonaPage, WhoCell, hhmm, useNowMinutes } from './persona-kit'
import { Widget } from './WidgetLayer'

/* Today's classes, in the Bento language.

   SCOPE. Every figure is teacher-scoped by the server, not by this file:
   `/api/v1/teaching/today` filters on `teacher_user_id = the caller`,
   `/api/v1/teaching/classes` goes through the assigned-classes scope resolver,
   and `/api/v1/teaching/my-work` answers only for the signed-in teacher. A
   teacher sees the sections they teach and no others, and a UI that hid a
   section would not be what made that true.

   ON REUSING THE CLASSIC SCREEN'S QUERIES. There were none to reuse. The
   classic `faculty/TodaysClasses.tsx` renders a hard-coded day — "Math 10A",
   "Room 304", five invented pupils with invented attendance — and issues no
   request at all. So this file reads the three endpoints the rest of the
   faculty area already reads rather than inventing a fourth; no handler was
   added. It does mean the figures here will not match the placeholder beside
   them under the same key. These are the real ones.

   THE ANCHOR is the lesson happening now and whether its register is in,
   because that is what a teacher opens this page at 08:02 to find out. It
   re-reads the clock every half minute.

   ONE DARK CELL: registers marked out of the day's lessons. A proportion whose
   shape is the point, and the one number a head of year will ask about. */

interface TodayClass {
  entry_id: string
  section_id: string
  section_name: string
  class_name: string
  subject_name: string
  period_name: string
  starts_at: string
  ends_at: string
  room?: string
  attendance_marked: boolean
}
interface MyClass {
  section_id: string
  section_name: string
  class_name: string
  room?: string
  enrolled: number
  marked_today: boolean
}
interface WorkItem {
  kind: string
  count: number
  overdue: boolean
}
interface MyWorkView {
  items: WorkItem[]
  outstanding: number
  sections: number
}

const where = (c: TodayClass) => `${c.class_name}-${c.section_name}`

export default function FacultyToday() {
  const t = useT()
  const now = useNowMinutes()

  const toRegister = useFeatureHref('faculty.attendance.take_attendance')
  const toWork = useFeatureHref('faculty.home.my_work')
  const toClasses = useFeatureHref('faculty.my_classes.my_classes')
  const toTimetable = useFeatureHref('faculty.timetable.my_timetable')

  const today = useQuery({
    queryKey: ['teaching-today'],
    queryFn: () => api.get<List<TodayClass>>('/api/v1/teaching/today'),
  })
  const classes = useQuery({
    queryKey: ['teaching-classes'],
    queryFn: () => api.get<List<MyClass>>('/api/v1/teaching/classes'),
  })
  const work = useQuery({
    queryKey: ['my-work'],
    queryFn: () => api.get<MyWorkView>('/api/v1/teaching/my-work'),
  })

  if (today.isLoading || classes.isLoading || work.isLoading) {
    return <BentoLoading message={t('bento.faculty_today.loading')} />
  }
  /* "Nothing waiting on you" read off a failed request is worse than a blank
     page: it is a teacher told the registers are in when they are not. */
  if (today.error || classes.error || work.error || !work.data) {
    return <BentoError message={t('bento.faculty_today.failed')} />
  }

  const lessons = today.data?.items ?? []
  const mine = classes.data?.items ?? []
  const w = work.data

  const idxNow = lessons.findIndex((c) => {
    const a = hhmm(c.starts_at)
    const b = hhmm(c.ends_at)
    return a !== null && b !== null && now >= a && now < b
  })
  const idxNext = lessons.findIndex((c) => {
    const a = hhmm(c.starts_at)
    return a !== null && a > now
  })
  const current = idxNow >= 0 ? lessons[idxNow] : undefined
  const next = idxNext >= 0 ? lessons[idxNext] : undefined
  const focus = current ?? next
  const finished = lessons.length > 0 && !focus

  const marked = lessons.filter((c) => c.attendance_marked).length
  const unmarked = lessons.length - marked
  const enrolled = mine.reduce((n, c) => n + c.enrolled, 0)
  const overdue = w.items.filter((i) => i.overdue).length

  const dots = lessons.map((c, i) => {
    const ends = hhmm(c.ends_at)
    const past = ends !== null && ends <= now
    return {
      key: c.entry_id,
      title: `${c.period_name} · ${c.subject_name} · ${where(c)} · ${c.starts_at}–${c.ends_at} · ${
        c.attendance_marked
          ? t('bento.faculty_today.dot_marked')
          : t('bento.faculty_today.dot_unmarked')
      }`,
      className: c.attendance_marked
        ? 'bg-success'
        : i === idxNow
          ? 'bg-info'
          : past
            ? 'bg-warning'
            : 'bg-muted',
    }
  })

  return (
    <PersonaPage
      eyebrow={t('bento.faculty_today.eyebrow')}
      title={t('bento.faculty_today.title')}
      description={t('bento.faculty_today.description', { count: lessons.length })}
      dashboard="faculty_today"
    >
      {/* THE ANCHOR — 2x2, light, because it is read as words. */}
      <Widget id="now" label={t('bento.faculty_today.now_label')} size="large" index={0}>
        {(span) => (
      <WhoCell
        span={span}
        label={current ? t('bento.faculty_today.now_label') : t('bento.faculty_today.next_label')}
        to={toRegister}
        cue={t('bento.faculty_today.now_cue')}
      >
        {lessons.length === 0 ? (
          <Figure
            span={span}
            value={t('bento.faculty_today.no_lessons')}
            note={t('bento.faculty_today.no_lessons_note')}
          />
        ) : finished ? (
          <Figure
            span={span}
            value={t('bento.faculty_today.finished')}
            note={t('bento.faculty_today.finished_note', { marked, count: lessons.length })}
          />
        ) : (
          <>
            <p className="text-[40px] font-semibold leading-none">{focus!.subject_name}</p>
            <p className="mt-2 text-[13.5px] text-secondary-foreground">
              {where(focus!)}
              {focus!.room ? ` · ${focus!.room}` : ''}
            </p>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              {current
                ? t('bento.faculty_today.until', {
                    period: focus!.period_name,
                    ends: focus!.ends_at,
                  })
                : t('bento.faculty_today.starts', {
                    period: focus!.period_name,
                    at: focus!.starts_at,
                  })}
            </p>
            <p className="mt-2 text-[13.5px] font-medium">
              {focus!.attendance_marked
                ? t('bento.faculty_today.register_in')
                : t('bento.faculty_today.register_out')}
            </p>
          </>
        )}
        {lessons.length > 0 && (
          <DotStrip
            dots={dots}
            srLabel={t('bento.faculty_today.strip_sr', { marked, count: lessons.length })}
          />
        )}
      </WhoCell>
        )}
      </Widget>

      {/* THE ONE DARK CELL. Drawn in the inverted foreground pair only — the
          semantic tokens were darkened against a light card and would sink
          into this ground — so the meter that belongs with it sits on the
          light lessons cell instead and this one carries the figure. */}
      <Widget id="marked" label={t('bento.faculty_today.marked_label')} size="small" index={1}>
        {(span) => (
      <WhoCell
        dark
        span={span}
        label={t('bento.faculty_today.marked_label')}
        to={toRegister}
        cue={t('bento.faculty_today.marked_cue')}
      >
        <Figure
          dark
          value={`${marked}/${lessons.length}`}
          note={
            unmarked === 0
              ? t('bento.faculty_today.marked_all')
              : t('bento.faculty_today.marked_left', { count: unmarked })
          }
        />
      </WhoCell>
        )}
      </Widget>

      <Widget id="work" label={t('bento.faculty_today.work_label')} size="small" index={2}>
        {(span) => (
      <WhoCell
        span={span}
        label={t('bento.faculty_today.work_label')}
        to={toWork}
        cue={t('bento.faculty_today.work_cue')}
      >
        <Figure
          value={w.outstanding}
          note={
            w.outstanding === 0
              ? t('bento.faculty_today.work_none')
              : overdue > 0
                ? t('bento.faculty_today.work_overdue', { count: overdue })
                : t('bento.faculty_today.work_some')
          }
        />
      </WhoCell>
        )}
      </Widget>

      <Widget id="sections" label={t('bento.faculty_today.sections_label')} size="small" index={3}>
        {(span) => (
      <WhoCell
        span={span}
        label={t('bento.faculty_today.sections_label')}
        to={toClasses}
        cue={t('bento.faculty_today.sections_cue')}
      >
        <Figure value={mine.length} note={t('bento.faculty_today.sections_note', { count: enrolled })} />
      </WhoCell>
        )}
      </Widget>

      <Widget id="lessons" label={t('bento.faculty_today.lessons_label')} size="small" index={4}>
        {(span) => (
      <WhoCell
        span={span}
        label={t('bento.faculty_today.lessons_label')}
        to={toTimetable}
        cue={t('bento.faculty_today.lessons_cue')}
      >
        <Figure
          value={lessons.length}
          note={
            lessons.length === 0
              ? t('bento.faculty_today.lessons_none')
              : t('bento.faculty_today.lessons_note', {
                  first: lessons[0].starts_at,
                  last: lessons[lessons.length - 1].ends_at,
                })
          }
        />
        {lessons.length > 0 && (
          <div className="mt-3">
            <Meter
              value={marked}
              total={lessons.length}
              tone={unmarked === 0 ? 'success' : 'warning'}
              srLabel={t('bento.faculty_today.marked_sr', { marked, count: lessons.length })}
            />
          </div>
        )}
      </WhoCell>
        )}
      </Widget>
    </PersonaPage>
  )
}
