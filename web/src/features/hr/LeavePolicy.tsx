import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Clock, Scale } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Checkbox, Field, FormGrid, FormNotice,
  Input, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'

/* The rules a payslip already assumed.

   Payroll counted days marked absent and nothing else, so a school running a
   ten-minute grace period, a three-late-marks rule or unpaid leave was
   deducting for none of them — and the half-day mark, which the register has
   always been able to record, cost the employee nothing.

   Everything set here is read by one database function, and the register at
   the bottom of this screen is that same function. A configuration screen
   whose numbers a payslip recomputes for itself is a configuration screen that
   will one day disagree with the payslip. */

interface TypeRule {
  leave_type_id: string
  code: string
  name: string
  annual_quota?: number
  is_paid: boolean
  carry_forward: boolean
  accrual: string
  carry_forward_max?: number
  encashable: boolean
  allow_half_day: boolean
  max_consecutive_days?: number
  notice_days: number
  document_required_after_days?: number
  available_during_probation: boolean
  applies_to_gender?: string
}

interface Policy {
  half_day_fraction: number
  shift_starts_at: string
  grace_minutes: number
  late_marks_per_lop_day: number
  late_half_day_after_minutes?: number
  lop_on_absent: boolean
  lop_on_unpaid_leave: boolean
  lop_rounding: string
  max_lop_days_per_month?: number
  types: TypeRule[]
}

interface LOPRow {
  employee_id: string
  employee_code: string
  full_name: string
  absent_days: number
  half_days: number
  unpaid_leave_days: number
  late_marks: number
  lop_days: number
}

interface LOPRegister {
  items: LOPRow[]
  year: number
  month: number
  total_lop_days: number
}

const TABS = [
  ['rules', 'Leave types', CalendarClock],
  ['lop', 'Lateness & loss of pay', Clock],
  ['register', 'This month', Scale],
] as const

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function lastMonth() {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}

export default function LeavePolicy() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('rules')
  const [draft, setDraft] = useState<Policy | null>(null)

  const policy = useQuery({
    queryKey: ['hr', 'leave-policy'],
    queryFn: () => api.get<Policy>('/api/v1/hr/leave-policy'),
  })
  const save = useMutation({
    mutationFn: (p: Policy) => api.post('/api/v1/hr/leave-policy', p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  })

  // The form edits a copy. Editing the query cache directly would make a
  // failed save look as though it had worked.
  useEffect(() => {
    if (policy.data) setDraft(policy.data)
  }, [policy.data])

  if (policy.isLoading || !draft) return <Loading label="Reading the leave policy…" />
  if (policy.error) return <ErrorState error={policy.error} />

  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setDraft({ ...draft, [k]: v })
  const setType = (id: string, patch: Partial<TypeRule>) =>
    setDraft({
      ...draft,
      types: draft.types.map((t) => (t.leave_type_id === id ? { ...t, ...patch } : t)),
    })

  const unpaid = draft.types.filter((t) => !t.is_paid).length

  return (
    <>
      <PageHead
        eyebrow="Attendance & Leave"
        title="Leave policy"
        description="What each kind of leave allows, what half a day costs, and how many late arrivals make one."
        actions={<Button onClick={() => save.mutate(draft)} disabled={save.isPending}>Save the policy</Button>}
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Leave types" value={draft.types.length} icon={CalendarClock} />
          <Stat label="Unpaid types" value={unpaid}
            hint="Days taken on these become loss of pay" />
          <Stat label="Grace period" value={`${draft.grace_minutes} min`} icon={Clock}
            hint={`After ${draft.shift_starts_at}`} />
          <Stat label="Late marks per day lost" value={draft.late_marks_per_lop_day} icon={Scale} />
        </CellGrid>

        <FormNotice error={save.error} ok={save.isSuccess ? 'Saved. Payroll reads this from the next run.' : undefined} />

        <div className="flex flex-wrap gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)} aria-current={tab === k}
              className={tab === k
                ? '-mb-px flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {tab === 'rules' && <RulesTab types={draft.types} onChange={setType} />}
        {tab === 'lop' && <LOPRulesTab policy={draft} onChange={set} />}
        {tab === 'register' && <RegisterTab />}
      </PageBody>
    </>
  )
}

function RulesTab({
  types,
  onChange,
}: {
  types: TypeRule[]
  onChange: (id: string, patch: Partial<TypeRule>) => void
}) {
  if (types.length === 0)
    return (
      <Card>
        <EmptyState title="No staff leave types yet"
          body="Casual, sick, earned and maternity leave are set up under Leave; their rules appear here once they exist." />
      </Card>
    )

  return (
    <Card>
      <CardHeader title="What each type allows"
        description="The quota, whether it is paid and whether it carries forward live on the leave type itself and are shown here for context. Everything editable below is the policy the database enforces when a request is made." />
      <Table head={['Type', 'Quota', 'Paid', 'Carry up to', 'Half days', 'Max spell', 'Notice', 'Proof after', 'Probation', 'Restricted to']}>
        {types.map((t) => (
          <tr key={t.leave_type_id}>
            <Td className="font-medium">{t.name}
              <div className="text-[12px] font-normal text-muted-foreground">{t.code}</div>
            </Td>
            <Td className="tabular-nums text-muted-foreground">{t.annual_quota ?? '—'}</Td>
            <Td>{t.is_paid ? <Badge tone="success">paid</Badge> : <Badge tone="warning">unpaid</Badge>}</Td>
            <Td className="w-24">
              {t.carry_forward ? (
                <Input type="number" value={t.carry_forward_max?.toString() ?? ''}
                  onChange={(v) => onChange(t.leave_type_id, { carry_forward_max: v ? Number(v) : undefined })} />
              ) : <span className="text-muted-foreground">no</span>}
            </Td>
            <Td>
              <Checkbox checked={t.allow_half_day} label=""
                onChange={(v) => onChange(t.leave_type_id, { allow_half_day: v })} />
            </Td>
            <Td className="w-24">
              <Input type="number" value={t.max_consecutive_days?.toString() ?? ''}
                onChange={(v) => onChange(t.leave_type_id, { max_consecutive_days: v ? Number(v) : undefined })} />
            </Td>
            <Td className="w-24">
              <Input type="number" value={String(t.notice_days)}
                onChange={(v) => onChange(t.leave_type_id, { notice_days: Number(v || 0) })} />
            </Td>
            <Td className="w-24">
              <Input type="number" value={t.document_required_after_days?.toString() ?? ''}
                onChange={(v) => onChange(t.leave_type_id, { document_required_after_days: v ? Number(v) : undefined })} />
            </Td>
            <Td>
              <Checkbox checked={t.available_during_probation} label=""
                onChange={(v) => onChange(t.leave_type_id, { available_during_probation: v })} />
            </Td>
            <Td className="w-32">
              <Select value={t.applies_to_gender ?? ''}
                onChange={(v) => onChange(t.leave_type_id, { applies_to_gender: v || undefined })}
                placeholder="Everybody"
                options={[
                  { value: 'female', label: 'Women only' },
                  { value: 'male', label: 'Men only' },
                ]} />
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function LOPRulesTab({
  policy,
  onChange,
}: {
  policy: Policy
  onChange: <K extends keyof Policy>(k: K, v: Policy[K]) => void
}) {
  return (
    <>
      <Card>
        <CardHeader title="Half a day"
          description="Stored rather than assumed to be exactly half: a school with a six-period morning and an eight-period day does not split evenly." />
        <div className="p-5">
          <FormGrid>
            <Field label="A half day costs" hint="As a fraction of a day's pay, between 0 and 1">
              <Input type="number" value={String(policy.half_day_fraction)}
                onChange={(v) => onChange('half_day_fraction', Number(v || 0))} />
            </Field>
            <Field label="Rounding"
              hint="A half-day rule that produces 2.33 days and a payslip showing 2.5 need one place where the difference is decided">
              <Select value={policy.lop_rounding} onChange={(v) => onChange('lop_rounding', v)}
                options={[
                  { value: 'none', label: 'None — charge the exact fraction' },
                  { value: 'half', label: 'To the nearest half day' },
                  { value: 'up', label: 'Up, to the whole day' },
                ]} />
            </Field>
          </FormGrid>
        </div>
      </Card>

      <Card>
        <CardHeader title="Late arrival"
          description="Past the grace window the day earns a late mark, and enough marks make a day. Beyond the half-day threshold the morning is simply gone and no mark is counted, so nobody is charged twice for one late bus." />
        <div className="p-5">
          <FormGrid>
            <Field label="The day starts at">
              <Input type="time" value={policy.shift_starts_at}
                onChange={(v) => onChange('shift_starts_at', v)} />
            </Field>
            <Field label="Grace period (minutes)">
              <Input type="number" value={String(policy.grace_minutes)}
                onChange={(v) => onChange('grace_minutes', Number(v || 0))} />
            </Field>
            <Field label="Late marks that make one day">
              <Input type="number" value={String(policy.late_marks_per_lop_day)}
                onChange={(v) => onChange('late_marks_per_lop_day', Number(v || 1))} />
            </Field>
            <Field label="Half a day after (minutes)"
              hint="Leave blank to switch the rule off. Zero would charge every arrival.">
              <Input type="number" value={policy.late_half_day_after_minutes?.toString() ?? ''}
                onChange={(v) => onChange('late_half_day_after_minutes', v ? Number(v) : undefined)} />
            </Field>
          </FormGrid>
        </div>
      </Card>

      <Card>
        <CardHeader title="What becomes loss of pay"
          description="Payroll pro-rates every earning on the days actually paid, so what is switched on here is what a payslip will show as deducted." />
        <div className="space-y-5 p-5">
          <Checkbox checked={policy.lop_on_absent} onChange={(v) => onChange('lop_on_absent', v)}
            label="An unexplained absence costs a full day" />
          <Checkbox checked={policy.lop_on_unpaid_leave} onChange={(v) => onChange('lop_on_unpaid_leave', v)}
            label="Leave taken on an unpaid type costs a day"
            hint="Half-day unpaid leave costs the half-day fraction above" />
          <FormGrid>
            <Field label="Most days a month may lose"
              hint="Leave blank for no cap. A month can never cost more days than it has.">
              <Input type="number" value={policy.max_lop_days_per_month?.toString() ?? ''}
                onChange={(v) => onChange('max_lop_days_per_month', v ? Number(v) : undefined)} />
            </Field>
          </FormGrid>
        </div>
      </Card>
    </>
  )
}

function RegisterTab() {
  const start = lastMonth()
  const [year, setYear] = useState(String(start.year))
  const [month, setMonth] = useState(String(start.month))

  const reg = useQuery({
    queryKey: ['hr', 'lop', year, month],
    queryFn: () => api.get<LOPRegister>(`/api/v1/hr/lop?year=${year}&month=${month}`),
  })

  const rows = (reg.data?.items ?? []).filter((r) => r.lop_days > 0)

  return (
    <Card>
      <CardHeader
        title="Loss of pay for the month"
        description="Read from the same function payroll calls, so this screen and the payslip cannot disagree. Only staff who lost something are listed."
        action={
          <div className="flex flex-wrap gap-2">
            <Select value={month} onChange={setMonth}
              options={MONTHS.map((label, i) => ({ value: String(i + 1), label }))} />
            <Input value={year} onChange={setYear} type="number" className="w-24" />
          </div>
        }
      />
      {reg.isLoading ? (
        <Loading label="Working out the month…" />
      ) : rows.length === 0 ? (
        <EmptyState title="Nobody lost a day"
          body="Every member of staff was present, on paid leave, or inside the grace period." />
      ) : (
        <Table head={['Employee', 'Absent', 'Half days', 'Unpaid leave', 'Late marks', 'Days lost']}>
          {rows.map((r) => (
            <tr key={r.employee_id}>
              <Td className="font-medium">{r.full_name}
                <div className="text-[12px] font-normal text-muted-foreground">{r.employee_code}</div>
              </Td>
              <Td className="tabular-nums text-muted-foreground">{r.absent_days || '—'}</Td>
              <Td className="tabular-nums text-muted-foreground">{r.half_days || '—'}</Td>
              <Td className="tabular-nums text-muted-foreground">{r.unpaid_leave_days || '—'}</Td>
              <Td className="tabular-nums text-muted-foreground">{r.late_marks || '—'}</Td>
              <Td className="tabular-nums font-medium">{r.lop_days}</Td>
            </tr>
          ))}
          <tr className="font-medium">
            <Td>Total</Td>
            <Td /><Td /><Td /><Td />
            <Td className="tabular-nums">{reg.data?.total_lop_days ?? 0}</Td>
          </tr>
        </Table>
      )}
    </Card>
  )
}
