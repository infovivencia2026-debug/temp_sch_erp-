import { Link } from 'react-router-dom'
import JoinActivities from './JoinActivities'
import { useCollapsingTitle } from '@/lib/motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CalendarCheck, ChevronRight, Megaphone, PlayCircle, Sparkles, Star, Timer } from 'lucide-react'
import { api, ApiError, type List } from '@/lib/api'
import { useFeatureHref } from '@/features/bento/bento-kit'
import { ErrorState } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  Bone, DueChip, NowNextCard, PullToRefresh, daysFrom, lastPlace, placeHref, todayISO, type Period,
} from './student-kit'

/* THE STUDENT'S HOME: WHAT DO I NEED TODAY?

   Above the fold on a phone, in this order: the class on now (or next) with a
   live countdown, the Continue-learning button, the homework due today and
   tomorrow, and whether today is marked present. Everything else (a quiz that is open,
   marks just published, notices) appears below only when there is something
   in it. Every card is one tap to the screen it summarises.

   The queries are the same ones the rest of the portal reads, keyed under
   `portal-`, so the persisted cache paints this page at once on a return
   visit and the network only refreshes it. */

interface Summary {
  full_name: string; attendance_pct: number; total_days: number; present_days: number
  today: Period[]
  /** The next school day's periods (Monday after the weekend). */
  next_day?: { weekday: number; periods: Period[] }
}
interface Day { date: string; status: string }
export interface StudentHomework {
  id: string; title: string; subject?: string; due_on?: string; assigned_on: string; submitted: boolean; overdue: boolean
  instructions?: string; teacher?: string; kind: string
  files?: { file_id: string; name: string }[]; my_answer?: string; my_file_id?: string; my_file_name?: string
}
interface Courses { items: { class_subject_id: string; subject: string; lessons: number; completed: number; quizzes_open: number }[] }
interface Todo {
  quizzes: { id: string; title: string; subject: string; class_subject_id: string; duration_minutes?: number | null }[]
  lessons: { id: string; title: string; subject: string; class_subject_id: string; unit: string }[]
}
interface Home { marks: { exam: string; subject: string; obtained: number | null; max_marks: number; grade?: string | null; is_absent: number }[]; notices: { id: string; title: string; publish_at: string }[] }

export const homeworkQuery = { queryKey: ['portal-student-homework'], queryFn: () => api.get<List<StudentHomework>>('/api/v1/homework') }

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}
/** Monday of this week, yyyy-mm-dd. */
export function weekStart() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function StudentHome() {
  const qc = useQueryClient()
  const toTimetable = useFeatureHref('student.timetable.timetable')
  const toHomework = useFeatureHref('student.homework.homework_assignments')
  const toCourses = useFeatureHref('student.learning.courses_subjects')
  const toAttendance = useFeatureHref('student.attendance.attendance')
  const toResults = useFeatureHref('student.exams_results.exams_grades')

  const summary = useQuery({ queryKey: ['portal-summary', 'self'], queryFn: () => api.get<Summary>('/api/v1/portal/summary') })
  const register = useQuery({ queryKey: ['portal-attendance', 'self'], queryFn: () => api.get<List<Day>>('/api/v1/portal/attendance') })
  const homework = useQuery(homeworkQuery)
  const courses = useQuery({ queryKey: ['portal-lms-courses'], queryFn: () => api.get<Courses>('/api/v1/portal/lms/courses') })
  const todo = useQuery({ queryKey: ['portal-lms-todo'], queryFn: () => api.get<Todo>('/api/v1/portal/lms/todo') })
  const home = useQuery({ queryKey: ['portal-lms-home', 'self'], queryFn: () => api.get<Home>('/api/v1/portal/lms/home') })

  const refresh = () => Promise.all(['portal-summary', 'portal-attendance', 'portal-student-homework', 'portal-lms-courses', 'portal-lms-todo', 'portal-lms-home']
    .map((k) => qc.invalidateQueries({ queryKey: [k] })))

  /* Before the early return below, not after it: a hook that runs while the
     summary is loading and is skipped once a 404 lands is "Rendered fewer
     hooks than expected", which took the whole screen down for a login with
     no student record. */
  const titleRef = useCollapsingTitle<HTMLDivElement>()

  if (summary.error instanceof ApiError && summary.error.status === 404) {
    return <div className="p-4"><ErrorState error={summary.error} /></div>
  }
  const s = summary.data
  const first = s?.full_name.split(' ')[0]
  const today = todayISO()
  const todayMark = register.data?.items.find((d) => d.date === today)

  /* Homework: what is due today and tomorrow (and anything late), soonest first. */
  const hw = homework.data?.items ?? []
  const pending = hw.filter((h) => !h.submitted && h.due_on && daysFrom(h.due_on) <= 1)
    .sort((a, b) => (a.due_on ?? '').localeCompare(b.due_on ?? ''))
  const ws = weekStart()
  const thisWeek = hw.filter((h) => (h.due_on ?? h.assigned_on) >= ws && (h.due_on ?? h.assigned_on) < addDays(ws, 7))
  const weekDone = thisWeek.filter((h) => h.submitted).length

  /* Continue: the last place opened on this device, else the next lesson waiting. */
  const last = lastPlace()
  const nextLesson = todo.data?.lessons[0]
  const cont = last && toCourses
    ? { href: placeHref(toCourses, last), title: last.title ?? 'Pick up where you left off', sub: last.subject ?? 'Your course' }
    : nextLesson && toCourses
      ? { href: placeHref(toCourses, { cs: nextLesson.class_subject_id, item: `lesson:${nextLesson.id}` }), title: nextLesson.title, sub: `${nextLesson.subject} · ${nextLesson.unit}` }
      : null
  const totalLessons = courses.data?.items.reduce((a, c) => a + c.lessons, 0) ?? 0
  const doneLessons = courses.data?.items.reduce((a, c) => a + c.completed, 0) ?? 0

  const quizzes = todo.data?.quizzes ?? []
  const marks = home.data?.marks ?? []
  const notices = home.data?.notices ?? []


  return (
    <PullToRefresh onRefresh={refresh}>
      <div className="w-full min-w-0 space-y-4 pt-2 md:space-y-6 md:px-8 md:pb-6 md:pt-6">
        {/* THE OWNER'S MY DAY. On a computer the greeting is a banner in the
            school's colour with the date as a pill; on a phone it is a plain
            header with the streak and badge chips beside it. */}
        <div className="relative hidden overflow-hidden rounded-3xl bg-gradient-to-br from-primary/85 to-primary/55 px-10 py-9 text-primary-foreground shadow-[0_10px_25px_-5px_hsl(var(--primary)/0.35)] md:flex md:items-center md:justify-between">
          <div>
            <h1 className="text-[32px] font-extrabold tracking-[-0.03em]">{s ? `${greeting()}, ${first}` : 'Hello'}</h1>
            <p className="mt-1.5 text-[15px] font-medium opacity-90">Your day at a glance</p>
          </div>
          <span className="flex items-center gap-2">
          <span className="rounded-full border border-white/30 bg-white/15 px-4 py-2 text-[13.5px] font-semibold backdrop-blur">
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </span>
          </span>
          <span aria-hidden className="pointer-events-none absolute -right-10 -top-14 h-60 w-60 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.18)_0%,transparent_70%)]" />
        </div>
        {/* A LARGE TITLE THAT COLLAPSES. The greeting shrinks toward its
            compact size and the date fades as the page scrolls, like a phone's
            navigation title (styles/motion.css .m-large-title). Scale only:
            the line never reflows. */}
        <div ref={titleRef} className="flex min-h-[56px] flex-wrap items-center gap-x-3 gap-y-2 md:hidden">
          <div className="min-w-0 flex-1">
            <h1 className="m-large-title text-[20px] font-extrabold leading-tight tracking-[-0.02em]">{s ? `${greeting()}, ${first}` : <Bone className="h-7 w-56" />}</h1>
            <p className="m-large-title-sub text-[12.5px] text-muted-foreground">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 md:gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-4">
        {summary.error && !s ? <ErrorState error={summary.error} /> : s ? (s.today.length === 0 ? (
          <section className="flex items-center gap-4 rounded-2xl border border-[#a7f3d0] bg-gradient-to-br from-[#f0fdf4] to-card px-5 py-5 shadow-sm">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-[#a7f3d0] bg-card text-[22px]">🌴</span>
            <span>
              <span className="block text-[16px] font-bold text-[#065f46]">No classes today</span>
              <span className="block text-[13px] text-[#047857]">Enjoy your day off. School is not in session.</span>
            </span>
          </section>
        ) : <NowNextCard periods={s.today} to={toTimetable} />) : <Bone className="h-[76px] w-full rounded-2xl" />}

        {/* Continue learning. */}
        {cont ? (
          <Link to={cont.href} className="flex min-h-[84px] items-center gap-3 rounded-2xl bg-primary px-4 py-3 text-primary-foreground shadow-sm transition active:scale-[.99]">
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/15"><PlayCircle className="h-7 w-7" strokeWidth={1.75} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[20px] font-bold leading-tight">Keep learning</span>
              <span className="block truncate text-[16px] font-medium opacity-95">{cont.title}</span>
              <span className="block truncate text-[14px] opacity-85">{cont.sub}{totalLessons ? ` · ${doneLessons}/${totalLessons} done` : ''}</span>
            </span>
            <ArrowRight className="h-8 w-8 shrink-0" aria-hidden />
          </Link>
        ) : todo.isLoading ? <Bone className="h-[72px] w-full rounded-2xl" /> : null}

        {/* Homework due today and tomorrow. */}
        <section className="card overflow-hidden p-0" aria-label="Homework">
          <Link to={toHomework ?? '#'} className="flex min-h-[52px] items-center gap-3 px-4 pt-3">
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold">Homework</span>
              <span className="block text-[13px] text-muted-foreground">
                {homework.data ? (thisWeek.length ? `${weekDone} of ${thisWeek.length} done this week` : 'Nothing set this week') : 'Loading…'}
              </span>
            </span>
            {homework.data && thisWeek.length > 0 && <MiniRing done={weekDone} total={thisWeek.length} />}
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
          {homework.isLoading ? (
            <div className="space-y-2 px-4 py-3"><Bone className="h-11 w-full" /><Bone className="h-11 w-full" /></div>
          ) : homework.error ? (
            <p className="px-4 py-3 text-[14px] text-destructive">Could not load your homework. Pull down to try again.</p>
          ) : pending.length === 0 ? (
            <p className="flex items-center gap-2 px-4 py-3 text-[14px] text-muted-foreground"><Sparkles className="h-4 w-4 text-success" /> Nothing due today or tomorrow. Nice!</p>
          ) : (
            <ul className="mt-1 divide-y border-t">
              {pending.slice(0, 4).map((h) => (
                <li key={h.id}>
                  <Link to={`${toHomework}?open=${h.id}`} className="flex min-h-[56px] items-center gap-3 px-4 py-2 active:bg-muted/50">
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 block text-[15px] font-medium leading-snug">{h.title}</span>
                      <span className="block truncate text-[13px] text-muted-foreground">{h.subject ?? 'Homework'}</span>
                    </span>
                    <DueChip due={h.due_on} />
                  </Link>
                </li>
              ))}
              {pending.length > 4 && <li><Link to={toHomework ?? '#'} className="flex min-h-[44px] items-center px-4 text-[13px] font-medium text-primary">{pending.length - 4} more</Link></li>}
            </ul>
          )}
        </section>

        {/* Today's attendance. */}
        <Link to={toAttendance ?? '#'} className="card flex min-h-[64px] items-center gap-3 px-4 py-3" aria-label="Attendance">
          <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
            todayMark?.status === 'absent' ? 'bg-[hsl(var(--sys-pink)/0.14)] text-[#be123c]'
              : todayMark ? 'bg-[hsl(var(--sys-green)/0.14)] text-[#047857]' : 'bg-muted text-muted-foreground')}>
            <CalendarCheck className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold">
              {register.isLoading ? 'Attendance' : todayMark ? `Today: ${todayMark.status.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())}` : 'Today: not marked yet'}
            </span>
            <span className="block text-[13px] text-muted-foreground">{s && s.total_days ? `${s.attendance_pct}% this year · ${s.present_days} of ${s.total_days} days` : 'No days marked yet'}</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>

        <JoinActivities />

        {/* Only when there is something in them. */}
        {quizzes.length > 0 && toCourses && (
          <section className="card overflow-hidden p-0">
            <h2 className="px-4 pt-3 text-[15px] font-semibold">Quiz time</h2>
            <ul className="divide-y">
              {quizzes.slice(0, 3).map((z) => (
                <li key={z.id}>
                  <Link to={placeHref(toCourses, { cs: z.class_subject_id, item: `quiz:${z.id}` })} className="flex min-h-[56px] items-center gap-3 px-4 py-2">
                    <Timer className="h-5 w-5 shrink-0 text-[hsl(var(--sys-blue))]" strokeWidth={1.75} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium">{z.title}</span>
                      <span className="block text-[13px] text-muted-foreground">{z.subject}{z.duration_minutes ? ` · ${z.duration_minutes} min` : ''}</span>
                    </span>
                    <span className="rounded-full bg-primary px-3 py-1 text-[13px] font-semibold text-primary-foreground">Play</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {marks.length > 0 && (
          <Link to={toResults ?? '#'} className="card block px-4 py-3">
            <span className="flex items-center gap-2 text-[15px] font-semibold"><Star className="h-4 w-4 text-[hsl(var(--sys-orange))]" strokeWidth={1.8} /> New marks</span>
            <ul className="mt-1 space-y-0.5 text-[14px]">
              {marks.slice(0, 3).map((m, i) => (
                <li key={i} className="flex justify-between gap-3"><span className="truncate text-muted-foreground">{m.subject} · {m.exam}</span><span className="shrink-0 font-medium tabular-nums">{m.is_absent ? 'Absent' : `${m.obtained ?? '–'}/${m.max_marks}`}</span></li>
              ))}
            </ul>
          </Link>
        )}

        {notices.length > 0 && (
          <div className="card px-4 py-3">
            <span className="flex items-center gap-2 text-[15px] font-semibold"><Megaphone className="h-4 w-4 text-[hsl(var(--sys-pink))]" strokeWidth={1.8} /> Notices</span>
            <ul className="mt-1 space-y-1 text-[14px]">
              {notices.slice(0, 3).map((n) => <li key={n.id} className="truncate">{n.title}</li>)}
            </ul>
          </div>
        )}
        </div>
        <div className="space-y-4">
        {/* THE NEXT SCHOOL DAY, from the owner's design: subject, teacher and
            the time as a chip. */}
        {s?.next_day && s.next_day.periods.length > 0 && (
          <section className="card overflow-hidden p-0 md:p-2" aria-label="Next school day">
            <div className="flex items-center justify-between px-4 pb-2 pt-3">
              <h2 className="text-[15px] font-bold">
                {s.next_day.weekday === ((new Date().getDay() + 6) % 7) + 2 || (new Date().getDay() === 0 && s.next_day.weekday === 1)
                  ? `Tomorrow (${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][s.next_day.weekday - 1]})`
                  : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][s.next_day.weekday - 1]}
              </h2>
              {toTimetable && <Link to={toTimetable} className="-my-2 inline-flex min-h-[44px] items-center px-1 text-[13px] font-semibold text-primary">Full week →</Link>}
            </div>
            <ul className="flex flex-col gap-2 px-3 pb-3">
              {s.next_day.periods.filter((x) => x.subject !== 'Free').map((x, i) => (
                <li key={i} className="flex items-center justify-between gap-3 rounded-xl border bg-muted/30 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold">{x.subject}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">{[x.period, x.teacher].filter(Boolean).join(' • ')}</span>
                  </span>
                  {x.starts_at && <span className="shrink-0 rounded-md border border-primary/25 bg-primary/10 px-2.5 py-1 text-[12px] font-bold tabular-nums text-primary">{x.starts_at}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {s?.next_day && s.next_day.periods.length === 0 && (
          <section className="card px-5 py-4 text-[14px] text-muted-foreground">Nothing is timetabled for the next school day.</section>
        )}
        </div>
        </div>
      </div>
    </PullToRefresh>
  )
}

function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export { addDays }

export function MiniRing({ done, total, size = 36 }: { done: number; total: number; size?: number }) {
  const r = (size - 5) / 2, c = 2 * Math.PI * r, p = total ? done / total : 0
  return (
    <svg width={size} height={size} className="-rotate-90 shrink-0" role="img" aria-label={`${done} of ${total}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={4} className="stroke-muted" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={4} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - c * p}
        className={cn('transition-[stroke-dashoffset] duration-700', p >= 1 ? 'stroke-success' : 'stroke-primary')} />
    </svg>
  )
}
