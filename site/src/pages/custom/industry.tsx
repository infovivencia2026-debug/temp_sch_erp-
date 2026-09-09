import { useMemo, useState } from 'react'
import { Check, Download, GripVertical, Plus, Trash2, X } from 'lucide-react'
import {
  Badge, Button, Card, Field, Input, Select, Tabs, Toggle, useToast,
} from '@/components/ui'
import { AreaTrend, BarSeries, Donut, LineSeries, RadarSpread } from '@/components/charts'
import { useApp } from '@/hooks/useAppState'
import { modulesForRole } from '@/industries'
import { cx } from '@/lib/utils'
import { Panel, StatRow } from './shared'

/* ---------------------------------------------------------------------------
   Cross-industry custom views. These read the active industry's dashboard
   config, so one implementation serves construction, logistics, healthcare and
   manufacturing without any per-vertical branching.
   --------------------------------------------------------------------------- */

/** Analytics workspace — the dashboard's series, sliced by the reader. */
export function IndustryAnalytics() {
  const app = useApp()
  const toast = useToast()
  const cfg = app.industry.dashboard
  const [tab, setTab] = useState('Executive')
  const TABS = ['Executive', 'Operations', 'Finance', 'People', 'Quality']

  if (!cfg) return null

  return (
    <div className="space-y-10">
      <Tabs value={tab} onChange={setTab} tabs={TABS.map((t) => ({ id: t, label: t }))} />

      <div className="flex flex-wrap gap-2">
        <Select className="w-auto" options={app.industry.scope.periods} />
        <Select className="w-auto" options={[`All ${app.industry.scope.siteLabel.toLowerCase()}s`, ...app.industry.scope.sites]} />
        <Select className="w-auto" options={['All departments', ...app.industry.vocab.dept.slice(0, 8)]} />
        <Button size="sm" className="ml-auto" icon={Download}
          onClick={() => toast({ title: 'Export queued', desc: `${app.industryId}-${tab.toLowerCase()}-analytics.pdf`, tone: 'success' })}>
          Export
        </Button>
        <Button size="sm" onClick={() => toast({ title: 'Report saved', desc: 'Available under saved reports.', tone: 'success' })}>Save report</Button>
      </div>

      <StatRow
        items={cfg.kpis.slice(0, 4).map((k) => ({ label: k.label, value: k.value, sub: `${k.delta} vs last month` }))}
      />

      {tab === 'Executive' && (
        <>
          <div className="grid gap-6 xl:grid-cols-3">
            <Panel title={cfg.trend.title} subtitle={cfg.trend.subtitle} className="xl:col-span-2">
              <div className="p-4"><AreaTrend data={cfg.trend.data} keys={cfg.trend.keys} height={260} /></div>
            </Panel>
            <Panel title={cfg.mix.title} subtitle={cfg.mix.subtitle}>
              <div className="p-4"><Donut data={cfg.mix.data} height={260} /></div>
            </Panel>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title={cfg.money.title} subtitle={cfg.money.subtitle}>
              <div className="p-4"><LineSeries data={cfg.money.data} keys={cfg.money.keys} /></div>
            </Panel>
            <Panel title={cfg.ranking.title} subtitle={cfg.ranking.subtitle}>
              <div className="p-4"><RadarSpread data={cfg.ranking.rows.map((r) => ({ name: r.name, value: r.value }))} /></div>
            </Panel>
          </div>
        </>
      )}

      {tab !== 'Executive' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title={cfg.funnel.title} subtitle={cfg.funnel.subtitle}>
            <div className="p-4"><BarSeries data={cfg.funnel.data} keys={cfg.funnel.keys} height={260} /></div>
          </Panel>
          <Panel title={cfg.trend.title} subtitle={`${tab} view · ${cfg.trend.subtitle}`}>
            <div className="p-4"><AreaTrend data={cfg.trend.data} keys={cfg.trend.keys} height={260} /></div>
          </Panel>
          <Panel title={cfg.progress.title} subtitle={cfg.progress.subtitle} className="lg:col-span-2">
            <div className="p-4">
              <BarSeries
                horizontal
                data={cfg.progress.rows.map((r) => ({ name: r.name, value: Math.round((r.done / r.total) * 100) }))}
                keys={[{ key: 'value', label: '% complete' }]}
                height={240}
              />
            </div>
          </Panel>
        </div>
      )}
    </div>
  )
}

/** Ad-hoc report builder — pick a module, pick fields, preview the shape. */
export function ReportBuilder() {
  const app = useApp()
  const toast = useToast()
  const mods = modulesForRole(app.role).filter((m) => m.tabs.some((t) => t.cols?.length))
  const [moduleId, setModuleId] = useState(mods[0]?.id ?? '')
  const mod = mods.find((m) => m.id === moduleId) ?? mods[0]
  const tabsWithCols = mod?.tabs.filter((t) => t.cols?.length) ?? []
  const [tabId, setTabId] = useState(tabsWithCols[0]?.id ?? '')
  const tab = tabsWithCols.find((t) => t.id === tabId) ?? tabsWithCols[0]

  const fields = useMemo(
    () => (tab?.cols ?? []).map((spec) => spec.split('@')[0].split(':')[1]),
    [tab],
  )
  const [chosen, setChosen] = useState<string[]>([])
  const picked = chosen.length ? chosen : fields.slice(0, 5)

  const toggle = (f: string) =>
    setChosen((c) => (c.includes(f) ? c.filter((x) => x !== f) : [...(c.length ? c : fields.slice(0, 5)), f]))

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="p-6">
        <p className="text-[13px] font-semibold">Source</p>
        <div className="mt-4 space-y-3">
          <Field label="Module">
            <Select
              options={mods.map((m) => m.label)}
              value={mod?.label ?? ''}
              onChange={(e) => {
                const next = mods.find((m) => m.label === e.target.value)
                if (!next) return
                setModuleId(next.id)
                setTabId(next.tabs.find((t) => t.cols?.length)?.id ?? '')
                setChosen([])
              }}
            />
          </Field>
          <Field label="Dataset">
            <Select
              options={tabsWithCols.map((t) => t.label)}
              value={tab?.label ?? ''}
              onChange={(e) => {
                const next = tabsWithCols.find((t) => t.label === e.target.value)
                if (next) { setTabId(next.id); setChosen([]) }
              }}
            />
          </Field>
          <Field label="Grouping"><Select options={['None', 'By status', 'By department', 'By month']} /></Field>
          <Field label="Chart"><Select options={['Table only', 'Bar', 'Line', 'Donut']} /></Field>
        </div>
        <div className="mt-5 flex items-center justify-between rounded-lg hairline px-3 py-2.5">
          <span className="text-[12px]">Schedule this report</span>
          <Toggle checked={false} onChange={() => toast({ title: 'Scheduling is mocked in the prototype', tone: 'info' })} />
        </div>
      </Card>

      <Card className="p-6">
        <p className="text-[13px] font-semibold">Fields</p>
        <p className="mt-1 text-[11px] muted">{picked.length} selected of {fields.length}</p>
        <div className="mt-4 space-y-1">
          {fields.map((f) => (
            <button
              key={f}
              onClick={() => toggle(f)}
              className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]',
                picked.includes(f) ? 'bg-accent' : 'hover:bg-accent/50')}
            >
              <GripVertical className="h-3.5 w-3.5 muted" />
              <span className="truncate">{f}</span>
              {picked.includes(f) ? <Check className="ml-auto h-3.5 w-3.5 text-primary" /> : <Plus className="ml-auto h-3.5 w-3.5 muted" />}
            </button>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <p className="text-[13px] font-semibold">Preview</p>
        <p className="mt-1 text-[11px] muted">{mod?.label} › {tab?.label}</p>
        <div className="mt-4 space-y-2">
          {picked.map((f) => (
            <div key={f} className="flex items-center gap-2 rounded-lg hairline px-3 py-2 text-[12px]">
              <span className="truncate">{f}</span>
              <button className="ml-auto muted hover:text-foreground" onClick={() => toggle(f)}><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          {picked.length === 0 && <p className="text-[12px] muted">Pick a field to start.</p>}
        </div>
        <div className="mt-5 flex gap-2">
          <Button size="sm" className="flex-1" icon={Trash2} onClick={() => setChosen([])}>Clear</Button>
          <Button size="sm" variant="primary" className="flex-1"
            onClick={() => toast({ title: 'Report generated', desc: `${picked.length} fields from ${tab?.label}.`, tone: 'success' })}>
            Run
          </Button>
        </div>
      </Card>
    </div>
  )
}

/** Role matrix — which roles reach which modules in this vertical. */
export function IndustryRoleMatrix() {
  const app = useApp()
  const roles = app.industry.roles
  const mods = app.industry.modules

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-[13px] leading-relaxed muted">
        Access is defined once per role in the registry. A tick means the role sees that module in
        its sidebar and command palette; everything else is not merely hidden, it is absent.
      </p>
      <div className="overflow-x-auto rounded-lg hairline">
        <table className="w-full min-w-[720px] text-left text-[12px]">
          <thead>
            <tr className="border-b">
              <th className="px-4 py-3 font-medium">Module</th>
              {roles.map((r) => (
                <th key={r.id} className="px-3 py-3 text-center font-medium">
                  <span className="block truncate">{r.label}</span>
                  <span className="block text-[10px] font-normal muted">{r.scope}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {mods.map((m) => (
              <tr key={m.id} className="hover:bg-accent/40">
                <td className="px-4 py-2.5">
                  <span className="font-medium">{m.label}</span>
                  <span className="ml-2 text-[10px] muted">{m.group}</span>
                </td>
                {roles.map((r) => {
                  const allowed = r.modules === '*' || (r.modules as string[]).includes(m.id)
                  return (
                    <td key={r.id} className="px-3 py-2.5 text-center">
                      {allowed
                        ? <Check className="mx-auto h-3.5 w-3.5 text-primary" />
                        : <span className="muted">—</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        {roles.map((r) => (
          <Badge key={r.id} tone={r.modules === '*' ? 'violet' : 'slate'}>
            {r.label} · {r.modules === '*' ? 'all modules' : `${(r.modules as string[]).length} modules`}
          </Badge>
        ))}
      </div>
    </div>
  )
}
