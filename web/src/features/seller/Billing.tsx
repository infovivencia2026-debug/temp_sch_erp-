import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { rupeesToPaise, isBadAmount } from '@/lib/money'
import { formatDate, formatPaise } from '@/lib/utils'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button, Input, Field, FormGrid,
  FormNotice, SkeletonTable, ErrorState,
} from '@/components/ui'

/* SUBSCRIPTION LEDGER: WHAT EACH SCHOOL OWES AND WHY.

   One row per school with its plan, its subscription status, when it renews
   and what is outstanding; the invoices underneath, newest first. Issuing an
   invoice takes the plan's price (or the agreed price) unless another amount
   is typed, adds the one GST line, and numbers it for the financial year.

   The status column is driven by the daily billing check: past due after the
   grace period, suspended after the further period, active again the moment
   the money is recorded. Settings for all of that live in the last card. */

export interface BillingInvoice {
  id: string; institution_id: string; school: string; number: string; issued_on: string; due_on: string
  period_from: string | null; period_to: string | null; description: string; amount_paise: number; gst_rate_bp: number
  gst_paise: number; total_paise: number; paid_paise: number; balance_paise: number; status: string; overdue: boolean; days_overdue: number
}
interface SchoolRow {
  institution_id: string; school: string; plan_name: string | null; subscription_status: string | null; renews_on: string | null
  renews_in_days: number | null; agreed_price_paise: number | null; price_paise: number | null; outstanding_paise: number
  days_overdue: number; last_invoiced_on: string | null
}
interface Settings {
  seller_name: string; seller_address: string; seller_gstin: string; seller_email: string; bank_details: string; upi_vpa: string
  invoice_prefix: string; gst_rate_bp: number; due_days: number; grace_days: number; suspend_after_days: number
  online_gateway: boolean; development: boolean
}

const KEY = ['seller-billing']
const SUB_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  active: 'success', trial: 'info', past_due: 'warning', suspended: 'danger', cancelled: 'neutral',
}
export const INV_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  paid: 'success', partial: 'warning', issued: 'neutral', void: 'neutral',
}
const pdfHref = (id: string) => `/api/v1/seller/billing/invoices/${id}/pdf`

export default function Billing() {
  const qc = useQueryClient()
  const schools = useQuery({ queryKey: [...KEY, 'schools'], queryFn: () => api.get<{ items: SchoolRow[]; total_outstanding_paise: number }>('/api/v1/seller/billing/schools') })
  const invoices = useQuery({ queryKey: [...KEY, 'invoices'], queryFn: () => api.get<{ items: BillingInvoice[] }>('/api/v1/seller/billing/invoices') })
  const refresh = () => qc.invalidateQueries({ queryKey: KEY })
  const [issuing, setIssuing] = useState<string | null>(null)
  const run = useMutation({
    mutationFn: () => api.post<{ status_changes: unknown[]; reminders: unknown[] }>('/api/v1/seller/billing/run'),
    onSuccess: refresh,
  })

  if (schools.isLoading) return <SkeletonTable columns={7} label="Reading the ledger…" />
  if (schools.error) return <ErrorState error={schools.error} />
  const rows = schools.data?.items ?? []
  const inv = invoices.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Subscriptions & Billing"
        title="Subscription ledger"
        description="Each school's plan, renewal date, invoices and what is outstanding."
        actions={<Button variant="secondary" pending={run.isPending} onClick={() => run.mutate()}>Run billing check now</Button>}
      />
      <PageBody>
        {run.data && (
          <FormNotice ok={`Checked: ${run.data.status_changes.length} status change(s), ${run.data.reminders.length} renewal reminder(s).`} />
        )}
        <FormNotice error={run.error} />
        <CellGrid cols={4}>
          <Stat label="Outstanding" value={formatPaise(schools.data?.total_outstanding_paise ?? 0)} />
          <Stat label="Schools overdue" value={rows.filter((r) => r.days_overdue > 0).length} />
          <Stat label="Past due or suspended" value={rows.filter((r) => r.subscription_status === 'past_due' || r.subscription_status === 'suspended').length} />
          <Stat label="Renewing in 30 days" value={rows.filter((r) => r.renews_in_days != null && r.renews_in_days >= 0 && r.renews_in_days <= 30).length} />
        </CellGrid>

        <Card>
          <CardHeader title="Schools" />
          <Table head={['School', 'Plan', 'Status', 'Renews', 'Outstanding', '']} empty={!rows.length} emptyLabel="No schools yet.">
            {rows.map((r) => (
              <tr key={r.institution_id}>
                <Td className="font-medium">{r.school}</Td>
                <Td>{r.plan_name ?? <span className="text-muted-foreground">No plan</span>}</Td>
                <Td>{r.subscription_status ? <Badge tone={SUB_TONE[r.subscription_status] ?? 'neutral'}>{r.subscription_status.replace('_', ' ')}</Badge> : '-'}</Td>
                <Td>
                  {r.renews_on ? formatDate(r.renews_on) : '-'}
                  {r.renews_in_days != null && r.renews_in_days >= 0 && r.renews_in_days <= 30 && (
                    <span className="ml-2 text-[12px] text-muted-foreground">in {r.renews_in_days} d</span>
                  )}
                </Td>
                <Td>
                  {r.outstanding_paise > 0 ? formatPaise(r.outstanding_paise) : <span className="text-muted-foreground">Nil</span>}
                  {r.days_overdue > 0 && <Badge tone="danger" className="ml-2">{r.days_overdue} d overdue</Badge>}
                </Td>
                <Td>
                  <Button size="sm" variant="secondary" onClick={() => setIssuing(issuing === r.institution_id ? null : r.institution_id)}>
                    {issuing === r.institution_id ? 'Cancel' : 'New invoice'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {issuing && (
          <IssueForm school={rows.find((r) => r.institution_id === issuing)!} onDone={() => { setIssuing(null); refresh() }} />
        )}

        <Card>
          <CardHeader title="Invoices" />
          <Table head={['Number', 'School', 'Issued', 'Due', 'Total', 'Balance', 'Status', '']} empty={!inv.length}
                 emptyLabel="No invoices issued yet." loading={invoices.isLoading}>
            {inv.map((i) => <InvoiceRow key={i.id} i={i} onChange={refresh} />)}
          </Table>
        </Card>

        <SettingsCard />
      </PageBody>
    </>
  )
}

function IssueForm({ school, onDone }: { school: SchoolRow; onDone: () => void }) {
  const [period, setPeriod] = useState<'yearly' | 'monthly' | 'one_off'>('yearly')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [gstin, setGstin] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [notify, setNotify] = useState(true)
  const issue = useMutation({
    mutationFn: () => api.post('/api/v1/seller/billing/invoices', {
      institution_id: school.institution_id, billing_period: period,
      amount_paise: amount.trim() ? rupeesToPaise(amount) : null,
      description: description.trim() || undefined, school_gstin: gstin.trim() || undefined, due_on: dueOn || undefined, notify,
    }),
    onSuccess: onDone,
  })
  const suggested = school.agreed_price_paise ?? school.price_paise
  return (
    <Card>
      <CardHeader title={`New invoice: ${school.school}`} />
      <div className="space-y-4 px-5 py-5">
        <FormGrid>
          <Field label="Period">
            <div className="flex gap-2">
              {(['yearly', 'monthly', 'one_off'] as const).map((p) => (
                <Button key={p} size="sm" variant={period === p ? 'primary' : 'secondary'} onClick={() => setPeriod(p)}>
                  {p === 'one_off' ? 'One-off' : p[0].toUpperCase() + p.slice(1)}
                </Button>
              ))}
            </div>
          </Field>
          <Field label="Amount before GST (Rs)" hint={suggested && period === 'yearly' ? `Blank uses ${formatPaise(suggested)}` : 'Blank uses the plan price'}>
            <Input value={amount} onChange={setAmount} placeholder="e.g. 50000" />
          </Field>
          <Field label="Description" hint="Blank describes the plan and period">
            <Input value={description} onChange={setDescription} />
          </Field>
          <Field label="School's GSTIN" hint="Optional, printed on the invoice">
            <Input value={gstin} onChange={setGstin} />
          </Field>
          <Field label="Due on" hint="Blank uses the settings' days to pay">
            <Input type="date" value={dueOn} onChange={setDueOn} />
          </Field>
          <Field label="Email the school's administrator">
            <label className="flex items-center gap-2 text-[14px]">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Send a notice
            </label>
          </Field>
        </FormGrid>
        <FormNotice error={issue.error} />
        <Button pending={issue.isPending} disabled={!!amount.trim() && isBadAmount(amount)} onClick={() => issue.mutate()}>Issue invoice</Button>
      </div>
    </Card>
  )
}

function InvoiceRow({ i, onChange }: { i: BillingInvoice; onChange: () => void }) {
  const [paying, setPaying] = useState(false)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('neft')
  const [reference, setReference] = useState('')
  const [paidOn, setPaidOn] = useState('')
  const pay = useMutation({
    mutationFn: () => api.post(`/api/v1/seller/billing/invoices/${i.id}/payments`, {
      amount_paise: amount.trim() ? rupeesToPaise(amount) : i.balance_paise, method, reference, paid_on: paidOn || undefined,
    }),
    onSuccess: () => { setPaying(false); setAmount(''); setReference(''); onChange() },
  })
  const voidIt = useMutation({ mutationFn: () => api.post(`/api/v1/seller/billing/invoices/${i.id}/void`, {}), onSuccess: onChange })
  const open = i.status === 'issued' || i.status === 'partial'
  return (
    <>
      <tr>
        <Td className="font-medium"><a className="underline-offset-2 hover:underline" href={pdfHref(i.id)} target="_blank" rel="noreferrer">{i.number}</a></Td>
        <Td>{i.school}</Td>
        <Td>{formatDate(i.issued_on)}</Td>
        <Td>{formatDate(i.due_on)}{i.overdue && <Badge tone="danger" className="ml-2">{i.days_overdue} d</Badge>}</Td>
        <Td>{formatPaise(i.total_paise)}</Td>
        <Td>{open ? formatPaise(i.balance_paise) : '-'}</Td>
        <Td><Badge tone={INV_TONE[i.status] ?? 'neutral'}>{i.status}</Badge></Td>
        <Td>
          <div className="flex flex-wrap gap-2">
            {open && <Button size="sm" variant="secondary" onClick={() => setPaying((p) => !p)}>{paying ? 'Cancel' : 'Record payment'}</Button>}
            {open && i.paid_paise === 0 && <Button size="sm" variant="ghost" pending={voidIt.isPending} onClick={() => voidIt.mutate()}>Void</Button>}
          </div>
          <FormNotice error={voidIt.error} />
        </Td>
      </tr>
      {paying && (
        <tr>
          <Td colSpan={8}>
            <div className="flex flex-wrap items-center gap-2">
              <Input value={amount} onChange={setAmount} placeholder={`Rs ${(i.balance_paise / 100).toFixed(2)}`} className="w-[130px]" srLabel="Amount in rupees" />
              <select className="field w-auto" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
                <option value="neft">NEFT / RTGS / IMPS</option>
                <option value="upi">UPI</option>
                <option value="cheque">Cheque</option>
                <option value="cash">Cash</option>
              </select>
              <Input value={reference} onChange={setReference} placeholder="UTR / transaction / cheque no." className="w-[220px]" srLabel="Reference" />
              <Input type="date" value={paidOn} onChange={setPaidOn} className="w-[160px]" srLabel="Paid on" />
              <Button size="sm" pending={pay.isPending} disabled={!!amount.trim() && isBadAmount(amount)} onClick={() => pay.mutate()}>Record</Button>
            </div>
            <FormNotice error={pay.error} />
          </Td>
        </tr>
      )}
    </>
  )
}

function SettingsCard() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: [...KEY, 'settings'], queryFn: () => api.get<Settings>('/api/v1/seller/billing/settings') })
  const [draft, setDraft] = useState<Partial<Settings>>({})
  const save = useMutation({
    mutationFn: () => api.put('/api/v1/seller/billing/settings', draft),
    onSuccess: () => { setDraft({}); qc.invalidateQueries({ queryKey: [...KEY, 'settings'] }) },
  })
  if (!q.data) return q.error ? <ErrorState error={q.error} /> : null
  const v = { ...q.data, ...draft }
  const text = (k: keyof Settings) => (x: string) => setDraft((d) => ({ ...d, [k]: x }))
  const whole = (k: keyof Settings) => (x: string) => setDraft((d) => ({ ...d, [k]: x.trim() === '' ? undefined : Number(x) }))
  return (
    <Card>
      <CardHeader title="Billing settings" action={
        <Badge tone={q.data.online_gateway ? 'success' : 'neutral'}>{q.data.online_gateway ? 'Online payment on' : 'Online payment off'}</Badge>
      } />
      <div className="space-y-4 px-5 py-5">
        <FormGrid>
          <Field label="Seller name"><Input value={v.seller_name} onChange={text('seller_name')} /></Field>
          <Field label="Seller GSTIN"><Input value={v.seller_gstin} onChange={text('seller_gstin')} placeholder="36ABCDE1234F1Z5" /></Field>
          <Field label="Address" wide><Input value={v.seller_address} onChange={text('seller_address')} /></Field>
          <Field label="Billing email"><Input value={v.seller_email} onChange={text('seller_email')} /></Field>
          <Field label="UPI ID for payments"><Input value={v.upi_vpa} onChange={text('upi_vpa')} /></Field>
          <Field label="Bank details" wide hint="Printed on every invoice"><Input value={v.bank_details} onChange={text('bank_details')} /></Field>
          <Field label="Invoice prefix" hint="INV gives INV/2026-27/0001"><Input value={v.invoice_prefix} onChange={text('invoice_prefix')} /></Field>
          <Field label="GST rate (%)">
            <Input value={String(v.gst_rate_bp / 100)} onChange={(x) => setDraft((d) => ({ ...d, gst_rate_bp: Math.round(Number(x) * 100) }))} />
          </Field>
          <Field label="Days to pay" hint="Due date = issue date + this"><Input value={String(v.due_days)} onChange={whole('due_days')} /></Field>
          <Field label="Grace period (days)" hint="Past due after the due date + this"><Input value={String(v.grace_days)} onChange={whole('grace_days')} /></Field>
          <Field label="Suspend after (days)" hint="Suspended this many days after becoming past due"><Input value={String(v.suspend_after_days)} onChange={whole('suspend_after_days')} /></Field>
        </FormGrid>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Saved.' : undefined} />
        <Button pending={save.isPending} disabled={!Object.keys(draft).length} onClick={() => save.mutate()}>Save settings</Button>
      </div>
    </Card>
  )
}
