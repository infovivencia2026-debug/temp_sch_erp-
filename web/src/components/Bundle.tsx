import { Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Loading } from '@/components/ui'
import { cn } from '@/lib/utils'

/* One menu entry, several screens behind it.
 *
 * The finance catalogue had forty-five entries. Each one was a real screen, and
 * together they were unusable: a cashier looking for the counter had to pick it
 * out of a list that also offered fee structure versioning, a trial balance and
 * a depreciation register. The screens were not the problem — the menu was
 * describing the software's parts rather than the accountant's jobs.
 *
 * So the parts group under the job. "Vendor bills & petty cash" is one entry
 * and two screens, because it is one afternoon's work. The screens themselves
 * are untouched and still separate: folding two into one page would put a
 * release-payment button on a screen somebody has open all day, which is the
 * mistake the split was protecting against.
 *
 * The open tab is in the URL, so a link points at the screen somebody meant and
 * the back button does what it looks like it does. Each tab loads when it is
 * first opened — grouping eleven screens behind four entries must not mean
 * downloading eleven screens to look at one.
 */

export interface BundleTab {
  /** URL value. Short and readable: ?view=petty-cash. */
  key: string
  label: string
  /** What this tab is for, when the label alone leaves somebody guessing. */
  note?: string
  Screen: LazyExoticComponent<ComponentType> | ComponentType
}

export default function Bundle({ tabs }: { tabs: BundleTab[] }) {
  const [params, setParams] = useSearchParams()
  const wanted = params.get('view')
  // An unknown view falls back to the first tab rather than an empty page: a
  // stale bookmark from before a tab was renamed should still land somewhere.
  const active = tabs.find((t) => t.key === wanted) ?? tabs[0]
  const Screen = active.Screen

  return (
    <>
      <div className="flex flex-wrap items-center gap-1 border-b px-1 pt-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            title={t.note}
            aria-current={t.key === active.key ? 'page' : undefined}
            onClick={() => {
              // replace, not push: flicking between tabs should not fill the
              // back button with steps somebody has to press through.
              const next = new URLSearchParams(params)
              next.set('view', t.key)
              setParams(next, { replace: true })
            }}
            className={cn(
              'rounded-t-md px-3 py-2 text-[13.5px] font-medium transition-colors',
              t.key === active.key
                ? 'border-b-2 border-primary text-foreground'
                : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Suspense fallback={<Loading />}>
        <Screen />
      </Suspense>
    </>
  )
}
