import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Select, Dialog, SkeletonTable, ErrorState, FormNotice,
} from '@/components/ui'
import { ImportButton } from '@/components/DataPortActions'
import { StaffMonth } from './StaffMonth'
import { useCan } from '@/lib/session'
import { Download, Printer, Image as ImageIcon } from 'lucide-react'
import { lateListJpeg } from './late-list-jpeg'
import { useSession } from '@/lib/session'
import { printHtml } from '@/features/finance/receipt-print'
import { staffRangeHtml, staffRegisterHtml } from './staff-register-print'
import { cn } from '@/lib/utils'

/* The staff register.
 *
 * Both endpoints existed and neither had a caller, so staff attendance was a
 * table nothing wrote to — which is why the "teachers absent" figure on every
 * dashboard was reading an empty relation.
 *
 * Same quick marks as the student register, for the same reason: this is a
 * list of forty people marked twice a day, and a dropdown per row costs three
 * interactions each. The difference is week_off, which a school marks for a
 * whole Sunday rather than per person.
 */

interface StaffRow {
  on_reader?: boolean
  user_id: string
  /** On the roll but with no login yet, so nothing can be marked against them. */
  needs_login?: boolean
  employee_code: string
  full_name: string
  status?: string
  check_in?: string
  /* The last punch of the day, 24-hour like check_in (owner, 2026-10-13: "add in and out time 24 hours format"). */
  check_out?: string
  /** The staff group (department), e.g. Teaching staff / Non Teaching. */
  department?: string
  /** The PIN on the biometric reader. */
  biometric_id?: string
}

const MARKS: { value: string; short: string; label: string; tone: string }[] = [
  { value: 'present', short: 'P', label: 'Present', tone: 'text-success border-success/40 bg-success/10' },
  { value: 'absent', short: 'A', label: 'Absent', tone: 'text-destructive border-destructive/40 bg-destructive/10' },
  { value: 'late', short: 'L', label: 'Late', tone: 'text-warning border-warning/40 bg-warning/10' },
  { value: 'half_day', short: '½', label: 'Half day', tone: 'text-warning border-warning/40 bg-warning/10' },
  { value: 'leave', short: 'Lv', label: 'On leave', tone: 'text-secondary-foreground border-border-strong bg-surface-hover' },
  { value: 'wfh', short: 'H', label: 'From home', tone: 'text-info border-info/40 bg-info/10' },
  /* Late with permission (Yajur, 2026-10-13): within an hour it is not a late mark, so no pay is cut. */
  { value: 'permission', short: 'Pr', label: 'Permission', tone: 'text-success border-success/40 bg-success/10' },
  /* A day on the school calendar's holiday list: grey, and nobody's absent. */
  { value: 'holiday', short: 'Hol', label: 'Holiday', tone: 'text-muted-foreground border-border-strong bg-muted' },
]

export default function StaffAttendance() {
  const qc = useQueryClient()
  const session = useSession()
  const can = useCan()
  const mayMark = can('hr.attendance.write')

  const [onDate, setOnDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')

  const q = useQuery({
    queryKey: ['staff-register', onDate],
    queryFn: () => api.get<List<StaffRow> & { holiday?: { name: string; from: string; to: string } }>(`/api/v1/workflow/staff-register?on_date=${onDate}`),
  })

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/workflow/staff-attendance', {
        on_date: onDate,
        entries: Object.entries(draft).map(([user_id, status]) => ({ user_id, status })),
      }),
    onSuccess: () => {
      const n = Object.keys(draft).length
      setNote(`${n} ${n === 1 ? 'mark' : 'marks'} saved.`)
      setDraft({})
      qc.invalidateQueries({ queryKey: ['staff-register'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  /* STAFF GROUP (Yajur, 2026-11-26: "let them choose staff or non staff, what
     names we have"): the groups are the school's own departments. Screen,
     print and export all follow the choice. */
  const [group, setGroup] = useState('')
  const NO_DEPT = '(none)'
  const inGroup = (r: { department?: string }) => !group || (group === NO_DEPT ? !r.department : r.department === group)
  const allRows = q.data?.items ?? []
  const groups = [...new Set(allRows.map((r) => r.department).filter(Boolean) as string[])].sort()
  const groupOptions = [{ value: '', label: 'All staff' }, ...groups.map((g) => ({ value: g, label: g })),
    ...(allRows.some((r) => !r.department) ? [{ value: NO_DEPT, label: 'No department' }] : [])]
  const groupLabel = groupOptions.find((o) => o.value === group)?.label ?? 'All staff'
  const rows = allRows.filter(inGroup)
  const value = (r: StaffRow) => draft[r.user_id] ?? r.status ?? ''
  const marked = rows.filter((r) => value(r)).length
  const present = rows.filter((r) => ['present', 'late', 'half_day', 'wfh'].includes(value(r))).length
  const absent = rows.filter((r) => ['absent', 'leave'].includes(value(r))).length

  /* Every employee, as marked on screen (owner's design, staff-register-print.ts). */
  const printRegister = () => printHtml(staffRegisterHtml({
    school: {
      name: (session.institution?.display_name || session.institution?.name || 'School'),
      logoUrl: session.institution?.logo_key ? `${location.origin}/api/v1/files/${session.institution.logo_key}?inline=1` : undefined,
    },
    onDate, printedBy: session.user?.full_name ?? '',
    rows: rows.map((r) => ({ employee_code: r.employee_code, full_name: r.full_name, check_in: r.check_in, check_out: r.check_out, mark: value(r) })),
  }))

  /* FROM – TO (owner: "let them choose date from to and print those dates").
     One request per day (the register is kept per day), at most 62 days. */
  const [rangeFrom, setRangeFrom] = useState(() => onDate.slice(0, 8) + '01')
  const [rangeTo, setRangeTo] = useState(onDate)
  const [rangeBusy, setRangeBusy] = useState(false)
  const [rangeErr, setRangeErr] = useState('')
  /* The Export button at the top asks for the dates and the group first (Yajur, 2026-11-27). */
  const [askExport, setAskExport] = useState(false)
  /* Print: one month at most, so the day columns fit an A4 sheet. Export:
     any range (owner, 2026-10-05). The register is kept per day, so a range
     is read day by day, ten at a time. */
  const rangeDays = (): string[] | null => {
    setRangeErr('')
    if (!rangeFrom || !rangeTo || rangeFrom > rangeTo) { setRangeErr('Choose a From date on or before the To date.'); return null }
    const days: string[] = []
    for (let d = new Date(rangeFrom + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= rangeTo; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10))
    return days
  }
  const loadRange = async (days: string[]) => {
    const lists: List<StaffRow>[] = []
    for (let i = 0; i < days.length; i += 10) lists.push(...await Promise.all(days.slice(i, i + 10).map((d) => api.get<List<StaffRow>>(`/api/v1/workflow/staff-register?on_date=${d}`))))
    const staff = new Map<string, StaffRow>()
    const marks: Record<string, Record<string, string>> = {}
    const ins: Record<string, Record<string, string>> = {}
    /* Keyed by code: a person with no login yet has no user_id. */
    lists.forEach((l, i) => { marks[days[i]] = {}; ins[days[i]] = {}; for (const r of l.items) { if (!inGroup(r)) continue; staff.set(r.employee_code, r); if (r.status) marks[days[i]][r.employee_code] = r.status; if (r.check_in) ins[days[i]][r.employee_code] = r.check_in } })
    return { staff: [...staff.values()].sort((a, b) => a.employee_code.localeCompare(b.employee_code)).map((r) => ({ ...r, user_id: r.employee_code })), marks, ins }
  }
  /* EXPORT AS EXCEL (Yajur, 2026-11-26: "export should be there with dates,
     highlight the absentees and late comers", "all the staff with their
     biometric id"). A real date over every column with the weekday, the
     biometric ID beside each name, Absent in red and Late in amber. Saved as
     an Excel sheet (HTML table), which keeps the colours; a day with no mark
     but a punch shows the in-time. */
  const exportRange = async (): Promise<boolean> => {
    const days = rangeDays(); if (!days) return false
    if (days.length > 366) { setRangeErr('Export at most one year at a time.'); return false }
    setRangeBusy(true)
    try {
      const { staff, marks, ins } = await loadRange(days)
      const SHORT: Record<string, string> = { present: 'P', absent: 'A', late: 'L', half_day: 'HD', leave: 'Lv', week_off: 'W', on_duty: 'OD', permission: 'Pr', wfh: 'H', holiday: 'Hol' }
      const FILL: Record<string, string> = { absent: '#fecaca', late: '#fde68a', half_day: '#fef3c7', leave: '#e2e8f0', holiday: '#f1f5f9', week_off: '#f1f5f9' }
      const INK: Record<string, string> = { absent: '#991b1b', late: '#92400e' }
      const esc = (v: string) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
      const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const head = (d: string) => { const t = new Date(d + 'T00:00:00Z'); return `${d.slice(8)} ${MON[t.getUTCMonth()]}<br>${WD[t.getUTCDay()]}` }
      const fmt = (d: string) => `${d.slice(8)} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
      const th = (v: string, w = '') => `<th style="background:#1e3a8a;color:#fff;border:1px solid #94a3b8;padding:4px 6px${w}">${v}</th>`
      const td = (v: string, st = '') => `<td style="border:1px solid #cbd5e1;padding:3px 6px;mso-number-format:'\@';${st}">${esc(v)}</td>`
      const body = staff.map((st) => {
        const ms = days.map((d) => marks[d][st.employee_code] ?? '')
        const n = (...k: string[]) => String(ms.filter((m) => k.includes(m)).length)
        const cells = days.map((d, i) => {
          const m = ms[i]; const v = m ? (SHORT[m] ?? m) : (ins[d][st.employee_code] ?? '')
          return td(v, `text-align:center;${FILL[m] ? `background:${FILL[m]};` : ''}${INK[m] ? `color:${INK[m]};font-weight:bold;` : ''}`)
        }).join('')
        return `<tr>${td(st.employee_code)}${td(st.biometric_id ?? '')}${td(st.full_name, 'white-space:nowrap')}${td(st.department ?? '')}${cells}${td(n('present', 'permission', 'on_duty', 'wfh'), 'text-align:center')}${td(n('absent'), 'text-align:center;background:#fecaca;color:#991b1b;font-weight:bold')}${td(n('late'), 'text-align:center;background:#fde68a;color:#92400e;font-weight:bold')}${td(n('half_day'), 'text-align:center')}${td(n('leave'), 'text-align:center')}</tr>`
      }).join('')
      const school = (session.institution?.display_name || session.institution?.name || 'School')
      const span = days.length + 9
      const html = `<html><head><meta charset="utf-8"></head><body style="font-family:Calibri,Arial,sans-serif">
<table><tr><td colspan="${span}" style="font-size:16pt;font-weight:bold">${esc(school)}: Staff attendance register</td></tr>
<tr><td colspan="${span}">${esc(groupLabel)} &middot; ${fmt(rangeFrom)} to ${fmt(rangeTo)} &middot; ${staff.length} staff</td></tr>
<tr><td colspan="${span}"><span style="background:#fecaca;color:#991b1b;font-weight:bold">&nbsp;A = Absent&nbsp;</span> <span style="background:#fde68a;color:#92400e;font-weight:bold">&nbsp;L = Late&nbsp;</span> P = Present, HD = Half day, Lv = Leave, Pr = Permission, Hol = Holiday, W = Week off; a time = punched in, not marked</td></tr><tr></tr>
<tr>${th('Code')}${th('Biometric ID')}${th('Name')}${th('Group')}${days.map((d) => th(head(d), ';text-align:center')).join('')}${th('Present')}${th('Absent')}${th('Late')}${th('Half day')}${th('Leave')}</tr>
${body}</table></body></html>`
      const url = URL.createObjectURL(new Blob(['\uFEFF' + html], { type: 'application/vnd.ms-excel' }))
      const a = document.createElement('a'); a.href = url
      a.download = `staff-register-${(group ? groupLabel : 'all-staff').replace(/[^\w-]+/g, '-').toLowerCase()}-${rangeFrom}-to-${rangeTo}.xls`
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      return true
    } catch (e) { setRangeErr((e as Error).message); return false } finally { setRangeBusy(false) }
  }
  const printRange = async () => {
    const days = rangeDays(); if (!days) return
    if (days.length > 31) { setRangeErr('Max 31 days per print. Use Export for more.'); return }
    setRangeBusy(true)
    try {
      const { staff, marks } = await loadRange(days)
      printHtml(staffRangeHtml({
        school: {
          name: (session.institution?.display_name || session.institution?.name || 'School'),
          logoUrl: session.institution?.logo_key ? `${location.origin}/api/v1/files/${session.institution.logo_key}?inline=1` : undefined,
        },
        from: rangeFrom, to: rangeTo, days, marks, printedBy: session.user?.full_name ?? '', staff,
      }))
    } catch (e) { setRangeErr((e as Error).message) } finally { setRangeBusy(false) }
  }

  function markAll(status: string) {
    setDraft(Object.fromEntries(rows.map((r) => [r.user_id, status])))
    setNote('')
  }

  /* NOT PUNCHED IN (Yajur, 2026-10-23: "add a button mark absent who didn't
     punch in"): nobody is made absent on their own; the office fills Absent
     for everyone with no punch and no mark, checks, and saves. */
  const noPunch = rows.filter((r) => !r.needs_login && !r.check_in && !r.check_out && !value(r))
  function markNoPunchAbsent() {
    setDraft({ ...draft, ...Object.fromEntries(noPunch.map((r) => [r.user_id, 'absent'])) })
    setNote('')
  }

  // Find a member of staff by name or code.
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const shown = needle ? rows.filter((r) => r.full_name.toLowerCase().includes(needle) || r.employee_code.toLowerCase().includes(needle)) : rows

  return (
    <>
      <PageHead
        eyebrow="Attendance & Leave"
        title="Staff register"
        description="Today's marks for every active employee."
        actions={
          <>
          {/* The staff register is a document a board asks for by name. */}
          {mayMark && (
            <ImportButton
              entity="staff_attendance"
              title="Import staff attendance"
              hint="One row per staff per day. Checked before saving."
            />
          )}
          <Button variant="secondary" onClick={() => { setRangeErr(''); setAskExport(true) }}>
            <Download className="h-4 w-4" /> Export
          </Button>
          <Button variant="secondary" onClick={() => lateListJpeg(rows, onDate)} disabled={!rows.length}>
            <ImageIcon className="h-4 w-4" /> Late list (JPEG)
          </Button>
          <Button variant="secondary" onClick={printRegister} disabled={!rows.length}>
            <Printer className="h-4 w-4" /> Print
          </Button>
          <Button
            disabled={!Object.keys(draft).length || save.isPending || !mayMark}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : `Save ${Object.keys(draft).length || ''}`.trim()}
          </Button>
          </>
        }
      />
      <PageBody>
        {askExport && (
          <Dialog onClose={() => setAskExport(false)} title="Export staff register" description="Excel sheet: one column per date, biometric ID for each person, Absent in red and Late in yellow."
            footer={<>
              <Button variant="secondary" onClick={() => setAskExport(false)}>Cancel</Button>
              <Button onClick={async () => { if (await exportRange()) setAskExport(false) }} disabled={rangeBusy}>
                <Download className="h-4 w-4" /> {rangeBusy ? 'Preparing…' : 'Download Excel'}
              </Button>
            </>}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2"><label className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Staff group</label><Select value={group} onChange={setGroup} options={groupOptions} /></div>
              <div><label className="mb-1 block text-[12.5px] font-medium text-muted-foreground">From</label><Input type="date" value={rangeFrom} onChange={setRangeFrom} /></div>
              <div><label className="mb-1 block text-[12.5px] font-medium text-muted-foreground">To</label><Input type="date" value={rangeTo} onChange={setRangeTo} /></div>
              {rangeErr && <p className="text-[13px] text-destructive sm:col-span-2">{rangeErr}</p>}
            </div>
          </Dialog>
        )}
        <Card>
          <div className="flex flex-wrap items-end gap-2.5 p-4">
            <div className="min-w-[170px]"><label className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Staff group</label><Select value={group} onChange={setGroup} options={groupOptions} /></div>
            <div className="min-w-[150px]"><label className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Print register from</label><Input type="date" value={rangeFrom} onChange={setRangeFrom} /></div>
            <div className="min-w-[150px]"><label className="mb-1 block text-[12.5px] font-medium text-muted-foreground">To</label><Input type="date" value={rangeTo} onChange={setRangeTo} /></div>
            <Button variant="secondary" onClick={printRange} disabled={rangeBusy}>
              <Printer className="h-4 w-4" /> {rangeBusy ? 'Preparing…' : 'Print these dates'}
            </Button>
            <Button variant="secondary" onClick={exportRange} disabled={rangeBusy}>
              <Download className="h-4 w-4" /> Export these dates
            </Button>
            {/* Level with the buttons and readable (owner: "make it big and in middle"). */}
            <span className="inline-flex h-[var(--control-h)] items-center rounded-lg bg-muted/60 px-3 text-[14px] font-medium text-foreground/80">Print: 1 month · Export: any range</span>
            {rangeErr && <span className="text-[13px] text-destructive">{rangeErr}</span>}
          </div>
        </Card>
        <CellGrid cols={4}>
          <Stat label="Staff" value={rows.length} />
          <Stat label="Marked" value={`${marked} / ${rows.length}`} />
          <Stat label="Present" value={present} />
          <Stat label="Absent or on leave" value={absent} />
        </CellGrid>

        <FormNotice error={save.error} ok={note} />

        {mayMark && <PunchRequests />}

        <Card>
          <CardHeader
            title="Register"
            description="Tap a mark to set it; tap it again to clear"
            action={
              <span className="flex flex-wrap items-center gap-2">
                <Input value={search} onChange={setSearch} placeholder="Search staff" className="w-48" />
                <Input value={onDate} onChange={setOnDate} type="date" />
                {mayMark && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => markAll('present')}>
                      All present
                    </Button>
                    <Button size="sm" variant="secondary" disabled={!noPunch.length} onClick={markNoPunchAbsent}>
                      Mark absent: not punched in ({noPunch.length})
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDraft({})}>
                      Reset
                    </Button>
                  </>
                )}
              </span>
            }
          />
          {/* Just the fact, not the explanation (owner, 2026-10-16: "only
              show holiday, why other unnecessary text"); the sentence about
              the reader was true but nobody taking the register needed to be
              told how the mark got there. A top margin too, so it no longer
              sits flush under the header's own divider. */}
          {q.data?.holiday && (
            <div className="mx-[var(--card-pad)] mb-3 mt-3 rounded-md border border-border bg-muted px-3 py-2 text-[13.5px] text-muted-foreground">
              <strong className="text-foreground">Holiday: {q.data.holiday.name}</strong>
              {q.data.holiday.to !== q.data.holiday.from && <> ({q.data.holiday.from} to {q.data.holiday.to})</>}
            </div>
          )}
          {q.isLoading ? (
            <SkeletonTable columns={5} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            <Table
              head={['Code', 'Employee', 'In', 'Out', 'Mark']}
              empty={!shown.length}
              emptyLabel={needle ? 'Nobody matches that search.' : 'No active employees.'}
            >
              {shown.map((r) => {
                const v = value(r)
                return (
                  <tr key={r.user_id || r.employee_code}>
                    <Td className="font-mono text-[12px]">{r.employee_code}</Td>
                    <Td className="font-medium">{r.full_name}</Td>
                    <Td className="tabular-nums text-muted-foreground">{r.check_in ?? '-'}</Td>
                    <Td className="tabular-nums text-muted-foreground">{r.check_out ?? '-'}</Td>
                    <Td>
                      {/* ON THE ROLL, NOT YET MARKABLE (owner, 2026-10-14:
                          "after adding new staff show their attendance in
                          staff registry").

                          A new member of staff used to be absent from this
                          sheet altogether, because attendance is kept against
                          a login and they had none. They are listed now, so
                          whoever takes the register can see the name is there
                          and why it cannot be marked, instead of wondering
                          whether they forgot somebody. */}
                      {r.needs_login ? (
                        /* The reader's times are already in the two columns
                           to the left, so this says only what is missing --
                           the ability to overrule them by hand -- and says it
                           quietly. It used to be a sentence of instruction
                           where a mark should be, which read as the row being
                           broken rather than as one waiting on a password. */
                        /* Nothing (owner, 2026-10-14: "why do i see that message").
                           The in and out are in the columns beside; marks are
                           the only thing a login adds, and an empty cell says
                           that without a sentence. */
                        <span aria-hidden className="block h-8" />
                      ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        {MARKS.map((m) => {
                          const on = v === m.value
                          return (
                            <button
                              key={m.value}
                              type="button"
                              aria-pressed={on}
                              aria-label={`${m.label} · ${r.full_name}`}
                              title={m.label}
                              disabled={!mayMark}
                              onClick={() =>
                                setDraft((d) => {
                                  const next = { ...d }
                                  if (next[r.user_id] === m.value) delete next[r.user_id]
                                  else next[r.user_id] = m.value
                                  return next
                                })
                              }
                              className={cn(
                                'h-8 w-8 rounded-[7px] border text-[12px] font-semibold',
                                'transition-colors duration-100',
                                'disabled:pointer-events-none disabled:opacity-40',
                                on
                                  ? m.tone
                                  : 'border-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground',
                              )}
                            >
                              {m.short}
                            </button>
                          )
                        })}
                      </div>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
        </Card>

        <StaffMonth people={rows} />
      </PageBody>
    </>
  )
}

/* Requests from staff to fix a day's punch. Approving writes the mark the
   person asked for; refusing needs a line they will read. */
function PunchRequests() {
  const qc = useQueryClient()
  const [notes, setNotes] = useState<Record<string, string>>({})
  const q = useQuery({
    queryKey: ['attendance-requests', 'pending'],
    queryFn: () => api.get<List<{ id: string; on_date: string; check_in?: string; check_out?: string; reason: string; full_name: string; employee_code: string }>>('/api/v1/hr/attendance-requests?status=pending'),
  })
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected' }) => api.post(`/api/v1/hr/attendance-requests/${v.id}/decide`, { decision: v.decision, note: notes[v.id] ?? '' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['attendance-requests'] }); qc.invalidateQueries({ queryKey: ['staff-register'] }) },
  })
  const rows = q.data?.items ?? []
  if (!rows.length) return null
  return (
    <Card>
      <CardHeader title="Requests to fix a punch" description="Approving writes the mark they asked for into the register." />
      <Table head={['Person', 'Day', 'Times', 'Reason', '']}>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="font-medium">{r.full_name}<span className="block font-mono text-[11.5px] font-normal text-muted-foreground">{r.employee_code}</span></Td>
            <Td className="text-muted-foreground">{r.on_date}</Td>
            <Td className="tabular-nums">{[r.check_in, r.check_out].filter(Boolean).join(' to ') || 'present'}</Td>
            <Td className="text-muted-foreground"><span className="block max-w-[32ch] truncate" title={r.reason}>{r.reason}</span></Td>
            <Td>
              <span className="flex flex-wrap items-center gap-2">
                <Input className="w-40" value={notes[r.id] ?? ''} onChange={(v) => setNotes({ ...notes, [r.id]: v })} placeholder="Note" />
                <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'approved' })}>Approve</Button>
                <Button size="sm" variant="ghost" tone="danger" disabled={decide.isPending || !(notes[r.id] ?? '').trim()} onClick={() => decide.mutate({ id: r.id, decision: 'rejected' })}>Refuse</Button>
              </span>
            </Td>
          </tr>
        ))}
      </Table>
      <div className="px-5 pb-4"><FormNotice error={decide.error} /></div>
    </Card>
  )
}
