import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, ConfirmButton, Select, Loading, ErrorState, FormNotice,
} from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import { useCan } from '@/lib/session'
import { formatPaise, formatDate, cn } from '@/lib/utils'

/* Every payment, by how it arrived and whether it has cleared.
 *
 * Collection is not one number. Cash is in the drawer the moment it is taken;
 * an online payment is a promise until the gateway settles; a cheque is a
 * promise until the bank says otherwise, and can be withdrawn weeks later. A
 * screen that adds them into a single total is the reason a school's books and
 * its bank statement disagree.
 *
 * So the split by mode leads, unreconciled and failed are called out
 * separately, and clearing or bouncing a cheque is done here — both endpoints
 * existed and only the PDC register called them.
 */

interface Payment {
  id: string
  receipt_no?: string
  student_name: string
  amount_paise: number
  mode: string
  paid_on: string
  status: string
  gateway?: string
  reconciled: boolean
}

const MODES = ['cash', 'cheque', 'online', 'card', 'upi', 'bank_transfer']

export default function Payments() {
  const qc = useQueryClient()
  const can = useCan()
  const mayWrite = can('finance.payments.write')

  const [mode, setMode] = useState('')
  const [note, setNote] = useState('')

  const q = useQuery({
    queryKey: ['payments'],
    queryFn: () => api.get<List<Payment>>('/api/v1/finance/payments'),
  })

  const cheque = useMutation({
    mutationFn: (v: { id: string; action: 'clear' | 'bounce' }) =>
      api.post(`/api/v1/fees/payments/${v.id}/${v.action}`, {}),
    onSuccess: (_r, v) => {
      setNote(
        v.action === 'clear'
          ? 'Marked cleared.'
          : 'Marked bounced. Any bounce fine is applied to the student ledger.',
      )
      qc.invalidateQueries({ queryKey: ['payments'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  const all = q.data?.items ?? []
  const rows = mode ? all.filter((p) => p.mode === mode) : all

  const sum = (f: (p: Payment) => boolean) =>
    all.filter(f).reduce((n, p) => n + p.amount_paise, 0)

  const settled = sum((p) => p.status === 'success')
  const failed = all.filter((p) => p.status === 'failed')
  const bounced = all.filter((p) => p.status === 'bounced')
  const unreconciled = all.filter((p) => p.status === 'success' && !p.reconciled)

  const byMode = MODES.map((m) => ({ mode: m, total: sum((p) => p.mode === m && p.status === 'success') }))
    .filter((x) => x.total > 0)

  return (
    <>
      <PageHead
        eyebrow="Fees"
        title="Payments"
        description="How money arrived, and whether it has actually cleared."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Settled" value={formatPaise(settled)} hint={`${all.filter((p) => p.status === 'success').length} payments`} />
          <Stat label="Unreconciled" value={unreconciled.length}
            hint={unreconciled.length ? 'Not matched to a statement' : 'All matched'} />
          <Stat label="Failed" value={failed.length} />
          <Stat label="Bounced" value={bounced.length} hint={bounced.length ? 'Recover from the family' : undefined} />
        </CellGrid>

        {byMode.length > 0 && (
          <Card>
            <CardHeader
              title="By mode"
              description="Settled money only — a promise is not a collection"
            />
            <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
              {byMode.map((m) => (
                <div key={m.mode} className="bg-card px-5 py-4">
                  <p className="text-[13px] capitalize text-muted-foreground">
                    {m.mode.replace('_', ' ')}
                  </p>
                  <p className="stat">{formatPaise(m.total)}</p>
                </div>
              ))}
            </div>
          </Card>
        )}

        <FormNotice error={cheque.error} ok={note} />

        <Card>
          <CardHeader
            title="Payments"
            description="Most recent first"
            action={
              <Select
                value={mode}
                onChange={setMode}
                options={[
                  { value: '', label: 'All modes' },
                  ...MODES.map((m) => ({ value: m, label: m.replace('_', ' ') })),
                ]}
              />
            }
          />
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            <Table
              head={['Receipt', 'Student', 'Amount', 'Mode', 'Paid on', 'Status', '']}
              empty={!rows.length}
              emptyLabel="No payments recorded."
            >
              {rows.map((p) => (
                <tr key={p.id}>
                  <Td className="font-mono text-[12px]">{p.receipt_no ?? '—'}</Td>
                  <Td className="font-medium">{p.student_name}</Td>
                  <Td className="tabular-nums font-medium">{formatPaise(p.amount_paise)}</Td>
                  <Td className="capitalize text-muted-foreground">
                    {p.mode?.replace('_', ' ')}
                    {p.gateway && (
                      <span className="block text-[11.5px]">{p.gateway}</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(p.paid_on)}</Td>
                  <Td>
                    <StatusPill status={p.status} />
                    {p.status === 'success' && !p.reconciled && (
                      <span className={cn('block text-[11.5px] text-muted-foreground')}>
                        unreconciled
                      </span>
                    )}
                  </Td>
                  <Td>
                    {mayWrite && p.mode === 'cheque' && p.status === 'pending' && (
                      <span className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={cheque.isPending}
                          onClick={() => cheque.mutate({ id: p.id, action: 'clear' })}
                        >
                          Cleared
                        </Button>
                        {/* Bouncing reverses money that has already been
                            applied against a bill, and the family is holding a
                            receipt for it. One stray click on a row of a table
                            is not a decision. */}
                        <ConfirmButton
                          size="sm"
                          variant="secondary"
                          tone="danger"
                          disabled={cheque.isPending}
                          confirmLabel="Mark bounced"
                          question="Mark this cheque bounced? The payment is reversed and the bill goes back to unpaid."
                          onConfirm={() => cheque.mutate({ id: p.id, action: 'bounce' })}
                        >
                          Bounced
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
