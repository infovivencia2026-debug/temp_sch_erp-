import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { rupeesToPaise } from '@/lib/money'
import { Card, CardHeader, Table, Td, Badge, Button, Select, Input, Textarea, Field, FormGrid, FormNotice, Checkbox } from '@/components/ui'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import { formatDate, formatPaise } from '@/lib/utils'

/* "I HAVE PAID" (owner, 2026-11-21). A family that paid the school outside
   the app (bank transfer, UPI to the school's account, cheque at the bank)
   tells the office: amount, how, the UTR, the date, a screenshot and which
   fees. The office makes the receipt or says why not; the status shows here.
   Nothing is paid from this card and no message is sent. */

interface Line { line_id: string; fee: string; instalment_no: number | null; due_on: string | null; balance_paise: number }
interface Item { id: string; amount_paise: number; mode: string; reference_no: string | null; paid_on: string; status: string; reject_reason: string | null; created_at: string; receipt_no: string | null }

const MODES = [{ value: 'upi', label: 'UPI' }, { value: 'neft', label: 'NEFT / IMPS / RTGS' }, { value: 'cheque', label: 'Cheque' }, { value: 'dd', label: 'Demand draft' }, { value: 'card', label: 'Card' }, { value: 'cash', label: 'Cash at the office' }]
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function IHavePaid({ studentId }: { studentId: string }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['portal-offline', studentId], queryFn: () => api.get<{ lines: Line[]; items: Item[] }>(`/api/v1/portal/fees/offline?student_id=${studentId}`), enabled: !!studentId })
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('upi')
  const [utr, setUtr] = useState('')
  const [paidOn, setPaidOn] = useState(today())
  const [file, setFile] = useState<UploadedFile | null>(null)
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const send = useMutation({
    mutationFn: () => api.post(`/api/v1/portal/fees/offline?student_id=${studentId}`, {
      amount_paise: rupeesToPaise(amount), mode, reference_no: utr.trim() || undefined, paid_on: paidOn, attachment_file_id: file?.file_id, line_ids: lines, note: note.trim() || undefined,
    }),
    onSuccess: async () => { setOpen(false); setAmount(''); setUtr(''); setFile(null); setNote(''); setLines([]); await qc.invalidateQueries({ queryKey: ['portal-offline', studentId] }) },
  })
  const block = !(rupeesToPaise(amount) > 0) ? 'Enter the amount you paid.'
    : mode === 'upi' && !/^\d{12}$/.test(utr.trim()) ? 'A UPI UTR is 12 digits; it is in your payment app.'
    : mode !== 'upi' && mode !== 'cash' && !utr.trim() ? 'Enter the UTR or cheque number.' : ''
  const items = q.data?.items ?? []
  return (
    <Card>
      <CardHeader title="Paid outside the app?" action={!open ? <Button variant="secondary" onClick={() => setOpen(true)}>I have paid</Button> : undefined} />
      {open && (
        <div className="space-y-3 p-[var(--card-pad)]">
          <p className="text-[14px]">Paid by bank, UPI or cheque? Tell the office here.</p>
          <FormGrid>
            <Field label="Amount (₹)" required><Input value={amount} onChange={setAmount} type="number" /></Field>
            <Field label="How you paid"><Select value={mode} onChange={setMode} options={MODES} /></Field>
            {mode !== 'cash' && <Field label={mode === 'cheque' || mode === 'dd' ? 'Cheque / DD number' : 'UTR / transaction number'} required={mode !== 'cash'}><Input value={utr} onChange={setUtr} /></Field>}
            <Field label="Date paid"><Input type="date" value={paidOn} onChange={setPaidOn} max={today()} /></Field>
          </FormGrid>
          {(q.data?.lines.length ?? 0) > 0 && (
            <fieldset className="space-y-1">
              <legend className="mb-1 text-[13px] text-muted-foreground">Which fees (optional)</legend>
              {q.data!.lines.map((l) => (
                <Checkbox key={l.line_id} label={`${l.fee}${l.instalment_no ? ` · Instalment ${l.instalment_no}` : ''} · ${formatPaise(l.balance_paise)} due`} checked={lines.includes(l.line_id)}
                  onChange={(v) => setLines((x) => (v ? [...x, l.line_id] : x.filter((y) => y !== l.line_id)))} />
              ))}
            </fieldset>
          )}
          <FilePicker value={file} onChange={setFile} label="Screenshot or slip (optional)" hint="Up to 2 MB" maxBytes={2 * 1024 * 1024} />
          <Field label="Note for the office (optional)"><Textarea value={note} onChange={setNote} rows={2} /></Field>
          <FormNotice error={send.error} />
          <div className="flex flex-wrap items-center gap-3">
            <Button needsNetwork disabled={!!block || send.isPending} onClick={() => send.mutate()}>{send.isPending ? 'Sending…' : 'Send to the school office'}</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            {block && <span className="text-[13px] text-muted-foreground">{block}</span>}
          </div>
        </div>
      )}
      {items.length > 0 && (
        <Table head={['Reported', 'Paid on', 'Amount', 'How', 'UTR', 'Status']} empty={false}>
          {items.map((i) => (
            <tr key={i.id}>
              <Td className="whitespace-nowrap">{formatDate(i.created_at)}</Td><Td className="whitespace-nowrap">{formatDate(i.paid_on)}</Td>
              <Td className="whitespace-nowrap tabular-nums">{formatPaise(i.amount_paise)}</Td><Td>{MODES.find((m) => m.value === i.mode)?.label ?? i.mode}</Td>
              <Td className="whitespace-nowrap font-mono text-[12px]">{i.reference_no || '-'}</Td>
              <Td><Badge tone={i.status === 'receipted' ? 'success' : i.status === 'rejected' ? 'danger' : 'warning'}>{i.status === 'receipted' ? `Receipt ${i.receipt_no ?? ''}` : i.status === 'rejected' ? 'Not accepted' : 'With the office'}</Badge>
                {i.reject_reason && <span className="block text-[12px] text-muted-foreground">{i.reject_reason}</span>}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
