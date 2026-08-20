import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/* THE SMOKE TEST.

   The simplest dashboard in the product, rendered in the Bento language, for
   one purpose: to prove the switch reaches a screen end to end while every
   other key in the catalogue falls through to classic. It is not the finished
   article and it is not meant to be — a later worker replaces this file, and
   the entry in bento-registry.ts stays exactly as it is.

   It reads the same `/api/v1/teaching/my-work` endpoint the classic screen
   reads. No new endpoint, no second implementation of the data: a Bento cell
   is a different rendering of a figure the account may already see, and
   anything it cannot see the API still refuses.

   Everything here is local. Nothing is imported from `ui.tsx` and nothing in
   the classic layout is touched, per docs/BENTO_UI_CONTRACT.md. */

interface WorkItem {
  kind: string
  title: string
  detail: string
  count: number
  due?: string
  overdue: boolean
}
interface MyWorkView {
  items: WorkItem[]
  outstanding: number
  sections: number
}

/** One cell. A figure and a word — never a table, never a scrollbar. */
function Cell({
  label,
  value,
  span,
  dark,
}: {
  label: string
  value: string | number
  span?: 'anchor' | 'one'
  /* Dark ground for the one figure that matters most; light for everything
     read as text. Both use existing tokens — a raw hex here would undo the
     contrast work already done on this palette. */
  dark?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col justify-between rounded-[14px] border p-5',
        span === 'anchor' ? 'sm:col-span-2 sm:row-span-2' : '',
        dark ? 'bg-foreground text-background' : 'bg-card text-card-foreground',
      )}
    >
      <p className={cn('text-[12.5px]', dark ? 'opacity-80' : 'text-muted-foreground')}>{label}</p>
      <p
        className={cn(
          'mt-6 tabular-nums font-semibold',
          span === 'anchor' ? 'text-[48px] leading-none' : 'text-[28px] leading-none',
        )}
      >
        {value}
      </p>
    </div>
  )
}

export default function BentoMyWork() {
  const t = useT()
  const { data, isLoading, error } = useQuery({
    queryKey: ['my-work'],
    queryFn: () => api.get<MyWorkView>('/api/v1/teaching/my-work'),
  })

  if (isLoading) return <div className="p-6 text-[13.5px] text-muted-foreground">{t('bento.my_work.loading')}</div>
  // A failed query renders an error, never an empty state that reads as a
  // fact: "0 outstanding" and "we could not ask" are not the same sentence.
  if (error) {
    return (
      <div className="p-6">
        <p className="rounded-[14px] border border-destructive/40 bg-card p-5 text-[13.5px] text-destructive">
          {t('bento.my_work.failed')}
        </p>
      </div>
    )
  }

  const d = data!
  const overdue = d.items.filter((i) => i.overdue).length

  return (
    <div className="p-6 sm:p-7">
      <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {t('bento.my_work.eyebrow')}
      </p>
      <h1 className="mt-1 text-[22px] font-semibold">{t('bento.my_work.title')}</h1>

      {/* Four columns, 20px gaps, one 2x2 anchor. */}
      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Cell span="anchor" dark label={t('bento.my_work.outstanding')} value={d.outstanding} />
        <Cell label={t('bento.my_work.overdue')} value={overdue} />
        <Cell label={t('bento.my_work.sections')} value={d.sections} />
        {d.outstanding === 0 && (
          <div className="rounded-[14px] border bg-card p-5 text-[13.5px] text-muted-foreground">
            {t('bento.my_work.nothing')}
          </div>
        )}
      </div>
    </div>
  )
}
