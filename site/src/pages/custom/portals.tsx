import { useState } from 'react'
import {
  BookOpen, CalendarDays, CheckSquare, CreditCard, FileText, GraduationCap, Library, MessageSquare,
  Receipt, Send, Upload, Wallet,
} from 'lucide-react'
import { Avatar, Badge, Button, Card, CardHeader, Field, Input, Modal, Progress, Select, Tabs, Textarea, useToast } from '@/components/ui'
import { DataTable } from '@/components/tables/DataTable'
import { AreaTrend, BarSeries, Donut } from '@/components/charts'
import { makeRows, parseCols, personName } from '@/data/generator'
import { COURSES, PROGRAMS, ROOMS } from '@/data/vocab'
import { cx, inr, int, rng } from '@/lib/utils'
import { ModuleShell, Panel, StatRow, type ViewProps } from './shared'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PERIODS = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00']

function MiniTimetable() {
  return (
    <div className="scroll-x">
      <table className="w-full min-w-[560px] border-collapse text-xs">
        <thead><tr><th className="w-14 border-b border-r p-1.5 text-left text-[10px] muted">Time</th>
          {DAYS.map((d) => <th key={d} className="border-b border-r p-1.5 text-left text-[10px] muted last:border-r-0">{d}</th>)}</tr></thead>
        <tbody>
          {PERIODS.map((p, pi) => (
            <tr key={p}>
              <td className="border-b border-r p-1.5 text-[10px] muted">{p}</td>
              {DAYS.map((d, di) => {
                const r = rng(pi * 13 + di + 3)
                const free = r() < 0.22
                return (
                  <td key={d} className="border-b border-r p-1 last:border-r-0">
                    {free ? <div className="rounded border border-dashed py-2 text-center text-[10px] muted">—</div> : (
                      <div className="rounded border border-brand-200 bg-brand-50 p-1.5 dark:border-brand-500/25 dark:bg-brand-500/10">
                        <p className="truncate text-[10px] font-semibold">{COURSES[(pi * 6 + di) % COURSES.length]}</p>
                        <p className="truncate text-[9px] muted">{ROOMS[(pi + di) % ROOMS.length]}</p>
                      </div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ======================================================= Student portal */
export function StudentPortal({ moduleId }: ViewProps) {
  const toast = useToast()
  const [tab, setTab] = useState('Dashboard')
  const tabs = ['Dashboard', 'Courses', 'Timetable', 'Attendance', 'Assignments', 'Exams', 'Grades', 'Fees', 'Library', 'Certificates', 'Requests', 'Profile']

  return (
    <ModuleShell moduleId={moduleId} subtitle="Aarav Sharma · VIT26CS0101 · B.Tech CSE · Semester 5">
      <Tabs value={tab} onChange={setTab} tabs={tabs.map((t) => ({ id: t, label: t }))} />
      <div className="pt-4 space-y-4">
        {tab === 'Dashboard' && (
          <>
            <StatRow items={[
              { label: 'Attendance', value: '92%', sub: 'Above 75% threshold' },
              { label: 'CGPA', value: '8.64', sub: 'Semester 4 result' },
              { label: 'Pending fees', value: '₹3,500', sub: 'Exam fee — overdue' },
              { label: 'Assignments due', value: '3', sub: 'This week' },
            ]} />
            <div className="grid gap-6 lg:grid-cols-3">
              <Panel title="Today's classes" className="lg:col-span-2">
                <div className="divide-y">
                  {COURSES.slice(0, 4).map((c, i) => (
                    <div key={c} className="flex items-center gap-3 px-6 py-4">
                      <span className="text-[12px] tabular-nums muted">{PERIODS[i]}</span>
                      <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{c}</p><p className="text-[11px] muted">{personName(rng(i + 5))} · {ROOMS[i]}</p></div>
                      <Badge tone={i === 0 ? 'green' : 'slate'}>{i === 0 ? 'Ongoing' : 'Upcoming'}</Badge>
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel title="Announcements">
                <div className="divide-y">
                  {['Semester fee deadline extended to 22 Aug', 'Sem 5 hall tickets available', 'Library open till 10 PM'].map((a) => (
                    <p key={a} className="px-6 py-4 text-[13px]">{a}</p>
                  ))}
                </div>
              </Panel>
            </div>
          </>
        )}
        {tab === 'Courses' && (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {COURSES.slice(0, 6).map((c, i) => (
              <Card key={c} className="p-4">
                <p className="text-[14px] font-semibold">{c}</p>
                <p className="mt-0.5 text-[11px] muted">{personName(rng(i))} · 4 credits</p>
                <div className="mt-3"><Progress value={40 + i * 9} /></div>
                <p className="mt-1.5 text-[11px] muted">{40 + i * 9}% complete</p>
                <Button size="sm" className="mt-3 w-full" onClick={() => toast({ title: 'Opening course', desc: c, tone: 'info' })}>Continue</Button>
              </Card>
            ))}
          </div>
        )}
        {tab === 'Timetable' && <Card><CardHeader title="Weekly timetable" subtitle="Semester 5 · Section A" /><div className="p-3"><MiniTimetable /></div></Card>}
        {tab === 'Attendance' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Subject-wise attendance">
              <div className="space-y-5 p-6">
                {COURSES.slice(0, 6).map((c, i) => {
                  const v = 96 - i * 5
                  return (
                    <div key={c}>
                      <div className="mb-1 flex justify-between text-[12px]"><span>{c}</span><span className={cx('tabular-nums', v < 75 && 'text-rose-600')}>{v}%</span></div>
                      <Progress value={v} tone={v < 75 ? 'red' : v < 85 ? 'amber' : 'green'} />
                    </div>
                  )
                })}
              </div>
            </Panel>
            <Panel title="Monthly trend"><div className="p-4"><AreaTrend data={['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'].map((m, i) => ({ name: m, attendance: 88 + int(rng(i), 0, 9) }))} keys={[{ key: 'attendance', label: 'Attendance %' }]} /></div></Panel>
          </div>
        )}
        {tab === 'Assignments' && (
          <DataTable selectable={false}
            columns={parseCols(['course:Course', 'text:Assignment@Problem Set 4,Lab Report 2,Term Paper,Case Study', 'datefuture:Due', 'status:Status@Submitted,Pending,Graded,Overdue'])}
            rows={makeRows('portal:assignments', parseCols(['course:Course', 'text:Assignment@Problem Set 4,Lab Report 2,Term Paper,Case Study', 'datefuture:Due', 'status:Status@Submitted,Pending,Graded,Overdue']), 14)} />
        )}
        {tab === 'Exams' && (
          <DataTable selectable={false}
            columns={parseCols(['course:Subject', 'datefuture:Exam Date', 'time:Start', 'room:Hall', 'int:Seat No', 'status:Hall Ticket@Generated,Pending'])}
            rows={makeRows('portal:exams', parseCols(['course:Subject', 'datefuture:Exam Date', 'time:Start', 'room:Hall', 'int:Seat No', 'status:Hall Ticket@Generated,Pending']), 8)} />
        )}
        {tab === 'Grades' && (
          <DataTable selectable={false}
            columns={parseCols(['sem:Semester', 'course:Subject', 'int:Internal', 'int:External', 'grade:Grade', 'rating:Grade Point'])}
            rows={makeRows('portal:grades', parseCols(['sem:Semester', 'course:Subject', 'int:Internal', 'int:External', 'grade:Grade', 'rating:Grade Point']), 18)} />
        )}
        {tab === 'Fees' && (
          <div className="grid gap-6 lg:grid-cols-3">
            <Panel title="Fee summary" className="lg:col-span-2">
              <div className="divide-y">
                {[['Tuition — Semester 5', 92000, 'Paid'], ['Hostel — 2026-27', 68000, 'Partial'], ['Transport — Route R-07', 24000, 'Paid'], ['Examination fee', 3500, 'Overdue']].map(([h, a, s]) => (
                  <div key={h as string} className="flex items-center gap-3 px-6 py-4">
                    <span className="min-w-0 flex-1 text-[13px] font-medium">{h}</span>
                    <span className="tabular-nums text-[13px]">{inr(a as number)}</span>
                    <Badge tone={s === 'Paid' ? 'green' : s === 'Partial' ? 'amber' : 'red'}>{s as string}</Badge>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Pay now">
              <div className="space-y-5 p-6">
                <p className="text-[13px] muted">Outstanding balance</p>
                <p className="text-2xl font-semibold">{inr(37500)}</p>
                <Button variant="primary" className="w-full" icon={CreditCard}
                  onClick={() => toast({ title: 'Payment successful', desc: 'Receipt RCP-40221 generated · status changed to Paid.', tone: 'success' })}>Pay ₹37,500</Button>
                <Button className="w-full" icon={Receipt} onClick={() => toast({ title: 'Receipts downloaded', tone: 'success' })}>Download receipts</Button>
              </div>
            </Panel>
          </div>
        )}
        {tab === 'Library' && (
          <DataTable selectable={false}
            columns={parseCols(['text:Title@Introduction to Algorithms,Operating System Concepts,Compiler Design', 'date:Issued', 'date:Due', 'moneysm:Fine', 'status:Status@Issued,Returned,Overdue'])}
            rows={makeRows('portal:library', parseCols(['text:Title@Introduction to Algorithms,Operating System Concepts,Compiler Design', 'date:Issued', 'date:Due', 'moneysm:Fine', 'status:Status@Issued,Returned,Overdue']), 8)} />
        )}
        {tab === 'Certificates' && (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {['Bonafide Certificate', 'Course Completion', 'Character Certificate', 'Sports Participation'].map((c) => (
              <Card key={c} className="p-4">
                <FileText className="h-5 w-5 muted" />
                <p className="mt-2 text-[13px] font-semibold">{c}</p>
                <Button size="sm" className="mt-3 w-full" onClick={() => toast({ title: 'Request submitted', desc: c, tone: 'success' })}>Request</Button>
              </Card>
            ))}
          </div>
        )}
        {tab === 'Requests' && <RequestForm />}
        {tab === 'Profile' && (
          <Card className="p-5">
            <div className="flex items-center gap-4">
              <Avatar name="Aarav Sharma" size={64} />
              <div><p className="text-base font-semibold">Aarav Sharma</p><p className="text-[13px] muted">VIT26CS0101 · B.Tech Computer Science · Semester 5</p></div>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Field label="Email"><Input defaultValue="aarav.sharma@vivencia.edu.in" /></Field>
              <Field label="Phone"><Input defaultValue="+91 98450 12345" /></Field>
              <Field label="Address"><Input defaultValue="42 MG Road, Bengaluru 560001" /></Field>
              <Field label="Guardian"><Input defaultValue="Rakesh Sharma · +91 98860 44321" /></Field>
            </div>
          </Card>
        )}
      </div>
    </ModuleShell>
  )
}

function RequestForm() {
  const toast = useToast()
  const [type, setType] = useState('Bonafide certificate')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  return (
    <Card className="p-5">
      <p className="mb-4 text-sm font-semibold">Raise a request</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Request type" required>
          <Select options={['Bonafide certificate', 'Duplicate ID card', 'Transcript', 'Bus pass', 'Leave application']} value={type} onChange={(e) => setType(e.target.value)} />
        </Field>
        <Field label="Needed by"><Input type="date" /></Field>
      </div>
      <div className="mt-3">
        <Field label="Reason" required error={error}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Briefly describe why you need this…" />
        </Field>
      </div>
      <Button variant="primary" className="mt-3"
        onClick={() => {
          if (!reason.trim()) { setError('Please provide a reason'); return }
          setError(''); setReason('')
          toast({ title: 'Request submitted', desc: `${type} · reference REQ-${Math.floor(Math.random() * 9000 + 1000)}`, tone: 'success' })
        }}>Submit request</Button>
    </Card>
  )
}

/* ======================================================== Parent portal */
export function ParentPortal({ moduleId }: ViewProps) {
  const toast = useToast()
  const [tab, setTab] = useState('Child profile')
  const tabs = ['Child profile', 'Attendance', 'Timetable', 'Homework', 'Results', 'Fees', 'Messages', 'Transport', 'Events', 'Leave request']

  return (
    <ModuleShell moduleId={moduleId} subtitle="Guardian view · Aarav Sharma (B.Tech CSE, Semester 5)">
      <Tabs value={tab} onChange={setTab} tabs={tabs.map((t) => ({ id: t, label: t }))} />
      <div className="pt-4 space-y-4">
        {tab === 'Child profile' && (
          <>
            <StatRow items={[
              { label: 'Attendance', value: '92%' }, { label: 'CGPA', value: '8.64' },
              { label: 'Fees due', value: '₹37,500' }, { label: 'Discipline', value: 'Clear' },
            ]} />
            <Card className="p-5">
              <div className="flex items-center gap-4">
                <Avatar name="Aarav Sharma" size={64} />
                <div>
                  <p className="text-base font-semibold">Aarav Sharma</p>
                  <p className="text-[13px] muted">VIT26CS0101 · Section A · Mentor: Dr. Meera Nair</p>
                  <div className="mt-2 flex gap-1.5">
                    <Badge tone="green">Attendance healthy</Badge><Badge tone="amber">Exam fee pending</Badge><Badge tone="blue">Transport R-07</Badge>
                  </div>
                </div>
              </div>
            </Card>
          </>
        )}
        {tab === 'Attendance' && <Panel title="Attendance by subject"><div className="p-4"><BarSeries horizontal height={260} data={COURSES.slice(0, 6).map((c, i) => ({ name: c.split(' ')[0], value: 96 - i * 5 }))} keys={[{ key: 'value', label: 'Attendance %' }]} /></div></Panel>}
        {tab === 'Timetable' && <Card><CardHeader title="Weekly timetable" /><div className="p-3"><MiniTimetable /></div></Card>}
        {tab === 'Homework' && (
          <DataTable selectable={false}
            columns={parseCols(['course:Subject', 'text:Homework@Chapter 5 exercises,Lab record,Presentation,Reading', 'datefuture:Due', 'status:Status@Submitted,Pending,Overdue'])}
            rows={makeRows('parent:homework', parseCols(['course:Subject', 'text:Homework@Chapter 5 exercises,Lab record,Presentation,Reading', 'datefuture:Due', 'status:Status@Submitted,Pending,Overdue']), 12)} />
        )}
        {tab === 'Results' && (
          <DataTable selectable={false}
            columns={parseCols(['sem:Semester', 'course:Subject', 'int:Marks', 'grade:Grade', 'status:Result@Passed,Failed'])}
            rows={makeRows('parent:results', parseCols(['sem:Semester', 'course:Subject', 'int:Marks', 'grade:Grade', 'status:Result@Passed,Failed']), 14)} />
        )}
        {tab === 'Fees' && (
          <Card className="p-5">
            <p className="text-sm font-semibold">Outstanding balance</p>
            <p className="mt-1 text-2xl font-semibold">{inr(37500)}</p>
            <p className="mt-1 text-[12px] muted">Hostel fee (partial) and examination fee pending</p>
            <Button variant="primary" className="mt-3" icon={Wallet} onClick={() => toast({ title: 'Payment successful', desc: 'Receipt emailed to the registered address.', tone: 'success' })}>Pay now</Button>
          </Card>
        )}
        {tab === 'Messages' && (
          <Card className="p-5 space-y-3">
            {[['Dr. Meera Nair', 'Aarav has been doing well in the internal assessments.'], ['Accounts Office', 'Kindly clear the pending examination fee before 22 Aug.']].map(([f, m]) => (
              <div key={f} className="flex gap-3">
                <Avatar name={f} size={30} />
                <div className="rounded-lg hairline p-3 text-[13px]"><p className="font-medium">{f}</p><p className="mt-0.5 muted">{m}</p></div>
              </div>
            ))}
            <div className="flex gap-2"><Input placeholder="Write a message…" /><Button variant="primary" icon={Send} onClick={() => toast({ title: 'Message sent', tone: 'success' })}>Send</Button></div>
          </Card>
        )}
        {tab === 'Transport' && (
          <Card className="p-5">
            <p className="text-sm font-semibold">Route R-07 — Whitefield</p>
            <p className="mt-1 text-[13px] muted">Bus KA-01-HF-8842 · Driver: Suresh Kumar · Stop: Marathahalli (07:15 AM)</p>
            <Badge tone="green" dot>On route · ETA 12 min</Badge>
          </Card>
        )}
        {tab === 'Events' && (
          <DataTable selectable={false}
            columns={parseCols(['text:Event@Parent-Teacher Meeting,Annual Day,Sports Meet,Convocation', 'datefuture:Date', 'room:Venue', 'status:RSVP@Confirmed,Pending,Declined'])}
            rows={makeRows('parent:events', parseCols(['text:Event@Parent-Teacher Meeting,Annual Day,Sports Meet,Convocation', 'datefuture:Date', 'room:Venue', 'status:RSVP@Confirmed,Pending,Declined']), 8)} />
        )}
        {tab === 'Leave request' && <RequestForm />}
      </div>
    </ModuleShell>
  )
}

/* ======================================================= Faculty portal */
export function FacultyPortal({ moduleId }: ViewProps) {
  const toast = useToast()
  const [tab, setTab] = useState('Classes')
  const tabs = ['Classes', 'Timetable', 'Attendance', 'Assignments', 'Gradebook', 'Students', 'Leave', 'Workload', 'Messages', 'Reports']

  return (
    <ModuleShell moduleId={moduleId} subtitle="Dr. Priya Raghavan · Computer Science & Engineering">
      <Tabs value={tab} onChange={setTab} tabs={tabs.map((t) => ({ id: t, label: t }))} />
      <div className="pt-4 space-y-4">
        {tab === 'Classes' && (
          <>
            <StatRow items={[
              { label: 'Sections', value: '6' }, { label: 'Students', value: '284' },
              { label: 'Weekly hours', value: '18' }, { label: 'Pending grading', value: '42' },
            ]} />
            <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {COURSES.slice(0, 6).map((c, i) => (
                <Card key={c} className="p-4">
                  <p className="text-[14px] font-semibold">{c}</p>
                  <p className="mt-0.5 text-[11px] muted">Section {String.fromCharCode(65 + (i % 4))} · {int(rng(i), 38, 62)} students</p>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" className="flex-1" onClick={() => toast({ title: 'Attendance sheet opened', desc: c, tone: 'info' })}>Mark attendance</Button>
                    <Button size="sm" variant="ghost" onClick={() => toast({ title: 'Gradebook opened', desc: c, tone: 'info' })}>Grades</Button>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
        {tab === 'Timetable' && <Card><CardHeader title="My timetable" subtitle="18 teaching hours this week" /><div className="p-3"><MiniTimetable /></div></Card>}
        {tab === 'Attendance' && (
          <DataTable selectable={false}
            columns={parseCols(['course:Course', 'text:Section@A,B,C,D', 'date:Date', 'int:Present', 'int:Absent', 'status:Status@Submitted,Pending'])}
            rows={makeRows('faculty:attendance', parseCols(['course:Course', 'text:Section@A,B,C,D', 'date:Date', 'int:Present', 'int:Absent', 'status:Status@Submitted,Pending']), 18)} />
        )}
        {tab === 'Assignments' && (
          <DataTable selectable={false}
            columns={parseCols(['course:Course', 'text:Assignment@Problem Set,Lab Report,Term Paper', 'datefuture:Due', 'int:Submissions', 'int:To Grade', 'status:Status@Open,Grading,Closed'])}
            rows={makeRows('faculty:assignments', parseCols(['course:Course', 'text:Assignment@Problem Set,Lab Report,Term Paper', 'datefuture:Due', 'int:Submissions', 'int:To Grade', 'status:Status@Open,Grading,Closed']), 14)} />
        )}
        {tab === 'Gradebook' && (
          <DataTable selectable={false}
            columns={parseCols(['person:Student', 'course:Course', 'int:Internal', 'int:External', 'grade:Grade', 'status:Status@Draft,Locked,Published'])}
            rows={makeRows('faculty:gradebook', parseCols(['person:Student', 'course:Course', 'int:Internal', 'int:External', 'grade:Grade', 'status:Status@Draft,Locked,Published']), 30)} />
        )}
        {tab === 'Students' && (
          <DataTable selectable={false}
            columns={parseCols(['person:Student', 'program:Programme', 'pct:Attendance', 'rating:CGPA', 'status:Flag@Regular,Shortage,At Risk'])}
            rows={makeRows('faculty:students', parseCols(['person:Student', 'program:Programme', 'pct:Attendance', 'rating:CGPA', 'status:Flag@Regular,Shortage,At Risk']), 34)} />
        )}
        {tab === 'Leave' && <RequestForm />}
        {tab === 'Workload' && (
          <Panel title="My workload" subtitle="Weekly hours">
            <div className="p-4"><BarSeries data={[{ name: 'Teaching', value: 18 }, { name: 'Research', value: 6 }, { name: 'Admin', value: 4 }, { name: 'Mentoring', value: 3 }]} keys={[{ key: 'value', label: 'Hours' }]} /></div>
          </Panel>
        )}
        {tab === 'Messages' && (
          <Card className="p-5 space-y-3">
            {[['HOD — CSE', 'Please submit the Sem 5 internal marks by Friday.'], ['Exam Cell', 'Invigilation duty assigned for 12 Aug, Hall B-301.']].map(([f, m]) => (
              <div key={f} className="flex gap-3"><Avatar name={f} size={30} />
                <div className="rounded-lg hairline p-3 text-[13px]"><p className="font-medium">{f}</p><p className="mt-0.5 muted">{m}</p></div>
              </div>
            ))}
          </Card>
        )}
        {tab === 'Reports' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Class performance"><div className="p-4"><Donut data={[{ name: 'A+/A', value: 84 }, { name: 'B+/B', value: 122 }, { name: 'C', value: 58 }, { name: 'Fail', value: 20 }]} /></div></Panel>
            <Panel title="Attendance trend"><div className="p-4"><AreaTrend data={['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'].map((m, i) => ({ name: m, attendance: 86 + int(rng(i + 1), 0, 11) }))} keys={[{ key: 'attendance', label: 'Attendance %' }]} /></div></Panel>
          </div>
        )}
      </div>
    </ModuleShell>
  )
}
