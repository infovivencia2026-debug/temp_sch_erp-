import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { Card, CardHeader, Table, Td, Button, Field, Select, FormNotice } from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { childOptions, type PortalChild } from './use-children'

/* Taking a parent-teacher meeting slot, under the calendar that shows it.

   The catalogue has one entry for both ("Calendar & PTM ... booking where
   enabled"), so booking lives on that screen rather than a second one. A
   school that opens no slots shows one quiet line here and nothing else. */

interface Slot {
  id: string
  teacher: string
  section?: string
  on_date: string
  starts_at: string
  minutes: number
  mode: string
  location?: string
  taken: boolean
  booked_for?: string
}

interface Booking {
  id: string
  student_name: string
  teacher?: string
  on_date: string
  starts_at: string
  status: string
  cancellable: boolean
}

export function PtmBooking({ children, studentId }: { children: PortalChild[]; studentId?: string }) {
  const t = useT()
  const qc = useQueryClient()
  const [pick, setPick] = useState('')
  const [note, setNote] = useState('')
  const child = studentId || pick || (children.length === 1 ? children[0].student_id : '')

  const slots = useQuery({
    queryKey: ['portal-ptm-slots', studentId ?? ''],
    queryFn: () => api.get<List<Slot>>(`/api/v1/portal/school-life/ptm/slots?student_id=${studentId ?? ''}`),
  })
  const bookings = useQuery({
    queryKey: ['portal-ptm-bookings', studentId ?? ''],
    queryFn: () => api.get<List<Booking>>(`/api/v1/portal/school-life/ptm/bookings?student_id=${studentId ?? ''}`),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['portal-ptm-slots'] })
    qc.invalidateQueries({ queryKey: ['portal-ptm-bookings'] })
    qc.invalidateQueries({ queryKey: ['portal-calendar'] })
  }
  const book = useMutation({
    mutationFn: (slotId: string) =>
      api.post('/api/v1/portal/school-life/ptm/book', { slot_id: slotId, student_id: child }),
    onSuccess: () => { setNote(t('portal.calendar.ptm_booked')); refresh() },
  })
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/portal/school-life/ptm/${id}/cancel`, {}),
    onSuccess: () => { setNote(t('portal.calendar.ptm_cancelled')); refresh() },
  })

  const open = slots.data?.items ?? []
  const mine = (bookings.data?.items ?? []).filter((b) => b.status === 'booked' && b.cancellable)

  return (
    <Card>
      <CardHeader title={t('portal.calendar.ptm_title')} description={t('portal.calendar.ptm_description')} />
      {!studentId && children.length > 1 && (
        <div className="px-5 pb-3">
          <Field label={t('portal.calendar.ptm_field_child')}>
            <Select
              value={pick}
              onChange={setPick}
              placeholder={t('portal.calendar.ptm_choose_child')}
              options={childOptions(children)}
            />
          </Field>
        </div>
      )}
      <FormNotice error={book.error ?? cancel.error} ok={note} />
      <Table
        loading={slots.isLoading}
        head={['', '', '', '']}
        empty={!open.length}
        emptyLabel={t('portal.calendar.ptm_empty')}
      >
        {open.map((s) => (
          <tr key={s.id}>
            <Td className="font-medium">
              {formatDate(s.on_date)} · {s.starts_at}
              <span className="block text-[12px] font-normal text-muted-foreground">{s.minutes} min</span>
            </Td>
            <Td>
              {s.teacher}
              {s.section && <span className="text-muted-foreground"> · {s.section}</span>}
            </Td>
            <Td className="text-muted-foreground">{[s.mode, s.location].filter(Boolean).join(' · ')}</Td>
            <Td>
              {s.booked_for ? (
                <span className="text-[13px]">{t('portal.calendar.ptm_booked_for', { name: s.booked_for })}</span>
              ) : s.taken ? (
                <span className="text-[13px] text-muted-foreground">{t('portal.calendar.ptm_taken')}</span>
              ) : (
                <Button size="sm" disabled={!child || book.isPending} onClick={() => book.mutate(s.id)}>
                  {book.isPending && book.variables === s.id ? t('portal.calendar.ptm_booking') : t('portal.calendar.ptm_book')}
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {mine.length > 0 && (
        <>
          <CardHeader title={t('portal.calendar.ptm_your_bookings')} />
          <Table head={['', '', '']}>
            {mine.map((b) => (
              <tr key={b.id}>
                <Td className="font-medium">{formatDate(b.on_date)} · {b.starts_at}</Td>
                <Td>{[b.teacher, b.student_name].filter(Boolean).join(' · ')}</Td>
                <Td>
                  <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(b.id)}>
                    {t('portal.calendar.ptm_cancel')}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </Card>
  )
}
