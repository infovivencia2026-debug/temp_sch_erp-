import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, FormNotice, Loading, ErrorState, ExportButton, PrintButton,
} from '@/components/ui'
import { cn, formatPaise } from '@/lib/utils'

interface Payslip {
  run_status?: string
  published?: boolean
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
  /* The immediate answer, until the refetch brings the recorded one.
   *
   * Publishing is an act rather than a stage — the run stays 'paid', because
   * paying is what happened to the money and publishing is what happened to
   * the people. Remembering it only here was the bug: reload the page and a
   * month whose staff had all been notified and emailed read "Paid" again,
   * over a Publish button. payroll_runs.published_at now records it, and this
   * only covers the moment between the click and the list coming back. */
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

  /* A month nobody marked pays everybody in full.
   *
   * Loss of pay comes from the staff register, so an unmarked month and a month
   * where everybody genuinely attended produce identical payslips — and the
   * second is the common case, which is how a school finds out in March that
   * loss of pay has never once deducted. The run stops, says how big the gap
   * is, and goes ahead only when somebody says they know. */
  const [unmarked, setUnmarked] = useState<{ staff_with_no_marks: number; unmarked_days: number } | null>(null)
  const run = useMutation({
    mutationFn: (acknowledge: boolean) =>
      api.post<{ employees: number; net_paise: number }>('/api/v1/payroll/run', {
        month: Number(month), year: Number(year),
        acknowledge_unmarked_attendance: acknowledge,
      }),
    onSuccess: () => {
      setUnmarked(null)
      qc.invalidateQueries({ queryKey: ['payslips'] })
    },
    onError: (e: unknown) => {
      const body = (e as ApiError).body as
        | { unmarked?: { staff_with_no_marks: number; unmarked_days: number } }
        | undefined
      if (body?.unmarked) setUnmarked(body.unmarked)
    },
  })

  const rows = slips.data?.items ?? []
  const status = rows[0]?.run_status ?? ''

  /* Whether the staff have been told, asked of the server rather than
     remembered.

     publishedNow was local state, so it knew only about a publish that had
     happened in this tab since it loaded. Reload the page and August — twelve
     people already notified and emailed — read "Paid" again, over a "Publish
     payslips" button. The only way to know it was done was to remember doing
     it, and the cost of forgetting is telling twelve people twice.

     publishedNow stays as the immediate answer, because the list is refetched
     after the mutation and the two would otherwise disagree for a moment. */
  const published = rows[0]?.published === true || publishedNow === `${month}-${year}`
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
              <Button disabled={run.isPending} onClick={() => run.mutate(false)}>
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

        {unmarked && (
          <Card>
            <CardHeader
              title="Nobody marked the register for this month"
              description={
                `${unmarked.staff_with_no_marks} staff have no attendance at all, and ` +
                `${unmarked.unmarked_days} working days are unaccounted for. Their days will be ` +
                'paid in full, and loss of pay will deduct nothing. That may be exactly right — ' +
                'a school that keeps its register on paper still pays people on the 30th — but ' +
                'it should be a decision, not an accident.'
              }
            />
            <label className="flex items-start gap-2 text-[14px]">
              <input
                type="checkbox"
                onChange={(e) => { if (e.target.checked) run.mutate(true) }}
                className="mt-1"
              />
              <span>I acknowledge this, and want to run payroll anyway.</span>
            </label>
          </Card>
        )}
        {note && <FormNotice ok={note} />}
        {state.isError && <FormNotice error={state.error} />}

        {rows.length > 0 && (
          <Card>
            <CardHeader
              title={
                published
                  ? 'Published'
                  : status === 'paid'
                    ? 'Paid'
                  : status === 'locked'
                    ? 'Locked — ready for the bank'
                    : 'Draft — nobody has approved these figures yet'
              }
              description={
                published
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
                  {status === 'paid' && !published && (
                    <Button disabled={state.isPending} onClick={() => state.mutate('published')}>
                      Publish payslips
                    </Button>
                  )}
                  {published && (
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
                  {/* .num: a dozen salary components squeeze these columns
                      hard, and without it the browser broke ₹1,800 across
                      three lines rather than let the table scroll. */}
                  <Td className="num font-mono text-[12px]">{p.employee_code}</Td>
                  <Td className="font-medium">{p.full_name}</Td>
                  <Td className="num">{p.paid_days}</Td>
                  <Td className="num">
                    {Number(p.lop_days) > 0
                      ? <Badge tone="warning">{p.lop_days}</Badge>
                      : '—'}
                  </Td>
                  {components.map((c) => (
                    <Td key={c} className={cn('num', (p.breakup?.[c] ?? 0) < 0 && 'text-destructive')}>
                      {p.breakup?.[c] != null ? formatPaise(Math.abs(p.breakup[c])) : '—'}
                    </Td>
                  ))}
                  <Td className="num">{formatPaise(p.gross_paise)}</Td>
                  <Td className="num text-destructive">{formatPaise(p.deduction_paise)}</Td>
                  <Td className="num font-medium">{formatPaise(p.net_paise)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
