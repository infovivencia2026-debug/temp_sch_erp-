import { useMemo, useState } from 'react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, ConfirmButton, Badge, Input, Select, Checkbox, Field, FormGrid,
  FormNotice, Skeleton, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'
import { inr, toPaise } from './ledger-lib'
import {
  describeRule, feeEngineBase, useFeeEngineMutation, useFineCharges,
  useFinePreview, useFineRules,
  type FineAssessment, type FineRule,
} from './fee-engine-lib'

/* The late fine rules engine.

   Two halves that must stay separate. Configuring a rule is a policy decision
   somebody signs off; running it is a clerk's monthly job. The screen keeps
   them apart, and keeps a hard line between preview and apply: nothing here
   charges anybody on a timer.

   That is deliberate rather than unfinished. A parent who finds an extra ₹1,750
   on their account overnight will ask who decided it, and "the system did"
   is not an answer a school can give. Somebody previews, reads the working,
   picks the invoices and applies. */

const today = () => new Date().toISOString().slice(0, 10)

export default function LateFineRules() {
  const toast = useToast()
  const can = useCan()
  const mayConfigure = can('finance.fees.write')
  const mayLevy = can('finance.invoices.write')

  const rules = useFineRules()
  const charges = useFineCharges()

  const [editing, setEditing] = useState<FineRule | null>(null)
  const [showForm, setShowForm] = useState(false)

  const items = rules.data?.items ?? []
  const active = items.filter((r) => r.is_active)
  const chargeRows = charges.data?.items ?? []
  const raised = chargeRows
    .filter((c) => c.status === 'applied')
    .reduce((n, c) => n + c.amount_paise, 0)
  const waived = chargeRows.filter((c) => c.status === 'waived').length

  return (
    <>
      <PageHead
        eyebrow="Student dues"
        title="Late fine rules"
        description="Configure the policy, preview what it would charge, then apply it deliberately."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Active rules" value={active.length} hint={active.length ? undefined : 'Nothing is being charged'} />
          <Stat label="Retired rules" value={items.length - active.length} hint="Kept for the audit trail" />
          <Stat label="Fines raised" value={raised ? inr(raised) : '—'} />
          <Stat label="Waived" value={waived} hint={waived ? 'Each with a reason on file' : undefined} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Rules"
            description="The most specific rule wins — a head beats a structure, which beats a campus"
            action={
              mayConfigure && (
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(null)
                    setShowForm(!showForm)
                  }}
                >
                  {showForm ? 'Close' : 'Add a rule'}
                </Button>
              )
            }
          />
          {rules.isLoading ? (
            <Skeleton />
          ) : rules.error ? (
            <ErrorState error={rules.error} />
          ) : (
            <Table
              head={['Rule', 'Applies to', 'Charge', 'Exempt', 'Priority', 'State', '']}
              empty={!items.length}
              emptyLabel="No fine rules configured. Nothing is being charged."
            >
              {items.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="text-muted-foreground">
                    {r.fee_head ?? 'All heads'}
                    <span className="block text-[11.5px]">
                      {r.fee_structure ?? 'All structures'} · {r.campus ?? 'All campuses'}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{describeRule(r, inr)}</Td>
                  <Td className="text-muted-foreground">
                    {r.exempt_concession_kinds.length
                      ? r.exempt_concession_kinds.map((k) => k.replace('_', ' ')).join(', ')
                      : '—'}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{r.priority}</Td>
                  <Td>
                    <Badge tone={r.is_active ? 'success' : 'neutral'}>
                      {r.is_active ? 'active' : 'retired'}
                    </Badge>
                  </Td>
                  <Td>
                    {mayConfigure && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setEditing(r)
                          setShowForm(true)
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {showForm && mayConfigure && (
          <RuleForm
            /* Keyed by the rule being edited.

               Without this, clicking Edit on a second rule while the form was
               open reused the mounted instance: its state was initialised from
               the first rule and useState does not run a second time, so the
               header read "Edit B" over A's amounts and Save posted B's id
               carrying A's policy. One rule's fine was written onto another. */
            key={editing?.id ?? 'new'}
            rule={editing}
            heads={rules.data?.heads ?? []}
            concessionKinds={rules.data?.concession_kinds ?? []}
            onDone={(m) => {
              toast.ok(m)
              setShowForm(false)
              setEditing(null)
            }}
          />
        )}

        <PreviewPanel mayLevy={mayLevy} onNotify={toast.ok} />

        <Card>
          <CardHeader
            title="Fines raised"
            description="Every charge with the rule and the basis behind it"
          />
          {charges.isLoading ? (
            <Skeleton />
          ) : charges.error ? (
            <ErrorState error={charges.error} />
          ) : (
            <Table
              head={['Student', 'Invoice', 'Rule', 'Overdue', 'Basis', { label: 'Charged', align: 'right' }, 'State', '']}
              empty={!chargeRows.length}
              emptyLabel="No fines have been raised."
            >
              {chargeRows.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">
                    {c.student_name}
                    <span className="block font-mono text-[11.5px] font-normal text-muted-foreground">
                      {c.admission_no}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">
                    {c.invoice_no}
                    {c.version && <span className="block text-[11.5px]">{c.version}</span>}
                  </Td>
                  <Td className="text-muted-foreground">
                    {c.rule_name}
                    {c.fee_head && <span className="block text-[11.5px]">{c.fee_head}</span>}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{c.days_overdue} d</Td>
                  <Td className="tabular-nums text-muted-foreground">{inr(c.basis_paise)}</Td>
                  <Td className="text-right tabular-nums font-medium">
                    {inr(c.amount_paise)}
                    {c.was_capped && (
                      <span className="block text-[11.5px] font-normal text-muted-foreground">capped</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={c.status === 'applied' ? 'warning' : 'neutral'}>{c.status}</Badge>
                    {c.waived_reason && (
                      <span className="block max-w-[22ch] truncate text-[11.5px] text-muted-foreground" title={c.waived_reason}>
                        {c.waived_reason}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {c.status === 'applied' && mayLevy && <WaiveButton chargeId={c.id} onNotify={toast.ok} />}
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

function WaiveButton({ chargeId, onNotify }: { chargeId: string; onNotify: (m: string) => void }) {
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState(false)

  const waive = useFeeEngineMutation(
    () => api.post(`${feeEngineBase}/fines/charges/${chargeId}/waive`, { reason }),
    () => {
      setAsking(false)
      setReason('')
      onNotify('Fine waived and taken back off the invoice.')
    },
  )

  if (!asking) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>
        Waive
      </Button>
    )
  }
  return (
    <span className="flex items-center gap-2">
      <Input value={reason} onChange={setReason} placeholder="Why?" />
      <Button size="sm" disabled={!reason.trim() || waive.isPending} onClick={() => waive.mutate(undefined as never)}>
        Waive
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  )
}

function RuleForm({
  rule, heads, concessionKinds, onDone,
}: {
  rule: FineRule | null
  heads: { id: string; name: string }[]
  concessionKinds: string[]
  onDone: (message: string) => void
}) {
  const [name, setName] = useState(rule?.name ?? '')
  const [kind, setKind] = useState(rule?.kind ?? 'per_day')
  const [headId, setHeadId] = useState(rule?.fee_head_id ?? '')
  const [graceDays, setGraceDays] = useState(String(rule?.grace_days ?? 0))
  const [amount, setAmount] = useState(String((rule?.amount_paise ?? 0) / 100))
  const [percent, setPercent] = useState(String(rule?.percent ?? ''))
  const [cap, setCap] = useState(rule?.cap_paise ? String(rule.cap_paise / 100) : '')
  const [compound, setCompound] = useState(rule?.compound_period ?? 'none')
  const [exempt, setExempt] = useState<string[]>(rule?.exempt_concession_kinds ?? [])
  const [priority, setPriority] = useState(String(rule?.priority ?? 100))
  /* WHEN the charge is raised, not how much.

     Both are real practice: a school that wants the pressure now charges each
     term as it falls due; a school that would rather not have the conversation
     three times lets them accrue and puts them all on the final instalment.
     The arithmetic is identical, so this decides only which invoice carries
     the money. */
  const [applyMode, setApplyMode] = useState(rule?.apply_mode ?? 'per_invoice')
  const [isActive, setIsActive] = useState(rule?.is_active ?? true)

  const save = useFeeEngineMutation(
    () =>
      api.post(`${feeEngineBase}/fine-rules`, {
        id: rule?.id || undefined,
        name,
        fee_head_id: headId || undefined,
        kind,
        grace_days: Number(graceDays || 0),
        amount_paise: kind === 'percent' ? 0 : toPaise(amount),
        percent: kind === 'percent' ? Number(percent || 0) : undefined,
        cap_paise: cap ? toPaise(cap) : undefined,
        compound_period: compound,
        apply_mode: applyMode,
        exempt_concession_kinds: exempt,
        priority: Number(priority || 100),
        is_active: isActive,
      }),
    () => onDone(rule ? 'Rule updated.' : 'Rule added.'),
  )

  const remove = useFeeEngineMutation(
    () => api.del(`${feeEngineBase}/fine-rules/${rule?.id}`),
    () => onDone('Rule removed.'),
  )

  // A per-day charge already grows with time; compounding it as well would
  // count the same days twice. The server refuses it, so the form does not
  // offer it.
  const compoundable = kind !== 'per_day'

  /* The charge has to be a number somebody typed.

     toPaise('') is 0, because Number('' || 0) is 0 — so clearing the amount
     box saved a rule that charges nothing and looked configured, and the same
     went for an emptied percentage. A rule that charges nothing is not a
     policy; retiring it is how a school turns a fine off. Gated the way the
     name already is: the button stays down until the field is real. */
  const charge = kind === 'percent' ? percent : amount
  const chargeMissing =
    charge.trim() === '' || !Number.isFinite(Number(charge)) || Number(charge) <= 0

  return (
    <Card>
      <CardHeader
        title={rule ? `Edit "${rule.name}"` : 'New fine rule'}
        description="Leave a target blank to mean 'any' — a blank head applies to the whole invoice balance"
      />
      <div className="space-y-4 p-5">
        <FormGrid>
          <Field label="Name" required hint="How the school finds this rule again">
            <Input value={name} onChange={setName} placeholder="Standard late fee" />
          </Field>
          <Field label="Fee head" hint="Blank means every head, charged on the invoice balance">
            <Select
              value={headId}
              onChange={setHeadId}
              options={[
                { value: '', label: 'All heads' },
                ...heads.map((h) => ({ value: h.id, label: h.name })),
              ]}
            />
          </Field>
          <Field label="Charge as" required>
            <Select
              value={kind}
              onChange={(v) => {
                setKind(v as FineRule['kind'])
                if (v === 'per_day') setCompound('none')
              }}
              options={[
                { value: 'per_day', label: 'A daily amount' },
                { value: 'fixed', label: 'A flat amount' },
                { value: 'percent', label: 'A percentage' },
              ]}
            />
          </Field>
          <Field label="Apply the fine to" wide>
            <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
              {([
                ['per_invoice', 'Each term separately',
                 'Term 1, Term 2 and Term 3 each carry their own fine as they fall due.'],
                ['final_term', 'Accumulate to the final term',
                 'The same amounts accrue, and all of them are charged on the last instalment of the year.'],
              ] as const).map(([value, label, note]) => (
                <label key={value} className="flex items-start gap-3 text-[13px]">
                  <input
                    type="radio"
                    name="apply-mode"
                    className="mt-0.5"
                    checked={applyMode === value}
                    onChange={() => setApplyMode(value)}
                  />
                  <span>
                    <strong className="font-medium">{label}</strong>
                    <span className="block text-[12.5px] text-muted-foreground">{note}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>

          <Field
            label="Grace period (days)"
            required
            hint="Nothing is charged while this many days have merely elapsed. At exactly this many days there is still nothing to pay."
          >
            <Input type="number" value={graceDays} onChange={setGraceDays} />
          </Field>

          {kind === 'percent' ? (
            <Field label="Percent" required hint="Of the head's amount under the invoice's fee version, or of the balance">
              <Input type="number" value={percent} onChange={setPercent} placeholder="2" />
            </Field>
          ) : (
            <Field label="Amount (₹)" required hint={kind === 'per_day' ? 'Per day past the grace period' : 'Charged once'}>
              <Input type="number" value={amount} onChange={setAmount} placeholder="50" />
            </Field>
          )}

          <Field label="Cap (₹)" hint="Stops a fine on an invoice nobody chases growing without bound">
            <Input type="number" value={cap} onChange={setCap} placeholder="No cap" />
          </Field>

          <Field
            label="Compounding"
            hint={compoundable ? 'Levies the charge once per elapsed period' : 'A daily charge already grows with time'}
          >
            <Select
              value={compound}
              onChange={(v) => setCompound(v as FineRule['compound_period'])}
              options={
                compoundable
                  ? [
                      { value: 'none', label: 'Charge once' },
                      { value: 'weekly', label: 'Every week' },
                      { value: 'monthly', label: 'Every month' },
                    ]
                  : [{ value: 'none', label: 'Not available for a daily charge' }]
              }
            />
          </Field>

          <Field label="Priority" hint="Lower wins when two rules are equally specific">
            <Input type="number" value={priority} onChange={setPriority} />
          </Field>
        </FormGrid>

        <Field label="Exempt these concession holders" hint="A staff ward on a full concession should not be chased for a late fine">
          <div className="flex flex-wrap gap-4">
            {concessionKinds.map((k) => (
              <Checkbox
                key={k}
                checked={exempt.includes(k)}
                onChange={(on) => setExempt(on ? [...exempt, k] : exempt.filter((x) => x !== k))}
                label={k.replace('_', ' ')}
              />
            ))}
          </div>
        </Field>

        <Checkbox
          checked={isActive}
          onChange={setIsActive}
          label="Active"
          hint="Retiring a rule keeps it on file. Only one active rule may cover a given campus, structure and head."
        />

        <FormNotice error={save.error ?? remove.error} />
        <div className="flex gap-2">
          <Button
            onClick={() => save.mutate(undefined as never)}
            disabled={!name.trim() || chargeMissing || save.isPending}
          >
            {rule ? 'Save the rule' : 'Add the rule'}
          </Button>
          {rule && (
            <ConfirmButton
              confirmLabel="Remove"
              question="Fines already raised under it are kept, but the rule is gone."
              onConfirm={() => remove.mutate(undefined as never)}
              tone="danger"
            >
              Remove
            </ConfirmButton>
          )}
        </div>
      </div>
    </Card>
  )
}

/* Preview, then apply. The two are never one button.

   The preview names every due it looked at, including the ones it decided not
   to charge, because "why was this student not fined" is asked at least as
   often as the opposite. */
function PreviewPanel({ mayLevy, onNotify }: { mayLevy: boolean; onNotify: (m: string) => void }) {
  const [asOf, setAsOf] = useState(today())
  const [ruleId, setRuleId] = useState('')
  const [run, setRun] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  /* Either input changes the question, so the answer to the old one is void.

     The preview refetched on a new date but the ticked invoice ids stayed, and
     apply posted the raw set — so a clerk who selected twelve invoices, changed
     the date and applied charged parents from a list this screen had never
     shown. The count said twelve and the confirmation quoted the total of the
     three that happened to survive, because one read the set and the other read
     the list. Cleared here, and below there is only one source left to read. */
  const changeAsOf = (v: string) => {
    setAsOf(v)
    setPicked(new Set())
  }
  const changeRule = (v: string) => {
    setRuleId(v)
    setPicked(new Set())
  }

  const rules = useFineRules()
  const preview = useFinePreview(asOf, ruleId, run)

  const items = useMemo(() => preview.data?.items ?? [], [preview.data])
  const chargeable = useMemo(() => items.filter((a) => a.delta_paise > 0), [items])
  /* One list, read by the count, the total and the request alike. A tick that
     is no longer on screen is not in it, so it cannot be charged. */
  const selected = useMemo(
    () => chargeable.filter((a) => picked.has(a.invoice_id)),
    [chargeable, picked],
  )
  const selectedTotal = selected.reduce((n, a) => n + a.delta_paise, 0)

  const apply = useFeeEngineMutation(
    () =>
      api.post<{ applied: number; skipped: number; total_paise: number }>(
        `${feeEngineBase}/fines/apply`,
        {
          as_of: asOf,
          invoice_ids: selected.map((a) => a.invoice_id),
          rule_id: ruleId || undefined,
        },
      ),
    (res) => {
      setPicked(new Set())
      onNotify(
        res.applied
          ? `${res.applied} fine${res.applied === 1 ? '' : 's'} raised, ${inr(res.total_paise)} in total.`
          : 'Nothing to raise — those fines were already charged.',
      )
    },
  )

  return (
    <Card>
      <CardHeader
        title="Preview a fine run"
        description="Computes and shows the working. Nothing is charged until you apply it."
        action={
          <span className="flex items-center gap-2">
            <Input type="date" value={asOf} onChange={changeAsOf} />
            <Select
              value={ruleId}
              onChange={changeRule}
              options={[
                { value: '', label: 'All rules' },
                ...(rules.data?.items ?? [])
                  .filter((r) => r.is_active)
                  .map((r) => ({ value: r.id, label: r.name })),
              ]}
            />
            <Button
              size="sm"
              onClick={() => {
                setRun(true)
                setPicked(new Set())
                preview.refetch()
              }}
            >
              Preview
            </Button>
          </span>
        }
      />

      {!run ? (
        <EmptyState
          title="Nothing previewed yet"
          body="Pick a date and a rule, then preview. Fines are never charged on a timer — somebody has to look at this first."
        />
      ) : preview.isLoading ? (
        <Skeleton />
      ) : preview.error ? (
        <ErrorState error={preview.error} />
      ) : (
        <>
          <div className="space-y-4 p-5 pb-4">
          <CellGrid cols={4}>
            <Stat label="Dues assessed" value={preview.data?.assessed ?? 0} period={`as at ${formatDate(asOf)}`} />
            <Stat label="Would be charged" value={preview.data?.chargeable ?? 0} />
            <Stat label="Exempt" value={preview.data?.exempt ?? 0} hint="Concession holders" />
            <Stat label="Total if applied" value={inr(preview.data?.total_paise ?? 0)} />
          </CellGrid>

          <FormNotice error={apply.error} />
          </div>

          <Table
            head={[
              mayLevy ? 'Charge' : '',
              'Student', 'Invoice', 'Rule', 'Overdue', 'Basis',
              { label: 'Fine', align: 'right' }, 'Working',
            ]}
            empty={!items.length}
            emptyLabel="No open dues matched. Nothing would be charged."
          >
            {items.map((a) =>
              previewRows({
                a,
                mayLevy,
                checked: picked.has(a.invoice_id),
                onToggle: (on) => {
                  const next = new Set(picked)
                  if (on) next.add(a.invoice_id)
                  else next.delete(a.invoice_id)
                  setPicked(next)
                },
                open: expanded.has(a.invoice_id),
                onOpen: () => {
                  const next = new Set(expanded)
                  if (next.has(a.invoice_id)) next.delete(a.invoice_id)
                  else next.add(a.invoice_id)
                  setExpanded(next)
                },
              }),
            )}
          </Table>

          {mayLevy && (
            <div className="flex flex-wrap items-center gap-3 p-5 pt-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setPicked(
                    selected.length === chargeable.length
                      ? new Set()
                      : new Set(chargeable.map((a) => a.invoice_id)),
                  )
                }
                disabled={!chargeable.length}
              >
                {selected.length === chargeable.length && chargeable.length
                  ? 'Clear selection'
                  : `Select all ${chargeable.length} chargeable`}
              </Button>
              <ConfirmButton
                confirmLabel={`Raise ${selected.length} fine${selected.length === 1 ? '' : 's'}`}
                question={`${inr(selectedTotal)} will be added to those invoices. Parents can be told the reason from the working shown here.`}
                onConfirm={() => apply.mutate(undefined as never)}
                disabled={!selected.length || apply.isPending}
                variant="primary"
              >
                Apply to {selected.length} selected
              </ConfirmButton>
              {selected.length > 0 && (
                <span className="text-[12.5px] text-muted-foreground">{inr(selectedTotal)} in total</span>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  )
}

/* The two rows a preview line can occupy, as an array rather than a component.

   <Table> gives every cell the name of its column so the row can stack into a
   labelled card on a phone, and it does that by walking the elements handed to
   it. A component element carries its rows behind a render that has not
   happened yet, so the walk finds nothing to label and this table — eight
   columns of money — collapsed into bare unlabelled values under 640px. An
   array is flattened by Children.map and each <tr> is walked normally. The
   contract is written up on labelCells in components/ui.tsx.

   The disclosure state moved up to the panel for the same reason: a plain
   function cannot hold it, and the panel is where "which rows are open" belongs
   anyway — it survives a refetch there. */
function previewRows({
  a, mayLevy, checked, onToggle, open, onOpen,
}: {
  a: FineAssessment
  mayLevy: boolean
  checked: boolean
  onToggle: (on: boolean) => void
  open: boolean
  onOpen: () => void
}) {
  const chargeable = a.delta_paise > 0

  return [
    <tr key={a.invoice_id}>
      <Td>
        {mayLevy && chargeable && (
          <Checkbox
            checked={checked}
            onChange={onToggle}
            label=""
            /* The column says what ticking does and the row says who it is
               done to; without this the box is announced as "checkbox" and
               nothing else, once per student, on the control that decides
               who is charged. */
            srLabel={`Charge ${a.student_name} ${inr(a.delta_paise)} on invoice ${a.invoice_no}`}
          />
        )}
      </Td>
      <Td className="font-medium">{a.student_name}</Td>
      <Td className="text-muted-foreground">
        {a.invoice_no}
        {a.version_label && <span className="block text-[11.5px]">{a.version_label}</span>}
      </Td>
      <Td className="text-muted-foreground">
        {a.rule_name || <span className="italic">no rule</span>}
      </Td>
      <Td className="tabular-nums text-muted-foreground">
        {a.days_overdue > 0 ? `${a.days_overdue} d` : '—'}
      </Td>
      <Td className="tabular-nums text-muted-foreground">
        {a.basis_paise ? inr(a.basis_paise) : '—'}
      </Td>
      <Td className="text-right tabular-nums font-medium">
        {chargeable ? (
          <>
            {inr(a.delta_paise)}
            {a.amount_paise !== a.delta_paise && (
              <span className="block text-[11.5px] font-normal text-muted-foreground">
                {inr(a.amount_paise)} accrued, rest already charged
              </span>
            )}
          </>
        ) : a.exempt ? (
          <Badge tone="info">exempt</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Td>
      <Td>
        <button
          type="button"
          aria-expanded={open}
          className="text-left text-[11.5px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={onOpen}
        >
          {a.reason}
        </button>
      </Td>
    </tr>,
    open && a.steps && a.steps.length > 0 ? (
      <tr key={`${a.invoice_id}:working`}>
        <Td colSpan={8}>
          <div className="rounded-md bg-muted/40 px-3 py-2 text-[11.5px] text-muted-foreground">
            {a.was_capped && <p className="mb-1">The cap applied — the uncapped figure was higher.</p>}
            {a.steps.map((s) => (
              <p key={s.period} className="tabular-nums">
                Period {s.period}: {inr(s.amount_paise)} on {inr(s.basis_paise)} — {s.note}
              </p>
            ))}
          </div>
        </Td>
      </tr>
    ) : null,
  ]
}
