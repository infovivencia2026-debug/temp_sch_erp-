import { lazy, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Bone, NowNextCard, type Period } from './student-kit'
import DayTimeline from '@/components/DayTimeline'
import { todayTimeline } from '@/lib/todayTimeline'

const Timetable = lazy(() => import('../shared/Timetable'))

/* The student's timetable: today first, as a now/next card with a live
   countdown and today's classes with the current one lit, then the full week
   (the shared timetable screen) below. */
export default function StudentTimetable() {
  const s = useQuery({ queryKey: ['portal-summary', 'self'], queryFn: () => api.get<{ today: Period[] }>('/api/v1/portal/summary') })
  const periods = s.data?.today ?? []
  return (
    <>
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pt-2 md:px-6 md:pt-6 lg:max-w-none lg:px-8">
        <h1 className="text-[24px] font-semibold leading-tight">Timetable</h1>
        {s.data ? <NowNextCard periods={periods} /> : <Bone className="h-[76px] w-full rounded-2xl" />}
        {periods.length > 0 && (
          /* Today as the shared timeline, like the teacher and parent homes (Yajur, 2026-10-24). */
          <div className="card overflow-hidden p-0" aria-label="Today">
            <DayTimeline bare todayOnly breaks={false} who="" where="" {...todayTimeline(periods)} />
          </div>
        )}
        <h2 className="pt-3 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">The whole week</h2>
      </div>
      <Suspense fallback={<div className="px-4"><Bone className="h-64 w-full rounded-2xl" /></div>}><Timetable embedded /></Suspense>
    </>
  )
}
