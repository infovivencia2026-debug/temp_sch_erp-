import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Hourglass, Landmark, ListPlus, Send, Stamp } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import {
  concessionsBase, concessionsKey, inr, toPaise, useSchemes, useAcademicYears,
  AGE_LABEL, CLAIM_LABEL, CLAIM_TONE,
  type Claim, type ClaimAgeing, type ClaimDetail, type ClaimLine,
  type ReimbursementRate,
} from './concessions-lib'

/* Government reimbursement claims.

   A private school in the RTE 25% quota claims a per-child reimbursement from
   the state, quarterly, at a rate a government order sets. Every school has the
   forms. Almost none of them can answer the question this screen is built
   around:

     how much is the state sitting on, how old is it, and for which children?

   So the ageing report is the first thing on the page and the oldest bucket is
   first inside it. A claim from two years ago is worth more attention than one
   from last month, and every ageing report that sorts newest-first buries
   exactly the rows it exists to surface.

   The three money columns never collapse into one:

     Claimed     what the school asked for, per child, at the notified rate
     Sanctioned  what the department's order actually approved, per child
     Received    what the treasury actually released

   Outstanding is claimed minus received rather than sanctioned minus received,
   because a department that sanctioned less than was claimed still leaves the
   school short — and hiding the disallowed part behind the sanction is how a
   shortfall stops being anybody's problem.

   What this screen does not do: submit anything anywhere. There is no state
   API. The claim leaves as a CSV somebody uploads to the department's portal or
   prints, and the release comes back as a receipt somebody types. */

export default function GovernmentClaims() {
  const can = useCan()
  const mayWrite = can('finance.fees.write')
  const mayApprove = can('finance.refunds.write')
  const mayExport = can('finance.export')

  const [openClaim, setOpenClaim] = useState<string | null>(null)
  const [status, setStatus] = useState('')

  const ageing = useQuery({
    queryKey: [concessionsKey, 'ageing'],
    queryFn: () => api.get<ClaimAgeing>(`${concessionsBase}/claims/ageing`),
  })
  const claims = useQuery({
    queryKey: [concessionsKey, 'claims', status],
    queryFn: () =>
      api.get<List<Claim>>(`${concessionsBase}/claims${status ? `?status=${status}` : ''}`),
  })

  if (claims.isLoading) return <Loading label="Opening the claim register…" />
  if (claims.error) return <ErrorState error={claims.error} />
  /* The gap is why this screen exists, so it may not fail quietly. `age` was
     read with `?.` throughout and the panel drawn only `{age && …}`, so a
     failed ageing call left "Outstanding with the state ₹0" and "Nothing older
     than a year" above a register that might be owed two years of fees — the
     one reading a school would act on, stated confidently, from no data. */
  if (ageing.error) return <ErrorState error={ageing.error} />

  const rows = claims.data?.items ?? []
  const age = ageing.data
  const overAYear = age?.buckets.find((b) => b.bucket === '365+')

  return (
    <>
      <PageHead
        eyebrow="Concessions"
        title="Government reimbursement claims"
        description="RTE and state fee reimbursement: what was claimed, what was sanctioned, and what the treasury has actually released."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat
            label="Outstanding with the state"
            value={ageing.isLoading ? '—' : inr(age?.total_outstanding_paise ?? 0)}
            icon={Hourglass}
            hint="Claimed and not yet received"
          />
          <Stat
            label="Owed over a year"
            value={ageing.isLoading ? '—' : inr(overAYear?.outstanding_paise ?? 0)}
            hint={
              ageing.isLoading
                ? 'Reading the ageing…'
                : overAYear?.claim_count
                  ? `${overAYear.claim_count} claim(s), ${overAYear.child_count} children`
                  : 'Nothing older than a year'
            }
          />
          <Stat label="Claims on file" value={rows.length} icon={Landmark} />
          <Stat
            label="Awaiting a sanction order"
            value={rows.filter((c) => c.status === 'submitted').length}
            hint="Sent to the department, nothing back yet"
          />
        </CellGrid>

        {age && <AgeingPanel ageing={age} onOpen={setOpenClaim} />}

        <Card>
          <CardHeader
            title="Claims"
            description="One per scheme per period. The claim number is the school's own; the department's acknowledgement is recorded beside it."
            action={
              <Select
                value={status}
                onChange={setStatus}
                options={[
                  { value: '', label: 'Every status' },
                  { value: 'draft', label: 'Draft' },
                  { value: 'submitted', label: 'With the department' },
                  { value: 'part_sanctioned', label: 'Part sanctioned' },
                  { value: 'sanctioned', label: 'Sanctioned' },
                  { value: 'rejected', label: 'Rejected' },
                  { value: 'closed', label: 'Closed' },
                ]}
              />
            }
          />
          <Table
            head={[
              'Claim', 'Period', 'Children',
              { label: 'Claimed', align: 'right' },
              { label: 'Sanctioned', align: 'right' },
              { label: 'Received', align: 'right' },
              { label: 'Outstanding', align: 'right' },
              'Age', 'Status', '',
            ]}
            empty={rows.length === 0}
            emptyLabel="No claims raised yet."
          >
            {rows.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium">
                  {c.claim_no}
                  <span className="block text-[12px] font-normal text-muted-foreground">
                    {c.scheme_name}
                  </span>
                </Td>
                <Td className="text-[13px] text-muted-foreground">
                  {c.period_start} to {c.period_end}
                  <span className="block text-[12px]">{c.academic_year}</span>
                </Td>
                <Td>{c.child_count}</Td>
                <Td className="text-right tabular-nums">{inr(c.claimed_paise)}</Td>
                <Td className="text-right tabular-nums">
                  {c.status === 'draft' || c.status === 'submitted'
                    ? '—'
                    : inr(c.sanctioned_paise)}
                </Td>
                <Td className="text-right tabular-nums">{inr(c.received_paise)}</Td>
                <Td
                  className={
                    c.outstanding_paise > 0
                      ? 'text-right font-medium tabular-nums text-warning'
                      : 'text-right tabular-nums text-muted-foreground'
                  }
                >
                  {inr(c.outstanding_paise)}
                </Td>
                <Td className="text-[13px] text-muted-foreground">
                  {c.submitted_on ? `${c.age_days} days` : '—'}
                </Td>
                <Td>
                  <Badge tone={CLAIM_TONE[c.status]}>{CLAIM_LABEL[c.status]}</Badge>
                </Td>
                <Td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpenClaim(openClaim === c.id ? null : c.id)}
                  >
                    {openClaim === c.id ? 'Close' : 'Open'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {openClaim && (
          <ClaimDetailPanel
            /* Keyed by the claim.

               Three forms live inside this panel and each holds its own state:
               the submission's acknowledgement, the sanction order number with
               a per-line map of reduced amounts, and the treasury receipt.
               Opening a second claim reused all of them, so a sanction could be
               recorded against claim B carrying A's order number and A's line
               ids — the arithmetic the school's status is derived from, on the
               wrong claim. */
            key={openClaim}
            claimId={openClaim}
            mayWrite={mayWrite}
            mayApprove={mayApprove}
            mayExport={mayExport}
          />
        )}

        {mayWrite && <NewClaim onCreated={setOpenClaim} />}
        {mayWrite && <RatesPanel />}
      </PageBody>
    </>
  )
}

// --- the ageing report -------------------------------------------------------

function AgeingPanel({
  ageing, onOpen,
}: { ageing: ClaimAgeing; onOpen: (id: string) => void }) {
  const anything = ageing.buckets.some((b) => b.claim_count > 0)
  return (
    <Card>
      <CardHeader
        title="How long the state has been sitting on it"
        description="Counted from the day each claim was submitted, because that is the day the school stopped being able to do anything about it."
      />
      {!anything ? (
        <EmptyState
          title="Nothing outstanding"
          body="Every submitted claim has been received in full."
        />
      ) : (
        <>
          <Table
            head={[
              'Age', 'Claims', 'Children',
              { label: 'Claimed', align: 'right' },
              { label: 'Sanctioned', align: 'right' },
              { label: 'Received', align: 'right' },
              { label: 'Outstanding', align: 'right' },
            ]}
            empty={false}
          >
            {ageing.buckets.map((b) => (
              <tr key={b.bucket}>
                <Td className="font-medium">
                  {AGE_LABEL[b.bucket] ?? b.bucket}
                  {b.bucket === '365+' && b.outstanding_paise > 0 && (
                    <span className="ml-2">
                      <Badge tone="danger">go and ask</Badge>
                    </span>
                  )}
                </Td>
                <Td>{b.claim_count}</Td>
                <Td>{b.child_count}</Td>
                <Td className="text-right tabular-nums">{inr(b.claimed_paise)}</Td>
                <Td className="text-right tabular-nums">{inr(b.sanctioned_paise)}</Td>
                <Td className="text-right tabular-nums">{inr(b.received_paise)}</Td>
                <Td className="text-right font-medium tabular-nums">
                  {inr(b.outstanding_paise)}
                </Td>
              </tr>
            ))}
          </Table>
          {ageing.oldest.length > 0 && (
            <div className="border-t px-5 py-4">
              <p className="mb-2 text-[13px] text-muted-foreground">
                The oldest by name, because a total is a number and a claim is a job.
              </p>
              <ul className="space-y-1.5 text-[13px]">
                {ageing.oldest.slice(0, 6).map((c) => (
                  <li key={c.id} className="flex flex-wrap items-baseline gap-x-2">
                    <button
                      type="button"
                      className="font-medium underline-offset-2 hover:underline"
                      onClick={() => onOpen(c.id)}
                    >
                      {c.claim_no}
                    </button>
                    <span className="text-muted-foreground">
                      {c.child_count} children · submitted {c.submitted_on} ·{' '}
                      {c.age_days} days ago
                    </span>
                    <span className="font-medium tabular-nums text-warning">
                      {inr(c.outstanding_paise)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// --- one claim ---------------------------------------------------------------

function ClaimDetailPanel({
  claimId, mayWrite, mayApprove, mayExport,
}: { claimId: string; mayWrite: boolean; mayApprove: boolean; mayExport: boolean }) {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: [concessionsKey] })

  const q = useQuery({
    queryKey: [concessionsKey, 'claim', claimId],
    queryFn: () => api.get<ClaimDetail>(`${concessionsBase}/claims/${claimId}`),
  })

  const build = useMutation({
    mutationFn: () =>
      api.post<{
        added: number
        already_on_claim: number
        skipped: { student_name: string; admission_no: string; class_name: string; why: string }[]
      }>(`${concessionsBase}/claims/${claimId}/build`, {}),
    onSuccess: invalidate,
  })

  if (q.isLoading) return <Loading label="Opening the claim…" />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data
  if (!d) return null

  const draft = d.claim.status === 'draft'
  const shortfall = d.claim.claimed_paise - d.claim.sanctioned_paise

  return (
    <Card>
      <CardHeader
        title={`${d.claim.claim_no} — ${d.claim.scheme_name}`}
        description={`${d.claim.period_start} to ${d.claim.period_end} · ${d.claim.child_count} children · ${CLAIM_LABEL[d.claim.status]}`}
        action={
          <span className="flex flex-wrap gap-2">
            {mayWrite && draft && (
              <Button size="sm" variant="secondary" disabled={build.isPending}
                onClick={() => build.mutate()}>
                <ListPlus className="h-3.5 w-3.5" />
                {build.isPending ? 'Assembling…' : 'Assemble from the roll'}
              </Button>
            )}
            {mayExport && d.claim.child_count > 0 && (
              <a href={`${concessionsBase}/claims/${claimId}/file`} download>
                <Button size="sm" variant="outline">
                  <Download className="h-3.5 w-3.5" /> Claim file (CSV)
                </Button>
              </a>
            )}
          </span>
        }
      />

      <div className="space-y-4 px-5 py-4">
        {build.data && (
          <div className="rounded-md border px-4 py-3 text-[13px]">
            <p>
              <span className="font-medium text-success">{build.data.added}</span> child(ren)
              added
              {build.data.already_on_claim > 0 &&
                ` · ${build.data.already_on_claim} already on the claim`}
            </p>
            {build.data.skipped.length > 0 && (
              <div className="mt-2">
                <p className="font-medium text-warning">
                  {build.data.skipped.length} left off, and why:
                </p>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {build.data.skipped.slice(0, 12).map((s) => (
                    <li key={s.admission_no}>
                      {s.student_name} ({s.admission_no}
                      {s.class_name ? `, ${s.class_name}` : ''}) — {s.why}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-muted-foreground">
                  A class band with no notified rate drops those children out of the claim
                  silently. Add the rate below, then assemble again.
                </p>
              </div>
            )}
          </div>
        )}
        <FormNotice error={build.error} />

        {!draft && shortfall > 0 && (
          <div className="rounded-md border border-warning/25 bg-warning/5 px-4 py-3 text-[13px]">
            The order allowed{' '}
            <span className="font-medium tabular-nums">{inr(shortfall)}</span> less than was
            claimed. Each child struck off carries the reason the order gave, in the table
            below.
          </div>
        )}

        {d.claim.rejected_reason && (
          <div className="rounded-md border border-destructive/25 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
            {d.claim.rejected_reason}
          </div>
        )}
      </div>

      <Table
        head={[
          'Child', 'Class', 'Months',
          { label: 'Rate', align: 'right' },
          { label: 'Claimed', align: 'right' },
          { label: 'Sanctioned', align: 'right' },
          'Why less',
        ]}
        empty={d.lines.length === 0}
        emptyLabel={
          draft
            ? 'No children on this claim yet. Assemble it from the roll.'
            : 'This claim was submitted with no children on it.'
        }
      >
        {d.lines.map((l) => (
          <ClaimLineRow key={l.id} line={l} />
        ))}
      </Table>

      {d.receipts.length > 0 && (
        <>
          <CardHeader
            title="Released by the treasury"
            description="Typed, or read off a bank statement. There is no live treasury feed."
          />
          <Table
            head={['Received', { label: 'Amount', align: 'right' }, 'Mode', 'Reference', 'Into', 'By']}
            empty={false}
          >
            {d.receipts.map((rc) => (
              <tr key={rc.id}>
                <Td>{rc.received_on}</Td>
                <Td className="text-right tabular-nums">{inr(rc.amount_paise)}</Td>
                <Td className="uppercase text-muted-foreground">{rc.mode}</Td>
                <Td className="font-mono text-[12px] text-muted-foreground">
                  {rc.reference_no ?? '—'}
                  {rc.treasury_voucher && (
                    <span className="block">voucher {rc.treasury_voucher}</span>
                  )}
                </Td>
                <Td className="text-muted-foreground">{rc.bank_account ?? '—'}</Td>
                <Td className="text-muted-foreground">{rc.recorded_by ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      <div className="space-y-6 border-t px-5 py-5">
        {mayApprove && draft && <SubmitClaim claimId={claimId} onDone={invalidate} />}
        {mayApprove && !draft && d.claim.status !== 'closed' && (
          <RecordSanction claimId={claimId} lines={d.lines} onDone={invalidate} />
        )}
        {mayWrite && !draft && <RecordReceipt claimId={claimId} onDone={invalidate} />}
        {!mayApprove && draft && (
          <p className="text-[13px] text-muted-foreground">
            Submitting a claim to the department, and recording what it sanctioned, needs the
            refunds approval permission. Assembling it does not.
          </p>
        )}
      </div>
    </Card>
  )
}

function ClaimLineRow({ line }: { line: ClaimLine }) {
  const short = line.sanctioned_paise != null && line.shortfall_paise > 0
  return (
    <tr>
      <Td className="font-medium">
        {line.student_name}
        <span className="block text-[12px] font-normal text-muted-foreground">
          {line.admission_no}
          {!line.has_concession && ' · no RTE concession on the fee ledger'}
        </span>
      </Td>
      <Td className="text-muted-foreground">{line.class_name ?? '—'}</Td>
      <Td>{line.months}</Td>
      <Td className="text-right tabular-nums text-muted-foreground">{inr(line.rate_paise)}</Td>
      <Td className="text-right tabular-nums">{inr(line.claimed_paise)}</Td>
      <Td
        className={
          short ? 'text-right font-medium tabular-nums text-warning' : 'text-right tabular-nums'
        }
      >
        {line.sanctioned_paise == null ? '—' : inr(line.sanctioned_paise)}
      </Td>
      <Td className="text-[13px] text-muted-foreground">{line.disallowed_reason ?? '—'}</Td>
    </tr>
  )
}

// --- the three writes --------------------------------------------------------

function SubmitClaim({ claimId, onDone }: { claimId: string; onDone: () => void }) {
  const [on, setOn] = useState('')
  const [ref, setRef] = useState('')

  const run = useMutation({
    mutationFn: () =>
      api.post(`${concessionsBase}/claims/${claimId}/submit`, {
        submitted_on: on,
        submitted_ref: ref,
      }),
    onSuccess: onDone,
  })

  return (
    <div className="space-y-3">
      <h4 className="text-[14px] font-semibold">Send it to the department</h4>
      <p className="text-[13px] text-muted-foreground">
        The date recorded here is what the ageing counts from. Nothing is transmitted — download
        the claim file above and lodge it the way the department accepts.
      </p>
      <FormGrid>
        <Field label="Submitted on" hint="Leave blank for today.">
          <Input value={on} onChange={setOn} type="date" />
        </Field>
        <Field
          label="Acknowledgement reference"
          hint="Often the only thing a school can produce when the department says it never arrived."
        >
          <Input value={ref} onChange={setRef} placeholder="Dispatch or inward number" />
        </Field>
      </FormGrid>
      <ConfirmButton
        variant="primary"
        confirmLabel="Record it as sent"
        question="The claim becomes read-only and starts ageing from this date."
        onConfirm={() => run.mutate()}
        disabled={run.isPending}
      >
        <Send className="h-3.5 w-3.5" /> Mark submitted
      </ConfirmButton>
      <FormNotice error={run.error} />
    </div>
  )
}

function RecordSanction({
  claimId, lines, onDone,
}: { claimId: string; lines: ClaimLine[]; onDone: () => void }) {
  const [orderNo, setOrderNo] = useState('')
  const [on, setOn] = useState('')
  const [edits, setEdits] = useState<Record<string, { amount: string; reason: string }>>({})

  const run = useMutation({
    mutationFn: () =>
      api.post(`${concessionsBase}/claims/${claimId}/sanction`, {
        sanction_order_no: orderNo,
        sanction_on: on,
        lines: Object.entries(edits)
          .filter(([, v]) => v.amount !== '')
          .map(([id, v]) => ({
            line_id: id,
            sanctioned_paise: toPaise(v.amount),
            disallowed_reason: v.reason,
          })),
      }),
    onSuccess: onDone,
  })

  const set = (id: string, patch: Partial<{ amount: string; reason: string }>) =>
    setEdits((e) => {
      const current = e[id] ?? { amount: '', reason: '' }
      return { ...e, [id]: { ...current, ...patch } }
    })

  return (
    <div className="space-y-3">
      <h4 className="text-[14px] font-semibold">Record the sanction order</h4>
      <p className="text-[13px] text-muted-foreground">
        Children the order does not mention are sanctioned in full — that is what silence on an
        order means. Name only the ones it reduced or struck off. The status that results is
        worked out from the arithmetic, not chosen here.
      </p>
      <FormGrid>
        <Field label="Sanction order number" required>
          <Input value={orderNo} onChange={setOrderNo} placeholder="Rc. No. / G.O. Ms. No." />
        </Field>
        <Field label="Order dated" hint="Leave blank for today.">
          <Input value={on} onChange={setOn} type="date" />
        </Field>
      </FormGrid>

      <Table
        head={['Child', { label: 'Claimed', align: 'right' }, 'Allowed (₹)', 'Reason the order gave']}
        empty={lines.length === 0}
        emptyLabel="No children on this claim."
      >
        {lines.map((l) => (
          <tr key={l.id}>
            <Td className="font-medium">
              {l.student_name}
              <span className="block text-[12px] font-normal text-muted-foreground">
                {l.admission_no}
              </span>
            </Td>
            <Td className="text-right tabular-nums">{inr(l.claimed_paise)}</Td>
            <Td>
              <Input
                value={edits[l.id]?.amount ?? ''}
                onChange={(v) => set(l.id, { amount: v })}
                placeholder="in full"
                className="w-28"
              />
            </Td>
            <Td>
              <Input
                value={edits[l.id]?.reason ?? ''}
                onChange={(v) => set(l.id, { reason: v })}
                placeholder="Required if less than claimed"
              />
            </Td>
          </tr>
        ))}
      </Table>

      <ConfirmButton
        variant="primary"
        confirmLabel="Record the order"
        question="This replaces any sanction previously recorded for this claim."
        onConfirm={() => run.mutate()}
        disabled={run.isPending || !orderNo}
      >
        <Stamp className="h-3.5 w-3.5" /> Record sanction
      </ConfirmButton>
      <FormNotice error={run.error} />
    </div>
  )
}

function RecordReceipt({ claimId, onDone }: { claimId: string; onDone: () => void }) {
  const [on, setOn] = useState('')
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('neft')
  const [ref, setRef] = useState('')
  const [voucher, setVoucher] = useState('')

  const run = useMutation({
    mutationFn: () =>
      api.post(`${concessionsBase}/claims/${claimId}/receipts`, {
        received_on: on,
        amount_paise: toPaise(amount),
        mode,
        reference_no: ref,
        treasury_voucher: voucher,
      }),
    onSuccess: () => {
      setAmount('')
      setRef('')
      setVoucher('')
      onDone()
    },
  })

  return (
    <div className="space-y-3">
      <h4 className="text-[14px] font-semibold">Record what the treasury released</h4>
      <p className="text-[13px] text-muted-foreground">
        A claim usually draws several releases months apart. The claim total updates itself.
      </p>
      <FormGrid>
        <Field label="Received on" required>
          <Input value={on} onChange={setOn} type="date" />
        </Field>
        <Field label="Amount (₹)" required>
          <Input value={amount} onChange={setAmount} placeholder="e.g. 128400" />
        </Field>
        <Field label="Mode">
          <Select
            value={mode}
            onChange={setMode}
            options={[
              { value: 'neft', label: 'NEFT' },
              { value: 'rtgs', label: 'RTGS' },
              { value: 'cheque', label: 'Cheque' },
              { value: 'dd', label: 'Demand draft' },
              { value: 'adjustment', label: 'Adjustment' },
            ]}
          />
        </Field>
        <Field label="Bank reference">
          <Input value={ref} onChange={setRef} placeholder="UTR or instrument number" />
        </Field>
        <Field label="Treasury voucher">
          <Input value={voucher} onChange={setVoucher} />
        </Field>
      </FormGrid>
      <Button disabled={run.isPending || !on || !amount} onClick={() => run.mutate()}>
        {run.isPending ? 'Recording…' : 'Record the release'}
      </Button>
      <FormNotice error={run.error} ok={run.isSuccess ? 'Recorded.' : undefined} />
    </div>
  )
}

// --- opening a claim ---------------------------------------------------------

function NewClaim({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient()
  const schemes = useSchemes('school')
  const years = useAcademicYears()

  const [schemeId, setSchemeId] = useState('')
  const [yearId, setYearId] = useState('')
  const [claimNo, setClaimNo] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [notes, setNotes] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`${concessionsBase}/claims`, {
        scheme_id: schemeId,
        academic_year_id: yearId,
        claim_no: claimNo,
        period_start: start,
        period_end: end,
        notes,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: [concessionsKey] })
      setClaimNo('')
      setNotes('')
      onCreated(r.id)
    },
  })

  const schemeOptions = (schemes.data?.items ?? []).map((s) => ({
    value: s.id,
    label: `${s.name} (${s.code})`,
  }))

  return (
    <Card>
      <CardHeader
        title="Open a claim"
        description="One per scheme per period. The period is what the department reimburses against — usually a quarter."
      />
      <div className="space-y-5 px-5 py-5">
        {schemeOptions.length === 0 && (
          <p className="text-[13px] text-warning">
            No school-reimbursed scheme is set up yet. Add one below before raising a claim.
          </p>
        )}
        <FormGrid>
          <Field label="Scheme" required>
            <Select
              value={schemeId}
              onChange={setSchemeId}
              options={schemeOptions}
              placeholder="Choose the scheme"
            />
          </Field>
          <Field label="Academic year" required>
            <Select
              value={yearId}
              onChange={setYearId}
              options={(years.data?.items ?? []).map((y) => ({ value: y.id, label: y.name }))}
              placeholder="Choose the year"
            />
          </Field>
          <Field label="Period from" required>
            <Input value={start} onChange={setStart} type="date" />
          </Field>
          <Field label="Period to" required>
            <Input value={end} onChange={setEnd} type="date" />
          </Field>
          <Field
            label="Claim number"
            hint="Leave blank and one is made from the scheme code and the period."
          >
            <Input value={claimNo} onChange={setClaimNo} />
          </Field>
          <Field label="Notes" wide>
            <Textarea value={notes} onChange={setNotes} />
          </Field>
        </FormGrid>
        <Button
          disabled={save.isPending || !schemeId || !yearId || !start || !end}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Opening…' : 'Open the claim'}
        </Button>
        <FormNotice error={save.error} />
      </div>
      <SchemeEditor paidTo="school" />
    </Card>
  )
}

// --- the notified rates ------------------------------------------------------

function RatesPanel() {
  const qc = useQueryClient()
  const schemes = useSchemes('school')
  const years = useAcademicYears()

  const [schemeId, setSchemeId] = useState('')
  const [yearId, setYearId] = useState('')
  const [from, setFrom] = useState('1')
  const [to, setTo] = useState('5')
  const [rate, setRate] = useState('')
  const [ref, setRef] = useState('')
  const [on, setOn] = useState('')

  const rates = useQuery({
    queryKey: [concessionsKey, 'rates'],
    queryFn: () => api.get<List<ReimbursementRate>>(`${concessionsBase}/rates`),
  })

  const save = useMutation({
    mutationFn: () =>
      api.post(`${concessionsBase}/rates`, {
        scheme_id: schemeId,
        academic_year_id: yearId,
        from_level: Number(from),
        to_level: Number(to),
        annual_rate_paise: toPaise(rate),
        notification_ref: ref,
        notified_on: on,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [concessionsKey] })
      setRate('')
      setRef('')
    },
  })

  return (
    <Card>
      <CardHeader
        title="Notified rates"
        description="The per-child annual rate a government order sets, by class band and year. Kept so a claim raised two years ago can still be explained against the order that set it."
      />
      <Table
        head={['Scheme', 'Year', 'Classes', { label: 'Annual rate', align: 'right' }, 'Order']}
        empty={(rates.data?.items ?? []).length === 0}
        emptyLabel="No rate notified yet. Children in an un-rated class band drop out of every claim."
      >
        {(rates.data?.items ?? []).map((rt) => (
          <tr key={rt.id}>
            <Td className="font-medium">{rt.scheme_name}</Td>
            <Td className="text-muted-foreground">{rt.academic_year}</Td>
            <Td>
              {rt.from_level === rt.to_level
                ? `Class ${rt.from_level}`
                : `Classes ${rt.from_level}–${rt.to_level}`}
            </Td>
            <Td className="text-right tabular-nums">{inr(rt.annual_rate_paise)}</Td>
            <Td className="text-[13px] text-muted-foreground">
              {rt.notification_ref ?? '—'}
              {rt.notified_on && <span className="block text-[12px]">{rt.notified_on}</span>}
            </Td>
          </tr>
        ))}
      </Table>
      <div className="space-y-5 border-t px-5 py-5">
        <FormGrid>
          <Field label="Scheme" required>
            <Select
              value={schemeId}
              onChange={setSchemeId}
              options={(schemes.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
              placeholder="Choose the scheme"
            />
          </Field>
          <Field label="Academic year" required>
            <Select
              value={yearId}
              onChange={setYearId}
              options={(years.data?.items ?? []).map((y) => ({ value: y.id, label: y.name }))}
              placeholder="Choose the year"
            />
          </Field>
          <Field label="From class" hint="Matches the class level, so 1 is Class I.">
            <Input value={from} onChange={setFrom} type="number" />
          </Field>
          <Field label="To class">
            <Input value={to} onChange={setTo} type="number" />
          </Field>
          <Field label="Annual rate per child (₹)" required>
            <Input value={rate} onChange={setRate} placeholder="e.g. 6000" />
          </Field>
          <Field label="Government order reference">
            <Input value={ref} onChange={setRef} placeholder="G.O. Ms. No. …" />
          </Field>
          <Field label="Notified on">
            <Input value={on} onChange={setOn} type="date" />
          </Field>
        </FormGrid>
        <Button
          disabled={save.isPending || !schemeId || !yearId || !rate}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Notify the rate'}
        </Button>
        <FormNotice error={save.error} />
      </div>
    </Card>
  )
}

// --- the scheme registry, shared with the scholarship screen -----------------

export function SchemeEditor({ paidTo }: { paidTo: 'school' | 'student' }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState(
    paidTo === 'school' ? 'rte_reimbursement' : 'nsp_scholarship',
  )
  const [authority, setAuthority] = useState('')
  const [portal, setPortal] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post(`${concessionsBase}/schemes`, {
        code, name, kind, authority, portal_url: portal,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [concessionsKey] })
      setCode('')
      setName('')
      setOpen(false)
    },
  })

  const kinds =
    paidTo === 'school'
      ? [
          { value: 'rte_reimbursement', label: 'RTE 25% quota reimbursement' },
          { value: 'fee_reimbursement', label: 'State fee reimbursement' },
        ]
      : [
          { value: 'nsp_scholarship', label: 'National Scholarship Portal' },
          { value: 'state_scholarship', label: 'State scholarship portal' },
        ]

  if (!open) {
    return (
      <div className="border-t px-5 py-4">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Add a scheme
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-5 border-t px-5 py-5">
      <p className="text-[13px] text-muted-foreground">
        Whether the money reaches the school or the child is worked out from the kind, not
        chosen here — a mis-ticked box would put a portal scholarship on the claims screen.
      </p>
      <FormGrid>
        <Field label="Short code" required hint="Used to build claim numbers.">
          <Input value={code} onChange={setCode} placeholder="RTE25" />
        </Field>
        <Field label="Name" required>
          <Input value={name} onChange={setName} placeholder="RTE 25% quota reimbursement" />
        </Field>
        <Field label="Kind" required>
          <Select value={kind} onChange={setKind} options={kinds} />
        </Field>
        <Field label="Authority">
          <Input
            value={authority}
            onChange={setAuthority}
            placeholder="Directorate of School Education"
          />
        </Field>
        <Field label="Portal address" wide>
          <Input value={portal} onChange={setPortal} placeholder="https://…" />
        </Field>
      </FormGrid>
      <span className="flex gap-2">
        <Button disabled={save.isPending || !code || !name} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Add the scheme'}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </span>
      <FormNotice error={save.error} />
    </div>
  )
}
