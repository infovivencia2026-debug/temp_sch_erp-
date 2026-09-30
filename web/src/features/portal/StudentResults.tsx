import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Award, CalendarCheck, ChevronRight, FileText, Medal, Star, TrendingUp } from 'lucide-react'
import { api } from '@/lib/api'
import { ErrorState } from '@/components/ui'
import CardViewer from '@/components/CardViewer'
import { useFeatureHref } from '@/features/bento/bento-kit'
import { cn } from '@/lib/utils'
import { Bar, Bone, PullToRefresh, Ring, StudentHeader, StudentPage, Tile, Trend, shortDate, type Hue } from './student-kit'

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

  return (
    <PullToRefresh onRefresh={() => qc.invalidateQueries({ queryKey: q.queryKey })}>
      <StudentPage>
        <StudentHeader title="My results" sub={current ? `${current.exam}${current.published_at ? ` · shared ${shortDate(current.published_at)}` : ''}` : r.data ? 'Nothing shared yet' : undefined} />

        {r.error ? <ErrorState error={r.error} /> : !r.data ? (
          <div className="space-y-3"><Bone className="h-[152px] w-full rounded-2xl" /><div className="grid grid-cols-3 gap-3">{[0, 1, 2].map((i) => <Bone key={i} className="h-[92px] rounded-2xl" />)}</div><Bone className="h-[260px] w-full rounded-2xl" /></div>
        ) : !current ? (
          <div className="card stu-rise px-5 py-10 text-center">
            <Award className="mx-auto h-10 w-10 text-muted-foreground" strokeWidth={1.5} />
            <p className="mt-3 text-[16px] font-semibold">No results yet</p>
            <p className="mt-1 text-[14px] text-muted-foreground">When your school shares a report card, your marks will show up here.</p>
          </div>
        ) : (
          <>
            {cards.length > 1 && (
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Exam">
                {[...cards].reverse().map((x) => (
                  <button key={x.id} type="button" role="tab" aria-selected={x.id === current.id} onClick={() => setPicked(x.id)}
                    className={cn('min-h-[44px] shrink-0 rounded-full border px-4 text-[14px] font-medium', x.id === current.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-[var(--color-card,white)]')}>
                    {x.exam}
                  </button>
                ))}
              </div>
            )}

            <section className="card stu-rise flex items-center gap-4 p-4" aria-label="Score">
              <Ring pct={p} hue={c.hue} label={`${fmt(p)} percent`}>
                <span className="text-[26px] font-bold leading-none tabular-nums">{fmt(p)}<span className="text-[15px] font-semibold">%</span></span>
                {current.grade && <span className="mt-1 text-[12px] font-semibold text-muted-foreground">Grade {current.grade}</span>}
              </Ring>
              <div className="min-w-0 flex-1">
                <p className="text-[18px] font-semibold leading-snug">{c.text}</p>
                <p className="mt-1 text-[13px] text-muted-foreground tabular-nums">{fmt(current.total_marks)} out of {fmt(current.max_marks)} marks</p>
                {best && <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,#f59e0b_16%,transparent)] px-2.5 py-1 text-[12px] font-semibold text-[#92400e] dark:text-[#fcd34d]"><Star className="h-3.5 w-3.5" /> Strongest: {best.subject}</p>}
              </div>
            </section>

            <div className="grid grid-cols-3 gap-3">
              <Tile i={1} icon={Medal} hue="amber" value={current.rank_in_section ? ordinal(current.rank_in_section) : '-'} label="in your class" />
              <Tile i={2} icon={CalendarCheck} hue="emerald" value={current.attendance_percent !== undefined ? `${fmt(current.attendance_percent)}%` : '-'} label="attendance" />
              <Tile i={3} icon={FileText} hue="sky" value={subjects.length} label={subjects.length === 1 ? 'subject' : 'subjects'} />
            </div>

            <section className="card stu-rise p-4" style={{ ['--i' as string]: 3 }} aria-label="Subjects">
              <h2 className="text-[16px] font-semibold">Subject by subject</h2>
              <ul className="mt-3 space-y-3.5">
                {subjects.map((s) => {
                  const sp = pctOf(s)
                  return (
                    <li key={s.subject}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate text-[15px] font-medium">{s.subject}</span>
                        <span className="shrink-0 text-[14px] tabular-nums text-muted-foreground">
                          {s.is_absent ? 'Absent' : <><span className="font-semibold text-foreground">{fmt(s.marks_obtained)}</span> / {fmt(s.max_marks)}</>}
                        </span>
                      </div>
                      <Bar className="mt-1.5" pct={s.is_absent ? 0 : sp} hue={sp >= 85 ? 'emerald' : sp >= 60 ? 'indigo' : sp >= 40 ? 'sky' : 'amber'} />
                    </li>
                  )
                })}
                {!subjects.length && <li className="text-[14px] text-muted-foreground">Subject marks for this exam are not shared yet.</li>}
              </ul>
            </section>

            <section className="card stu-rise p-4" style={{ ['--i' as string]: 4 }} aria-label="Trend">
              <h2 className="flex items-center gap-2 text-[16px] font-semibold"><TrendingUp className="h-[18px] w-[18px] text-primary" strokeWidth={1.75} /> How you are growing</h2>
              {cards.length > 1 ? (
                <>
                  <div className="mt-2"><Trend points={cards.map((x) => x.percentage ?? 0)} labels={cards.map((x) => x.exam)} /></div>
                  <div className="mt-1 flex justify-between gap-2 text-[12px] text-muted-foreground">{cards.map((x) => <span key={x.id} className="truncate">{x.exam}</span>)}</div>
                </>
              ) : (
                <p className="mt-1 text-[14px] text-muted-foreground">After your next exam, a line here will show how your scores change.</p>
              )}
            </section>

            {current.class_teacher_remarks && (
              <section className="card stu-rise p-4" style={{ ['--i' as string]: 5 }}>
                <h2 className="text-[16px] font-semibold">From your class teacher</h2>
                <p className="mt-1 text-[15px] leading-relaxed">“{current.class_teacher_remarks}”</p>
              </section>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={openCard} disabled={opening} className="card stu-press flex min-h-[56px] items-center gap-3 px-4 text-left">
                <FileText className="h-5 w-5 text-primary" strokeWidth={1.75} />
                <span className="flex-1 text-[15px] font-medium">{opening ? 'Opening…' : 'Open my report card'}</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
              {record && (
                <Link to={record} className="card stu-press flex min-h-[56px] items-center gap-3 px-4">
                  <Award className="h-5 w-5 text-primary" strokeWidth={1.75} />
                  <span className="flex-1 text-[15px] font-medium">My school record</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </Link>
              )}
            </div>
          </>
        )}
      </StudentPage>
      {viewer && <CardViewer card={viewer} onClose={() => setViewer(null)} />}
    </PullToRefresh>
  )
}
