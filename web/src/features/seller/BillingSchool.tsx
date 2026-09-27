import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatDate, formatPaise } from '@/lib/utils'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button, FormNotice, SkeletonTable, ErrorState,
} from '@/components/ui'
import { INV_TONE, type BillingInvoice } from './Billing'

/* THE SCHOOL'S OWN BILLING (Settings → School → Billing, at /billing).

   The administrator's view of what the school has been invoiced by the
   vendor, what is still due, and how to pay it. Reachable while the
   subscription is past due or suspended: that is exactly when it is needed. */

interface Resp {
  subscription: { plan_name: string | null; status: string; renews_on: string | null; trial_ends_on: string | null } | null
  invoices: BillingInvoice[]
  outstanding_paise: number
  online_available: boolean
  simulated_checkout: boolean
  pay_to: { seller_name: string; upi_vpa: string; bank_details: string; gstin: string }
}

const KEY = ['school-billing']
const STATUS_WORD: Record<string, string> = { active: 'Active', trial: 'Trial', past_due: 'Past due', suspended: 'Suspended', cancelled: 'Cancelled' }

export default function BillingSchool() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<Resp>('/api/v1/school-billing') })
  if (q.isLoading) return <SkeletonTable columns={6} label="Reading your invoices…" />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data!
  const sub = d.subscription
  const payOnline = d.online_available && d.simulated_checkout

  return (
    <>
      <PageHead eyebrow="Settings · School" title="Billing" description="Your subscription, invoices and payments." />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Subscription" value={sub ? `${sub.plan_name ?? ''} · ${STATUS_WORD[sub.status] ?? sub.status}` : 'None'} />
          <Stat label="Renews on" value={sub?.renews_on ? formatDate(sub.renews_on) : '-'} />
          <Stat label="Outstanding" value={formatPaise(d.outstanding_paise)} />
        </CellGrid>

        {(sub?.status === 'past_due' || sub?.status === 'suspended') && (
          <FormNotice error={new Error('Your subscription is ' + (STATUS_WORD[sub.status] ?? sub.status).toLowerCase() +
            '. Settle the overdue invoice below and the system switches straight back on.')} />
        )}

        <Card>
          <CardHeader title="Invoices" />
          <Table head={['Number', 'Issued', 'Due', 'Total', 'Balance', 'Status', '']} empty={!d.invoices.length} emptyLabel="No invoices yet.">
            {d.invoices.map((i) => <Row key={i.id} i={i} payOnline={payOnline} />)}
          </Table>
        </Card>

        {(d.pay_to.upi_vpa || d.pay_to.bank_details) && (
          <Card>
            <CardHeader title="Paying by UPI or bank transfer" />
            <div className="space-y-1.5 px-5 py-5 text-[14px]">
              {d.pay_to.seller_name && <p className="font-medium">{d.pay_to.seller_name}{d.pay_to.gstin ? ` · GSTIN ${d.pay_to.gstin}` : ''}</p>}
              {d.pay_to.upi_vpa && <p>UPI: <span className="font-mono">{d.pay_to.upi_vpa}</span></p>}
              {d.pay_to.bank_details && <p className="whitespace-pre-line">{d.pay_to.bank_details}</p>}
              <p className="text-muted-foreground">Quote the invoice number as the reference. The payment shows here once it is recorded.</p>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}

function Row({ i, payOnline }: { i: BillingInvoice; payOnline: boolean }) {
  const qc = useQueryClient()
  const pay = useMutation({
    mutationFn: async () => {
      const o = await api.post<{ order_ref: string }>(`/api/v1/school-billing/invoices/${i.id}/checkout`)
      // Test checkout (outside production): the server stands in for the gateway and verifies its own signature.
      return api.post(`/api/v1/school-billing/checkout/${o.order_ref}/callback`, { outcome: 'success' })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
  const open = i.status === 'issued' || i.status === 'partial'
  return (
    <tr>
      <Td className="font-medium">
        <a className="underline-offset-2 hover:underline" href={`/api/v1/school-billing/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer">{i.number}</a>
        <div className="text-[12px] text-muted-foreground">{i.description}</div>
      </Td>
      <Td>{formatDate(i.issued_on)}</Td>
      <Td>{formatDate(i.due_on)}{i.overdue && <Badge tone="danger" className="ml-2">Overdue</Badge>}</Td>
      <Td>{formatPaise(i.total_paise)}</Td>
      <Td>{open ? formatPaise(i.balance_paise) : '-'}</Td>
      <Td><Badge tone={INV_TONE[i.status] ?? 'neutral'}>{i.status}</Badge></Td>
      <Td>
        {open && payOnline && <Button size="sm" pending={pay.isPending} onClick={() => pay.mutate()}>Pay online (test)</Button>}
        <FormNotice error={pay.error} />
      </Td>
    </tr>
  )
}
