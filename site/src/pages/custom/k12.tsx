import { useMemo, useState } from 'react'
import {
  BadgeCheck, CalendarClock, Check, Download, LogIn, LogOut, Printer, QrCode, Send,
  Sparkles, TriangleAlert, UserCheck, Wand2, X,
} from 'lucide-react'
import {
  Avatar, Badge, Button, Card, CardHeader, Checkbox, Field, Input, Modal, Progress,
  Select, Textarea, useToast,
} from '@/components/ui'
import { DataTable } from '@/components/tables/DataTable'
import { makeRows, parseCols, personName } from '@/data/generator'
import { CBSE_GRADES, CLASSES, CO_SCHOLASTIC, SCHOOL_SUBJECTS, VISIT_PURPOSES } from '@/data/vocab'
import { cx, dateOffset, fmtDate, int, pick, rng, TODAY } from '@/lib/utils'
import { Panel, StatRow, type ViewProps } from './shared'

/* ======================================================== Report card */
/** A CBSE-style term report: scholastic marks split across four components,
 *  co-scholastic areas graded on a 3-point scale, plus attendance and remarks. */
export function ReportCard() {
  const toast = useToast()
  const [cls, setCls] = useState('Class VIII-B')
  const [term, setTerm] = useState('Term 2')
  const [published, setPublished] = useState(false)
  const [student, setStudent] = useState(0)

  const students = useMemo(
    () => Array.from({ length: 8 }, (_, i) => personName(rng(4200 + i))),
    [],
  )
  const name = students[student]
  const r = rng(name.length * 31 + student)

  const subjects = SCHOOL_SUBJECTS.slice(0, 6).map((s, i) => {
    const rr = rng(i + name.length)
    const pt = int(rr, 12, 20), nb = int(rr, 3, 5), se = int(rr, 3, 5), term1 = int(rr, 45, 80)
    const total = pt + nb + se + term1
    const grade = total >= 91 ? 'A1' : total >= 81 ? 'A2' : total >= 71 ? 'B1' : total >= 61 ? 'B2' : total >= 51 ? 'C1' : 'C2'
    return { subject: s, pt, nb, se, term: term1, total, grade }
  })
  const overall = Math.round(subjects.reduce((a, s) => a + s.total, 0) / subjects.length)

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-auto" options={CLASSES.slice(0, 12)} value={cls} onChange={(e) => setCls(e.target.value)} />
        <Select className="w-auto" options={['Term 1', 'Term 2', 'Term 3']} value={term} onChange={(e) => setTerm(e.target.value)} />
        <Select className="w-auto" options={students} value={name} onChange={(e) => setStudent(students.indexOf(e.target.value))} />
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" icon={Printer} onClick={() => window.print()}>Print</Button>
          <Button size="sm" icon={Download} onClick={() => toast({ title: 'Report cards exported', desc: `${cls} — ${term} · 38 PDFs`, tone: 'success' })}>Bulk export</Button>
          <Button size="sm" variant="primary" icon={Send} disabled={published}
            onClick={() => { setPublished(true); toast({ title: 'Report cards published', desc: '38 parents notified by SMS and app push.', tone: 'success' }) }}>
            {published ? 'Published' : 'Publish to parents'}
          </Button>
        </div>
      </div>

      {published && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200">
          <Check className="h-4 w-4" /> {cls} · {term} published — visible in the parent portal
        </div>
      )}

      <Card className="print-area">
        <div className="border-b px-5 py-4 text-center">
          <p className="text-[15px] font-semibold">Vivencia Institute of Technology</p>
          <p className="text-[11px] muted">Main Campus — Bengaluru · Affiliated to CBSE · Affiliation No. 830142</p>
          <p className="mt-2 text-[13px] font-medium">Report Card — {term}, Academic Year 2026–27</p>
        </div>

        <div className="grid gap-x-6 gap-y-2 border-b px-5 py-3 sm:grid-cols-4">
          {[['Student', name], ['Class', cls], ['Admission No', `VIT26${1000 + student}`], ['Roll No', String(student + 1)],
          ['Father', `${pick(r, ['Rakesh', 'Suresh', 'Anil'])} ${name.split(' ')[1]}`], ['Mother', `${pick(r, ['Sunita', 'Kavita', 'Meena'])} ${name.split(' ')[1]}`],
          ['Date of Birth', fmtDate(dateOffset(-int(r, 4200, 4800)))], ['Attendance', `${int(r, 84, 98)}%`]].map(([k, v]) => (
            <div key={k}><p className="text-[10px] uppercase muted">{k}</p><p className="text-[13px] font-medium">{v}</p></div>
          ))}
        </div>

        <div className="px-5 py-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide muted">Part 1 — Scholastic areas</p>
          <div className="scroll-x">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b text-left text-[10px] uppercase muted">
                  <th className="py-2">Subject</th>
                  <th className="py-2 text-right">Periodic Test<br /><span className="normal-case">(20)</span></th>
                  <th className="py-2 text-right">Notebook<br /><span className="normal-case">(5)</span></th>
                  <th className="py-2 text-right">Subject Enrich.<br /><span className="normal-case">(5)</span></th>
                  <th className="py-2 text-right">Term Exam<br /><span className="normal-case">(80)</span></th>
                  <th className="py-2 text-right">Total<br /><span className="normal-case">(110)</span></th>
                  <th className="py-2 text-center">Grade</th>
                </tr>
              </thead>
              <tbody>
                {subjects.map((s) => (
                  <tr key={s.subject} className="border-b last:border-0">
                    <td className="py-2 font-medium">{s.subject}</td>
                    <td className="py-2 text-right tabular-nums">{s.pt}</td>
                    <td className="py-2 text-right tabular-nums">{s.nb}</td>
                    <td className="py-2 text-right tabular-nums">{s.se}</td>
                    <td className="py-2 text-right tabular-nums">{s.term}</td>
                    <td className="py-2 text-right font-semibold tabular-nums">{s.total}</td>
                    <td className="py-2 text-center"><Badge tone={/A/.test(s.grade) ? 'green' : /B/.test(s.grade) ? 'blue' : 'amber'}>{s.grade}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wide muted">Part 2 — Co-scholastic areas (3-point scale)</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {CO_SCHOLASTIC.map((c, i) => (
              <div key={c} className="flex items-center gap-3 rounded-lg hairline px-3 py-2">
                <span className="flex-1 text-[13px]">{c}</span>
                <Badge tone={i % 3 === 0 ? 'green' : i % 3 === 1 ? 'blue' : 'amber'}>{['A', 'B', 'C'][i % 3]}</Badge>
              </div>
            ))}
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg hairline p-3">
              <p className="text-[10px] uppercase muted">Overall</p>
              <p className="text-xl font-semibold tabular-nums">{overall}/110</p>
            </div>
            <div className="rounded-lg hairline p-3">
              <p className="text-[10px] uppercase muted">Result</p>
              <p className="mt-1"><Badge tone="green">Promoted to next class</Badge></p>
            </div>
            <div className="rounded-lg hairline p-3">
              <p className="text-[10px] uppercase muted">Rank in class</p>
              <p className="text-xl font-semibold tabular-nums">{int(r, 1, 12)} / 38</p>
            </div>
          </div>

          <div className="mt-6">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide muted">Class teacher's remark</p>
            <Textarea defaultValue={pick(r, [
              'A consistent performer who participates well in class discussions. Should work on presentation in Mathematics.',
              'Shows great improvement this term. Encouraged to read more widely to strengthen written expression.',
              'An excellent all-rounder. Keep up the enthusiasm in co-curricular activities.',
            ])} />
          </div>

          <div className="mt-6 flex justify-between text-[11px] muted">
            <span>Class Teacher</span><span>Principal</span><span>Parent's Signature</span>
          </div>
        </div>
      </Card>
    </div>
  )
}

/* ==================================================== Homework assign */
export function HomeworkAssign() {
  const toast = useToast()
  const [cls, setCls] = useState('Class VIII-B')
  const [subject, setSubject] = useState(SCHOOL_SUBJECTS[2])
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [notify, setNotify] = useState(true)
  const [assigned, setAssigned] = useState<{ cls: string; subject: string; text: string; due: string }[]>([])

  const submit = () => {
    if (!text.trim()) { setErr('Describe the homework before assigning'); return }
    setErr('')
    setAssigned((a) => [{ cls, subject, text, due: fmtDate(dateOffset(1)) }, ...a])
    setText('')
    toast({
      title: 'Homework assigned',
      desc: `${cls} · ${subject}${notify ? ' — 38 parents notified in the diary' : ''}`,
      tone: 'success',
    })
  }

  return (
    <div className="space-y-10">
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Assign homework" subtitle="Posts to the student app and the parent digital diary" />
          <div className="space-y-5 p-6">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Class" required><Select options={CLASSES.slice(0, 12)} value={cls} onChange={(e) => setCls(e.target.value)} /></Field>
              <Field label="Subject" required><Select options={SCHOOL_SUBJECTS.slice(0, 10)} value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
              <Field label="Due date" required><Input type="date" defaultValue="2026-08-09" /></Field>
            </div>
            <Field label="Homework" required error={err}>
              <Textarea value={text} onChange={(e) => setText(e.target.value)}
                placeholder="e.g. Complete exercise 5.2 questions 1–12 in the notebook and revise the chapter summary." />
            </Field>
            <div className="flex flex-wrap items-center gap-4">
              <Checkbox checked={notify} onChange={setNotify} label="Notify parents in the diary" />
              <Button size="sm" icon={Sparkles} onClick={() => {
                setText('Complete exercise 5.2 (questions 1–12) in your notebook. Revise the chapter summary and attempt the two sample word problems discussed in class today.')
                toast({ title: 'Draft generated', desc: 'Edit before assigning.', tone: 'info' })
              }}>Draft with AI</Button>
              <Button variant="primary" className="ml-auto" onClick={submit}>Assign homework</Button>
            </div>
          </div>
        </Card>

        <Panel title="Today's diary" subtitle={`${assigned.length} entries added this session`}>
          <div className="max-h-[340px] divide-y overflow-y-auto">
            {assigned.length === 0 && <p className="px-4 py-8 text-center text-[12px] muted">Nothing assigned yet — the diary fills as you post.</p>}
            {assigned.map((a, i) => (
              <div key={i} className="px-6 py-4">
                <p className="text-[13px] font-medium">{a.subject} · {a.cls}</p>
                <p className="mt-0.5 text-[12px] muted">{a.text}</p>
                <p className="mt-1 text-[11px] muted">Due {a.due}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Submission tracker" subtitle="Live status for the selected class">
        <DataTable
          selectable={false} pageSize={8}
          columns={parseCols(['person:Student', 'course:Subject', 'date:Submitted', 'status:Status@Submitted,Late,Not Submitted,Graded', 'grade:Grade'])}
          rows={makeRows('homework:tracker', parseCols(['person:Student', 'course:Subject', 'date:Submitted', 'status:Status@Submitted,Late,Not Submitted,Graded', 'grade:Grade']), 30)}
        />
      </Panel>
    </div>
  )
}

/* ====================================================== Substitutions */
/** Absent teachers on the left, the engine's proposed cover on the right.
 *  Proposals are ranked by free periods and subject match. */
export function Substitutions() {
  const toast = useToast()
  const [filled, setFilled] = useState<Record<string, string>>({})

  const gaps = useMemo(() => Array.from({ length: 6 }, (_, i) => {
    const r = rng(6100 + i)
    return {
      id: `SUB-${i}`,
      absent: personName(r),
      subject: pick(r, SCHOOL_SUBJECTS.slice(0, 8)),
      cls: pick(r, CLASSES.slice(0, 12)),
      period: `Period ${int(r, 1, 8)}`,
      time: `${String(int(r, 9, 15)).padStart(2, '0')}:00`,
      candidates: Array.from({ length: 3 }, (_, j) => {
        const rr = rng(6100 + i * 10 + j)
        return { name: personName(rr), free: int(rr, 1, 4), match: j === 0 ? 'Same subject' : j === 1 ? 'Same department' : 'Free period only', load: int(rr, 12, 22) }
      }),
    }
  }), [])

  const unfilled = gaps.filter((g) => !filled[g.id]).length

  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Teachers absent today', value: '6', sub: '3 on approved leave' },
        { label: 'Periods to cover', value: String(gaps.length) },
        { label: 'Still unfilled', value: String(unfilled), sub: unfilled ? 'Needs attention' : 'All covered' },
        { label: 'Avg substitute load', value: '17 hrs', sub: 'Cap 20 hrs' },
      ]} />

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={Wand2}
          onClick={() => {
            const auto: Record<string, string> = {}
            gaps.forEach((g) => { auto[g.id] = g.candidates[0].name })
            setFilled(auto)
            toast({ title: 'Substitutions auto-assigned', desc: `${gaps.length} periods covered, ranked by subject match and free load.`, tone: 'success' })
          }}>
          Auto-assign all
        </Button>
        <Button size="sm" onClick={() => { setFilled({}); toast({ title: 'Assignments cleared', tone: 'info' }) }}>Clear</Button>
        <Button size="sm" icon={Send} className="ml-auto"
          onClick={() => toast({ title: 'Substitutes notified', desc: 'SMS and app push sent to covering teachers.', tone: 'success' })}>
          Notify substitutes
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {gaps.map((g) => (
          <Card key={g.id} className={cx('p-4', filled[g.id] && 'border-emerald-300 dark:border-emerald-500/40')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">{g.subject} · {g.cls}</p>
                <p className="text-[11px] muted">{g.period} at {g.time} — {g.absent} absent</p>
              </div>
              {filled[g.id]
                ? <Badge tone="green" dot>Covered</Badge>
                : <Badge tone="red" dot>Unfilled</Badge>}
            </div>

            {filled[g.id] ? (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 dark:bg-emerald-500/10">
                <UserCheck className="h-4 w-4 text-emerald-600" />
                <span className="text-[13px] font-medium">{filled[g.id]}</span>
                <Button size="sm" variant="ghost" className="ml-auto"
                  onClick={() => setFilled((f) => { const n = { ...f }; delete n[g.id]; return n })}>Change</Button>
              </div>
            ) : (
              <div className="mt-3 space-y-1.5">
                {g.candidates.map((c) => (
                  <button key={c.name}
                    onClick={() => { setFilled((f) => ({ ...f, [g.id]: c.name })); toast({ title: `${c.name} assigned`, desc: `${g.subject} · ${g.cls} · ${g.period}`, tone: 'success' }) }}
                    className="flex w-full items-center gap-2.5 rounded-lg hairline px-3 py-2 text-left hover:bg-accent">
                    <Avatar name={c.name} size={24} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{c.name}</p>
                      <p className="text-[11px] muted">{c.match} · {c.free} free periods · {c.load} hrs/week</p>
                    </div>
                    <Badge tone={c.match === 'Same subject' ? 'green' : c.match === 'Same department' ? 'blue' : 'slate'}>
                      {c.match === 'Same subject' ? 'Best' : c.match === 'Same department' ? 'Good' : 'Fallback'}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}

/* ========================================================== Gate pass */
export function GatePass() {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [inside, setInside] = useState(() => Array.from({ length: 7 }, (_, i) => {
    const r = rng(7700 + i)
    return {
      id: `GP-${4200 + i}`, name: personName(r), type: pick(r, ['Visitor', 'Parent', 'Vendor', 'Contractor']),
      purpose: pick(r, VISIT_PURPOSES), host: personName(rng(7800 + i)),
      inTime: `${String(int(r, 8, 15)).padStart(2, '0')}:${pick(r, ['05', '20', '35', '50'])}`,
      pass: `P-${int(r, 100, 999)}`,
    }
  }))

  return (
    <div className="space-y-10">
      <StatRow items={[
        { label: 'Currently inside', value: String(inside.length), sub: 'Live count' },
        { label: 'Passes issued today', value: '34' },
        { label: 'Avg visit duration', value: '24 min' },
        { label: 'Overstaying', value: '2', sub: 'Beyond 2 hours' },
      ]} />

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={LogIn} onClick={() => setOpen(true)}>Issue gate pass</Button>
        <Button size="sm" icon={QrCode} onClick={() => toast({ title: 'Scanner ready', desc: 'Point the camera at the pass QR code.', tone: 'info' })}>Scan pass</Button>
        <Button size="sm" icon={Printer} onClick={() => window.print()} className="ml-auto">Print register</Button>
      </div>

      <Panel title="Currently on campus" subtitle="Check out to release the pass and stamp the register">
        <div className="divide-y">
          {inside.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-3 px-6 py-4">
              <Avatar name={v.name} size={28} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{v.name} <Badge tone="slate">{v.type}</Badge></p>
                <p className="truncate text-[11px] muted">{v.purpose} · meeting {v.host} · in at {v.inTime}</p>
              </div>
              <Badge tone="blue">{v.pass}</Badge>
              <Button size="sm" icon={LogOut}
                onClick={() => { setInside((l) => l.filter((x) => x.id !== v.id)); toast({ title: 'Checked out', desc: `${v.name} · pass ${v.pass} released`, tone: 'success' }) }}>
                Check out
              </Button>
            </div>
          ))}
          {inside.length === 0 && <p className="px-4 py-10 text-center text-[13px] muted">Nobody on campus — every pass has been checked out.</p>}
        </div>
      </Panel>

      <Modal open={open} onClose={() => setOpen(false)} title="Issue gate pass" subtitle="Visitor is photographed and badged at the desk"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" icon={BadgeCheck} onClick={() => {
            const r = rng(Date.now() % 88883)
            const n = personName(r)
            setInside((l) => [{ id: `GP-${Date.now()}`, name: n, type: 'Visitor', purpose: VISIT_PURPOSES[0], host: personName(rng(Date.now() % 7717)), inTime: '14:05', pass: `P-${int(r, 100, 999)}` }, ...l])
            setOpen(false)
            toast({ title: 'Gate pass issued', desc: `${n} — badge printed, host notified.`, tone: 'success' })
          }}>Issue pass</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Visitor name" required><Input placeholder="Full name" /></Field>
          <Field label="Phone" required><Input placeholder="+91" /></Field>
          <Field label="Visitor type"><Select options={['Visitor', 'Parent', 'Vendor', 'Contractor', 'Alumni']} /></Field>
          <Field label="Purpose" required><Select options={VISIT_PURPOSES} /></Field>
          <Field label="Person to meet"><Input placeholder="Staff name" /></Field>
          <Field label="ID proof"><Select options={['Aadhaar', 'Driving Licence', 'Voter ID', 'Company ID']} /></Field>
        </div>
        <div className="mt-3 grid place-items-center rounded-lg border border-dashed py-6 text-[12px] muted">
          Webcam capture placeholder — photo is printed on the badge
        </div>
      </Modal>
    </div>
  )
}
