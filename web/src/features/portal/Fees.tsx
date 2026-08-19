import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, IndianRupee, Receipt } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Select, Loading, ErrorState, EmptyState, PrintButton,
} from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'
import { useT } from '@/lib/i18n'

/* The family's own bill.

   This catalogue entry used to open the cashier's counter — the screen that
   searches every student in the school and takes money over a till. A parent
   got a 403 on its first request and a blank page, which is worse than the
   feature not existing: it looks built and it is not.

   What a parent actually wants is three numbers and two lists: what is owed,
   by when, what has been paid. */

interface Invoice {
  invoice_no: string
  instalment_no?: number
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

  const { data, isLoading, error } = useQuery({
    queryKey: ['portal-fees', child],
    queryFn: () => api.get<FeeView>(`/api/v1/portal/fees?student_id=${child}`),
    enabled: !!child,
  })

  /* The children request is a state of this screen too.

     `isLoading || !child` sent a parent whose list failed — or whose account is
     linked to nobody — to a spinner that never resolved, because the fee query
     stays disabled while there is no child and a disabled query never stops
     being pending. Three separate answers, in the order the page learns them. */
  if (children.isLoading) return <Loading />
  if (children.error) return <ErrorState error={children.error} />
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
  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
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
      <PageBody>
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
            <Table head={[t('portal.fees.col_instalment'), t('portal.fees.col_due'), t('portal.fees.col_amount'), t('portal.fees.col_paid'), t('portal.fees.col_still_due'), t('portal.fees.col_status')]}>
              {d.invoices.map((i) => (
                <tr key={i.invoice_no}>
                  <Td className="font-medium">
                    {i.instalment_no ? t('portal.fees.instalment_no', { number: i.instalment_no }) : i.invoice_no}
                    <span className="ml-2 text-[12px] text-muted-foreground">{i.invoice_no}</span>
                  </Td>
                  <Td className={i.days_overdue > 0 && i.due_paise > 0 ? 'text-destructive' : undefined}>
                    {formatDate(i.due_on)}
                    {i.days_overdue > 0 && i.due_paise > 0 && (
                      <span className="ml-1.5 text-[12px]">{t('portal.fees.days_late', { days: i.days_overdue })}</span>
                    )}
                  </Td>
                  <Td className="tabular-nums">{formatPaise(i.net_paise)}</Td>
                  <Td className="tabular-nums">{formatPaise(i.paid_paise)}</Td>
                  <Td className="tabular-nums">
                    {i.due_paise > 0 ? formatPaise(i.due_paise) : '—'}
                    {i.fine_paise > 0 && (
                      <span className="ml-1.5 text-[12px] text-destructive">
                        {t('portal.fees.incl_fine', { amount: formatPaise(i.fine_paise) })}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[i.status] ?? 'neutral'}>{i.status}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
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
