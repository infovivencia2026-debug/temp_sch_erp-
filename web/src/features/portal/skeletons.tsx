import { Skeleton, useDelayed } from '@/components/Skeleton'
import { PageBody } from '@/components/ui'

/* PLACEHOLDERS IN THE SHAPE OF THE PARENT SCREENS THEY STAND FOR.
   Each one copies the real screen's grid, card frames and paddings (see
   Portal.tsx and ParentChildCard.tsx) so nothing moves when the data lands:
   the child card where the child card goes, a photo circle where the photo
   goes, two figure cells, the messages card, then the subject rows/cards. */

function Says({ label }: { label?: string }) {
  return <p role="status" aria-live="polite" className="sr-only">{label ?? 'Loading…'}</p>
}

/** The child card's insides: photo circle, name, class chip, the info tiles. */
export function ChildCardSkeleton() {
  return (
    <div aria-hidden className="relative isolate flex h-full flex-col overflow-hidden rounded-2xl bg-primary/10 p-4 shadow-md sm:p-5 lg:justify-center lg:p-7">
      <div className="flex min-w-0 items-center gap-4 lg:flex-col lg:gap-3">
        <Skeleton className="h-[108px] w-[84px] shrink-0 !rounded-xl lg:h-[170px] lg:w-[132px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 lg:items-center">
          <Skeleton className="h-6 w-40 max-w-full" />
          <Skeleton className="h-4 w-24 lg:h-7" round="full" />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,9.5rem),1fr))] gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex min-h-[58px] flex-col justify-center gap-1.5 rounded-xl bg-card/60 px-3 py-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
      <div className="mt-auto hidden gap-2 pt-5 lg:grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex flex-col items-center gap-1.5 rounded-[14px] border px-2 py-2.5">
            <Skeleton className="h-5 w-10" />
            <Skeleton className="h-2.5 w-14" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Subjects: one boxed list of rows on a phone, a grid of cards wider (with
    the three homework / notes / marks boxes when the real cards carry them). */
export function SubjectCardsSkeleton({ n = 6, wide = true }: { n?: number; wide?: boolean }) {
  return (
    <div aria-hidden>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-sm sm:hidden">
        {Array.from({ length: n }, (_, i) => (
          <li key={i} className="flex min-h-[64px] items-center gap-4 px-4 py-3">
            <Skeleton className="size-10 shrink-0 !rounded-xl" />
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-4" style={{ width: `${48 - (i % 3) * 8}%` }} />
              <Skeleton className="h-3" style={{ width: `${34 - (i % 2) * 8}%` }} />
            </span>
          </li>
        ))}
      </ul>
      <ul className={wide ? 'hidden gap-3 sm:grid sm:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]' : 'hidden gap-3 sm:grid sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'}>
        {Array.from({ length: n }, (_, i) => (
          <li key={i} className="flex min-h-[92px] flex-col gap-3 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
            <span className="flex items-center gap-3">
              <Skeleton className="size-10 shrink-0 !rounded-xl" />
              <span className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4" style={{ width: `${70 - (i % 3) * 12}%` }} />
                <Skeleton className="h-3 w-1/2" />
              </span>
            </span>
            {wide && (
              <span className="grid grid-cols-3 gap-1.5">
                {[0, 1, 2].map((k) => <Skeleton key={k} className="h-[60px] !rounded-lg opacity-70" />)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The parent's home before the child list has answered. */
export function ParentHomeSkeleton({ delay }: { delay?: number }) {
  const show = useDelayed(true, delay)
  if (!show) return null
  return (
    <PageBody top width="full">
      <div aria-hidden className="grid grid-cols-[minmax(0,1fr)] gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 lg:order-2"><ChildCardSkeleton /></div>
        <div className="flex min-w-0 flex-col gap-4 md:gap-6 lg:order-1">
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="flex min-h-[92px] flex-col justify-center gap-2 rounded-[var(--radius-card)] border bg-card px-[14px] py-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-24" />
                <Skeleton className="h-2.5 w-16" />
              </div>
            ))}
          </div>
          <div className="flex min-h-[440px] flex-col rounded-[var(--radius-card)] border bg-card lg:min-h-[480px]">
            <div className="flex justify-center border-b px-4 pb-4 pt-5">
              <Skeleton className="h-[56px] w-full max-w-[360px]" round="full" />
            </div>
            <MessageRowsSkeleton />
          </div>
        </div>
      </div>
      <section aria-hidden className="space-y-3">
        <Skeleton className="h-5 w-24" />
        <SubjectCardsSkeleton />
      </section>
      <Says />
    </PageBody>
  )
}

/** The attendance register card: header with month picker, the figure cells
    (two columns, one beside the month on a desktop) and the month grid. */
export function AttendanceReportSkeleton({ delay }: { delay?: number }) {
  const show = useDelayed(true, delay)
  if (!show) return null
  return (
    <>
      <Says />
      <div aria-hidden className="rounded-[var(--radius-card)] border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-9 w-44" />
        </div>
        <div className="grid gap-5 px-5 py-4 lg:grid-cols-[220px_1fr]">
          <div className="grid content-start grid-cols-2 gap-3 lg:grid-cols-1">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-xl border px-4 py-3">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
          <div className="min-w-0">
            <div className="grid grid-cols-7 gap-1.5">
              {Array.from({ length: 42 }, (_, i) => (
                <Skeleton key={i} className="aspect-square w-full" />
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-3 border-t pt-3">
              {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-3 w-16" round="full" />)}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/** The school's messages: a card per notice with its icon square, title and
    date, the type chip and two lines of text. */
export function MessageRowsSkeleton({ n = 4 }: { n?: number }) {
  return (
    <ul aria-hidden className="space-y-2.5 px-3 pb-3 pt-1">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="flex items-start gap-3 rounded-xl border bg-card px-3.5 py-3 shadow-sm">
          <Skeleton className="mt-0.5 size-10 shrink-0" round="card" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5" style={{ width: `${62 - (i % 3) * 12}%` }} />
              <span className="flex-1" />
              <Skeleton className="h-2.5 w-10" />
            </div>
            <Skeleton className="h-4 w-16" round="full" />
            <Skeleton className="h-2.5 w-11/12" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Today's homework: subject chip, then title and instructions. */
export function HomeworkRowsSkeleton({ n = 2 }: { n?: number }) {
  return (
    <ul aria-hidden className="space-y-2.5 px-3 pb-3 pt-1">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="flex min-h-[56px] items-start gap-3 rounded-xl border bg-card px-3.5 py-3 shadow-sm">
          <Skeleton className="mt-0.5 h-6 w-20 shrink-0" round="full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-2.5 w-5/6" />
          </div>
        </li>
      ))}
    </ul>
  )
}
