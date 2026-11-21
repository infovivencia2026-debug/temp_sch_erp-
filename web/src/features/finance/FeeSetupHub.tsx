import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Select, ErrorState, SkeletonTable, PrintButton, Button, TAB_BAR, tabClass, Field, Input, FormNotice } from '@/components/ui'
import { useToast } from '@/components/Toast'
import { formatPaise, formatDate, cn } from '@/lib/utils'
import { useFeatureHref } from '@/features/bento/bento-kit'

/* FEE SETUP AND NEXT YEAR, from the counter (owner's preview, 2026-11-21).
   What the school charges, read here in one place. Changes are made on the
   setup screens that already do them (Class & transport fee setup, Year
   rollover, Class promotion), which the buttons open, so there is one way
   to edit each thing. */

interface Setup {
  year_id: string
  years: { id: string; name: string; is_current: number }[]
  plans: { id: string; name: string; class_name: string; is_active: number; students: number; items: { fee_type: string; instalment_no: number; amount_paise: number; due_on: string | null }[] }[]
}
interface Head { id: string; name: string; code: string; is_recurring: boolean; optional: boolean; used_in: number; chosen_by: number }
interface Rule { id: string; name: string; fee_head?: string; fee_structure?: string; kind: string; grace_days: number; amount_paise: number; percent: string | null; cap_paise: number | null; is_active: boolean }

export default function FeeSetupHub() {
  const [year, setYear] = useState('')
  const [tab, setTab] = useState<'plans' | 'types' | 'instalments' | 'transport' | 'fines' | 'next'>('plans')
  const setup = useQuery({ queryKey: ['fee-hub-setup', year], queryFn: () => api.get<Setup>(`/api/v1/fees/hub/setup${year ? `?year=${year}` : ''}`) })
  const heads = useQuery({ queryKey: ['fee-heads'], queryFn: () => api.get<{ items: Head[] }>('/api/v1/setup/fee-heads') })
  const rules = useQuery({ queryKey: ['fine-rules'], queryFn: () => api.get<{ items: Rule[] }>('/api/v1/finance/fee-engine/fine-rules') })
  const setupHref = useFeatureHref('finance.fees.class_transport_fee_setup')
  const rolloverHref = useFeatureHref('institution_admin.academics.year_rollover')
  const promoteHref = useFeatureHref('institution_admin.students.class_promotion')
  const routesHref = useFeatureHref('operations.transport.vehicles_routes')
  const navigate = useNavigate()
  const go = (href: string) => navigate(href)
  const s = setup.data
  const plans = s?.plans ?? []
  const transport = plans.filter((p) => p.items.some((i) => /transport|bus|route/i.test(i.fee_type)))
  const total = (p: Setup['plans'][number]) => p.items.reduce((a, i) => a + i.amount_paise, 0)
  const edit = setupHref ? <Button size="sm" variant="outline" onClick={() => go(setupHref)}>Edit on Class & transport fee setup</Button> : null
  return (
    <Card>
      <CardHeader title="Fee setup & next year" action={
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-52"><Select value={year || s?.year_id || ''} onChange={setYear} options={(s?.years ?? []).map((y) => ({ value: y.id, label: y.name + (Number(y.is_current) ? ' (current)' : '') }))} /></div>
          <PrintButton scope="card" title="Fee setup" />
        </div>
      } />
      <div className={cn(TAB_BAR, 'px-[var(--card-pad)]')} role="tablist">
        {([['plans', 'Fee plans (class wise)'], ['types', 'Fee types'], ['instalments', 'Instalments & due dates'], ['transport', 'Transport plans'], ['fines', 'Fine rules'], ['next', 'Next year']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tabClass(tab === k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {setup.error ? <ErrorState error={setup.error} onRetry={() => setup.refetch()} /> : setup.isLoading ? <SkeletonTable columns={5} /> : (
        <>
          {tab === 'plans' && (
            <Table head={['Class', 'Plan', 'Fee types', 'Amount', 'Instalments', 'Students billed', 'Status']} empty={!plans.length} emptyLabel="No fee plans for this year.">
              {plans.map((p) => (
                <tr key={p.id}><Td>{p.class_name}</Td><Td className="font-medium">{p.name}</Td><Td className="min-w-[10rem]">{[...new Set(p.items.map((i) => i.fee_type))].join(', ')}</Td>
                  <Td className="tabular-nums">{formatPaise(total(p))}</Td><Td>{new Set(p.items.map((i) => i.instalment_no)).size}</Td><Td>{p.students}</Td>
                  <Td><Badge tone={Number(p.is_active) ? 'success' : 'neutral'}>{Number(p.is_active) ? 'Active' : 'Off'}</Badge></Td></tr>
              ))}
            </Table>
          )}
          {tab === 'types' && (
            <Table head={['Fee type', 'Code', 'Regular / extra', 'Recurring', 'In plans', 'Opted in']} loading={heads.isLoading} empty={!heads.data?.items.length}>
              {(heads.data?.items ?? []).map((h) => (
                <tr key={h.id}><Td className="font-medium">{h.name}</Td><Td className="font-mono text-[12px]">{h.code}</Td><Td>{h.optional ? 'Extra (opt-in)' : 'Regular'}</Td>
                  <Td>{h.is_recurring ? 'Yes' : 'No'}</Td><Td>{h.used_in}</Td><Td>{h.optional ? h.chosen_by : '-'}</Td></tr>
              ))}
            </Table>
          )}
          {tab === 'instalments' && (
            <Table head={['Plan', 'Fee type', 'Instalment', 'Share', 'Amount', 'Due date']} empty={!plans.length} emptyLabel="No fee plans for this year.">
              {plans.flatMap((p) => p.items.map((i, k) => {
                const headTotal = p.items.filter((x) => x.fee_type === i.fee_type).reduce((a, x) => a + x.amount_paise, 0)
                return (
                  <tr key={`${p.id}-${k}`}><Td className="font-medium">{p.name}</Td><Td>{i.fee_type}</Td><Td>{i.instalment_no}</Td>
                    <Td>{headTotal ? `${Math.round((i.amount_paise * 100) / headTotal)}%` : '-'}</Td><Td className="tabular-nums">{formatPaise(i.amount_paise)}</Td><Td className="whitespace-nowrap">{formatDate(i.due_on)}</Td></tr>
                )
              }))}
            </Table>
          )}
          {tab === 'transport' && (
            <>
              <Table head={['Plan', 'Class', 'Yearly', 'Instalments', 'Students billed']} empty={!transport.length} emptyLabel="No transport plan for this year. Bus fares by stop are set on the routes screen.">
                {transport.map((p) => (
                  <tr key={p.id}><Td className="font-medium">{p.name}</Td><Td>{p.class_name}</Td><Td className="tabular-nums">{formatPaise(total(p))}</Td><Td>{new Set(p.items.map((i) => i.instalment_no)).size}</Td><Td>{p.students}</Td></tr>
                ))}
              </Table>
              {routesHref && <div className="px-[var(--card-pad)] pb-4"><Button size="sm" variant="outline" onClick={() => go(routesHref)}>Routes and stop fares</Button></div>}
            </>
          )}
          {tab === 'fines' && (
            <Table head={['Rule', 'Applies to', 'After due by', 'Fine', 'Maximum', 'Status']} loading={rules.isLoading} empty={!rules.data?.items.length} emptyLabel="No late fee rules.">
              {(rules.data?.items ?? []).map((r) => (
                <tr key={r.id}><Td className="font-medium">{r.name}</Td><Td>{r.fee_head || r.fee_structure || 'All fees'}</Td><Td>{r.grace_days} day{r.grace_days === 1 ? '' : 's'}</Td>
                  <Td className="whitespace-nowrap">{r.kind === 'percent' ? `${r.percent}%` : `${formatPaise(r.amount_paise)}${r.kind === 'per_day' ? ' / day' : ''}`}</Td>
                  <Td className="tabular-nums">{r.cap_paise !== null ? formatPaise(r.cap_paise) : '-'}</Td><Td><Badge tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'On' : 'Off'}</Badge></Td></tr>
              ))}
            </Table>
          )}
          {tab === 'next' && (
            <Table head={['Step', 'What happens', '']} empty={false}>
              <tr><Td>1</Td><Td>Copy this year's fee plans to next year with an increase (below), then fine-tune amounts.</Td><Td>{edit}</Td></tr>
              <tr><Td>2</Td><Td>Start next year and move the classes on.</Td><Td>{rolloverHref && <Button size="sm" variant="outline" onClick={() => go(rolloverHref)}>Year rollover</Button>}</Td></tr>
              <tr><Td>3</Td><Td>Promote the students to their new class.</Td><Td>{promoteHref && <Button size="sm" variant="outline" onClick={() => go(promoteHref)}>Class promotion</Button>}</Td></tr>
              <tr><Td>4</Td><Td>Raise next year's fees. Unpaid bills from this year are carried onto the first new bill as arrears.</Td><Td>{edit}</Td></tr>
            </Table>
          )}
          {tab === 'next' && <CopyPlans years={s?.years ?? []} />}
          {tab !== 'next' && edit && <div className="px-[var(--card-pad)] pb-4">{edit}</div>}
        </>
      )}
    </Card>
  )
}

/* Copy plans to another year with a % increase (owner, 2026-11-21): preview first, then copy.
   A plan already in the target year (same name and class) is left alone. */
function CopyPlans({ years }: { years: Setup['years'] }) {
  const toast = useToast()
  const cur = years.find((y) => Number(y.is_current))?.id ?? ''
  const [from, setFrom] = useState(cur)
  const [to, setTo] = useState('')
  const [pct, setPct] = useState('8')
  type Row = { plan: string; class_name: string; skipped: boolean; old_paise: number; new_paise: number; instalments: number }
  const run = useMutation({
    mutationFn: (dry: boolean) => api.post<{ plans: Row[]; copied?: number }>('/api/v1/fees/hub/copy-plans', { from_year: from || cur, to_year: to, percent: Number(pct), dry_run: dry }),
    onSuccess: (r, dry) => { if (!dry) toast.ok(`Copied ${r.copied ?? 0} plan${r.copied === 1 ? '' : 's'}`) },
  })
  const opts = years.map((y) => ({ value: y.id, label: y.name }))
  return (
    <div className="space-y-3 border-t p-[var(--card-pad)]">
      <div className="text-[14px] font-semibold">Copy plans to another year</div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From year"><Select value={from || cur} onChange={setFrom} options={opts} /></Field>
        <Field label="To year"><Select value={to} onChange={setTo} placeholder="Choose" options={opts.filter((o) => o.value !== (from || cur))} /></Field>
        <Field label="Increase (%)"><Input value={pct} onChange={setPct} type="number" /></Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!to || run.isPending} onClick={() => run.mutate(true)}>Preview</Button>
        <Button needsNetwork disabled={!to || !run.data || run.isPending} onClick={() => run.mutate(false)}>Copy plans</Button>
      </div>
      <FormNotice error={run.error} />
      {run.data && (
        <Table head={['Plan', 'Class', 'Instalments', 'Now', 'After increase', '']} empty={!run.data.plans.length} emptyLabel="No plans in that year.">
          {run.data.plans.map((r, i) => (
            <tr key={i}><Td className="font-medium">{r.plan}</Td><Td>{r.class_name}</Td><Td>{r.instalments}</Td><Td className="tabular-nums">{formatPaise(r.old_paise)}</Td>
              <Td className="tabular-nums">{formatPaise(r.new_paise)}</Td><Td>{r.skipped && <Badge tone="neutral">Already there</Badge>}</Td></tr>
          ))}
        </Table>
      )}
    </div>
  )
}
