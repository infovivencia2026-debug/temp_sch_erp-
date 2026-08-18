import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, Clock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Select, Input,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
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

  if (slots.isLoading) return <Loading label="Looking up meeting times…" />
  if (slots.error) return <ErrorState error={slots.error} />

  const rows = slots.data?.items ?? []
  const mine = bookings.data?.items ?? []
  const free = rows.filter((s) => !s.taken)
  // A parent of several must say which child before booking; guessing would
  // seat the wrong sibling.
  const ready = studentId !== ''

  return (
    <>
      <PageHead
        eyebrow="School life"
        title="Parent-teacher meeting"
        description="Take a time with your child's teacher instead of queueing on the morning."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Times still free" value={free.length} icon={Clock} />
          <Stat label="Your meetings" value={mine.filter((b) => b.status === 'booked').length} icon={CalendarCheck} />
          <Stat label="Meetings held" value={mine.filter((b) => b.status === 'met').length} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Book a time"
            description="Choose a child, add anything you would like raised, then take a slot."
          />
          <div className="px-5 py-4">
            <FormGrid>
              {children.length > 1 && (
                <Field label="Child" required>
                  <Select
                    value={chosen}
                    onChange={setChosen}
                    options={childOptions(children)}
                    placeholder="Which child…"
                  />
                </Field>
              )}
              <Field label="What would you like to discuss?" hint="Optional. The teacher sees this before the meeting." wide>
                <Input value={note} onChange={setNote} placeholder="Reading progress" />
              </Field>
            </FormGrid>
            <FormNotice error={book.error} ok={book.isSuccess ? 'Meeting booked.' : undefined} />
          </div>
          <Table
            head={['Date', 'Time', 'Teacher', 'For', 'Where', '']}
            empty={rows.length === 0}
            emptyLabel="The school has not opened any times yet."
          >
            {rows.map((s) => (
              <tr key={s.id} className={s.taken ? 'text-muted-foreground' : undefined}>
                <Td>{formatDate(s.on_date)}</Td>
                <Td>
                  {s.starts_at}
                  <span className="text-muted-foreground"> · {s.minutes} min</span>
                </Td>
                <Td>{s.teacher}</Td>
                <Td>{s.section ? `Class ${s.section}` : 'Any class'}</Td>
                <Td>{s.location ?? s.mode.replace('_', ' ')}</Td>
                <Td className="text-right">
                  {s.taken ? (
                    <Badge tone={s.booked_for ? 'primary' : 'neutral'}>
                      {s.booked_for ? `Yours · ${s.booked_for}` : 'Taken'}
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!ready || book.isPending}
                      onClick={() => book.mutate(s.id)}
                      title={ready ? undefined : 'Choose a child first'}
                    >
                      Take this time
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="Your meetings"
            description="Including what was agreed, where the school has shared it."
          />
          {mine.length === 0 ? (
            <EmptyState title="No meetings yet" body="Take a time above and it will appear here." />
          ) : (
            <ul className="divide-y">
              {mine.map((b) => (
                <li key={b.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium">
                        {b.student_name}
                        {b.teacher && <span className="text-muted-foreground"> with {b.teacher}</span>}
                      </p>
                      <p className="text-[13px] text-muted-foreground">
                        {formatDate(b.on_date)} · {b.starts_at} · {b.minutes} min
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge tone={TONE[b.status] ?? 'neutral'}>{b.status.replace('_', ' ')}</Badge>
                      {b.cancellable && (
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          tone="danger"
                          confirmLabel="Give up the slot"
                          question="The time goes back to the school."
                          onConfirm={() => cancel.mutate(b.id)}
                        >
                          Cancel
                        </ConfirmButton>
                      )}
                    </div>
                  </div>
                  {b.purpose && <p className="mt-2 text-[13px]">{b.purpose}</p>}
                  {b.concerns && (
                    <p className="mt-2 text-[13px]">
                      <span className="text-muted-foreground">Raised: </span>
                      {b.concerns}
                    </p>
                  )}
                  {b.agreed_actions && (
                    <p className="mt-1 text-[13px]">
                      <span className="text-muted-foreground">Agreed: </span>
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
