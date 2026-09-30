import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, CalendarX, ChevronLeft, ChevronRight, Flame, NotebookPen } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { ErrorState } from '@/components/ui'
import { useFeatureHref } from '@/features/bento/bento-kit'
import { cn } from '@/lib/utils'
import { Bone, PullToRefresh, Ring, StudentHeader, StudentPage, Tile, todayISO } from './student-kit'

/* MY ATTENDANCE: the year as a ring, a streak to keep going, and the month as
   a calendar of soft coloured days. Read from the same two endpoints the
   family's attendance page uses; the server answers for the student
   themselves when no student_id is sent. */

interface Summary { attendance_pct: number; present_days: number; total_days: number; absent_days: number }
interface Day { date: string; status: string; on_leave?: boolean; label?: string }

const sq = { queryKey: ['student-att-summary'], queryFn: () => api.get<Summary>('/api/v1/portal/summary') }
const dq = { queryKey: ['student-att-days'], queryFn: () => api.get<List<Day>>('/api/v1/portal/attendance') }

const TONE: Record<string, { cls: string; label: string }> = {
  present: { cls: 'bg-[color-mix(in_oklab,#10b981_22%,transparent)] text-[#047857] dark:text-[#6ee7b7]', label: 'Present' },
  late: { cls: 'bg-[color-mix(in_oklab,#f59e0b_24%,transparent)] text-[#92400e] dark:text-[#fcd34d]', label: 'Late' },
  absent: { cls: 'bg-[color-mix(in_oklab,#f43f5e_20%,transparent)] text-[#be123c] dark:text-[#fda4af]', label: 'Absent' },
  leave: { cls: 'bg-[color-mix(in_oklab,#0ea5e9_20%,transparent)] text-[#075985] dark:text-[#7dd3fc]', label: 'On leave' },
}
const toneOf = (d: Day) => (d.on_leave ? TONE.leave : TONE[d.status] ?? TONE.present)
const came = (d: Day) => d.status === 'present' || d.status === 'late'
const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export default function StudentAttendance() {
  const qc = useQueryClient()
  const s = useQuery(sq)
  const d = useQuery(dq)
  const leave = useFeatureHref('student.attendance.apply_for_leave')
  const days = [...(d.data?.items ?? [])].sort((a, b) => b.date.localeCompare(a.date))
  let streak = 0
  for (const x of days) { if (came(x)) streak++; else break }
  const byDate = new Map(days.map((x) => [x.date, x]))
  const [month, setMonth] = useState(() => todayISO().slice(0, 7))
  const months = [...new Set([todayISO().slice(0, 7), ...days.map((x) => x.date.slice(0, 7))])].sort()
  const mi = months.indexOf(month)
  const pct = s.data?.attendance_pct ?? 0
  const word = pct >= 90 ? 'Brilliant! You are here nearly every day.' : pct >= 75 ? 'Doing well. Keep it above 75%.' : "Let's get back above 75%."

  return (
    <PullToRefresh onRefresh={() => Promise.all([qc.invalidateQueries({ queryKey: sq.queryKey }), qc.invalidateQueries({ queryKey: dq.queryKey })])}>
      <StudentPage>
        <StudentHeader title="My attendance" sub={s.data ? `${s.data.total_days} school days so far this year` : undefined} />

        {s.error || d.error ? <ErrorState error={s.error ?? d.error} /> : !s.data || !d.data ? (
          <div className="space-y-3"><Bone className="h-[152px] w-full rounded-2xl" /><div className="grid grid-cols-3 gap-3">{[0, 1, 2].map((i) => <Bone key={i} className="h-[92px] rounded-2xl" />)}</div><Bone className="h-[360px] w-full rounded-2xl" /></div>
        ) : (
          <>
            <section className="card stu-rise flex items-center gap-4 p-4" aria-label="This year">
              <Ring pct={pct} hue={pct >= 75 ? 'emerald' : 'amber'} label={`${pct} percent attendance`}>
                <span className="text-[28px] font-bold leading-none tabular-nums">{pct}<span className="text-[15px] font-semibold">%</span></span>
                <span className="mt-1 text-[12px] font-semibold text-muted-foreground">this year</span>
              </Ring>
              <div className="min-w-0 flex-1">
                <p className="text-[18px] font-semibold leading-snug">{word}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">{s.data.present_days} of {s.data.total_days} days in school</p>
              </div>
            </section>

            <div className="grid grid-cols-3 gap-3">
              <Tile i={1} icon={CalendarCheck} hue="emerald" value={s.data.present_days} label="days here" />
              <Tile i={2} icon={CalendarX} hue="rose" value={s.data.absent_days} label={s.data.absent_days === 1 ? 'day missed' : 'days missed'} />
              <Tile i={3} icon={Flame} hue="amber" value={streak} label="day streak" />
            </div>

            <section className="card stu-rise p-4" style={{ ['--i' as string]: 4 }} aria-label="Month">
              <div className="flex items-center gap-2">
                <button type="button" aria-label="Previous month" disabled={mi <= 0} onClick={() => setMonth(months[mi - 1])} className="inline-flex h-11 w-11 items-center justify-center rounded-full disabled:opacity-30"><ChevronLeft className="h-5 w-5" /></button>
                <h2 className="flex-1 text-center text-[16px] font-semibold">{new Date(month + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h2>
                <button type="button" aria-label="Next month" disabled={mi >= months.length - 1} onClick={() => setMonth(months[mi + 1])} className="inline-flex h-11 w-11 items-center justify-center rounded-full disabled:opacity-30"><ChevronRight className="h-5 w-5" /></button>
              </div>
              <MonthGrid month={month} byDate={byDate} />
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground">
                {Object.values(TONE).map((t) => <span key={t.label} className="inline-flex items-center gap-1.5"><span className={cn('h-3 w-3 rounded', t.cls)} />{t.label}</span>)}
              </div>
            </section>

            {leave && (
              <Link to={leave} className="card stu-press flex min-h-[56px] items-center gap-3 px-4">
                <NotebookPen className="h-5 w-5 text-primary" strokeWidth={1.75} />
                <span className="flex-1"><span className="block text-[15px] font-medium">Going to be away?</span><span className="block text-[13px] text-muted-foreground">Ask for leave</span></span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            )}
          </>
        )}
      </StudentPage>
    </PullToRefresh>
  )
}

function MonthGrid({ month, byDate }: { month: string; byDate: Map<string, Day> }) {
  const first = new Date(month + '-01T00:00:00')
  const lead = (first.getDay() + 6) % 7
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const today = todayISO()
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)]
  while (cells.length % 7) cells.push(null)
  return (
    <div className="mt-2 grid grid-cols-7 gap-1.5 text-center">
      {WEEK.map((w, i) => <span key={i} className="pb-1 text-[12px] font-semibold text-muted-foreground">{w}</span>)}
      {cells.map((n, i) => {
        if (n === null) return <span key={i} />
        const iso = `${month}-${String(n).padStart(2, '0')}`
        const day = byDate.get(iso)
        const t = day ? toneOf(day) : null
        return (
          <span key={i} title={day ? `${t!.label}${day.label ? ` · ${day.label}` : ''}` : undefined}
            className={cn('flex aspect-square min-h-[40px] items-center justify-center rounded-xl text-[14px] font-medium tabular-nums', t ? t.cls : 'text-muted-foreground', iso === today && 'ring-2 ring-primary ring-offset-1 ring-offset-[var(--color-card,white)]')}>
            {n}
          </span>
        )
      })}
    </div>
  )
}
