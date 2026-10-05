import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, SkeletonTable, ErrorState, FormNotice, ExportButton,
} from '@/components/ui'
import { ImportButton } from '@/components/DataPortActions'
import { useCan } from '@/lib/session'
import { Printer } from 'lucide-react'
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
  const printRange = async () => {
    setRangeErr('')
    if (!rangeFrom || !rangeTo || rangeFrom > rangeTo) { setRangeErr('Choose a From date on or before the To date.'); return }
    const days: string[] = []
    for (let d = new Date(rangeFrom + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= rangeTo; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10))
    if (days.length > 62) { setRangeErr('Choose at most 62 days (two months) at a time.'); return }
    setRangeBusy(true)
    try {
      const lists = await Promise.all(days.map((d) => api.get<List<StaffRow>>(`/api/v1/workflow/staff-register?on_date=${d}`)))
      const staff = new Map<string, { user_id: string; employee_code: string; full_name: string }>()
      const marks: Record<string, Record<string, string>> = {}
      lists.forEach((l, i) => { marks[days[i]] = {}; for (const r of l.items) { staff.set(r.user_id, r); if (r.status) marks[days[i]][r.user_id] = r.status } })
      printHtml(staffRangeHtml({
        school: {
          name: session.institution?.display_name ?? 'School',
          logoUrl: session.institution?.logo_key ? `${location.origin}/api/v1/files/${session.institution.logo_key}?inline=1` : undefined,
        },
        from: rangeFrom, to: rangeTo, days, marks, printedBy: session.user?.full_name ?? '',
        staff: [...staff.values()].sort((a, b) => a.employee_code.localeCompare(b.employee_code)),
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
          <div className="flex flex-wrap items-end gap-3 p-4">
            <div className="min-w-[150px]"><label className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Print register from</label><Input type="date" value={rangeFrom} onChange={setRangeFrom} /></div>
            <div className="min-w-[150px]"><label className="mb-1 block text-[12.5px] font-medium text-muted-foreground">To</label><Input type="date" value={rangeTo} onChange={setRangeTo} /></div>
            <Button variant="secondary" onClick={printRange} disabled={rangeBusy}>
              <Printer className="h-4 w-4" /> {rangeBusy ? 'Preparing…' : 'Print these dates'}
            </Button>
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
