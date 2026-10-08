import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, FormNotice, SkeletonTable, ErrorState, ExportButton,
  UnavailableState,
} from '@/components/ui'
import { MonthField } from '@/components/DatePopover'
import { useCan, useSession } from '@/lib/session'
import { Printer } from 'lucide-react'
import { printHtml } from '@/features/finance/receipt-print'
import { registerHtml } from './payroll-print'
import { useToast } from '@/components/Toast'
import { cn, formatPaise } from '@/lib/utils'

interface Payslip {
  run_status?: string
  published?: boolean
  left_service?: boolean
  employee_code: string; full_name: string
  paid_days: string; lop_days: string
  gross_paise: number; deduction_paise: number; net_paise: number
  breakup: Record<string, number>
  bank_ready?: boolean
  employee_id?: string
}
interface UnmarkedStaff { id: string; code: string; name: string; monthly_paise: number }
interface Unmarked { staff_with_no_marks: number; unmarked_days: number; staff?: UnmarkedStaff[] }

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December']

/** Payroll. Earnings pro-rate on paid days derived from staff attendance;
    deductions do not. A locked run is never recomputed. */
export default function Payroll() {
  const qc = useQueryClient()
  const now = new Date()
  const [month, setMonth] = useState(String(now.getMonth() + 1))
  const [year, setYear] = useState(String(now.getFullYear()))
  /* Finance opens this screen under "Approve & pay salaries", but the payroll
     routes sit behind hr.payroll.read (Go and the Worker alike). Without it the
     page asked three times, got 403 three times, and showed a zero month with
     a Run payroll button that could only fail. */
  const can = useCan()
  const session = useSession()
  const canRead = can('hr.payroll.read')
  const canRun = can('hr.payroll.write')

  const slips = useQuery({
    queryKey: ['payslips', month, year],
    queryFn: () => api.get<List<Payslip>>(`/api/v1/payroll/payslips?month=${month}&year=${year}`),
    enabled: canRead,
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
                  ? `. ${r.email_failed} could not be emailed, check the mail provider in Settings; they were still notified in the app.`
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
  const [unmarked, setUnmarked] = useState<Unmarked | null>(null)
  /* The staff this run would not pay at all, because no salary is in force
     for them this month. A different question from an unmarked register, and
     a worse one, so it is asked before it. */
  const [unpaid, setUnpaid] = useState<{ count: number; staff: { id: string; code: string; name: string }[] } | null>(null)
  const [okUnpaid, setOkUnpaid] = useState(false)
  /* Who to leave out of this month: ticked = paid in full, unticked = left out. */
  const [leaveOut, setLeaveOut] = useState<Set<string>>(new Set())
  const run = useMutation({
    mutationFn: (acknowledge: boolean) =>
      api.post<{ employees: number; net_paise: number }>('/api/v1/payroll/run', {
        month: Number(month), year: Number(year),
        acknowledge_unmarked_attendance: acknowledge,
        acknowledge_unpaid_staff: okUnpaid,
        exclude_employee_ids: [...leaveOut],
      }),
    onSuccess: () => {
      setUnmarked(null)
      setUnpaid(null)
      setOkUnpaid(false)
      setLeaveOut(new Set())
      qc.invalidateQueries({ queryKey: ['payslips'] })
    },
    onError: (e: unknown) => {
      const body = (e as ApiError).body as
        | { unmarked?: Unmarked; unpaid?: { count: number; staff: { id: string; code: string; name: string }[] } }
        | undefined
      if (body?.unmarked) setUnmarked(body.unmarked)
      if (body?.unpaid) setUnpaid(body.unpaid)
    },
  })

  const rows = slips.data?.items ?? []
  const status = rows[0]?.run_status ?? ''

  /* TWO NUMBERS THAT CANNOT BOTH BE TRUE.
   *
   * A payslip carries the days paid and the days lost, and they are written
   * together from one calculation -- so if a row shows three days of loss of
   * pay beside a full month paid, that row was not produced by the rule the
   * column headings claim. It happens when a month is run, the attendance
   * behind it changes, and the month is never re-run: the loss-of-pay figure
   * is refreshed on screen while the money stays at the old numbers.
   *
   * October 2026 on this school was exactly that, published, with every one
   * of eight people showing loss of pay and a full month's pay, and nothing
   * anywhere saying the two disagreed. The arithmetic was right; the row was
   * stale, which no amount of reading the code would have shown.
   *
   * Flagged, not silently recomputed: the figures on a published month are
   * what somebody was paid, and a screen must not quietly redraw history.
   * Re-running the month is a decision, and it has a button. */
  const stale = rows.filter((p) => {
    const lop = Number(p.lop_days) || 0
    const paid = Number(p.paid_days) || 0
    return lop > 0 && paid > 0 && paid + lop > 31.5
  })

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
  const left = rows.filter((r) => r.left_service).length
  const locked = status === 'locked' || status === 'paid'
  const gross = rows.reduce((a, r) => a + r.gross_paise, 0)
  const ded = rows.reduce((a, r) => a + r.deduction_paise, 0)
  const net = rows.reduce((a, r) => a + r.net_paise, 0)
  /* The owner's payroll register (payroll-print.ts), not a copy of this screen. */
  /* Never a greyed-out button that says nothing (owner: "print is not
     working"): with no run for the month, it says so and names the fix. */
  const toast = useToast()
  const printRegister = () => rows.length ? printHtml(registerHtml({
    school: {
      name: session.institution?.display_name ?? 'School',
      logoUrl: session.institution?.logo_key ? `${location.origin}/api/v1/files/${session.institution.logo_key}?inline=1` : undefined,
    },
    month: Number(month), year: Number(year), status, published, rows, printedBy: session.user?.full_name ?? '',
  })) : toast.error(`No payroll has been run for ${MONTHS[Number(month) - 1]} ${year} yet, so there is nothing to print. Choose a month that has been run, or run this one first.`)
  const components = [...new Set(rows.flatMap((r) => Object.keys(r.breakup ?? {})))].sort()

  if (!canRead) {
    return (
      <PageBody>
        <UnavailableState
          title="The payroll run is HR's to show"
          body="Your role does not include viewing payroll. Ask the school admin to grant payroll view to your role, or use Release the money for the bank file."
        />
      </PageBody>
    )
  }

  return (
    <>
      <PageHead
        eyebrow="HR Workspace"
        title="Payroll"
        description="Run monthly salaries. Loss of pay comes from staff attendance, not manual entry."
        actions={
          <>
            <ExportButton report="payroll" query={{ month, year }} />
            <Button variant="secondary" onClick={printRegister}>
              <Printer className="h-4 w-4" /> Print
            </Button>
            {/* One control, not two lists. "July 2026" was a month dropdown
                and a year dropdown side by side: two decisions for one
                answer, and the year list only ever held two entries. */}
            <MonthField
              month={Number(month)}
              year={Number(year)}
              onPick={(m, y) => { setMonth(String(m)); setYear(String(y)) }}
              className="w-[190px]"
            />
            {/* Re-running a locked month would overwrite figures somebody has
                already signed off, so it is not offered until it is unlocked. */}
            {!locked && canRun && (
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

        {unpaid && (
          <Card className="border-destructive/40 bg-destructive/[0.04]">
            <CardHeader title={`${unpaid.count} on the roll would not be paid at all`} />
            <div className="px-5 pb-2 text-[13px] text-muted-foreground">
              No salary is in force for them this month, so the run skips them entirely — they get no
              payslip and no line anywhere. Set a salary, or run the month without them.
            </div>
            <ul className="flex flex-wrap gap-x-5 gap-y-1 px-5 pb-4 text-[13px]">
              {unpaid.staff.map((s2) => (
                <li key={s2.id}>
                  <span className="font-mono text-[12px] text-muted-foreground">{s2.code}</span>{' '}
                  {s2.name}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2 px-5 pb-5">
              <Button
                disabled={run.isPending}
                onClick={() => { setOkUnpaid(true); setUnpaid(null); setTimeout(() => run.mutate(false), 0) }}
              >
                Run without them
              </Button>
              <a href="/hr/payroll/salary_setup" className="text-[13px] font-medium text-primary underline-offset-2 hover:underline">
                Set their salary first
              </a>
              <Button variant="ghost" onClick={() => setUnpaid(null)}>Cancel</Button>
            </div>
          </Card>
        )}
        {unmarked && (
          <Card>
            <CardHeader
              title={`${unmarked.staff_with_no_marks} ${unmarked.staff_with_no_marks === 1 ? 'person has' : 'people have'} no attendance this month`}
              description="Nobody marked their register, so they would be paid in full with no loss of pay. Untick anyone who should not be paid this month, or mark their attendance first on Staff register."
            />
            {(unmarked.staff ?? []).length > 0 && (
              <Table head={['Pay this month', 'Code', 'Name', 'Monthly pay']}>
                {(unmarked.staff ?? []).map((s) => (
                  <tr key={s.id}>
                    <Td>
                      <input type="checkbox" aria-label={`Pay ${s.name} this month`} checked={!leaveOut.has(s.id)}
                        onChange={(e) => setLeaveOut((cur) => { const n = new Set(cur); if (e.target.checked) n.delete(s.id); else n.add(s.id); return n })} />
                    </Td>
                    <Td className="font-mono text-[12px]">{s.code}</Td>
                    <Td className="font-medium">{s.name}</Td>
                    <Td className="tabular-nums">{s.monthly_paise ? formatPaise(s.monthly_paise) : '-'}</Td>
                  </tr>
                ))}
              </Table>
            )}
            <div className="flex flex-wrap items-center gap-2 px-5 pb-5 pt-4">
              <Button disabled={run.isPending} onClick={() => run.mutate(true)}>
                {leaveOut.size ? `Run payroll, leaving out ${leaveOut.size}` : 'Run payroll, paying them in full'}
              </Button>
              <a href="/hr/attendance/staff_register" className="text-[13px] font-medium text-primary underline-offset-2 hover:underline">Mark attendance first</a>
              <Button variant="ghost" onClick={() => { setUnmarked(null); setLeaveOut(new Set()) }}>Cancel</Button>
            </div>
          </Card>
        )}
        {(() => {
          /* The bank file pays by account number and IFSC; a person without
             them is a blank line the bank will bounce (owner, 2026-10-08). */
          const noBank = (slips.data?.items ?? []).filter((s) => s.bank_ready === false)
          if (!noBank.length) return null
          return (
            <FormNotice error={new Error(`${noBank.length} of ${(slips.data?.items ?? []).length} staff have no bank account or IFSC, so the bank file cannot pay them: ${noBank.map((s) => s.full_name).join(', ')}. Add them on Staff records → the person → Bank details.`)} />
          )
        })()}
        {stale.length > 0 && (
          <Card className="border-destructive/40 bg-destructive/[0.04] p-4">
            <p className="text-[14px] font-semibold">
              These figures are out of date, and the pay below is not what the attendance now says.
            </p>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              {stale.length} {stale.length === 1 ? 'person has' : 'people have'} loss of pay recorded and
              a full month paid, which the calculation cannot produce. The month was run, the attendance
              behind it changed, and it was never run again. Reopen the month and run it to settle it —
              publishing again is a separate press, and only that tells the staff.
            </p>
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
                    ? 'Locked, ready for the bank'
                    : 'Draft, nobody has approved these figures yet'
              }
              action={
                /* Only what this login may do. Finance reads payroll to approve it and
                   was shown HR's Lock button, which answered "Forbidden." (owner, 2026-10-08). */
                !canRun ? (
                  locked ? (
                    stale.length > 0 ? (
                      <span className="inline-flex cursor-not-allowed items-center rounded-md border px-3 py-1.5 text-[13px] font-medium opacity-50"
                        title="These figures are out of date. Run the month first.">
                        Download bank file
                      </span>
                    ) : (
                    <a
                      className="inline-flex items-center rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-muted"
                      href={`/api/v1/payroll/bank-file?month=${month}&year=${year}`}
                    >
                      Download bank file
                    </a>
                    )
                  ) : (
                    <span className="text-[13px] text-muted-foreground">HR checks and locks these figures; nothing to do here yet.</span>
                  )
                ) : (
                <div className="flex flex-wrap gap-2">
                  {/* STALE FIGURES DO NOT GO TO A BANK.
                      Warning and then allowing it is not a warning. While a
                      row shows loss of pay beside a full month's pay, the
                      month cannot be locked and no file can be drawn from
                      it: those are the two steps that turn these numbers
                      into money leaving the school. Run the month and both
                      come back. */}
                  {status !== 'locked' && status !== 'paid' && (
                    <Button disabled={state.isPending || stale.length > 0} onClick={() => state.mutate('locked')}>
                      Lock payroll & send to finance
                    </Button>
                  )}
                  {locked && (
                    stale.length > 0 ? (
                      <span className="inline-flex cursor-not-allowed items-center rounded-md border px-3 py-1.5 text-[13px] font-medium opacity-50"
                        title="These figures are out of date. Run the month first.">
                        Download bank file
                      </span>
                    ) : (
                    <a
                      className="inline-flex items-center rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-muted"
                      href={`/api/v1/payroll/bank-file?month=${month}&year=${year}`}
                    >
                      Download bank file
                    </a>
                    )
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
                  {/* A WAY BACK FROM A MONTH THAT HAS ALREADY GONE OUT.
                      Once a month reached paid or published the only button
                      left was Download bank file, so a month published with
                      the wrong figures could not be corrected at all.
                      Permanently wrong pay is worse than a reopened month.
                      Re-publishing is a separate press, and that is what
                      tells the staff again. */}
                  {status === 'paid' && (
                    <Button variant="ghost" disabled={state.isPending}
                      onClick={() => state.mutate('draft')}>
                      {published ? 'Reopen this month' : 'Unlock'}
                    </Button>
                  )}
                </div>
                )
              }
            />
            {/* WHERE THE SENTENCE ACTUALLY GOES.

                This card carried its whole meaning in CardHeader's
                `description`, and card descriptions are no longer drawn
                anywhere in the product -- the prop is kept so screens do not
                break. So what was left on screen was a 62px strip reading
                "Published", a button, and a green "Payslips published."
                repeating the title, with an empty band between them. The one
                line a person needs -- the money has gone, nobody has approved
                this yet, here is what to do next -- was not rendered at all.

                In the body, where it is drawn, and the redundant green echo
                of the title is gone with it. */}
            <p className="px-[var(--card-pad)] py-3 text-[13px] text-muted-foreground">
              {published
                ? 'Every member of staff has been told, in the app and by email. There is nothing left to do for this month.'
                : status === 'paid'
                  ? 'The money has gone. Publishing tells each member of staff their payslip is ready, in the app and by email.'
                  : status === 'locked'
                    ? 'Download the bank file, upload it to the school’s net banking, then mark the month paid.'
                    : 'Check the figures, then lock the month so attendance cannot change them.'}
            </p>
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
            title={`Payslips · ${MONTHS[Number(month) - 1]} ${year}`}
            description={
              /* Why this count can differ from the staff headcount.
                 A payslip records money that moved, so it outlives the person
                 leaving. HR said 11 and this said 12, both correct, and
                 nothing on either screen explained the gap. */
              left
                ? `Breakup is frozen at run time, so an issued payslip keeps its numbers. ${rows.length} paid this month, including ${left} who ${left === 1 ? 'has' : 'have'} since left, the current staff count will be lower.`
                : 'Breakup is frozen at run time so an issued payslip keeps its numbers'
            }
          />
          {slips.isLoading ? <SkeletonTable columns={8} /> : slips.error ? <ErrorState error={slips.error} /> : (
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
                  <Td className="font-medium">
                    {p.full_name}
                    {p.left_service && (
                      <span className="ml-2 align-middle">
                        <Badge tone="neutral">left</Badge>
                      </span>
                    )}
                  </Td>
                  <Td className="num">{p.paid_days}</Td>
                  <Td className="num">
                    {Number(p.lop_days) > 0
                      ? <Badge tone="warning">{p.lop_days}</Badge>
                      : '-'}
                  </Td>
                  {components.map((c) => (
                    <Td key={c} className={cn('num', (p.breakup?.[c] ?? 0) < 0 && 'text-destructive')}>
                      {p.breakup?.[c] != null ? formatPaise(Math.abs(p.breakup[c])) : '-'}
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
