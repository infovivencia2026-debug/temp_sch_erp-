import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Award, ChevronRight, FileText } from 'lucide-react'
import { api } from '@/lib/api'
import { ErrorState } from '@/components/ui'
import CardViewer from '@/components/CardViewer'
import { useFeatureHref } from '@/features/bento/bento-kit'
import { cn } from '@/lib/utils'
import { Bone, PullToRefresh, StudentPage, type Hue } from './student-kit'

/* MY RESULTS, for a student of ten to sixteen.

   The same published report cards the family sees (/portal/results), said
   the way a child reads them: the latest score as a ring, a word of
   encouragement that is honest about the number, each subject as a bar, and
   the line of scores across exams once there are two. Nothing provisional is
   shown; the server only returns what the school has published. */

interface ReportCard {
  id: string; exam: string; total_marks?: number; max_marks?: number; percentage?: number
  grade?: string; rank_in_section?: number; attendance_percent?: number; class_teacher_remarks?: string; published_at?: string
}
interface SubjectMark { exam: string; subject: string; marks_obtained?: number; max_marks?: number; grade?: string; is_absent: boolean }
interface ResultView { cards: ReportCard[]; subjects: SubjectMark[]; published: boolean }

const q = { queryKey: ['student-results'], queryFn: () => api.get<ResultView>('/api/v1/portal/results') }

export function cheer(p: number): { text: string; hue: Hue } {
  if (p >= 85) return { text: 'Outstanding work!', hue: 'emerald' }
  if (p >= 70) return { text: 'Great job, keep it up!', hue: 'indigo' }
  if (p >= 50) return { text: 'Good going. A little more each week adds up.', hue: 'sky' }
  return { text: 'Keep at it. Ask your teacher where to start.', hue: 'amber' }
}
export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
const pctOf = (m: SubjectMark) => (m.max_marks ? ((m.marks_obtained ?? 0) / m.max_marks) * 100 : 0)
const fmt = (n?: number) => (n === undefined || n === null ? '-' : Number.isInteger(n) ? String(n) : n.toFixed(1))

export default function StudentResults() {
  const qc = useQueryClient()
  const r = useQuery(q)
  const record = useFeatureHref('student.exams_results.academic_record')
  const cards = [...(r.data?.cards ?? [])].sort((a, b) => (a.published_at ?? '').localeCompare(b.published_at ?? ''))
  const [picked, setPicked] = useState<string | null>(null)
  const [viewer, setViewer] = useState<{ html: string; css?: string; name?: string } | null>(null)
  const [opening, setOpening] = useState(false)
  const latest = cards[cards.length - 1]
  const current = cards.find((c) => c.id === picked) ?? latest
  const subjects = (r.data?.subjects ?? []).filter((s) => s.exam === current?.exam)
  const best = subjects.filter((s) => !s.is_absent).sort((a, b) => pctOf(b) - pctOf(a))[0]
  const p = current?.percentage ?? 0
  const c = cheer(p)

  const openCard = async () => {
    if (!current) return
    setOpening(true)
    try { setViewer({ ...(await api.get<{ html: string; css?: string }>(`/api/v1/portal/results/card?id=${current.id}`)), name: current.exam }) } finally { setOpening(false) }
  }

  /* THE OWNER'S LAYOUT: a segmented switch across the exams, one result card
     with the total and a score ring, then every subject as a card with its
     grade and a bar. The latest exam is chosen to begin with. */
  const ay = (iso?: string) => {
    const t = iso ? new Date(iso) : new Date()
    const y = t.getMonth() >= 3 ? t.getFullYear() : t.getFullYear() - 1
    return `${y}–${String((y + 1) % 100).padStart(2, '0')}`
  }
  const cleared = subjects.filter((x) => !x.is_absent && pctOf(x) >= 35).length
  const passed = p >= 35
  const R = 45, C = 2 * Math.PI * R

  return (
    <PullToRefresh onRefresh={() => qc.invalidateQueries({ queryKey: q.queryKey })}>
      <StudentPage>
        {viewer && <CardViewer card={viewer} onClose={() => setViewer(null)} />}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
          <h1 className="text-[24px] font-extrabold tracking-[-0.03em]">My examination results</h1>
          <span className="rounded-full border bg-card px-3.5 py-1.5 text-[13px] font-semibold text-muted-foreground shadow-sm">
            {ay(current?.published_at)} session
          </span>
        </div>

        {r.error ? <ErrorState error={r.error} /> : !r.data ? (
          <div className="space-y-3"><Bone className="h-12 w-full rounded-2xl" /><Bone className="h-[170px] w-full rounded-2xl" /><Bone className="h-[260px] w-full rounded-2xl" /></div>
        ) : !current ? (
          <div className="card stu-rise px-5 py-10 text-center">
            <Award className="mx-auto h-10 w-10 text-muted-foreground" strokeWidth={1.5} />
            <p className="mt-3 text-[16px] font-semibold">No results shared yet</p>
            <p className="mt-1 text-[14px] text-muted-foreground">Your marks appear here once the school publishes a report card.</p>
          </div>
        ) : (
          <>
            {/* The exams, one tap apart, newest first. */}
            <nav className="flex gap-1 overflow-x-auto rounded-[14px] bg-muted p-1.5">
              {[...cards].reverse().map((x) => (
                <button key={x.id} type="button" onClick={() => setPicked(x.id)}
                  className={cn('min-h-[40px] flex-1 whitespace-nowrap rounded-[10px] px-4 py-2 text-[13.5px] font-semibold transition-all',
                    x.id === current.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  {x.exam}
                </button>
              ))}
            </nav>

            <section className="relative flex flex-col-reverse items-center gap-6 overflow-hidden rounded-[20px] border bg-card px-9 py-8 shadow-md sm:flex-row sm:justify-between">
              <span aria-hidden className={cn('absolute inset-y-0 left-0 hidden w-1 sm:block', passed ? 'bg-[#16a34a]' : 'bg-[#d97706]')} />
              <div className="flex flex-col items-center gap-3 sm:items-start">
                <span className={cn('inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-bold tracking-[0.04em]',
                  passed ? 'border-[#bbf7d0] bg-[#f0fdf4] text-[#16a34a]' : 'border-[#fde68a] bg-[#fffbeb] text-[#b45309]')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', passed ? 'bg-[#16a34a]' : 'bg-[#d97706]')} />
                  {passed ? 'PASSED' : 'NEEDS IMPROVEMENT'}
                </span>
                <div className="text-[38px] font-extrabold leading-none tracking-[-0.03em]">
                  {fmt(current.total_marks)} <span className="text-[20px] font-medium text-muted-foreground">/ {fmt(current.max_marks)}</span>
                </div>
                <div className="mt-1 flex gap-7">
                  {[
                    [current.rank_in_section ? `#${current.rank_in_section}` : '-', 'Class rank'],
                    [current.grade ?? '-', 'Grade'],
                    [`${cleared} / ${subjects.length}`, 'Subjects cleared'],
                  ].map(([v, l]) => (
                    <div key={l} className="flex flex-col">
                      <span className="text-[16px] font-bold">{v}</span>
                      <span className="text-[12px] text-muted-foreground">{l}</span>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={openCard} disabled={opening}
                  className="mt-1 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary disabled:opacity-60">
                  <FileText className="h-4 w-4" /> {opening ? 'Opening…' : 'View report card'} <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="relative h-[110px] w-[110px] shrink-0">
                <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                  <circle cx="50" cy="50" r={R} fill="none" strokeWidth="9" className="stroke-muted" />
                  <circle cx="50" cy="50" r={R} fill="none" strokeWidth="9" strokeLinecap="round" className="stroke-primary"
                    strokeDasharray={C} strokeDashoffset={C - (C * Math.min(100, p)) / 100} />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center text-[20px] font-extrabold">
                  {fmt(p)}%
                  <span className="text-[10px] font-bold tracking-[0.05em] text-muted-foreground">TOTAL</span>
                </div>
              </div>
            </section>

            <div className="pt-2 text-[13px] font-bold uppercase tracking-[0.06em] text-muted-foreground">Subject scores</div>
            <div className="grid gap-4 sm:grid-cols-2">
              {subjects.map((x, k) => {
                const sp = pctOf(x)
                const strong = sp >= 85
                return (
                  <div key={x.subject} className={cn('rounded-2xl border bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md',
                    subjects.length % 2 === 1 && k === subjects.length - 1 && 'sm:col-span-2')}>
                    <div className="mb-4 flex items-center justify-between">
                      <span className="text-[15px] font-bold">{x.subject}</span>
                      {x.grade && <span className={cn('rounded-md px-2 py-0.5 text-[12px] font-bold', strong ? 'bg-primary/10 text-primary' : 'bg-muted')}>Grade {x.grade}</span>}
                    </div>
                    {x.is_absent ? (
                      <p className="text-[14px] font-semibold text-[#b45309]">Absent</p>
                    ) : (
                      <>
                        <div className="mb-2 flex items-baseline justify-between">
                          <div className="text-[24px] font-extrabold tracking-[-0.02em]">
                            {fmt(x.marks_obtained)} <span className="text-[13px] font-medium text-muted-foreground">/ {fmt(x.max_marks)}</span>
                          </div>
                          <span className="text-[13px] font-semibold text-muted-foreground">{Math.round(sp)}%</span>
                        </div>
                        <div className="h-[7px] w-full overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, sp)}%` }} />
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
            {best && !best.is_absent && (
              <p className="pt-1 text-[13px] text-muted-foreground">Best subject: <b className="text-foreground">{best.subject}</b> · {c.text}</p>
            )}
            {record && (
              <Link to={record} className="inline-flex items-center gap-1 text-[13px] font-semibold text-primary">All years <ChevronRight className="h-3.5 w-3.5" /></Link>
            )}
          </>
        )}
      </StudentPage>
    </PullToRefresh>
  )
}
