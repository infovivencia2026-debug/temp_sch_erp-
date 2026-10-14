import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { YearEndRate, YearEndRow, YearEndSettings, YearEndSummary } from '@shared/api/feature_year_end_payout'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, ConfirmButton, Checkbox, Input, Select,
  FormNotice, ErrorState, SkeletonTable, UnavailableState,
} from '@/components/ui'
import { MonthField } from '@/components/DatePopover'
import { useCan } from '@/lib/session'
import { formatDate, formatPaise } from '@/lib/utils'

/* YEAR-END PAYOUT (owner, 2026-10-14: "holiday pay may be given at the end of
   the working month of the academic year... if no leave is applied that is
   also considered as a pay"). One row per member of staff: the leave they had,
   took and left, the holidays they worked, and the money each comes to at the
   school's rates. Save adds it to one month's payroll as Changes to pay, once
   per year; it can be removed and redone while that month is open.
   Reads GET /payroll/year-end (worker/src/routes/payroll/year_end_payout.ts). */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const RATE_OPTIONS: { value: YearEndRate; label: string }[] = [
  { value: 'gross_30', label: "A day's pay: gross ÷ 30" },
  { value: 'ctc_30', label: "A day's pay: CTC ÷ 30" },
  { value: 'pattern', label: "A day's pay: gross ÷ work pattern days" },
  { value: 'fixed', label: 'Fixed amount a day' },
]

interface Edit { holiday_days: string; holiday_paise: string; leave_days: string; leave_paise: string }
const rupees = (paise: number) => String(Math.round(paise) / 100)
const paise = (s: string) => Math.round((Number(s) || 0) * 100)

export default function YearEndPayout() {
  const qc = useQueryClient()
  const can = useCan()
  const canRead = can('hr.payroll.read')
  const canWrite = can('hr.payroll.write')
  const [yearId, setYearId] = useState('')
  const [pay, setPay] = useState<{ month: number; year: number } | null>(null)

  const q = useQuery({
    queryKey: ['year-end-payout', yearId, pay?.month, pay?.year],
    queryFn: () => api.call('GET /payroll/year-end', { query: { year_id: yearId || undefined, month: pay?.month, year: pay?.year } }),
    enabled: canRead,
  })
  const d = q.data
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['year-end-payout'] })
    qc.invalidateQueries({ queryKey: ['payroll-adjustments'] })
    qc.invalidateQueries({ queryKey: ['payslips'] })
  }

  if (!canRead) return <UnavailableState title="Year-end payout" body="Your role cannot see payroll." />
  return (
    <>
      <PageHead eyebrow="Payroll" title="Year-end payout" />
      <PageBody>
        {q.isError ? <ErrorState error={q.error} /> : !d ? <SkeletonTable /> : (
          <Loaded d={d} yearId={yearId} setYearId={setYearId} pay={pay} setPay={setPay} canWrite={canWrite} refresh={refresh} />
        )}
      </PageBody>
    </>
  )
}

function Loaded({ d, yearId, setYearId, pay, setPay, canWrite, refresh }: {
  d: YearEndSummary; yearId: string; setYearId: (v: string) => void
  pay: { month: number; year: number } | null; setPay: (v: { month: number; year: number }) => void
  canWrite: boolean; refresh: () => void
}) {
  const month = pay?.month ?? d.pay_month, year = pay?.year ?? d.pay_year
  const monthName = month ? `${MONTHS[month - 1]} ${year}` : 'the month'
  const paid = d.paid
  const editable = canWrite && d.settings.available && !d.month_locked && !paid
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  // A new year, month or rate starts the ticks and hand figures afresh: the rows underneath changed.
  useEffect(() => { setTicked({}); setEdits({}) }, [d.year?.id, d.pay_month, d.pay_year, d.settings])

  const editOf = (r: YearEndRow): Edit => edits[r.employee_id] ?? {
    holiday_days: String(r.holiday_days), holiday_paise: rupees(r.holiday_paise), leave_days: String(r.leave_days), leave_paise: rupees(r.leave_paise),
  }
  const isTicked = (r: YearEndRow) => ticked[r.employee_id] ?? !r.no_salary
  const setEdit = (r: YearEndRow, patch: Partial<Edit>) => {
    const cur = editOf(r)
    const next = { ...cur, ...patch }
    // Days typed by hand re-price at the row's own rate; an amount typed by hand stands as typed.
    if (patch.holiday_days !== undefined) next.holiday_paise = rupees((Number(patch.holiday_days) || 0) * r.day_pay_paise)
    if (patch.leave_days !== undefined) {
      const unit = r.leave_days > 0 ? r.leave_paise / r.leave_days : r.day_pay_paise
      next.leave_paise = rupees((Number(patch.leave_days) || 0) * unit)
    }
    setEdits({ ...edits, [r.employee_id]: next })
  }
  const rowsToSave = useMemo(() => d.rows.filter(isTicked).map((r) => {
    const e = editOf(r)
    return { employee_id: r.employee_id, holiday_days: Number(e.holiday_days) || 0, holiday_paise: paise(e.holiday_paise), leave_days: Number(e.leave_days) || 0, leave_paise: paise(e.leave_paise) }
  }), [d.rows, ticked, edits]) // eslint-disable-line react-hooks/exhaustive-deps
  const total = rowsToSave.reduce((n, r) => n + r.holiday_paise + r.leave_paise, 0)
  const people = rowsToSave.filter((r) => r.holiday_paise + r.leave_paise > 0).length

  const save = useMutation({
    mutationFn: () => api.call('POST /payroll/year-end', { body: { year_id: d.year!.id, month, year, rows: rowsToSave } }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () => api.call('DELETE /payroll/year-end/{id}', { params: { id: paid!.id } }),
    onSuccess: refresh,
  })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Which year, paid in which month" />
        <div className="flex flex-wrap items-end gap-3 px-5 py-4">
          <div className="w-full sm:w-64">
            <div className="mb-1 text-[12px] text-muted-foreground">Academic year</div>
            <Select value={d.year?.id ?? yearId} onChange={setYearId} placeholder="Choose a year"
              options={d.years.map((y) => ({ value: y.id, label: y.name }))} />
          </div>
          <div>
            <div className="mb-1 text-[12px] text-muted-foreground">Add to the payroll of</div>
            <MonthField month={month || 1} year={year || new Date().getFullYear()} onPick={(m, y) => setPay({ month: m, year: y })} />
          </div>
          {d.year && <div className="text-[13px] text-muted-foreground">{formatDate(d.year.starts_on)} to {formatDate(d.year.ends_on)}</div>}
        </div>
        {paid && (
          <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3 text-[13px]">
            <Badge tone="success">Added</Badge>
            <span>Already added to {MONTHS[paid.month - 1]} {paid.year} payroll on {formatDate(paid.at)}{paid.by_name ? ` by ${paid.by_name}` : ''}: {paid.people} people, {formatPaise(paid.total_paise)}.</span>
            {canWrite && (
              <ConfirmButton confirmLabel="Remove" tone="danger" disabled={d.month_locked || remove.isPending}
                question={d.month_locked ? `${MONTHS[paid.month - 1]} ${paid.year} is locked. Unlock it on Monthly payroll first.` : `Remove these changes to pay from ${MONTHS[paid.month - 1]} ${paid.year}? You can save the payout again afterwards.`}
                onConfirm={() => remove.mutate()}>
                Remove and redo
              </ConfirmButton>
            )}
            <div className="w-full"><FormNotice error={remove.error} /></div>
          </div>
        )}
        {!paid && d.month_locked && (
          <div className="border-t px-5 py-3 text-[13px]">{monthName} is locked. Unlock it on Monthly payroll to add the payout there, or pick another month.</div>
        )}
        {!d.settings.available && (
          <div className="border-t px-5 py-3 text-[13px]">This school's database needs migration 0087 before rates or a payout can be saved. The figures below use the default rates.</div>
        )}
        {d.pay_holidays_worked && (
          <div className="border-t px-5 py-3 text-[13px]">Holidays worked are already paid every month (Taxes &amp; statutory, Settings). Paying them here as well pays them twice: set the holiday amounts to 0 or switch that off.</div>
        )}
      </Card>

      <Rates settings={d.settings} canWrite={canWrite} leaveTypes={d.leave_types} onSaved={refresh} />

      <Card>
        <CardHeader title={d.year ? `Staff, ${d.year.name}` : 'Staff'} />
        <Table head={['', 'Name', 'Leave quota', 'Leave taken', 'Unused', 'Holidays worked', 'Holiday days', 'Holiday pay', 'Leave days', 'Leave pay', 'Total']}
          empty={d.rows.length === 0} emptyLabel="Nobody active on the staff roll." wide>
          {d.rows.map((r) => {
            const e = editOf(r)
            const on = isTicked(r)
            const rowTotal = paise(e.holiday_paise) + paise(e.leave_paise)
            return (
              <tr key={r.employee_id} className={on ? '' : 'opacity-60'}>
                <Td><Checkbox checked={on} onChange={(v) => setTicked({ ...ticked, [r.employee_id]: v })} label="" srLabel={`Include ${r.full_name}`} /></Td>
                <Td className="font-medium">
                  {r.full_name}
                  <span className="block text-[12px] text-muted-foreground">{r.employee_code}{r.no_salary ? ' · no salary in force' : ''}</span>
                </Td>
                <Td className="num">{r.leave_quota}</Td>
                <Td>
                  <span className="num">{r.leave_taken}</span>
                  {r.leave_taken_dates.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => setOpen({ ...open, ['l' + r.employee_id]: !open['l' + r.employee_id] })}>
                      {open['l' + r.employee_id] ? 'Hide dates' : 'Dates'}
                    </Button>
                  )}
                  {open['l' + r.employee_id] && (
                    <ul className="mt-1 text-[12px] text-muted-foreground">
                      {r.leave_taken_dates.map((t, i) => (
                        <li key={i}>{t.on === t.to ? formatDate(t.on) : `${formatDate(t.on)} to ${formatDate(t.to)}`} · {t.days} {t.type}</li>
                      ))}
                    </ul>
                  )}
                </Td>
                <Td className="num">{r.leave_unused}</Td>
                <Td>
                  <span className="num">{r.holiday_dates.length}{r.holiday_manual > 0 ? ` + ${r.holiday_manual} typed in` : ''}</span>
                  {r.holiday_dates.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => setOpen({ ...open, ['h' + r.employee_id]: !open['h' + r.employee_id] })}>
                      {open['h' + r.employee_id] ? 'Hide dates' : 'Dates'}
                    </Button>
                  )}
                  {open['h' + r.employee_id] && (
                    <ul className="mt-1 text-[12px] text-muted-foreground">
                      {r.holiday_dates.map((day) => <li key={day}>{formatDate(day)}</li>)}
                    </ul>
                  )}
                </Td>
                <Td className="num">{editable ? <Input value={e.holiday_days} onChange={(v) => setEdit(r, { holiday_days: v })} type="number" srLabel="Holiday days" className="w-20" /> : e.holiday_days}</Td>
                <Td className="num">{editable ? <Input value={e.holiday_paise} onChange={(v) => setEdit(r, { holiday_paise: v })} type="number" srLabel="Holiday pay" className="w-28" /> : formatPaise(paise(e.holiday_paise))}</Td>
                <Td className="num">{editable ? <Input value={e.leave_days} onChange={(v) => setEdit(r, { leave_days: v })} type="number" srLabel="Leave days" className="w-20" /> : e.leave_days}</Td>
                <Td className="num">{editable ? <Input value={e.leave_paise} onChange={(v) => setEdit(r, { leave_paise: v })} type="number" srLabel="Leave pay" className="w-28" /> : formatPaise(paise(e.leave_paise))}</Td>
                <Td className="num font-medium">{formatPaise(rowTotal)}</Td>
              </tr>
            )
          })}
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
          <div className="text-[13px]">{people} people, {formatPaise(total)}</div>
          {canWrite && !paid && (
            <Button disabled={!editable || people === 0 || !d.year || save.isPending} needsNetwork onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : `Save to ${monthName} payroll`}
            </Button>
          )}
          <div className="w-full"><FormNotice error={save.error} ok={save.isSuccess ? `Added to ${monthName} payroll as changes to pay.` : undefined} /></div>
        </div>
      </Card>
    </div>
  )
}

function Rates({ settings, canWrite, leaveTypes, onSaved }: {
  settings: YearEndSettings; canWrite: boolean; leaveTypes: YearEndSummary['leave_types']; onSaved: () => void
}) {
  const [v, setV] = useState<YearEndSettings>(settings)
  useEffect(() => setV(settings), [settings])
  const save = useMutation({
    mutationFn: () => api.call('PUT /payroll/year-end/settings', { body: v }),
    onSuccess: onSaved,
  })
  const counted = leaveTypes.filter((t) => (v.leave_types === 'paid' ? t.is_paid : t.encashable)).map((t) => t.name)
  const editable = canWrite && settings.available
  return (
    <Card>
      <CardHeader title="Rates" />
      <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="text-[13px] font-medium">Holiday work</div>
          <Select value={v.holiday_rate} onChange={(x) => setV({ ...v, holiday_rate: x as YearEndRate })} options={RATE_OPTIONS} />
          {v.holiday_rate === 'fixed' && <Input value={rupees(v.holiday_fixed_paise)} onChange={(x) => setV({ ...v, holiday_fixed_paise: paise(x) })} type="number" placeholder="₹ a day" srLabel="Holiday work, rupees a day" />}
          <Input value={v.holiday_max_days ? String(v.holiday_max_days) : ''} onChange={(x) => setV({ ...v, holiday_max_days: Number(x) || 0 })} type="number" placeholder="Most days paid (blank = no cap)" srLabel="Holiday work, most days paid" />
        </div>
        <div className="space-y-2">
          <div className="text-[13px] font-medium">Unused leave</div>
          <Select value={v.leave_rate} onChange={(x) => setV({ ...v, leave_rate: x as YearEndRate })} options={RATE_OPTIONS} />
          {v.leave_rate === 'fixed' && <Input value={rupees(v.leave_fixed_paise)} onChange={(x) => setV({ ...v, leave_fixed_paise: paise(x) })} type="number" placeholder="₹ a day" srLabel="Unused leave, rupees a day" />}
          <Input value={v.leave_max_days ? String(v.leave_max_days) : ''} onChange={(x) => setV({ ...v, leave_max_days: Number(x) || 0 })} type="number" placeholder="Most days paid (blank = no cap)" srLabel="Unused leave, most days paid" />
          <Select value={v.leave_types} onChange={(x) => setV({ ...v, leave_types: x === 'paid' ? 'paid' : 'encashable' })}
            options={[{ value: 'encashable', label: 'Leave types marked encashable in the leave policy' }, { value: 'paid', label: 'Every paid leave type' }]} />
          <div className="text-[12px] text-muted-foreground">{counted.length ? `Counts: ${counted.join(', ')}` : 'No leave type counts yet. Mark one encashable under Leave policy.'}</div>
        </div>
      </div>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3">
          <Button variant="secondary" disabled={!editable || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save rates'}</Button>
          <FormNotice error={save.error} ok={save.isSuccess ? 'Rates saved. The table has been worked out again.' : undefined} />
        </div>
      )}
    </Card>
  )
}
