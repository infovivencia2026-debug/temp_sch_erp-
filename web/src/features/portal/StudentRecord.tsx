import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, GraduationCap, Printer, School, Trophy } from 'lucide-react'
import { api } from '@/lib/api'
import { ErrorState } from '@/components/ui'
import { cn } from '@/lib/utils'
import { Bar, Bone, PullToRefresh, Ring, StudentHeader, StudentPage, Tile, Trend, shortDate } from './student-kit'
import { ordinal } from './StudentResults'

/* MY SCHOOL RECORD: every year at this school, one card each, with the class,
   how the year went and how much of it was attended. The same record a
   transfer certificate is copied from (/portal/academic-record). A year whose
   report card is not published shows the class only. */

interface RecordYear {
  academic_year: string; class_name: string; section_name: string; roll_no?: number; status: string
  enrolled_on: string; percentage?: number; grade?: string; rank_in_section?: number; attendance_percent?: number
  class_teacher_remarks?: string; is_published: boolean
}
interface RecordResponse { student_name: string; admission_no: string; apaar_id?: string | null; lifetime_attendance_percent?: number; years: RecordYear[] }

const q = { queryKey: ['student-record'], queryFn: () => api.get<RecordResponse>('/api/v1/portal/academic-record') }

const STATUS: Record<string, { text: string; cls: string }> = {
  active: { text: 'This year', cls: 'bg-[color-mix(in_oklab,#6366f1_13%,transparent)] text-[#4338ca] dark:text-[#a5b4fc]' },
  promoted: { text: 'Moved up', cls: 'bg-[color-mix(in_oklab,#10b981_15%,transparent)] text-[#047857] dark:text-[#6ee7b7]' },
  completed: { text: 'Completed', cls: 'bg-[color-mix(in_oklab,#10b981_15%,transparent)] text-[#047857] dark:text-[#6ee7b7]' },
  detained: { text: 'Repeating', cls: 'bg-[color-mix(in_oklab,#f59e0b_17%,transparent)] text-[#92400e] dark:text-[#fcd34d]' },
}
const fmt = (n?: number) => (n === undefined || n === null ? '-' : Number.isInteger(n) ? String(n) : n.toFixed(1))

export default function StudentRecord() {
  const qc = useQueryClient()
  const r = useQuery(q)
  const d = r.data
  const years = [...(d?.years ?? [])].sort((a, b) => b.academic_year.localeCompare(a.academic_year))
  const scored = years.filter((y) => y.percentage !== undefined && y.percentage !== null).reverse()
  const best = scored.reduce<number | undefined>((b, y) => (b === undefined || (y.percentage ?? 0) > b ? y.percentage : b), undefined)
  const life = d?.lifetime_attendance_percent

  return (
    <PullToRefresh onRefresh={() => qc.invalidateQueries({ queryKey: q.queryKey })}>
      <StudentPage>
        <StudentHeader title="My school record" sub={d ? `${d.student_name} · ${d.admission_no}` : undefined}
          right={<button type="button" onClick={() => window.print()} aria-label="Print my record" className="card stu-press inline-flex h-11 w-11 items-center justify-center"><Printer className="h-5 w-5" strokeWidth={1.75} /></button>} />

        {r.error ? <ErrorState error={r.error} /> : !d ? (
          <div className="space-y-3"><Bone className="h-[152px] w-full rounded-2xl" /><div className="grid grid-cols-2 gap-3"><Bone className="h-[92px] rounded-2xl" /><Bone className="h-[92px] rounded-2xl" /></div><Bone className="h-[180px] w-full rounded-2xl" /></div>
        ) : (
          <>
            <section className="card stu-rise flex items-center gap-4 p-4" aria-label="Attendance over all years">
              <Ring pct={life ?? 0} hue={(life ?? 0) >= 75 ? 'emerald' : 'amber'} label={`${fmt(life)} percent attendance`}>
                <span className="text-[26px] font-bold leading-none tabular-nums">{fmt(life)}<span className="text-[15px] font-semibold">%</span></span>
                <span className="mt-1 text-[12px] font-semibold text-muted-foreground">attended</span>
              </Ring>
              <div className="min-w-0 flex-1">
                <p className="text-[18px] font-semibold leading-snug">{(life ?? 0) >= 90 ? 'You hardly miss a day!' : (life ?? 0) >= 75 ? 'Solid attendance.' : 'Every day in class counts.'}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">Across all your years here. Schools look for 75% or more.</p>
              </div>
            </section>

            <div className="grid grid-cols-2 gap-3">
              <Tile i={1} icon={School} hue="indigo" value={years.length} label={years.length === 1 ? 'year at this school' : 'years at this school'} />
              <Tile i={2} icon={Trophy} hue="amber" value={best !== undefined ? `${fmt(best)}%` : '-'} label="your best year" />
            </div>

            {scored.length > 1 && (
              <section className="card stu-rise p-4" style={{ ['--i' as string]: 3 }}>
                <h2 className="text-[16px] font-semibold">Year by year</h2>
                <div className="mt-2"><Trend points={scored.map((y) => y.percentage ?? 0)} labels={scored.map((y) => y.academic_year)} /></div>
              </section>
            )}

            <ol className="space-y-3" aria-label="Your years">
              {years.map((y, i) => {
                const st = STATUS[y.status] ?? { text: y.status, cls: 'bg-muted text-muted-foreground' }
                return (
                  <li key={y.academic_year} className="card stu-rise p-4" style={{ ['--i' as string]: i + 3 }}>
                    <div className="flex items-start gap-3">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,#6366f1_13%,transparent)] text-[#4338ca] dark:text-[#a5b4fc]"><GraduationCap className="h-5 w-5" strokeWidth={1.75} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[17px] font-semibold">{y.class_name} {y.section_name}</span>
                          <span className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-[12px] font-semibold', st.cls)}>{st.text}</span>
                        </div>
                        <p className="text-[13px] text-muted-foreground">{y.academic_year}{y.roll_no ? ` · Roll ${y.roll_no}` : ''} · joined {shortDate(y.enrolled_on)}</p>
                      </div>
                    </div>
                    {y.is_published && y.percentage !== undefined && y.percentage !== null ? (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <div>
                          <div className="flex justify-between text-[13px]"><span className="text-muted-foreground">Result</span><span className="font-semibold tabular-nums">{fmt(y.percentage)}%{y.grade ? ` · ${y.grade}` : ''}{y.rank_in_section ? ` · ${ordinal(y.rank_in_section)}` : ''}</span></div>
                          <Bar className="mt-1" pct={y.percentage} hue="indigo" />
                        </div>
                        {y.attendance_percent !== undefined && y.attendance_percent !== null && (
                          <div>
                            <div className="flex justify-between text-[13px]"><span className="inline-flex items-center gap-1 text-muted-foreground"><CalendarCheck className="h-3.5 w-3.5" /> Attendance</span><span className="font-semibold tabular-nums">{fmt(y.attendance_percent)}%</span></div>
                            <Bar className="mt-1" pct={y.attendance_percent} hue="emerald" />
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="mt-3 text-[13px] text-muted-foreground">Your result for this year appears once the school shares the report card.</p>
                    )}
                    {y.class_teacher_remarks && <p className="mt-3 rounded-xl bg-muted/60 px-3 py-2 text-[14px]">“{y.class_teacher_remarks}”</p>}
                  </li>
                )
              })}
            </ol>

            <p className="px-1 text-[12px] text-muted-foreground">Admission number {d.admission_no}{d.apaar_id ? ` · APAAR ${d.apaar_id}` : ''}</p>
          </>
        )}
      </StudentPage>
    </PullToRefresh>
  )
}
