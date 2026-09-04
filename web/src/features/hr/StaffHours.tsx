import { useState } from 'react'
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
  expected_days: number
  present_days: number
  half_days: number
  absent_days: number
  late_days: number
  early_leaves: number
  lop_days: number
  lop_paise?: number | null
  lop_rule: string
}

const thisMonth = () => new Date().toISOString().slice(0, 7)

export default function StaffHours() {
  const [month, setMonth] = useState(thisMonth)

  const q = useQuery({
    queryKey: ['staff-hours', month],
    queryFn: () => api.get<Row[]>(`/api/v1/setup/staff-hours?month=${month}`),
  })

  const rows = q.data ?? []
  const noPattern = rows.filter((r) => r.pattern === 'None').length
  const totalLOP = rows.reduce((n, r) => n + (r.lop_paise ?? 0), 0)

  return (
    <>
      <PageHead eyebrow="Staff" title="Hours this month" />
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
          <CardHeader title="Against each person's own hours" />
          {q.isLoading ? (
            <SkeletonTable rows={6} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : rows.length === 0 ? (
            <EmptyState title="Nobody on record" body="Active staff appear here once they exist." />
          ) : (
            <Table
              head={['Name', 'Hours', 'Expected', 'Worked', 'Half', 'Away', 'Late', 'Left early',
                'Days lost', 'Deduction']}
            >
              {rows.map((r) => (
                <tr key={r.employee_id}>
                  <Td className="font-medium">
                    {r.name}
                    {r.department && <div className="text-xs text-slate-500">{r.department}</div>}
                  </Td>
                  <Td>
                    {r.pattern === 'None'
                      ? <Badge tone="warning">None set</Badge>
                      : r.pattern}
                  </Td>
                  <Td className="tabular-nums">{r.expected_days}</Td>
                  <Td className="tabular-nums">{r.present_days}</Td>
                  <Td className="tabular-nums">{r.half_days || ''}</Td>
                  <Td className="tabular-nums">{r.absent_days || ''}</Td>
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
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
