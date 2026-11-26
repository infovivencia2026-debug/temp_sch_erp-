import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, NotebookPen } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, CellGrid, Stat, EmptyState, ErrorState, SkeletonTiles } from '@/components/ui'
import { formatDate, cn } from '@/lib/utils'
import Homework from '@/features/workflow/Homework'
import { useChildren } from './use-children'
import { useChildProfile, useParentYear, type ChildSubject } from './parent-child'
import { ChildAvatar, SubjectCards } from './ParentChildCard'

/* THE PARENT'S ACADEMICS (owner, 2026-11-26). One screen behind the menu's
   Homework, Subjects and ECA entries, picked by `?view=`:

     (none)    Homework: a card per subject; a subject shows its current work
               with the earlier work under it.
     subjects  The child's subjects as cards.
     subject   One subject: its teacher with photo, periods a week, homework
               and marks.
     eca       The extra-curricular activities the child is enrolled in.
     diary     The full homework diary (by day, with handing work in), as
               before. */

interface Hw {
  id: string; title: string; kind: string; subject?: string; assigned_on: string; due_on?: string
  instructions?: string; submitted: boolean; overdue: boolean; teacher?: string; student_id?: string
}
interface ResultView { subjects: { exam: string; subject: string; marks_obtained?: number; max_marks?: number; grade?: string; is_absent: boolean }[] }

const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const isCurrent = (h: Hw, today: string) => h.assigned_on.slice(0, 10) === today || (!!h.due_on && h.due_on >= today && !h.submitted)

export default function ParentAcademics() {
  const [params] = useSearchParams()
  const view = params.get('view') ?? ''
  if (view === 'diary') return <Homework />
  return <Academics view={view} />
}

function Academics({ view }: { view: string }) {
  const [params] = useSearchParams()
  const { children, chosen } = useChildren()
  const asked = params.get('student_id') ?? ''
  const ids = children.map((c) => c.student_id)
  const sid = (asked && ids.includes(asked) ? asked : chosen && ids.includes(chosen) ? chosen : ids[0]) ?? ''
  const [year] = useParentYear()
  const profile = useChildProfile(sid || null, year)
  const homework = useQuery({
    queryKey: ['homework', 'diary', false],
    queryFn: () => api.get<List<Hw>>('/api/v1/homework'),
    enabled: view === '' || view === 'subject',
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
        <PageHead title="Subjects" />
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
    if (!s) return <><PageHead title="Subject" /><PageBody><Back to={keep({ view: 'subjects' })} label="All subjects" /><EmptyState title="Subject not found" body="Pick a subject from the list." /></PageBody></>
    const mine = hw.filter((h) => h.subject === s.subject).sort((a, b) => b.assigned_on.localeCompare(a.assigned_on))
    const marks = (results.data?.subjects ?? []).filter((m) => m.subject === s.subject)
    return (
      <>
        <PageHead title={s.subject} />
        <PageBody>
          <Back to={keep({ view: 'subjects' })} label="All subjects" />
          <CellGrid cols={2}>
            <Stat label="Periods per week" value={s.periods_per_week || '-'} />
            <Stat label="Homework set" value={mine.length} />
          </CellGrid>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <ChildAvatar name={s.teacher ?? '?'} photo={s.teacher_photo} size="md" />
              <div className="min-w-0">
                <p className="truncate text-[16px] font-semibold">{s.teacher ?? 'Teacher not assigned yet'}</p>
                <p className="text-[14px] text-muted-foreground">Subject teacher</p>
              </div>
            </div>
          </Card>
          <HomeworkLists items={mine} today={today} loading={homework.isLoading} error={homework.error} />
          <Card>
            <CardHeader title="Marks" />
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
        </PageBody>
      </>
    )
  }

  /* Homework. */
  const subj = params.get('subject')
  if (subj) {
    const mine = hw.filter((h) => (h.subject ?? 'Other') === subj).sort((a, b) => b.assigned_on.localeCompare(a.assigned_on))
    return (
      <>
        <PageHead title={subj} />
        <PageBody>
          <Back to={keep({})} label="All subjects" />
          <HomeworkLists items={mine} today={today} loading={homework.isLoading} error={homework.error} />
        </PageBody>
      </>
    )
  }
  /* A card per subject the class takes, plus any subject that has homework
     but is not on the class list (so no work is ever out of reach). */
  const names = [...subjects.map((s) => s.subject), ...hw.map((h) => h.subject ?? 'Other').filter((n) => !subjects.some((s) => s.subject === n))]
  const cards: ChildSubject[] = [...new Set(names)].map((n) => subjects.find((s) => s.subject === n) ?? { class_subject_id: `x-${n}`, subject: n, periods_per_week: 0 })
  return (
    <>
      <PageHead title="Homework" />
      <PageBody>
        {homework.error && !homework.data ? <ErrorState error={homework.error} /> : (
          <SubjectCards subjects={cards} hrefFor={(s) => keep({ subject: s.subject })}
            note={(s) => {
              const n = hw.filter((h) => (h.subject ?? 'Other') === s.subject && isCurrent(h, today)).length
              return n ? `${n} current` : 'Nothing current'
            }} />
        )}
        <Link to={keep({ view: 'diary' })} className="inline-flex min-h-[48px] items-center gap-2 text-[15px] font-medium text-primary">
          <NotebookPen className="h-4 w-4" aria-hidden /> Day-by-day diary and handing work in
        </Link>
      </PageBody>
    </>
  )
}

function Back({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex min-h-[48px] items-center gap-1 text-[15px] font-medium text-primary">
      <ChevronLeft className="h-4 w-4" aria-hidden /> {label}
    </Link>
  )
}

function HomeworkLists({ items, today, loading, error }: { items: Hw[]; today: string; loading: boolean; error: unknown }) {
  if (loading) return <SkeletonTiles count={2} />
  if (error && !items.length) return <ErrorState error={error} />
  const current = items.filter((h) => isCurrent(h, today))
  const earlier = items.filter((h) => !isCurrent(h, today))
  return (
    <>
      <Card>
        <CardHeader title="Current homework" />
        {current.length === 0 ? <p className="px-[var(--card-pad)] pb-4 text-[15px] text-muted-foreground">Nothing set right now.</p> : <HwList items={current} />}
      </Card>
      <Card>
        <CardHeader title="Earlier homework" />
        {earlier.length === 0 ? <p className="px-[var(--card-pad)] pb-4 text-[15px] text-muted-foreground">None yet.</p> : <HwList items={earlier} />}
      </Card>
    </>
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
