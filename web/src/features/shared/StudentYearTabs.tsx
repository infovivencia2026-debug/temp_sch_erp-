import { useState } from 'react'
import type { StudentFullDetail, StudentProfile } from '@shared/api'
import { Card, CardHeader, Select, Table, Td, EmptyState, SkeletonTable } from '@/components/ui'
import { formatDate, formatPaise, cn } from '@/lib/utils'

/* STUDENT 360, YEAR BY YEAR, IN THE OWNER'S LAYOUT.

   The Academics and Fees tabs listed every year the child has been here in
   one long run, in pale tables. The owner asked for the faculty-dashboard
   look -- figures across the top, a toolbar of pickers, a firm table with
   coloured status tags -- and a year picker that opens on the current
   academic year (April to March). */

/** "2026-27" for any date in April 2026 to March 2027. */
export function academicYear(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

function yearsOf(dates: (string | undefined)[]): string[] {
  const set = new Set(dates.map((d) => academicYear(d)).filter(Boolean))
  set.add(academicYear())
  return [...set].sort().reverse()
}

function Kpi({ label, value, small, tone }: { label: string; value: string; small?: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border bg-card px-5 py-4">
      <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{label}</span>
      <div className={cn('flex flex-wrap items-baseline gap-x-1.5 text-[22px] font-bold', tone)}>
        {value}
        {small && <small className="whitespace-nowrap text-[11px] font-medium text-muted-foreground">{small}</small>}
      </div>
    </div>
  )
}

function Tag({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'plain'; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex rounded-md px-2 py-0.5 text-[12px] font-semibold',
      tone === 'good' ? 'bg-[#f0fdf4] text-[#15803d]'
        : tone === 'warn' ? 'bg-[#fefce8] text-[#b45309]'
          : tone === 'bad' ? 'bg-[#fef2f2] text-[#b91c1c]' : 'bg-muted text-muted-foreground')}>
      {children}
    </span>
  )
}

const pct = (m?: string, x?: string) => {
  const a = Number(m), b = Number(x)
  return m != null && x != null && b > 0 && !Number.isNaN(a) ? Math.round((a / b) * 1000) / 10 : null
}

/* ACADEMICS: the year, then the exam, then every subject with its score,
   grade, the change since the previous exam in that subject, and a tag. */
export function AcademicsYear({ results, marks, loading, attendancePercent, figures = true }: {
  results: StudentProfile['results']
  marks: StudentFullDetail['subject_marks']
  loading: boolean
  attendancePercent: number
  /** False where the page already shows its own figures above. */
  figures?: boolean
}) {
  const years = yearsOf(marks.map((m) => m.on))
  const [year, setYear] = useState(academicYear())
  const inYear = marks.filter((m) => !m.on || academicYear(m.on) === year)
  const exams = [...new Set(inYear.map((m) => m.exam))]
  const [examPick, setExam] = useState('')
  const exam = exams.includes(examPick) ? examPick : (exams[0] ?? '')
  const rows = inYear.filter((m) => m.exam === exam)
  /* The previous paper in the same subject, for the trend arrow. */
  const order = [...new Set(marks.map((m) => m.exam))]
  const prevOf = (subject: string) => {
    const at = order.indexOf(exam)
    for (const e of order.slice(at + 1)) {
      const hit = marks.find((m) => m.exam === e && m.subject === subject && !m.absent)
      if (hit) return pct(hit.marks, hit.max)
    }
    return null
  }
  const got = rows.reduce((a, x) => a + (x.absent ? 0 : Number(x.marks ?? 0)), 0)
  const max = rows.reduce((a, x) => a + Number(x.max ?? 0), 0)
  const overall = max > 0 ? Math.round((got / max) * 1000) / 10 : null
  const card = results.find((r) => r.exam === exam)
  const scored = rows.map((r) => ({ r, p: r.absent ? null : pct(r.marks, r.max) }))
  const best = scored.filter((x) => x.p != null).sort((a, b) => b.p! - a.p!)[0]
  const weak = scored.filter((x) => x.p != null && x.p < 50).length

  if (loading) return <Card><SkeletonTable columns={5} /></Card>
  return (
    <>
      {figures && <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Overall score" value={overall == null ? '-' : `${overall}%`} small={exam || undefined} />
        <Kpi label="Grade · rank" value={card?.grade || '-'} small={card?.rank ? `Rank ${card.rank}` : undefined} />
        <Kpi label="Attendance" value={`${attendancePercent}%`} small="This year" />
        <Kpi label="Needs attention" value={String(weak)} small={weak === 1 ? 'Subject' : 'Subjects'} tone={weak ? 'text-destructive' : undefined} />
      </div>}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-36">
              <Select value={year} onChange={(v) => { setYear(v); setExam('') }} options={years.map((y) => ({ value: y, label: y }))} />
            </div>
            {exams.length > 0 && (
              <div className="w-52">
                <Select value={exam} onChange={setExam} options={exams.map((e) => ({ value: e, label: e }))} />
              </div>
            )}
          </div>
          {best && <span className="text-[12.5px] font-semibold text-muted-foreground">Best: {best.r.subject} · {best.p}%</span>}
        </div>
        {rows.length === 0 ? (
          <div className="p-6"><EmptyState title={`No marks in ${year}`} body="Marks appear here as soon as a subject teacher enters them." /></div>
        ) : (
          <Table head={['Subject', 'Score', 'Marks', 'Status', 'Standing']} empty={false}>
            {scored.map(({ r, p }, i) => {
              const prev = p == null ? null : prevOf(r.subject)
              const diff = prev == null || p == null ? null : Math.round((p - prev) * 10) / 10
              return (
                <tr key={`${r.subject}-${i}`}>
                  <Td>
                    <div className="flex items-center gap-3">
                      <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-primary/10 text-[12px] font-bold text-primary">
                        {r.subject.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="font-semibold">{r.subject}</span>
                    </div>
                  </Td>
                  <Td>
                    {r.absent ? <Tag tone="warn">Absent</Tag> : p == null ? '-' : (
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="text-[14px] font-bold tabular-nums">{p}%</span>
                        {r.grade && <span className="rounded bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">{r.grade}</span>}
                        {diff != null && diff !== 0 && (
                          <span className={cn('text-[12px] font-semibold', diff > 0 ? 'text-[#15803d]' : 'text-[#b91c1c]')}>
                            {diff > 0 ? '↑' : '↓'} {Math.abs(diff)}%
                          </span>
                        )}
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{r.absent ? '-' : `${r.marks ?? '-'} / ${r.max ?? '-'}`}</Td>
                  <Td>
                    {p == null ? <Tag tone="plain">-</Tag>
                      : p >= 75 ? <Tag tone="good">On track</Tag>
                        : p >= 50 ? <Tag tone="warn">Under watch</Tag>
                          : <Tag tone="bad">Needs support</Tag>}
                  </Td>
                  <Td>{r.approved ? <Tag tone="good">Signed off</Tag> : <Tag tone="warn">Provisional</Tag>}</Td>
                </tr>
              )
            })}
          </Table>
        )}
      </Card>
    </>
  )
}

/* FEES: the year's bills and the year's receipts, with how each was paid. */
export function FeesYear({ invoices, payments, outstanding }: {
  invoices: StudentProfile['invoices']
  payments: StudentFullDetail['payments']
  outstanding: number
}) {
  const years = yearsOf([...invoices.map((x) => x.date), ...payments.map((x) => x.paid_on)])
  const [year, setYear] = useState(academicYear())
  const inv = invoices.filter((x) => academicYear(x.date) === year)
  const pay = payments.filter((x) => academicYear(x.paid_on) === year)
  const billed = inv.reduce((a, x) => a + Number(x.net_paise), 0)
  const paid = pay.filter((x) => x.status === 'success').reduce((a, x) => a + Number(x.amount_paise), 0)
  const modeTone = (m: string) => /upi|online|card|net/i.test(m) ? 'bg-primary/10 text-primary' : /cash/i.test(m) ? 'bg-[#f0fdf4] text-[#15803d]' : 'bg-muted text-foreground'
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Billed" value={formatPaise(billed)} small={year} />
        <Kpi label="Paid" value={formatPaise(paid)} small={`${pay.length} receipt${pay.length === 1 ? '' : 's'}`} />
        <Kpi label="Outstanding" value={formatPaise(outstanding)} small="All years" tone={outstanding ? 'text-destructive' : undefined} />
        <Kpi label="Invoices" value={String(inv.length)} small={year} />
      </div>
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
          <h3 className="text-[15px] font-semibold">Receipts</h3>
          <div className="w-36">
            <Select value={year} onChange={setYear} options={years.map((y) => ({ value: y, label: y }))} />
          </div>
        </div>
        <Table head={['Receipt', 'Date', 'Amount', 'Mode of payment', 'Reference', '']} empty={pay.length === 0}
          emptyLabel={`No payments in ${year}.`}>
          {pay.map((x, i) => (
            <tr key={`${x.receipt_no}-${i}`}>
              <Td className="font-mono text-[12px]">{x.receipt_no || '-'}</Td>
              <Td className="text-muted-foreground">{formatDate(x.paid_on)}</Td>
              <Td className="font-semibold tabular-nums">{formatPaise(Number(x.amount_paise))}</Td>
              <Td><span className={cn('inline-flex rounded-md px-2 py-0.5 text-[12px] font-semibold uppercase', modeTone(x.mode))}>{x.mode || '-'}</span></Td>
              <Td className="font-mono text-[12px] text-muted-foreground">{x.reference || '-'}</Td>
              <Td>{x.status !== 'success' && <Tag tone="bad">{x.status}</Tag>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card className="overflow-hidden p-0">
        <CardHeader title="Invoices" />
        <Table head={['Date', 'Invoice', 'Amount', 'Paid', 'Status']} empty={inv.length === 0} emptyLabel={`No invoices in ${year}.`}>
          {inv.map((x) => {
            const due = Number(x.net_paise) - Number(x.paid_paise)
            return (
              <tr key={x.invoice_no}>
                <Td className="text-muted-foreground">{formatDate(x.date)}</Td>
                <Td className="font-mono text-[12px]">{x.invoice_no}</Td>
                <Td className="tabular-nums">{formatPaise(x.net_paise)}</Td>
                <Td className="tabular-nums">{formatPaise(x.paid_paise)}</Td>
                <Td>{due <= 0 ? <Tag tone="good">Paid</Tag> : Number(x.paid_paise) > 0 ? <Tag tone="warn">Part paid</Tag> : <Tag tone="bad">Unpaid</Tag>}</Td>
              </tr>
            )
          })}
        </Table>
      </Card>
    </>
  )
}

/* ATTENDANCE AS A MONTH, the way the parent's report draws it: a year and a
   month picker, the month's figures, and every day tinted -- light green for
   present, light red for absent, light amber for late or half day, grey for
   Sundays. The owner asked for the same calendar here. */
const DAY_TONE: Record<string, string> = {
  present: 'border-[#86efac] bg-[#dcfce7] font-semibold text-[#15803d]',
  late: 'border-[#fcd34d] bg-[#fef3c7] font-semibold text-[#b45309]',
  half_day: 'border-[#fdba74] bg-[#ffedd5] font-semibold text-[#b45309]',
  absent: 'border-[#fca5a5] bg-[#fee2e2] font-semibold text-[#b91c1c]',
  leave: 'border-border bg-muted text-muted-foreground',
  holiday: 'border-border bg-muted text-muted-foreground',
}
const KEY_EDGE: Record<string, string> = {
  present: 'border-[#16a34a] bg-[#dcfce7]', late: 'border-[#d97706] bg-[#fef3c7]',
  absent: 'border-[#dc2626] bg-[#fee2e2]', half_day: 'border-[#f97316] bg-[#ffedd5]',
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function AttendanceCalendar({ days }: { days: { date: string; status: string }[] }) {
  const byDate = new Map(days.map((d) => [d.date.slice(0, 10), d.status]))
  const now = new Date()
  const thisYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const years = yearsOf(days.map((d) => d.date))
  const [year, setYear] = useState(academicYear())
  /* The twelve months of the academic year, April first, none in the future. */
  const start = Number(year.slice(0, 4))
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = (3 + i) % 12, y = start + (3 + i >= 12 ? 1 : 0)
    return `${y}-${String(m + 1).padStart(2, '0')}`
  }).filter((ym) => ym <= thisYm)
  const [pick, setPick] = useState(thisYm)
  const ym = months.includes(pick) ? pick : months[months.length - 1] ?? thisYm
  const [y, m] = ym.split('-').map(Number)
  const count = new Date(y, m, 0).getDate()
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7
  const tally = { present: 0, absent: 0, late: 0, marked: 0 }
  for (let d = 1; d <= count; d++) {
    const st = byDate.get(`${ym}-${String(d).padStart(2, '0')}`)
    if (!st || st === 'holiday') continue
    tally.marked++
    if (st === 'present') tally.present++
    else if (st === 'late') { tally.late++; tally.present++ }
    else if (st === 'absent') tally.absent++
  }
  const pctM = tally.marked ? Math.round((tally.present / tally.marked) * 100) : null
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <h3 className="text-[15px] font-semibold">Attendance calendar</h3>
        <div className="flex flex-wrap gap-2">
          <div className="w-32">
            <Select value={year} onChange={(v) => { setYear(v); setPick('') }} options={years.map((x) => ({ value: x, label: x }))} />
          </div>
          <div className="w-40">
            <Select value={ym} onChange={setPick} options={months.map((x) => ({ value: x, label: `${MONTHS[Number(x.slice(5)) - 1]} ${x.slice(0, 4)}` }))} />
          </div>
        </div>
      </div>
      <div className="grid gap-5 px-5 py-4 lg:grid-cols-[220px_1fr]">
        <div className="grid content-start grid-cols-2 gap-3 lg:grid-cols-1">
          <Kpi label="Present" value={String(tally.present)} small="days" tone="text-[#16a34a]" />
          <Kpi label="Absent" value={String(tally.absent)} small="days" tone={tally.absent ? 'text-destructive' : undefined} />
          <Kpi label="This month" value={pctM == null ? '-' : `${pctM}%`} />
          {tally.late > 0 && <Kpi label="Late" value={String(tally.late)} small="days" tone="text-[#b45309]" />}
        </div>
        <div className="min-w-0">
          <div className="grid grid-cols-7 gap-1.5 text-center">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <div key={i} className="pb-1 text-[11px] font-semibold text-muted-foreground">{d}</div>
            ))}
            {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} />)}
            {Array.from({ length: count }, (_, i) => {
              const day = i + 1
              const iso = `${ym}-${String(day).padStart(2, '0')}`
              const st = byDate.get(iso)
              const sunday = new Date(y, m - 1, day).getDay() === 0
              return (
                <div key={day} title={st ? `${formatDate(iso)} · ${st.replace('_', ' ')}` : formatDate(iso)}
                  className={cn('flex h-10 items-center justify-center rounded-lg border text-[13.5px] tabular-nums',
                    st ? DAY_TONE[st] ?? 'bg-muted' : sunday ? 'border-transparent bg-muted text-muted-foreground' : 'text-muted-foreground')}>
                  {day}
                </div>
              )
            })}
          </div>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t pt-3 text-[14px] font-medium">
            {Object.entries(KEY_EDGE).map(([k, cls]) => (
              <span key={k} className="inline-flex items-center gap-2">
                <span className={cn('h-4 w-4 rounded-full border-2', cls)} />{k.replace('_', ' ')}
              </span>
            ))}
            <span className="inline-flex items-center gap-2">
              <span className="h-4 w-4 rounded-full border-2 border-muted-foreground/40 bg-muted" />holiday / Sunday
            </span>
          </div>
        </div>
      </div>
    </Card>
  )
}
