import { useSyncExternalStore } from 'react'
import { PickerMenu } from '@/components/PickerMenu'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatPaise } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { ChevronDown } from 'lucide-react'
import { useLayout, periodOf, type Period } from '@/lib/widgets'
import { StatCell } from './bento-kit'
import { Widget, useWidgetLayer } from './WidgetLayer'

/* THE CELLS ANY BOARD CAN ADD.
 *
 * A board was a fixed handful of cells drawn by hand; seventeen of the
 * eighteen had nothing to add. These are the rest: every figure the server's
 * metric registry offers this role (internal/api/metrics.go), rendered as a
 * stat cell keyed `metric:<key>`, each with a period the person sets on the
 * cell itself -- today, yesterday, this week, this month, this term, this
 * year, all time.
 *
 * Nothing here is declared by a board. A metric cell exists on a board
 * because the layout store says so (it was added from the gallery), and it
 * declares itself to the layer like any other Widget, so ordering, sizing,
 * hiding and the pager all treat it as a card. Rendered by WidgetLayer after
 * the board's own children, so no board file knows it exists. */

export interface MetricListing {
  key: string
  label: string
  hint: string
  unit: 'count' | 'paise' | 'percent'
  as_of: boolean
  group: string
  periods: Period[]
}

export const METRIC_PREFIX = 'metric:'

/* The metrics this session may read, fetched once per page load.

   Not react-query, on purpose: WidgetLayer reads this for every board, and
   the boards' own tests render a layer with no QueryClientProvider around
   it -- as does any host that mounts a board outside the app shell. A
   module-level store with useSyncExternalStore asks the server once, hands
   every board the same answer, and needs nothing above it. The list changes
   when a role is granted a permission, not while a board is open. */
let catalogue: { items: MetricListing[] } | null = null
let catalogueFailed = false
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()
function notify() {
  for (const l of listeners) l()
}
function ensureCatalogue() {
  if (catalogue || inflight) return
  inflight = api
    .get<{ items: MetricListing[] }>('/api/v1/metrics')
    .then((d) => {
      catalogue = d
    })
    .catch(() => {
      catalogueFailed = true
    })
    .finally(() => {
      inflight = null
      notify()
    })
}
export function useMetricCatalogue(): { data: { items: MetricListing[] } | null; isSuccess: boolean } {
  const data = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      ensureCatalogue()
      return () => listeners.delete(cb)
    },
    () => catalogue,
    () => null,
  )
  return { data, isSuccess: data !== null && !catalogueFailed }
}

interface MetricValue {
  key: string
  label: string
  unit: 'count' | 'paise' | 'percent'
  as_of: boolean
  period: Period
  from: string
  to: string
  value: number
  previous?: number
}

const PERIOD_LABEL_KEY: Record<Period, string> = {
  today: 'bento.period.today',
  yesterday: 'bento.period.yesterday',
  week: 'bento.period.week',
  month: 'bento.period.month',
  term: 'bento.period.term',
  year: 'bento.period.year',
  all: 'bento.period.all',
}

export function periodLabelKey(p: Period) {
  return PERIOD_LABEL_KEY[p]
}

function formatValue(unit: MetricValue['unit'], v: number) {
  if (unit === 'paise') return formatPaise(v)
  if (unit === 'percent') return `${Math.round(v * 10) / 10}%`
  return new Intl.NumberFormat('en-IN').format(Math.round(v))
}

/* The comparison, in the words a person compares in. A percentage of a
   previous zero is not a number, and a change under half a percent is
   noise: both say "same". */
function delta(unit: MetricValue['unit'], v: number, prev?: number): string | undefined {
  if (prev === undefined) return undefined
  if (unit === 'percent') {
    const d = Math.round((v - prev) * 10) / 10
    if (Math.abs(d) < 0.5) return 'same as before'
    return `${d > 0 ? '+' : ''}${d} pts`
  }
  if (prev === 0) return v === 0 ? 'same as before' : 'new'
  const pct = Math.round(((v - prev) / prev) * 100)
  if (Math.abs(pct) < 1) return 'same as before'
  return `${pct > 0 ? '+' : ''}${pct}%`
}

/* THE PERIOD IS ON THE CELL.

   It was reachable only through the hold menu, which nobody finds by
   looking. A metric that can be read over more than one window now carries
   a small dropdown on the note's line -- "Month ▾" -- and one that cannot
   (an as-of headcount, say) carries nothing: the control appears only where
   the choice exists. Native <select> under a drawn pill, as SettingsRows
   does, so a phone gets its own wheel; pointer events stop at the pill so the
   widget's hold-to-menu never starts from a tap on it. */
function PeriodPicker({ value, options, onPick }: { value: Period; options: Period[]; onPick: (p: Period) => void }) {
  const t = useT()
  const name = (p: Period) => t(PERIOD_LABEL_KEY[p] as never)
  return (
    <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <PickerMenu
        value={value}
        options={options.map((o) => ({ value: o, label: name(o) }))}
        onChange={onPick}
        ariaLabel={t('bento.widgets.period')}
      >
        <span
          className="relative inline-flex shrink-0 items-center gap-0.5 rounded-full border border-current/20
                     bg-current/[0.06] px-2 py-0.5 text-[11px] font-medium leading-none text-[var(--bento-ink)]"
        >
          {name(value)}
          <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
        </span>
      </PickerMenu>
    </span>
  )
}

function MetricCard({ metricKey, period, span, periods, onPeriod }: {
  metricKey: string
  period: Period
  span: Parameters<typeof StatCell>[0]['span']
  periods?: Period[]
  onPeriod?: (p: Period) => void
}) {
  const t = useT()
  const q = useQuery({
    queryKey: ['metric', metricKey, period],
    queryFn: () => api.get<MetricValue>(`/api/v1/metrics/${metricKey}?period=${period}`),
    staleTime: 60 * 1000,
  })
  const d = q.data
  const periodLabel = t(PERIOD_LABEL_KEY[period] as never)
  return (
    <StatCell
      span={span}
      label={d?.label ?? metricKey.split('.').slice(1).join(' ')}
      value={d ? formatValue(d.unit, d.value) : '…'}
      badge={d ? delta(d.unit, d.value, d.previous) : undefined}
      note={d?.as_of ? `as of ${periodLabel.toLowerCase()}` : periodLabel}
      picker={periods && periods.length > 1 && onPeriod
        ? <PeriodPicker value={period} options={periods} onPick={onPeriod} />
        : undefined}
    />
  )
}

/** Every metric cell the layout holds for this board. */
export function MetricCells() {
  const layer = useWidgetLayer()
  const { layout, setPeriod } = useLayout(layer?.dashboard ?? 'default')
  const ids = layout.placed.map((p) => p.id).filter((id) => id.startsWith(METRIC_PREFIX))
  const catalogue = useMetricCatalogue()
  if (!layer || ids.length === 0) return null
  const known = new Map((catalogue.data?.items ?? []).map((m) => [m.key, m]))
  return (
    <>
      {ids.map((id, i) => {
        const key = id.slice(METRIC_PREFIX.length)
        const m = known.get(key)
        /* A metric this role may no longer read, or one this build no
           longer offers, simply does not draw -- the same rule as a pinned
           feature that was withdrawn. It stays in the layout so it returns
           if the permission does. */
        if (catalogue.isSuccess && !m) return null
        const period = periodOf(layout, id)
        return (
          <Widget key={id} id={id} label={m?.label ?? key} size="small" index={1000 + i} periodic>
            {(span) => (
              <MetricCard
                metricKey={key}
                period={period}
                span={span}
                periods={m?.periods}
                onPeriod={(p) => setPeriod(id, p)}
              />
            )}
          </Widget>
        )
      })}
    </>
  )
}
