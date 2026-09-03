import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, SkeletonTable, ErrorState, FormNotice, ExportButton, PrintButton,
} from '@/components/ui'
import { useCan } from '@/lib/session'
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
          <ExportButton report="staff-attendance" />
          <PrintButton />
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
                    <Td className="tabular-nums text-muted-foreground">{r.check_in ?? '—'}</Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        {MARKS.map((m) => {
                          const on = v === m.value
                          return (
                            <button
                              key={m.value}
                              type="button"
                              aria-pressed={on}
                              aria-label={`${m.label} — ${r.full_name}`}
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
