import { useState } from 'react'
import {
  Activity, AlertTriangle, BrainCircuit, Check, ChevronDown, Cloud, Database, Download, FileText,
  GripVertical, Link2, Lock, Plus, RefreshCw, Send, Server, Settings2, Sparkles, Trash2, Upload, Wand2, X,
} from 'lucide-react'
import {
  Avatar, Badge, Button, Card, CardHeader, Checkbox, Field, Input, Modal, Progress, Select,
  Tabs, Textarea, Toggle, useToast,
} from '@/components/ui'
import { DataTable } from '@/components/tables/DataTable'
import { AreaTrend, BarSeries, Donut, LineSeries, RadarSpread } from '@/components/charts'
import { makeRows, parseCols, personName } from '@/data/generator'
import { CAMPUSES, DEPARTMENTS, INSTITUTIONS, PROGRAMS } from '@/data/vocab'
import { admissionsTrend, attendanceTrend, campusComparison, revenueTrend, studentDistribution } from '@/data/dashboard'
import { cx, inrCompact, int, num, rng } from '@/lib/utils'
import { ModuleShell, Panel, StatRow, type ViewProps } from './shared'
import { useApp } from '@/hooks/useAppState'

/* ============================================================ Analytics */
const ANALYTICS_TABS = [
  'Executive', 'Admissions', 'Academics', 'Attendance', 'Finance', 'HR', 'Placements',
  'Library', 'Transport', 'Custom reports',
]

export function AnalyticsPage({ moduleId }: ViewProps) {
  const toast = useToast()
  const [tab, setTab] = useState('Executive')
  return (
    <ModuleShell moduleId={moduleId} subtitle="Cross-module reporting — all figures are simulated">
      <Tabs value={tab} onChange={setTab} tabs={ANALYTICS_TABS.map((t) => ({ id: t, label: t }))} />
      <div className="flex flex-wrap gap-2 pt-4">
        <Select className="w-auto" options={['This academic year', 'Last academic year', 'This quarter']} />
        <Select className="w-auto" options={['All campuses', ...CAMPUSES]} />
        <Select className="w-auto" options={['All departments', ...DEPARTMENTS.slice(0, 8)]} />
        <Button size="sm" className="ml-auto" icon={Download} onClick={() => toast({ title: 'Export queued', desc: `${tab.toLowerCase()}-analytics.pdf`, tone: 'success' })}>Export</Button>
        <Button size="sm" onClick={() => toast({ title: 'Report saved', desc: 'Available under Saved reports.', tone: 'success' })}>Save report</Button>
      </div>

      {tab === 'Executive' && (
        <div className="space-y-4 pt-4">
          <StatRow cols={5} items={[
            { label: 'Students', value: '2,840' }, { label: 'Revenue YTD', value: '₹52.6 Cr' },
            { label: 'Attendance', value: '92.4%' }, { label: 'Placement', value: '82.1%' }, { label: 'Retention', value: '94.6%' },
          ]} />
          <div className="grid gap-6 xl:grid-cols-3">
            <Panel title="Revenue vs expenses" className="xl:col-span-2"><div className="p-4"><AreaTrend data={revenueTrend} keys={[{ key: 'revenue', label: 'Revenue (₹Cr)' }, { key: 'expenses', label: 'Expenses (₹Cr)' }]} /></div></Panel>
            <Panel title="Student mix"><div className="p-4"><Donut data={studentDistribution} /></div></Panel>
          </div>
          <Panel title="Campus scorecard">
            <div className="scroll-x">
              <table className="w-full min-w-[620px] text-sm">
                <thead><tr className="border-b text-left text-[11px] uppercase muted">
                  <th className="px-4 py-2">Campus</th><th className="px-4 py-2 text-right">Students</th>
                  <th className="px-4 py-2 text-right">Attendance</th><th className="px-4 py-2 text-right">Collection</th>
                  <th className="px-4 py-2 text-right">Placement</th><th className="px-4 py-2">Health</th>
                </tr></thead>
                <tbody>
                  {campusComparison.map((c) => (
                    <tr key={c.name} className="border-b last:border-0">
                      <td className="px-6 py-4 font-medium">{c.name}</td>
                      <td className="px-6 py-4 text-right tabular-nums">{num(c.students)}</td>
                      <td className="px-6 py-4 text-right tabular-nums">{c.attendance}%</td>
                      <td className="px-6 py-4 text-right tabular-nums">{c.collection}%</td>
                      <td className="px-6 py-4 text-right tabular-nums">{c.placement}%</td>
                      <td className="px-6 py-4"><Badge tone={c.attendance > 92 ? 'green' : c.attendance > 90 ? 'amber' : 'red'}>
                        {c.attendance > 92 ? 'Healthy' : c.attendance > 90 ? 'Watch' : 'At risk'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

      {tab === 'Custom reports' && (
        <div className="space-y-4 pt-4">
          <Panel title="Report builder" subtitle="Pick a dataset, dimensions and measures">
            <div className="grid gap-3 p-4 sm:grid-cols-4">
              <Field label="Dataset"><Select options={['Students', 'Admissions', 'Finance', 'Attendance', 'HR', 'Library']} /></Field>
              <Field label="Dimension"><Select options={['Programme', 'Department', 'Campus', 'Semester', 'Month']} /></Field>
              <Field label="Measure"><Select options={['Count', 'Sum of fees', 'Average attendance', 'Average CGPA']} /></Field>
              <Field label="Chart"><Select options={['Bar', 'Line', 'Donut', 'Table']} /></Field>
            </div>
            <div className="border-t p-2"><BarSeries data={PROGRAMS.slice(0, 8).map((p, i) => ({ name: p.replace('B.Tech ', ''), value: 240 - i * 22 }))} keys={[{ key: 'value', label: 'Students' }]} /></div>
          </Panel>
          <Panel title="Saved reports">
            <div className="divide-y">
              {['Monthly collection summary', 'Department attendance scorecard', 'Placement funnel by programme', 'Faculty workload audit'].map((r) => (
                <div key={r} className="flex items-center gap-3 px-6 py-4">
                  <FileText className="h-4 w-4 muted" /><span className="flex-1 text-[13px] font-medium">{r}</span>
                  <Badge tone="slate">Weekly email</Badge>
                  <Button size="sm" variant="ghost" onClick={() => toast({ title: `${r} generated`, tone: 'success' })}>Run</Button>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {tab !== 'Executive' && tab !== 'Custom reports' && (
        <div className="grid gap-4 pt-4 lg:grid-cols-2">
          <Panel title={`${tab} trend`}><div className="p-4"><LineSeries data={attendanceTrend} keys={[{ key: 'students', label: tab }]} /></div></Panel>
          <Panel title={`${tab} breakdown`}><div className="p-4"><BarSeries data={admissionsTrend.slice(-6)} keys={[{ key: 'leads', label: 'Volume' }, { key: 'enrolled', label: 'Converted' }]} /></div></Panel>
          <Panel title="Distribution"><div className="p-4"><Donut data={studentDistribution.slice(0, 5)} /></div></Panel>
          <Panel title="Quality index"><div className="p-4"><RadarSpread data={[
            { name: 'Coverage', value: 88 }, { name: 'Accuracy', value: 92 }, { name: 'Timeliness', value: 76 },
            { name: 'Adoption', value: 81 }, { name: 'Compliance', value: 94 },
          ]} /></div></Panel>
        </div>
      )}
    </ModuleShell>
  )
}

/* ============================================================ AI Center */
const AI_SUGGESTIONS = [
  'Which programmes are at risk of missing intake targets?',
  'Summarise fee collection for July across campuses',
  'List students likely to drop below 75% attendance',
  'Draft an announcement about the extended fee deadline',
]

export function AiCenter({ moduleId }: ViewProps) {
  const toast = useToast()
  const [messages, setMessages] = useState<{ role: 'user' | 'ai'; text: string }[]>([
    { role: 'ai', text: 'I can summarise any module in this workspace. Everything I return here is generated from the prototype’s mock dataset — nothing leaves your browser.' },
  ])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)

  const ask = (q: string) => {
    if (!q.trim()) return
    setMessages((m) => [...m, { role: 'user', text: q }])
    setInput(''); setThinking(true)
    setTimeout(() => {
      setThinking(false)
      setMessages((m) => [...m, {
        role: 'ai',
        text: `Based on the current dataset: 3 programmes (M.Tech VLSI, B.Sc Chemistry, LL.M) are tracking 18–24% below intake target. Fee collection stands at ₹39.84 Cr (83% of billing) with ₹41.2 L overdue beyond 30 days across 38 invoices. 146 students are projected to fall below the 75% attendance threshold before the next review — the largest cluster is Semester 5 CSE Section B.`,
      }])
    }, 900)
  }

  const insights = [
    { icon: AlertTriangle, tone: 'red' as const, title: '92 students flagged high fee-default risk', detail: 'Model confidence 0.81 · based on payment history and prior semester behaviour' },
    { icon: Activity, tone: 'amber' as const, title: 'Attendance anomaly detected — ECE Sem 3', detail: 'Thursday afternoon sessions show a 22% dip over 4 weeks' },
    { icon: Sparkles, tone: 'blue' as const, title: 'Admission conversion likely to reach 78%', detail: 'Up from 72% — driven by referral channel performance' },
    { icon: BrainCircuit, tone: 'green' as const, title: 'Timetable optimisation available', detail: '14 room conflicts can be resolved by swapping 6 sessions' },
  ]

  return (
    <ModuleShell moduleId={moduleId} subtitle="All predictions are simulated for demonstration — no model is called">
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2 flex flex-col">
          <CardHeader title="Ask ERP" subtitle="Natural-language questions over your institutional data"
            action={<Badge tone="violet" dot>Simulated</Badge>} />
          <div className="flex-1 space-y-3 overflow-y-auto p-4" style={{ maxHeight: 420 }}>
            {messages.map((m, i) => (
              <div key={i} className={cx('flex gap-2.5', m.role === 'user' && 'justify-end')}>
                {m.role === 'ai' && <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"><Sparkles className="h-4 w-4" /></div>}
                <div className={cx('max-w-[80%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed',
                  m.role === 'user' ? 'bg-brand-600 text-white' : 'hairline')}>{m.text}</div>
              </div>
            ))}
            {thinking && <div className="flex items-center gap-2 text-[13px] muted"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Analysing 2,840 student records…</div>}
          </div>
          <div className="border-t p-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {AI_SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => ask(s)} className="rounded-full hairline px-2.5 py-1 text-[11px] muted hover:bg-slate-50 dark:hover:bg-white/5">{s}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask(input)} placeholder="Ask anything about your institution…" />
              <Button variant="primary" icon={Send} onClick={() => ask(input)}>Ask</Button>
            </div>
          </div>
        </Card>

        <div className="space-y-10">
          <Panel title="AI insights" subtitle="Refreshed 20 minutes ago">
            <div className="divide-y">
              {insights.map((i) => (
                <div key={i.title} className="flex gap-2.5 px-6 py-4">
                  <i.icon className={cx('mt-0.5 h-4 w-4 shrink-0',
                    i.tone === 'red' ? 'text-rose-500' : i.tone === 'amber' ? 'text-amber-500' : i.tone === 'green' ? 'text-emerald-500' : 'text-brand-500')} />
                  <div><p className="text-[13px] font-medium leading-snug">{i.title}</p><p className="mt-0.5 text-[11px] muted">{i.detail}</p></div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Generate" subtitle="Drafts you can edit before sending">
            <div className="grid gap-2.5 p-6">
              {['Announcement — fee deadline', 'Email — attendance shortage notice', 'Report summary — July finance', 'Timetable suggestions'].map((g) => (
                <Button key={g} icon={Wand2} onClick={() => toast({ title: 'Draft generated', desc: g, tone: 'success' })}>{g}</Button>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Student risk prediction" subtitle="Composite risk score">
          <DataTable selectable={false} pageSize={5}
            columns={parseCols(['person:Student', 'pct:Risk Score', 'status:Risk@Low,Medium,High'])}
            rows={makeRows('ai:risk', parseCols(['person:Student', 'pct:Risk Score', 'status:Risk@Low,Medium,High']), 20)} />
        </Panel>
        <Panel title="Fee default prediction" subtitle="Next billing cycle">
          <DataTable selectable={false} pageSize={5}
            columns={parseCols(['person:Student', 'money:Exposure', 'status:Likelihood@Low,Medium,High'])}
            rows={makeRows('ai:fee', parseCols(['person:Student', 'money:Exposure', 'status:Likelihood@Low,Medium,High']), 20)} />
        </Panel>
        <Panel title="Performance prediction" subtitle="Projected end-semester grade">
          <DataTable selectable={false} pageSize={5}
            columns={parseCols(['person:Student', 'grade:Projected', 'pct:Confidence'])}
            rows={makeRows('ai:perf', parseCols(['person:Student', 'grade:Projected', 'pct:Confidence']), 20)} />
        </Panel>
      </div>
    </ModuleShell>
  )
}

/* ========================================================= Integrations */
const INTEGRATIONS = [
  { name: 'Razorpay', cat: 'Payment gateway', connected: true, desc: 'Online fee collection, UPI and cards' },
  { name: 'SendGrid', cat: 'Email', connected: true, desc: 'Transactional and campaign email' },
  { name: 'MSG91', cat: 'SMS', connected: true, desc: 'Bulk SMS and OTP delivery' },
  { name: 'WhatsApp Business', cat: 'Messaging', connected: false, desc: 'Template messages to parents' },
  { name: 'Google Workspace', cat: 'Productivity', connected: true, desc: 'Directory sync, Drive, Classroom' },
  { name: 'Microsoft 365', cat: 'Productivity', connected: false, desc: 'Entra ID sync, OneDrive, Outlook' },
  { name: 'Zoom', cat: 'Live classes', connected: true, desc: 'Scheduled live sessions and recordings' },
  { name: 'Microsoft Teams', cat: 'Live classes', connected: false, desc: 'Meetings and channel sync' },
  { name: 'ESSL Biometric', cat: 'Devices', connected: true, desc: 'Fingerprint attendance devices' },
  { name: 'RFID Gateway', cat: 'Devices', connected: true, desc: 'Card-based entry and attendance' },
  { name: 'CCTV / NVR', cat: 'Devices', connected: true, desc: 'Camera feeds and 30-day recording retention' },
  { name: 'GPS Tracker', cat: 'Devices', connected: true, desc: 'Live school bus location for parents' },
  { name: 'Tally Prime', cat: 'Accounting', connected: false, desc: 'Ledger and voucher synchronisation' },
  { name: 'Moodle', cat: 'LMS', connected: false, desc: 'Course and grade exchange' },
  { name: 'LTI 1.3', cat: 'LMS standard', connected: true, desc: 'External tool launch' },
  { name: 'LDAP', cat: 'Directory', connected: true, desc: 'On-premise user directory' },
  { name: 'SAML 2.0', cat: 'SSO', connected: true, desc: 'Single sign-on for staff' },
  { name: 'OAuth 2.0', cat: 'SSO', connected: true, desc: 'Google and Microsoft social login' },
  { name: 'REST API', cat: 'Developer', connected: true, desc: 'Public read/write endpoints' },
  { name: 'Webhooks', cat: 'Developer', connected: false, desc: 'Event push to your systems' },
]

export function Integrations({ moduleId }: ViewProps) {
  const toast = useToast()
  const [state, setState] = useState(Object.fromEntries(INTEGRATIONS.map((i) => [i.name, i.connected])))
  const [config, setConfig] = useState<string | null>(null)
  const [logs, setLogs] = useState<string | null>(null)
  const [filter, setFilter] = useState('All')
  const cats = ['All', ...Array.from(new Set(INTEGRATIONS.map((i) => i.cat)))]
  const list = INTEGRATIONS.filter((i) => filter === 'All' || i.cat === filter)

  return (
    <ModuleShell moduleId={moduleId} subtitle="Connections are simulated — no credentials are stored or transmitted">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" options={cats} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Badge tone="green">{Object.values(state).filter(Boolean).length} connected</Badge>
        <Badge tone="slate">{Object.values(state).filter((v) => !v).length} available</Badge>
      </div>
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((i) => (
          <Card key={i.name} className="p-4">
            <div className="flex items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-[12px] font-bold dark:bg-white/10">{i.name.slice(0, 2).toUpperCase()}</div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold">{i.name}</p>
                <p className="truncate text-[11px] muted">{i.cat}</p>
              </div>
              <Badge tone={state[i.name] ? 'green' : 'slate'} dot>{state[i.name] ? 'Connected' : 'Disconnected'}</Badge>
            </div>
            <p className="mt-2.5 text-[12px] muted">{i.desc}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => setConfig(i.name)}>Configure</Button>
              <Button size="sm" onClick={() => toast({ title: 'Connection test passed', desc: `${i.name} responded in 142 ms`, tone: 'success' })}>Test</Button>
              <Button size="sm" variant="ghost" onClick={() => setLogs(i.name)}>Logs</Button>
              <Button size="sm" variant={state[i.name] ? 'danger' : 'primary'} className="ml-auto"
                onClick={() => {
                  setState((s) => ({ ...s, [i.name]: !s[i.name] }))
                  toast({ title: state[i.name] ? `${i.name} disabled` : `${i.name} connected`, tone: state[i.name] ? 'error' : 'success' })
                }}>
                {state[i.name] ? 'Disable' : 'Connect'}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Modal open={!!config} onClose={() => setConfig(null)} title={`Configure ${config}`} subtitle="Credentials are not persisted in this prototype"
        footer={<><Button onClick={() => setConfig(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => { setConfig(null); toast({ title: 'Configuration saved', tone: 'success' }) }}>Save</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Environment"><Select options={['Production', 'Sandbox']} /></Field>
          <Field label="API key" required><Input placeholder="sk_live_••••••••••••" /></Field>
          <Field label="Secret"><Input type="password" placeholder="••••••••••••" /></Field>
          <Field label="Webhook URL"><Input placeholder="https://erp.vivencia.edu.in/hooks" /></Field>
          <Field label="Sync frequency"><Select options={['Real-time', 'Every 15 minutes', 'Hourly', 'Nightly']} /></Field>
          <Field label="Scope"><Select options={['All campuses', ...CAMPUSES]} /></Field>
        </div>
      </Modal>

      <Modal open={!!logs} onClose={() => setLogs(null)} title={`${logs} — connection logs`} size="lg">
        <div className="space-y-1 font-mono text-[11px]">
          {Array.from({ length: 14 }, (_, i) => {
            const ok = i % 5 !== 3
            return (
              <div key={i} className={cx('rounded px-2 py-1', ok ? 'bg-slate-50 dark:bg-white/5' : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300')}>
                2026-08-0{(i % 8) + 1} 1{i % 10}:2{i % 6}:14 · {ok ? '200 OK' : '504 GATEWAY TIMEOUT'} · sync batch #{4100 + i} · {int(rng(i), 12, 480)} records
              </div>
            )
          })}
        </div>
      </Modal>
    </ModuleShell>
  )
}

/* ============================================================= Settings */
const SETTINGS_TABS = ['Institution', 'Branding', 'Academic', 'Localisation', 'Grading', 'Fee rules', 'Notifications', 'Custom fields', 'Templates']

export function SettingsPage({ moduleId }: ViewProps) {
  const toast = useToast()
  const app = useApp()
  const [tab, setTab] = useState('Institution')
  const [dirty, setDirty] = useState(false)

  return (
    <ModuleShell moduleId={moduleId} subtitle="Workspace configuration"
      actions={<>
        <Button size="sm" onClick={() => { setDirty(false); toast({ title: 'Changes discarded', tone: 'info' }) }}>Discard</Button>
        <Button size="sm" variant="primary" disabled={!dirty} onClick={() => { setDirty(false); toast({ title: 'Settings saved', tone: 'success' }) }}>Save changes</Button>
      </>}>
      <Tabs value={tab} onChange={setTab} tabs={SETTINGS_TABS.map((t) => ({ id: t, label: t }))} />
      <div onChange={() => setDirty(true)} className="pt-4">
        {tab === 'Institution' && (
          <Card className="p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Institution name" required><Input defaultValue={INSTITUTIONS[0]} /></Field>
              <Field label="Short name"><Input defaultValue="VIT-B" /></Field>
              <Field label="Affiliating university"><Input defaultValue="Visvesvaraya Technological University" /></Field>
              <Field label="AICTE approval no."><Input defaultValue="AICTE/2026/KA/1184" /></Field>
              <Field label="Registered address"><Textarea defaultValue="12 Knowledge Park, Whitefield, Bengaluru 560066" /></Field>
              <Field label="Contact"><Input defaultValue="+91 80 4567 8900" /></Field>
            </div>
          </Card>
        )}
        {tab === 'Branding' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-5">
              <p className="mb-3 text-sm font-semibold">Logo & identity</p>
              <div className="flex items-center gap-4">
                <div className="grid h-16 w-16 place-items-center rounded-xl bg-brand-600 text-white text-xl font-bold">V</div>
                <Button size="sm" icon={Upload} onClick={() => toast({ title: 'Upload dialog', desc: 'Mocked in the prototype.', tone: 'info' })}>Upload logo</Button>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <Field label="Primary colour"><Input defaultValue="#3163F5" /></Field>
                <Field label="Accent colour"><Input defaultValue="#10B981" /></Field>
              </div>
            </Card>
            <Card className="p-5">
              <p className="mb-3 text-sm font-semibold">Appearance</p>
              <Row label="Theme" hint="Applies to your account only">
                <Select className="w-40" options={['Light', 'Dark']} value={app.theme === 'dark' ? 'Dark' : 'Light'}
                  onChange={(e) => app.setTheme(e.target.value === 'Dark' ? 'dark' : 'light')} />
              </Row>
              <Row label="Institution type" hint="Switches vocabulary across every module — school reads Class VIII-B / Mathematics / Term 2, university reads B.Tech CSE / Semester 5.">
                <Select className="w-40" options={['higher-ed', 'k12']} value={app.segment}
                  onChange={(e) => app.setSegment(e.target.value as 'higher-ed' | 'k12')} />
              </Row>
              <Row label="Visual skin" hint="Applies to working screens. Select shadcn, bento, or ui-3 (glassmorphic theme with neon accents and frosted layers).">
                <Select className="w-44" options={['shadcn', 'bento', 'ui-3']} value={app.skin}
                  onChange={(e) => app.setSkin(e.target.value as 'shadcn' | 'bento' | 'ui-3')} />
              </Row>
              <Row label="Density" hint="Table row height">
                <Select className="w-40" options={['Comfortable', 'Compact']} value={app.density === 'compact' ? 'Compact' : 'Comfortable'}
                  onChange={(e) => app.setDensity(e.target.value === 'Compact' ? 'compact' : 'comfortable')} />
              </Row>
              <Row label="Collapse sidebar by default"><Toggle checked={app.sidebarCollapsed} onChange={app.setSidebarCollapsed} /></Row>
            </Card>
          </div>
        )}
        {tab === 'Academic' && (
          <Card className="p-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Current academic year"><Select options={app.years} value={app.year} onChange={(e) => app.setYear(e.target.value)} /></Field>
              <Field label="Term structure"><Select options={['Semester', 'Trimester', 'Annual']} /></Field>
              <Field label="Working days"><Select options={['Monday–Saturday', 'Monday–Friday']} /></Field>
              <Field label="Attendance threshold"><Input defaultValue="75%" /></Field>
              <Field label="Max credits per semester"><Input defaultValue="26" /></Field>
              <Field label="Promotion rule"><Select options={['Credit-based', 'Percentage-based']} /></Field>
            </div>
          </Card>
        )}
        {tab === 'Localisation' && (
          <Card className="p-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Time zone"><Select options={['Asia/Kolkata (IST)', 'Asia/Dubai', 'UTC']} /></Field>
              <Field label="Currency"><Select options={['INR — ₹', 'USD — $', 'AED — د.إ']} /></Field>
              <Field label="Language"><Select options={['English (India)', 'हिन्दी', 'ಕನ್ನಡ', 'தமிழ்']} /></Field>
              <Field label="Date format"><Select options={['DD MMM YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']} /></Field>
              <Field label="Number format"><Select options={['Indian (1,23,456)', 'International (123,456)']} /></Field>
              <Field label="Week starts on"><Select options={['Monday', 'Sunday']} /></Field>
            </div>
          </Card>
        )}
        {tab === 'Grading' && (
          <Card className="overflow-hidden">
            <CardHeader title="Grading scheme" subtitle="Relative grading · 10-point scale"
              action={<Button size="sm" icon={Plus} onClick={() => toast({ title: 'Grade band added', tone: 'success' })}>Add band</Button>} />
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-[11px] uppercase muted"><th className="px-4 py-2">Grade</th><th className="px-4 py-2">Range</th><th className="px-4 py-2">Grade point</th><th className="px-4 py-2">Result</th></tr></thead>
              <tbody>
                {[['A+', '90–100', 10], ['A', '80–89', 9], ['B+', '70–79', 8], ['B', '60–69', 7], ['C', '50–59', 6], ['D', '40–49', 5], ['F', '< 40', 0]].map(([g, r, p]) => (
                  <tr key={g as string} className="border-b last:border-0">
                    <td className="px-4 py-2 font-medium">{g}</td><td className="px-4 py-2">{r}</td><td className="px-4 py-2">{p}</td>
                    <td className="px-4 py-2"><Badge tone={p === 0 ? 'red' : 'green'}>{p === 0 ? 'Fail' : 'Pass'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {tab === 'Fee rules' && (
          <Card className="p-5">
            <Row label="Late payment penalty" hint="Applied monthly on overdue balance"><Input className="w-32" defaultValue="2%" /></Row>
            <Row label="Grace period" hint="Days after due date"><Input className="w-32" defaultValue="7" /></Row>
            <Row label="Allow instalments"><Toggle checked onChange={() => setDirty(true)} /></Row>
            <Row label="Auto-block results on default"><Toggle checked={false} onChange={() => setDirty(true)} /></Row>
            <Row label="Sibling discount"><Input className="w-32" defaultValue="10%" /></Row>
          </Card>
        )}
        {tab === 'Notifications' && (
          <Card className="p-5">
            {['Fee due reminder', 'Attendance shortage alert', 'Result publication', 'Exam schedule', 'Event invitation', 'Library due date'].map((n, i) => (
              <div key={n} className="flex flex-wrap items-center gap-3 border-b py-3 last:border-0">
                <span className="min-w-0 flex-1 text-[13px] font-medium">{n}</span>
                {['Email', 'SMS', 'Push', 'WhatsApp'].map((c, ci) => (
                  <label key={c} className="flex items-center gap-1.5 text-[12px] muted">
                    <Checkbox checked={(i + ci) % 3 !== 0} onChange={() => setDirty(true)} /> {c}
                  </label>
                ))}
              </div>
            ))}
          </Card>
        )}
        {tab === 'Custom fields' && (
          <DataTable
            columns={parseCols(['text:Field@Blood Group,Guardian Occupation,Sports Quota,Hostel Required,Transport Route', 'text:Type@Text,Dropdown,Checkbox,Date,Number', 'text:Module@Students,Admissions,HR', 'status:Status@Active,Inactive'])}
            rows={makeRows('settings:fields', parseCols(['text:Field@Blood Group,Guardian Occupation,Sports Quota,Hostel Required,Transport Route', 'text:Type@Text,Dropdown,Checkbox,Date,Number', 'text:Module@Students,Admissions,HR', 'status:Status@Active,Inactive']), 18)} />
        )}
        {tab === 'Templates' && (
          <DataTable
            columns={parseCols(['text:Template@Bonafide Certificate,Fee Receipt,Offer Letter,Warning Letter,Experience Letter', 'text:Channel@PDF,Email,SMS', 'int:Version', 'date:Updated', 'status:Status@Active,Draft'])}
            rows={makeRows('settings:templates', parseCols(['text:Template@Bonafide Certificate,Fee Receipt,Offer Letter,Warning Letter,Experience Letter', 'text:Channel@PDF,Email,SMS', 'int:Version', 'date:Updated', 'status:Status@Active,Draft']), 14)} />
        )}
      </div>
    </ModuleShell>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{label}</p>
        {hint && <p className="text-[11px] muted">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

/* ======================================================== Multi-campus */
export function MultiCampus({ moduleId }: ViewProps) {
  const app = useApp()
  const toast = useToast()
  return (
    <ModuleShell moduleId={moduleId} subtitle="Group-level consolidation across institutions and campuses">
      <StatRow cols={5} items={[
        { label: 'Institutions', value: '3' }, { label: 'Campuses', value: '6' }, { label: 'Students', value: '2,840' },
        { label: 'Consolidated revenue', value: '₹52.6 Cr' }, { label: 'Consolidated intake', value: '412' },
      ]} />
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {CAMPUSES.map((c, i) => {
          const d = campusComparison[i]
          return (
            <Card key={c} className="p-4">
              <div className="flex items-start justify-between">
                <div><p className="text-[14px] font-semibold">{c.split('—')[0].trim()}</p><p className="text-[11px] muted">{c.split('—')[1]?.trim()}</p></div>
                <Badge tone={app.campus === c ? 'blue' : 'slate'}>{app.campus === c ? 'Active' : 'Available'}</Badge>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
                <div><dt className="muted">Students</dt><dd className="font-medium tabular-nums">{num(d.students)}</dd></div>
                <div><dt className="muted">Attendance</dt><dd className="font-medium tabular-nums">{d.attendance}%</dd></div>
                <div><dt className="muted">Collection</dt><dd className="font-medium tabular-nums">{d.collection}%</dd></div>
                <div><dt className="muted">Placement</dt><dd className="font-medium tabular-nums">{d.placement}%</dd></div>
              </dl>
              <Button size="sm" className="mt-3 w-full" onClick={() => { app.setCampus(c); toast({ title: `Switched to ${c}`, tone: 'success' }) }}>
                Switch to campus
              </Button>
            </Card>
          )
        })}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Campus comparison — students"><div className="p-4"><BarSeries data={campusComparison} keys={[{ key: 'students', label: 'Students' }]} /></div></Panel>
        <Panel title="Campus comparison — performance"><div className="p-4"><BarSeries data={campusComparison} keys={[{ key: 'attendance', label: 'Attendance %' }, { key: 'placement', label: 'Placement %' }]} /></div></Panel>
      </div>
      <Panel title="Shared services" subtitle="Centralised across the group">
        <div className="divide-y">
          {[['Central library consortium', '6 campuses', 'Active'], ['Group payroll processing', '260 employees', 'Active'],
          ['Shared transport pool', '23 vehicles', 'Active'], ['Common admissions CRM', '326 leads', 'Active'],
          ['Group procurement', '18 vendors', 'Under review']].map(([n, d, s]) => (
            <div key={n as string} className="flex items-center gap-3 px-6 py-4">
              <span className="flex-1 text-[13px] font-medium">{n}</span>
              <span className="text-[11px] muted">{d}</span>
              <Badge tone={s === 'Active' ? 'green' : 'amber'}>{s as string}</Badge>
            </div>
          ))}
        </div>
      </Panel>
    </ModuleShell>
  )
}

/* ================================================= Admin portal helpers */
export function AdminOverview() {
  return (
    <div className="space-y-10">
      <StatRow cols={5} items={[
        { label: 'Institutions', value: '3' }, { label: 'Campuses', value: '6' }, { label: 'Active users', value: '3,214' },
        { label: 'Roles', value: '13' }, { label: 'Storage used', value: '184 GB' },
      ]} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="User growth"><div className="p-4"><AreaTrend data={attendanceTrend.map((a, i) => ({ name: a.name, users: 2400 + i * 72 }))} keys={[{ key: 'users', label: 'Users' }]} /></div></Panel>
        <Panel title="Module adoption"><div className="p-4"><BarSeries horizontal height={250} data={[
          { name: 'Students', value: 98 }, { name: 'Finance', value: 92 }, { name: 'Attendance', value: 88 },
          { name: 'LMS', value: 71 }, { name: 'Library', value: 64 }, { name: 'Transport', value: 52 },
        ]} keys={[{ key: 'value', label: 'Adoption %' }]} /></div></Panel>
      </div>
    </div>
  )
}

export function SystemHealth() {
  const services = [
    { name: 'Application server', status: 'Operational', uptime: 99.98, latency: '124 ms' },
    { name: 'Database cluster', status: 'Operational', uptime: 99.99, latency: '8 ms' },
    { name: 'File storage', status: 'Operational', uptime: 99.94, latency: '212 ms' },
    { name: 'Email delivery', status: 'Degraded', uptime: 97.10, latency: '1.8 s' },
    { name: 'SMS gateway', status: 'Operational', uptime: 99.80, latency: '640 ms' },
    { name: 'Biometric sync', status: 'Partial outage', uptime: 92.40, latency: '—' },
  ]
  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Overall uptime', value: '99.6%', sub: 'Last 30 days' },
        { label: 'Avg response', value: '186 ms' },
        { label: 'Background jobs', value: '1,284', sub: '3 failed' },
        { label: 'Storage', value: '184 / 500 GB' },
      ]} />
      <Panel title="Service status">
        <div className="divide-y">
          {services.map((s) => (
            <div key={s.name} className="flex flex-wrap items-center gap-3 px-6 py-4">
              <Server className="h-4 w-4 muted" />
              <span className="min-w-0 flex-1 text-[13px] font-medium">{s.name}</span>
              <span className="text-[11px] muted tabular-nums">{s.uptime}% uptime · {s.latency}</span>
              <Badge tone={s.status === 'Operational' ? 'green' : s.status === 'Degraded' ? 'amber' : 'red'} dot>{s.status}</Badge>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Request volume" subtitle="Requests per minute, last 12 hours">
        <div className="p-4"><AreaTrend data={Array.from({ length: 12 }, (_, i) => ({ name: `${i + 8}:00`, requests: 400 + int(rng(i + 4), 0, 900) }))} keys={[{ key: 'requests', label: 'Requests/min' }]} /></div>
      </Panel>
    </div>
  )
}

/* =========================================================== Role matrix */
const PERMISSIONS = ['View', 'Create', 'Edit', 'Delete', 'Approve', 'Export']
const MATRIX_MODULES = ['Students', 'Admissions', 'Academics', 'Finance', 'HR', 'Library', 'Transport', 'Security']

export function RoleMatrix() {
  const toast = useToast()
  const [role, setRole] = useState('Faculty')
  const [grid, setGrid] = useState<Record<string, boolean>>(() => {
    const g: Record<string, boolean> = {}
    MATRIX_MODULES.forEach((m, mi) => PERMISSIONS.forEach((p, pi) => { g[`${m}-${p}`] = (mi + pi) % 3 !== 0 }))
    return g
  })
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Permission matrix" subtitle="Toggle a cell to grant or revoke access"
        action={<div className="flex gap-2">
          <Select className="w-44" options={['Super Admin', 'Institution Admin', 'Principal', 'HOD', 'Faculty', 'Accountant', 'Librarian']} value={role} onChange={(e) => setRole(e.target.value)} />
          <Button size="sm" variant="primary" onClick={() => toast({ title: `Permissions saved for ${role}`, tone: 'success' })}>Save</Button>
        </div>} />
      <div className="scroll-x">
        <table className="w-full min-w-[680px] text-sm">
          <thead><tr className="border-b text-left text-[11px] uppercase muted">
            <th className="px-4 py-2">Module</th>
            {PERMISSIONS.map((p) => <th key={p} className="px-4 py-2 text-center">{p}</th>)}
          </tr></thead>
          <tbody>
            {MATRIX_MODULES.map((m) => (
              <tr key={m} className="border-b last:border-0">
                <td className="px-4 py-2 font-medium">{m}</td>
                {PERMISSIONS.map((p) => (
                  <td key={p} className="px-4 py-2 text-center">
                    <button onClick={() => setGrid((g) => ({ ...g, [`${m}-${p}`]: !g[`${m}-${p}`] }))}
                      className={cx('grid h-5 w-5 mx-auto place-items-center rounded border transition-colors',
                        grid[`${m}-${p}`] ? 'border-emerald-500 bg-emerald-500 text-white' : 'surface')}>
                      {grid[`${m}-${p}`] ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3 muted" />}
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/* =========================================================== Form builder */
const FIELD_TYPES = ['Short text', 'Long text', 'Dropdown', 'Checkbox', 'Radio', 'Date', 'Number', 'File upload']

export function FormBuilder() {
  const toast = useToast()
  const [fields, setFields] = useState([
    { id: 1, label: 'Full name', type: 'Short text', required: true },
    { id: 2, label: 'Date of birth', type: 'Date', required: true },
    { id: 3, label: 'Programme applied for', type: 'Dropdown', required: true },
    { id: 4, label: 'Class 12 percentage', type: 'Number', required: true },
    { id: 5, label: 'Upload marksheet', type: 'File upload', required: false },
  ])
  const [preview, setPreview] = useState(false)

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2 overflow-hidden">
        <CardHeader title="UG Application 2026" subtitle="Drag fields to reorder · click to edit"
          action={<div className="flex gap-2">
            <Button size="sm" onClick={() => setPreview(true)}>Preview</Button>
            <Button size="sm" variant="primary" onClick={() => toast({ title: 'Form published', desc: 'Live at /apply/ug-2026', tone: 'success' })}>Publish</Button>
          </div>} />
        <div className="divide-y">
          {fields.map((f) => (
            <div key={f.id} className="flex items-center gap-3 px-6 py-4">
              <GripVertical className="h-4 w-4 cursor-grab muted" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{f.label} {f.required && <span className="text-rose-500">*</span>}</p>
                <p className="text-[11px] muted">{f.type}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setFields((fs) => fs.filter((x) => x.id !== f.id))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader title="Add field" />
        <div className="grid gap-2.5 p-6">
          {FIELD_TYPES.map((t) => (
            <Button key={t} icon={Plus} onClick={() => {
              setFields((fs) => [...fs, { id: Date.now(), label: `New ${t.toLowerCase()} field`, type: t, required: false }])
              toast({ title: 'Field added', desc: t, tone: 'success' })
            }}>{t}</Button>
          ))}
        </div>
      </Card>

      <Modal open={preview} onClose={() => setPreview(false)} title="Form preview" subtitle="UG Application 2026"
        footer={<Button variant="primary" onClick={() => { setPreview(false); toast({ title: 'Test submission recorded', tone: 'success' }) }}>Submit test entry</Button>}>
        <div className="grid gap-3">
          {fields.map((f) => (
            <Field key={f.id} label={f.label} required={f.required}>
              {f.type === 'Dropdown' ? <Select options={PROGRAMS.slice(0, 8)} />
                : f.type === 'Long text' ? <Textarea />
                  : <Input type={f.type === 'Date' ? 'date' : f.type === 'Number' ? 'number' : f.type === 'File upload' ? 'file' : 'text'} />}
            </Field>
          ))}
        </div>
      </Modal>
    </div>
  )
}
