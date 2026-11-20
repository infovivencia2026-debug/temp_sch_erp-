import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Dialog, Button, ErrorState } from '@/components/ui'
import { receiptHtml, printHtml } from './receipt-print'

/* A receipt opened from a receipt number, inside the page (owner, 2026-11-20:
   "after receipt no is clicked there is no going back"). A new tab had no way
   back on a phone; this closes to where the person was. */
export default function ReceiptDialog({ paymentId, onClose }: { paymentId: string; onClose: () => void }) {
  const inst = useSession().institution
  const q = useQuery({
    queryKey: ['receipt', paymentId],
    queryFn: () => api.call('GET /fees/receipts/{id}', { params: { id: paymentId } }),
  })
  const html = q.data ? receiptHtml(q.data, {
    name: inst?.display_name || q.data.institution,
    logoUrl: inst?.logo_key ? `${location.origin}/api/v1/files/${inst.logo_key}?inline=1` : undefined,
  }) : ''
  return (
    <Dialog
      onClose={onClose}
      title={q.data?.receipt_no ? `Receipt ${q.data.receipt_no}` : 'Receipt'}
      width="52rem"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button disabled={!html} onClick={() => printHtml(html)}>Print</Button>
        </>
      }
    >
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : !html ? <div className="h-[60dvh] animate-pulse rounded-xl bg-muted" />
        : <iframe title="Receipt" srcDoc={html} className="h-[70dvh] w-full rounded-xl border bg-white" />}
    </Dialog>
  )
}
