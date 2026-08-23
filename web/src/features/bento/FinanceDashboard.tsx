import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { formatPaise } from '@/lib/utils'
import {
  BentoError,
  BentoLoading,
  BentoPage,
  Cell,
  CellError,
  Cue,
  Meter,
  ReservoirArt,
  StatCell,
  useFeatureHref,
} from './bento-kit'
import { Widget, WidgetLayer } from './WidgetLayer'

/* THE FINANCE PAGE, IN THE BENTO LANGUAGE.

   The same two endpoints as `web/src/features/finance/Dashboard.tsx` —
   /finance/dashboard and /finance/invoices?overdue=true — and no others. No
   handler was added for this screen and none was needed.

   THE ANCHOR is what came in against what was due, and how old the rest is.
   The ageing is not a new query: the overdue invoice list the classic screen
   already fetches carries `due_on` and `due_paise` per invoice, so the three
   buckets below are that same list summed by how far past its due date each
   invoice is. The list is capped at 300 rows server-side, which is stated on
   the cell rather than hidden — a total that might be partial must say so.

   WHAT IS NOT HERE. There is no target or budget figure anywhere in this
   product's finance data, so "expectation" is the only expectation the numbers
   support: collected in the period plus what is still outstanding, which is
   everything billed and not yet paid. The label says exactly that. */

interface FinanceKPIs {
  today_paise: number
  month_paise: number
  outstanding_paise: number
  overdue_paise: number
  defaulters: number
  invoices: number
  unreconciled: number
  refunds_pending: number
  range: { period: string; from: string; to: string; label: string }
  as_of_now: string[]
}
interface InvoiceRow {
  id: string
  invoice_no: string
  student_name: string
  admission_no: string
  issued_on: string
  due_on?: string
  net_paise: number
  paid_paise: number
  due_paise: number
  status: string
}

/** The three buckets, in paise, from invoices the API already returned.

    A row without a due date is skipped rather than bucketed: `?overdue=true`
    is defined server-side as `due_on IS NOT NULL AND due_on < CURRENT_DATE`,
    so it cannot occur, and if it ever did it would not be overdue money and
    guessing an age for it would put a figure in a bucket it does not belong
    to. */
function ageing(items: InvoiceRow[]) {
  const today = Date.now()
  const day = 86_400_000
  const b = { fresh: 0, mid: 0, old: 0 }
  for (const i of items) {
    if (!i.due_on) continue
    const days = Math.floor((today - Date.parse(i.due_on)) / day)
    if (days <= 30) b.fresh += i.due_paise
    else if (days <= 60) b.mid += i.due_paise
    else b.old += i.due_paise
  }
  return b
}

export default function BentoFinanceDashboard() {
  const t = useT()

  const kpis = useQuery({
    queryKey: ['bento-finance-dashboard'],
    queryFn: () => api.get<FinanceKPIs>('/api/v1/finance/dashboard'),
  })
  const overdue = useQuery({
    queryKey: ['finance-invoices-overdue'],
    queryFn: () => api.get<List<InvoiceRow>>('/api/v1/finance/invoices?overdue=true'),
  })

  const collectHref = useFeatureHref('finance.collections.collect_payment')
  const receiptsHref = useFeatureHref('finance.collections.receipts')
  const defaultersHref = useFeatureHref('finance.student_dues.defaulters_reminders')
  const ledgerHref = useFeatureHref('finance.student_dues.student_ledger')
  const reconciliationHref = useFeatureHref('finance.reconciliation.reconciliation')
  const refundsHref = useFeatureHref('finance.concessions_refunds.refunds')
  const invoicesHref = useFeatureHref('finance.fee_structure.demand_invoice_generation')

  if (kpis.isLoading) return <BentoLoading message={t('bento.finance.loading')} />
  // Never a zero that is really a failed fetch. On a finance dashboard that is
  // the most expensive kind of wrong.
  if (kpis.error) return <BentoError message={t('bento.finance.failed')} />

  const k = kpis.data!
  const expected = k.month_paise + k.outstanding_paise
  const collectedPct = expected > 0 ? Math.round((k.month_paise / expected) * 100) : 0
  const rows = overdue.data?.items ?? []
  const a = ageing(rows)
  const agedTotal = a.fresh + a.mid + a.old

  const bands: { key: string; label: string; paise: number; opacity: string }[] = [
    { key: 'fresh', label: t('bento.finance.age_fresh'), paise: a.fresh, opacity: 'opacity-100' },
    { key: 'mid', label: t('bento.finance.age_mid'), paise: a.mid, opacity: 'opacity-70' },
    { key: 'old', label: t('bento.finance.age_old'), paise: a.old, opacity: 'opacity-40' },
  ]

  return (
    <BentoPage eyebrow={t('bento.finance.eyebrow')} title={t('bento.finance.title')}>
      <WidgetLayer dashboard="finance">
      {/* THE ANCHOR — 2x2, dark, and the only dark cell on the page. */}
      <Widget id="collection" label={t('bento.finance.anchor_label')} size="large" index={0}>
        {(span) => (
      <Cell
        span={span}
        dark
        /* The vessel is everything expected this month; the waterline is what
           has come in. It is the same proportion the bar below states in
           words and the same one the headline figure is a part of — the
           reservoir is that bar at full-card scale, not a second claim. */
        art={<ReservoirArt fill={expected > 0 ? k.month_paise / expected : 0} />}
      >
        <p className="text-[12.5px] opacity-80">{t('bento.finance.anchor_label')}</p>

        <p className="mt-4 text-[48px] font-semibold leading-none tabular-nums">
          {formatPaise(k.month_paise)}
        </p>
        <div
          role="progressbar"
          aria-label={t('bento.finance.collected_sr')}
          aria-valuenow={collectedPct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-4 h-2 w-full overflow-hidden rounded-full bg-background/25"
        >
          <div className="h-full rounded-full bg-background" style={{ width: `${collectedPct}%` }} />
        </div>
        <p className="mt-2 text-[12.5px] opacity-80">
          {t('bento.finance.collected_of_expected', {
            pct: collectedPct,
            expected: formatPaise(expected),
          })}
        </p>

        <div className="mt-6 border-t border-background/20 pt-4">
          <p className="text-[12px] uppercase tracking-[0.05em] opacity-70">
            {t('bento.finance.ageing')}
          </p>

          {overdue.error ? (
            // The collection figure above is still true; only the ageing is
            // unknown, and it says so rather than drawing an empty bar that
            // would read as "nothing is old".
            <div className="mt-3">
              <CellError dark message={t('bento.finance.ageing_failed')} />
            </div>
          ) : overdue.isLoading ? (
            <p className="mt-3 text-[12.5px] opacity-70">{t('bento.finance.ageing_loading')}</p>
          ) : agedTotal === 0 ? (
            <p className="mt-3 text-[13px]">{t('bento.finance.ageing_none')}</p>
          ) : (
            <>
              {/* Opacity separates the bands, but never alone: each band's own
                  figure is printed beneath it, so the bar can be read without
                  distinguishing three tints of one colour. Semantic tokens are
                  not used here — they were measured against a light card, and
                  this ground is the opposite of one. */}
              <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-background/20">
                {bands.map((b) => (
                  <div
                    key={b.key}
                    className={`h-full bg-background ${b.opacity}`}
                    style={{ width: `${(b.paise / agedTotal) * 100}%` }}
                  />
                ))}
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-3">
                {bands.map((b) => (
                  <div key={b.key}>
                    <dt className="text-[11.5px] opacity-70">{b.label}</dt>
                    <dd className="mt-0.5 text-[15px] font-semibold tabular-nums">
                      {formatPaise(b.paise)}
                    </dd>
                  </div>
                ))}
              </dl>
              {rows.length >= 300 && (
                <p className="mt-2 text-[11.5px] opacity-70">{t('bento.finance.ageing_capped')}</p>
              )}
            </>
          )}
        </div>

        {defaultersHref && (
          <Cue dark to={defaultersHref} label={t('bento.finance.cue_overdue')} />
        )}
      </Cell>
        )}
      </Widget>

      <Widget id="today" label={t('bento.finance.today')} size="small" index={1}>
        {(span) => (
      <StatCell
        span={span}
        label={t('bento.finance.today')}
        value={formatPaise(k.today_paise)}
        note={t('bento.finance.today_note')}
        to={collectHref ?? receiptsHref}
        cue={t('bento.finance.cue_collect')}
      />
        )}
      </Widget>

      <Widget id="outstanding" label={t('bento.finance.outstanding')} size="small" index={2}>
        {(span) => (
      <StatCell
        span={span}
        label={t('bento.finance.outstanding')}
        value={formatPaise(k.outstanding_paise)}
        shape={
          <Meter
            value={k.overdue_paise}
            total={k.outstanding_paise}
            tone="destructive"
            srLabel={t('bento.finance.overdue_sr')}
          />
        }
        note={t('bento.finance.overdue_note', { amount: formatPaise(k.overdue_paise) })}
        to={ledgerHref}
        cue={t('bento.finance.cue_ledger')}
      />
        )}
      </Widget>

      <Widget id="defaulters" label={t('bento.finance.defaulters')} size="small" index={3}>
        {(span) => (
      <StatCell
        span={span}
        label={t('bento.finance.defaulters')}
        value={k.defaulters}
        note={t('bento.finance.defaulters_note')}
        to={defaultersHref}
        cue={t('bento.finance.cue_defaulters')}
      />
        )}
      </Widget>

      <Widget id="unreconciled" label={t('bento.finance.unreconciled')} size="small" index={4}>
        {(span) => (
      <StatCell
        span={span}
        label={t('bento.finance.unreconciled')}
        value={k.unreconciled}
        note={t('bento.finance.unreconciled_note')}
        to={reconciliationHref}
        cue={t('bento.finance.cue_reconcile')}
      />
        )}
      </Widget>

      <Widget id="refunds" label={t('bento.finance.refunds')} size="small" index={5}>
        {(span) => (
      <StatCell
        span={span}
        label={t('bento.finance.refunds')}
        value={k.refunds_pending}
        note={t('bento.finance.refunds_note')}
        to={refundsHref}
        cue={t('bento.finance.cue_refunds')}
      />
        )}
      </Widget>

      <Widget id="invoices" label={t('bento.finance.invoices')} size="small" index={6}>
        {(span) => (
      <StatCell
        span={span}
        label={t('bento.finance.invoices')}
        value={k.invoices}
        note={t('bento.finance.invoices_note')}
        to={invoicesHref}
        cue={t('bento.finance.cue_invoices')}
      />
        )}
      </Widget>
      </WidgetLayer>
    </BentoPage>
  )
}
