import { useMemo, useState } from 'react'
import {
  ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, Clock, Download, Filter, GripVertical,
  Lock, Mail, Phone, Plus, Save, Search, Star, TriangleAlert, Trophy, Upload, Users, Video, Wand2,
} from 'lucide-react'
import {
  Avatar, Badge, Button, Card, CardHeader, Checkbox, Drawer, Field, Input, Modal, Progress,
  Select, Tabs, Textarea, useToast,
} from '@/components/ui'
import { DataTable } from '@/components/tables/DataTable'
import { AreaTrend, BarSeries, Donut, RadarSpread } from '@/components/charts'
import { makeRows, parseCols, personName } from '@/data/generator'
import { COURSES, DEPARTMENTS, FIRST, LAST, PROGRAMS, ROOMS } from '@/data/vocab'
import { admissionsTrend, studentDistribution } from '@/data/dashboard'
import { cx, dateOffset, fmtDate, inr, inrCompact, int, num, pick, rng, TODAY } from '@/lib/utils'
import { MoveToStageMenu, Panel, StatRow, type ViewProps } from './shared'

/* ==================================================== Admissions overview */
export function AdmissionsOverview() {
  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Open leads', value: '326', sub: '+42 this week' },
        { label: 'Applications', value: '114', sub: 'Pending review' },
        { label: 'Offers sent', value: '186', sub: '72% acceptance' },
        { label: 'Enrolled', value: '412', sub: 'Target 480' },
      ]} />
      <div className="grid gap-6 xl:grid-cols-3">
        <Panel title="Funnel by month" subtitle="Leads → applications → enrolments" className="xl:col-span-2">
          <div className="p-4"><BarSeries data={admissionsTrend} keys={[{ key: 'leads', label: 'Leads' }, { key: 'applications', label: 'Applications' }, { key: 'enrolled', label: 'Enrolled' }]} /></div>
        </Panel>
        <Panel title="Source mix" subtitle="Where leads come from">
          <div className="p-4"><Donut data={[
            { name: 'Website', value: 128 }, { name: 'Referral', value: 74 }, { name: 'Education fair', value: 52 },
            { name: 'Paid ads', value: 44 }, { name: 'Walk-in', value: 28 },
          ]} /></div>
        </Panel>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Counsellor performance" subtitle="Conversion this term">
          <div className="divide-y">
            {['Nikhil Verma', 'Tara Menon', 'Rehan Qureshi', 'Divya Pillai', 'Omkar Joshi'].map((n, i) => {
              const conv = 42 - i * 5
              return (
                <div key={n} className="flex items-center gap-3 px-6 py-4">
                  <Avatar name={n} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">{n}</p>
                    <p className="text-[11px] muted">{60 - i * 6} leads · {24 - i * 3} enrolments</p>
                  </div>
                  <div className="w-28"><Progress value={conv} tone={conv > 35 ? 'green' : 'amber'} /></div>
                  <span className="w-10 text-right text-[13px] tabular-nums">{conv}%</span>
                </div>
              )
            })}
          </div>
        </Panel>
        <Panel title="Programme demand" subtitle="Applications per programme">
          <div className="p-4"><BarSeries horizontal height={250} data={PROGRAMS.slice(0, 7).map((p, i) => ({ name: p.replace('B.Tech ', ''), applications: 120 - i * 13 }))} keys={[{ key: 'applications', label: 'Applications' }]} /></div>
        </Panel>
      </div>
    </div>
  )
}

/* ================================================= Admissions lead board */
const STAGES = ['New', 'Contacted', 'Test Scheduled', 'Interviewed', 'Offer Sent', 'Enrolled'] as const

interface Lead { id: string; name: string; program: string; source: string; owner: string; value: number; stage: string; phone: string; email: string }

function seedLeads(): Lead[] {
  return Array.from({ length: 34 }, (_, i) => {
    const r = rng(9100 + i)
    const name = `${pick(r, FIRST)} ${pick(r, LAST)}`
    return {
      id: `LEAD-${2600 + i}`,
      name,
      program: pick(r, PROGRAMS),
      source: pick(r, ['Website', 'Referral', 'Education Fair', 'Google Ads', 'Walk-in']),
      owner: pick(r, ['Nikhil Verma', 'Tara Menon', 'Rehan Qureshi', 'Divya Pillai']),
      value: int(r, 90, 320) * 1000,
      stage: STAGES[Math.min(STAGES.length - 1, int(r, 0, 5))],
      phone: `+91 ${int(r, 70, 99)}${int(r, 10000, 99999)}${int(r, 100, 999)}`,
      email: `${name.toLowerCase().replace(/\s/g, '.')}@gmail.com`,
    }
  })
}

export function AdmissionsPipeline() {
  const toast = useToast()
  const [leads, setLeads] = useState<Lead[]>(seedLeads)
  const [q, setQ] = useState('')
  const [owner, setOwner] = useState('All owners')
  const [active, setActive] = useState<Lead | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [view, setView] = useState<'board' | 'table'>('board')

  const filtered = leads.filter((l) =>
    (owner === 'All owners' || l.owner === owner) &&
    (l.name.toLowerCase().includes(q.toLowerCase()) || l.program.toLowerCase().includes(q.toLowerCase())))

  const move = (id: string, stage: string) => {
    setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, stage } : l)))
    toast({ title: `Lead moved to ${stage}`, desc: id, tone: 'success' })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search leads…" className="field pl-8" />
        </div>
        <Select className="w-auto" options={['All owners', 'Nikhil Verma', 'Tara Menon', 'Rehan Qureshi', 'Divya Pillai']} value={owner} onChange={(e) => setOwner(e.target.value)} />
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-lg hairline p-0.5">
            {(['board', 'table'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)}
                className={cx('rounded-md px-2.5 py-1 text-xs font-medium capitalize', view === v ? 'bg-brand-600 text-white' : 'muted')}>{v}</button>
            ))}
          </div>
          <Button size="sm" icon={Upload} onClick={() => toast({ title: 'Import leads', desc: 'CSV mapping is mocked.', tone: 'info' })}>Import</Button>
          <Button size="sm" variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>Add lead</Button>
        </div>
      </div>

      {view === 'table' ? (
        <DataTable
          columns={parseCols(['id:Lead ID', 'person:Name', 'program:Program', 'source:Source', 'person:Counsellor', 'status:Stage@New,Contacted,Test Scheduled,Interviewed,Offer Sent,Enrolled'])}
          rows={filtered.map((l) => ({ _id: l.id, lead_id: l.id, name: l.name, program: l.program, source: l.source, counsellor: l.owner, stage: l.stage }))}
          onRowClick={(r) => setActive(leads.find((l) => l.id === r._id) ?? null)}
        />
      ) : (
        <div className="scroll-x pb-2">
          <div className="flex min-w-max gap-3">
            {STAGES.map((stage) => {
              const items = filtered.filter((l) => l.stage === stage)
              const total = items.reduce((s, l) => s + l.value, 0)
              return (
                <div
                  key={stage}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (dragId) move(dragId, stage); setDragId(null) }}
                  className="w-[80vw] max-w-[264px] shrink-0 rounded-xl bg-slate-50 dark:bg-white/[0.03] hairline sm:w-[264px]"
                >
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <span className="text-[13px] font-semibold">{stage}</span>
                    <Badge tone="slate">{items.length}</Badge>
                  </div>
                  <p className="px-3 pt-2 text-[11px] muted">Pipeline value {inrCompact(total)}</p>
                  <div className="max-h-[58vh] space-y-2 overflow-y-auto p-2">
                    {items.map((l) => (
                      <div
                        key={l.id}
                        draggable
                        onDragStart={() => setDragId(l.id)}
                        onClick={() => setActive(l)}
                        className="card bento-interactive cursor-pointer p-2.5"
                      >
                        <div className="flex items-start gap-2">
                          <GripVertical className="mt-0.5 hidden h-3.5 w-3.5 shrink-0 muted sm:block" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium">{l.name}</p>
                            <p className="truncate text-[11px] muted">{l.program}</p>
                          </div>
                          <span className="sm:hidden" onClick={(e) => e.stopPropagation()}>
                            <MoveToStageMenu stages={STAGES} current={l.stage} onMove={(to: string) => move(l.id, to)} />
                          </span>
                        </div>
                        <div className="mt-2 flex items-center justify-between">
                          <Badge tone="blue">{l.source}</Badge>
                          <span className="text-[11px] tabular-nums muted">{inrCompact(l.value)}</span>
                        </div>
                        <div className="mt-2 flex items-center gap-1.5">
                          <Avatar name={l.owner} size={18} />
                          <span className="truncate text-[10px] muted">{l.owner}</span>
                        </div>
                      </div>
                    ))}
                    {items.length === 0 && <p className="px-2 py-6 text-center text-[11px] muted">Drop a lead here</p>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <LeadDrawer lead={active} onClose={() => setActive(null)} onMove={move} />
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add admission lead"
        footer={<><Button onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => {
            const n = `${pick(rng(Date.now() % 99991), FIRST)} ${pick(rng(Date.now() % 7919), LAST)}`
            setLeads((ls) => [{ id: `LEAD-${9000 + ls.length}`, name: n, program: PROGRAMS[0], source: 'Website', owner: 'Nikhil Verma', value: 180000, stage: 'New', phone: '+91 98765 43210', email: 'new.lead@gmail.com' }, ...ls])
            setAddOpen(false); toast({ title: 'Lead created', desc: 'Added to the New column.', tone: 'success' })
          }}>Create lead</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name" required><Input placeholder="e.g. Aarav Sharma" /></Field>
          <Field label="Phone" required><Input placeholder="+91" /></Field>
          <Field label="Email"><Input placeholder="name@example.com" /></Field>
          <Field label="Programme of interest"><Select options={PROGRAMS.slice(0, 12)} /></Field>
          <Field label="Source"><Select options={['Website', 'Referral', 'Education Fair', 'Google Ads', 'Walk-in']} /></Field>
          <Field label="Assign counsellor"><Select options={['Nikhil Verma', 'Tara Menon', 'Rehan Qureshi']} /></Field>
        </div>
      </Modal>
    </div>
  )
}

function LeadDrawer({ lead, onClose, onMove }: { lead: Lead | null; onClose: () => void; onMove: (id: string, stage: string) => void }) {
  const toast = useToast()
  const [tab, setTab] = useState('overview')
  if (!lead) return null
  return (
    <Drawer
      open={!!lead} onClose={onClose}
      title={<span className="flex items-center gap-2"><Avatar name={lead.name} size={26} />{lead.name}</span>}
      subtitle={`${lead.id} · ${lead.program}`}
      footer={
        <>
          <Button size="sm" icon={Phone} onClick={() => toast({ title: 'Call scheduled', desc: 'Tomorrow 11:00 AM', tone: 'success' })}>Schedule call</Button>
          <Button size="sm" icon={Mail} onClick={() => toast({ title: 'Email sent', desc: lead.email, tone: 'success' })}>Send email</Button>
          <Button size="sm" variant="primary" icon={ArrowRight}
            onClick={() => { const i = STAGES.indexOf(lead.stage as any); onMove(lead.id, STAGES[Math.min(i + 1, STAGES.length - 1)]); onClose() }}>
            Advance stage
          </Button>
        </>
      }
    >
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'overview', label: 'Overview' }, { id: 'activity', label: 'Activity' },
        { id: 'documents', label: 'Documents' }, { id: 'notes', label: 'Notes' },
      ]} />
      <div className="p-5">
        {tab === 'overview' && (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {[['Stage', lead.stage], ['Source', lead.source], ['Counsellor', lead.owner], ['Phone', lead.phone],
            ['Email', lead.email], ['Expected fee', inr(lead.value)], ['Campus', 'Main Campus — Bengaluru'], ['Created', fmtDate(dateOffset(-18))]].map(([k, v]) => (
              <div key={k}><dt className="text-[11px] uppercase tracking-wide muted">{k}</dt><dd className="mt-0.5 text-sm">{v}</dd></div>
            ))}
          </dl>
        )}
        {tab === 'activity' && (
          <ol className="relative space-y-4 border-l pl-4">
            {[['Lead captured from website form', '18 Jul 2026 · 10:24'], ['Counsellor assigned — Nikhil Verma', '18 Jul 2026 · 11:02'],
            ['Introductory call completed (8 min)', '19 Jul 2026 · 15:40'], ['Entrance test slot shared', '24 Jul 2026 · 09:10'],
            ['Documents requested', '02 Aug 2026 · 16:30']].map(([t, s]) => (
              <li key={t} className="relative">
                <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-brand-500 ring-4 ring-[rgb(var(--surface))]" />
                <p className="text-[13px] font-medium">{t}</p><p className="text-[11px] muted">{s}</p>
              </li>
            ))}
          </ol>
        )}
        {tab === 'documents' && (
          <div className="space-y-2">
            {['10th Marksheet', '12th Marksheet', 'Aadhaar', 'Photograph'].map((d, i) => (
              <div key={d} className="flex items-center gap-3 rounded-lg hairline px-3 py-2.5">
                <span className="text-sm">{d}</span>
                <Badge tone={i < 2 ? 'green' : 'amber'}>{i < 2 ? 'Verified' : 'Pending'}</Badge>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => toast({ title: 'Document requested', desc: d, tone: 'info' })}>Request</Button>
              </div>
            ))}
          </div>
        )}
        {tab === 'notes' && (
          <>
            <Textarea placeholder="Add a note about this lead…" />
            <Button size="sm" className="mt-2" onClick={() => toast({ title: 'Note added', tone: 'success' })}>Save note</Button>
          </>
        )}
      </div>
    </Drawer>
  )
}

export function AdmissionsReports() {
  return (
    <div className="space-y-10">
      <StatRow cols={4} items={[
        { label: 'Lead → application', value: '38.4%' }, { label: 'Application → offer', value: '61.2%' },
        { label: 'Offer → enrolment', value: '72.0%' }, { label: 'Avg. cycle time', value: '21 days' },
      ]} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Conversion by source"><div className="p-4"><BarSeries data={[
          { name: 'Referral', value: 44 }, { name: 'Website', value: 31 }, { name: 'Fair', value: 27 },
          { name: 'Google Ads', value: 19 }, { name: 'Walk-in', value: 38 },
        ]} keys={[{ key: 'value', label: 'Conversion %' }]} /></div></Panel>
        <Panel title="Intake vs target by programme"><div className="p-4"><BarSeries data={PROGRAMS.slice(0, 6).map((p, i) => ({ name: p.replace('B.Tech ', ''), intake: 90 - i * 8, target: 100 - i * 5 }))} keys={[{ key: 'intake', label: 'Intake' }, { key: 'target', label: 'Target' }]} /></div></Panel>
      </div>
    </div>
  )
}

/* ================================================== Student directory/profile */
export function StudentsDirectory() {
  const [openId, setOpenId] = useState<string | null>(null)
  const cols = useMemo(() => parseCols([
    'id:Student ID', 'person:Name', 'program:Programme', 'sem:Semester', 'batch:Batch',
    'pct:Attendance', 'rating:CGPA', 'status:Fee Status@Paid,Partial,Overdue', 'status:Status@Active,On Leave,Suspended,Graduated',
  ]), [])
  const rows = useMemo(() => makeRows('students:directory', cols, 60), [cols])
  const toast = useToast()
  const active = rows.find((r) => r._id === openId)

  return (
    <>
      <DataTable
        columns={cols} rows={rows} onRowClick={(r) => setOpenId(r._id)}
        toolbar={<Button size="sm" variant="primary" icon={Plus} onClick={() => toast({ title: 'Add student', desc: 'Opens the admission conversion form.', tone: 'info' })}>Add student</Button>}
        bulkActions={(ids, clear) => (
          <>
            <Button size="sm" onClick={() => { toast({ title: `${ids.length} students promoted to next semester`, tone: 'success' }); clear() }}>Promote</Button>
            <Button size="sm" onClick={() => { toast({ title: `Notification sent to ${ids.length} students`, tone: 'success' }); clear() }}>Notify</Button>
            <Button size="sm" onClick={() => { toast({ title: `${ids.length} ID cards queued for printing`, tone: 'success' }); clear() }}>Generate ID</Button>
          </>
        )}
      />
      {active && <StudentProfile row={active} onClose={() => setOpenId(null)} />}
    </>
  )
}

function StudentProfile({ row, onClose }: { row: any; onClose: () => void }) {
  const toast = useToast()
  const [tab, setTab] = useState('profile')
  const name = row.name as string
  const r = rng(name.length * 7919)

  return (
    <Drawer
      open onClose={onClose} width="max-w-3xl"
      title={<span className="flex items-center gap-2"><Avatar name={name} size={30} />{name}</span>}
      subtitle={`${row.student_id} · ${row.programme} · ${row.batch}`}
      footer={
        <>
          <Button size="sm" onClick={() => toast({ title: 'Profile PDF generated', tone: 'success' })}>Download profile</Button>
          <Button size="sm" onClick={() => toast({ title: 'Bonafide certificate generated', tone: 'success' })}>Generate certificate</Button>
          <Button size="sm" onClick={() => toast({ title: 'Student promoted to next semester', tone: 'success' })}>Promote</Button>
          <Button size="sm" variant="danger" onClick={() => toast({ title: 'Student suspended', desc: 'Guardian notified.', tone: 'error' })}>Suspend</Button>
        </>
      }
    >
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'profile', label: 'Profile' }, { id: 'academics', label: 'Academics' }, { id: 'attendance', label: 'Attendance' },
        { id: 'fees', label: 'Fees' }, { id: 'documents', label: 'Documents' }, { id: 'timeline', label: 'Timeline' },
      ]} />
      <div className="p-5">
        {tab === 'profile' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-4 rounded-xl hairline p-4">
              <Avatar name={name} size={64} />
              <div className="min-w-0">
                <p className="text-base font-semibold">{name}</p>
                <p className="text-[13px] muted">{row.programme} · {row.semester} · Section {row.batch?.split('Sec ')[1] ?? 'A'}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge tone="blue">{row.student_id}</Badge>
                  <Badge tone="green">Attendance {row.attendance}</Badge>
                  <Badge tone="violet">CGPA {row.cgpa}</Badge>
                  <Badge tone={row.fee_status === 'Paid' ? 'green' : 'amber'}>Fees {row.fee_status}</Badge>
                  <Badge tone="slate">Hostel: Ganga Block A-214</Badge>
                  <Badge tone="slate">Transport: Route R-07</Badge>
                </div>
              </div>
            </div>
            <Section title="Contact">
              <Info label="Email" value={`${name.toLowerCase().replace(/\s/g, '.')}@vivencia.edu.in`} />
              <Info label="Phone" value={`+91 ${int(r, 70, 99)}${int(r, 10000, 99999)}${int(r, 100, 999)}`} />
              <Info label="Address" value={`${int(r, 1, 99)}, MG Road, Bengaluru 560001`} />
              <Info label="Emergency contact" value={`${pick(r, FIRST)} ${pick(r, LAST)} · +91 98${int(r, 100, 999)}${int(r, 10000, 99999)}`} />
            </Section>
            <Section title="Guardian">
              <Info label="Father" value={`${pick(r, FIRST)} ${name.split(' ')[1]}`} />
              <Info label="Mother" value={`${pick(r, FIRST)} ${name.split(' ')[1]}`} />
              <Info label="Occupation" value={pick(r, ['Business', 'Service', 'Doctor', 'Engineer'])} />
              <Info label="Annual income" value={inr(int(r, 6, 24) * 100000)} />
            </Section>
            <Section title="Previous education">
              <Info label="School" value="St. Joseph's Higher Secondary" />
              <Info label="Board" value="CBSE" />
              <Info label="Class 12 %" value={`${int(r, 72, 96)}%`} />
              <Info label="Year" value="2023" />
            </Section>
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide muted">Tags</p>
              <div className="flex flex-wrap gap-1.5">
                {['Merit scholar', 'Robotics Club', 'Hostel resident', 'Placement eligible'].map((t) => <Badge key={t} tone="slate">{t}</Badge>)}
              </div>
            </div>
          </div>
        )}
        {tab === 'academics' && (
          <div className="space-y-10">
            <div className="grid gap-3 sm:grid-cols-3">
              {[['CGPA', row.cgpa], ['Credits earned', '112'], ['Backlogs', '0']].map(([k, v]) => (
                <div key={k as string} className="card p-3"><p className="text-[11px] muted">{k}</p><p className="mt-1 text-lg font-semibold">{v}</p></div>
              ))}
            </div>
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-[11px] uppercase muted"><th className="py-2">Subject</th><th>Internal</th><th>External</th><th>Grade</th></tr></thead>
              <tbody>
                {COURSES.slice(0, 6).map((c, i) => {
                  const rr = rng(i + name.length)
                  return (
                    <tr key={c} className="border-b last:border-0">
                      <td className="py-2">{c}</td><td>{int(rr, 24, 40)}/40</td><td>{int(rr, 32, 58)}/60</td>
                      <td><Badge tone="green">{pick(rr, ['A+', 'A', 'B+'])}</Badge></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {tab === 'attendance' && <AttendanceHeatmap />}
        {tab === 'fees' && (
          <div className="space-y-6">
            {[['Tuition fee — Sem 5', 92000, 'Paid'], ['Hostel fee — 2026-27', 68000, 'Partial'], ['Transport — Route R-07', 24000, 'Paid'], ['Exam fee — Sem 5', 3500, 'Overdue']].map(([h, a, s]) => (
              <div key={h as string} className="flex items-center gap-3 rounded-lg hairline px-3 py-2.5">
                <div className="min-w-0"><p className="text-[13px] font-medium">{h}</p><p className="text-[11px] muted">Due {fmtDate(dateOffset(-6))}</p></div>
                <span className="ml-auto text-[13px] tabular-nums">{inr(a as number)}</span>
                <Badge tone={s === 'Paid' ? 'green' : s === 'Partial' ? 'amber' : 'red'}>{s as string}</Badge>
              </div>
            ))}
            <Button size="sm" variant="primary" onClick={() => toast({ title: 'Payment recorded', desc: 'Receipt RCP-40218 generated.', tone: 'success' })}>Record payment</Button>
          </div>
        )}
        {tab === 'documents' && (
          <div className="space-y-2">
            {['Birth Certificate', 'Aadhaar', 'Class 12 Marksheet', 'Transfer Certificate', 'Passport Photo'].map((d, i) => (
              <div key={d} className="flex items-center gap-3 rounded-lg hairline px-3 py-2.5">
                <span className="text-sm">{d}</span>
                <Badge tone={i < 3 ? 'green' : 'amber'}>{i < 3 ? 'Verified' : 'Pending'}</Badge>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => toast({ title: 'Preview', desc: `${d}.pdf`, tone: 'info' })}>Preview</Button>
              </div>
            ))}
          </div>
        )}
        {tab === 'timeline' && (
          <ol className="relative space-y-4 border-l pl-4">
            {[['Enrolled in B.Tech CSE', 'Aug 2023'], ['Promoted to Semester 3', 'Aug 2024'], ['Merit scholarship awarded', 'Sep 2024'],
            ['Joined Robotics Club', 'Oct 2024'], ['Promoted to Semester 5', 'Aug 2025'], ['Placement registration completed', 'Jul 2026']].map(([t, s]) => (
              <li key={t} className="relative">
                <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-brand-500 ring-4 ring-[rgb(var(--surface))]" />
                <p className="text-[13px] font-medium">{t}</p><p className="text-[11px] muted">{s}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Drawer>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide muted">{title}</p>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">{children}</dl>
    </div>
  )
}
function Info({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[11px] muted">{label}</dt><dd className="text-sm">{value}</dd></div>
}

function AttendanceHeatmap() {
  const days = Array.from({ length: 140 }, (_, i) => {
    const r = rng(i * 31 + 7)
    return r() > 0.12 ? (r() > 0.06 ? 2 : 1) : 0
  })
  const tone = ['bg-rose-400', 'bg-amber-400', 'bg-emerald-400']
  return (
    <div>
      <div className="mb-3 flex items-center gap-3 text-[11px] muted">
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-emerald-400" /> Present</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-amber-400" /> Late</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-rose-400" /> Absent</span>
      </div>
      <div className="grid grid-flow-col grid-rows-7 gap-1">
        {days.map((d, i) => <span key={i} className={cx('h-3.5 w-3.5 rounded-[3px]', tone[d])} title={`Day ${i + 1}`} />)}
      </div>
      <div className="mt-4"><AreaTrend height={180} data={['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'].map((m, i) => ({ name: m, attendance: 88 + int(rng(i + 3), 0, 9) }))} keys={[{ key: 'attendance', label: 'Attendance %' }]} /></div>
    </div>
  )
}

/* ==================================================== Academic calendar */
export function AcademicCalendar() {
  const [month, setMonth] = useState(0)
  const base = new Date(TODAY.getFullYear(), TODAY.getMonth() + month, 1)
  const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
  const first = base.getDay()
  const events: Record<number, { label: string; tone: any }[]> = {
    3: [{ label: 'Semester begins', tone: 'blue' }], 8: [{ label: 'Sem 5 exams', tone: 'amber' }],
    12: [{ label: 'Guest lecture', tone: 'violet' }], 15: [{ label: 'Independence Day', tone: 'green' }],
    18: [{ label: 'Fee deadline', tone: 'red' }], 22: [{ label: 'NAAC visit', tone: 'amber' }],
    27: [{ label: 'Sports meet', tone: 'green' }],
  }
  return (
    <Card>
      <CardHeader
        title={base.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
        subtitle="Institutional academic calendar"
        action={<div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setMonth(month - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" onClick={() => setMonth(0)}>Today</Button>
          <Button size="sm" variant="ghost" onClick={() => setMonth(month + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>}
      />
      <div className="scroll-x p-3">
        <div className="min-w-[680px]">
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium muted">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="py-1">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {[...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)].map((d, i) => (
              <div key={i} className={cx('min-h-[86px] rounded-lg hairline p-1.5', d === null && 'opacity-0',
                month === 0 && d === TODAY.getDate() && 'ring-2 ring-brand-500')}>
                <span className="text-[11px] font-medium">{d}</span>
                <div className="mt-1 space-y-1">
                  {month === 0 && d && events[d]?.map((e) => <Badge key={e.label} tone={e.tone}>{e.label}</Badge>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  )
}

/* ======================================================== Timetable grid */
const PERIODS = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00']
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Slot { id: string; day: string; period: string; course: string; faculty: string; room: string }

export function TimetableGrid() {
  const toast = useToast()
  const [slots, setSlots] = useState<Slot[]>(() => {
    const out: Slot[] = []
    DAYS.forEach((day, di) => PERIODS.forEach((p, pi) => {
      const r = rng(di * 100 + pi + 17)
      if (r() > 0.28) out.push({ id: `${di}-${pi}`, day, period: p, course: pick(r, COURSES), faculty: personName(r), room: pick(r, ROOMS) })
    }))
    return out
  })
  const [drag, setDrag] = useState<Slot | null>(null)
  const [sel, setSel] = useState<Slot | null>(null)
  const [published, setPublished] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)

  const drop = (day: string, period: string) => {
    if (!drag) return
    const occupied = slots.find((s) => s.day === day && s.period === period && s.id !== drag.id)
    if (occupied) {
      setConflict(`${occupied.course} already occupies ${day} ${period} in ${occupied.room}.`)
      setDrag(null)
      return
    }
    setSlots((ss) => ss.map((s) => (s.id === drag.id ? { ...s, day, period } : s)))
    toast({ title: 'Class moved', desc: `${drag.course} → ${day} ${period}`, tone: 'success' })
    setDrag(null)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" options={PROGRAMS.slice(0, 8)} />
        <Select className="w-auto" options={['Semester 5', 'Semester 3', 'Semester 1']} />
        <Select className="w-auto" options={['Section A', 'Section B', 'Section C']} />
        <div className="ml-auto flex gap-2">
          <Button size="sm" icon={Wand2}
            onClick={() => {
              // Re-seed every slot: the "solver" is simulated, but it demonstrates
              // the generate-then-review flow a real scheduler uses.
              const out: Slot[] = []
              const seed = Math.floor(Math.random() * 9999)
              DAYS.forEach((day, di) => PERIODS.forEach((p, pi) => {
                const r = rng(seed + di * 100 + pi + 17)
                if (r() > 0.22) out.push({ id: `${di}-${pi}`, day, period: p, course: pick(r, COURSES), faculty: personName(r), room: pick(r, ROOMS) })
              }))
              setSlots(out)
              setPublished(false)
              toast({ title: 'Timetable generated', desc: `${out.length} periods placed · 0 conflicts · review before publishing.`, tone: 'success' })
            }}>
            Auto-generate
          </Button>
          <Button size="sm" onClick={() => window.print()}>Print timetable</Button>
          <Button size="sm" variant="primary" onClick={() => { setPublished(true); toast({ title: 'Timetable published', desc: 'Visible to students and faculty.', tone: 'success' }) }}>
            Publish
          </Button>
        </div>
      </div>
      {published && <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200"><Check className="h-4 w-4" /> Published to 6 sections · version 4</div>}

      <Card className="overflow-hidden">
        <div className="scroll-x">
          <table className="w-full min-w-[840px] border-collapse text-xs">
            <thead>
              <tr>
                <th className="w-20 border-b border-r p-2 text-left text-[11px] uppercase muted">Time</th>
                {DAYS.map((d) => <th key={d} className="border-b border-r p-2 text-left text-[11px] uppercase muted last:border-r-0">{d}</th>)}
              </tr>
            </thead>
            <tbody>
              {PERIODS.map((p) => (
                <tr key={p}>
                  <td className="border-b border-r p-2 align-top text-[11px] muted">{p}</td>
                  {DAYS.map((d) => {
                    const slot = slots.find((s) => s.day === d && s.period === p)
                    return (
                      <td key={d} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(d, p)}
                        className="h-[74px] border-b border-r p-1 align-top last:border-r-0">
                        {slot ? (
                          <div draggable onDragStart={() => setDrag(slot)} onClick={() => setSel(slot)}
                            className="h-full cursor-pointer rounded-lg border border-brand-200 bg-brand-50 p-1.5 hover:shadow-card dark:border-brand-500/25 dark:bg-brand-500/10">
                            <p className="truncate text-[11px] font-semibold leading-tight">{slot.course}</p>
                            <p className="truncate text-[10px] muted">{slot.faculty}</p>
                            <p className="truncate text-[10px] muted">{slot.room}</p>
                          </div>
                        ) : <div className="grid h-full place-items-center rounded-lg border border-dashed text-[10px] muted">Free</div>}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Free-room finder" subtitle="Rooms available right now">
          <div className="flex flex-wrap gap-1.5 p-4">{ROOMS.slice(0, 8).map((r) => <Badge key={r} tone="green">{r}</Badge>)}</div>
        </Panel>
        <Panel title="Faculty availability" subtitle="This slot">
          <div className="divide-y">
            {['Meera Nair', 'Rohan Desai', 'Kavya Iyer'].map((n, i) => (
              <div key={n} className="flex items-center gap-2 px-4 py-2">
                <Avatar name={n} size={22} /><span className="text-[13px]">{n}</span>
                <Badge tone={i === 1 ? 'red' : 'green'}>{i === 1 ? 'Busy' : 'Available'}</Badge>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Workload check" subtitle="Weekly hours vs cap">
          <div className="space-y-2.5 p-4">
            {[['Meera Nair', 18, 20], ['Rohan Desai', 22, 20], ['Kavya Iyer', 14, 20]].map(([n, h, cap]) => (
              <div key={n as string}>
                <div className="mb-1 flex justify-between text-[11px]"><span>{n}</span><span className="tabular-nums">{h}/{cap} hrs</span></div>
                <Progress value={((h as number) / (cap as number)) * 100} tone={(h as number) > (cap as number) ? 'red' : 'brand'} />
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Modal open={!!conflict} onClose={() => setConflict(null)} title="Scheduling conflict" size="sm"
        footer={<><Button onClick={() => setConflict(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => { setConflict(null); toast({ title: 'Conflict resolved', desc: 'Class reassigned to Lab-CS2.', tone: 'success' }) }}>Auto-resolve</Button></>}>
        <div className="flex gap-2.5"><TriangleAlert className="h-5 w-5 shrink-0 text-amber-500" /><p className="text-sm muted">{conflict}</p></div>
      </Modal>

      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.course ?? ''} subtitle="Class session"
        footer={<><Button onClick={() => setSel(null)}>Close</Button>
          <Button variant="primary" onClick={() => { setSel(null); toast({ title: 'Room reassigned', tone: 'success' }) }}>Assign room</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Faculty"><Select options={[sel?.faculty ?? '', 'Meera Nair', 'Rohan Desai']} /></Field>
          <Field label="Room"><Select options={ROOMS} /></Field>
          <Field label="Day"><Select options={DAYS} /></Field>
          <Field label="Period"><Select options={PERIODS} /></Field>
        </div>
      </Modal>
    </div>
  )
}

/* ================================================== Attendance marking */
export function AttendanceMarking() {
  const toast = useToast()
  const students = useMemo(() => Array.from({ length: 32 }, (_, i) => {
    const r = rng(555 + i)
    return { id: `VIT26CS${String(101 + i).padStart(4, '0')}`, name: personName(r) }
  }), [])
  const [state, setState] = useState<Record<string, string>>(() =>
    Object.fromEntries(students.map((s, i) => [s.id, i % 11 === 0 ? 'Absent' : i % 7 === 0 ? 'Late' : 'Present'])))
  const [saved, setSaved] = useState(false)

  const counts = ['Present', 'Absent', 'Late', 'Excused', 'Leave'].map((k) => ({ k, n: Object.values(state).filter((v) => v === k).length }))
  const pct = Math.round((counts[0].n / students.length) * 100)

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" options={PROGRAMS.slice(0, 6)} />
        <Select className="w-auto" options={['Semester 5', 'Semester 3']} />
        <Select className="w-auto" options={COURSES.slice(0, 6)} />
        <Input type="date" className="w-auto" defaultValue="2026-08-08" />
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => { setState(Object.fromEntries(students.map((s) => [s.id, 'Present']))); toast({ title: 'All marked present', tone: 'success' }) }}>Mark all present</Button>
          <Button size="sm" variant="primary" icon={Save} onClick={() => { setSaved(true); toast({ title: 'Attendance saved', desc: `${counts[0].n}/${students.length} present`, tone: 'success' }) }}>Save</Button>
        </div>
      </div>

      <StatRow cols={5} items={[
        { label: 'Class strength', value: String(students.length) },
        ...counts.slice(0, 3).map((c) => ({ label: c.k, value: String(c.n) })),
        { label: 'Percentage', value: `${pct}%` },
      ]} />

      <Card className="overflow-hidden">
        <CardHeader title="Mark attendance" subtitle="Tap a state to change it — RFID, QR and biometric feeds are simulated"
          action={<div className="flex gap-1.5">{['RFID', 'QR', 'Biometric', 'Face'].map((d) => <Badge key={d} tone="green" dot>{d}</Badge>)}</div>} />
        <div className="divide-y">
          {students.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
              <Avatar name={s.name} size={26} />
              <div className="min-w-0"><p className="text-[13px] font-medium">{s.name}</p><p className="text-[11px] muted">{s.id}</p></div>
              <div className="ml-auto flex flex-wrap gap-1">
                {['Present', 'Absent', 'Late', 'Excused', 'Leave'].map((k) => (
                  <button key={k} onClick={() => { setState((st) => ({ ...st, [s.id]: k })); setSaved(false) }}
                    className={cx('rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                      state[s.id] === k
                        ? k === 'Present' ? 'border-emerald-500 bg-emerald-500 text-white'
                          : k === 'Absent' ? 'border-rose-500 bg-rose-500 text-white'
                            : k === 'Late' ? 'border-amber-500 bg-amber-500 text-white'
                              : 'border-brand-500 bg-brand-500 text-white'
                        : 'muted hover:bg-slate-100 dark:hover:bg-white/5')}>
                    {k}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
      {saved && <p className="text-[13px] text-emerald-600">Saved locally at {new Date().toLocaleTimeString()} — prototype state only.</p>}
    </div>
  )
}

export function AttendanceReports() {
  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Institute average', value: '92.4%', sub: 'Target 90%' },
        { label: 'Below 75%', value: '146', sub: 'Students at risk' },
        { label: 'Perfect attendance', value: '318', sub: 'This semester' },
        { label: 'Device uptime', value: '97.8%', sub: '18 devices' },
      ]} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Monthly trend"><div className="p-4"><AreaTrend data={['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'].map((m, i) => ({ name: m, students: 89 + int(rng(i), 0, 6), faculty: 93 + int(rng(i + 9), 0, 5) }))} keys={[{ key: 'students', label: 'Students' }, { key: 'faculty', label: 'Faculty' }]} /></div></Panel>
        <Panel title="Department comparison"><div className="p-4"><BarSeries horizontal height={250} data={DEPARTMENTS.slice(0, 7).map((d, i) => ({ name: d.split(' ')[0], value: 96 - i * 2 }))} keys={[{ key: 'value', label: 'Attendance %' }]} /></div></Panel>
      </div>
      <Panel title="Low attendance alerts" subtitle="Students below the 75% eligibility threshold">
        <DataTable
          columns={parseCols(['person:Student', 'program:Programme', 'pct:Attendance', 'int:Classes Missed', 'status:Notice@Sent,Pending,Escalated'])}
          rows={makeRows('attendance:low', parseCols(['person:Student', 'program:Programme', 'pct:Attendance', 'int:Classes Missed', 'status:Notice@Sent,Pending,Escalated']), 24)}
          selectable={false}
        />
      </Panel>
    </div>
  )
}

/* ========================================================== Marks entry */
export function MarksEntry() {
  const toast = useToast()
  const [locked, setLocked] = useState(false)
  const students = useMemo(() => Array.from({ length: 22 }, (_, i) => {
    const r = rng(777 + i)
    return { id: `VIT26CS${String(101 + i).padStart(4, '0')}`, name: personName(r), internal: int(r, 22, 40), external: int(r, 30, 60) }
  }), [])
  const [marks, setMarks] = useState(students)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" options={COURSES.slice(0, 6)} />
        <Select className="w-auto" options={['End Semester', 'Mid Semester', 'Internal Assessment']} />
        <div className="ml-auto flex gap-2">
          <Button size="sm" icon={Upload} onClick={() => toast({ title: 'Import marks', desc: 'Template mapping mocked.', tone: 'info' })}>Import</Button>
          <Button size="sm" onClick={() => toast({ title: 'Moderation applied', desc: '+2 marks to 4 borderline students.', tone: 'success' })}>Apply moderation</Button>
          <Button size="sm" variant="primary" icon={Lock} disabled={locked}
            onClick={() => { setLocked(true); toast({ title: 'Grades locked', desc: 'Further edits require HOD approval.', tone: 'success' }) }}>
            {locked ? 'Locked' : 'Lock grades'}
          </Button>
        </div>
      </div>
      <Card className="overflow-hidden">
        <div className="scroll-x">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="surface"><tr className="border-b text-left text-[11px] uppercase muted">
              <th className="px-3 py-2">Roll No</th><th className="px-3 py-2">Student</th>
              <th className="px-3 py-2 w-32">Internal /40</th><th className="px-3 py-2 w-32">External /60</th>
              <th className="px-3 py-2">Total</th><th className="px-3 py-2">Grade</th>
            </tr></thead>
            <tbody>
              {marks.map((m, i) => {
                const total = m.internal + m.external
                const grade = total >= 90 ? 'A+' : total >= 80 ? 'A' : total >= 70 ? 'B+' : total >= 60 ? 'B' : total >= 50 ? 'C' : 'D'
                return (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="px-3 py-1.5 text-[13px]">{m.id}</td>
                    <td className="px-3 py-1.5 text-[13px] font-medium">{m.name}</td>
                    <td className="px-3 py-1.5">
                      <input disabled={locked} type="number" value={m.internal} max={40}
                        onChange={(e) => setMarks((ms) => ms.map((x, xi) => (xi === i ? { ...x, internal: Math.min(40, +e.target.value) } : x)))}
                        className="field h-8 w-20 disabled:opacity-50" />
                    </td>
                    <td className="px-3 py-1.5">
                      <input disabled={locked} type="number" value={m.external} max={60}
                        onChange={(e) => setMarks((ms) => ms.map((x, xi) => (xi === i ? { ...x, external: Math.min(60, +e.target.value) } : x)))}
                        className="field h-8 w-20 disabled:opacity-50" />
                    </td>
                    <td className="px-3 py-1.5 tabular-nums">{total}</td>
                    <td className="px-3 py-1.5"><Badge tone={total >= 80 ? 'green' : total >= 60 ? 'blue' : 'amber'}>{grade}</Badge></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

/* ================================================================= LMS */
export function LmsCourses() {
  const toast = useToast()
  const courses = COURSES.slice(0, 9).map((c, i) => {
    const r = rng(i + 41)
    return { name: c, faculty: personName(r), students: int(r, 40, 180), progress: int(r, 25, 96), lessons: int(r, 12, 42) }
  })
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="space-y-10">
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {courses.map((c) => (
          <Card key={c.name} className="overflow-hidden">
            <div className="h-20 bg-gradient-to-br from-brand-500 to-brand-700" />
            <div className="p-4">
              <p className="truncate text-[14px] font-semibold">{c.name}</p>
              <p className="mt-0.5 text-[12px] muted">{c.faculty} · {c.lessons} lessons · {c.students} enrolled</p>
              <div className="mt-3"><Progress value={c.progress} /></div>
              <div className="mt-1.5 flex items-center justify-between text-[11px] muted"><span>Average completion</span><span>{c.progress}%</span></div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" className="flex-1" onClick={() => setOpen(c.name)}>Open course</Button>
                <Button size="sm" variant="ghost" onClick={() => toast({ title: 'Live class starting', desc: c.name, tone: 'info' })}><Video className="h-4 w-4" /></Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ?? ''} size="lg" subtitle="Course workspace">
        <div className="space-y-10">
          <div className="grid aspect-video place-items-center rounded-xl bg-slate-900 text-white">
            <div className="text-center"><Video className="mx-auto h-8 w-8 opacity-70" /><p className="mt-2 text-sm opacity-70">Lecture video player (placeholder)</p></div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {['Unit 1 — Slides.pdf', 'Unit 2 — Reading list.pdf', 'Lab notebook.ipynb', 'Reference dataset.csv'].map((f) => (
              <div key={f} className="flex items-center gap-2 rounded-lg hairline px-3 py-2 text-sm"><Download className="h-4 w-4 muted" />{f}</div>
            ))}
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase muted">Discussion</p>
            {['Will Unit 4 be included in the mid-sem?', 'Sharing my notes for the lab session.'].map((d, i) => (
              <div key={d} className="mb-2 flex gap-2 rounded-lg hairline p-2.5">
                <Avatar name={i ? 'Riya Sharma' : 'Kabir Rao'} size={24} />
                <div><p className="text-[13px]">{d}</p><p className="text-[11px] muted">{i ? 'Riya Sharma' : 'Kabir Rao'} · 3 replies</p></div>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  )
}

export function LmsGamification() {
  const leaders = Array.from({ length: 10 }, (_, i) => {
    const r = rng(i + 71)
    return { name: personName(r), points: 4800 - i * 240, badges: 12 - i }
  })
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Panel title="Leaderboard" subtitle="Top learners this semester" className="lg:col-span-2">
        <div className="divide-y">
          {leaders.map((l, i) => (
            <div key={l.name} className="flex items-center gap-3 px-6 py-4">
              <span className={cx('grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold',
                i === 0 ? 'bg-amber-100 text-amber-700' : i < 3 ? 'bg-slate-100 text-slate-700' : 'muted')}>{i + 1}</span>
              <Avatar name={l.name} size={26} />
              <p className="flex-1 truncate text-[13px] font-medium">{l.name}</p>
              <Badge tone="violet">{l.badges} badges</Badge>
              <span className="w-16 text-right text-[13px] tabular-nums">{num(l.points)}</span>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Badges" subtitle="Earned across the cohort">
        <div className="grid grid-cols-3 gap-3 p-4">
          {['Fast Starter', 'Quiz Ace', 'Perfect Week', 'Helper', 'Night Owl', 'Streak 30'].map((b, i) => (
            <div key={b} className="flex flex-col items-center gap-1.5 rounded-lg hairline p-3 text-center">
              <Trophy className={cx('h-5 w-5', i % 2 ? 'text-amber-500' : 'text-brand-500')} />
              <span className="text-[11px] font-medium leading-tight">{b}</span>
              <span className="text-[10px] muted">{200 - i * 24} earned</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}
