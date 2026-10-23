import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useStudentRoster } from '@/lib/rosters'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Input, Button, ConfirmButton, Select, Field, FormGrid,
  Loading, ErrorState, FormNotice, TAB_BAR, tabClass,
} from '@/components/ui'
import { formatPaise, formatDate, cn } from '@/lib/utils'

/* Corrections to money already taken: a receipt issued by mistake, a
   receipt against the wrong child, an online payment the gateway never
   confirmed, a fee that should stop for a whole class. Rare, and each one
   leaves its reason on the record. */

interface Payment {
  id: string; receipt_no: string; amount_paise: number; allocated_paise: number; mode: string; paid_on: string; status: string
  gateway?: string; gateway_txn_id?: string; reference_no?: string; remarks?: string; student_name: string; admission_no: string; student_id: string
}
interface Student { id: string; full_name?: string; first_name?: string; last_name?: string; admission_no: string }
const STATUS: Record<string, string> = { success: 'Received', pending: 'Pending', cancelled: 'Void', bounced: 'Bounced' }

export default function FeeCorrections() {
  const [tab, setTab] = useState<'receipts' | 'online' | 'end'>('receipts')
  return (
    <>
      <PageHead eyebrow="Fees" title="Fee corrections" />
      <PageBody>
        <div className={cn(TAB_BAR, 'mb-4')}>
          {([['receipts', 'A receipt'], ['online', 'Online payments pending'], ['end', 'End a fee for a class']] as const).map(([k, label]) => (
            <button key={k} type="button" className={tabClass(tab === k)} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {tab === 'receipts' && <Receipts />}
        {tab === 'online' && <PendingOnline />}
        {tab === 'end' && <EndFee />}
      </PageBody>
    </>
  )
}

const studentLabel = (s: Student) => `${s.full_name ?? `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim()} (${s.admission_no})`

function Receipts() {
  const qc = useQueryClient()
  const roster = useStudentRoster<Student>()
  const students = roster.data?.items ?? []
  const [student, setStudent] = useState('')
  const [acting, setActing] = useState<{ id: string; what: 'void' | 'move' } | null>(null)
  const [reason, setReason] = useState('')
  const [to, setTo] = useState('')
  const [done, setDone] = useState('')
  const q = useQuery({
    queryKey: ['fee-corrections', student],
    queryFn: () => api.get<{ items: Payment[] }>(`/api/v1/finance/corrections/payments?student_id=${student}`),
    enabled: !!student,
  })
  interface Outcome { receipt_no?: string; allocated_paise?: number; unallocated_paise?: number }
  const run = useMutation({
    mutationFn: (v: { id: string; what: 'void' | 'move' }): Promise<Outcome> =>
      v.what === 'void'
        ? api.post<Outcome>(`/api/v1/finance/corrections/payments/${v.id}/void`, { reason })
        : api.post<Outcome>(`/api/v1/finance/corrections/payments/${v.id}/move`, { to_student_id: to, reason }),
    onSuccess: (r, v) => {
      setDone(v.what === 'void'
        ? `Receipt ${r.receipt_no ?? ''} is void. The family's dues are back to what they were.`
        : `Moved. ${formatPaise(r.allocated_paise ?? 0)} set against the other child's dues${r.unallocated_paise ? `, ${formatPaise(r.unallocated_paise)} left unallocated` : ''}.`)
      setActing(null); setReason(''); setTo('')
      qc.invalidateQueries({ queryKey: ['fee-corrections'] })
    },
  })
  return (
    <div className="space-y-4">
      <Card>
        <div className="p-5">
          <Field label="Whose receipts" required>
            <Select value={student} onChange={(v) => { setStudent(v); setDone('') }} placeholder="Find a child"
              options={students.map((s) => ({ value: s.id, label: studentLabel(s) }))} />
          </Field>
          <FormNotice ok={done || undefined} error={run.error} />
        </div>
      </Card>
      {student && (
        <Card>
          <CardHeader title="Receipts" description="Void one issued by mistake, or move one taken against the wrong child." />
          {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (
            <Table head={['Receipt', 'Date', 'Mode', { label: 'Amount', align: 'right' }, 'Status', 'Note', '']} empty={!(q.data?.items ?? []).length} emptyLabel="No receipts for this child.">
              {(q.data?.items ?? []).map((p) => (
                <tr key={p.id}>
                  <Td className="font-mono text-[12.5px]">{p.receipt_no}</Td>
                  <Td className="text-muted-foreground">{formatDate(p.paid_on)}</Td>
                  <Td className="text-muted-foreground">{p.mode}{p.reference_no ? ` · ${p.reference_no}` : ''}</Td>
                  <Td className="text-right tabular-nums font-medium">{formatPaise(p.amount_paise)}</Td>
                  <Td>{STATUS[p.status] ?? p.status}</Td>
                  <Td className="text-muted-foreground"><span className="block max-w-[28ch] truncate" title={p.remarks ?? ''}>{p.remarks ?? ''}</span></Td>
                  <Td>
                    {p.status === 'success' && acting?.id !== p.id && (
                      <span className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => { setActing({ id: p.id, what: 'move' }); setReason('') }}>Move</Button>
                        <Button size="sm" variant="ghost" tone="danger" onClick={() => { setActing({ id: p.id, what: 'void' }); setReason('') }}>Void</Button>
                      </span>
                    )}
                    {acting?.id === p.id && (
                      <span className="flex flex-col gap-2">
                        {acting.what === 'move' && (
                          <Select value={to} onChange={setTo} placeholder="To which child"
                            options={students.filter((s) => s.id !== student).map((s) => ({ value: s.id, label: studentLabel(s) }))} />
                        )}
                        <Input className="w-56" value={reason} onChange={setReason} placeholder="Why, for the record" />
                        <span className="flex gap-2">
                          {acting.what === 'void' ? (
                            <ConfirmButton size="sm" tone="danger" disabled={reason.trim().length < 5 || run.isPending} confirmLabel="Void it"
                              question="Void this receipt? The money counts as never received and the dues come back. The receipt number stays on the record with your reason."
                              onConfirm={() => run.mutate({ id: p.id, what: 'void' })}>Void</ConfirmButton>
                          ) : (
                            <Button size="sm" disabled={!to || reason.trim().length < 5 || run.isPending} onClick={() => run.mutate({ id: p.id, what: 'move' })}>Move it</Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => setActing(null)}>Cancel</Button>
                        </span>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </div>
  )
}

function PendingOnline() {
  const qc = useQueryClient()
  const [reason, setReason] = useState<Record<string, string>>({})
  const [txn, setTxn] = useState<Record<string, string>>({})
  const q = useQuery({ queryKey: ['fee-corrections', 'pending'], queryFn: () => api.get<{ items: Payment[] }>('/api/v1/finance/corrections/payments?pending=1') })
  const force = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/finance/corrections/payments/${id}/force-success`, { reason: reason[id] ?? '', gateway_txn_id: txn[id] || undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fee-corrections'] }),
  })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const rows = q.data?.items ?? []
  return (
    <Card>
      <CardHeader title="Online payments the gateway never confirmed" description="Mark one received only when the bank or the gateway has confirmed it to you. It then counts like any receipt." />
      <Table head={['Receipt', 'Child', 'Date', 'Gateway', { label: 'Amount', align: 'right' }, '']} empty={!rows.length} emptyLabel="Nothing is pending at the gateway.">
        {rows.map((p) => (
          <tr key={p.id}>
            <Td className="font-mono text-[12.5px]">{p.receipt_no}</Td>
            <Td className="font-medium">{p.student_name}<span className="block font-mono text-[11.5px] font-normal text-muted-foreground">{p.admission_no}</span></Td>
            <Td className="text-muted-foreground">{formatDate(p.paid_on)}</Td>
            <Td className="text-muted-foreground">{p.gateway ?? p.mode}{p.gateway_txn_id ? ` · ${p.gateway_txn_id}` : ''}</Td>
            <Td className="text-right tabular-nums font-medium">{formatPaise(p.amount_paise)}</Td>
            <Td>
              <span className="flex flex-wrap items-center gap-2">
                <Input className="w-40" value={txn[p.id] ?? ''} onChange={(v) => setTxn({ ...txn, [p.id]: v })} placeholder="Gateway reference" />
                <Input className="w-48" value={reason[p.id] ?? ''} onChange={(v) => setReason({ ...reason, [p.id]: v })} placeholder="How it was confirmed" />
                <ConfirmButton size="sm" disabled={(reason[p.id] ?? '').trim().length < 5 || force.isPending} confirmLabel="Mark received"
                  question="Mark this payment received? Only do this when the gateway or the bank has confirmed the money."
                  onConfirm={() => force.mutate(p.id)}>Mark received</ConfirmButton>
              </span>
            </Td>
          </tr>
        ))}
      </Table>
      <div className="px-5 pb-4"><FormNotice error={force.error} /></div>
    </Card>
  )
}

function EndFee() {
  interface Head { id: string; name: string }
  interface Klass { id: string; name: string }
  interface Section { id: string; name: string; class_id: string }
  const [form, setForm] = useState({ fee_head_id: '', class_id: '', section_id: '', from: new Date().toISOString().slice(0, 10), reason: '' })
  const heads = useQuery({ queryKey: ['fee-heads'], queryFn: () => api.get<{ items: Head[] }>('/api/v1/setup/fee-heads') })
  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api.get<{ items: Klass[] }>('/api/v1/academics/classes') })
  const sections = useQuery({ queryKey: ['sections'], queryFn: () => api.get<{ items: Section[] }>('/api/v1/academics/sections') })
  const end = useMutation({
    mutationFn: () => api.post<{ ended: number; from: string }>('/api/v1/finance/corrections/end-fee', { ...form, section_id: form.section_id || undefined, class_id: form.class_id || undefined }),
  })
  return (
    <Card>
      <CardHeader title="Stop a fee for a whole class" description="From the date you give, the fee is left out of the next billing. Nothing already invoiced changes." />
      <div className="p-5">
        <FormGrid>
          <Field label="Fee head" required>
            <Select value={form.fee_head_id} onChange={(v) => setForm({ ...form, fee_head_id: v })} placeholder="Choose" options={(heads.data?.items ?? []).map((h) => ({ value: h.id, label: h.name }))} />
          </Field>
          <Field label="Class" required>
            <Select value={form.class_id} onChange={(v) => setForm({ ...form, class_id: v, section_id: '' })} placeholder="Choose" options={(classes.data?.items ?? []).map((k) => ({ value: k.id, label: k.name }))} />
          </Field>
          <Field label="Section" hint="Leave blank for the whole class.">
            <Select value={form.section_id} onChange={(v) => setForm({ ...form, section_id: v })} placeholder="All sections"
              options={(sections.data?.items ?? []).filter((s) => !form.class_id || s.class_id === form.class_id).map((s) => ({ value: s.id, label: s.name }))} />
          </Field>
          <Field label="From" required>
            <Input type="date" value={form.from} onChange={(v) => setForm({ ...form, from: v })} />
          </Field>
        </FormGrid>
        <Field label="Reason" required>
          <Input value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} placeholder="Why, for the record" />
        </Field>
        <FormNotice error={end.error} ok={end.data ? `Ended for ${end.data.ended} ${end.data.ended === 1 ? 'child' : 'children'} from ${formatDate(end.data.from)}.` : undefined} />
        <div className="mt-3">
        <ConfirmButton disabled={!form.fee_head_id || !form.class_id || !form.from || form.reason.trim().length < 5 || end.isPending} confirmLabel="End the fee"
          question="End this fee for every child in the class from that date?" onConfirm={() => end.mutate()}>End the fee</ConfirmButton>
        </div>
      </div>
    </Card>
  )
}
