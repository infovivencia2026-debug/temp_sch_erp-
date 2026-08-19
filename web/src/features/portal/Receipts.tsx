import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Receipt as ReceiptIcon } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Button,
  PrintButton, Loading, ErrorState,
} from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'
import { useT } from '@/lib/i18n'

/* The family's own copy of a receipt.

   The counter has had a printable receipt since the fee module shipped, behind
   payments.read — the permission to read every payment in the school, which no
   parent holds and none should. So a family asking for last term's receipt
   rang the office and somebody printed it again.

   This is the same document reached by owning the child instead. Only cleared
   money appears: a cheque handed over but not banked is not a receipt anybody
   can show, and printing it as one is how a parent ends up at the counter
   insisting a bounced cheque was paid.

   "Download PDF" is the browser's print dialogue. A school's receipt has to
   carry the institution's letterhead and be produced on demand for any of
   thousands of payments; rendering it as a page the browser saves keeps one
   template, and the file the parent gets is a real PDF. */

interface ReceiptRow {
  payment_id: string
  receipt_no: string
  student_id: string
  student_name: string
  amount_paise: number
  mode: string
  status: string
  paid_on: string
  reference_no?: string
}

interface ReceiptDetail {
  receipt_no: string
  amount_paise: number
  amount_words: string
  mode: string
  status: string
  paid_on: string
  reference_no?: string
  student_name: string
  admission_no: string
  institution: string
  class_name?: string
  section_name?: string
  financial_year: string
  lines: { invoice_no: string; amount_paise: number; particulars: string }[]
}

export default function Receipts() {
  const t = useT()
  const [open, setOpen] = useState<string | null>(null)
  const receipts = useQuery({
    queryKey: ['portal-receipts'],
    queryFn: () => api.get<List<ReceiptRow>>('/api/v1/portal/receipts'),
  })

  if (receipts.isLoading) return <Loading label={t('portal.receipts.loading')} />
  if (receipts.error) return <ErrorState error={receipts.error} />

  const rows = receipts.data?.items ?? []
  const total = rows.reduce((n, r) => n + r.amount_paise, 0)

  return (
    <>
      <PageHead
        eyebrow={t('portal.receipts.eyebrow')}
        title={t('portal.receipts.title')}
        description={t('portal.receipts.description')}
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label={t('portal.receipts.stat_receipts')} value={rows.length} icon={ReceiptIcon} />
          <Stat label={t('portal.receipts.stat_paid_total')} value={formatPaise(total)} />
          <Stat label={t('portal.receipts.stat_most_recent')} value={rows.length ? formatDate(rows[0].paid_on) : '—'} />
        </CellGrid>

        {/* The list is chrome once a receipt is open: printing it alongside
            wastes the first page of every saved PDF. */}
        <Card className="no-print">
          <CardHeader
            title={t('portal.receipts.card_title')}
            description={t('portal.receipts.card_description')}
          />
          <Table
            head={[t('portal.receipts.col_receipt'), t('portal.receipts.col_child'), t('portal.receipts.col_paid_on'), t('portal.receipts.col_how'), t('portal.receipts.col_amount'), '']}
            empty={rows.length === 0}
            emptyLabel={t('portal.receipts.empty')}
          >
            {rows.map((r) => (
              <tr key={r.payment_id}>
                <Td className="font-medium">{r.receipt_no}</Td>
                <Td>{r.student_name}</Td>
                <Td>{formatDate(r.paid_on)}</Td>
                <Td>
                  {r.mode}
                  {r.reference_no && (
                    <div className="text-[12px] text-muted-foreground">{r.reference_no}</div>
                  )}
                </Td>
                <Td className="tabular-nums">{formatPaise(r.amount_paise)}</Td>
                <Td>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setOpen(open === r.payment_id ? null : r.payment_id)}
                  >
                    {open === r.payment_id ? t('portal.receipts.action_hide') : t('portal.receipts.action_open')}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {open && <PrintableReceipt paymentId={open} />}
      </PageBody>
    </>
  )
}

function PrintableReceipt({ paymentId }: { paymentId: string }) {
  const t = useT()
  const detail = useQuery({
    queryKey: ['portal-receipt', paymentId],
    queryFn: () => api.get<ReceiptDetail>(`/api/v1/portal/receipts/${paymentId}`),
  })

  if (detail.isLoading) return <Loading label={t('portal.receipts.detail_loading')} />
  if (detail.error) return <ErrorState error={detail.error} />
  const d = detail.data
  if (!d) return null

  return (
    <Card>
      <CardHeader
        title={t('portal.receipts.detail_title', { number: d.receipt_no })}
        description={t('portal.receipts.detail_description', { institution: d.institution, year: d.financial_year })}
        action={<PrintButton label={t('portal.receipts.action_download')} />}
      />
      <div className="p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Detail label={t('portal.receipts.detail_received_from')} value={d.student_name} />
          <Detail label={t('portal.receipts.detail_admission_no')} value={d.admission_no} />
          <Detail
            label={t('portal.receipts.detail_class')}
            value={[d.class_name, d.section_name].filter(Boolean).join(' ') || '—'}
          />
          <Detail label={t('portal.receipts.detail_paid_on')} value={formatDate(d.paid_on)} />
          <Detail label={t('portal.receipts.detail_method')} value={d.mode + (d.reference_no ? ` · ${d.reference_no}` : '')} />
          <Detail label={t('portal.receipts.detail_status')} value={d.status} />
        </div>

        {/* The primitives, not a hand-rolled table: `responsive-table` alone
            styles the collapse but only Table/Td inject the data-label each
            cell needs, and without them a parent on a phone got three bare
            right-aligned values with nothing saying which was the invoice
            number and which the amount. */}
        <div className="mt-6">
          <Table head={[t('portal.receipts.col_invoice'), t('portal.receipts.col_particulars'), { label: t('portal.receipts.col_line_amount'), align: 'right' }]}>
            {d.lines.map((l) => (
              <tr key={l.invoice_no}>
                <Td>{l.invoice_no}</Td>
                <Td>{l.particulars}</Td>
                <Td className="text-right tabular-nums">{formatPaise(l.amount_paise)}</Td>
              </tr>
            ))}
            <tr className="font-medium">
              <Td colSpan={2}>{t('portal.receipts.total')}</Td>
              <Td className="text-right tabular-nums">{formatPaise(d.amount_paise)}</Td>
            </tr>
          </Table>
        </div>

        {/* Rupees in words is not decoration: it is what makes a receipt hard to
            alter, and Indian schools are asked for it by auditors. */}
        <div className="mt-4 text-[13px] text-muted-foreground">
          {d.amount_words}
        </div>
      </div>
    </Card>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="text-[14px] font-medium">{value}</div>
    </div>
  )
}
