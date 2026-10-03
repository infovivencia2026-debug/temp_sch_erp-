import { lazy, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Bone, NowNextCard, useNow, nowNext, type Period } from './student-kit'
import { cn } from '@/lib/utils'

const Timetable = lazy(() => import('../shared/Timetable'))

/* The student's timetable: today first, as a now/next card with a live
   countdown and today's classes with the current one lit, then the full week
   (the shared timetable screen) below. */
export default function StudentTimetable() {
  const s = useQuery({ queryKey: ['portal-summary', 'self'], queryFn: () => api.get<{ today: Period[] }>('/api/v1/portal/summary') })
  const now = useNow(15000)
  const periods = s.data?.today ?? []
  const { current } = nowNext(periods, now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return (
    <>
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pt-2 md:px-6 md:pt-6 lg:max-w-none lg:px-8">
        <h1 className="text-[24px] font-semibold leading-tight">Timetable</h1>
        {s.data ? <NowNextCard periods={periods} /> : <Bone className="h-[76px] w-full rounded-2xl" />}
        {periods.length > 0 && (
          <ol className="card divide-y overflow-hidden p-0" aria-label="Today">
            {periods.map((p, i) => {
              const end = p.ends_at ? Number(p.ends_at.slice(0, 2)) * 60 + Number(p.ends_at.slice(3, 5)) : null
              const past = end !== null && end <= nowMin
              const on = p === current
              return (
                <li key={i} className={cn('flex min-h-[52px] items-center gap-3 px-4 py-2', on && 'bg-[color-mix(in_oklab,var(--color-primary,#4f46e5)_8%,transparent)]', past && 'opacity-55')}>
                  <span className="w-[92px] shrink-0 text-[13px] tabular-nums text-muted-foreground">{p.starts_at}{p.ends_at ? `–${p.ends_at}` : ''}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{p.subject}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">{[p.teacher, p.room].filter(Boolean).join(' · ')}</span>
                  </span>
                  {on && <span className="rounded-full bg-primary px-2.5 py-0.5 text-[12px] font-semibold text-primary-foreground">Now</span>}
                </li>
              )
            })}
          </ol>
        )}
        <h2 className="pt-3 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">The whole week</h2>
      </div>
      <Suspense fallback={<div className="px-4"><Bone className="h-64 w-full rounded-2xl" /></div>}><Timetable embedded /></Suspense>
    </>
  )
}
