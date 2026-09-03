import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarOff, CheckCircle2, Clock, UserPlus } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Table, Td,
  Input, Textarea, Field, FormGrid, FormNotice, Checkbox, Loading, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { WEEKDAYS, cn } from '@/lib/utils'

/* Asking for your classes to be covered, and answering the ask.

   Two halves of one screen because they are two halves of one conversation,
   and the person reading it is whichever of the two you are: a teacher sees
   their own periods and their own requests, an approver additionally sees the
   queue and the suggestions.

   The valuable half is the suggestion list. Recording "Mrs Rao will be away on
   Thursday" is a form; working out who is genuinely free in Thursday's third
   period, and who has room left in their week, is the job somebody currently
   does by hand with a printed grid — which is why proxy duty in most schools
   lands on whoever is standing in the corridor.

   Leave already applied for is shown beside the date pickers. A school that
   runs leave properly should not make anybody type the same three days twice,
   and two records disagreeing about which days somebody was out is the sort of
   thing payroll finds in August and nobody can resolve. */

interface CoverPeriod {
  timetable_entry_id: string
  on_date: string
  weekday: number
  period_id: string
  period_name: string
  starts_at: string
  class_name: string
  section_name: string
  subject_name: string
  already_asked: boolean
  covered_by?: string
}

interface LeaveRow {
  id: string
  from_date: string
  to_date: string
  reason: string
  status: string
}

interface RequestRow {
  id: string
  requested_by: string
  teacher_name: string
  from_date: string
  to_date: string
  reason: string
  status: string
  suggested_teacher?: string
  suggested_user_id?: string
  leave_request_id?: string
  decided_by?: string
  decision_note?: string
  created_at: string
  periods: number
  covered: number
  mine: boolean
}

interface Candidate {
  user_id: string
  full_name: string
  teaches_subject: boolean
  periods_today: number
  periods_week: number
  max_periods_per_week: number
  suggested: boolean
}

interface RequestLine {
  id: string
  timetable_entry_id: string
  on_date: string
  period_name: string
  starts_at: string
  class_name: string
  section_name: string
  subject_name: string
  status: string
  assigned_teacher?: string
  assigned_user_id?: string
  candidates: Candidate[]
}

const today = () => new Date().toISOString().slice(0, 10)
const inDays = (n: number) =>
  new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  approved: 'success',
  partially_approved: 'warning',
  pending: 'info',
  rejected: 'danger',
  cancelled: 'neutral',
}

export default function SubstitutionRequest() {
  const qc = useQueryClient()
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(inDays(2))
  const [reason, setReason] = useState('')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [leaveID, setLeaveID] = useState('')
  const [open, setOpen] = useState('')

  const periods = useQuery({
    queryKey: ['timetable-cover', 'my-periods', from, to],
    queryFn: () =>
      api.get<{ items: CoverPeriod[]; from: string; to: string; leave: LeaveRow[] }>(
        `/api/v1/timetable-cover/my-periods?from=${from}&to=${to}`,
      ),
  })
  const requests = useQuery({
    queryKey: ['timetable-cover', 'requests'],
    queryFn: () =>
      api.get<{ items: RequestRow[]; can_decide: boolean }>('/api/v1/timetable-cover/requests'),
  })

  const submit = useMutation({
    mutationFn: () => {
      const chosen = (periods.data?.items ?? []).filter((p) => picked[key(p)])
      return api.post('/api/v1/timetable-cover/requests', {
        from_date: from,
        to_date: to,
        reason,
        leave_request_id: leaveID || undefined,
        periods: chosen.map((p) => ({
          timetable_entry_id: p.timetable_entry_id,
          on_date: p.on_date,
        })),
      })
    },
    onSuccess: () => {
      setPicked({})
      setReason('')
      qc.invalidateQueries({ queryKey: ['timetable-cover'] })
    },
  })

  if (periods.isLoading || requests.isLoading) return <SkeletonTable columns={4} label="Reading your week…" />
  if (periods.error) return <ErrorState error={periods.error} />
  /* The requests list failing is not the same as having no requests. Without
     this, a failed call left can_decide false and both lists empty, so an
     approver was shown "nothing waiting on you" and a teacher was shown none of
     the requests they had raised. */
  if (requests.error) return <ErrorState error={requests.error} />

  const rows = periods.data?.items ?? []
  const leave = periods.data?.leave ?? []
  const canDecide = requests.data?.can_decide ?? false
  const mine = (requests.data?.items ?? []).filter((r) => r.mine)
  const queue = (requests.data?.items ?? []).filter((r) => !r.mine && r.status === 'pending')
  const chosenCount = rows.filter((p) => picked[key(p)]).length

  return (
    <>
      <PageHead
        eyebrow="Timetable"
        title="Substitution requests"
        description="Ask for your periods to be covered while you are away, and suggest a colleague. The approver is shown who is actually free in each period."
        actions={
          <>
            <Input
              type="date"
              value={from}
              onChange={setFrom}
              className="w-40"
              srLabel="Show periods from this date"
            />
            <Input
              type="date"
              value={to}
              onChange={setTo}
              className="w-40"
              srLabel="Show periods up to this date"
            />
          </>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Periods in range" value={rows.length} icon={Clock} />
          <Stat label="Selected" value={chosenCount} icon={CalendarOff} />
          <Stat label="My open requests" value={mine.filter((r) => r.status === 'pending').length} icon={UserPlus} />
          {canDecide && <Stat label="Waiting on me" value={queue.length} icon={CheckCircle2} />}
        </CellGrid>

        {leave.length > 0 && (
          <Card>
            <CardHeader
              title="Leave you have already applied for"
              description="Attaching the request to it keeps the two records from disagreeing about which days you were out."
            />
            <Table head={['Dates', 'Reason', 'Status', '']}>
              {leave.map((l) => (
                <tr key={l.id}>
                  <Td>
                    {l.from_date} to {l.to_date}
                  </Td>
                  <Td className="text-[13px] text-muted-foreground">{l.reason}</Td>
                  <Td>
                    <Badge tone={l.status === 'approved' ? 'success' : 'info'}>{l.status}</Badge>
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant={leaveID === l.id ? 'primary' : 'secondary'}
                      onClick={() => {
                        if (leaveID === l.id) {
                          setLeaveID('')
                          return
                        }
                        setLeaveID(l.id)
                        setFrom(l.from_date)
                        setTo(l.to_date)
                        if (!reason) setReason(l.reason)
                      }}
                    >
                      {leaveID === l.id ? 'Attached' : 'Use these dates'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Which periods need covering"
            description="Select nothing and every period in the range is included, which is what three days of leave usually means."
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No timetabled periods in that range"
              body="Holidays are already excluded. Widen the dates, or check that the timetable has been published."
            />
          ) : (
            <Table head={['', 'Date', 'Period', 'Class', 'Subject', 'State']}>
              {rows.map((p) => (
                <tr key={key(p)}>
                  <Td>
                    <Checkbox
                      checked={!!picked[key(p)]}
                      onChange={(v) => setPicked({ ...picked, [key(p)]: v })}
                      label=""
                    />
                  </Td>
                  <Td>
                    <div>{p.on_date}</div>
                    <div className="text-[12px] text-muted-foreground">{WEEKDAYS[p.weekday - 1]}</div>
                  </Td>
                  <Td>
                    {p.period_name}
                    <span className="ml-2 text-[12px] text-muted-foreground">{p.starts_at}</span>
                  </Td>
                  <Td>
                    {p.class_name}-{p.section_name}
                  </Td>
                  <Td className="font-medium">{p.subject_name}</Td>
                  <Td>
                    {p.covered_by ? (
                      <Badge tone="success">covered by {p.covered_by}</Badge>
                    ) : p.already_asked ? (
                      <Badge tone="info">already asked</Badge>
                    ) : (
                      <span className="text-[13px] text-muted-foreground">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}

          <div className="border-t p-5">
            <FormGrid>
              <Field
                label="Why you will be away"
                required
                hint="The approver reads this before deciding, and it is copied onto the cover."
                wide
              >
                <Textarea value={reason} onChange={setReason} rows={2} />
              </Field>
            </FormGrid>
            <div className="mt-4 flex items-center gap-3">
              <Button
                onClick={() => submit.mutate()}
                disabled={!reason.trim() || submit.isPending || rows.length === 0}
              >
                {submit.isPending
                  ? 'Sending…'
                  : chosenCount > 0
                    ? `Request cover for ${chosenCount} periods`
                    : `Request cover for all ${rows.length} periods`}
              </Button>
              <FormNotice
                error={submit.error}
                ok={submit.isSuccess ? 'Sent. You will see it below.' : undefined}
              />
            </div>
          </div>
        </Card>

        {canDecide && (
          <Card>
            <CardHeader
              title="Waiting for a decision"
              description="Open one to see who is genuinely free in each period."
            />
            {queue.length === 0 ? (
              <EmptyState title="Nothing waiting" body="No colleague has an open request." />
            ) : (
              <Table head={['Teacher', 'Dates', 'Reason', 'Periods', 'Suggested', '']}>
                {queue.map((r) => (
                  <tr key={r.id}>
                    <Td className="font-medium">{r.teacher_name}</Td>
                    <Td>
                      {r.from_date} to {r.to_date}
                    </Td>
                    <Td className="text-[13px] text-muted-foreground">{r.reason}</Td>
                    <Td className="tabular-nums">{r.periods}</Td>
                    <Td className="text-[13px]">{r.suggested_teacher ?? '—'}</Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setOpen(open === r.id ? '' : r.id)}
                      >
                        {open === r.id ? 'Close' : 'Arrange cover'}
                      </Button>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        <Card>
          <CardHeader title="My requests" />
          {mine.length === 0 ? (
            <EmptyState title="You have not asked for cover" body="Requests you send appear here with what was arranged." />
          ) : (
            <Table head={['Dates', 'Reason', 'Covered', 'Status', '']}>
              {mine.map((r) => (
                <tr key={r.id}>
                  <Td>
                    {r.from_date} to {r.to_date}
                  </Td>
                  <Td className="text-[13px] text-muted-foreground">{r.reason}</Td>
                  <Td className="tabular-nums">
                    {r.covered} / {r.periods}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>
                      {r.status.replace(/_/g, ' ')}
                    </Badge>
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setOpen(open === r.id ? '' : r.id)}
                    >
                      {open === r.id ? 'Close' : 'Open'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {open && (
          /* Keyed by the request.

             RequestDetail holds the substitute chosen for each period and the
             decision note. Opening a second request while one was open reused
             them, so approving request B posted the period ids and substitutes
             picked for request A — cover assigned for the wrong teacher's
             periods, or a 400, depending on what the server made of ids that
             belong to another request. */
          <RequestDetail key={open} id={open} onDone={() => setOpen('')} />
        )}
      </PageBody>
    </>
  )
}

const key = (p: CoverPeriod) => `${p.timetable_entry_id}:${p.on_date}`

/* One request, period by period, with the answer to "who is free".

   The candidate list is the server's, ordered by the server: the colleague the
   teacher suggested first if they are actually free, then somebody who teaches
   the subject, then whoever has the most room left in their week. Ordering it
   in the browser would mean two approvers looking at the same request get
   different advice. */
function RequestDetail({ id, onDone }: { id: string; onDone: () => void }) {
  const qc = useQueryClient()
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')

  const q = useQuery({
    queryKey: ['timetable-cover', 'request', id],
    queryFn: () =>
      api.get<{ request: RequestRow; periods: RequestLine[]; can_decide: boolean }>(
        `/api/v1/timetable-cover/requests/${id}`,
      ),
  })

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api.post(`/api/v1/timetable-cover/requests/${id}/decide`, {
        decision,
        note,
        assignments:
          decision === 'approve'
            ? Object.entries(choice)
                .filter(([, v]) => v)
                .map(([period_id, substitute_user_id]) => ({ period_id, substitute_user_id }))
            : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timetable-cover'] })
      qc.invalidateQueries({ queryKey: ['substitution-board'] })
      onDone()
    },
  })

  const cancel = useMutation({
    mutationFn: () => api.post(`/api/v1/timetable-cover/requests/${id}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timetable-cover'] })
      onDone()
    },
  })

  if (q.isLoading) return <Loading label="Reading the request…" />
  if (q.error) return <ErrorState error={q.error} />

  const r = q.data!.request
  const lines = q.data!.periods
  const canDecide = q.data!.can_decide
  const assigned = Object.values(choice).filter(Boolean).length

  return (
    <Card>
      <CardHeader
        title={`${r.teacher_name} — ${r.from_date} to ${r.to_date}`}
        description={r.reason}
        action={
          <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.replace(/_/g, ' ')}</Badge>
        }
      />
      <FormNotice error={decide.error ?? cancel.error} />

      <div className="divide-y">
        {lines.map((l) => (
          <div key={l.id} className="px-5 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <span className="font-medium">
                  {l.class_name}-{l.section_name} · {l.subject_name}
                </span>
                <span className="ml-2 text-[13px] text-muted-foreground">
                  {l.on_date} · {l.period_name} at {l.starts_at}
                </span>
              </div>
              {l.status === 'covered' ? (
                <Badge tone="success">covered by {l.assigned_teacher}</Badge>
              ) : l.status === 'declined' ? (
                <Badge tone="neutral">declined</Badge>
              ) : (
                <Badge tone="info">open</Badge>
              )}
            </div>

            {canDecide && l.status === 'pending' && (
              <div className="mt-3">
                {l.candidates.length === 0 ? (
                  <p className="text-[13px] text-destructive">
                    Nobody is free in this period. Merge the class or send it to the library.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {l.candidates.map((c) => {
                      const on = choice[l.id] === c.user_id
                      return (
                        <button
                          key={c.user_id}
                          type="button"
                          onClick={() =>
                            setChoice({ ...choice, [l.id]: on ? '' : c.user_id })
                          }
                          className={cn(
                            'rounded-md border px-3 py-2 text-left text-[13px]',
                            on ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                          )}
                        >
                          <div className="font-medium">
                            {c.full_name}
                            {c.suggested && (
                              <span className="ml-1.5 text-[11px] text-primary">suggested</span>
                            )}
                          </div>
                          <div className="text-[12px] text-muted-foreground">
                            {c.teaches_subject ? 'teaches the subject' : 'free period'} ·{' '}
                            {c.periods_week} of {c.max_periods_per_week} this week ·{' '}
                            {c.periods_today} today
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t p-5">
        {canDecide ? (
          <>
            <Input value={note} onChange={setNote} placeholder="Note (optional)" className="w-64" />
            <Button
              onClick={() => decide.mutate('approve')}
              disabled={assigned === 0 || decide.isPending}
            >
              Approve {assigned} of {lines.length}
            </Button>
            <Button
              variant="secondary"
              tone="danger"
              onClick={() => decide.mutate('reject')}
              disabled={decide.isPending}
            >
              Reject
            </Button>
            {assigned < lines.length && assigned > 0 && (
              <span className="text-[13px] text-muted-foreground">
                The rest stay open — the request will read “partially approved”, which is the
                truth.
              </span>
            )}
          </>
        ) : (
          r.mine &&
          r.status === 'pending' && (
            <Button variant="secondary" tone="danger" onClick={() => cancel.mutate()}>
              Withdraw this request
            </Button>
          )
        )}
      </div>
    </Card>
  )
}
