import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Textarea, Loading, ErrorState, FormNotice, PrintButton,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { cn } from '@/lib/utils'
import { adminOpsBase, inr, kg, toPaise, type MDMUtilisation as Util } from './admin-ops-lib'

/* The monthly PM POSHAN utilisation return.
 *
 * The daily register (mdm_registers, from the Telangana migration) is the
 * source. Nothing on this screen is stored except the four things aggregation
 * cannot know — the opening balances, what the government sanctioned, what it
 * actually released, and the school's explanation of any gap. Everything else
 * is summed live, so the return and the register can never drift apart.
 *
 * The checks are the reason to open this rather than a spreadsheet. A return
 * that merely adds up gets sent back; the block office asks whether meals were
 * served on every working day, whether the grain consumed matches the children
 * fed at the per-child norm, and whether the balance carried forward is
 * possible. Those questions are answered here, before filing, instead of six
 * weeks later in a letter.
 *
 * Foodgrain is kilograms and cooking cost is paise, kept in separate columns
 * all the way down. A schema that put rice in a money column would eventually
 * report 100 g as a rupee value, and this screen would faithfully print it.
 */

const SEVERITY: Record<string, 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  warn: 'warning',
  fail: 'danger',
}

function thisMonth(): string {
  const n = new Date()
  const prev = new Date(n.getFullYear(), n.getMonth() - 1, 1)
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
}

export default function MDMUtilisation() {
  const qc = useQueryClient()
  const can = useCan()
  const mayFile = can('institution.write')

  const [month, setMonth] = useState(thisMonth())
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)

  const util = useQuery({
    queryKey: ['admin-ops', 'mdm', 'utilisation', month],
    queryFn: () => api.get<Util>(`${adminOpsBase}/mdm/utilisation?month=${month}`),
  })

  const finalise = useMutation({
    mutationFn: () => api.post(`${adminOpsBase}/mdm/returns/${util.data!.return.id}/finalise`, {
      figures: {
        month: util.data!.month,
        meals: util.data!.meals,
        foodgrain: util.data!.foodgrain,
        cooking_cost_paise: util.data!.cooking_cost_paise,
        roll: util.data!.roll,
        checks: util.data!.checks,
      },
    }),
    onSuccess: () => {
      setNote('Finalised. The figures are frozen — this month will read the same in November as it does today.')
      qc.invalidateQueries({ queryKey: ['admin-ops', 'mdm'] })
    },
  })

  const reopen = useMutation({
    mutationFn: (reason: string) =>
      api.post(`${adminOpsBase}/mdm/returns/${util.data!.return.id}/reopen`, { reason }),
    onSuccess: () => {
      setNote('Reopened. The reason is on the record.')
      qc.invalidateQueries({ queryKey: ['admin-ops', 'mdm'] })
    },
  })

  const d = util.data
  const failures = d?.checks.filter((c) => c.severity === 'fail') ?? []
  const warnings = d?.checks.filter((c) => c.severity === 'warn') ?? []
  const flaggedDays = d?.days.filter((x) => x.issues.length > 0) ?? []
  const status = d?.return.status ?? ''
  const frozen = status === 'finalised' || status === 'filed'

  return (
    <>
      <PageHead
        eyebrow="Mid-day meal"
        title="MDM utilisation report"
        description="The monthly return under PM POSHAN: meals served against enrolment, foodgrain consumed against what was lifted, cooking cost against what was allotted, and the balance carried forward."
      />
      <PageBody>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="text-muted-foreground">Month</span>
            <Input value={month} onChange={setMonth} type="month" />
          </label>
          <PrintButton label="Print the return" />
          {mayFile && d && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(!editing)}>
              {editing ? 'Close' : 'Balances and allotment'}
            </Button>
          )}
        </div>

        <FormNotice error={finalise.error ?? reopen.error} ok={note} />

        {util.isLoading ? <Loading /> : util.error ? <ErrorState error={util.error} /> : d && (
          <>
            {editing && mayFile && (
              <BalancesForm
                month={month}
                onSaved={(m) => {
                  setEditing(false); setNote(m)
                  qc.invalidateQueries({ queryKey: ['admin-ops', 'mdm'] })
                }}
              />
            )}

            <CellGrid cols={4}>
              <Stat label="Meals served" value={d.meals.total.toLocaleString('en-IN')} />
              <Stat
                label="Serving days"
                value={`${d.meals.serving_days} of ${d.meals.working_days}`}
                hint={d.meals.serving_days >= d.meals.working_days
                  ? 'Every working day'
                  : `${d.meals.working_days - d.meals.serving_days} days without a meal`}
              />
              <Stat label="Average on roll" value={d.meals.avg_enrolment}
                hint={`${d.meals.avg_present} present on an average day`} />
              <Stat label="Cooking cost spent" value={inr(d.cooking_cost_paise.spent)} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Checks"
                description="What the block office will ask. Answer these before filing, not after it comes back."
              />
              <Table head={['', 'Check', 'What the figures say']}>
                {d.checks.map((c) => (
                  <tr key={c.code}>
                    <Td>
                      <Badge tone={SEVERITY[c.severity] ?? 'neutral'}>
                        {c.severity === 'ok' ? 'ok' : c.severity === 'warn' ? 'check' : 'fix'}
                      </Badge>
                    </Td>
                    <Td className="font-medium">{c.label}</Td>
                    <Td className="text-muted-foreground">{c.detail}</Td>
                  </tr>
                ))}
              </Table>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader
                  title={`Foodgrain — ${d.foodgrain.grain}`}
                  description="Weight, in kilograms. Deliberately never mixed with the money columns."
                />
                <Table head={['', 'Quantity']}>
                  <tr><Td>Opening balance</Td><Td className="tabular-nums">{kg(d.foodgrain.opening_kg)}</Td></tr>
                  <tr><Td>Allotted</Td><Td className="tabular-nums">{kg(d.foodgrain.allotted_kg)}</Td></tr>
                  <tr><Td>Lifted this month</Td><Td className="tabular-nums">{kg(d.foodgrain.lifted_kg)}</Td></tr>
                  <tr><Td>Consumed</Td><Td className="tabular-nums">{kg(d.foodgrain.consumed_kg)}</Td></tr>
                  <tr className="font-medium">
                    <Td>Closing balance</Td>
                    <Td className={cn('tabular-nums', d.foodgrain.closing_kg < 0 && 'text-destructive')}>
                      {kg(d.foodgrain.closing_kg)}
                    </Td>
                  </tr>
                </Table>
              </Card>

              <Card>
                <CardHeader
                  title="Cooking cost"
                  description="Money, in rupees. Every figure is exact paise underneath."
                />
                <Table head={['', 'Amount']}>
                  <tr><Td>Opening balance</Td><Td className="tabular-nums">{inr(d.cooking_cost_paise.opening)}</Td></tr>
                  <tr><Td>Allotted</Td><Td className="tabular-nums">{inr(d.cooking_cost_paise.allotted)}</Td></tr>
                  <tr><Td>Released</Td><Td className="tabular-nums">{inr(d.cooking_cost_paise.released)}</Td></tr>
                  <tr><Td>Spent</Td><Td className="tabular-nums">{inr(d.cooking_cost_paise.spent)}</Td></tr>
                  <tr className="font-medium">
                    <Td>Closing balance</Td>
                    <Td className={cn('tabular-nums', d.cooking_cost_paise.closing < 0 && 'text-destructive')}>
                      {inr(d.cooking_cost_paise.closing)}
                    </Td>
                  </tr>
                </Table>
              </Card>
            </div>

            <Card>
              <CardHeader
                title="Day by day"
                description={flaggedDays.length
                  ? `${flaggedDays.length} day(s) need attention — those are shown first.`
                  : 'Every recorded day ties out.'}
              />
              <Table
                head={['Date', 'On roll', 'Present', 'Meals', d.foodgrain.grain, 'Cost', 'Menu', '']}
                empty={!d.days.length}
                emptyLabel="Nothing recorded in the register for this month."
              >
                {[...d.days]
                  .sort((a, b) => b.issues.length - a.issues.length)
                  .map((x) => (
                    <tr key={x.on_date}>
                      <Td className="tabular-nums">{x.on_date}</Td>
                      <Td className="tabular-nums text-muted-foreground">{x.enrolled}</Td>
                      <Td className="tabular-nums text-muted-foreground">{x.present}</Td>
                      <Td className={cn('tabular-nums', x.issues.length && 'font-medium text-destructive')}>
                        {x.meals_served}
                      </Td>
                      <Td className="tabular-nums">{x.rice_kg ? `${x.rice_kg}` : '—'}</Td>
                      <Td className="tabular-nums">{inr(x.cost_paise)}</Td>
                      <Td className="text-muted-foreground">{x.menu ?? '—'}</Td>
                      <Td>
                        {x.issues.map((i) => (
                          <span key={i} className="block text-[12px] text-destructive">{i}</span>
                        ))}
                      </Td>
                    </tr>
                  ))}
              </Table>
            </Card>

            {d.return.id && mayFile && (
              <Card>
                <CardHeader
                  title="File the return"
                  description={frozen
                    ? 'This month is frozen. What was filed stays retrievable exactly as filed.'
                    : 'Finalising freezes a copy of these figures. Later edits to the daily register will not change it.'}
                />
                <div className="space-y-3 px-5 py-4">
                  {!frozen && failures.length > 0 && (
                    <p className="text-[13px] text-destructive">
                      {failures.length} check{failures.length === 1 ? '' : 's'} still failing.
                      A return filed over these is a return that comes back.
                    </p>
                  )}
                  {!frozen && !failures.length && warnings.length > 0 && (
                    <p className="text-[13px] text-muted-foreground">
                      {warnings.length} thing{warnings.length === 1 ? '' : 's'} worth explaining in the
                      variance note before filing.
                    </p>
                  )}
                  {frozen ? (
                    <ReopenBox pending={reopen.isPending} onReopen={(r) => reopen.mutate(r)} />
                  ) : (
                    <Button disabled={finalise.isPending} onClick={() => finalise.mutate()}>
                      {finalise.isPending ? 'Finalising…' : 'Finalise and freeze'}
                    </Button>
                  )}
                </div>
              </Card>
            )}

            {!d.return.id && (
              <Card>
                <CardHeader
                  title="No return opened for this month"
                  description="The figures above are computed from the register and are correct. Opening a return lets you record the opening balances and the sanctioned allotment, which nothing can derive."
                />
              </Card>
            )}
          </>
        )}
      </PageBody>
    </>
  )
}

function ReopenBox({ pending, onReopen }: { pending: boolean; onReopen: (r: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <>
      <label className="flex max-w-lg flex-col gap-1.5 text-[13px]">
        <span className="text-muted-foreground">
          Reopening a filed return needs a reason, and the reason stays on the record
        </span>
        <Textarea value={reason} onChange={setReason} rows={2} />
      </label>
      <Button variant="secondary" disabled={pending || !reason.trim()}
        onClick={() => onReopen(reason.trim())}>
        {pending ? 'Reopening…' : 'Reopen'}
      </Button>
    </>
  )
}

function BalancesForm({ month, onSaved }: { month: string; onSaved: (m: string) => void }) {
  const [openingKg, setOpeningKg] = useState('')
  const [allottedKg, setAllottedKg] = useState('')
  const [openingCost, setOpeningCost] = useState('')
  const [allottedCost, setAllottedCost] = useState('')
  const [releasedCost, setReleasedCost] = useState('')
  const [explanation, setExplanation] = useState('')

  const save = useMutation({
    mutationFn: () => api.post(`${adminOpsBase}/mdm/returns`, {
      month,
      opening_grain_kg: Number(openingKg) || 0,
      allotted_grain_kg: Number(allottedKg) || 0,
      opening_cost_paise: toPaise(openingCost),
      allotted_cost_paise: toPaise(allottedCost),
      released_cost_paise: toPaise(releasedCost),
      variance_explanation: explanation.trim(),
    }),
    onSuccess: () => onSaved('Balances saved. The rest of the return is computed from the register.'),
  })

  return (
    <Card>
      <CardHeader
        title="Opening balances and sanction"
        description="The only figures on this return that aggregation cannot know. Everything else is summed from the daily register."
      />
      <div className="grid gap-4 p-5 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Opening foodgrain (kg)</span>
          <Input value={openingKg} onChange={setOpeningKg} placeholder="0.000" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Foodgrain allotted (kg)</span>
          <Input value={allottedKg} onChange={setAllottedKg} placeholder="0.000" />
        </label>
        <span />
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Opening cooking cost (₹)</span>
          <Input value={openingCost} onChange={setOpeningCost} placeholder="0" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Cooking cost allotted (₹)</span>
          <Input value={allottedCost} onChange={setAllottedCost} placeholder="0" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">Cooking cost released (₹)</span>
          <Input value={releasedCost} onChange={setReleasedCost} placeholder="0" />
        </label>
      </div>
      <div className="px-5 pb-5">
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-muted-foreground">
            Explanation for any gap — days without a meal, consumption off the norm
          </span>
          <Textarea value={explanation} onChange={setExplanation} rows={2} />
        </label>
      </div>
      <div className="border-t px-5 py-4">
        <FormNotice error={save.error} />
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Card>
  )
}
