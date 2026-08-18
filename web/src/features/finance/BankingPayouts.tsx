import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ShieldCheck, Send, Info } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Checkbox, Field, FormGrid, FormNotice, Input, Select,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import {
  bankingBase, bankingQueryKey, inr, useBankAccounts, bankAccountOptions,
  BATCH_TONES, type PayoutBatch, type PayoutBatchDetail, type PayoutCandidate,
  type PayoutProvider,
} from './banking-lib'

/* Connected banking payouts.

   The screen is a maker/checker queue, and it is honest about two things that
   software of this kind usually is not.

   First, there is no live bank connection. This installation prepares a file
   the school uploads to its own net-banking portal; it does not move money.
   That is stated on the screen rather than buried, because a finance clerk who
   believes the ERP has paid a vendor will not chase the upload, and the vendor
   will not be paid.

   Second, the approve button is absent for the person who assembled the batch
   — and its absence is a courtesy, not the control. The server refuses the
   same request with a 403, and a CHECK constraint refuses it again beneath
   that. Hiding a button has never stopped anybody who can open a terminal. */

export default function BankingPayouts() {
  const can = useCan()
  const mayWrite = can('finance.payments.write')
  const mayApprove = can('finance.refunds.write')
  const mayExport = can('finance.export')

  const [openId, setOpenId] = useState('')
  const [status, setStatus] = useState('')

  const providers = useQuery({
    queryKey: [bankingQueryKey, 'providers'],
    queryFn: () => api.get<List<PayoutProvider>>(`${bankingBase}/payouts/providers`),
  })

  const q = useQuery({
    queryKey: [bankingQueryKey, 'payouts', status],
    queryFn: () =>
      api.get<List<PayoutBatch>>(`${bankingBase}/payouts${status ? `?status=${status}` : ''}`),
  })

  if (q.isLoading) return <Loading label="Reading the payout queue…" />
  if (q.error) return <ErrorState error={q.error} />

  const rows = q.data?.items ?? []
  const awaiting = rows.filter((b) => b.status === 'submitted')
  /* Branching on the code, not on the sentence. This read
     `approval_blocked?.includes('assembled')`, so the tile counted batches by
     matching English the server writes for a human — reword that message and
     the count silently becomes nought, which is the reading that says "nothing
     is waiting on you" when something is. */
  const mine = awaiting.filter(
    (b) => !b.caller_may_approve && b.approval_blocked_code === 'assembled_by_caller',
  )
  const releasable = awaiting.filter((b) => b.caller_may_approve)
  const approved = rows.filter((b) => b.status === 'approved')
  const pendingValue = awaiting.reduce((n, b) => n + b.total_paise, 0)

  const transmitting = providers.data?.items?.find((p) => p.can_transmit)

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Banking payouts"
        description="Assemble outbound payments as a batch, have somebody else release it, and export the file your bank accepts."
        width="wide"
      />
      <PageBody width="wide">
        {/* The honesty notice. Not a footnote. */}
        {!transmitting && (
          <Card>
            <div className="flex items-start gap-3 p-5">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="text-[13px]">
                <p className="font-medium">This does not send money to the bank by itself.</p>
                <p className="mt-1 text-muted-foreground">
                  {providers.data?.items?.[0]?.why ??
                    'Approved batches are exported as a file for you to upload to your bank’s own portal.'}{' '}
                  A batch marked <em>exported</em> means the file has been produced — not that
                  anybody has been paid. The reconciliation will tell you when the money actually
                  left, by matching the payout against the bank statement.
                </p>
              </div>
            </div>
          </Card>
        )}

        <CellGrid cols={4}>
          <Stat
            label="Awaiting release"
            value={awaiting.length}
            icon={ShieldCheck}
            hint={releasable.length ? `${releasable.length} you can release` : 'none you can release'}
          />
          <Stat label="Value awaiting release" value={inr(pendingValue)} />
          <Stat
            label="Released, not yet exported"
            value={approved.length}
            hint={approved.length ? 'The file has not been produced yet' : undefined}
          />
          <Stat
            label="Waiting on somebody else"
            value={mine.length}
            hint={mine.length ? 'You assembled these — another person must release them' : undefined}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Batches"
            description="Most recent first"
            action={
              <Select
                value={status}
                onChange={setStatus}
                options={[
                  { value: '', label: 'All' },
                  { value: 'draft', label: 'Draft' },
                  { value: 'submitted', label: 'Awaiting release' },
                  { value: 'approved', label: 'Released' },
                  { value: 'exported', label: 'Exported' },
                  { value: 'rejected', label: 'Refused' },
                ]}
              />
            }
          />
          <Table
            head={['Batch', 'Purpose', 'Value date', 'From', { label: 'Amount', align: 'right' },
              'Items', 'Status', 'Made by', '']}
            empty={rows.length === 0}
            emptyLabel="No payout batches yet."
          >
            {rows.map((b) => (
              <tr key={b.id}>
                <Td className="font-medium tabular-nums">{b.batch_no}</Td>
                <Td className="capitalize text-muted-foreground">{b.purpose}</Td>
                <Td className="text-muted-foreground">{b.value_date}</Td>
                <Td className="text-muted-foreground">{b.account_label}</Td>
                <Td className="text-right tabular-nums font-medium">{inr(b.total_paise)}</Td>
                <Td className="tabular-nums">{b.item_count}</Td>
                <Td>
                  <Badge tone={BATCH_TONES[b.status] ?? 'neutral'}>{b.status}</Badge>
                  {b.decision_reason && (
                    <span className="block text-[12px] text-muted-foreground">
                      {b.decision_reason}
                    </span>
                  )}
                </Td>
                <Td className="text-[13px] text-muted-foreground">
                  {b.created_by}
                  {b.approved_by && <span className="block">released by {b.approved_by}</span>}
                </Td>
                <Td>
                  <Button
                    size="sm"
                    variant={openId === b.id ? 'primary' : 'secondary'}
                    onClick={() => setOpenId(openId === b.id ? '' : b.id)}
                  >
                    {openId === b.id ? 'Close' : 'Open'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {openId && (
          <BatchDetail
            /* Keyed by the batch.

               `reason` lives in that component, so opening a second batch
               while a refusal note was typed carried the note across: the
               decision recorded against batch B quoted the reason written for
               batch A. That text is the audit trail for a payment refusal. */
            key={openId}
            id={openId}
            mayWrite={mayWrite}
            mayApprove={mayApprove}
            mayExport={mayExport}
          />
        )}

        {mayWrite && <NewBatch />}
      </PageBody>
    </>
  )
}

// --- one batch ---------------------------------------------------------------

function BatchDetail({
  id, mayWrite, mayApprove, mayExport,
}: { id: string; mayWrite: boolean; mayApprove: boolean; mayExport: boolean }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')

  const q = useQuery({
    queryKey: [bankingQueryKey, 'payout', id],
    queryFn: () => api.get<PayoutBatchDetail>(`${bankingBase}/payouts/${id}`),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: [bankingQueryKey] })

  const submit = useMutation({
    mutationFn: () => api.post(`${bankingBase}/payouts/${id}/submit`, {}),
    onSuccess: invalidate,
  })
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api.post(`${bankingBase}/payouts/${id}/decide`, { approve, reason }),
    onSuccess: () => { setReason(''); invalidate() },
  })
  const remove = useMutation({
    mutationFn: (itemId: string) => api.del(`${bankingBase}/payouts/${id}/items/${itemId}`),
    onSuccess: invalidate,
  })

  if (q.isLoading) return <Loading label="Opening the batch…" />
  if (q.error) return <ErrorState error={q.error} />
  const b = q.data
  if (!b) return null

  const missingBank = b.items.filter((i) => !i.account_masked)

  return (
    <>
      <Card>
        <CardHeader
          title={`${b.batch_no} — ${b.item_count} beneficiaries, ${inr(b.total_paise)}`}
          description={`${b.purpose} · value date ${b.value_date} · debiting ${b.account_label}`}
          action={
            <span className="flex flex-wrap gap-2">
              {b.status === 'draft' && mayWrite && (
                <Button
                  disabled={submit.isPending || b.item_count === 0}
                  onClick={() => submit.mutate()}
                >
                  <Send className="h-4 w-4" />
                  Send for release
                </Button>
              )}
              {(b.status === 'approved' || b.status === 'exported') && mayExport && (
                <a href={`${bankingBase}/payouts/${b.id}/file`} download>
                  <Button variant="secondary">
                    <Download className="h-4 w-4" /> Bank file
                  </Button>
                </a>
              )}
            </span>
          }
        />

        <div className="space-y-4 p-5">
          <FormNotice error={submit.error ?? decide.error ?? remove.error} />

          {b.status === 'submitted' && (
            <div className="rounded-md border px-4 py-3">
              {b.caller_may_approve ? (
                <div className="space-y-3">
                  <p className="text-[13px]">
                    <span className="font-medium">{b.created_by}</span> assembled this batch of{' '}
                    {inr(b.total_paise)}. Releasing it is your decision and it is recorded against
                    your name.
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-[280px] flex-1">
                      <Field label="Note or reason" hint="Required if you refuse it">
                        <Input value={reason} onChange={setReason} placeholder="Checked against the approved bills" />
                      </Field>
                    </div>
                    <ConfirmButton
                      confirmLabel="Release it"
                      question={`Release ${inr(b.total_paise)} to ${b.item_count} beneficiaries?`}
                      onConfirm={() => decide.mutate(true)}
                      disabled={decide.isPending}
                      variant="primary"
                      size="md"
                    >
                      Release
                    </ConfirmButton>
                    <Button
                      variant="secondary"
                      tone="danger"
                      disabled={!reason || decide.isPending}
                      onClick={() => decide.mutate(false)}
                    >
                      Refuse
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  {b.approval_blocked ??
                    'This batch is waiting for somebody else to release it.'}{' '}
                  {mayApprove
                    ? 'That separation is the control — it is enforced on the server, not by this screen.'
                    : ''}
                </p>
              )}
            </div>
          )}

          {b.status === 'exported' && (
            <p className="text-[13px] text-muted-foreground">
              The file has been produced{b.exported_at ? ` on ${b.exported_at.slice(0, 10)}` : ''}.
              Upload it to your bank’s portal. Nothing here knows whether the bank has paid these
              beneficiaries — the reconciliation will show it when the statement arrives.
            </p>
          )}

          {missingBank.length > 0 && (
            <p className="text-[13px] text-destructive">
              {missingBank.length} beneficiary(ies) have no account number on file. The bank will
              reject those rows.
            </p>
          )}
        </div>

        {b.items.length === 0 ? (
          <EmptyState
            title="No beneficiaries yet"
            body="Add the bills, payslips or refunds this batch pays."
          />
        ) : (
          <Table
            head={['Beneficiary', 'Account', 'IFSC', { label: 'Amount', align: 'right' },
              'Mode', 'For', 'Status', '']}
            empty={false}
          >
            {b.items.map((i) => (
              <tr key={i.id}>
                <Td className="font-medium">
                  {i.beneficiary_name}
                  <span className="block text-[12px] font-normal capitalize text-muted-foreground">
                    {i.beneficiary_kind}
                  </span>
                </Td>
                <Td className="font-mono text-[12px]">{i.account_masked || '—'}</Td>
                <Td className="font-mono text-[12px] text-muted-foreground">{i.ifsc}</Td>
                <Td className="text-right tabular-nums">{inr(i.amount_paise)}</Td>
                <Td className="uppercase text-muted-foreground">{i.mode}</Td>
                <Td className="text-[13px] text-muted-foreground">
                  {i.source_kind?.replace('_', ' ') ?? 'ad hoc'}
                </Td>
                <Td>
                  <Badge tone={i.status === 'paid' ? 'success' : i.status === 'failed' ? 'danger' : 'neutral'}>
                    {i.status}
                  </Badge>
                  {i.utr && (
                    <span className="block font-mono text-[12px] text-muted-foreground">{i.utr}</span>
                  )}
                </Td>
                <Td>
                  {b.status === 'draft' && mayWrite && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(i.id)}
                    >
                      Remove
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {b.status === 'draft' && mayWrite && <AddBeneficiaries batchId={b.id} onDone={invalidate} />}
    </>
  )
}

// --- adding what the batch pays ----------------------------------------------

function AddBeneficiaries({ batchId, onDone }: { batchId: string; onDone: () => void }) {
  const [kind, setKind] = useState('vendor_bill')
  const [picked, setPicked] = useState<Record<string, boolean>>({})

  const q = useQuery({
    queryKey: [bankingQueryKey, 'payout-candidates', kind],
    queryFn: () => api.get<List<PayoutCandidate>>(`${bankingBase}/payouts/candidates?kind=${kind}`),
  })

  const add = useMutation({
    mutationFn: (items: PayoutCandidate[]) =>
      api.post<{ added: number; skipped_no_bank: string[] }>(
        `${bankingBase}/payouts/${batchId}/items`,
        {
          items: items.map((c) => ({
            beneficiary_kind: c.beneficiary_kind,
            vendor_id: c.beneficiary_kind === 'vendor' ? c.beneficiary_id : '',
            employee_id: c.beneficiary_kind === 'employee' ? c.beneficiary_id : '',
            student_id: c.beneficiary_kind === 'student' ? c.beneficiary_id : '',
            beneficiary_name: c.beneficiary_name,
            /* Account number and IFSC are deliberately not sent.

               This list shows them masked, so the browser does not hold the
               real ones and could not send them if it wanted to. The server
               reads each beneficiary's number from their own record — which
               means an account number never leaves the database in order to be
               paid, only in order to be deliberately revealed. */
            account_number: '',
            ifsc: '',
            amount_paise: c.amount_paise,
            narration: c.reference,
            source_kind: c.source_kind,
            source_id: c.source_id,
          })),
        },
      ),
    onSuccess: () => { setPicked({}); onDone() },
  })

  const rows = q.data?.items ?? []
  const chosen = rows.filter((c) => picked[c.source_id])
  const total = chosen.reduce((n, c) => n + c.amount_paise, 0)

  return (
    <Card>
      <CardHeader
        title="Add what this batch pays"
        description="Only documents already approved by their own workflow appear here. Anything already in a live batch is left out — a bill cannot be paid twice."
        action={
          <Select
            value={kind}
            onChange={(v) => { setKind(v); setPicked({}) }}
            options={[
              { value: 'vendor_bill', label: 'Approved vendor bills' },
              { value: 'payslip', label: 'Payslips' },
              { value: 'refund', label: 'Approved refunds' },
            ]}
          />
        }
      />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : (
        <>
          <Table
            head={['', 'Beneficiary', 'Reference', 'Account', { label: 'Amount', align: 'right' }, 'Due']}
            empty={rows.length === 0}
            emptyLabel="Nothing outstanding of this kind."
          >
            {rows.map((c) => (
              <tr key={c.source_id}>
                <Td>
                  <Checkbox
                    checked={!!picked[c.source_id]}
                    onChange={(v) => setPicked({ ...picked, [c.source_id]: v })}
                    label=""
                    srLabel={`Pay ${c.beneficiary_name} ${inr(c.amount_paise)} against ${c.reference}`}
                    hint={c.has_bank ? undefined : 'no bank details'}
                  />
                </Td>
                <Td className="font-medium">{c.beneficiary_name}</Td>
                <Td className="text-muted-foreground">{c.reference}</Td>
                <Td className="font-mono text-[12px]">
                  {c.has_bank ? (
                    c.account_masked
                  ) : (
                    <span className="text-destructive">none on file</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">{inr(c.amount_paise)}</Td>
                <Td className="text-muted-foreground">{c.due_on ?? '—'}</Td>
              </tr>
            ))}
          </Table>
          <div className="space-y-3 border-t p-5">
            <FormNotice error={add.error} />
            {add.data && (
              <p className="text-[13px]">
                Added {add.data.added}.{' '}
                {add.data.skipped_no_bank.length > 0 && (
                  <span className="text-destructive">
                    Left out, with no usable account on file:{' '}
                    {add.data.skipped_no_bank.join(', ')}.
                  </span>
                )}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={chosen.length === 0 || add.isPending}
                onClick={() => add.mutate(chosen)}
              >
                Add {chosen.length || ''} {chosen.length === 1 ? 'beneficiary' : 'beneficiaries'}
                {chosen.length > 0 && ` — ${inr(total)}`}
              </Button>
              {chosen.some((c) => !c.has_bank) && (
                <span className="text-[13px] text-destructive">
                  Some of those have no account number on file and will be left out.
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  )
}

// --- a new batch -------------------------------------------------------------

function NewBatch() {
  const qc = useQueryClient()
  const accounts = useBankAccounts()
  const [open, setOpen] = useState(false)
  const [accountId, setAccountId] = useState('')
  const [purpose, setPurpose] = useState('vendor')
  const [valueDate, setValueDate] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post(`${bankingBase}/payouts`, {
        bank_account_id: accountId,
        purpose,
        value_date: valueDate || undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [bankingQueryKey] }),
  })

  const payable = bankAccountOptions(accounts.data?.items, true)

  return (
    <Card>
      <CardHeader
        title="Start a batch"
        description="You assemble it; somebody else releases it. That separation is enforced on the server."
        action={
          <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'New batch'}
          </Button>
        }
      />
      {open && (
        <div className="space-y-5 p-5">
          {payable.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No account is marked for payouts. Mark one on the bank reconciliation screen — it
              stops the collection account being debited by accident.
            </p>
          ) : (
            <>
              <FormGrid>
                <Field label="Debit from" required>
                  <Select
                    value={accountId}
                    onChange={setAccountId}
                    placeholder="Choose an account"
                    options={payable}
                  />
                </Field>
                <Field label="Purpose" required>
                  <Select
                    value={purpose}
                    onChange={setPurpose}
                    options={[
                      { value: 'vendor', label: 'Vendor payments' },
                      { value: 'salary', label: 'Salary' },
                      { value: 'refund', label: 'Fee refunds' },
                      { value: 'scholarship', label: 'Scholarship / DBT' },
                      { value: 'mixed', label: 'Mixed' },
                    ]}
                  />
                </Field>
                <Field label="Value date" hint="When the bank should process it">
                  <Input type="date" value={valueDate} onChange={setValueDate} />
                </Field>
              </FormGrid>
              <FormNotice error={save.error} ok={save.isSuccess ? 'Batch started.' : undefined} />
              <Button disabled={!accountId || save.isPending} onClick={() => save.mutate()}>
                Start the batch
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  )
}
