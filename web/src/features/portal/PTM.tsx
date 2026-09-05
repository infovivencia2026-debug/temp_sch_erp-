import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, Clock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  ConfirmButton, Field, FormGrid, FormNotice, Select, Input, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useChildren, childOptions } from './use-children'

/* Taking a slot at the parent-teacher meeting.

   The queue outside a classroom on PTM morning is the thing this replaces, and
   the reason it can is that a booking here is an appointment in the front
   desk's own diary — not a request the office has to transcribe. A meeting
   cancelled at the desk therefore disappears from this screen without anybody
   remembering to tell it.

   Taken slots are shown greyed rather than hidden. A parent who booked at nine
   o'clock and cannot find the slot again assumes it failed and telephones. */

interface Slot {
  id: string
  teacher: string
  section?: string
  on_date: string
  starts_at: string
  minutes: number
  mode: string
  location?: string
  notes?: string
  taken: boolean
  booked_for?: string
}

interface Booking {
  id: string
  student_id: string
  student_name: string
  teacher?: string
  on_date: string
  starts_at: string
  minutes: number
  purpose: string
  status: string
  outcome?: string
  cancellable: boolean
  concerns?: string
  agreed_actions?: string
}

const TONE: Record<string, 'primary' | 'success' | 'warning' | 'neutral'> = {
  booked: 'primary',
  met: 'success',
  no_show: 'warning',
  cancelled: 'neutral',
}

export default function PTM() {
  const t = useT()
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const [note, setNote] = useState('')

  const slots = useQuery({
    queryKey: ['ptm-slots', studentId],
    queryFn: () =>
      api.get<List<Slot>>(
        `/api/v1/portal/school-life/ptm/slots${studentId ? `?student_id=${studentId}` : ''}`,
      ),
  })
  const bookings = useQuery({
    queryKey: ['ptm-bookings', studentId],
    queryFn: () =>
      api.get<List<Booking>>(
        `/api/v1/portal/school-life/ptm/bookings${studentId ? `?student_id=${studentId}` : ''}`,
      ),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ptm-slots'] })
    qc.invalidateQueries({ queryKey: ['ptm-bookings'] })
    qc.invalidateQueries({ queryKey: ['portal-calendar'] })
  }

  const book = useMutation({
    mutationFn: (slotId: string) =>
      api.post('/api/v1/portal/school-life/ptm/book', {
        slot_id: slotId,
        student_id: studentId,
        note,
      }),
    onSuccess: () => {
      setNote('')
      refresh()
    },
  })
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/portal/school-life/ptm/${id}/cancel`, {}),
    onSuccess: refresh,
  })

  if (slots.isLoading) return <ScreenSkeleton label={t('portal.ptm.loading')} />
  if (slots.error && !slots.data) return <ScreenError error={slots.error} />

  const rows = slots.data?.items ?? []
  const mine = bookings.data?.items ?? []
  const free = rows.filter((s) => !s.taken)
  // A parent of several must say which child before booking; guessing would
  // seat the wrong sibling.
  const ready = studentId !== ''

  return (
    <>
      <PageHead
        eyebrow={t('portal.ptm.eyebrow')}
        title={t('portal.ptm.title')}
        description={t('portal.ptm.description')}
      />
      <Freshness query={slots} />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label={t('portal.ptm.stat_free')} value={free.length} icon={Clock} />
          <Stat label={t('portal.ptm.stat_yours')} value={mine.filter((b) => b.status === 'booked').length} icon={CalendarCheck} />
          <Stat label={t('portal.ptm.stat_held')} value={mine.filter((b) => b.status === 'met').length} />
        </CellGrid>

        <Card>
          <CardHeader
            title={t('portal.ptm.book_title')}
            description={t('portal.ptm.book_description')}
          />
          <div className="px-5 py-4">
            <FormGrid>
              {children.length > 1 && (
                <Field label={t('portal.ptm.field_child')} required>
                  <Select
                    value={chosen}
                    onChange={setChosen}
                    options={childOptions(children)}
                    placeholder={t('portal.ptm.child_placeholder')}
                  />
                </Field>
              )}
              <Field label={t('portal.ptm.field_note')} hint={t('portal.ptm.field_note_hint')} wide>
                <Input value={note} onChange={setNote} placeholder={t('portal.ptm.note_placeholder')} />
              </Field>
            </FormGrid>
            <FormNotice error={book.error} ok={book.isSuccess ? t('portal.ptm.booked_ok') : undefined} />
          </div>
          <Table
            head={[
              t('portal.ptm.col_date'),
              t('portal.ptm.col_time'),
              t('portal.ptm.col_teacher'),
              t('portal.ptm.col_for'),
              t('portal.ptm.col_where'),
              '',
            ]}
            empty={rows.length === 0}
            emptyLabel={t('portal.ptm.empty_slots')}
          >
            {rows.map((s) => (
              <tr key={s.id} className={s.taken ? 'text-muted-foreground' : undefined}>
                <Td>{formatDate(s.on_date)}</Td>
                <Td>
                  {s.starts_at}
                  <span className="text-muted-foreground">
                    {t('portal.ptm.slot_minutes', { minutes: s.minutes })}
                  </span>
                </Td>
                <Td>{s.teacher}</Td>
                <Td>
                  {s.section
                    ? t('portal.ptm.slot_class', { section: s.section })
                    : t('portal.ptm.slot_any_class')}
                </Td>
                <Td>{s.location ?? s.mode.replace('_', ' ')}</Td>
                <Td className="text-right">
                  {s.taken ? (
                    <Badge tone={s.booked_for ? 'primary' : 'neutral'}>
                      {s.booked_for
                        ? t('portal.ptm.slot_yours', { name: s.booked_for })
                        : t('portal.ptm.slot_taken')}
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!ready || book.isPending}
                      onClick={() => book.mutate(s.id)}
                      title={ready ? undefined : t('portal.ptm.choose_child_first')}
                    >
                      {t('portal.ptm.action_take')}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title={t('portal.ptm.mine_title')}
            description={t('portal.ptm.mine_description')}
          />
          {mine.length === 0 ? (
            <EmptyState
              title={t('portal.ptm.empty_title')}
              body={t('portal.ptm.empty_body')}
            />
          ) : (
            <ul className="divide-y">
              {mine.map((b) => (
                <li key={b.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium">
                        {b.student_name}
                        {b.teacher && <span className="text-muted-foreground">
                            {t('portal.ptm.with_teacher', { teacher: b.teacher })}
                          </span>}
                      </p>
                      <p className="text-[13px] text-muted-foreground">
                        {t('portal.ptm.meeting_when', {
                          date: formatDate(b.on_date),
                          time: b.starts_at,
                          minutes: b.minutes,
                        })}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge tone={TONE[b.status] ?? 'neutral'}>{b.status.replace('_', ' ')}</Badge>
                      {b.cancellable && (
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          tone="danger"
                          confirmLabel={t('portal.ptm.cancel_confirm')}
                          question={t('portal.ptm.cancel_question')}
                          onConfirm={() => cancel.mutate(b.id)}
                        >
                          {t('portal.ptm.action_cancel')}
                        </ConfirmButton>
                      )}
                    </div>
                  </div>
                  {b.purpose && <p className="mt-2 text-[13px]">{b.purpose}</p>}
                  {b.concerns && (
                    <p className="mt-2 text-[13px]">
                      <span className="text-muted-foreground">{t('portal.ptm.label_raised')}</span>
                      {b.concerns}
                    </p>
                  )}
                  {b.agreed_actions && (
                    <p className="mt-1 text-[13px]">
                      <span className="text-muted-foreground">{t('portal.ptm.label_agreed')}</span>
                      {b.agreed_actions}
                    </p>
                  )}
                  {b.outcome && (
                    <p className="mt-1 text-[13px] text-muted-foreground">{b.outcome}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}
