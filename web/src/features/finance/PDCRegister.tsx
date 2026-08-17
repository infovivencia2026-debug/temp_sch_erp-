import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, ConfirmButton, Field, Input, Skeleton, ErrorState, FormNotice, useSort,
} from '@/components/ui'
import { formatPaise, formatDate } from '@/lib/utils'
import { useToast } from '@/components/Toast'

interface PDC {
  payment_id: string; receipt_no?: string; student_name: string; admission_no: string
  amount_paise: number; bank_name?: string; instrument_no?: string
  cheque_date?: string; due_today: boolean
}

/** Post-dated cheques: money promised but not banked. Nothing here counts as
    collection until it clears, which is why it has its own register. */
export default function PDCRegister() {
  const toast = useToast()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['pdc'],
    queryFn: () => api.get<List<PDC>>('/api/v1/fees/pdc'),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['pdc'] })
    qc.invalidateQueries({ queryKey: ['finance-dashboard'] })
  }
  // ₹500 is the usual dishonour charge, but it is a school policy and not a
  // constant: some charge nothing, some pass on exactly what the bank levied.
  // It was hard-coded, so a cashier had no way to enter the real figure and
  // the ledger recorded a number nobody had agreed.
  const [fine, setFine] = useState('500')

  const clear = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/fees/payments/${id}/clear`),
    onSuccess: () => {
      invalidate()
      toast.ok('Cheque marked cleared and the invoice settled')
    },
  })
  const bounce = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/fees/payments/${id}/bounce`, {
        fine_paise: Math.max(0, Math.round(parseFloat(fine || '0') * 100)),
      }),
    onSuccess: () => {
      invalidate()
      toast.ok('Cheque bounced — the invoice is open again and the charge applied')
    },
  })

  const rows = data?.items ?? []
  // Instrument date ascending: the register is worked in the order the bank
  // will take them.
  const sort = useSort<PDC>(
    rows,
    (p, k) => (p as unknown as Record<string, string | number | undefined>)[k],
    { key: 'cheque_date' },
  )
  const dueNow = rows.filter((r) => r.due_today)
  const total = rows.reduce((a, r) => a + r.amount_paise, 0)

  return (
    <>
      <PageHead
        eyebrow="Fee Workspace"
        title="Post-dated cheques"
        description="Instruments held against future dates. Clear them once the bank confirms; bounce them to reopen the invoice and levy the penalty."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Cheques held" value={rows.length} />
          <Stat label="Value held" value={formatPaise(total)} hint="Not counted as collection" />
          <Stat label="Bankable today" value={dueNow.length} hint="Instrument date reached" />
        </CellGrid>

        <Card>
          <CardHeader
            title="Register"
            description="Oldest instrument date first"
            action={
              <div className="w-40">
                <Field label="Dishonour charge" hint="Applied when a cheque bounces.">
                  <Input value={fine} onChange={setFine} placeholder="500" />
                </Field>
              </div>
            }
          />
          {isLoading ? (
            <Skeleton />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table
              head={[
                { label: 'Student', key: 'student_name' },
                { label: 'Instrument', key: 'instrument_no' },
                { label: 'Bank', key: 'bank_name' },
                { label: 'Dated', key: 'cheque_date' },
                { label: 'Amount', key: 'amount_paise' },
                'State',
                '',
              ]}
              sort={sort}
              empty={!rows.length}
              emptyLabel="No cheques currently held."
            >
              {sort.sorted.map((p) => (
                <tr key={p.payment_id}>
                  <Td className="font-medium">
                    {p.student_name}
                    <div className="font-mono text-[12px] text-muted-foreground">{p.admission_no}</div>
                  </Td>
                  <Td className="font-mono text-[12px]">{p.instrument_no ?? '—'}</Td>
                  <Td className="text-muted-foreground">{p.bank_name ?? '—'}</Td>
                  <Td>{formatDate(p.cheque_date)}</Td>
                  <Td className="font-medium">{formatPaise(p.amount_paise)}</Td>
                  <Td>
                    <Badge tone={p.due_today ? 'success' : 'warning'}>
                      {p.due_today ? 'bankable' : 'held'}
                    </Badge>
                  </Td>
                  <Td>
                    {/* Both of these move money and neither can be undone from
                        this screen, so each states what it is about to do. */}
                    <div className="flex flex-wrap gap-1.5">
                      <ConfirmButton
                        variant="primary"
                        disabled={clear.isPending}
                        question={`Bank ${formatPaise(p.amount_paise)} for ${p.student_name}?`}
                        confirmLabel="Mark cleared"
                        onConfirm={() => clear.mutate(p.payment_id)}
                      >
                        Clear
                      </ConfirmButton>
                      <ConfirmButton
                        tone="danger"
                        disabled={bounce.isPending}
                        question={`Reopen the invoice and add a ${formatPaise(
                          Math.max(0, Math.round(parseFloat(fine || '0') * 100)),
                        )} charge?`}
                        confirmLabel="Bounce"
                        onConfirm={() => bounce.mutate(p.payment_id)}
                      >
                        Bounce
                      </ConfirmButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {(clear.isError || bounce.isError) && (
            <div className="border-t px-5 py-3">
              <FormNotice error={clear.error ?? bounce.error} />
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}
