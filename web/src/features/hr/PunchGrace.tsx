import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useCan } from '@/lib/session'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, Input, Field, FormGrid,
  FormNotice, SkeletonForm, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* THE MORNING GRACE WINDOW.

   Four numbers, and the punches of the last two weeks the current numbers
   would mark late. Change a number, save, and the list follows — before the
   month's register does. */

interface Grace {
  shift_starts_at: string
  grace_minutes: number
  late_half_day_after_minutes?: number | null
  late_marks_per_lop_day: number
}
interface Late {
  employee: string
  on_date: string
  check_in: string
  minutes_late: number
  half_day: boolean
}
interface Resp extends Grace { recent: Late[]; devices_on: number }

export default function PunchGrace() {
  const qc = useQueryClient()
  const can = useCan()
  const canWrite = can('hr.employees.write')
  const [f, setF] = useState({ shift: '09:00', grace: '10', half: '', marks: '3' })
  const [note, setNote] = useState<{ error?: unknown; ok?: string }>({})

  const q = useQuery({
    queryKey: ['punch-grace'],
    queryFn: () => api.get<Resp>('/api/v1/hr/punch-grace'),
  })
  useEffect(() => {
    if (!q.data) return
    setF({
      shift: q.data.shift_starts_at,
      grace: String(q.data.grace_minutes),
      half: q.data.late_half_day_after_minutes == null ? '' : String(q.data.late_half_day_after_minutes),
      marks: String(q.data.late_marks_per_lop_day),
    })
  }, [q.data])

  const save = useMutation({
    mutationFn: () =>
      api.put<Grace>('/api/v1/hr/punch-grace', {
        shift_starts_at: f.shift,
        grace_minutes: Number(f.grace),
        late_half_day_after_minutes: f.half === '' ? null : Number(f.half),
        late_marks_per_lop_day: Number(f.marks),
      }),
    onSuccess: () => {
      setNote({ ok: 'Saved. The register applies this from the start of the month.' })
      qc.invalidateQueries({ queryKey: ['punch-grace'] })
    },
    onError: (error) => setNote({ error }),
  })

  return (
    <>
      <PageHead eyebrow="Attendance" title="Punch-in grace" width="form" />
      <PageBody width="form">
        {q.isLoading ? (
          <SkeletonForm fields={4} />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : (
          <>
            <Card>
              <CardHeader
                title="Window"
                action={q.data!.devices_on === 0 ? <Badge tone="warning">No reader switched on</Badge> : undefined}
              />
              <div className="p-5">
                <FormGrid>
                  <Field label="Shift starts" required>
                    <Input type="time" value={f.shift} onChange={(v) => setF({ ...f, shift: v })} />
                  </Field>
                  <Field label="Grace, minutes" hint="Late after this">
                    <Input type="number" value={f.grace} onChange={(v) => setF({ ...f, grace: v })} />
                  </Field>
                  <Field label="Half day after, minutes" hint="Leave blank for never">
                    <Input type="number" value={f.half} onChange={(v) => setF({ ...f, half: v })} />
                  </Field>
                  <Field label="Late marks per day of pay">
                    <Input type="number" value={f.marks} onChange={(v) => setF({ ...f, marks: v })} />
                  </Field>
                </FormGrid>
                <div className="mt-5 flex items-center gap-3">
                  {canWrite && (
                    <Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
                  )}
                  <FormNotice error={note.error} ok={note.ok} />
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Late in the last two weeks" />
              {q.data!.recent.length === 0 ? (
                <EmptyState title="Nobody late" body="Device punches after the grace window show here." />
              ) : (
                <Table head={['Name', 'Day', 'In', 'Late by', '']}>
                  {q.data!.recent.map((p, i) => (
                    <tr key={`${p.employee}-${p.on_date}-${i}`}>
                      <Td className="font-medium">{p.employee}</Td>
                      <Td>{formatDate(p.on_date)}</Td>
                      <Td className="tabular-nums">{p.check_in}</Td>
                      <Td className="tabular-nums">{p.minutes_late} min</Td>
                      <Td>{p.half_day ? <Badge tone="danger">Half day</Badge> : <Badge tone="warning">Late</Badge>}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
