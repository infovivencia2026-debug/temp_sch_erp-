import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, ConfirmButton, Field, Input, Skeleton, ErrorState, FormNotice, useSort,
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
  /* WHAT A BOUNCE COSTS IS THE SCHOOL'S RULE, NOT THE COUNTER'S.

     This box defaulted to 500 — a number nobody chose, sitting in a field
     somebody retypes every time. Two people at the counter remember the
     school's figure differently and the second is not wrong, only later, so a
     family that argues gets a different answer from one that does not. The
     standing amount is now a setting; the box still overrides it for the
     cheque in front of you, because a dishonour the school decides not to
     charge for is ordinary. */
  const standing = useQuery({
    queryKey: ['cheque-bounce-fine'],
    queryFn: () => api.get<{ amount: number; set: boolean }>('/api/v1/fees/cheque-bounce-fine'),
  })
  const [fine, setFine] = useState('')
  const [savingRule, setSavingRule] = useState(false)
  const saveStanding = useMutation({
    mutationFn: (amount: number) => api.put('/api/v1/fees/cheque-bounce-fine', { amount }),
    onSuccess: () => {
      standing.refetch()
      setSavingRule(false)
      toast.ok('Saved. Every bounce from now on carries this charge unless you change it.')
    },
  })
  /* Blank means "use the school's figure", which is what the server does with
     nothing. Typing overrides it for this cheque only. */
  const effectiveFine = fine.trim() === ''
    ? (standing.data?.amount ?? 0)
    : Math.max(0, parseFloat(fine) || 0)

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
        // Blank sends nothing and the server applies the school's standing
        // amount; a typed figure overrides it for this cheque.
        fine_paise: fine.trim() === '' ? 0 : Math.round(effectiveFine * 100),
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
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-44">
                  <Field
                    label="Dishonour charge"
                    hint={
                      standing.data?.set
                        ? `School's rule: ₹${standing.data.amount}. Leave blank to use it.`
                        : 'No school rule set — nothing is charged unless you type an amount.'
                    }
                  >
                    <Input
                      value={fine}
                      onChange={setFine}
                      placeholder={standing.data?.set ? String(standing.data.amount) : 'none'}
                    />
                  </Field>
                </div>
                {/* Making it the rule, from the figure already typed. Two
                    screens for one number is how the number ends up different
                    in each. */}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={saveStanding.isPending || fine.trim() === ''}
                  onClick={() => {
                    setSavingRule(true)
                    saveStanding.mutate(Math.max(0, parseFloat(fine) || 0))
                  }}
                >
                  {savingRule && saveStanding.isPending ? 'Saving…' : 'Make this the rule'}
                </Button>
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
                          Math.round(effectiveFine * 100),
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
