import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Banknote, Calculator, FileSpreadsheet, HandCoins, Landmark, ShieldCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Checkbox, Field, FormGrid, FormNotice, Input, Select,
  Loading, SkeletonTable, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'

/* What the government takes, and what the school owes.

   Payroll could compute a payslip from a salary structure, with PF and
   professional tax as fixed amounts somebody typed into a component. That is
   fine until a salary changes, at which point the deduction silently does not,
   and every return filed against it is wrong for the rest of the year.

   Everything here is computed from the wage and a stored rate. The rates are
   stored rather than compiled in because the EPF ceiling has moved twice in
   living memory and ESI's threshold three times, and a rate in code is a rate
   that needs a deploy on the morning the gazette changes. */

interface Settings {
  pf_enabled: boolean
  pf_employee_percent: number
  pf_employer_percent: number
  pf_wage_ceiling_paise: number
  eps_percent: number
  pf_admin_percent: number
  pf_establishment_code?: string
  esi_enabled: boolean
  esi_employee_percent: number
  esi_employer_percent: number
  esi_wage_threshold_paise: number
  esi_code?: string
  pt_state: string
  pt_enabled: boolean
  substitution_rate_paise: number
  overtime_hourly_paise: number
  overtime_holiday_multiplier: number
  gratuity_days: number
  gratuity_month_days: number
  gratuity_min_years: number
  gratuity_cap_paise: number
  pt_slabs: Slab[]
}
interface Slab {
  id?: string
  state: string
  from_paise: number
  to_paise?: number
  monthly_paise: number
}
interface StatRow {
  employee_id: string
  employee_code: string
  full_name: string
  uan?: string
  esi_number?: string
  gross_paise: number
  basic_da_paise: number
  pf_wage_paise: number
  pf_employee_paise: number
  pf_employer_paise: number
  eps_paise: number
  esi_employee_paise: number
  esi_employer_paise: number
  pt_paise: number
  missing: string[]
}
interface Gratuity {
  employee_id: string
  full_name: string
  joined_on: string
  years_of_service: number
  counted_years: number
  basic_da_paise: number
  accrued_paise: number
  vested_paise: number
  eligible: boolean
  no_salary_structure: boolean
}
interface Loan {
  id: string
  employee_id: string
  full_name: string
  kind: string
  principal_paise: number
  instalment_paise: number
  reason?: string
  status: string
  recovered_paise: number
  outstanding_paise: number
  months_left: number
}
interface Bill {
  id: string
  vendor: string
  service: string
  period_year: number
  period_month: number
  invoice_no?: string
  claimed_days: number
  verified_days?: number
  rate_paise: number
  claimed_paise: number
  approved_paise?: number
  status: string
  remarks?: string
  shortfall_paise: number
}
interface Named {
  id: string
  full_name?: string
  name?: string
}

const TABS = [
  ['register', 'PF, ESI & PT', ShieldCheck],
  ['tax', 'Income tax', Calculator],
  ['loans', 'Advances', HandCoins],
  ['gratuity', 'Gratuity', Landmark],
  ['contractors', 'Contractors', FileSpreadsheet],
  ['settings', 'Rates', Banknote],
] as const

const rupees = (p: number) => (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })

function lastMonth() {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}

export default function Statutory() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('register')
  const start = lastMonth()
  const [year, setYear] = useState(String(start.year))
  const [month, setMonth] = useState(String(start.month))

  const reg = useQuery({
    queryKey: ['statutory', year, month],
    queryFn: () =>
      api.get<{ items: StatRow[]; totals: Record<string, number> }>(
        `/api/v1/payroll/statutory?year=${year}&month=${month}`,
      ),
  })

  if (reg.isLoading) return <SkeletonTiles count={4} label="Working out the month's contributions…" />
  if (reg.error) return <ErrorState error={reg.error} />

  const t = reg.data?.totals ?? {}
  const incomplete = (reg.data?.items ?? []).filter((r) => r.missing.length > 0)

  return (
    <>
      <PageHead
        eyebrow="Payroll"
        title="Statutory returns"
        description="Provident fund, state insurance and professional tax, computed from each wage rather than typed into a component."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="PF this month" value={`₹${rupees(t.pf_employee_paise ?? 0)}`} icon={ShieldCheck} />
          <Stat label="Employer's share" value={`₹${rupees((t.pf_employer_paise ?? 0) + (t.eps_paise ?? 0))}`} />
          <Stat label="ESI" value={`₹${rupees((t.esi_employee_paise ?? 0) + (t.esi_employer_paise ?? 0))}`} />
          <Stat
            label="Missing numbers"
            value={incomplete.length}
            delta={
              incomplete.length
                ? { value: 'One absent UAN fails the whole upload', positive: false }
                : { value: 'Every return complete', positive: true }
            }
          />
        </CellGrid>

        <div className="flex flex-wrap gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              aria-current={tab === k}
              className={
                tab === k
                  ? '-mb-px flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                  : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'
              }
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {tab === 'register' && (
          <Register
            rows={reg.data?.items ?? []}
            totals={t}
            year={year}
            month={month}
            onPeriod={(y, m) => {
              setYear(y)
              setMonth(m)
            }}
          />
        )}
        {tab === 'tax' && <IncomeTax />}
        {tab === 'loans' && <Advances />}
        {tab === 'gratuity' && <GratuityTab />}
        {tab === 'contractors' && <Contractors />}
        {tab === 'settings' && <Rates />}
      </PageBody>
    </>
  )
}

function Register({
  rows,
  totals,
  year,
  month,
  onPeriod,
}: {
  rows: StatRow[]
  totals: Record<string, number>
  year: string
  month: string
  onPeriod: (y: string, m: string) => void
}) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  return (
    <Card>
      <CardHeader
        title="The month's register"
        description="Read from the payslips actually issued, so the return and the payslip can never disagree. PF is on basic plus dearness allowance and capped at the ceiling; ESI stops entirely above its threshold."
        action={
          <div className="flex flex-wrap gap-2">
            <Select
              value={month}
              onChange={(m) => onPeriod(year, m)}
              options={months.map((label, i) => ({ value: String(i + 1), label }))}
            />
            <Input value={year} onChange={(y) => onPeriod(y, month)} type="number" className="w-24" />
            <Button
              variant="secondary"
              onClick={() => window.open(`/api/v1/payroll/ecr?year=${year}&month=${month}`, '_blank')}
            >
              ECR file
            </Button>
            <Button
              variant="secondary"
              onClick={() => window.open(`/api/v1/payroll/bank-file?year=${year}&month=${month}`, '_blank')}
            >
              Bank file
            </Button>
          </div>
        }
      />
      {rows.length === 0 ? (
        <EmptyState
          title="No payroll for this month"
          body="Run payroll for the period first; the register is built from the payslips it issues."
        />
      ) : (
        <Table
          head={[
            { label: 'Employee' },
            { label: 'Basic + DA' },
            { label: 'PF wage' },
            { label: 'PF' },
            { label: 'Employer' },
            { label: 'Pension' },
            { label: 'ESI' },
            { label: 'PT' },
          ]}
        >
          {rows.map((r) => (
            <tr key={r.employee_id}>
              <Td className="font-medium">
                {r.full_name}
                <div className="text-[12px] font-normal text-muted-foreground">
                  {r.employee_code || '—'}
                  {r.missing.length > 0 && (
                    <span className="ml-1 text-destructive">no {r.missing.join(', ')}</span>
                  )}
                </div>
              </Td>
              <Td className="tabular-nums">₹{rupees(r.basic_da_paise)}</Td>
              <Td className="tabular-nums text-muted-foreground">₹{rupees(r.pf_wage_paise)}</Td>
              <Td className="tabular-nums">₹{rupees(r.pf_employee_paise)}</Td>
              <Td className="tabular-nums text-muted-foreground">₹{rupees(r.pf_employer_paise)}</Td>
              <Td className="tabular-nums text-muted-foreground">₹{rupees(r.eps_paise)}</Td>
              <Td className="tabular-nums">
                {r.esi_employee_paise ? `₹${rupees(r.esi_employee_paise)}` : '—'}
              </Td>
              <Td className="tabular-nums">₹{rupees(r.pt_paise)}</Td>
            </tr>
          ))}
          <tr className="font-medium">
            <Td>Total</Td>
            <Td />
            <Td />
            <Td className="tabular-nums">₹{rupees(totals.pf_employee_paise ?? 0)}</Td>
            <Td className="tabular-nums">₹{rupees(totals.pf_employer_paise ?? 0)}</Td>
            <Td className="tabular-nums">₹{rupees(totals.eps_paise ?? 0)}</Td>
            <Td className="tabular-nums">₹{rupees(totals.esi_employee_paise ?? 0)}</Td>
            <Td className="tabular-nums">₹{rupees(totals.pt_paise ?? 0)}</Td>
          </tr>
        </Table>
      )}
    </Card>
  )
}

function IncomeTax() {
  const qc = useQueryClient()
  const [employeeId, setEmployeeId] = useState('')
  const [section, setSection] = useState('80C')
  const [particulars, setParticulars] = useState('')
  const [amount, setAmount] = useState('')
  const [regime, setRegime] = useState('')

  const employees = useQuery({
    queryKey: ['employees', 'payroll'],
    queryFn: () => api.get<List<Named>>('/api/v1/hr/employees?limit=300'),
  })
  const tax = useQuery({
    queryKey: ['tax', employeeId],
    queryFn: () =>
      api.get<Record<string, number | string | boolean | unknown[]>>(
        `/api/v1/payroll/tax?employee_id=${employeeId}`,
      ),
    enabled: !!employeeId,
  })
  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/payroll/declarations', {
        employee_id: employeeId,
        section,
        particulars,
        declared_paise: Math.round(Number(amount || 0) * 100),
        regime: regime || undefined,
      }),
    onSuccess: () => {
      setParticulars('')
      setAmount('')
      qc.invalidateQueries()
    },
  })
  const verify = useMutation({
    mutationFn: (v: { id: string; status: string; verified_paise?: number; remarks?: string }) =>
      api.post('/api/v1/payroll/declarations', v),
    onSuccess: () => qc.invalidateQueries(),
  })

  const t = tax.data as
    | (Record<string, number> & { declarations: { id: string; section: string; particulars: string; declared_paise: number; verified_paise?: number; status: string; counted_paise: number }[]; regime: string; elected: boolean; projected: boolean })
    | undefined

  return (
    <>
      <Card>
        <CardHeader
          title="Working out the withholding"
          description="Every intermediate number is shown, because a payroll office is asked why this much was deducted every February and a total cannot be defended."
          action={
            <Select
              value={employeeId}
              onChange={setEmployeeId}
              placeholder="Choose an employee"
              options={(employees.data?.items ?? []).map((e) => ({
                value: e.id,
                label: e.full_name ?? e.name ?? e.id,
              }))}
            />
          }
        />
        {!employeeId ? (
          <EmptyState title="Choose an employee" body="Their TDS working and Form 16 basis appear here." />
        ) : tax.isLoading ? (
          <SkeletonTable columns={2} label="Computing…" />
        ) : t ? (
          <div className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone={t.regime === 'old' ? 'warning' : 'neutral'}>
                {t.regime === 'old' ? 'Old regime' : 'New regime'}
              </Badge>
              {!t.elected && (
                <span className="text-[13px] text-muted-foreground">
                  Defaulted — the employee has not chosen
                </span>
              )}
              {t.projected && (
                <span className="text-[13px] text-muted-foreground">
                  Projected from {t.months_paid} month{t.months_paid === 1 ? '' : 's'} paid
                </span>
              )}
            </div>
            <Table head={[{ label: 'Line' }, { label: 'Amount' }]}>
              {(
                [
                  ['Gross salary for the year', t.gross_annual_paise],
                  ['Less standard deduction', -t.standard_deduction_paise],
                  ...(t.regime === 'old'
                    ? ([
                        ['Less Chapter VI-A', -t.chapter_via_paise],
                        ['Less professional tax', -t.professional_tax_paise],
                      ] as [string, number][])
                    : []),
                  ['Taxable income', t.taxable_income_paise],
                  ['Tax on slabs', t.tax_before_rebate_paise],
                  ['Less rebate under 87A', -t.rebate_paise],
                  ['Health and education cess', t.cess_paise],
                  ['Tax payable for the year', t.tax_payable_paise],
                  ['To withhold each month', t.monthly_tds_paise],
                ] as [string, number][]
              ).map(([label, v]) => (
                <tr key={label}>
                  <Td
                    className={
                      label.startsWith('Tax payable') || label.startsWith('To withhold')
                        ? 'font-medium'
                        : ''
                    }
                  >
                    {label}
                  </Td>
                  <Td className="tabular-nums">
                    {v < 0 ? `(₹${rupees(-v)})` : `₹${rupees(v)}`}
                  </Td>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}
      </Card>

      {employeeId && (
        <Card>
          <CardHeader
            title="Investment declarations"
            description="A declaration in April is a promise; the proof arrives in January. TDS runs on the promise and is corrected on the proof, which is what Form 12BB exists to record."
          />
          <div className="border-b p-4">
            <FormGrid>
              <Field label="Section">
                <Select
                  value={section}
                  onChange={setSection}
                  options={[
                    { value: '80C', label: '80C — LIC, PPF, ELSS, tuition fees' },
                    { value: '80D', label: '80D — medical insurance' },
                    { value: '80CCD1B', label: '80CCD(1B) — NPS' },
                    { value: '80E', label: '80E — education loan interest' },
                    { value: '80G', label: '80G — donations' },
                    { value: '24B', label: '24(b) — home loan interest' },
                    { value: 'HRA', label: 'HRA — rent paid' },
                  ]}
                />
              </Field>
              <Field label="What it is">
                <Input value={particulars} onChange={setParticulars} placeholder="LIC premium and PPF" />
              </Field>
              <Field label="Amount (₹)">
                <Input value={amount} onChange={setAmount} type="number" />
              </Field>
              <Field label="Regime" hint="Only set this when the employee actually chooses.">
                <Select
                  value={regime}
                  onChange={setRegime}
                  placeholder="Leave as is"
                  options={[
                    { value: 'new', label: 'New regime' },
                    { value: 'old', label: 'Old regime' },
                  ]}
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <Button
                disabled={save.isPending || !particulars.trim()}
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : 'Add declaration'}
              </Button>
            </div>
            <FormNotice error={save.error} />
          </div>
          {(t?.declarations ?? []).length === 0 ? (
            <EmptyState title="Nothing declared" body="Declarations reduce tax only under the old regime." />
          ) : (
            <Table
              head={[
                { label: 'Section' },
                { label: 'Particulars' },
                { label: 'Declared' },
                { label: 'Verified' },
                { label: 'Counted' },
                { label: '' },
              ]}
            >
              {(t?.declarations ?? []).map((d) => (
                <tr key={d.id}>
                  <Td className="font-medium">{d.section}</Td>
                  <Td>{d.particulars}</Td>
                  <Td className="tabular-nums">₹{rupees(d.declared_paise)}</Td>
                  <Td className="tabular-nums text-muted-foreground">
                    {d.verified_paise != null ? `₹${rupees(d.verified_paise)}` : '—'}
                  </Td>
                  <Td className="tabular-nums">₹{rupees(d.counted_paise)}</Td>
                  <Td>
                    {d.status === 'verified' ? (
                      <Badge tone="success">Verified</Badge>
                    ) : d.status === 'rejected' ? (
                      <Badge tone="danger">Rejected</Badge>
                    ) : (
                      <Button
                        size="sm"
                        disabled={verify.isPending}
                        onClick={() =>
                          verify.mutate({
                            id: d.id,
                            status: 'verified',
                            verified_paise: d.declared_paise,
                          })
                        }
                      >
                        Accept proof
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <FormNotice error={verify.error} />
        </Card>
      )}
    </>
  )
}

function Advances() {
  const qc = useQueryClient()
  const [employeeId, setEmployeeId] = useState('')
  const [principal, setPrincipal] = useState('')
  const [instalment, setInstalment] = useState('')
  const [reason, setReason] = useState('')

  const list = useQuery({
    queryKey: ['staff-loans'],
    queryFn: () => api.get<List<Loan>>('/api/v1/payroll/loans'),
  })
  const employees = useQuery({
    queryKey: ['employees', 'payroll'],
    queryFn: () => api.get<List<Named>>('/api/v1/hr/employees?limit=300'),
  })
  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/payroll/loans', {
        employee_id: employeeId,
        principal_paise: Math.round(Number(principal || 0) * 100),
        instalment_paise: Math.round(Number(instalment || 0) * 100),
        reason,
      }),
    onSuccess: () => {
      setPrincipal('')
      setInstalment('')
      setReason('')
      qc.invalidateQueries({ queryKey: ['staff-loans'] })
    },
  })

  const rows = list.data?.items ?? []
  const outstanding = rows.reduce((n, r) => n + r.outstanding_paise, 0)

  return (
    <>
      <CellGrid cols={3}>
        <Stat label="Outstanding" value={`₹${rupees(outstanding)}`} icon={HandCoins} />
        <Stat label="Active advances" value={rows.filter((r) => r.status === 'active').length} />
        <Stat label="All time" value={rows.length} />
      </CellGrid>

      <Card>
        <CardHeader
          title="Give an advance"
          description="Instalments come out of the next payroll run automatically, and the last one is trimmed to whatever is still owed."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Employee" required>
              <Select
                value={employeeId}
                onChange={setEmployeeId}
                placeholder="Choose"
                options={(employees.data?.items ?? []).map((e) => ({
                  value: e.id,
                  label: e.full_name ?? e.name ?? e.id,
                }))}
              />
            </Field>
            <Field label="Amount (₹)" required>
              <Input value={principal} onChange={setPrincipal} type="number" />
            </Field>
            <Field label="Monthly instalment (₹)" required>
              <Input value={instalment} onChange={setInstalment} type="number" />
            </Field>
            <Field label="Reason">
              <Input value={reason} onChange={setReason} placeholder="Daughter's wedding" />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button
              disabled={save.isPending || !employeeId || !principal || !instalment}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Approve advance'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Recovery"
          description="The balance is summed from instalments actually taken. A stored balance that disagrees with the payslips is how these end up in a labour court."
        />
        {rows.length === 0 ? (
          <EmptyState title="No advances" body="Salary advances appear here with what is left to recover." />
        ) : (
          <Table
            head={[
              { label: 'Employee' },
              { label: 'Advance' },
              { label: 'Instalment' },
              { label: 'Recovered' },
              { label: 'Outstanding' },
              { label: 'Left' },
              { label: '' },
            ]}
          >
            {rows.map((l) => (
              <tr key={l.id}>
                <Td className="font-medium">
                  {l.full_name}
                  {l.reason && (
                    <div className="text-[12px] font-normal text-muted-foreground">{l.reason}</div>
                  )}
                </Td>
                <Td className="tabular-nums">₹{rupees(l.principal_paise)}</Td>
                <Td className="tabular-nums text-muted-foreground">₹{rupees(l.instalment_paise)}</Td>
                <Td className="tabular-nums text-muted-foreground">₹{rupees(l.recovered_paise)}</Td>
                <Td className="tabular-nums">₹{rupees(l.outstanding_paise)}</Td>
                <Td className="tabular-nums text-muted-foreground">
                  {l.status === 'active' ? `${l.months_left} mo` : '—'}
                </Td>
                <Td>
                  <Badge tone={l.status === 'active' ? 'warning' : 'success'}>{l.status}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

function GratuityTab() {
  const g = useQuery({
    queryKey: ['gratuity'],
    queryFn: () =>
      api.get<{
        items: Gratuity[]
        total_accrued_paise: number
        vested_paise: number
        staff_without_salary_structure: number
      }>('/api/v1/payroll/gratuity'),
  })

  if (g.isLoading) return <SkeletonTable columns={7} label="Working out the exposure…" />
  const d = g.data

  return (
    <>
      <CellGrid cols={3}>
        <Stat label="Accrued" value={`₹${rupees(d?.total_accrued_paise ?? 0)}`} icon={Landmark} />
        <Stat label="Payable if everyone left today" value={`₹${rupees(d?.vested_paise ?? 0)}`} />
        <Stat
          label="Cannot be computed"
          value={d?.staff_without_salary_structure ?? 0}
          delta={
            d?.staff_without_salary_structure
              ? { value: 'No salary structure on file', positive: false }
              : undefined
          }
        />
      </CellGrid>
      <Card>
        <CardHeader
          title="Gratuity exposure"
          description="Fifteen days' wages for each completed year on a twenty-six day month, payable after five. Accrued is what has built up; vested is what would actually have to be paid this afternoon — nothing at all under five years, however long the accrual."
        />
        <Table
          head={[
            { label: 'Employee' },
            { label: 'Joined' },
            { label: 'Service' },
            { label: 'Basic + DA' },
            { label: 'Accrued' },
            { label: 'Vested' },
          ]}
        >
          {(d?.items ?? []).map((x) => (
            <tr key={x.employee_id}>
              <Td className="font-medium">
                {x.full_name}
                {x.no_salary_structure && (
                  <div className="text-[12px] font-normal text-destructive">
                    No salary structure — cannot be computed
                  </div>
                )}
              </Td>
              <Td className="text-muted-foreground">{x.joined_on}</Td>
              <Td className="tabular-nums text-muted-foreground">
                {x.years_of_service.toFixed(1)}y
                <span className="ml-1 text-[12px]">counted {x.counted_years}</span>
              </Td>
              <Td className="tabular-nums text-muted-foreground">₹{rupees(x.basic_da_paise)}</Td>
              <Td className="tabular-nums">₹{rupees(x.accrued_paise)}</Td>
              <Td className="tabular-nums">
                {x.eligible ? (
                  `₹${rupees(x.vested_paise)}`
                ) : (
                  <span className="text-muted-foreground">not yet</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}

function Contractors() {
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({ service: 'security' })
  const [verifying, setVerifying] = useState<string | null>(null)
  const [days, setDays] = useState('')
  const [remarks, setRemarks] = useState('')

  const list = useQuery({
    queryKey: ['contractor-bills'],
    queryFn: () => api.get<List<Bill>>('/api/v1/payroll/contractor-bills'),
  })
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post('/api/v1/payroll/contractor-bills', v),
    onSuccess: () => {
      setVerifying(null)
      qc.invalidateQueries({ queryKey: ['contractor-bills'] })
    },
  })

  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })
  const rows = list.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="An outsourced staff bill"
          description="Guards and cleaners are the contractor's people, not the school's — putting them in the staff list would inflate every headcount the school reports. What is checked is the bill: bodies claimed against bodies the gate saw."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Vendor" required>
              <Input value={form.vendor ?? ''} onChange={set('vendor')} placeholder="Sai Security Services" />
            </Field>
            <Field label="Service">
              <Select
                value={form.service ?? 'security'}
                onChange={set('service')}
                options={[
                  { value: 'security', label: 'Security' },
                  { value: 'housekeeping', label: 'Housekeeping' },
                  { value: 'gardening', label: 'Gardening' },
                  { value: 'catering', label: 'Catering' },
                ]}
              />
            </Field>
            <Field label="Person-days claimed" required>
              <Input value={form.claimed_days ?? ''} onChange={set('claimed_days')} type="number" />
            </Field>
            <Field label="Day rate (₹)" required>
              <Input value={form.rate ?? ''} onChange={set('rate')} type="number" />
            </Field>
            <Field label="Invoice number">
              <Input value={form.invoice_no ?? ''} onChange={set('invoice_no')} />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button
              disabled={save.isPending || !form.vendor || !form.claimed_days || !form.rate}
              onClick={() =>
                save.mutate({
                  vendor: form.vendor,
                  service: form.service,
                  claimed_days: Number(form.claimed_days),
                  rate_paise: Math.round(Number(form.rate) * 100),
                  invoice_no: form.invoice_no,
                })
              }
            >
              {save.isPending ? 'Saving…' : 'Record bill'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Bills"
          description="The approved amount follows the verified days, so a bill can only be short-paid by disagreeing about attendance — and that disagreement has to be written down."
        />
        {rows.length === 0 ? (
          <EmptyState title="No bills" body="Contractor invoices appear here for verification." />
        ) : (
          <Table
            head={[
              { label: 'Vendor' },
              { label: 'Period' },
              { label: 'Claimed' },
              { label: 'Verified' },
              { label: 'Short' },
              { label: '' },
            ]}
          >
            {rows.map((b) => (
              <tr key={b.id}>
                <Td className="font-medium">
                  {b.vendor}
                  <div className="text-[12px] font-normal text-muted-foreground">
                    {b.service}
                    {b.invoice_no && ` · ${b.invoice_no}`}
                  </div>
                </Td>
                <Td className="text-muted-foreground">
                  {b.period_month}/{b.period_year}
                </Td>
                <Td className="tabular-nums">
                  {b.claimed_days}d · ₹{rupees(b.claimed_paise)}
                </Td>
                <Td className="tabular-nums">
                  {b.verified_days != null
                    ? `${b.verified_days}d · ₹${rupees(b.approved_paise ?? 0)}`
                    : '—'}
                </Td>
                <Td className="tabular-nums">
                  {b.shortfall_paise > 0 ? (
                    <Badge tone="warning">₹{rupees(b.shortfall_paise)}</Badge>
                  ) : (
                    '—'
                  )}
                  {b.remarks && (
                    <div className="text-[12px] text-muted-foreground">{b.remarks}</div>
                  )}
                </Td>
                <Td>
                  {b.status === 'received' ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        setVerifying(b.id)
                        setDays(String(b.claimed_days))
                        setRemarks('')
                      }}
                    >
                      Verify
                    </Button>
                  ) : (
                    <Badge tone="success">{b.status}</Badge>
                  )}
                  {verifying === b.id && (
                    <div className="mt-2 space-y-2">
                      <Input value={days} onChange={setDays} type="number" placeholder="Days actually worked" />
                      {Number(days) < b.claimed_days && (
                        <Input
                          value={remarks}
                          onChange={setRemarks}
                          placeholder="Why less than billed"
                        />
                      )}
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          disabled={
                            save.isPending ||
                            (Number(days) < b.claimed_days && remarks.trim() === '')
                          }
                          onClick={() =>
                            save.mutate({ id: b.id, verified_days: Number(days), remarks })
                          }
                        >
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setVerifying(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

function Rates() {
  const qc = useQueryClient()
  const s = useQuery({
    queryKey: ['payroll-settings'],
    queryFn: () => api.get<Settings>('/api/v1/payroll/settings'),
  })
  const [draft, setDraft] = useState<Settings | null>(null)
  const save = useMutation({
    mutationFn: () => api.put('/api/v1/payroll/settings', draft),
    onSuccess: () => {
      setDraft(null)
      qc.invalidateQueries({ queryKey: ['payroll-settings'] })
    },
  })

  if (s.isLoading) return <Loading label="Loading rates…" />
  const v = draft ?? s.data
  if (!v) return null
  const set = (k: keyof Settings) => (val: string) =>
    setDraft({ ...v, [k]: Number(val) } as Settings)

  return (
    <Card>
      <CardHeader
        title="Statutory rates"
        description="Stored rather than compiled in: the EPF ceiling has moved twice in living memory and ESI's threshold three times, and a rate in code needs a deploy on the morning the gazette changes."
      />
      <div className="p-4">
        <FormGrid>
          <Field label="PF employee %">
            <Input value={String(v.pf_employee_percent)} onChange={set('pf_employee_percent')} type="number" />
          </Field>
          <Field label="PF employer %">
            <Input value={String(v.pf_employer_percent)} onChange={set('pf_employer_percent')} type="number" />
          </Field>
          <Field label="PF wage ceiling (₹)" hint="The wage contributions are computed on, not a cut-off for coverage.">
            <Input
              value={String(v.pf_wage_ceiling_paise / 100)}
              onChange={(x) => setDraft({ ...v, pf_wage_ceiling_paise: Math.round(Number(x) * 100) })}
              type="number"
            />
          </Field>
          <Field label="Pension share %" hint="Comes out of the employer's share, not on top of it.">
            <Input value={String(v.eps_percent)} onChange={set('eps_percent')} type="number" />
          </Field>
          <Field label="ESI employee %">
            <Input value={String(v.esi_employee_percent)} onChange={set('esi_employee_percent')} type="number" />
          </Field>
          <Field label="ESI employer %">
            <Input value={String(v.esi_employer_percent)} onChange={set('esi_employer_percent')} type="number" />
          </Field>
          <Field label="ESI wage threshold (₹)" hint="Above this, ESI stops entirely.">
            <Input
              value={String(v.esi_wage_threshold_paise / 100)}
              onChange={(x) => setDraft({ ...v, esi_wage_threshold_paise: Math.round(Number(x) * 100) })}
              type="number"
            />
          </Field>
          <Field label="Professional tax state">
            <Input
              value={v.pt_state}
              onChange={(x) => setDraft({ ...v, pt_state: x })}
            />
          </Field>
          <Field label="Per proxy period (₹)" hint="School policy, not law — which is why it lives here.">
            <Input
              value={String(v.substitution_rate_paise / 100)}
              onChange={(x) => setDraft({ ...v, substitution_rate_paise: Math.round(Number(x) * 100) })}
              type="number"
            />
          </Field>
          <Field label="Overtime per hour (₹)">
            <Input
              value={String(v.overtime_hourly_paise / 100)}
              onChange={(x) => setDraft({ ...v, overtime_hourly_paise: Math.round(Number(x) * 100) })}
              type="number"
            />
          </Field>
          <Field label="Holiday overtime multiplier">
            <Input
              value={String(v.overtime_holiday_multiplier)}
              onChange={set('overtime_holiday_multiplier')}
              type="number"
            />
          </Field>
          <Field label="Gratuity days per year" hint="Fifteen days on a twenty-six day month is the Act's own formula.">
            <Input value={String(v.gratuity_days)} onChange={set('gratuity_days')} type="number" />
          </Field>
        </FormGrid>

        <div className="mt-4 flex gap-3">
          <Checkbox
            checked={v.pf_enabled}
            onChange={(x) => setDraft({ ...v, pf_enabled: x })}
            label="Deduct PF"
          />
          <Checkbox
            checked={v.esi_enabled}
            onChange={(x) => setDraft({ ...v, esi_enabled: x })}
            label="Deduct ESI"
          />
          <Checkbox
            checked={v.pt_enabled}
            onChange={(x) => setDraft({ ...v, pt_enabled: x })}
            label="Deduct professional tax"
          />
        </div>

        <h3 className="mt-6 text-[14px] font-medium">Professional tax slabs — {v.pt_state}</h3>
        <Table head={[{ label: 'Monthly wage from' }, { label: 'To' }, { label: 'Tax' }]}>
          {v.pt_slabs.map((sl, i) => (
            <tr key={sl.id ?? i}>
              <Td className="tabular-nums">₹{rupees(sl.from_paise)}</Td>
              <Td className="tabular-nums text-muted-foreground">
                {sl.to_paise ? `₹${rupees(sl.to_paise)}` : 'and above'}
              </Td>
              <Td className="tabular-nums">₹{rupees(sl.monthly_paise)}</Td>
            </tr>
          ))}
        </Table>

        <div className="mt-4 flex items-center gap-2">
          <Button disabled={save.isPending || draft === null} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save rates'}
          </Button>
          {draft !== null && (
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Discard
            </Button>
          )}
        </div>
        <FormNotice error={save.error} />
      </div>
    </Card>
  )
}
