import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { Card, CardHeader, Table, Td, Button, Input, Select, FormNotice } from '@/components/ui'

interface Row { employee_id: string; holidays_worked: number; vacation_days: number; vacation_dates: string }

/* HOLIDAYS WORKED AND VACATION, typed in for the month. Holidays worked are
   paid as extra days when the school turns that on (Statutory -> Settings);
   days marked present on a holiday in the register are counted as well.
   Vacation is recorded for the salary statement and does not change pay. */
export function MonthDays({ month, year, people, locked, canWrite }: {
  month: string; year: string; locked: boolean; canWrite: boolean
  people: { employee_id?: string; employee_code: string; full_name: string }[]
}) {
  const qc = useQueryClient()
  const [who, setWho] = useState('')
  const [hw, setHw] = useState('')
  const [vd, setVd] = useState('')
  const [dates, setDates] = useState('')
  const list = useQuery({
    queryKey: ['payroll-month-days', month, year],
    queryFn: () => api.get<List<Row>>(`/api/v1/payroll/month-days?month=${month}&year=${year}`),
  })
  const save = useMutation({
    mutationFn: () => api.put('/api/v1/payroll/month-days', {
      month: Number(month), year: Number(year), employee_id: who,
      holidays_worked: Number(hw) || 0, vacation_days: Number(vd) || 0, vacation_dates: dates.trim(),
    }),
    onSuccess: () => { setHw(''); setVd(''); setDates(''); qc.invalidateQueries({ queryKey: ['payroll-month-days'] }) },
  })
  const rows = (list.data?.items ?? []).filter((r) => r.vacation_days > 0)
  const editable = canWrite && !locked
  if (!editable && rows.length === 0) return null
  const name = (id: string) => {
    const p = people.find((x) => x.employee_id === id)
    return p ? `${p.full_name} (${p.employee_code})` : 'Former staff'
  }
  const pickPerson = (id: string) => {
    setWho(id)
    const r = (list.data?.items ?? []).find((x) => x.employee_id === id)
    setHw(r ? String(r.holidays_worked) : ''); setVd(r ? String(r.vacation_days) : ''); setDates(r?.vacation_dates ?? '')
  }

  return (
    <Card>
      <CardHeader
        title="Vacation taken"
        description="Vacation days and dates for the month, shown on the salary statement. Pay for holidays worked goes in Changes to pay above."
      />
      {editable && (
        <div className="flex flex-wrap items-end gap-2 border-b px-5 py-4">
          <div className="w-full sm:w-64">
            <Select value={who} onChange={pickPerson} placeholder="Choose a person"
              options={people.filter((p) => p.employee_id).map((p) => ({ value: p.employee_id!, label: `${p.full_name} (${p.employee_code})` }))} />
          </div>
          <div className="w-full sm:w-36"><Input value={vd} onChange={setVd} placeholder="Vacation days" type="number" /></div>
          <div className="w-full sm:w-56"><Input value={dates} onChange={setDates} placeholder="Vacation dates, e.g. 10-14 Aug" /></div>
          <Button disabled={!who || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          <div className="w-full"><FormNotice error={save.error} /></div>
        </div>
      )}
      <Table head={['Employee', 'Vacation days', 'Vacation dates']} empty={rows.length === 0} emptyLabel="Nothing entered this month.">
        {rows.map((r) => (
          <tr key={r.employee_id}>
            <Td className="font-medium">{name(r.employee_id)}</Td>
            <Td className="num">{r.vacation_days || '-'}</Td>
            <Td>{r.vacation_dates || '-'}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
