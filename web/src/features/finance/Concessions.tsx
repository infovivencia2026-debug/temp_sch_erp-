import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, ConfirmButton, Select, Input, SkeletonTable, ErrorState, FormNotice,
} from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import { useCan } from '@/lib/session'
import { formatPaise, formatDate, cn } from '@/lib/utils'

/* Concessions and refunds: the two ways money leaves a fee ledger.
 *
 * They sit on one screen because they are the same decision from two ends —
 * somebody pays less, or somebody gets some back — and both need a signature
 * from whoever is accountable for the shortfall. A school that grants
 * concessions from one screen and refunds from another has two places to look
 * when the collection figure does not add up.
 *
 * Status is stored now (00180) and a REFUSAL IS KEPT. It used to be derived
 * from approved_by, and rejecting ran a DELETE — so a family that asked for
 * help and was told no left no trace at all: the same request came back next
 * term and was decided from nothing, a parent saying "we applied and heard
 * nothing" could not be answered, and an auditor saw a table of approvals,
 * which reads as a school that approves everything.
 *
 * Every refusal now carries a reason, because "rejected" with nothing beside
 * it is the decision somebody rings the office about — and the person
 * answering the telephone did not make it.
 */

interface Concession {
  id: string
  student_name: string
  admission_no: string
  fee_head?: string
  kind: string
  percent?: string
  amount_paise?: number
  reason?: string
  approved_by?: string
  status: string
  decision_note?: string
  requested_by?: string
  decided_on?: string
  raised_on?: string
}

interface Refund {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  amount_paise: number
  reason?: string
  mode?: string
  status: string
  processed_on?: string
  created_at: string
  requested_by?: string
  decided_by?: string
  decided_on?: string
  decision_note?: string
  reference_no?: string
}

const REFUND_MODES = [
  { value: 'cash', label: 'Cash' },
  { value: 'neft', label: 'NEFT / IMPS' },
  { value: 'upi', label: 'UPI' },
  { value: 'cheque', label: 'Cheque' },
]

export default function Concessions() {
  const qc = useQueryClient()
  const can = useCan()
  const mayDecide = can('finance.fees.write')

  const [status, setStatus] = useState('')
  const [note, setNote] = useState('')

  const concessions = useQuery({
    queryKey: ['concessions', status],
    queryFn: () => api.get<List<Concession>>(`/api/v1/fees/concessions?status=${status}`),
  })
  const refunds = useQuery({
    queryKey: ['refunds'],
    queryFn: () => api.get<List<Refund>>('/api/v1/fees/refunds'),
  })

  /* The note the decider writes, kept per row so two people being decided in
     one sitting cannot end up with each other's reason. */
  const [notes, setNotes] = useState<Record<string, string>>({})
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected' }) =>
      api.post(`/api/v1/workflow/concessions/${v.id}/decide`,
        { decision: v.decision, note: notes[v.id] ?? '' }),
    onSuccess: (_r, v) => {
      setNote(
        v.decision === 'approved'
          ? 'Approved. It applies to the next demand raised for this student.'
          : 'Rejected.',
      )
      qc.invalidateQueries({ queryKey: ['concessions'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  /* THE REFUND WRITE PATH. The table could be listed and never written: no
     refund could be raised, so none could be approved, so the payout batch
     that consumes approved refunds was permanently empty. A child leaving
     in November with two terms paid and unused had no settlement path. */
  const maySign = can('finance.refunds.write')
  const [refundStudent, setRefundStudent] = useState('')
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const students = useQuery({
    queryKey: ['students-picker'],
    queryFn: () => api.get<List<{ id: string; full_name?: string; admission_no?: string }>>('/api/v1/students?limit=400'),
  })
  const requestRefund = useMutation({
    mutationFn: () =>
      api.post('/api/v1/fees/refunds', {
        student_id: refundStudent,
        amount_paise: Math.round(Number(refundAmount || 0) * 100),
        reason: refundReason,
      }),
    onSuccess: () => {
      setNote('Refund raised. It waits for sign-off before any money moves.')
      setRefundStudent('')
      setRefundAmount('')
      setRefundReason('')
      qc.invalidateQueries({ queryKey: ['refunds'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })
  const [refundNotes, setRefundNotes] = useState<Record<string, string>>({})
  const decideRefund = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected' }) =>
      api.post(`/api/v1/fees/refunds/${v.id}/decide`, { decision: v.decision, note: refundNotes[v.id] ?? '' }),
    onSuccess: (_r, v) => {
      setNote(v.decision === 'approved' ? 'Approved. Mark it paid once the money has gone.' : 'Refused.')
      qc.invalidateQueries({ queryKey: ['refunds'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })
  /* How it was paid and the bank's reference, per row: the UTR is what the
     family quotes when they say the money never arrived. */
  const [payout, setPayout] = useState<Record<string, { mode: string; ref: string }>>({})
  const processRefund = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/fees/refunds/${id}/process`, {
        mode: payout[id]?.mode ?? 'neft',
        reference_no: payout[id]?.ref ?? '',
      }),
    onSuccess: () => {
      setNote('Paid out and on the ledger.')
      qc.invalidateQueries({ queryKey: ['refunds'] })
    },
  })

  const cs = concessions.data?.items ?? []
  const rs = refunds.data?.items ?? []
  const pending = cs.filter((c) => c.status === 'pending')
  const granted = cs
    .filter((c) => c.status === 'approved' && c.amount_paise)
    .reduce((n, c) => n + (c.amount_paise ?? 0), 0)
  const refunded = rs
    .filter((r) => r.status === 'processed' || r.status === 'approved')
    .reduce((n, r) => n + r.amount_paise, 0)

  /* A concession is either a percentage or a flat amount, never both. Showing
     one column for "value" and letting each row say which it is beats two
     mostly-empty columns. */
  function value(c: Concession) {
    if (c.percent && Number(c.percent) > 0) return `${Number(c.percent)}%`
    if (c.amount_paise) return formatPaise(c.amount_paise)
    return '—'
  }

  return (
    <>
      <PageHead
        eyebrow="Fees"
        title="Concessions & refunds"
        description="Discounts and scholarships awaiting sign-off, and money going back out."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Awaiting approval" value={pending.length}
            hint={pending.length ? 'Blocks the next demand' : 'All signed off'} />
          <Stat label="Concessions granted" value={cs.filter((c) => c.status === 'approved').length} />
          <Stat label="Value conceded" value={granted ? formatPaise(granted) : '—'}
            hint="Flat-amount awards only" />
          <Stat label="Refunded" value={refunded ? formatPaise(refunded) : '—'} />
        </CellGrid>

        <FormNotice error={decide.error ?? requestRefund.error ?? decideRefund.error ?? processRefund.error} ok={note} />

        <Card>
          <CardHeader
            title="Concessions"
            description="Unsigned first — a concession only reduces a bill once it is approved"
            action={
              <Select
                value={status}
                onChange={setStatus}
                options={[
                  { value: '', label: 'All' },
                  { value: 'pending', label: 'Awaiting approval' },
                  { value: 'approved', label: 'Approved' },
                  { value: 'rejected', label: 'Refused' },
                ]}
              />
            }
          />
          {concessions.isLoading ? (
            <SkeletonTable columns={7} />
          ) : concessions.error ? (
            <ErrorState error={concessions.error} />
          ) : (
            <Table
              head={['Student', 'Fee head', 'Kind', 'Value', 'Reason', 'Status', '']}
              empty={!cs.length}
              emptyLabel="No concessions recorded."
            >
              {cs.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">
                    {c.student_name}
                    <span className="block font-mono text-[11.5px] font-normal text-muted-foreground">
                      {c.admission_no}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{c.fee_head ?? 'All heads'}</Td>
                  <Td className="text-muted-foreground">{c.kind?.replace('_', ' ')}</Td>
                  <Td className="tabular-nums font-medium">{value(c)}</Td>
                  <Td className="text-muted-foreground">
                    <span className="block max-w-[24ch] truncate" title={c.reason ?? ''}>
                      {c.reason ?? '—'}
                    </span>
                  </Td>
                  <Td>
                    <StatusPill status={c.status} />
                    {/* The whole decision, not just its outcome: who asked,
                        who decided, when, and what they wrote. */}
                    {c.requested_by && (
                      <span className="block text-[11.5px] text-muted-foreground">
                        asked by {c.requested_by}
                        {c.raised_on ? ` · ${c.raised_on}` : ''}
                      </span>
                    )}
                    {c.approved_by && (
                      <span className="block text-[11.5px] text-muted-foreground">
                        {c.status === 'rejected' ? 'refused' : 'approved'} by {c.approved_by}
                        {c.decided_on ? ` · ${c.decided_on}` : ''}
                      </span>
                    )}
                    {c.decision_note && (
                      <span className="block max-w-[28ch] text-[11.5px] text-muted-foreground">
                        “{c.decision_note}”
                      </span>
                    )}
                  </Td>
                  <Td>
                    {c.status === 'pending' && mayDecide && (
                      <span className="flex flex-wrap items-center gap-2">
                        {/* Required on a refusal, and worth writing on an
                            approval — it is what the family is told and what
                            an auditor reads. */}
                        <Input
                          className="w-48"
                          value={notes[c.id] ?? ''}
                          onChange={(v) => setNotes({ ...notes, [c.id]: v })}
                          placeholder="Reason for the decision"
                        />
                        <Button
                          size="sm"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: c.id, decision: 'approved' })}
                        >
                          Approve
                        </Button>
                        <ConfirmButton
                          size="sm"
                          variant="secondary"
                          tone="danger"
                          disabled={decide.isPending}
                            confirmLabel="Reject"
                            question="Refuse this concession? It stays on the record with your reason, and the person who asked is told."
                          onConfirm={() => decide.mutate({ id: c.id, decision: 'rejected' })}
                        >
                          Reject
                        </ConfirmButton>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Refunds"
            description="Money returned, and what it was against. Raised by the office, signed off, then marked paid — a refund cannot exceed what the family actually paid."
          />
          {mayDecide && (
            <div className="flex flex-wrap items-end gap-3 border-b px-4 py-3">
              <label className="flex min-w-[16rem] flex-col gap-1 text-[12.5px]">
                <span className="text-muted-foreground">Child</span>
                <Select
                  value={refundStudent}
                  onChange={setRefundStudent}
                  placeholder="Choose a child"
                  options={(students.data?.items ?? []).map((s) => ({
                    value: s.id,
                    label: s.admission_no ? `${s.full_name ?? s.id} · ${s.admission_no}` : (s.full_name ?? s.id),
                  }))}
                />
              </label>
              <label className="flex flex-col gap-1 text-[12.5px]">
                <span className="text-muted-foreground">Amount (₹)</span>
                <Input className="w-32" value={refundAmount} onChange={setRefundAmount} placeholder="0" />
              </label>
              <label className="flex min-w-[18rem] flex-1 flex-col gap-1 text-[12.5px]">
                <span className="text-muted-foreground">Why the money is going back</span>
                <Input value={refundReason} onChange={setRefundReason} placeholder="Left in November; terms 2 and 3 unused" />
              </label>
              <Button
                size="sm"
                disabled={requestRefund.isPending || !refundStudent || !(Number(refundAmount) > 0) || !refundReason.trim()}
                onClick={() => requestRefund.mutate()}
              >
                Raise refund
              </Button>
            </div>
          )}
          {refunds.isLoading ? (
            <SkeletonTable columns={7} />
          ) : refunds.error ? (
            <ErrorState error={refunds.error} />
          ) : (
            <Table
              head={['Student', 'Amount', 'Reason', 'Mode', 'Status', 'Processed', '']}
              empty={!rs.length}
              emptyLabel="No refunds raised."
            >
              {rs.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">
                    {r.student_name}
                    <span className="block font-mono text-[11.5px] font-normal text-muted-foreground">
                      {r.admission_no}
                    </span>
                  </Td>
                  <Td className={cn('tabular-nums font-medium')}>{formatPaise(r.amount_paise)}</Td>
                  <Td className="text-muted-foreground">
                    <span className="block max-w-[24ch] truncate" title={r.reason ?? ''}>{r.reason ?? '—'}</span>
                  </Td>
                  <Td className="text-muted-foreground">
                    {r.mode ?? '—'}
                    {r.reference_no && (
                      <span className="block font-mono text-[11.5px]">{r.reference_no}</span>
                    )}
                  </Td>
                  <Td>
                    <StatusPill status={r.status} />
                    {r.requested_by && (
                      <span className="block text-[11.5px] text-muted-foreground">
                        asked by {r.requested_by} · {formatDate(r.created_at)}
                      </span>
                    )}
                    {r.decided_by && (
                      <span className="block text-[11.5px] text-muted-foreground">
                        {r.status === 'rejected' ? 'refused' : 'approved'} by {r.decided_by}
                        {r.decided_on ? ` · ${formatDate(r.decided_on)}` : ''}
                      </span>
                    )}
                    {r.decision_note && (
                      <span className="block max-w-[28ch] text-[11.5px] text-muted-foreground">“{r.decision_note}”</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">
                    {r.processed_on ? formatDate(r.processed_on) : '—'}
                  </Td>
                  <Td>
                    {r.status === 'pending' && maySign && (
                      <span className="flex flex-wrap items-center gap-2">
                        <Input
                          className="w-44"
                          value={refundNotes[r.id] ?? ''}
                          onChange={(v) => setRefundNotes({ ...refundNotes, [r.id]: v })}
                          placeholder="Reason for the decision"
                        />
                        <Button size="sm" disabled={decideRefund.isPending}
                          onClick={() => decideRefund.mutate({ id: r.id, decision: 'approved' })}>
                          Approve
                        </Button>
                        <ConfirmButton size="sm" variant="secondary" tone="danger" disabled={decideRefund.isPending}
                          confirmLabel="Refuse"
                          question="Refuse this refund? It stays on the record with your reason."
                          onConfirm={() => decideRefund.mutate({ id: r.id, decision: 'rejected' })}>
                          Refuse
                        </ConfirmButton>
                      </span>
                    )}
                    {r.status === 'approved' && maySign && (
                      <span className="flex flex-wrap items-center gap-2">
                        <Select
                          value={payout[r.id]?.mode ?? 'neft'}
                          onChange={(v) => setPayout({ ...payout, [r.id]: { mode: v, ref: payout[r.id]?.ref ?? '' } })}
                          options={REFUND_MODES}
                        />
                        <Input
                          className="w-36"
                          value={payout[r.id]?.ref ?? ''}
                          onChange={(v) => setPayout({ ...payout, [r.id]: { mode: payout[r.id]?.mode ?? 'neft', ref: v } })}
                          placeholder="UTR / cheque no."
                        />
                        <ConfirmButton size="sm" disabled={processRefund.isPending}
                          confirmLabel="Mark paid"
                          question="Record this refund as paid out? It goes on the family's ledger as money returned."
                          onConfirm={() => processRefund.mutate(r.id)}>
                          Mark paid
                        </ConfirmButton>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
