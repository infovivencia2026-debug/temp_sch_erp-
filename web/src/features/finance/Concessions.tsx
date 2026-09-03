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
  student_name: string
  admission_no: string
  amount_paise: number
  reason?: string
  mode?: string
  status: string
  processed_on?: string
  created_at: string
}

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

        <FormNotice error={decide.error} ok={note} />

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
          <CardHeader title="Refunds" description="Money returned, and what it was against" />
          {refunds.isLoading ? (
            <SkeletonTable columns={6} />
          ) : refunds.error ? (
            <ErrorState error={refunds.error} />
          ) : (
            <Table
              head={['Student', 'Amount', 'Reason', 'Mode', 'Status', 'Processed']}
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
                  <Td className="text-muted-foreground">{r.reason ?? '—'}</Td>
                  <Td className="text-muted-foreground">{r.mode ?? '—'}</Td>
                  <Td><StatusPill status={r.status} /></Td>
                  <Td className="text-muted-foreground">
                    {r.processed_on ? formatDate(r.processed_on) : '—'}
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
