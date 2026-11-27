import { useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, CalendarDays, ClipboardCheck, TrendingUp } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, CellGrid, Stat, EmptyState, ErrorState, Input, SkeletonTiles } from '@/components/ui'
import { formatDate, cn, WEEKDAYS } from '@/lib/utils'
import Homework from '@/features/workflow/Homework'
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
  const results = useQuery({
    queryKey: ['portal-results', sid],
    queryFn: () => api.get<ResultView>(`/api/v1/portal/results?student_id=${sid}`),
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
    return (
      <>
        {head}
        <PageBody>
          {/* THE SUBJECT (owner, 2026-11-27, after the subject-workspace
              mockup): the subject and its teacher, three facts, then only the
              sections the school has data for. Attendance by subject, topic
              mastery and resources are left out: nothing records them. */}
          <Card className="relative overflow-hidden p-4 sm:p-6">
            <span aria-hidden className="absolute inset-x-0 top-0 h-1.5 bg-primary" />
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 items-center gap-4">
                <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary"><BookOpen className="h-7 w-7" strokeWidth={1.8} aria-hidden /></span>
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Subject</p>
                  <h2 className="break-words text-[24px] font-extrabold leading-tight tracking-[-0.02em] sm:text-[28px]">{s.subject}</h2>
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-3 rounded-2xl border bg-muted/40 p-3 md:min-w-[260px]">
                <ChildAvatar name={s.teacher ?? '?'} photo={s.teacher_photo} size="md" />
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Subject teacher</p>
                  <p className="truncate text-[16px] font-semibold leading-snug">{s.teacher ?? 'Not assigned yet'}</p>
                </div>
              </div>
            </div>
          </Card>
          <CellGrid cols={3}>
            <Stat label="Periods per week" value={s.periods_per_week || '-'} icon={CalendarDays} />
            <Stat label="Homework set" value={homework.isLoading ? '…' : mine.length} icon={ClipboardCheck} />
            <Stat label="Latest marks" value={results.isLoading ? '…' : latest ? `${latest.marks_obtained} / ${latest.max_marks}` : '-'} icon={TrendingUp}
              hint={latest?.exam} />
          </CellGrid>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex min-w-0 flex-col gap-4 md:gap-6">
              {scored.length > 1 && <MarksTrend items={scored} />}
              <SubjectHomework items={mine} today={today} loading={homework.isLoading} error={homework.error} />
              <Card>
                <CardHeader title="Academic performance" />
                {results.isLoading ? <SkeletonTiles count={2} /> : marks.length === 0 ? (
                  <p className="px-[var(--card-pad)] pb-4 text-[15px] text-muted-foreground">No marks published yet.</p>
                ) : (
                  <ul className="divide-y px-[var(--card-pad)] pb-2">
                    {marks.map((m, i) => (
                      <li key={i} className="flex min-h-[48px] items-center justify-between gap-3 py-2 text-[15px]">
                        <span className="min-w-0 truncate">{m.exam}</span>
                        <span className="shrink-0 font-semibold tabular-nums">{m.is_absent ? 'Absent' : `${m.marks_obtained ?? '-'} / ${m.max_marks ?? '-'}${m.grade ? ` · ${m.grade}` : ''}`}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <Card className="h-fit min-w-0">
              <CardHeader title="This week" />
              {entries.isLoading || periods.isLoading ? <SkeletonTiles count={2} /> : week.length === 0 ? (
                <p className="px-[var(--card-pad)] pb-4 text-[15px] text-muted-foreground">No periods on the timetable yet.</p>
              ) : (
                <ul className="divide-y px-[var(--card-pad)] pb-2">
                  {week.map((w, i) => (
                    <li key={i} className={cn('flex min-h-[48px] items-center gap-3 py-2 text-[15px]', w.day === todayDay && 'font-semibold')}>
                      <span className={cn('w-12 shrink-0 rounded-full py-0.5 text-center text-[13px] font-semibold', w.day === todayDay ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{WEEKDAYS[w.day - 1] ?? w.day}</span>
                      <span className="min-w-0 flex-1 truncate">{w.p?.name ?? 'Period'}{w.room ? ` · ${w.room}` : ''}</span>
                      {w.p?.starts_at && <span className="shrink-0 tabular-nums text-muted-foreground">{w.p.starts_at.slice(0, 5)}{w.p.ends_at ? `–${w.p.ends_at.slice(0, 5)}` : ''}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
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
        ? <p className="px-[var(--card-pad)] pb-4 text-[15px] text-muted-foreground">{day === today ? 'No homework set today.' : 'No homework set on this day.'}</p>
        : <HwList items={onDay} />}
    </Card>
  )
}

function HwList({ items }: { items: Hw[] }) {
  return (
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
          <p className="mt-1 text-[13px] text-muted-foreground">Set {formatDate(h.assigned_on)}{h.teacher ? ` · ${h.teacher}` : ''}</p>
        </li>
      ))}
    </ul>
  )
}
