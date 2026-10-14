import { useState } from 'react'
import { rupeesToPaise } from '@/lib/money'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Select, Field, FormGrid, FormNotice, SkeletonTable, ErrorState,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'
import BulkImport from '@/components/BulkImport'
import { useOpenState } from '@/lib/motion'

/* What each person is paid — the thing payroll could not run without.
 *
 * "Salary structure builder" was a menu entry that opened the payroll run
 * screen and built nothing. Behind it, no endpoint in the product wrote a
 * salary: salary_components was empty in every school on the installation, and
 * a payroll run only pays staff who have a structure. So Run payroll found
 * nobody, month after month, and the register underneath stayed empty — which
 * reads as a broken button rather than as a step nobody could take.
 *
 * Revise edits the salary in force (owner, 2026-10-14: "let them edit and save
 * and no need to duplicate"); payslips already issued keep their own figures.
 */

interface Component {
  id: string
  code: string
  name: string
  kind: 'earning' | 'deduction' | 'employer_contribution'
  is_percent: boolean
  percent_of?: string
  is_statutory: boolean
}

interface Item {
  component_id: string
  code: string
  name: string
  kind: string
  amount_paise: number
  percent?: number
}

interface Row {
  employee_id: string
  employee_code: string
  full_name: string
  structure_id?: string
  effective_from?: string
  ctc_paise: number
  items: Item[]
}

const today = () => new Date().toISOString().slice(0, 10)

/* A PART AS A FIGURE OR AS A SHARE (Yajur, 2026-10-14: "let them add all
   components by selecting % per person or by salary range").

   Each part can be typed in rupees, as a percent of the monthly gross, or as a
   percent of Basic. What is saved is the rupee amount it comes to, because
   that is what a payroll run pays; the percent is kept beside it so the form
   opens the way it was filled. Whatever the parts leave of the gross can go to
   Special allowance, so the split always adds back up to the gross. PF, ESI
   and professional tax are not typed at all: the run works them out from the
   rules in payroll settings. */
type Mode = 'amt' | 'pg' | 'pb'
type Line = { mode: Mode; val: string }
type Lines = Record<string, Line>
const MODES = [
  { value: 'amt', label: '₹ a month' },
  { value: 'pg', label: '% of gross' },
  { value: 'pb', label: '% of Basic' },
]
const AUTO = new Set(['PF', 'ESI', 'PT'])
const typed = (c: Component) => !AUTO.has(c.code)

function splitSalary(comps: Component[], lines: Lines, grossPaise: number, rest: boolean): Record<string, number> {
  const out: Record<string, number> = {}
  const share = (v: string, of: number) => Math.round((of * (Number(v) || 0)) / 100)
  for (const c of comps) {
    const l = lines[c.id]
    if (!typed(c) || !l || l.mode === 'pb') continue
    out[c.id] = l.mode === 'pg' ? share(l.val, grossPaise) : rupeesToPaise(l.val || 0)
  }
  const basic = comps.find((c) => c.code === 'BASIC')
  const basicPaise = basic ? out[basic.id] ?? 0 : 0
  for (const c of comps) {
    const l = lines[c.id]
    if (typed(c) && l?.mode === 'pb') out[c.id] = share(l.val, basicPaise)
  }
  const special = comps.find((c) => c.code === 'SPECIAL')
  if (rest && special && grossPaise > 0) {
    const others = comps.filter((c) => c.kind === 'earning' && c.id !== special.id).reduce((a, c) => a + (out[c.id] ?? 0), 0)
    out[special.id] = Math.max(0, grossPaise - others)
  }
  return out
}
const earned = (comps: Component[], split: Record<string, number>) =>
  comps.filter((c) => c.kind === 'earning').reduce((a, c) => a + (split[c.id] ?? 0), 0)

type RangeRule = { from: string; to: string; lines: Lines; rest: boolean }
const RULE_KEY = 'salary-range-rule'
const loadRule = (): RangeRule => {
  try {
    const v = JSON.parse(localStorage.getItem(RULE_KEY) ?? '')
    if (v && v.lines) return v
  } catch {
    /* none kept */
  }
  return { from: '', to: '', lines: {}, rest: true }
}

function LineInputs({ comps, lines, setLines, split }: {
  comps: Component[]; lines: Lines; setLines: (f: (l: Lines) => Lines) => void; split: Record<string, number>
}) {
  return (
    <Table head={['Component', 'Type', 'Entered as', 'Value', 'Comes to']}>
      {comps.map((c) => {
        const l: Line = lines[c.id] ?? { mode: 'amt', val: '' }
        const set = (p: Partial<Line>) => setLines((x) => ({ ...x, [c.id]: { ...l, ...p } }))
        return (
          <tr key={c.id}>
            <Td>{c.name}</Td>
            <Td>
              <Badge tone={c.kind === 'earning' ? 'success' : 'neutral'}>{c.kind === 'earning' ? 'added' : 'taken off'}</Badge>
            </Td>
            {typed(c) ? (
              <>
                <Td><Select value={l.mode} onChange={(v) => set({ mode: v as Mode })} options={MODES} /></Td>
                <Td><Input type="number" value={l.val} onChange={(v) => set({ val: v })} placeholder="0" /></Td>
                <Td className="tabular-nums">{formatPaise(split[c.id] ?? 0)}</Td>
              </>
            ) : (
              <Td className="text-muted-foreground" colSpan={3}>Worked out by payroll from the settings</Td>
            )}
          </tr>
        )
      })}
    </Table>
  )
}

export default function SalarySetup() {
  const qc = useQueryClient()
  const [open, setOpen] = useOpenState<string | null>(null)
  const [from, setFrom] = useState(today())
  const [lines, setLines] = useState<Lines>({})
  const [gross, setGross] = useState('')
  const [rest, setRest] = useState(true)
  const [rule, setRuleState] = useState<RangeRule>(loadRule)
  const setRule = (f: (r: RangeRule) => RangeRule) =>
    setRuleState((r) => {
      const n = f(r)
      try {
        localStorage.setItem(RULE_KEY, JSON.stringify(n))
      } catch {
        /* kept for this visit only */
      }
      return n
    })
  const [applying, setApplying] = useState('')
  const [done, setDone] = useState('')

  const comps = useQuery({
    queryKey: ['salary-components'],
    queryFn: () =>
      api.get<{ items: Component[]; suggested: Component[] }>('/api/v1/payroll/components'),
  })
  const structures = useQuery({
    queryKey: ['salary-structures'],
    queryFn: () => api.get<{ items: Row[] }>('/api/v1/payroll/structures'),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['salary-components'] })
    qc.invalidateQueries({ queryKey: ['salary-structures'] })
  }

  const addStarters = useMutation({
    mutationFn: () => api.post<{ created: number }>('/api/v1/payroll/components', { starters: true }),
    onSuccess: (r) => {
      setDone(`${r.created} pay components created. You can rename or add to them.`)
      refresh()
    },
  })

  // Paise in the database, so no salary is ever a float. The percent rides
  // along so the form reopens as it was filled.
  const post = (employee_id: string, effective_from: string, l: Lines, split: Record<string, number>) =>
    api.post('/api/v1/payroll/structures', {
      employee_id,
      effective_from,
      items: Object.entries(split)
        .filter(([, v]) => v > 0)
        .map(([component_id, amount_paise]) => ({
          component_id,
          amount_paise,
          percent: l[component_id] && l[component_id].mode !== 'amt' ? Number(l[component_id].val) || null : null,
        })),
    })

  const save = useMutation({
    mutationFn: (v: { employee_id: string; split: Record<string, number> }) => post(v.employee_id, from, lines, v.split),
    onSuccess: () => {
      setDone('Saved. The next payroll run pays these amounts.')
      setOpen(null)
      setLines({})
      refresh()
    },
  })

  const delStructure = useMutation({
    mutationFn: (structureId: string) => api.del(`/api/v1/payroll/structures/${structureId}`),
    onSuccess: () => { setDone('Salary revision deleted.'); refresh() },
    onError: (e: unknown) => setDone(e instanceof Error ? e.message : 'Could not delete'),
  })
  const delComponent = useMutation({
    mutationFn: (componentId: string) => api.del(`/api/v1/payroll/components/${componentId}`),
    onSuccess: () => { setDone('Component removed.'); refresh() },
    onError: (e: unknown) => setDone(e instanceof Error ? e.message : 'Could not remove, a salary may still use it'),
  })

  if (comps.isLoading || structures.isLoading) return <SkeletonTable columns={3} />
  if (comps.error) return <ErrorState error={comps.error} />
  if (structures.error) return <ErrorState error={structures.error} />

  const components = comps.data?.items ?? []
  const rows = structures.data?.items ?? []
  const unpaid = rows.filter((r) => !r.structure_id)

  // The parts when there are any; otherwise the monthly gross the salary
  // import set, which is what the payroll run pays in that case.
  const monthly = (r: Row) => {
    const parts = r.items.filter((i) => i.kind === 'earning').reduce((a, i) => a + i.amount_paise, 0)
    return parts > 0 ? parts : Number(r.ctc_paise) || 0
  }

  const grossPaise = rupeesToPaise(gross || 0)
  const split = splitSalary(components, lines, grossPaise, rest)
  const splitTotal = earned(components, split)

  const inRange = (r: Row) => {
    const m = monthly(r)
    const lo = rupeesToPaise(rule.from || 0)
    const hi = rule.to.trim() === '' ? Infinity : rupeesToPaise(rule.to)
    return r.structure_id != null && m > 0 && m >= lo && m <= hi
  }
  const ruleRows = rows.filter(inRange)
  const ruleReady = components.some((c) => typed(c) && Number(rule.lines[c.id]?.val) > 0)
  const sample = ruleRows[0]
  const sampleSplit = sample ? splitSalary(components, rule.lines, monthly(sample), rule.rest) : {}

  const applyRule = async () => {
    if (!confirm(`Split the salary of ${ruleRows.length} staff by this rule? Each keeps the same gross and start date.`)) return
    let n = 0
    try {
      for (const r of ruleRows) {
        n++
        setApplying(`Saving ${n} of ${ruleRows.length}...`)
        await post(r.employee_id, r.effective_from ?? today(), rule.lines, splitSalary(components, rule.lines, monthly(r), rule.rest))
      }
      setDone(`${ruleRows.length} salaries split by the rule. The next payroll run pays these amounts.`)
    } catch (e) {
      setDone(`Stopped after ${n - 1} of ${ruleRows.length}: ${e instanceof Error ? e.message : 'could not save'}`)
    } finally {
      setApplying('')
      refresh()
    }
  }

  return (
    <>
      <PageHead
        eyebrow="Payroll"
        title="Salary setup"
        description="What each member of staff is paid, and the components a payslip is built from. Payroll can only pay somebody who has a salary set here."
      />
      <PageBody>
        {done && <FormNotice ok={done} />}
        {(save.error || addStarters.error) && (
          <FormNotice error={save.error ?? addStarters.error} />
        )}

        <CellGrid cols={3}>
          <Stat label="Staff with a salary set" value={rows.length - unpaid.length} />
          <Stat
            label="Nobody has set a salary for"
            value={unpaid.length}
            hint={unpaid.length ? 'They are left out of every payroll run' : 'Everyone is covered'}
          />
          <Stat label="Pay components" value={components.length} />
        </CellGrid>

        {components.length === 0 ? (
          <Card>
            <CardHeader
              title="Start with the usual components"
              description="Basic, dearness allowance, HRA, conveyance, special allowance, provident fund, professional tax and TDS, the vocabulary an Indian school payslip is written in. Rename or add to them afterwards; nothing is created until you ask."
              action={
                <Button onClick={() => addStarters.mutate()} disabled={addStarters.isPending}>
                  Set these up for me
                </Button>
              }
            />
            <Table head={['Code', 'Name', 'Type']}>
              {(comps.data?.suggested ?? []).map((c) => (
                <tr key={c.code}>
                  <Td className="font-mono text-[12px]">{c.code}</Td>
                  <Td>{c.name}</Td>
                  <Td>
                    <Badge tone={c.kind === 'earning' ? 'success' : 'neutral'}>
                      {c.kind === 'earning' ? 'added to pay' : 'taken off'}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        ) : (
          <Card>
            <CardHeader
              title="Pay components"
              description="The lines every payslip is built from."
            />
            <div className="flex flex-wrap gap-2 px-[var(--card-pad)] py-3">
              {components.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1">
                  <Badge tone={c.kind === 'earning' ? 'success' : 'neutral'}>
                    {c.name}
                    {c.is_percent && c.percent_of ? ` (% of ${c.percent_of})` : ''}
                  </Badge>
                  <button
                    type="button"
                    title={`Remove ${c.name}`}
                    disabled={delComponent.isPending}
                    onClick={() => { if (confirm(`Remove the ${c.name} pay component?`)) delComponent.mutate(c.id) }}
                    className="rounded px-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Who is paid what"
            description={
              unpaid.length
                ? `${unpaid.length} of ${rows.length} have no salary set, so payroll skips them.`
                : 'Everybody on the staff roll has a salary set.'
            }
          />
          <Table
            head={['Code', 'Name', 'Monthly pay', 'From', '']}
            empty={rows.length === 0}
            emptyLabel="Nobody on the staff roll yet."
          >
            {rows.map((r) => (
              <tr key={r.employee_id}>
                <Td className="font-mono text-[12px]">{r.employee_code}</Td>
                <Td className="font-medium">{r.full_name}</Td>
                <Td>
                  {r.structure_id ? (
                    formatPaise(monthly(r))
                  ) : (
                    /* Said as a consequence, not as a blank. "—" in this column
                       is exactly the state that kept somebody out of payroll
                       without anybody noticing. */
                    <Badge tone="warning">not set, will not be paid</Badge>
                  )}
                </Td>
                <Td className="text-muted-foreground">{r.effective_from ?? '-'}</Td>
                <Td>
                  <Button
                    size="sm"
                    variant={r.structure_id ? 'ghost' : 'primary'}
                    onClick={() => {
                      setOpen(open === r.employee_id ? null : r.employee_id)
                      setFrom(r.effective_from ?? today())
                      setGross(monthly(r) ? String(monthly(r) / 100) : '')
                      setRest(false)
                      const seed: Lines = {}
                      for (const i of r.items) {
                        const c = components.find((x) => x.id === i.component_id)
                        seed[i.component_id] =
                          i.percent != null && i.percent > 0
                            ? { mode: c?.is_percent && c.percent_of === 'BASIC' ? 'pb' : 'pg', val: String(i.percent) }
                            : { mode: 'amt', val: String(i.amount_paise / 100) }
                      }
                      setLines(seed)
                    }}
                    disabled={components.length === 0}
                  >
                    {r.structure_id ? 'Revise' : 'Set salary'}
                  </Button>
                  {r.structure_id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={delStructure.isPending}
                      onClick={() => {
                        if (confirm(`Delete ${r.full_name}'s current salary? Their pay history is kept; this removes the active revision.`))
                          delStructure.mutate(r.structure_id!)
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {open && (
          <Card>
            <CardHeader
              title={`Salary for ${rows.find((r) => r.employee_id === open)?.full_name ?? ''}`}
              description="Type each part in rupees, or as a percent of the gross or of Basic. Payroll pays the amounts in the last column."
            />
            <FormGrid>
              <Field label="Applies from" hint="Pay before this date is untouched.">
                <Input type="date" value={from} onChange={setFrom} />
              </Field>
              <Field label="Monthly gross (₹)" hint="What a percent of gross is taken from.">
                <Input type="number" value={gross} onChange={setGross} placeholder="0" />
              </Field>
            </FormGrid>
            <LineInputs comps={components} lines={lines} setLines={setLines} split={split} />
            {/* ON THE CARD'S OWN PADDING (owner, 2026-10-13): the table runs
                the full width and pads its own cells, so these rows pad themselves. */}
            <div className="flex flex-wrap items-center gap-3 px-[var(--card-pad)] py-3">
              <label className="inline-flex items-center gap-2 text-[13px]">
                <input id="salary-rest" type="checkbox" checked={rest} onChange={(e) => setRest(e.target.checked)} />
                Put whatever is left of the gross into Special allowance
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3 px-[var(--card-pad)] py-3">
              <Button onClick={() => save.mutate({ employee_id: open, split })} disabled={save.isPending || splitTotal <= 0}>
                Save this salary
              </Button>
              <span className="text-[13px] text-muted-foreground">
                Adds up to {formatPaise(splitTotal)} a month before deductions
                {grossPaise > 0 && splitTotal !== grossPaise
                  ? `, ${formatPaise(Math.abs(grossPaise - splitTotal))} ${splitTotal < grossPaise ? 'short of' : 'over'} the gross`
                  : ''}
                .
              </span>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Split salaries by range"
            description="One rule for everyone whose monthly gross falls in a range, for example Basic 50% of gross, HRA 40% of Basic, the rest as Special allowance. Each person keeps their gross; only the split changes."
          />
          <FormGrid>
            <Field label="Gross from (₹)">
              <Input type="number" value={rule.from} onChange={(v) => setRule((r) => ({ ...r, from: v }))} placeholder="0" />
            </Field>
            <Field label="Gross up to (₹)" hint="Leave empty for no upper limit.">
              <Input type="number" value={rule.to} onChange={(v) => setRule((r) => ({ ...r, to: v }))} placeholder="no limit" />
            </Field>
          </FormGrid>
          <LineInputs
            comps={components}
            lines={rule.lines}
            setLines={(f) => setRule((r) => ({ ...r, lines: f(r.lines) }))}
            split={sampleSplit}
          />
          <div className="flex flex-wrap items-center gap-3 px-[var(--card-pad)] py-3">
            <label className="inline-flex items-center gap-2 text-[13px]">
              <input id="rule-rest" type="checkbox" checked={rule.rest} onChange={(e) => setRule((r) => ({ ...r, rest: e.target.checked }))} />
              Put whatever is left of the gross into Special allowance
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3 px-[var(--card-pad)] py-3">
            <Button onClick={applyRule} disabled={!!applying || !ruleReady || ruleRows.length === 0}>
              {applying || `Apply to ${ruleRows.length} staff`}
            </Button>
            <span className="text-[13px] text-muted-foreground">
              {sample ? `"Comes to" shows ${sample.full_name} (gross ${formatPaise(monthly(sample))}).` : 'Nobody with a salary falls in this range.'}
            </span>
          </div>
        </Card>

        <div className="mt-2">
          <BulkImport
            entity="staff_payroll"
            title="Bank details and salary from a sheet"
            hint="One row per person: staff code, name, bank account, IFSC and gross salary. Sets the account and IFSC on the staff record and records the gross as their standing salary. Matched by staff code, so import your staff first."
            onDone={refresh}
          />
        </div>
        {/* The school's own salary sheet, the same columns as the School format download (Yajur, 2026-10-13). */}
        <div className="mt-2">
          <BulkImport
            entity="salary_sheet"
            title="Salary sheet (school format)"
            hint="Your salary register as a CSV: Employee ID, Employee Name, Designation, Mobile Number, Subject, Date of Joining, Bank Account Number, IFSC, Aadhaar, PAN, UAN, Basic, House Rent Allowance, Dearness Allowance, Conveyance Allowance, Other Allowance. Fills each staff record and sets the monthly salary from the five pay parts. Gross, EPF, ESI and net are worked out by the payroll run."
            onDone={refresh}
          />
        </div>
      </PageBody>
    </>
  )
}
