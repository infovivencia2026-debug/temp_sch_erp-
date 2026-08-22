import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, FormNotice, Loading, ErrorState, ExportButton, PrintButton,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

interface Payslip {
  run_status?: string
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
  /* The month, moved forward one deliberate step at a time.
   *
   * Running payroll used to be the end of it: no moment at which HR said the
   * numbers were finished, nothing stopping attendance from quietly changing a
   * figure already approved, and nobody told their pay was ready. The bank file
   * could be drawn from a draft, which is a school paying real money out of
   * numbers it had not agreed to.
   *
   * Only the next step is offered. A row of four buttons where three are wrong
   * is a row of three chances to do the wrong one. */
  const [note, setNote] = useState('')
  /* Published is not a state the run carries.
   *
   * There are four statuses and 'published' is not one of them — publishing is
   * an act, not a stage, so the row stays 'paid' afterwards. That left the card
   * still headed "Paid" and still offering Publish, which invites somebody to
   * send every teacher a second notification about the same payslip. The act
   * is remembered here for the rest of the visit, which is as long as the
   * question "did I already publish this?" is being asked. */
  const [publishedNow, setPublishedNow] = useState('')
  const state = useMutation({
    mutationFn: (to: 'locked' | 'paid' | 'published' | 'draft') =>
      api.post<{ notified: number; emailed: number; email_failed: number }>(
        '/api/v1/payroll/state', { month: Number(month), year: Number(year), to },
      ),
    onSuccess: (r, to) => {
      setNote(
        to === 'locked'
          ? 'Locked. Attendance can no longer change these figures, and finance can draw the bank file.'
          : to === 'paid'
            ? 'Marked as paid. Publish the payslips now and staff will be told.'
            : to === 'draft'
              ? 'Unlocked. It can be run again.'
              : `Published. ${r.notified} staff notified` +
                (r.emailed ? `, ${r.emailed} emailed` : '') +
                (r.email_failed
                  ? `. ${r.email_failed} could not be emailed — check the mail provider in Settings; they were still notified in the app.`
                  : '.'),
      )
      if (to === 'published') setPublishedNow(`${month}-${year}`)
      qc.invalidateQueries({ queryKey: ['payslips'] })
    },
  })

  const run = useMutation({
    mutationFn: () => api.post<{ employees: number; net_paise: number }>('/api/v1/payroll/run', {
      month: Number(month), year: Number(year),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payslips'] }),
  })

  const rows = slips.data?.items ?? []
  const status = rows[0]?.run_status ?? ''
  const locked = status === 'locked' || status === 'paid'
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
            <ExportButton report="payroll" /><PrintButton />
            <Select value={month} onChange={setMonth}
              options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
            <Select value={year} onChange={setYear}
              options={[now.getFullYear() - 1, now.getFullYear()].map((y) => ({
                value: String(y), label: String(y),
              }))} />
            {/* Re-running a locked month would overwrite figures somebody has
                already signed off, so it is not offered until it is unlocked. */}
            {!locked && (
              <Button disabled={run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? 'Running…' : 'Run payroll'}
              </Button>
            )}
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

        {note && <FormNotice ok={note} />}
        {state.isError && <FormNotice error={state.error} />}

        {rows.length > 0 && (
          <Card>
            <CardHeader
              title={
                publishedNow === `${month}-${year}`
                  ? 'Published'
                  : status === 'paid'
                    ? 'Paid'
                  : status === 'locked'
                    ? 'Locked — ready for the bank'
                    : 'Draft — nobody has approved these figures yet'
              }
              description={
                publishedNow === `${month}-${year}`
                  ? 'Every member of staff has been told, in the app and by email. There is nothing left to do for this month.'
                  : status === 'paid'
                  ? 'The money has gone. Publishing tells each member of staff their payslip is ready, in the app and by email.'
                  : status === 'locked'
                    ? 'Download the bank file, upload it to the school’s net banking, then mark the month paid.'
                    : 'Check the figures, then lock the month so attendance cannot change them.'
              }
              action={
                <div className="flex flex-wrap gap-2">
                  {status !== 'locked' && status !== 'paid' && (
                    <Button disabled={state.isPending} onClick={() => state.mutate('locked')}>
                      Lock payroll & send to finance
                    </Button>
                  )}
                  {locked && (
                    <a
                      className="inline-flex items-center rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-muted"
                      href={`/api/v1/payroll/bank-file?month=${month}&year=${year}`}
                    >
                      Download bank file
                    </a>
                  )}
                  {status === 'locked' && (
                    <>
                      <Button variant="secondary" disabled={state.isPending}
                        onClick={() => state.mutate('paid')}>
                        Mark as paid
                      </Button>
                      <Button variant="ghost" disabled={state.isPending}
                        onClick={() => state.mutate('draft')}>
                        Unlock
                      </Button>
                    </>
                  )}
                  {status === 'paid' && publishedNow !== `${month}-${year}` && (
                    <Button disabled={state.isPending} onClick={() => state.mutate('published')}>
                      Publish payslips
                    </Button>
                  )}
                  {publishedNow === `${month}-${year}` && (
                    <span className="text-[13px] text-success">Payslips published.</span>
                  )}
                </div>
              }
            />
          </Card>
        )}

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
