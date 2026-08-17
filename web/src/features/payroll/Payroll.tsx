import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Loading, ErrorState,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

interface Payslip {
  employee_code: string; full_name: string
  paid_days: string; lop_days: string
  gross_paise: number; deduction_paise: number; net_paise: number
  breakup: Record<string, number>
}

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December']

/** Payroll. Earnings pro-rate on paid days derived from staff attendance;
    deductions do not. A locked run is never recomputed. */
export default function Payroll() {
  const qc = useQueryClient()
  const now = new Date()
  const [month, setMonth] = useState(String(now.getMonth() + 1))
  const [year, setYear] = useState(String(now.getFullYear()))

  const slips = useQuery({
    queryKey: ['payslips', month, year],
    queryFn: () => api.get<List<Payslip>>(`/api/v1/payroll/payslips?month=${month}&year=${year}`),
  })
  const run = useMutation({
    mutationFn: () => api.post<{ employees: number; net_paise: number }>('/api/v1/payroll/run', {
      month: Number(month), year: Number(year),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payslips'] }),
  })

  const rows = slips.data?.items ?? []
  const gross = rows.reduce((a, r) => a + r.gross_paise, 0)
  const ded = rows.reduce((a, r) => a + r.deduction_paise, 0)
  const net = rows.reduce((a, r) => a + r.net_paise, 0)
  const components = [...new Set(rows.flatMap((r) => Object.keys(r.breakup ?? {})))].sort()

  return (
    <>
      <PageHead
        eyebrow="HR Workspace"
        title="Payroll"
        description="Run monthly salaries. Loss of pay comes from staff attendance, not manual entry."
        actions={
          <>
            <Select value={month} onChange={setMonth}
              options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
            <Select value={year} onChange={setYear}
              options={[now.getFullYear() - 1, now.getFullYear()].map((y) => ({
                value: String(y), label: String(y),
              }))} />
            <Button disabled={run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? 'Running…' : 'Run payroll'}
            </Button>
          </>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Employees" value={rows.length} />
          <Stat label="Gross" value={formatPaise(gross)} />
          <Stat label="Deductions" value={formatPaise(ded)} />
          <Stat label="Net payable" value={formatPaise(net)} />
        </CellGrid>

        {run.isError && (
          <Card className="p-4">
            <p className="text-[14px] text-destructive">
              {run.error instanceof Error ? run.error.message : 'Payroll run failed'}
            </p>
          </Card>
        )}

        <Card>
          <CardHeader
            title={`Payslips — ${MONTHS[Number(month) - 1]} ${year}`}
            description="Breakup is frozen at run time so an issued payslip keeps its numbers"
          />
          {slips.isLoading ? <Loading /> : slips.error ? <ErrorState error={slips.error} /> : (
            <Table
              head={['Code', 'Employee', 'Paid days', 'LOP', ...components, 'Gross', 'Deductions', 'Net']}
              empty={!rows.length}
              emptyLabel="No payroll run for this month yet."
            >
              {rows.map((p) => (
                <tr key={p.employee_code}>
                  <Td className="font-mono text-[12px]">{p.employee_code}</Td>
                  <Td className="font-medium">{p.full_name}</Td>
                  <Td>{p.paid_days}</Td>
                  <Td>
                    {Number(p.lop_days) > 0
                      ? <Badge tone="warning">{p.lop_days}</Badge>
                      : '—'}
                  </Td>
                  {components.map((c) => (
                    <Td key={c} className={(p.breakup?.[c] ?? 0) < 0 ? 'text-destructive' : undefined}>
                      {p.breakup?.[c] != null ? formatPaise(Math.abs(p.breakup[c])) : '—'}
                    </Td>
                  ))}
                  <Td>{formatPaise(p.gross_paise)}</Td>
                  <Td className="text-destructive">{formatPaise(p.deduction_paise)}</Td>
                  <Td className="font-medium">{formatPaise(p.net_paise)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
