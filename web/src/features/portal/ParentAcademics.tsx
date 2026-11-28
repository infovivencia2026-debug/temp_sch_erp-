import { useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Inbox } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { Skeleton } from '@/components/Skeleton'
import { SubjectCardsSkeleton, HomeworkRowsSkeleton } from './skeletons'
import { PageHead, PageBody, Card, CardHeader, EmptyState, ErrorState, Input, SkeletonTiles } from '@/components/ui'
import { formatDate, cn } from '@/lib/utils'

import Homework from '@/features/workflow/Homework'
import FileView, { type ViewableFile } from '@/components/FileView'
import { Paperclip, CalendarClock, BarChart3 } from 'lucide-react'
import { useChildren } from './use-children'
import { useChildProfile, useParentYear, fileSrc, initials } from './parent-child'
import { SubjectCards } from './ParentChildCard'

/* THE PARENT'S ACADEMICS (owner, 2026-11-26). One screen behind the menu's
   Homework, Subjects and ECA entries, picked by `?view=`:

     (none)    Homework: the full diary, every piece of work by day
               (owner, 2026-11-27: "show all homework like it used to be").
     subjects  The child's subjects as cards.
     subject   One subject: its teacher, periods a week, the marks trend,
               homework by day, marks and this week's periods.
     eca       The extra-curricular activities the child is enrolled in.
     diary     The same diary (older links). */

interface Hw {
  id: string; title: string; kind: string; subject?: string; assigned_on: string; due_on?: string
  files?: { file_id: string; name: string }[]
  instructions?: string; submitted: boolean; overdue: boolean; teacher?: string; student_id?: string
}
interface ResultView { subjects: { exam: string; subject: string; marks_obtained?: number; max_marks?: number; grade?: string; is_absent: boolean }[] }

const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function ParentAcademics() {
  const [params] = useSearchParams()
  const view = params.get('view') ?? ''
  if (view === '' || view === 'diary') return <Homework />
  return <Academics view={view} />
}

function Academics({ view }: { view: string }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const home = `/${useLocation().pathname.split('/')[1] || 'parent'}`
  const { children, chosen } = useChildren()
  const asked = params.get('student_id') ?? ''
  const ids = children.map((c) => c.student_id)
  const sid = (asked && ids.includes(asked) ? asked : chosen && ids.includes(chosen) ? chosen : ids[0]) ?? ''
  const [year] = useParentYear()
  const profile = useChildProfile(sid || null, year)
  const homework = useQuery({
    queryKey: ['homework', 'diary', false],
    queryFn: () => api.get<List<Hw>>('/api/v1/homework'),
    enabled: view === 'subject' || view === 'subjects',
  })
  const sectionId = children.find((c) => c.student_id === sid)?.section_id ?? ''
  const periods = useQuery({
    queryKey: ['periods', 'all'],
    queryFn: () => api.call('GET /timetable/periods', { query: { all: '1' } }),
    enabled: view === 'subject' && !!sectionId,
  })
  const entries = useQuery({
    queryKey: ['timetable', 'section', sectionId],
    queryFn: () => api.call('GET /timetable/entries', { query: { section_id: sectionId } }),
    enabled: view === 'subject' && !!sectionId,
  })
  /* Notes are the teacher's study material for the subject (Classwork › Materials). */
  const materials = useQuery({
    queryKey: ['portal-resources', sid],
    queryFn: () => api.get<List<Note>>(`/api/v1/portal/learning/resources?student_id=${sid}`),
    enabled: (view === 'subject' || view === 'subjects') && !!sid,
  })
  const results = useQuery({
    queryKey: ['portal-results', sid, year],
    queryFn: () => api.get<ResultView>(`/api/v1/portal/results?student_id=${sid}${year ? `&academic_year_id=${year}` : ''}`),
    enabled: (view === 'subject' || view === 'subjects') && !!sid,
  })

  const keep = (extra: Record<string, string>) => {
    const p = new URLSearchParams(params)
    for (const k of ['view', 'subject', 'cs']) p.delete(k)
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v)
    const s = p.toString()
    return s ? `?${s}` : '?'
  }
  const p = profile.data
  const subjects = p?.subjects ?? []
  const hw = (homework.data?.items ?? []).filter((h) => !h.student_id || h.student_id === sid)
  const today = todayISO()

  if (profile.isLoading && !p) return <><PageHead title={view === 'subjects' ? 'All subjects' : 'Homework'} /><PageBody>{view === 'subjects' ? <SubjectCardsSkeleton /> : <SkeletonTiles count={4} />}</PageBody></>
  if (profile.error && !p) return <><PageHead title="Homework" /><PageBody><ErrorState error={profile.error} /></PageBody></>

  if (view === 'subjects') {
    return (
      <>
        <PageHead eyebrow="Home" onEyebrow={() => navigate(home)} title="All subjects" />
        <PageBody>
          <SubjectCards subjects={subjects} hrefFor={(s) => keep({ view: 'subject', cs: s.class_subject_id })}
            note={(s) => s.teacher ? `${s.teacher}` : `${s.periods_per_week} periods a week`}
            /* The same cards as the home page (owner, 2026-11-28). */
            stats={(x) => {
              const last = (results.data?.subjects ?? []).filter((m) => m.subject === x.subject && !m.is_absent && m.marks_obtained != null && m.max_marks).at(-1)
              return {
                homework: homework.isLoading ? '…' : hw.filter((h) => h.subject === x.subject && h.assigned_on.slice(0, 10) === today).length,
                notes: materials.isLoading ? '…' : (materials.data?.items ?? []).filter((m) => m.subject === x.subject).length,
                marks: last ? `${last.marks_obtained}/${last.max_marks}` : '–',
              }
            }} />
        </PageBody>
      </>
    )
  }

  if (view === 'eca') {
    const eca = p?.eca ?? []
    return (
      <>
        <PageHead title="ECA" />
        <PageBody>
          {eca.length === 0 ? <EmptyState title="No activities" body="This child is not enrolled in any extra-curricular activity." /> : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {eca.map((a) => (
                <li key={a.id} className="card p-4">
                  <p className="text-[16px] font-semibold">{a.name}</p>
                  <p className="mt-1 text-[14px] text-muted-foreground">{[a.category, a.schedule, a.venue].filter(Boolean).join(' · ')}</p>
                </li>
              ))}
            </ul>
          )}
        </PageBody>
      </>
    )
  }

  if (view === 'subject') {
    const s = subjects.find((x) => x.class_subject_id === params.get('cs'))
    const head = <PageHead eyebrow="All subjects" onEyebrow={() => navigate(keep({ view: 'subjects' }))} title={s?.subject ?? 'Subject'} />
    if (!s) return <>{head}<PageBody><EmptyState title="Subject not found" body="Pick a subject from the list." /></PageBody></>
    const mine = hw.filter((h) => h.subject === s.subject).sort((a, b) => b.assigned_on.localeCompare(a.assigned_on))
    const marks = (results.data?.subjects ?? []).filter((m) => m.subject === s.subject)
    const scored = marks.filter((m) => !m.is_absent && m.marks_obtained != null && !!m.max_marks)
    const periodOf = new Map((periods.data?.items ?? []).map((x) => [x.id, x]))
    const week = (entries.data?.items ?? [])
      .filter((e) => (e.subject_name || e.subject_code) === s.subject)
      .map((e) => ({ day: e.weekday, p: periodOf.get(e.period_id), room: e.room }))
      .sort((a, b) => a.day - b.day || (a.p?.starts_at ?? '').localeCompare(b.p?.starts_at ?? ''))
    const todayDay = ((new Date().getDay() + 6) % 7) + 1
    const nowHM = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
    const todays = week.filter((w) => w.day === todayDay)
    /* The next class after today, wrapping round the week. */
    const next = week.find((w) => w.day > todayDay) ?? week[0]
    /* What staff set on the Homework screen, by its type, and their notes. */
    const ofKind = (...k: string[]) => mine.filter((h) => k.includes(h.kind || 'homework')).length
    const homeworkN = ofKind('homework', 'classwork')
    const assignments = ofKind('assignment')
    const projects = ofKind('project')
    const notes = (materials.data?.items ?? []).filter((m) => m.subject === s.subject).length
    return (
      <>
        {head}
        <PageBody width="full">
          {/* THE SUBJECT (owner, 2026-11-27, after the subject-workspace
              mockup): the subject and its teacher, three facts, then only the
              sections the school has data for. Attendance by subject, topic
              mastery and resources are left out: nothing records them. */}
          {/* The subject's name is the breadcrumb above (owner, 2026-11-27: no
              second heading), so the card is its teacher. */}
          <Card className="relative -mt-2 overflow-hidden p-4 sm:p-5">
            <div className="flex min-w-0 items-center gap-4">
              {/* Bigger teacher photo (owner, 2026-11-28: "I can't see it"), passport shape like the child's. */}
              {s.teacher_photo
                ? <img src={fileSrc(s.teacher_photo)} alt="" style={{ borderRadius: 4, clipPath: 'none' }} className="h-[92px] w-[72px] shrink-0 rounded-[4px] bg-muted object-cover object-[50%_20%] shadow-sm ring-2 ring-white sm:h-[112px] sm:w-[88px]" />
                : <span aria-hidden className="grid h-[92px] w-[72px] shrink-0 place-items-center rounded-xl bg-primary/10 text-[24px] font-extrabold text-primary sm:h-[112px] sm:w-[88px] sm:text-[28px]">{initials(s.teacher ?? '?')}</span>}
              <div className="min-w-0 flex-1">
                {/* Name only (up to two lines, normal case), then the class (owner, 2026-11-28). */}
                <p className="line-clamp-2 break-words text-[18px] font-bold leading-snug">{s.teacher ? s.teacher.toLowerCase().replace(/(^|[\s.'-])\p{L}/gu, (c) => c.toUpperCase()) : 'Teacher not assigned yet'}</p>
                {p?.class_name && <p className="mt-1 text-[14px] text-muted-foreground">{/^\d/.test(p.class_name.trim()) ? `Class ${p.class_name.trim()}` : p.class_name.trim()}{p.section_name ? ` · ${p.section_name}` : ''}</p>}
              </div>
            </div>
          </Card>
          {/* TODAY (owner, 2026-11-28 preview): one line when there is no class
              (with the next one), else a row per class with Done / Now / Later. */}
          <Card className="p-4">
            <h2 className="mb-3 text-[16px] font-bold">Today</h2>
            {todays.length === 0 ? (
              <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><CalendarClock className="size-5" aria-hidden /></span>
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold">No {s.subject} class today</span>
                  {next && <span className="block text-[13px] text-muted-foreground">Next: {DAY[next.day - 1]}, {next.p?.name ?? 'class'}{next.p?.starts_at ? ` · ${next.p.starts_at}` : ''}</span>}
                </span>
              </div>
            ) : (
              <ul className="space-y-2">
                {todays.map((w, i) => {
                  const st = w.p?.ends_at && w.p.ends_at <= nowHM ? 'Done' : w.p?.starts_at && w.p.starts_at <= nowHM ? 'Now' : 'Later'
                  return (
                    <li key={i} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-muted/50 px-3 py-2.5', st === 'Now' && 'bg-primary/10 ring-1 ring-primary')}>
                      <span className="text-[15px] font-bold tabular-nums">{w.p?.starts_at ?? '-'}–{w.p?.ends_at ?? '-'}</span>
                      <span className="min-w-0 flex-1 text-[14px] text-muted-foreground">{[w.p?.name, w.room ? `Room ${w.room}` : ''].filter(Boolean).join(' · ')}</span>
                      <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-[11px] font-bold', st === 'Now' ? 'bg-primary text-primary-foreground' : st === 'Done' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground')}>{st}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
          {/* The four kinds of work as one compact row. */}
          <ul className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 5.25rem), 1fr))' }}>
            {([['Assignments', assignments, homework.isLoading], ['Homework', homeworkN, homework.isLoading], ['Projects', projects, homework.isLoading], ['Notes', notes, materials.isLoading]] as const).map(([k, v, busy]) => (
              <li key={k} className="rounded-2xl border bg-card px-1.5 py-3 text-center">
                <span className="block text-[22px] font-extrabold tabular-nums">{busy ? '…' : v}</span>
                <span className="block whitespace-nowrap text-[11px] font-semibold text-muted-foreground">{k}</span>
              </li>
            ))}
          </ul>
          <MarksCard marks={marks} scored={scored} />
          <NotesList items={(materials.data?.items ?? []).filter((m) => m.subject === s.subject)} />
          <SubjectHomework items={mine} today={today} loading={homework.isLoading} error={homework.error} />
        </PageBody>
      </>
    )
  }

  return null
}

/* A SUBJECT'S HOMEWORK BY DAY (owner, 2026-11-26): a date picker, today by
   default, and the work set on that day; earlier days one pick away. */
function SubjectHomework({ items, today, loading, error }: { items: Hw[]; today: string; loading: boolean; error: unknown }) {
  const [day, setDay] = useState(today)
  if (loading) return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-[var(--card-pad)] pb-2 pt-[var(--card-pad)]">
        <h2 className="text-[16px] font-semibold">Homework</h2>
        <Skeleton className="h-10 w-[11.5rem] max-w-full" />
      </div>
      <HomeworkRowsSkeleton />
    </Card>
  )
  if (error && !items.length) return <ErrorState error={error} />
  const onDay = items.filter((h) => h.assigned_on.slice(0, 10) === day)
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-[var(--card-pad)] pb-2 pt-[var(--card-pad)]">
        <h2 className="text-[16px] font-semibold">Homework</h2>
        <div className="w-[11.5rem] max-w-full"><Input type="date" value={day} onChange={(v) => setDay(v || today)} max={today} /></div>
      </div>
      {onDay.length === 0
        ? <p className="flex items-center gap-2 px-[var(--card-pad)] pb-4 text-[14px] text-muted-foreground"><Inbox className="h-4 w-4 shrink-0" aria-hidden />{day === today ? 'No homework set today' : 'No homework set on this day'}</p>
        : <HwList items={onDay} />}
    </Card>
  )
}

interface Note { id: string; title: string; subject?: string; kind?: string; file_id?: string; file_name?: string; external_url?: string; posted_on?: string; uploaded_by?: string }

/* The teacher's notes and study material for this subject, each opening its file or link. */
function NotesList({ items }: { items: Note[] }) {
  const [view, setView] = useState<ViewableFile | null>(null)
  if (!items.length) return null
  return (
    <Card>
      {view && <FileView file={view} onClose={() => setView(null)} />}
      <CardHeader title="Notes" />
      <ul className="divide-y px-[var(--card-pad)] pb-2">
        {items.map((n) => (
          <li key={n.id} className="py-3">
            <p className="text-[16px] font-medium leading-snug">{n.title}</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">{[n.uploaded_by, n.posted_on ? formatDate(n.posted_on) : ''].filter(Boolean).join(' · ')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {n.file_id && <FileChip name={n.file_name || 'Open file'} onOpen={() => setView({ file_id: n.file_id!, name: n.file_name || n.title })} />}
              {n.external_url && <a href={n.external_url} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center rounded-xl border bg-card px-3 text-[14px] font-medium text-primary">Open link</a>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

type Mark = { exam: string; marks_obtained?: number | null; max_marks?: number | null; grade?: string | null; is_absent?: boolean }
const pctOf = (m: Mark) => Math.round(((m.marks_obtained ?? 0) / (m.max_marks || 1)) * 100)

/* MARKS (owner, 2026-11-28 preview): the average as a ring, the latest result
   and the change from the test before, then each test with its bar and grade. */
function MarksCard({ marks, scored }: { marks: Mark[]; scored: Mark[] }) {
  if (!marks.length) {
    return (
      <Card className="p-4">
        <h2 className="mb-3 text-[16px] font-bold">Marks</h2>
        <p className="flex items-center gap-3 rounded-xl bg-muted/50 p-3 text-[14px] text-muted-foreground">
          <BarChart3 className="size-5 shrink-0 text-primary" aria-hidden />Marks show here once the school publishes them.
        </p>
      </Card>
    )
  }
  const avg = scored.length ? Math.round(scored.reduce((a, m) => a + pctOf(m), 0) / scored.length) : null
  const latest = scored.at(-1)
  const prev = scored.at(-2)
  const change = latest && prev ? pctOf(latest) - pctOf(prev) : null
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-[16px] font-bold">Marks</h2>
      {avg != null && latest && (
        <div className="mb-3 flex items-center gap-4">
          <span className="grid size-[74px] shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(hsl(var(--primary)) ${avg}%, hsl(var(--muted)) 0)` }}>
            <span className="grid size-[58px] place-items-center rounded-full bg-card text-[17px] font-extrabold tabular-nums">{avg}%</span>
          </span>
          <span className="min-w-0 text-[14px]">
            <span className="block text-[15px] font-semibold">Average of {scored.length} test{scored.length === 1 ? '' : 's'}</span>
            <span className="block text-muted-foreground">Latest: <b className="text-foreground">{latest.marks_obtained} / {latest.max_marks}</b> in {latest.exam}</span>
            {change != null && change !== 0 && prev && (
              <span className={cn('block font-semibold', change > 0 ? 'text-success' : 'text-destructive')}>{change > 0 ? '↑' : '↓'} {Math.abs(change)}% {change > 0 ? 'better' : 'lower'} than {prev.exam}</span>
            )}
          </span>
        </div>
      )}
      <ul>
        {marks.map((m, i) => (
          <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-t py-2.5">
            <span className="min-w-0 break-words text-[14px] font-semibold">{m.exam}{m.grade && <span className="ml-1.5 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold text-primary">{m.grade}</span>}</span>
            <span className="text-[14px] font-extrabold tabular-nums">{m.is_absent ? 'Absent' : `${m.marks_obtained ?? '-'} / ${m.max_marks ?? '-'}`}</span>
            {!m.is_absent && m.max_marks ? (
              <span className="col-span-2 h-2 overflow-hidden rounded-full bg-muted">
                <span className={cn('block h-full rounded-full', pctOf(m) >= 75 ? 'bg-success' : pctOf(m) >= 50 ? 'bg-warning' : 'bg-destructive')} style={{ width: `${pctOf(m)}%` }} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  )
}

const KIND: Record<string, string> = { homework: 'Homework', classwork: 'Classwork', assignment: 'Assignment', project: 'Project' }

/* A file the teacher attached, opened in the in-app viewer. */
function FileChip({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}
      className="inline-flex min-h-[44px] max-w-full items-center gap-2 rounded-xl border bg-card px-3 text-left text-[14px] font-medium text-primary">
      <Paperclip className="size-4 shrink-0" aria-hidden /><span className="min-w-0 break-words">{name}</span>
    </button>
  )
}

function HwList({ items }: { items: Hw[] }) {
  const [view, setView] = useState<ViewableFile | null>(null)
  return (
    <>
    {view && <FileView file={view} onClose={() => setView(null)} />}
    <ul className="divide-y px-[var(--card-pad)] pb-2">
      {items.map((h) => (
        <li key={`${h.id}:${h.student_id ?? ''}`} className="py-3">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-[16px] font-medium leading-snug">{h.title}</p>
            <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-semibold',
              h.submitted ? 'bg-success/10 text-success' : h.overdue ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')}>
              {h.submitted ? 'Done' : h.overdue ? 'Overdue' : h.due_on ? `Due ${formatDate(h.due_on)}` : 'Set'}
            </span>
          </div>
          {h.instructions && <p className="mt-1 line-clamp-3 text-[15px] text-muted-foreground">{h.instructions}</p>}
          {!!h.files?.length && <div className="mt-2 flex flex-wrap gap-2">{h.files.map((f) => <FileChip key={f.file_id} name={f.name} onOpen={() => setView({ file_id: f.file_id, name: f.name })} />)}</div>}
          <p className="mt-1 text-[13px] text-muted-foreground">{KIND[h.kind] ?? 'Homework'} · Set {formatDate(h.assigned_on)}{h.teacher ? ` · ${h.teacher}` : ''}</p>
        </li>
      ))}
    </ul>
    </>
  )
}

