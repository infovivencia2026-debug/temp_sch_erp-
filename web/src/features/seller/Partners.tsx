import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, ConfirmButton, Dialog, Field, FormGrid, FormNotice,
  Input, Select, ErrorState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { formatDate, formatPaise } from '@/lib/utils'

/* PARTNERS (Subscriptions & Billing → Partners).

   Resellers who bring schools. Each partner has a commission rate; when one
   of its schools pays an invoice in full, the server accrues the commission
   on the invoice's value before GST. A payout pays everything owed in one
   ledger row with its bank reference. Money: every action here waits for the
   server and shows what it wrote. */

interface Partner {
  id: string; name: string; email: string | null; phone: string | null; commission_bp: number; status: 'active' | 'inactive'
  schools: number; accrued_paise: number; owed_paise: number; paid_paise: number
}
interface Detail {
  partner: Partner
  schools: { id: string; name: string }[]
  commissions: { id: string; invoice_number: string; school: string; base_paise: number; rate_bp: number; commission_paise: number; accrued_at: string; payout_id: string | null }[]
  payouts: { id: string; amount_paise: number; reference: string; paid_on: string }[]
}
interface Tenant { id: string; name: string }

const KEY = ['seller-partners']
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`
const bpOf = (s: string) => Math.round(Number(s) * 100)

export default function Partners() {
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<List<Partner>>('/api/v1/seller/partners') })
  const rows = q.data?.items ?? []
  const owed = rows.reduce((a, p) => a + p.owed_paise, 0)

  return (
    <>
      <PageHead
        eyebrow="Subscriptions & billing"
        title="Partners"
        description="Resellers, the schools they brought, and the commission owed to them."
        actions={<Button onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" />Add partner</Button>}
      />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : (
          <Card>
            <CardHeader
              title={`${rows.length} ${rows.length === 1 ? 'partner' : 'partners'}`}
              description={owed ? `${formatPaise(owed)} owed in commission, not yet paid out.` : 'Commission accrues when a partner\'s school pays an invoice in full.'}
            />
            <Table
              loading={q.isPending && !q.data}
              head={['Partner', 'Rate', 'Schools', 'Earned', 'Owed', 'Paid', '']}
              empty={rows.length === 0}
              emptyLabel="No partners yet. Add one, then link the schools it brought."
            >
              {rows.map((p) => (
                <tr key={p.id}>
                  <Td className="font-medium">
                    {p.name}
                    {p.status === 'inactive' && <Badge tone="neutral" className="ml-2">Inactive</Badge>}
                    {(p.email || p.phone) && <span className="block text-[12px] font-normal text-muted-foreground">{p.email ?? p.phone}</span>}
                  </Td>
                  <Td className="num">{pct(p.commission_bp)}</Td>
                  <Td className="num">{p.schools}</Td>
                  <Td className="num">{formatPaise(p.accrued_paise)}</Td>
                  <Td className="num">{formatPaise(p.owed_paise)}</Td>
                  <Td className="num">{formatPaise(p.paid_paise)}</Td>
                  <Td className="text-right"><Button size="sm" variant="secondary" onClick={() => setOpen(p.id)}>Open</Button></Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </PageBody>
      {adding && <AddPartner onClose={() => setAdding(false)} />}
      {open && <PartnerSheet id={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function AddPartner({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [f, setF] = useState({ name: '', email: '', phone: '', rate: '10' })
  const add = useMutation({
    mutationFn: () => api.post('/api/v1/seller/partners', { name: f.name, email: f.email, phone: f.phone, commission_bp: bpOf(f.rate) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); toast.ok('Partner added'); onClose() },
  })
  return (
    <Dialog
      onClose={onClose}
      title="Add a partner"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!f.name.trim()} pending={add.isPending} needsNetwork onClick={() => add.mutate()}>Add partner</Button></>}
    >
      <FormGrid>
        <Field label="Name" required wide><Input value={f.name} onChange={(v) => setF({ ...f, name: v })} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(v) => setF({ ...f, phone: v })} /></Field>
        <Field label="Commission" hint="Percent of each paid invoice, before GST. Up to 50.">
          <Input value={f.rate} onChange={(v) => setF({ ...f, rate: v.replace(/[^\d.]/g, '') })} />
        </Field>
      </FormGrid>
      <FormNotice error={add.error} />
    </Dialog>
  )
}

function PartnerSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const key = [...KEY, id]
  const d = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(`/api/v1/seller/partners/${id}`) })
  const tenants = useQuery({ queryKey: ['seller-tenants'], queryFn: () => api.get<List<Tenant>>('/api/v1/seller/tenants') })
  const [school, setSchool] = useState('')
  const [reference, setReference] = useState('')
  const [rate, setRate] = useState<string | null>(null)
  const done = (msg: string) => { void qc.invalidateQueries({ queryKey: KEY }); toast.ok(msg) }
  const link = useMutation({ mutationFn: () => api.post(`/api/v1/seller/partners/${id}/schools`, { institution_id: school }), onSuccess: () => { setSchool(''); done('School linked') } })
  const unlink = useMutation({ mutationFn: (sid: string) => api.del(`/api/v1/seller/partners/${id}/schools/${sid}`), onSuccess: () => done('School unlinked') })
  const save = useMutation({ mutationFn: (body: Record<string, unknown>) => api.put(`/api/v1/seller/partners/${id}`, body), onSuccess: () => { setRate(null); done('Partner saved') } })
  const pay = useMutation({
    mutationFn: () => api.post<{ amount_paise: number }>(`/api/v1/seller/partners/${id}/payouts`, { reference }),
    onSuccess: (r) => { setReference(''); done(`Payout of ${formatPaise(r.amount_paise)} recorded`) },
  })
  const p = d.data?.partner
  const linked = new Set((d.data?.schools ?? []).map((s) => s.id))
  const owed = (d.data?.commissions ?? []).filter((c) => !c.payout_id).reduce((a, c) => a + c.commission_paise, 0)

  return (
    <Dialog onClose={onClose} size="xl" title={p?.name ?? 'Partner'} description={p ? `${pct(p.commission_bp)} commission` : undefined}>
      {d.error && <ErrorState error={d.error} />}
      {p && d.data && (
        <div className="space-y-6">
          <section className="space-y-3">
            <FormGrid>
              <Field label="Commission" hint="Applies to invoices paid from now on.">
                <Input value={rate ?? String(p.commission_bp / 100)} onChange={(v) => setRate(v.replace(/[^\d.]/g, ''))} />
              </Field>
              <Field label="Status">
                <Select value={p.status} onChange={(v) => save.mutate({ status: v })} options={[{ value: 'active', label: 'Active, earns commission' }, { value: 'inactive', label: 'Inactive, earns nothing new' }]} />
              </Field>
            </FormGrid>
            {rate !== null && <Button size="sm" needsNetwork pending={save.isPending} onClick={() => save.mutate({ commission_bp: bpOf(rate) })}>Save rate</Button>}
            <FormNotice error={save.error} />
          </section>

          <section>
            <p className="mb-2 text-[14px] font-semibold">Schools</p>
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <Select
                  value={school}
                  onChange={setSchool}
                  placeholder="Choose a school to link"
                  options={(tenants.data?.items ?? []).filter((t) => !linked.has(t.id)).map((t) => ({ value: t.id, label: t.name }))}
                />
              </div>
              <Button size="sm" variant="secondary" disabled={!school} pending={link.isPending} onClick={() => link.mutate()}>Link school</Button>
            </div>
            <Table head={['School', '']} empty={d.data.schools.length === 0} emptyLabel="No schools linked.">
              {d.data.schools.map((s) => (
                <tr key={s.id}>
                  <Td>{s.name}</Td>
                  <Td className="text-right">
                    <ConfirmButton confirmLabel="Unlink" question="Invoices this school pays from now on earn this partner nothing." onConfirm={() => unlink.mutate(s.id)} disabled={unlink.isPending}>Unlink</ConfirmButton>
                  </Td>
                </tr>
              ))}
            </Table>
            <FormNotice error={link.error ?? unlink.error} />
          </section>

          <section>
            <p className="mb-2 text-[14px] font-semibold">Commission</p>
            <Table head={['Invoice', 'School', 'Before GST', 'Rate', 'Commission', '']} empty={d.data.commissions.length === 0} emptyLabel="Nothing earned yet.">
              {d.data.commissions.map((c) => (
                <tr key={c.id}>
                  <Td className="num">{c.invoice_number}</Td>
                  <Td>{c.school}</Td>
                  <Td className="num">{formatPaise(c.base_paise)}</Td>
                  <Td className="num">{pct(c.rate_bp)}</Td>
                  <Td className="num">{formatPaise(c.commission_paise)}</Td>
                  <Td>{c.payout_id ? <Badge tone="success">Paid</Badge> : <Badge tone="warning">Owed</Badge>}</Td>
                </tr>
              ))}
            </Table>
          </section>

          <section>
            <p className="mb-2 text-[14px] font-semibold">Payouts</p>
            {owed > 0 && (
              <div className="mb-3 flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label={`Pay ${formatPaise(owed)} owed`} hint="The bank or UPI reference of the transfer.">
                    <Input value={reference} onChange={setReference} />
                  </Field>
                </div>
                <Button needsNetwork disabled={reference.trim().length < 3} pending={pay.isPending} onClick={() => pay.mutate()}>Mark paid</Button>
              </div>
            )}
            <FormNotice error={pay.error} />
            <Table head={['Paid on', 'Reference', 'Amount']} empty={d.data.payouts.length === 0} emptyLabel="No payouts yet.">
              {d.data.payouts.map((o) => (
                <tr key={o.id}>
                  <Td className="num">{formatDate(o.paid_on)}</Td>
                  <Td>{o.reference}</Td>
                  <Td className="num">{formatPaise(o.amount_paise)}</Td>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}
    </Dialog>
  )
}
