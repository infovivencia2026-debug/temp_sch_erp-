import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Card, CardHeader, FormGrid, Field as FormField, Select, Input, Textarea,
  FormNotice, Table, Td, Badge, Button,
} from '@/components/ui'
import { formatPaise, formatDate } from '@/lib/utils'

/* What this child is charged, what has been waived, and the bill.

   All three lived somewhere else. The quote and the concession form were on
   the admission panel, which exists for about ninety seconds and is then
   gone — so for every child admitted before today, which is all of them,
   there was nowhere to see whether a waiver had been asked for and nowhere to
   ask for one. The record is where somebody looks.

   THE ORDER IS ENFORCED, NOT EXPLAINED.

   The engine applies a concession when it builds the invoice lines, and reads
   only approved ones. Raise the bill while a request is still waiting and the
   family is charged in full, with the waiver approved and inert an hour later
   — and the only fix then is a credit note.

   That was documented in a sentence nobody reads at the moment they press the
   button. So the button is held while anything is pending, and says why. A
   school that means to bill anyway decides the concession first, which takes
   one click and is the decision that was owed regardless.
*/

interface Concession {
  id: string
  kind: string
  status: string
  percent: string
  amount_paise: string
  reason: string
  decision_note: string
  decided_by: string
  asked_by: string
  raised_on: string
  decided_on: string
  fee_head: string
}

interface Quote {
  structure_id: string
  structure: string
  heads: { head: string; paise: number; instalment: number }[]
  total_paise: number
  instalments: number
  has_structure: boolean
  draft_structure: string
}

export default function StudentFees({ studentID, classID, mayEdit, onChanged }: {
  studentID: string
  classID?: string
  mayEdit: boolean
  onChanged: () => void
}) {
  const [asking, setAsking] = useState(false)
  const [kind, setKind] = useState('staff_ward')
  const [mode, setMode] = useState<'percent' | 'amount'>('percent')
  const [percent, setPercent] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')

  const quote = useQuery({
    queryKey: ['admission-fee', classID],
    enabled: !!classID,
    queryFn: () => api.get<Quote>(`/api/v1/students/fee-preview?class_id=${classID}`),
  })

  const detail = useQuery({
    queryKey: ['student-detail', studentID],
    queryFn: () => api.get<{ concessions: Concession[] }>(
      `/api/v1/students/${studentID}/detail`),
  })
  const concessions = detail.data?.concessions ?? []
  const pending = concessions.filter((c) => c.status === 'pending')

  const ask = useMutation({
    mutationFn: () => api.post('/api/v1/fees/concessions', {
      student_id: studentID,
      kind,
      percent: mode === 'percent' ? percent : '',
      amount_paise: mode === 'amount' ? Math.round(Number(amount) * 100) : undefined,
      reason,
    }),
    onSuccess: () => {
      setAsking(false)
      setPercent('')
      setAmount('')
      setReason('')
      detail.refetch()
      onChanged()
    },
  })

  const raise = useMutation({
    mutationFn: () => api.post<{ created: number; skipped: number }>(
      '/api/v1/fees/invoices/generate', {
        fee_structure_id: quote.data?.structure_id,
        instalment_no: 1,
        student_id: studentID,
      }),
    onSuccess: onChanged,
  })

  const q = quote.data
  const value = (c: Concession) =>
    c.percent ? `${c.percent}%` : formatPaise(Number(c.amount_paise || 0))

  return (
    <Card>
      <CardHeader
        title="Fee and concessions"
        description="What this class costs, what has been waived for this child, and the bill."
      />

      {q?.has_structure ? (
        <div className="border-b px-5 py-3 text-[13px]">
          <span className="font-medium">{q.structure}</span> —{' '}
          <span className="tabular-nums">{formatPaise(q.total_paise)}</span> for the
          year, {q.instalments} instalment{q.instalments === 1 ? '' : 's'}.
        </div>
      ) : (
        <div className="border-b px-5 py-3 text-[13px] text-muted-foreground">
          {q?.draft_structure
            ? `${q.draft_structure} exists for this class but has no priced heads, so nothing can be billed from it.`
            : 'No fee structure covers this class yet.'}
        </div>
      )}

      <Table
        head={['Asked for', 'Why', 'How much', 'Answer', 'Notes']}
        empty={!concessions.length}
        emptyLabel="No concession has been asked for on this child."
      >
        {concessions.map((c) => (
          <tr key={c.id}>
            <Td className="text-muted-foreground">
              {formatDate(c.raised_on)}
              {c.asked_by && (
                <span className="block text-[12px]">by {c.asked_by}</span>
              )}
            </Td>
            <Td>{c.kind.replace('_', ' ')}{c.fee_head ? ` · ${c.fee_head}` : ''}</Td>
            <Td className="tabular-nums">{value(c)}</Td>
            <Td>
              {/* A refusal is kept and shown. A table of approvals alone reads
                  as a school that approves everything, and the same request
                  comes back next term decided from nothing. */}
              <Badge tone={c.status === 'approved' ? 'success'
                : c.status === 'rejected' ? 'danger' : 'warning'}>
                {c.status}
              </Badge>
              {c.decided_by && (
                <span className="block text-[12px] text-muted-foreground">
                  {c.decided_by}{c.decided_on ? ` · ${formatDate(c.decided_on)}` : ''}
                </span>
              )}
            </Td>
            <Td className="text-muted-foreground">
              {c.decision_note || c.reason || '—'}
            </Td>
          </tr>
        ))}
      </Table>

      {mayEdit && (
        <div className="space-y-3 border-t p-4">
          {asking ? (
            <>
              <FormGrid>
                <FormField label="Why" required>
                  <Select value={kind} onChange={setKind} options={[
                    { value: 'staff_ward', label: "Staff member's child" },
                    { value: 'sibling', label: 'Sibling already here' },
                    { value: 'scholarship', label: 'Scholarship' },
                    { value: 'merit', label: 'Merit' },
                    { value: 'rte', label: 'RTE' },
                    { value: 'other', label: 'Other' },
                  ]} />
                </FormField>
                <FormField label="How much">
                  <Select value={mode} onChange={(v) => setMode(v as 'percent' | 'amount')}
                    options={[
                      { value: 'percent', label: 'A percentage of the fee' },
                      { value: 'amount', label: 'A fixed amount off' },
                    ]} />
                </FormField>
                {mode === 'percent' ? (
                  <FormField label="Percent" required>
                    <Input type="number" value={percent} onChange={setPercent} placeholder="50" />
                  </FormField>
                ) : (
                  <FormField label="Amount (₹)" required>
                    <Input type="number" value={amount} onChange={setAmount} placeholder="2000" />
                  </FormField>
                )}
              </FormGrid>
              <FormField label="Reason" required
                hint="What was agreed, and with whom. The principal reads this before deciding.">
                <Textarea rows={2} value={reason} onChange={setReason} />
              </FormField>
              <FormNotice error={ask.error} />
              <div className="flex items-center gap-2">
                <Button
                  disabled={ask.isPending || !reason.trim()
                    || (mode === 'percent' ? !percent : !amount)}
                  onClick={() => ask.mutate()}
                >
                  {ask.isPending ? 'Saving…' : 'Ask for this concession'}
                </Button>
                <Button variant="secondary" onClick={() => setAsking(false)}>Cancel</Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>
                Ask for a concession
              </Button>
              <Button
                size="sm"
                /* HELD WHILE ANYTHING IS WAITING.

                   Billing now charges the family in full and leaves the waiver
                   approved and inert an hour later, and the only remedy then is
                   a credit note. The rule was written in a sentence nobody
                   reads at the moment they press the button, so the button
                   holds instead. */
                disabled={raise.isPending || pending.length > 0 || !q?.has_structure}
                onClick={() => raise.mutate()}
              >
                {raise.isPending ? 'Raising…' : 'Raise this child’s fee'}
              </Button>
              {pending.length > 0 && (
                <span className="text-[12.5px] text-warning">
                  {pending.length === 1 ? 'A concession is' : `${pending.length} concessions are`}{' '}
                  waiting on the principal. Billing now would charge the full
                  amount and the waiver could not be applied afterwards.
                </span>
              )}
              {raise.isSuccess && (
                <span className="text-[12.5px] text-success">
                  {raise.data.created > 0
                    ? 'Raised. It is on the family’s fees page now.'
                    : 'Already raised for this instalment — nothing to do.'}
                </span>
              )}
              {raise.isError && (
                <span className="text-[12.5px] text-destructive">
                  {raise.error instanceof Error ? raise.error.message : 'Could not raise it'}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
