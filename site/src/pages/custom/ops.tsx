import { useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, Archive, Bus, Check, CircleDollarSign, Download, Fuel, Gauge, MapPin,
  Paperclip, Printer, Reply, Send, Star, Trash2, Wrench,
} from 'lucide-react'
import {
  Avatar, Badge, Button, Card, CardHeader, Checkbox, Drawer, Field, Input, Modal, Progress,
  Select, Tabs, Textarea, useToast,
} from '@/components/ui'
import { DataTable } from '@/components/tables/DataTable'
import { AreaTrend, BarSeries, Donut, LineSeries, RadarSpread } from '@/components/charts'
import { makeRows, parseCols, personName } from '@/data/generator'
import { COMPANIES, COURSES, DEPARTMENTS, PROGRAMS, VENDORS } from '@/data/vocab'
import { feeCollection, revenueTrend } from '@/data/dashboard'
import { cx, dateOffset, fmtDate, inr, inrCompact, int, num, pick, rng } from '@/lib/utils'
import { MoveToStageMenu, Panel, StatRow, type ViewProps } from './shared'

/* ==================================================== Finance dashboard */
export function FinanceDashboard() {
  const toast = useToast()
  const [payOpen, setPayOpen] = useState(false)
  const [invoiceOpen, setInvoiceOpen] = useState(false)
  // Clicking a chart segment filters the table below it, so the picture and
  // the records are the same interface rather than two separate ones.
  const [headFilter, setHeadFilter] = useState<string | null>(null)

  const outstandingCols = parseCols([
    'person:Student', 'text:Fee Head@Tuition,Hostel,Transport,Exam,Library',
    'program:Programme', 'money:Outstanding', 'int:Days Overdue',
    'status:Status@Overdue,Partial,Payment Plan',
  ])
  const outstandingRows = makeRows('finance:outstanding', outstandingCols, 40)

  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Annual billing', value: '₹48.00 Cr', sub: 'FY 2026-27' },
        { label: 'Collected', value: '₹39.84 Cr', sub: '83% of billing' },
        { label: 'Outstanding', value: '₹8.16 Cr', sub: '412 students' },
        { label: 'Overdue > 30 days', value: '₹41.2 L', sub: '38 invoices' },
      ]} />
      <div className="grid gap-6 xl:grid-cols-3">
        <Panel title="Revenue vs expenses" subtitle="₹ crore, monthly" className="xl:col-span-2">
          <div className="p-4"><LineSeries data={revenueTrend} keys={[{ key: 'revenue', label: 'Revenue' }, { key: 'expenses', label: 'Expenses' }]} /></div>
        </Panel>
        <Panel title="Collection by head" subtitle="₹ lakh — click a segment to filter the table below">
          <div className="p-4">
            <Donut data={feeCollection.map((f) => ({ name: f.name, value: f.collected }))}
              onSelect={(name) => { setHeadFilter(name); toast({ title: `Filtered to ${name}`, desc: 'Outstanding fees table updated.', tone: 'info' }) }} />
          </div>
        </Panel>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Quick actions" className="lg:col-span-1">
          <div className="grid gap-2.5 p-6">
            <Button onClick={() => setInvoiceOpen(true)}>Create invoice</Button>
            <Button onClick={() => setPayOpen(true)}>Record payment</Button>
            <Button onClick={() => toast({ title: 'Reminders queued', desc: '412 students will receive an SMS + email.', tone: 'success' })}>Send fee reminders</Button>
            <Button onClick={() => toast({ title: 'Receipt generated', desc: 'RCP-40219.pdf', tone: 'success' })}>Generate receipt</Button>
            <Button onClick={() => toast({ title: 'Report exported', desc: 'collections-aug-2026.xlsx', tone: 'success' })}>Export collections</Button>
          </div>
        </Panel>
        <Panel title="Budget vs actual" subtitle="Top spending departments" className="lg:col-span-2">
          <div className="p-4"><BarSeries data={DEPARTMENTS.slice(0, 6).map((d, i) => ({ name: d.split(' ')[0], budget: 120 - i * 9, actual: 108 - i * 11 }))} keys={[{ key: 'budget', label: 'Budget (₹L)' }, { key: 'actual', label: 'Actual (₹L)' }]} /></div>
        </Panel>
      </div>
      <Panel title="Outstanding fees" subtitle="Highest balances first">
        <DataTable
          selectable={false}
          columns={outstandingCols}
          rows={outstandingRows}
          externalFilter={headFilter ? { label: 'Fee head', value: headFilter } : null}
          onClearExternalFilter={() => setHeadFilter(null)}
        />
      </Panel>

      <Modal open={payOpen} onClose={() => setPayOpen(false)} title="Record payment" subtitle="Cash / UPI / bank transfer"
        footer={<><Button onClick={() => setPayOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => { setPayOpen(false); toast({ title: 'Payment recorded', desc: 'Receipt RCP-40220 generated · status changed to Paid.', tone: 'success' }) }}>Record payment</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Student" required><Input placeholder="Search by name or ID" /></Field>
          <Field label="Invoice" required><Select options={['INV-20418 — Tuition Sem 5', 'INV-20419 — Hostel', 'INV-20420 — Transport']} /></Field>
          <Field label="Amount" required><Input type="number" placeholder="92000" /></Field>
          <Field label="Mode"><Select options={['UPI', 'Net Banking', 'Card', 'Cash', 'NEFT', 'DD']} /></Field>
          <Field label="Payment date"><Input type="date" defaultValue="2026-08-08" /></Field>
          <Field label="Reference"><Input placeholder="UTR / transaction ID" /></Field>
        </div>
      </Modal>

      <Modal open={invoiceOpen} onClose={() => setInvoiceOpen(false)} title="Invoice preview" size="lg"
        footer={<><Button icon={Printer} onClick={() => window.print()}>Print</Button>
          <Button variant="primary" onClick={() => { setInvoiceOpen(false); toast({ title: 'Invoice issued', desc: 'INV-20421 sent to the student and guardian.', tone: 'success' }) }}>Issue invoice</Button></>}>
        <InvoicePreview />
      </Modal>
    </div>
  )
}

function InvoicePreview() {
  const lines = [['Tuition fee — Semester 5', 92000], ['Hostel fee — Q2', 34000], ['Transport — Route R-07', 12000], ['Examination fee', 3500]] as const
  const total = lines.reduce((s, l) => s + l[1], 0)
  return (
    <div className="rounded-xl hairline p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold">Vivencia Institute of Technology</p>
          <p className="text-[11px] muted">Main Campus — Bengaluru 560001 · GSTIN 29ABCDE1234F1Z5</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold">INV-20421</p>
          <p className="text-[11px] muted">Issued {fmtDate(dateOffset(0))}</p>
        </div>
      </div>
      <div className="my-4 h-px bg-border" />
      <p className="text-[11px] uppercase muted">Billed to</p>
      <p className="text-sm font-medium">Aarav Sharma · VIT26CS0101 · B.Tech Computer Science</p>
      <table className="mt-4 w-full text-sm">
        <thead><tr className="border-b text-left text-[11px] uppercase muted"><th className="py-1.5">Particulars</th><th className="py-1.5 text-right">Amount</th></tr></thead>
        <tbody>
          {lines.map(([l, a]) => <tr key={l} className="border-b last:border-0"><td className="py-1.5">{l}</td><td className="py-1.5 text-right tabular-nums">{inr(a)}</td></tr>)}
        </tbody>
        <tfoot><tr><td className="pt-2 font-semibold">Total payable</td><td className="pt-2 text-right font-semibold tabular-nums">{inr(total)}</td></tr></tfoot>
      </table>
      <p className="mt-4 text-[11px] muted">Payment due within 15 days. Late payment attracts 2% per month.</p>
    </div>
  )
}

export function FinanceReports() { return <GenericReports moduleId="finance" /> }

/* ================================================== Generic report page */
export function GenericReports({ moduleId }: ViewProps) {
  const toast = useToast()
  const [range, setRange] = useState('This academic year')
  const reports = [
    'Collection summary', 'Ageing analysis', 'Head-wise breakup', 'Campus comparison',
    'Defaulter list', 'Scholarship impact', 'Refund register', 'Daily cash book',
  ]
  return (
    <div className="space-y-10">
      <div className="flex flex-wrap gap-2">
        <Select className="w-auto" options={['This academic year', 'Last academic year', 'This quarter', 'This month', 'Custom range']} value={range} onChange={(e) => setRange(e.target.value)} />
        <Input type="date" className="w-auto" defaultValue="2026-04-01" />
        <Input type="date" className="w-auto" defaultValue="2026-08-08" />
        <Button size="sm" className="ml-auto" icon={Download} onClick={() => toast({ title: 'Export queued', desc: `${moduleId}-report.xlsx`, tone: 'success' })}>Export all</Button>
      </div>
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {reports.map((r, i) => (
          <Card key={r} className="p-4">
            <p className="text-[13px] font-semibold">{r}</p>
            <p className="mt-1 text-[11px] muted">{range} · updated {int(rng(i), 1, 9)}h ago</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" className="flex-1" onClick={() => toast({ title: `${r} generated`, tone: 'success' })}>Run</Button>
              <Button size="sm" variant="ghost" onClick={() => toast({ title: 'Saved to My reports', tone: 'success' })}><Star className="h-4 w-4" /></Button>
            </div>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Trend"><div className="p-4"><AreaTrend data={revenueTrend} keys={[{ key: 'revenue', label: 'Revenue (₹Cr)' }]} /></div></Panel>
        <Panel title="Distribution"><div className="p-4"><BarSeries data={feeCollection} keys={[{ key: 'billed', label: 'Billed (₹L)' }, { key: 'collected', label: 'Collected (₹L)' }]} /></div></Panel>
      </div>
    </div>
  )
}

/* ============================================================ HR people */
export function HrEmployees() {
  const cols = useMemo(() => parseCols([
    'id:Employee ID', 'person:Name', 'dept:Department', 'text:Designation@Professor,Associate Professor,Assistant Professor,Lab Technician,Accounts Officer,Administrative Staff',
    'date:Joined', 'money:Gross Salary', 'status:Employment@Permanent,Contract,Probation', 'status:Status@Active,On Leave,Notice Period',
  ]), [])
  const rows = useMemo(() => makeRows('hr:employees', cols, 52), [cols])
  const [open, setOpen] = useState<string | null>(null)
  const active = rows.find((r) => r._id === open)
  const toast = useToast()

  return (
    <>
      <DataTable columns={cols} rows={rows} onRowClick={(r) => setOpen(r._id)} />
      {active && (
        <Drawer open onClose={() => setOpen(null)} width="max-w-3xl"
          title={<span className="flex items-center gap-2"><Avatar name={active.name} size={28} />{active.name}</span>}
          subtitle={`${active.employee_id} · ${active.designation} · ${active.department}`}
          footer={<>
            <Button size="sm" onClick={() => toast({ title: 'Payslip generated', tone: 'success' })}>Generate payslip</Button>
            <Button size="sm" variant="primary" onClick={() => toast({ title: 'Leave approved', tone: 'success' })}>Approve leave</Button>
          </>}>
          <EmployeeProfile row={active} />
        </Drawer>
      )}
    </>
  )
}

function EmployeeProfile({ row }: { row: any }) {
  const [tab, setTab] = useState('personal')
  const r = rng(String(row.name).length * 977)
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'personal', label: 'Personal' }, { id: 'employment', label: 'Employment' }, { id: 'payroll', label: 'Payroll' },
        { id: 'attendance', label: 'Attendance & leave' }, { id: 'performance', label: 'Performance' }, { id: 'documents', label: 'Documents' },
      ]} />
      <div className="p-5">
        {tab === 'personal' && (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {[['Full name', row.name], ['Date of birth', fmtDate(dateOffset(-int(r, 9000, 16000)))], ['Gender', pick(r, ['Female', 'Male'])],
            ['Email', `${String(row.name).toLowerCase().replace(/\s/g, '.')}@vivencia.edu.in`], ['Phone', `+91 9${int(r, 100000000, 999999999)}`],
            ['Address', 'Indiranagar, Bengaluru'], ['Blood group', pick(r, ['A+', 'B+', 'O+'])], ['Emergency contact', personName(r)]].map(([k, v]) => (
              <div key={k as string}><dt className="text-[11px] uppercase muted">{k}</dt><dd className="text-sm">{v}</dd></div>
            ))}
          </dl>
        )}
        {tab === 'employment' && (
          <div className="space-y-10">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {[['Employee ID', row.employee_id], ['Designation', row.designation], ['Department', row.department],
              ['Joined', row.joined], ['Employment type', row.employment], ['Reporting to', personName(r)],
              ['Qualifications', 'Ph.D · M.Tech · B.E'], ['Experience', `${int(r, 3, 22)} years`]].map(([k, v]) => (
                <div key={k as string}><dt className="text-[11px] uppercase muted">{k}</dt><dd className="text-sm">{v}</dd></div>
              ))}
            </dl>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase muted">Assigned subjects</p>
              <div className="flex flex-wrap gap-1.5">{COURSES.slice(0, 4).map((c) => <Badge key={c} tone="blue">{c}</Badge>)}</div>
            </div>
          </div>
        )}
        {tab === 'payroll' && (
          <table className="w-full text-sm">
            <tbody>
              {[['Basic', 68000], ['HRA', 27200], ['DA', 13600], ['Special allowance', 9000], ['Gross', 117800], ['PF', -8160], ['TDS', -9400], ['Net pay', 100240]].map(([k, v]) => (
                <tr key={k as string} className={cx('border-b last:border-0', (k === 'Gross' || k === 'Net pay') && 'font-semibold')}>
                  <td className="py-2">{k}</td><td className="py-2 text-right tabular-nums">{inr(Math.abs(v as number))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'attendance' && (
          <div className="space-y-10">
            <StatRow cols={4} items={[{ label: 'Present days', value: '214' }, { label: 'Leaves taken', value: '11' }, { label: 'Balance', value: '13' }, { label: 'Attendance', value: '96.4%' }]} />
            <DataTable selectable={false} pageSize={5}
              columns={parseCols(['text:Type@Casual,Sick,Earned,Duty', 'date:From', 'int:Days', 'status:Status@Approved,Pending,Rejected'])}
              rows={makeRows('hr:leave-detail', parseCols(['text:Type@Casual,Sick,Earned,Duty', 'date:From', 'int:Days', 'status:Status@Approved,Pending,Rejected']), 10)} />
          </div>
        )}
        {tab === 'performance' && (
          <div className="space-y-10">
            <RadarSpread data={[
              { name: 'Teaching', value: 88 }, { name: 'Research', value: 72 }, { name: 'Mentoring', value: 81 },
              { name: 'Admin', value: 64 }, { name: 'Student feedback', value: 92 },
            ]} />
            <p className="text-[13px] muted">FY 2025-26 outcome: <Badge tone="green">Exceeds expectations</Badge></p>
          </div>
        )}
        {tab === 'documents' && (
          <div className="space-y-2">
            {['Appointment letter', 'PAN card', 'Aadhaar', 'Ph.D certificate', 'Experience letter'].map((d, i) => (
              <div key={d} className="flex items-center gap-3 rounded-lg hairline px-3 py-2.5">
                <Paperclip className="h-4 w-4 muted" /><span className="text-sm">{d}</span>
                <Badge tone={i < 4 ? 'green' : 'amber'}>{i < 4 ? 'Verified' : 'Pending'}</Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/* ========================================================= ATS pipeline */
const ATS_STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired']
export function AtsPipeline() {
  const toast = useToast()
  const [cands, setCands] = useState(() => Array.from({ length: 26 }, (_, i) => {
    const r = rng(3300 + i)
    return {
      id: `CAND-${400 + i}`, name: personName(r), role: pick(r, ['Assistant Professor', 'Lab Technician', 'Counsellor', 'Accounts Officer']),
      exp: int(r, 1, 18), stage: ATS_STAGES[int(r, 0, 4)], score: +(3 + r() * 2).toFixed(1),
    }
  }))
  return (
    <div className="scroll-x pb-2">
      <div className="flex min-w-max gap-3">
        {ATS_STAGES.map((stage) => {
          const items = cands.filter((c) => c.stage === stage)
          return (
            <div key={stage} onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const id = e.dataTransfer.getData('id')
                setCands((cs) => cs.map((c) => (c.id === id ? { ...c, stage } : c)))
                toast({ title: `Candidate moved to ${stage}`, tone: 'success' })
              }}
              className="w-[80vw] max-w-[248px] shrink-0 rounded-xl bg-slate-50 dark:bg-white/[0.03] hairline sm:w-[248px]">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="text-[13px] font-semibold">{stage}</span><Badge tone="slate">{items.length}</Badge>
              </div>
              <div className="max-h-[56vh] space-y-2 overflow-y-auto p-2">
                {items.map((c) => (
                  <div key={c.id} draggable onDragStart={(e) => e.dataTransfer.setData('id', c.id)}
                    className="card bento-interactive cursor-grab p-2.5">
                    <div className="flex items-center gap-2"><Avatar name={c.name} size={22} />
                      <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{c.name}</p><p className="truncate text-[11px] muted">{c.role}</p></div>
                      <span className="sm:hidden">
                        <MoveToStageMenu stages={ATS_STAGES} current={c.stage} onMove={(to: string) => {
                          setCands((cs) => cs.map((x) => (x.id === c.id ? { ...x, stage: to } : x)))
                          toast({ title: `Candidate moved to ${to}`, tone: 'success' })
                        }} />
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] muted">
                      <span>{c.exp} yrs exp</span><Badge tone={c.score > 4 ? 'green' : 'amber'}>★ {c.score}</Badge>
                    </div>
                  </div>
                ))}
                {!items.length && <p className="px-2 py-6 text-center text-[11px] muted">Drop candidates here</p>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ======================================================= Workload chart */
export function WorkloadChart() {
  const data = Array.from({ length: 10 }, (_, i) => {
    const r = rng(i + 313)
    return { name: personName(r).split(' ')[0] + ' ' + personName(r).split(' ')[1][0] + '.', teaching: int(r, 8, 20), research: int(r, 2, 10), admin: int(r, 1, 8) }
  })
  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Average load', value: '19.4 hrs', sub: 'Cap 20 hrs' },
        { label: 'Overloaded', value: '14', sub: 'Faculty above cap' },
        { label: 'Underloaded', value: '9', sub: 'Below 12 hrs' },
        { label: 'Utilisation', value: '87%', sub: 'Institute-wide' },
      ]} />
      <Panel title="Workload distribution" subtitle="Stacked weekly hours per faculty">
        <div className="p-4"><BarSeries height={300} data={data} keys={[{ key: 'teaching', label: 'Teaching' }, { key: 'research', label: 'Research' }, { key: 'admin', label: 'Admin' }]} /></div>
      </Panel>
      <Panel title="Overload alerts">
        <div className="divide-y">
          {data.filter((d) => d.teaching + d.research + d.admin > 26).map((d) => (
            <div key={d.name} className="flex items-center gap-3 px-6 py-4">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <span className="text-[13px] font-medium">{d.name}</span>
              <span className="text-[11px] muted">{d.teaching + d.research + d.admin} hrs/week — above 26 hr threshold</span>
              <Badge tone="red" >Overloaded</Badge>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

/* ===================================================== Library dashboard */
export function LibraryDashboard() {
  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Total volumes', value: '48,260', sub: '12,840 titles' },
        { label: 'Issued today', value: '186', sub: '+12% vs avg' },
        { label: 'Overdue', value: '94', sub: '₹18,400 fines' },
        { label: 'Active members', value: '2,614', sub: 'Students + faculty' },
      ]} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Circulation trend"><div className="p-4"><AreaTrend data={['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'].map((m, i) => ({ name: m, issued: 900 + int(rng(i), 0, 500), returned: 850 + int(rng(i + 5), 0, 500) }))} keys={[{ key: 'issued', label: 'Issued' }, { key: 'returned', label: 'Returned' }]} /></div></Panel>
        <Panel title="Category mix"><div className="p-4"><Donut data={[{ name: 'Engineering', value: 18200 }, { name: 'Management', value: 8400 }, { name: 'Science', value: 9600 }, { name: 'Law', value: 3200 }, { name: 'Reference', value: 8860 }]} /></div></Panel>
      </div>
      <Panel title="Most issued titles">
        <div className="divide-y">
          {['Introduction to Algorithms', 'Operating System Concepts', 'Principles of Marketing', 'Organic Chemistry', 'Indian Constitution'].map((t, i) => (
            <div key={t} className="flex items-center gap-3 px-6 py-4">
              <span className="grid h-6 w-6 place-items-center rounded bg-slate-100 text-[11px] font-semibold dark:bg-white/10">{i + 1}</span>
              <p className="flex-1 text-[13px] font-medium">{t}</p>
              <span className="text-[13px] tabular-nums muted">{280 - i * 34} issues</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

/* ========================================================= Transport */
export function TransportFleet() {
  const toast = useToast()
  const vehicles = Array.from({ length: 12 }, (_, i) => {
    const r = rng(i + 811)
    return {
      no: `KA-01-HF-${8800 + i * 7}`, route: `R-${String(i + 1).padStart(2, '0')}`,
      driver: personName(r), capacity: 48, onboard: int(r, 18, 48),
      status: pick(r, ['On Route', 'At Campus', 'Maintenance', 'Idle']), fuel: int(r, 20, 95),
    }
  })
  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Fleet size', value: '23', sub: '21 operational' },
        { label: 'Students ferried', value: '1,184', sub: 'Daily average' },
        { label: 'Routes', value: '18', sub: '214 stops' },
        { label: 'Due for service', value: '4', sub: 'Within 21 days' },
      ]} />
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {vehicles.map((v) => (
          <Card key={v.no} className="p-4">
            <div className="flex items-start justify-between">
              <div><p className="text-[14px] font-semibold">{v.no}</p><p className="text-[11px] muted">Route {v.route} · {v.driver}</p></div>
              <Badge tone={v.status === 'On Route' ? 'green' : v.status === 'Maintenance' ? 'red' : 'slate'} dot>{v.status}</Badge>
            </div>
            <div className="mt-3 space-y-2">
              <div>
                <div className="mb-1 flex justify-between text-[11px] muted"><span>Occupancy</span><span>{v.onboard}/{v.capacity}</span></div>
                <Progress value={(v.onboard / v.capacity) * 100} tone={v.onboard / v.capacity > 0.9 ? 'amber' : 'brand'} />
              </div>
              <div>
                <div className="mb-1 flex justify-between text-[11px] muted"><span className="flex items-center gap-1"><Fuel className="h-3 w-3" />Fuel</span><span>{v.fuel}%</span></div>
                <Progress value={v.fuel} tone={v.fuel < 30 ? 'red' : 'green'} />
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" className="flex-1" onClick={() => toast({ title: `Live location — ${v.no}`, desc: 'Near Marathahalli Bridge', tone: 'info' })}>Track</Button>
              <Button size="sm" variant="ghost" onClick={() => toast({ title: 'Maintenance scheduled', desc: v.no, tone: 'success' })}><Wrench className="h-4 w-4" /></Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

export function TransportTracking() {
  const toast = useToast()
  const buses = Array.from({ length: 6 }, (_, i) => {
    const r = rng(i + 900)
    return { no: `KA-01-HF-${8800 + i * 7}`, route: `R-${String(i + 1).padStart(2, '0')}`, speed: int(r, 0, 52), eta: `${int(r, 4, 28)} min`, stop: pick(r, ['Marathahalli', 'Silk Board', 'Hebbal', 'Banashankari', 'ITPL Gate']), x: 12 + int(r, 0, 70), y: 14 + int(r, 0, 66) }
  })
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2 overflow-hidden">
        <CardHeader title="Live fleet map" subtitle="Simulated positions — refreshed every 30s"
          action={<Badge tone="green" dot>Live</Badge>} />
        <div className="relative h-[420px] bg-[linear-gradient(to_right,rgba(148,163,184,.16)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,.16)_1px,transparent_1px)] bg-[size:32px_32px]">
          <div className="absolute inset-0 grid place-items-center text-[11px] muted">Map placeholder — no external tiles loaded</div>
          {buses.map((b) => (
            <button key={b.no} onClick={() => toast({ title: b.no, desc: `Near ${b.stop} · ${b.speed} km/h · ETA ${b.eta}`, tone: 'info' })}
              style={{ left: `${b.x}%`, top: `${b.y}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-600 p-1.5 text-white shadow-card ring-2 ring-white/70 dark:ring-black/40 hover:scale-110 transition-transform">
              <Bus className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      </Card>
      <Panel title="Vehicle status" subtitle="All buses currently on route">
        <div className="divide-y">
          {buses.map((b) => (
            <div key={b.no} className="px-6 py-4">
              <div className="flex items-center gap-2">
                <MapPin className="h-3.5 w-3.5 muted" />
                <p className="text-[13px] font-medium">{b.no}</p>
                <Badge tone={b.speed > 0 ? 'green' : 'amber'} >{b.speed > 0 ? 'Moving' : 'Halted'}</Badge>
              </div>
              <p className="mt-0.5 text-[11px] muted">Route {b.route} · near {b.stop} · {b.speed} km/h · ETA {b.eta}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

/* ================================================== Vendor comparison */
export function VendorComparison() {
  const toast = useToast()
  const rows = VENDORS.slice(0, 5).map((v, i) => {
    const r = rng(i + 55)
    return { vendor: v, quote: int(r, 380, 720) * 1000, delivery: int(r, 5, 28), warranty: int(r, 1, 3), rating: +(3.4 + r() * 1.5).toFixed(1) }
  })
  const best = rows.reduce((a, b) => (a.quote < b.quote ? a : b))
  return (
    <Card className="overflow-hidden">
      <CardHeader title="RFQ-0184 — Lab equipment supply" subtitle="5 quotations received · closes 18 Aug 2026"
        action={<Button size="sm" variant="primary" onClick={() => toast({ title: `PO awarded to ${best.vendor}`, tone: 'success' })}>Award PO</Button>} />
      <div className="scroll-x">
        <table className="w-full min-w-[700px] text-sm">
          <thead><tr className="border-b text-left text-[11px] uppercase muted">
            <th className="px-4 py-2">Vendor</th><th className="px-4 py-2 text-right">Quote</th><th className="px-4 py-2">Delivery</th>
            <th className="px-4 py-2">Warranty</th><th className="px-4 py-2">Rating</th><th className="px-4 py-2">Recommendation</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.vendor} className={cx('border-b last:border-0', r.vendor === best.vendor && 'bg-emerald-50/60 dark:bg-emerald-500/5')}>
                <td className="px-6 py-4 font-medium">{r.vendor}</td>
                <td className="px-6 py-4 text-right tabular-nums">{inr(r.quote)}</td>
                <td className="px-6 py-4">{r.delivery} days</td>
                <td className="px-6 py-4">{r.warranty} year(s)</td>
                <td className="px-6 py-4">★ {r.rating}</td>
                <td className="px-6 py-4">{r.vendor === best.vendor ? <Badge tone="green">Lowest quote</Badge> : <Badge tone="slate">Standard</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/* ================================================== Counselor calendar */
export function CounselorCalendar() {
  const toast = useToast()
  const slots = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00']
  const days = ['Mon 10', 'Tue 11', 'Wed 12', 'Thu 13', 'Fri 14']
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Counselling schedule" subtitle="Week of 10 Aug 2026 · click a free slot to book" />
      <div className="scroll-x p-3">
        <table className="w-full min-w-[680px] border-collapse text-xs">
          <thead><tr><th className="w-16 border-b border-r p-2 text-left text-[11px] muted">Time</th>
            {days.map((d) => <th key={d} className="border-b border-r p-2 text-left text-[11px] muted last:border-r-0">{d}</th>)}</tr></thead>
          <tbody>
            {slots.map((s, si) => (
              <tr key={s}>
                <td className="border-b border-r p-2 text-[11px] muted">{s}</td>
                {days.map((d, di) => {
                  const booked = (si * 3 + di) % 4 === 0
                  return (
                    <td key={d} className="border-b border-r p-1 last:border-r-0">
                      {booked ? (
                        <div className="rounded-lg border border-brand-200 bg-brand-50 p-1.5 dark:border-brand-500/25 dark:bg-brand-500/10">
                          <p className="truncate text-[11px] font-medium">{personName(rng(si * 10 + di))}</p>
                          <p className="text-[10px] muted">Academic stress</p>
                        </div>
                      ) : (
                        <button onClick={() => toast({ title: 'Session booked', desc: `${d} at ${s}`, tone: 'success' })}
                          className="h-full w-full rounded-lg border border-dashed py-2.5 text-[10px] muted hover:bg-slate-50 dark:hover:bg-white/5">Free</button>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/* ================================================ Discipline analytics */
export function DisciplineAnalytics() {
  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Open cases', value: '18' }, { label: 'Resolved this term', value: '64' },
        { label: 'Repeat offenders', value: '7' }, { label: 'Avg resolution', value: '4.2 days' },
      ]} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Incidents by category"><div className="p-4"><BarSeries horizontal height={240} data={[
          { name: 'Late entry', value: 42 }, { name: 'Misconduct', value: 18 }, { name: 'Plagiarism', value: 12 },
          { name: 'Property damage', value: 7 }, { name: 'Ragging complaint', value: 3 },
        ]} keys={[{ key: 'value', label: 'Cases' }]} /></div></Panel>
        <Panel title="Monthly trend"><div className="p-4"><LineSeries data={['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'].map((m, i) => ({ name: m, cases: 8 + int(rng(i + 2), 0, 14) }))} keys={[{ key: 'cases', label: 'Cases' }]} /></div></Panel>
      </div>
    </div>
  )
}

/* ================================================ Placement analytics */
export function PlacementAnalytics() {
  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Placement rate', value: '82.1%', sub: '486 of 592 eligible' },
        { label: 'Highest package', value: '₹42.0 L', sub: 'Product company' },
        { label: 'Average package', value: '₹7.8 L', sub: '+11% YoY' },
        { label: 'Recruiters', value: '128', sub: '34 new this year' },
      ]} />
      <div className="grid gap-6 xl:grid-cols-3">
        <Panel title="Offers by company" className="xl:col-span-2">
          <div className="p-4"><BarSeries horizontal height={280} data={COMPANIES.slice(0, 8).map((c, i) => ({ name: c, offers: 62 - i * 6 }))} keys={[{ key: 'offers', label: 'Offers' }]} /></div>
        </Panel>
        <Panel title="Package distribution">
          <div className="p-4"><Donut data={[{ name: '< ₹5L', value: 128 }, { name: '₹5–10L', value: 214 }, { name: '₹10–20L', value: 96 }, { name: '> ₹20L', value: 48 }]} /></div>
        </Panel>
      </div>
      <Panel title="Placement by programme">
        <div className="p-4"><BarSeries data={PROGRAMS.slice(0, 8).map((p, i) => ({ name: p.replace('B.Tech ', ''), placed: 92 - i * 6, eligible: 100 - i * 4 }))} keys={[{ key: 'placed', label: 'Placed' }, { key: 'eligible', label: 'Eligible' }]} /></div>
      </Panel>
    </div>
  )
}

/* ========================================================= Comms inbox */
const THREADS = Array.from({ length: 12 }, (_, i) => {
  const r = rng(i + 1200)
  const subjects = [
    'Fee waiver request — Semester 5', 'Timetable clash on Wednesday', 'Bonafide certificate needed urgently',
    'Hostel room change request', 'Query on placement eligibility', 'Bus route change from Monday',
    'Lab equipment purchase approval', 'Leave application — 3 days', 'Marks discrepancy in CS304',
    'Library book renewal', 'Parent-teacher meeting slot', 'Scholarship document submission',
  ]
  return {
    id: `MSG-${i}`, from: personName(r), subject: subjects[i],
    preview: 'Sharing the details as discussed. Please review and let me know if anything further is required from my side.',
    time: `${int(r, 1, 11)}:${String(int(r, 10, 59))} ${i % 2 ? 'AM' : 'PM'}`,
    unread: i < 4, tag: pick(r, ['Students', 'Faculty', 'Parents', 'Accounts']),
  }
})

export function CommsInbox() {
  const toast = useToast()
  const [sel, setSel] = useState(THREADS[0])
  const [composeOpen, setComposeOpen] = useState(false)
  const [filter, setFilter] = useState('All')
  const list = THREADS.filter((t) => filter === 'All' || t.tag === filter)

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-1">
          <CardHeader title="Inbox" subtitle={`${THREADS.filter((t) => t.unread).length} unread`}
            action={<Button size="sm" variant="primary" onClick={() => setComposeOpen(true)}>Compose</Button>} />
          <div className="border-b p-2"><Select options={['All', 'Students', 'Faculty', 'Parents', 'Accounts']} value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
          <div className="max-h-[60vh] divide-y overflow-y-auto">
            {list.map((t) => (
              <button key={t.id} onClick={() => setSel(t)}
                className={cx('block w-full px-6 py-4 text-left hover:bg-slate-50 dark:hover:bg-white/5', sel.id === t.id && 'bg-brand-50/60 dark:bg-brand-500/10')}>
                <div className="flex items-center gap-2">
                  <Avatar name={t.from} size={24} />
                  <p className={cx('flex-1 truncate text-[13px]', t.unread && 'font-semibold')}>{t.from}</p>
                  <span className="text-[10px] muted">{t.time}</span>
                </div>
                <p className={cx('mt-0.5 truncate text-[12px]', t.unread ? 'font-medium' : 'muted')}>{t.subject}</p>
              </button>
            ))}
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title={sel.subject} subtitle={`From ${sel.from} · ${sel.time} · ${sel.tag}`}
            action={<div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => toast({ title: 'Archived', tone: 'success' })}><Archive className="h-4 w-4" /></Button>
              <Button size="sm" variant="ghost" onClick={() => toast({ title: 'Moved to trash', tone: 'error' })}><Trash2 className="h-4 w-4" /></Button>
            </div>} />
          <div className="space-y-4 p-5">
            <div className="flex gap-3">
              <Avatar name={sel.from} size={32} />
              <div className="rounded-xl hairline p-3.5 text-[13px] leading-relaxed">{sel.preview}</div>
            </div>
            <div className="flex gap-3">
              <Avatar name="Priya Raghavan" size={32} />
              <div className="rounded-xl bg-brand-50 p-3.5 text-[13px] leading-relaxed dark:bg-brand-500/10">
                Thanks for writing in. I have forwarded this to the concerned department and you should hear back within two working days.
              </div>
            </div>
            <div>
              <Textarea placeholder="Write a reply…" />
              <div className="mt-2 flex gap-2">
                <Button size="sm" icon={Reply} variant="primary" onClick={() => toast({ title: 'Reply sent', desc: sel.from, tone: 'success' })}>Reply</Button>
                <Button size="sm" onClick={() => toast({ title: 'Forwarded', tone: 'success' })}>Forward</Button>
                <Button size="sm" onClick={() => toast({ title: 'Scheduled for 9:00 AM tomorrow', tone: 'success' })}>Schedule</Button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Modal open={composeOpen} onClose={() => setComposeOpen(false)} title="Compose message" size="lg"
        footer={<><Button onClick={() => setComposeOpen(false)}>Save draft</Button>
          <Button variant="primary" icon={Send} onClick={() => { setComposeOpen(false); toast({ title: 'Message queued', desc: 'Delivery status will update in the logs tab.', tone: 'success' }) }}>Send now</Button></>}>
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Audience" required><Select options={['All students', 'All faculty', 'Parents — Section B', 'Semester 5 — CSE', 'Fee defaulters']} /></Field>
            <Field label="Channel" required><Select options={['Email', 'SMS', 'Push notification', 'WhatsApp', 'All channels']} /></Field>
          </div>
          <Field label="Subject" required><Input placeholder="Semester fee — last date extended" /></Field>
          <Field label="Template"><Select options={['— None —', 'Fee reminder', 'Attendance shortage', 'Exam schedule', 'Event invite']} /></Field>
          <Field label="Message"><Textarea placeholder="Type your message…" /></Field>
          <div className="rounded-lg hairline p-3">
            <p className="text-[11px] font-semibold uppercase muted">Preview</p>
            <p className="mt-1 text-[13px]">Dear Student, the last date for semester fee payment has been extended to 22 Aug 2026. — Vivencia Institute of Technology</p>
            <p className="mt-2 text-[11px] muted">Estimated reach: 2,840 recipients · 1 SMS credit each</p>
          </div>
        </div>
      </Modal>
    </>
  )
}
