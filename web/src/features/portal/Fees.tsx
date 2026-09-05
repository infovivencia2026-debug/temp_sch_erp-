import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, IndianRupee, Receipt } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Select, EmptyState, PrintButton, FormNotice,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { formatDate, formatPaise, cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

/* The family's own bill.

   This catalogue entry used to open the cashier's counter — the screen that
   searches every student in the school and takes money over a till. A parent
   got a 403 on its first request and a blank page, which is worse than the
   feature not existing: it looks built and it is not.

   What a parent actually wants is three numbers and two lists: what is owed,
   by when, what has been paid. */

interface InvoiceLine { head: string; amount_paise: number; is_fine?: boolean }

interface Invoice {
  invoice_no: string
  instalment_no?: number
  lines?: InvoiceLine[]
  issued_on: string
  due_on?: string
  net_paise: number
  paid_paise: number
  due_paise: number
  fine_paise: number
  status: string
  days_overdue: number
}
interface ReceiptRow {
  receipt_no: string
  paid_on: string
  amount_paise: number
  mode: string
  reference_no?: string
  status: string
}
interface FeeView {
  student_id: string
  student_name: string
  outstanding_paise: number
  invoices: Invoice[]
  receipts: ReceiptRow[]
}
interface Child {
  student_id: string
  full_name: string
  class_name?: string
  section_name?: string
}

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  paid: 'success',
  cleared: 'success',
  unpaid: 'warning',
  partial: 'warning',
  overdue: 'danger',
  bounced: 'danger',
  cancelled: 'neutral',
}

export default function PortalFees() {
  const t = useT()
  const children = useQuery({
    queryKey: ['portal-children'],
    queryFn: () => api.get<List<Child>>('/api/v1/portal/students'),
  })
  const kids = children.data?.items ?? []
  const [picked, setPicked] = useState('')
  const child = picked || kids[0]?.student_id || ''

  /* Paying, with nothing moving. See internal/api/portal_pay.go: it writes the
     receipt and the ledger entry the counter would, stamped SIMULATED, so the
     day a gateway arrives the only new code is the part that takes the money. */
  const qc = useQueryClient()
  const [paid, setPaid] = useState('')
  const pay = useMutation({
    mutationFn: (v: { invoice_no?: string }) =>
      api.post<{ receipt_no: string }>(
        `/api/v1/portal/fees/pay?student_id=${child}`, v),
    onSuccess: (r) => {
      setPaid(`Paid. Receipt ${r.receipt_no}. This was a test payment — no money was taken.`)
      qc.invalidateQueries()
    },
    onError: () => setPaid(''),
  })

  const fees = useQuery({
    queryKey: ['portal-fees', child],
    queryFn: () => api.get<FeeView>(`/api/v1/portal/fees?student_id=${child}`),
    enabled: !!child,
  })
  const { data, isLoading, error } = fees

  /* The children request is a state of this screen too.

     `isLoading || !child` sent a parent whose list failed — or whose account is
     linked to nobody — to a spinner that never resolved, because the fee query
     stays disabled while there is no child and a disabled query never stops
     being pending. Three separate answers, in the order the page learns them. */
  if (children.isLoading) return <ScreenSkeleton />
  if (children.error && !children.data) return <ScreenError error={children.error} />
  if (!kids.length)
    return (
      <>
        <PageHead eyebrow={t('portal.fees.eyebrow')} title={t('portal.fees.title')} />
        <PageBody>
          <EmptyState
            title={t('portal.fees.no_link_title')}
            body={t('portal.fees.no_link_body')}
          />
        </PageBody>
      </>
    )
  if (isLoading) return <ScreenSkeleton />
  if (error && !data) return <ScreenError error={error} />
  if (!data)
    return (
      <>
        <PageHead eyebrow={t('portal.fees.eyebrow')} title={t('portal.fees.title')} />
        <PageBody>
          <EmptyState
            title={t('portal.fees.no_record_title')}
            body={t('portal.fees.no_record_body')}
          />
        </PageBody>
      </>
    )
  const d = data

  const overdue = d.invoices.filter((i) => i.due_paise > 0 && i.days_overdue > 0)
  const paidThisYear = d.receipts
    .filter((r) => r.status !== 'bounced')
    .reduce((n, r) => n + r.amount_paise, 0)

  return (
    <>
      <PageHead
        eyebrow={t('portal.fees.eyebrow')}
        title={d.outstanding_paise > 0 ? t('portal.fees.title_due', { amount: formatPaise(d.outstanding_paise) }) : t('portal.fees.title_nothing_due')}
        description={
          d.outstanding_paise > 0
            ? t('portal.fees.description_due', { name: d.student_name })
            : t('portal.fees.description_paid', { name: d.student_name })
        }
        actions={
          <>
            {/* A fee statement is a document a parent takes to the office. */}
            <PrintButton label={t('portal.fees.action_print')} />
            {/* The switcher is only for a guardian with more than one child;
                a student has one bill and it would be furniture. */}
            {kids.length > 1 && (
              <Select
                value={child}
                onChange={setPicked}
                options={kids.map((k) => ({
                  value: k.student_id,
                  label: `${k.full_name}${k.class_name ? ` · ${k.class_name}-${k.section_name ?? ''}` : ''}`,
                }))}
              />
            )}
          </>
        }
      />
      <Freshness query={fees} />
      <PageBody>
        {/* NO MONEY MOVES HERE YET, AND IT SAYS SO.

            There is no payment gateway in this product. The button records the
            payment the way the counter does — same receipt, same ledger, same
            notification — and stamps every row SIMULATED, so the whole family
            side of the fee flow can be exercised before a gateway is wired in,
            which is the worst day to find a fault in it. */}
        {d.outstanding_paise > 0 && (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="text-[15px] font-semibold">
                  {formatPaise(d.outstanding_paise)} outstanding
                </p>
                <p className="text-[12.5px] text-muted-foreground">
                  Test payment only — no money is taken and no card is asked for.
                  The receipt is issued exactly as it would be at the office.
                </p>
              </div>
              <Button disabled={pay.isPending} onClick={() => pay.mutate({})}>
                {pay.isPending ? 'Paying…' : `Pay ${formatPaise(d.outstanding_paise)}`}
              </Button>
            </div>
            <FormNotice error={pay.error} ok={paid} />
          </Card>
        )}

        <CellGrid cols={3}>
          <Stat label={t('portal.fees.stat_outstanding')} value={formatPaise(d.outstanding_paise)} icon={IndianRupee} />
          <Stat
            label={t('portal.fees.stat_overdue')}
            value={overdue.length}
            icon={AlertTriangle}
            delta={
              overdue.length
                ? { value: t('portal.fees.stat_overdue_delta', { days: Math.max(...overdue.map((o) => o.days_overdue)) }), positive: false }
                : { value: t('portal.fees.stat_overdue_none'), positive: true }
            }
          />
          <Stat label={t('portal.fees.stat_paid')} value={formatPaise(paidThisYear)} icon={Receipt} />
        </CellGrid>

        <Card>
          <CardHeader title={t('portal.fees.instalments_title')} description={t('portal.fees.instalments_description')} />
          {d.invoices.length === 0 ? (
            <EmptyState
              title={t('portal.fees.instalments_empty_title')}
              body={t('portal.fees.instalments_empty_body')}
            />
          ) : (
            <ul className="space-y-3 p-4">
              {d.invoices.map((i) => (
                <li key={i.invoice_no} className="rounded-xl border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold">
                        {i.instalment_no
                          ? t('portal.fees.instalment_no', { number: i.instalment_no })
                          : i.invoice_no}
                        <span className="ml-2 font-mono text-[12px] font-normal text-muted-foreground">
                          {i.invoice_no}
                        </span>
                      </p>
                      <p
                        className={cn(
                          'mt-0.5 text-[13px]',
                          i.days_overdue > 0 && i.due_paise > 0
                            ? 'font-medium text-destructive'
                            : 'text-muted-foreground',
                        )}
                      >
                        {t('portal.fees.col_due')}: {formatDate(i.due_on)}
                        {i.days_overdue > 0 && i.due_paise > 0
                          && ` · ${t('portal.fees.days_late', { days: i.days_overdue })}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <span className="block text-[11px] text-muted-foreground">
                          {t('portal.fees.col_still_due')}
                        </span>
                        <span className="text-[15px] font-semibold tabular-nums">
                          {i.due_paise > 0 ? formatPaise(i.due_paise) : '—'}
                        </span>
                      </div>
                      <Badge tone={STATUS_TONE[i.status] ?? 'neutral'}>{i.status}</Badge>
                    </div>
                  </div>

                  {/* What the instalment is made of, and what it adds up to.

                      "Instalment 1 — ₹11,833" and nothing else meant a parent
                      asking what they were paying for had to telephone the
                      office to be read a list the school already holds. */}
                  {/* A grid, not a sentence.

                      Six charges written as a wrapped line read as prose: the
                      eye cannot compare "Transport ₹833" with "Uniform ₹333"
                      when they sit at different points on different lines. A
                      column each, with the label above the figure, is how a
                      bill is read. */}
                  {i.lines && i.lines.length > 0 && (
                    <div className="mt-3 border-t pt-3">
                      <p className="eyebrow mb-2">{t('portal.fees.col_amount')}</p>
                      <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/40 p-3 text-[12.5px] sm:grid-cols-3 md:grid-cols-4">
                        {i.lines.map((l, n) => (
                          <div key={n}>
                            <span className={cn('block', l.is_fine ? 'text-destructive' : 'text-muted-foreground')}>
                              {l.head}
                            </span>
                            <span className="font-semibold tabular-nums">
                              {formatPaise(l.amount_paise)}
                            </span>
                          </div>
                        ))}
                        <div className="col-span-2 flex items-center justify-between border-t pt-2 sm:col-span-3 md:col-span-4">
                          <span className="font-semibold">{t('portal.fees.col_amount')}</span>
                          <span className="font-semibold tabular-nums">{formatPaise(i.net_paise)}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[12.5px] text-muted-foreground">
                      {t('portal.fees.col_paid')}{' '}
                      <strong className="tabular-nums text-foreground">
                        {formatPaise(i.paid_paise)}
                      </strong>
                    </span>
                    {i.due_paise > 0 && (
                      <Button
                        size="sm"
                        disabled={pay.isPending}
                        onClick={() => pay.mutate({ invoice_no: i.invoice_no })}
                      >
                        {pay.isPending ? 'Paying…' : `Pay ${formatPaise(i.due_paise)}`}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title={t('portal.fees.receipts_title')} description={t('portal.fees.receipts_description')} />
          {d.receipts.length === 0 ? (
            <EmptyState title={t('portal.fees.receipts_empty_title')} />
          ) : (
            <Table head={[t('portal.fees.col_receipt'), t('portal.fees.col_date'), t('portal.fees.col_amount'), t('portal.fees.col_mode'), t('portal.fees.col_reference'), t('portal.fees.col_status')]}>
              {d.receipts.map((r) => (
                <tr key={r.receipt_no}>
                  <Td className="font-medium">{r.receipt_no}</Td>
                  <Td>{formatDate(r.paid_on)}</Td>
                  <Td className="tabular-nums">{formatPaise(r.amount_paise)}</Td>
                  <Td className="capitalize">{r.mode}</Td>
                  <Td className="text-muted-foreground">{r.reference_no ?? '—'}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {d.receipts.some((r) => r.status === 'bounced') && (
            <p className="border-t px-5 py-2.5 text-[13px] text-destructive">
              {t('portal.fees.bounced_note')}
            </p>
          )}
        </Card>
      </PageBody>
    </>
  )
}
