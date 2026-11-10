import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useShownNotes } from '@/components/Notifications'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from './bento-kit'
import { Facts, PersonaCard, PersonaPage, Say, useShape } from './persona-kit'
import { Widget } from './WidgetLayer'
import { inClassic } from './classic-board'

/* THE TEACHER'S FOCUS BOARD (owner, 2026-11-10: "everyone has their own
   bentos on focus"). The teacher home used to be the same timetable page on
   both shells; Work keeps that page, Focus has these cells. Every figure is
   from the lists the Work home already reads. */

type Entry = { id: string; weekday: number; period_id: string; period_name?: string; subject_name: string; class_name: string; section_name: string }
type Period = { id: string; name: string; starts_at: string; ends_at: string }

function weekdayNow(): number {
  const d = new Date().getDay()
  return d === 0 ? 7 : d
}

function TeacherDesk() {
  const periods = useQuery({ queryKey: ['periods', 'all'], queryFn: () => api.call('GET /timetable/periods', { query: { all: '1' } }) })
  const entries = useQuery({ queryKey: ['timetable', 'me'], queryFn: () => api.call('GET /timetable/entries', { query: { teacher_id: 'me' } }) })
  const tasks = useQuery({
    queryKey: ['staff-tasks', 'mine-summary'],
    queryFn: () => api.get<{ summary: { open: number; in_progress: number; review: number; overdue: number } }>('/api/v1/hr/tasks?for=mine'),
    retry: false,
  })
  const ct = useQuery({ queryKey: ['sections', 'class_teacher'], queryFn: () => api.get<List<{ id: string; name?: string }>>('/api/v1/academics/sections?mine=class_teacher'), retry: false })
  const notes = useShownNotes()

  const toTimetable = useFeatureHref('faculty.timetable.my_timetable')
  const toAttendance = useFeatureHref('faculty.attendance.student_absentees')
  const toTasks = useFeatureHref('faculty.my_profile.my_tasks')
  const toLeave = useFeatureHref('faculty.my_profile.leave_self_service')
  const toMessages = useFeatureHref('faculty.communication.messages')

  if (periods.isLoading || entries.isLoading) return <BentoLoading message="Reading your timetable…" />
  if (entries.error && !String(entries.error).includes('403')) return <BentoError message={String(entries.error)} />

  const bell = new Map(((periods.data?.items ?? []) as Period[]).map((p) => [p.id, p]))
  const day = weekdayNow()
  const all = (entries.data?.items ?? []) as Entry[]
  const today = all.filter((e) => e.weekday === day)
    .map((e) => ({ e, p: bell.get(e.period_id) }))
    .sort((a, b) => (a.p?.starts_at ?? '').localeCompare(b.p?.starts_at ?? ''))
  const ts = tasks.data?.summary
  const unread = (notes.items ?? []).filter((n) => !n.read_at).length

  return (
    <PersonaPage eyebrow="Home" title="My day" dashboard="teacher_desk">
      <Widget id="classes" label="Classes today" size="large" index={0}>
        {(span) => <ClassesCell span={span} today={today} week={all.length} to={toTimetable} />}
      </Widget>
      <Widget id="register" label="Attendance" size="small" index={1}>
        {(span) => (
          <PersonaCard span={span} ground="attendance" title="Attendance" glyph="✓"
            value={(ct.data?.items?.length ?? 0) || '-'}
            change={(ct.data?.items?.length ?? 0) ? 'Your class to mark today' : 'You are not a class teacher'}
            to={toAttendance} cueLabel="Open attendance">
            <Say>Mark the register before the first period</Say>
          </PersonaCard>
        )}
      </Widget>
      <Widget id="tasks" label="My tasks" size="small" index={2}>
        {(span) => (
          <PersonaCard span={span} ground="staff" title="My tasks" glyph="☰"
            value={ts ? ts.open + ts.in_progress : '-'}
            change={ts ? (ts.overdue ? `${ts.overdue} overdue` : 'Nothing overdue') : 'No tasks'}
            to={toTasks} cueLabel="Open my tasks">
            {ts && ts.review > 0 ? <Say>{`${ts.review} waiting for review`}</Say> : <Say>Tasks set for you by the office</Say>}
          </PersonaCard>
        )}
      </Widget>
      <Widget id="notes" label="Notifications" size="small" index={3}>
        {(span) => (
          <PersonaCard span={span} ground="reports" title="Notifications" glyph="◔"
            value={unread}
            change={unread ? 'New for you' : 'All caught up'}
            to={toMessages} cueLabel="Open messages">
            {(notes.items ?? []).slice(0, 2).length
              ? <Facts items={(notes.items ?? []).slice(0, 2).map((n) => ({ label: n.title, value: '' }))} srLabel="Latest notifications" />
              : <Say>Nothing new</Say>}
          </PersonaCard>
        )}
      </Widget>
      <Widget id="leave" label="Leave" size="small" index={4}>
        {(span) => (
          <PersonaCard span={span} ground="operations" title="Apply for leave" glyph="✈"
            value="Apply" change="A day off, and where your requests are" to={toLeave} cueLabel="Open leave">
            <Say>Requests go to the office for approval</Say>
          </PersonaCard>
        )}
      </Widget>
    </PersonaPage>
  )
}

function ClassesCell({ span, today, week, to }: { span: CellSpan; today: { e: Entry; p?: Period }[]; week: number; to?: string }) {
  const { tall } = useShape()
  const facts = today.slice(0, tall ? 8 : 4).map(({ e, p }) => ({
    label: `${e.subject_name} · ${e.class_name} ${e.section_name}`,
    value: p ? p.starts_at.slice(0, 5) : (e.period_name ?? ''),
  }))
  return (
    <PersonaCard span={span} ground="academics" title="Classes today" glyph="◷"
      value={today.length} change={`${week} periods this week`} to={to} cueLabel="Open my timetable">
      {facts.length ? <Facts items={facts} srLabel="Today's classes and their times" /> : <Say>No classes today</Say>}
    </PersonaCard>
  )
}

export const Classic = inClassic(TeacherDesk)
export default TeacherDesk
