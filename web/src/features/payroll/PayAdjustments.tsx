import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Button, Input, Select, FormNotice } from '@/components/ui'
import { formatPaise } from '@/lib/utils'

interface Adjustment { id: string; employee_id: string; kind: 'earning' | 'deduction'; amount_paise: number; reason: string; by_name: string }

/* CHANGE A PERSON'S PAY BEFORE THE MONTH IS LOCKED (owner, 2026-10-13: "let
   them edit the payroll before publishing"). A bonus or arrears adds, a
   one-off deduction takes off, and each carries a reason the payslip prints.
   They belong to the month, so running the month again keeps them; once the
   month is locked they can only be read. */
export function PayAdjustments({ month, year, people, locked, canWrite }: {
  month: string; year: string; locked: boolean; canWrite: boolean
  people: { employee_id?: string; employee_code: string; full_name: string }[]
}) {
  const qc = useQueryClient()
  const [who, setWho] = useState('')
  const [kind, setKind] = useState<'earning' | 'deduction'>('earning')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const list = useQuery({
    queryKey: ['payroll-adjustments', month, year],
    queryFn: () => api.get<List<Adjustment>>(`/api/v1/payroll/adjustments?month=${month}&year=${year}`),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['payroll-adjustments'] })
    qc.invalidateQueries({ queryKey: ['payslips'] })
  }
  const add = useMutation({
    mutationFn: () => api.post('/api/v1/payroll/adjustments', {
      month: Number(month), year: Number(year), employee_id: who, kind,
      amount_paise: Math.round(Number(amount) * 100), reason: reason.trim(),
    }),
    onSuccess: () => { setAmount(''); setReason(''); refresh() },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/payroll/adjustments/${id}`),
    onSuccess: refresh,
  })
  const name = (id: string) => {
    const p = people.find((x) => x.employee_id === id)
    return p ? `${p.full_name} (${p.employee_code})` : 'Former staff'
  }
  const rows = list.data?.items ?? []
  const editable = canWrite && !locked
  if (!editable && rows.length === 0) return null
  const ready = who && Number(amount) > 0 && reason.trim()

  return (
    <Card>
      <CardHeader
        title="Changes to pay this month"
        description="A bonus or arrears adds to pay; a deduction takes off. The reason is printed on the payslip. Allowed until the month is locked."
      />
      {editable && (
        <div className="flex flex-wrap items-end gap-2 border-b px-5 py-4">
          <div className="w-full sm:w-64">
            <Select value={who} onChange={setWho} placeholder="Choose a person"
              options={people.filter((p) => p.employee_id).map((p) => ({ value: p.employee_id!, label: `${p.full_name} (${p.employee_code})` }))} />
          </div>
          <div className="w-full sm:w-44">
            <Select value={kind} onChange={(v) => setKind(v === 'deduction' ? 'deduction' : 'earning')}
              options={[{ value: 'earning', label: 'Add (bonus / arrears)' }, { value: 'deduction', label: 'Deduct' }]} />
          </div>
          <div className="w-full sm:w-32"><Input value={amount} onChange={setAmount} placeholder="Amount ₹" type="number" /></div>
          <div className="w-full sm:w-64"><Input value={reason} onChange={setReason} placeholder="Reason (shows on payslip)" /></div>
          <Button disabled={!ready || add.isPending} onClick={() => add.mutate()}>{add.isPending ? 'Saving…' : 'Add'}</Button>
          <div className="w-full"><FormNotice error={add.error ?? remove.error} /></div>
        </div>
      )}
      <Table head={['Employee', 'Change', 'Amount', 'Reason', 'By', '']} empty={rows.length === 0} emptyLabel="No changes this month.">
        {rows.map((a) => (
          <tr key={a.id}>
            <Td className="font-medium">{name(a.employee_id)}</Td>
            <Td>{a.kind === 'earning' ? <Badge tone="success">Add</Badge> : <Badge tone="warning">Deduct</Badge>}</Td>
            <Td className="num">{a.kind === 'earning' ? '+' : '−'}{formatPaise(a.amount_paise)}</Td>
            <Td>{a.reason}</Td>
            <Td className="text-muted-foreground">{a.by_name || '-'}</Td>
            <Td>{editable && <Button variant="secondary" disabled={remove.isPending} onClick={() => remove.mutate(a.id)}>Remove</Button>}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
