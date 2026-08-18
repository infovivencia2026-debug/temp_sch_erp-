import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Receipt as ReceiptIcon } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Button,
  PrintButton, Loading, ErrorState,
} from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'

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
  const [open, setOpen] = useState<string | null>(null)
  const receipts = useQuery({
    queryKey: ['portal-receipts'],
    queryFn: () => api.get<List<ReceiptRow>>('/api/v1/portal/receipts'),
  })

  if (receipts.isLoading) return <Loading label="Looking up your payments…" />
  if (receipts.error) return <ErrorState error={receipts.error} />

  const rows = receipts.data?.items ?? []
  const total = rows.reduce((n, r) => n + r.amount_paise, 0)

  return (
    <>
      <PageHead
        eyebrow="Fees"
        title="Receipts"
        description="Every payment the school has banked, with a receipt you can print or save."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Receipts" value={rows.length} icon={ReceiptIcon} />
          <Stat label="Paid in total" value={formatPaise(total)} />
          <Stat label="Most recent" value={rows.length ? formatDate(rows[0].paid_on) : '—'} />
        </CellGrid>

        {/* The list is chrome once a receipt is open: printing it alongside
            wastes the first page of every saved PDF. */}
        <Card className="no-print">
          <CardHeader
            title="Payments"
            description="Only money the bank has cleared appears here."
          />
          <Table
            head={['Receipt', 'Child', 'Paid on', 'How', 'Amount', '']}
            empty={rows.length === 0}
            emptyLabel="No payments have cleared yet."
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
                    {open === r.payment_id ? 'Hide' : 'Open'}
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
  const detail = useQuery({
    queryKey: ['portal-receipt', paymentId],
    queryFn: () => api.get<ReceiptDetail>(`/api/v1/portal/receipts/${paymentId}`),
  })

  if (detail.isLoading) return <Loading label="Rendering the receipt…" />
  if (detail.error) return <ErrorState error={detail.error} />
  const d = detail.data
  if (!d) return null

  return (
    <Card>
      <CardHeader
        title={`Receipt ${d.receipt_no}`}
        description={`${d.institution} · financial year ${d.financial_year}`}
        action={<PrintButton label="Download PDF" />}
      />
      <div className="p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Detail label="Received from" value={d.student_name} />
          <Detail label="Admission number" value={d.admission_no} />
          <Detail
            label="Class"
            value={[d.class_name, d.section_name].filter(Boolean).join(' ') || '—'}
          />
          <Detail label="Paid on" value={formatDate(d.paid_on)} />
          <Detail label="Method" value={d.mode + (d.reference_no ? ` · ${d.reference_no}` : '')} />
          <Detail label="Status" value={d.status} />
        </div>

        <table className="responsive-table mt-6 w-full text-[14px]">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-muted-foreground">Invoice</th>
              <th className="px-3 py-2 text-left text-[12px] font-medium text-muted-foreground">Particulars</th>
              <th className="px-3 py-2 text-right text-[12px] font-medium text-muted-foreground">Amount</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.invoice_no} className="border-t">
                <td className="px-3 py-2">{l.invoice_no}</td>
                <td className="px-3 py-2">{l.particulars}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatPaise(l.amount_paise)}</td>
              </tr>
            ))}
            <tr className="border-t font-medium">
              <td className="px-3 py-2" colSpan={2}>Total</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatPaise(d.amount_paise)}</td>
            </tr>
          </tbody>
        </table>

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
