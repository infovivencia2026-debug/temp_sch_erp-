import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Select, SkeletonTable, ErrorState } from '@/components/ui'
import { MonthField } from '@/components/DatePopover'

interface Day { on_date: string; status?: string; check_in?: string; check_out?: string; hours?: string; source?: string }

const LABEL: Record<string, string> = {
  present: 'Present', absent: 'Absent', late: 'Late', half_day: 'Half day', leave: 'On leave',
  wfh: 'From home', holiday: 'Holiday', week_off: 'Week off', permission: 'Permission',
}
const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  present: 'success', wfh: 'success', permission: 'success', late: 'warning', half_day: 'warning', absent: 'danger',
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/* ONE PERSON, A WHOLE MONTH (owner, 2026-10-13: "let them see all month in and
   out"). Every day of the month with the mark, the first and last punch in
   24-hour time and the hours between, so HR can check a month before payroll. */
export function StaffMonth({ people }: { people: { user_id: string; employee_code: string; full_name: string }[] }) {
  const now = new Date()
  const [ym, setYm] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [who, setWho] = useState('')
  const q = useQuery({
    queryKey: ['staff-month', who, ym],
    queryFn: () => api.get<List<Day>>(`/api/v1/workflow/staff-month?user_id=${who}&month=${ym}`),
    enabled: !!who,
  })
  const days = q.data?.items ?? []
  const count = (s: string) => days.filter((d) => d.status === s).length
  return (
    <Card>
      <CardHeader
        title="Month view"
        description="One person's whole month: the mark, In and Out (24-hour) and hours worked, day by day."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-56">
              <Select value={who} onChange={setWho} placeholder="Choose a person"
                options={people.map((p) => ({ value: p.user_id, label: `${p.full_name} (${p.employee_code})` }))} />
            </div>
            <MonthField month={Number(ym.slice(5))} year={Number(ym.slice(0, 4))} onPick={(m, y) => setYm(`${y}-${String(m).padStart(2, '0')}`)} />
          </div>
        }
      />
      {!who ? (
        <p className="px-5 py-4 text-[14px] text-muted-foreground">Choose a person to see their month.</p>
      ) : q.isLoading ? <SkeletonTable columns={6} /> : q.error ? <ErrorState error={q.error} /> : (
        <>
          <p className="px-5 pt-3 text-[13px] text-muted-foreground">
            Present {count('present') + count('wfh')} · Permission {count('permission')} · Late {count('late')} · Half day {count('half_day')} · Absent {count('absent')} · Leave {count('leave')}
          </p>
          <Table head={['Date', 'Day', 'Mark', 'In', 'Out', 'Hours']} empty={false}>
            {days.map((d) => {
              const dt = new Date(d.on_date + 'T00:00:00')
              return (
                <tr key={d.on_date} className={dt.getDay() === 0 ? 'bg-muted/40' : ''}>
                  <Td className="tabular-nums">{d.on_date.slice(8)}/{d.on_date.slice(5, 7)}</Td>
                  <Td className="text-muted-foreground">{DOW[dt.getDay()]}</Td>
                  <Td>{d.status ? <Badge tone={TONE[d.status] ?? 'neutral'}>{LABEL[d.status] ?? d.status}</Badge> : <span className="text-muted-foreground">-</span>}</Td>
                  <Td className="tabular-nums">{d.check_in ?? '-'}</Td>
                  <Td className="tabular-nums">{d.check_out ?? '-'}</Td>
                  <Td className="tabular-nums">{d.hours ?? '-'}</Td>
                </tr>
              )
            })}
          </Table>
        </>
      )}
    </Card>
  )
}
