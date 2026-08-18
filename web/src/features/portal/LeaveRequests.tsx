import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarOff, Clock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Checkbox, Loading, ErrorState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, childOptions } from './use-children'

/* Leave a family has asked for, and the form for asking.

   Both catalogued screens land here — the list and the application — because
   a parent opening "Requests" to apply is one tap from a list that answers
   "did I already ask?", and splitting them put that answer on another page.

   The form posts to /api/v1/workflow/leave, the endpoint the office's approval
   queue already reads. Writing to a parent-only endpoint would have produced a
   second pile of applications for the class teacher to miss. */

interface LeaveRow {
  id: string
  student_id: string
  student_name: string
  from_date: string
  to_date: string
  days: number
  is_half_day: boolean
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  decision_note?: string
  decided_by?: string
  decided_at?: string
  applied_on: string
  cancellable: boolean
}

const TONE: Record<LeaveRow['status'], 'warning' | 'success' | 'danger' | 'neutral'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
}

export default function LeaveRequests() {
  const qc = useQueryClient()
  const leave = useQuery({
    queryKey: ['portal-leave'],
    queryFn: () => api.get<List<LeaveRow>>('/api/v1/portal/leave'),
  })

  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/portal/leave/${id}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-leave'] }),
  })

  if (leave.isLoading) return <Loading label="Looking up your applications…" />
  if (leave.error) return <ErrorState error={leave.error} />

  const rows = leave.data?.items ?? []
  const pending = rows.filter((r) => r.status === 'pending')

  return (
    <>
      <PageHead
        eyebrow="Leave & absence"
        title="Time off school"
        description="Every day you have asked for, and what the school decided."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Waiting on the school" value={pending.length} icon={Clock} />
          <Stat label="Approved this year" value={rows.filter((r) => r.status === 'approved').length} />
          <Stat
            label="Days approved"
            value={rows.filter((r) => r.status === 'approved').reduce((n, r) => n + Number(r.days), 0)}
            icon={CalendarOff}
          />
        </CellGrid>

        <ApplyForLeave />

        <Card>
          <CardHeader
            title="Applications"
            description="A pending application can be withdrawn; once the school has decided, it stands."
          />
          <Table
            head={['Child', 'Days', 'Reason', 'Decision', '']}
            empty={rows.length === 0}
            emptyLabel="You have not asked for any time off."
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <div className="font-medium">{r.student_name}</div>
                  <div className="text-[12px] text-muted-foreground">
                    applied {formatDate(r.applied_on)}
                  </div>
                </Td>
                <Td>
                  {formatDate(r.from_date)}
                  {r.to_date !== r.from_date && ` – ${formatDate(r.to_date)}`}
                  <div className="text-[12px] text-muted-foreground">
                    {r.is_half_day ? 'half day' : `${Number(r.days)} day${Number(r.days) === 1 ? '' : 's'}`}
                  </div>
                </Td>
                <Td className="max-w-[20rem]">{r.reason}</Td>
                <Td>
                  <Badge tone={TONE[r.status]}>{r.status}</Badge>
                  {r.decision_note && (
                    <div className="text-[12px] text-muted-foreground">{r.decision_note}</div>
                  )}
                  {r.decided_by && (
                    <div className="text-[12px] text-muted-foreground">by {r.decided_by}</div>
                  )}
                </Td>
                <Td>
                  {r.cancellable && (
                    <ConfirmButton
                      confirmLabel="Withdraw"
                      question="The school will no longer see this application."
                      onConfirm={() => cancel.mutate(r.id)}
                    >
                      Withdraw
                    </ConfirmButton>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <FormNotice error={cancel.error} />
        </Card>
      </PageBody>
    </>
  )
}

/** The application form. Powers parent.leave_absence.apply_student_leave. */
function ApplyForLeave() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [half, setHalf] = useState(false)
  const [reason, setReason] = useState('')

  const apply = useMutation({
    mutationFn: () =>
      api.post('/api/v1/workflow/leave', {
        student_id: studentId,
        from_date: from,
        // The shared endpoint requires both ends. A single day is the same date
        // twice rather than an absent field, which it would reject.
        to_date: half || !to ? from : to,
        is_half_day: half,
        reason,
      }),
    onSuccess: () => {
      setFrom('')
      setTo('')
      setHalf(false)
      setReason('')
      qc.invalidateQueries({ queryKey: ['portal-leave'] })
    },
  })

  const ready = studentId !== '' && from !== '' && reason.trim() !== ''

  return (
    <Card>
      <CardHeader
        title="Ask for time off"
        description="The class teacher decides. Tell them why — an application with no reason usually comes back."
      />
      <div className="p-4">
        <FormGrid>
          {children.length > 1 && (
            <Field label="Child" required>
              <Select
                value={chosen}
                onChange={setChosen}
                placeholder="Choose a child"
                options={childOptions(children)}
              />
            </Field>
          )}
          <Field label="First day away" required>
            <Input type="date" value={from} onChange={setFrom} />
          </Field>
          {!half && (
            <Field label="Last day away" hint="Leave blank for a single day.">
              <Input type="date" value={to} onChange={setTo} />
            </Field>
          )}
          <Field label="Half day" wide>
            <Checkbox
              checked={half}
              onChange={setHalf}
              label="Only half the day"
              hint="A half day is one day — the school counts it as 0.5."
            />
          </Field>
          <Field label="Reason" wide required>
            <Textarea
              rows={2}
              value={reason}
              onChange={setReason}
              placeholder="Sister's wedding in Warangal"
            />
          </Field>
        </FormGrid>
        <div className="mt-4">
          <Button disabled={!ready || apply.isPending} onClick={() => apply.mutate()}>
            {apply.isPending ? 'Sending…' : 'Send to the school'}
          </Button>
        </div>
        <FormNotice
          error={apply.error}
          ok={apply.isSuccess ? 'Sent. You will see it in the list below.' : undefined}
        />
      </div>
    </Card>
  )
}
