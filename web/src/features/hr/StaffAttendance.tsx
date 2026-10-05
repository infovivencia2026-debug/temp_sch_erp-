import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, SkeletonTable, ErrorState, FormNotice, ExportButton,
} from '@/components/ui'
import { ImportButton } from '@/components/DataPortActions'
import { useCan } from '@/lib/session'
import { Download, Printer } from 'lucide-react'
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
  user_id: string
  employee_code: string
  full_name: string
  status?: string
  check_in?: string
}

const MARKS: { value: string; short: string; label: string; tone: string }[] = [
  { value: 'present', short: 'P', label: 'Present', tone: 'text-success border-success/40 bg-success/10' },
  { value: 'absent', short: 'A', label: 'Absent', tone: 'text-destructive border-destructive/40 bg-destructive/10' },
  { value: 'late', short: 'L', label: 'Late', tone: 'text-warning border-warning/40 bg-warning/10' },
  { value: 'half_day', short: '½', label: 'Half day', tone: 'text-warning border-warning/40 bg-warning/10' },
  { value: 'leave', short: 'Lv', label: 'On leave', tone: 'text-secondary-foreground border-border-strong bg-surface-hover' },
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
    queryFn: () => api.get<List<StaffRow>>(`/api/v1/workflow/staff-register?on_date=${onDate}`),
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

  const rows = q.data?.items ?? []
  const value = (r: StaffRow) => draft[r.user_id] ?? r.status ?? ''
  const marked = rows.filter((r) => value(r)).length
  const present = rows.filter((r) => ['present', 'late', 'half_day'].includes(value(r))).length
  const absent = rows.filter((r) => ['absent', 'leave'].includes(value(r))).length

  /* Every employee, as marked on screen (owner's design, staff-register-print.ts). */
  const printRegister = () => printHtml(staffRegisterHtml({
    school: {
      name: session.institution?.display_name ?? 'School',
      logoUrl: session.institution?.logo_key ? `${location.origin}/api/v1/files/${session.institution.logo_key}?inline=1` : undefined,
    },
    onDate, printedBy: session.user?.full_name ?? '',
    rows: rows.map((r) => ({ employee_code: r.employee_code, full_name: r.full_name, check_in: r.check_in, mark: value(r) })),
  }))

  /* FROM – TO (owner: "let them choose date from to and print those dates").
     One request per day (the register is kept per day), at most 62 days. */
  const [rangeFrom, setRangeFrom] = useState(() => onDate.slice(0, 8) + '01')
  const [rangeTo, setRangeTo] = useState(onDate)
  const [rangeBusy, setRangeBusy] = useState(false)
  const [rangeErr, setRangeErr] = useState('')
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
    const staff = new Map<string, { user_id: string; employee_code: string; full_name: string }>()
    const marks: Record<string, Record<string, string>> = {}
    lists.forEach((l, i) => { marks[days[i]] = {}; for (const r of l.items) { staff.set(r.user_id, r); if (r.status) marks[days[i]][r.user_id] = r.status } })
    return { staff: [...staff.values()].sort((a, b) => a.employee_code.localeCompare(b.employee_code)), marks }
  }
  const exportRange = async () => {
    const days = rangeDays(); if (!days) return
    if (days.length > 366) { setRangeErr('Export at most one year at a time.'); return }
    setRangeBusy(true)
    try {
      const { staff, marks } = await loadRange(days)
      const SHORT: Record<string, string> = { present: 'P', absent: 'A', late: 'L', half_day: 'HD', leave: 'Lv', week_off: 'W', on_duty: 'OD' }
      const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
      const lines = [['Code', 'Employee', ...days, 'Present', 'Absent', 'Leave', 'Late', 'Half day'].map(cell).join(',')]
      for (const st of staff) {
        const ms = days.map((d) => marks[d][st.user_id] ?? '')
        const n = (k: string) => String(ms.filter((m) => m === k).length)
        lines.push([st.employee_code, st.full_name, ...ms.map((m) => SHORT[m] ?? m), n('present'), n('absent'), n('leave'), n('late'), n('half_day')].map(cell).join(','))
      }
      const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a'); a.href = url; a.download = `staff-register-${rangeFrom}-to-${rangeTo}.csv`
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (e) { setRangeErr((e as Error).message) } finally { setRangeBusy(false) }
  }
  const printRange = async () => {
    const days = rangeDays(); if (!days) return
    if (days.length > 31) { setRangeErr('Print one month at a time (31 days at most) so it fits on A4. Use Export for longer ranges.'); return }
    setRangeBusy(true)
    try {
      const { staff, marks } = await loadRange(days)
      printHtml(staffRangeHtml({
        school: {
          name: session.institution?.display_name ?? 'School',
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
              hint="One row per employee per day, with the mark. Nothing is written until the dry run passes."
            />
          )}
          <ExportButton report="staff-attendance" />
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
        <Card>
          <div className="flex flex-wrap items-end gap-2.5 p-4">
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

        <Card>
          <CardHeader
            title="Register"
            description="Tap a mark to set it; tap it again to clear"
            action={
              <span className="flex items-center gap-2">
                <Input value={onDate} onChange={setOnDate} type="date" />
                {mayMark && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => markAll('present')}>
                      All present
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDraft({})}>
                      Reset
                    </Button>
                  </>
                )}
              </span>
            }
          />
          {q.isLoading ? (
            <SkeletonTable columns={4} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            <Table
              head={['Code', 'Employee', 'Checked in', 'Mark']}
              empty={!rows.length}
              emptyLabel="No active employees."
            >
              {rows.map((r) => {
                const v = value(r)
                return (
                  <tr key={r.user_id}>
                    <Td className="font-mono text-[12px]">{r.employee_code}</Td>
                    <Td className="font-medium">{r.full_name}</Td>
                    <Td className="tabular-nums text-muted-foreground">{r.check_in ?? '-'}</Td>
                    <Td>
                      <div className="flex items-center gap-1">
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
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
