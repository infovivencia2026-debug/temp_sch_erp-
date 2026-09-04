import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Input, Field,
  SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

/* WHAT THE PUNCHES ADD UP TO.

   Every piece of this existed and none of it was joined: the reader wrote a
   check-in, the school knew its hours, and payroll knew what a day was worth.
   Nothing put the three together, so a month of attendance answered none of
   the questions anybody actually asks - who was late, who left early, who was
   away, and what that comes to.

   The rule is printed beside the money on purpose. A deduction somebody cannot
   trace to a rule is a deduction they will come to the office to argue about,
   and the office had no answer to give them. */

interface Row {
  employee_id: string
  employee_code: string
  name: string
  department: string
  pattern: string
  starts_at: string
  ends_at: string
  grace_minutes: number
  expected_days: number
  present_days: number
  half_days: number
  unmarked_days: number
  absent_days: number
  late_days: number
  early_leaves: number
  lop_days: number
  lop_paise?: number | null
  lop_rule: string
}

interface Day {
  on_date: string
  weekday: string
  expected: boolean
  due_in: string
  due_out: string
  status: string
  check_in?: string | null
  check_out?: string | null
  minutes?: number | null
  late_by_minutes?: number | null
  verdict: string
}

const thisMonth = () => new Date().toISOString().slice(0, 7)

const hhmm = (m?: number | null) =>
  m == null ? '' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`

/* ONE PERSON'S MONTH, A ROW PER DAY.

   The totals answer "how many days did she lose" and every argument about them
   is about a particular morning: the day the reader missed her finger, the day
   she stayed until six and it still says half day. Without the days behind the
   total the office can only repeat the total back. */
function DayList({ employeeId, month }: { employeeId: string; month: string }) {
  const q = useQuery({
    queryKey: ['staff-hours-days', employeeId, month],
    queryFn: () => api.get<{ items: Day[] }>(
      `/api/v1/setup/staff-hours/${employeeId}?month=${month}`),
  })
  if (q.isLoading) return <div className="p-4"><SkeletonTable rows={4} /></div>
  if (q.error) return <div className="p-4"><ErrorState error={q.error} /></div>

  return (
    <div className="overflow-x-auto p-4">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-1 pr-4">Day</th>
            <th className="py-1 pr-4">Due in</th>
            <th className="py-1 pr-4">Punched in</th>
            <th className="py-1 pr-4">Due out</th>
            <th className="py-1 pr-4">Punched out</th>
            <th className="py-1 pr-4">On the premises</th>
            <th className="py-1 pr-4">Late by</th>
            <th className="py-1">The day</th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.items ?? []).map((d) => (
            <tr
              key={d.on_date}
              className={d.expected ? 'border-t' : 'border-t text-slate-400'}
            >
              <td className="py-1 pr-4 tabular-nums whitespace-nowrap">
                {d.on_date.slice(8)} {d.weekday}
              </td>
              {/* Due beside actual, so a late count explains itself on the
                  row rather than needing the pattern looked up elsewhere. */}
              <td className="py-1 pr-4 tabular-nums text-slate-400">
                {d.expected ? d.due_in : '-'}
              </td>
              <td className="py-1 pr-4 tabular-nums">{d.check_in ?? '-'}</td>
              <td className="py-1 pr-4 tabular-nums text-slate-400">
                {d.expected ? d.due_out : '-'}
              </td>
              <td className="py-1 pr-4 tabular-nums">{d.check_out ?? '-'}</td>
              <td className="py-1 pr-4 tabular-nums">{hhmm(d.minutes) || '-'}</td>
              <td className="py-1 pr-4 tabular-nums">
                {d.late_by_minutes ? `${d.late_by_minutes} min` : '-'}
              </td>
              <td className="py-1">{d.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function StaffHours() {
  const [month, setMonth] = useState(thisMonth)
  const [open, setOpen] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['staff-hours', month],
    queryFn: () => api.get<{ items: Row[] }>(`/api/v1/setup/staff-hours?month=${month}`),
  })

  const rows = q.data?.items ?? []
  const noPattern = rows.filter((r) => r.pattern === 'None').length
  const totalLOP = rows.reduce((n, r) => n + (r.lop_paise ?? 0), 0)

  return (
    <>
      <PageHead eyebrow="Staff" title="Staff hours this month" />
      <PageBody>
        <Card>
          <CardHeader
            title="Month"
            action={
              totalLOP > 0
                ? <Badge tone="warning">{formatPaise(totalLOP)} lost across the school</Badge>
                : undefined
            }
          />
          <div className="p-5">
            <Field label="Month">
              <Input type="month" value={month} onChange={setMonth} />
            </Field>
            {noPattern > 0 && (
              <p className="mt-3 text-sm text-slate-500">
                {noPattern} of {rows.length} are on no set of hours, so nothing is expected of them
                and nothing is deducted. Give the school a default under Working hours.
              </p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Against each person's own hours"
            description="Open a row to see the month day by day, with the punches behind it." />
          {q.isLoading ? (
            <SkeletonTable rows={6} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : rows.length === 0 ? (
            <EmptyState title="Nobody on record" body="Active staff appear here once they exist." />
          ) : (
            <Table
              head={['Name', 'Hours', 'Expected', 'Worked', 'Half', 'Away', 'Not marked', 'Late', 'Left early',
                'Days lost', 'Deduction']}
            >
              {rows.map((r) => (
                <Fragment key={r.employee_id}>
                <tr
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => setOpen(open === r.employee_id ? null : r.employee_id)}
                >
                  <Td className="font-medium">
                    {r.name}
                    {r.department && <div className="text-xs text-slate-500">{r.department}</div>}
                  </Td>
                  {/* THE TIMES, NOT JUST THE NAME OF THEM.

                      "School hours" beside a count of late minutes does not say
                      what the minutes were counted from, and that is the whole
                      question the moment one member of staff keeps different
                      hours from the rest. */}
                  <Td>
                    {r.pattern === 'None' ? (
                      <Badge tone="warning">None set</Badge>
                    ) : (
                      <>
                        <div className="tabular-nums">{r.starts_at}&ndash;{r.ends_at}</div>
                        <div className="text-xs text-slate-500">
                          {r.pattern} &middot; {r.grace_minutes} min grace
                        </div>
                      </>
                    )}
                  </Td>
                  <Td className="tabular-nums">{r.expected_days}</Td>
                  <Td className="tabular-nums">{r.present_days}</Td>
                  <Td className="tabular-nums">{r.half_days || ''}</Td>
                  <Td className="tabular-nums">{r.absent_days || ''}</Td>
                  {/* Silence, kept separate from absence. A school that has not
                      begun marking sees that, rather than a month of absences
                      it never recorded. */}
                  <Td className="tabular-nums text-slate-400">{r.unmarked_days || ''}</Td>
                  <Td className="tabular-nums">{r.late_days || ''}</Td>
                  <Td className="tabular-nums">{r.early_leaves || ''}</Td>
                  <Td className="tabular-nums">{r.lop_days || ''}</Td>
                  <Td>
                    {/* Days without money is the honest state where the school
                        has set no rule, and it says which state it is in. */}
                    <div className="tabular-nums">
                      {r.lop_paise != null ? formatPaise(r.lop_paise) : '-'}
                    </div>
                    <div className="text-xs text-slate-500">{r.lop_rule}</div>
                  </Td>
                </tr>
                {open === r.employee_id && (
                  <tr>
                    <td colSpan={11} className="bg-slate-50 p-0">
                      <DayList employeeId={r.employee_id} month={month} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
