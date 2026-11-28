import { useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Inbox, ClipboardCheck, TrendingUp, BookOpenCheck, FolderKanban, NotebookText } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, CellGrid, Stat, EmptyState, ErrorState, Input, SkeletonTiles } from '@/components/ui'
import { formatDate, cn } from '@/lib/utils'

import Homework from '@/features/workflow/Homework'
import FileView, { type ViewableFile } from '@/components/FileView'
import { Paperclip } from 'lucide-react'
import { useChildren } from './use-children'
import { useChildProfile, useParentYear } from './parent-child'
import { ChildAvatar, SubjectCards } from './ParentChildCard'

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
    enabled: view === 'subject',
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
    enabled: view === 'subject' && !!sid,
  })
  const results = useQuery({
    queryKey: ['portal-results', sid, year],
    queryFn: () => api.get<ResultView>(`/api/v1/portal/results?student_id=${sid}${year ? `&academic_year_id=${year}` : ''}`),
    enabled: view === 'subject' && !!sid,
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

  if (profile.isLoading && !p) return <><PageHead title="Homework" /><PageBody><SkeletonTiles count={4} /></PageBody></>
  if (profile.error && !p) return <><PageHead title="Homework" /><PageBody><ErrorState error={profile.error} /></PageBody></>

  if (view === 'subjects') {
    return (
      <>
        <PageHead eyebrow="Home" onEyebrow={() => navigate(home)} title="All subjects" />
        <PageBody>
          <SubjectCards subjects={subjects} hrefFor={(s) => keep({ view: 'subject', cs: s.class_subject_id })}
            note={(s) => s.teacher ? `${s.teacher}` : `${s.periods_per_week} periods a week`} />
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
    const latest = scored.at(-1)
    const periodOf = new Map((periods.data?.items ?? []).map((x) => [x.id, x]))
    const week = (entries.data?.items ?? [])
      .filter((e) => (e.subject_name || e.subject_code) === s.subject)
      .map((e) => ({ day: e.weekday, p: periodOf.get(e.period_id), room: e.room }))
      .sort((a, b) => a.day - b.day || (a.p?.starts_at ?? '').localeCompare(b.p?.starts_at ?? ''))
    const todayDay = ((new Date().getDay() + 6) % 7) + 1
    const nowHM = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
    const todays = week.filter((w) => w.day === todayDay)
    /* What staff set on the Homework screen, by its type, and their notes. */
    const ofKind = (...k: string[]) => mine.filter((h) => k.includes(h.kind || 'homework')).length
    const homeworkN = ofKind('homework', 'classwork')
    const assignments = ofKind('assignment')
    const projects = ofKind('project')
    const notes = (materials.data?.items ?? []).filter((m) => m.subject === s.subject).length
    return (
      <>
        {head}
        <PageBody top width="full">
          {/* THE SUBJECT (owner, 2026-11-27, after the subject-workspace
              mockup): the subject and its teacher, three facts, then only the
              sections the school has data for. Attendance by subject, topic
              mastery and resources are left out: nothing records them. */}
          {/* The subject's name is the breadcrumb above (owner, 2026-11-27: no
              second heading), so the card is its teacher. */}
          <Card className="relative overflow-hidden p-4 sm:p-5">
            <div className="flex min-w-0 items-center gap-4">
              <ChildAvatar name={s.teacher ?? '?'} photo={s.teacher_photo} size="md" />
              <div className="min-w-0">
                <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Subject teacher</p>
                <p className="truncate text-[17px] font-semibold leading-snug">{s.teacher ?? 'Not assigned yet'}</p>
              </div>
            </div>
          </Card>
          {/* Empty sections are left out (owner, 2026-11-27: "empty boxes look
              ugly"); Homework always shows, as it carries the date picker. */}
          {/* Today's classes only (owner, 2026-11-28: no full week), each with
              its time and whether it is done, on now or later. */}
          <Card>
            <CardHeader title="Today's classes" />
            {todays.length === 0 ? <p className="px-[var(--card-pad)] pb-4 text-[15px] text-muted-foreground">No {s.subject} class today.</p> : (
              <ul className="divide-y divide-dashed px-[var(--card-pad)] pb-2">
                {todays.map((w, i) => {
                  const st = w.p?.ends_at && w.p.ends_at <= nowHM ? 'Done' : w.p?.starts_at && w.p.starts_at <= nowHM ? 'Now' : 'Later'
                  return (
                    <li key={i} className={cn('flex items-stretch gap-3 py-2.5', st === 'Done' && 'opacity-70')}>
                      <span className="w-[60px] shrink-0 text-center"><span className="block text-[16px] font-bold tabular-nums">{w.p?.starts_at ?? '-'}</span><span className="text-[12px] text-muted-foreground">to {w.p?.ends_at ?? '-'}</span></span>
                      <span className={cn('min-w-0 flex-1 rounded-xl border-l-4 bg-muted/50 px-3 py-2', st === 'Now' ? 'border-primary bg-primary/10' : 'border-border')}>
                        <span className="flex items-center justify-between gap-2"><span className="truncate text-[15px] font-semibold">{w.p?.name ?? 'Class'}</span>
                          <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-[11px] font-bold', st === 'Now' ? 'bg-primary text-primary-foreground' : st === 'Done' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground')}>{st}</span></span>
                        <span className="block truncate text-[13px] text-muted-foreground">{w.room ? `Room ${w.room}` : (s.teacher ?? '')}</span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
          <CellGrid cols={2}>
            <Stat label="Assignments" value={homework.isLoading ? '…' : assignments} icon={ClipboardCheck} hint={assignments ? 'Set so far' : 'None yet'} />
            <Stat label="Homework" value={homework.isLoading ? '…' : homeworkN} icon={BookOpenCheck} hint={homeworkN ? 'Set so far' : 'None yet'} />
            <Stat label="Projects" value={homework.isLoading ? '…' : projects} icon={FolderKanban} hint={projects ? 'Set so far' : 'None yet'} />
            <Stat label="Notes" value={materials.isLoading ? '…' : notes} icon={NotebookText} hint={notes ? 'From the teacher' : 'None yet'} />
          </CellGrid>
          {latest && <CellGrid cols={2}>
            <Stat label="Latest marks" value={`${latest.marks_obtained} / ${latest.max_marks}`} icon={TrendingUp} hint={latest.exam} />
            <Stat label="Average" value={`${Math.round(scored.reduce((a, m) => a + (m.marks_obtained ?? 0) / (m.max_marks || 1), 0) / scored.length * 100)}%`} icon={TrendingUp} hint={`${scored.length} exam${scored.length === 1 ? '' : 's'}`} />
          </CellGrid>}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:gap-6">
            <div className="flex min-w-0 flex-col gap-4 md:gap-6">
              {scored.length > 1 && <MarksTrend items={scored} />}
              <NotesList items={(materials.data?.items ?? []).filter((m) => m.subject === s.subject)} />
              <SubjectHomework items={mine} today={today} loading={homework.isLoading} error={homework.error} />
              {marks.length === 0 ? <Quiet>No marks published yet</Quiet> : (
              <Card>
                <CardHeader title="Academic performance" />
                {
                  <ul className="divide-y px-[var(--card-pad)] pb-2">
                    {marks.map((m, i) => (
                      <li key={i} className="flex min-h-[48px] items-center justify-between gap-3 py-2 text-[15px]">
                        <span className="min-w-0 truncate">{m.exam}</span>
                        <span className="shrink-0 font-semibold tabular-nums">{m.is_absent ? 'Absent' : `${m.marks_obtained ?? '-'} / ${m.max_marks ?? '-'}${m.grade ? ` · ${m.grade}` : ''}`}</span>
                      </li>
                    ))}
                  </ul>
                }
              </Card>
              )}
            </div>
          </div>
        </PageBody>
      </>
    )
  }

  return null
}

/* ASSESSMENT TREND: each published exam's score as a share of its maximum,
   in the order the school lists them. Plain bars with the real percentage. */
function MarksTrend({ items }: { items: { exam: string; marks_obtained?: number; max_marks?: number }[] }) {
  return (
    <Card>
      <CardHeader title="Assessment trend" />
      <ol className="flex items-end gap-3 overflow-hidden px-[var(--card-pad)] pb-4">
        {items.map((m, i) => {
          const pct = Math.round(((m.marks_obtained ?? 0) / (m.max_marks || 1)) * 100)
          return (
            <li key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <span className="text-[13px] font-semibold tabular-nums">{pct}%</span>
              <span className="flex h-28 w-full max-w-[56px] items-end overflow-hidden rounded-lg bg-muted">
                <span className="w-full rounded-lg bg-primary" style={{ height: `${Math.max(4, pct)}%` }} />
              </span>
              <span className="w-full truncate text-center text-[12px] text-muted-foreground" title={m.exam}>{m.exam}</span>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

/* A SUBJECT'S HOMEWORK BY DAY (owner, 2026-11-26): a date picker, today by
   default, and the work set on that day; earlier days one pick away. */
function SubjectHomework({ items, today, loading, error }: { items: Hw[]; today: string; loading: boolean; error: unknown }) {
  const [day, setDay] = useState(today)
  if (loading) return <SkeletonTiles count={2} />
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

/* A section with nothing in it: one soft line, no box. */
function Quiet({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 px-1 text-[14px] text-muted-foreground">
      <Inbox className="h-4 w-4 shrink-0" aria-hidden />{children}
    </p>
  )
}
