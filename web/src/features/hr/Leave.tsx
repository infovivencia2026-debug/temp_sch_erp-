import { useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Select, Loading, ErrorState, FormNotice, Field, FormGrid, Input, ExportButton, PrintButton,
} from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'

/* Leave, as the queue it is.
 *
 * A leave request blocks two people: the person who applied and cannot plan,
 * and whoever has to cover the class. The list endpoint and the decide
 * endpoint both existed and nothing called them, so requests went into the
 * table and stayed pending — which is the one state that costs somebody
 * something.
 *
 * Approving is deliberately a single click with no confirm: the decision is
 * reversible by deciding again, and a confirm dialog on a queue of twenty is
 * twenty extra clicks to say yes to things you already read.
 */

interface LeaveRow {
  id: string
  who: string
  subject_kind: string
  leave_type?: string
  from_date: string
  to_date: string
  days: string
  reason: string
  status: string
}

export default function Leave() {
  const qc = useQueryClient()
  const can = useCan()
  /* Which door somebody came through.
   *
   * One screen serves two jobs — deciding other people's leave, and taking
   * your own — and it was always drawing the approver's. So "My Profile →
   * Leave & self service" opened a page headed "Staff & student leave
   * approvals", which is somebody else's work under a menu entry that
   * promised your own. The feature in the URL says which was meant. */
  const { featureSlug } = useParams()
  const mine = featureSlug === 'leave_self_service'

  /* What you open on depends on why you are here.
   *
   * "Pending" is the right default for somebody who decides leave — the queue
   * is the job. It is the wrong default for everybody else: your own request
   * disappears from this screen the moment it is answered, which is exactly
   * when you came to look at it. An applicant opens on all statuses and sees
   * their own history, decided or not.
   *
   * The test used to be the permission alone, and a principal holds it. So
   * the principal's own "My leave" — the one screen on this route that is
   * explicitly about them — opened filtered to Pending and showed an empty
   * table, with "Approved 14" counted in a tile directly above it. The route
   * decides it too now: your own record opens on your whole record. */
  const canDecide = can('hr.leave.approve')
  const [status, setStatus] = useState(canDecide && !mine ? 'pending' : '')
  const [done, setDone] = useState('')

  /* Whose leave this screen is about.
   *
   * One table holds both, and one screen showing both put children into HR's
   * queue beside the teachers — in a module that exists for employees. The
   * workspace in the URL says which door somebody came through: HR's is staff,
   * everybody else's is unchanged, and the principal still sees one queue
   * because they genuinely decide both from the same desk. */
  const path = useLocation().pathname
  const workspace = path.split('/')[1]

  /* MY LEAVE IS MINE, WHOEVER ELSE'S I AM ALLOWED TO SEE.

     This screen is registered twice: as an approver's queue, and as
     `<role>.my_profile.leave_self_service`, titled "My leave". The server used
     to choose between them by permission alone -- hold hr.employees.read and
     you saw every row, whichever door you came through.

     A head of department holds it. So their "My leave" listed thirteen of
     another teacher's requests and a student's medical leave: fourteen rows,
     none of them theirs. It looked right for a class teacher only because the
     rows they could see happened to be their own.

     The route says which door this is, so the route decides. `for=mine`
     narrows on the server and can never widen -- a caller without the
     permission is scoped to themselves regardless of what they ask for. */
  const selfService = path.includes('/my_profile/')
  const forWhom = selfService ? 'mine' : workspace === 'hr' ? 'staff' : ''

  const q = useQuery({
    queryKey: ['leave', status, forWhom],
    queryFn: () => {
      const p = new URLSearchParams()
      if (status) p.set('status', status)
      if (forWhom) p.set('for', forWhom)
      const qs = p.toString()
      return api.get<List<LeaveRow>>(`/api/v1/hr/leave${qs ? `?${qs}` : ''}`)
    },
  })

  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected' }) =>
      api.post(`/api/v1/workflow/leave/${v.id}/decide`, { decision: v.decision }),
    onSuccess: (_r, v) => {
      setDone(v.decision === 'approved' ? 'Approved.' : 'Rejected.')
      qc.invalidateQueries({ queryKey: ['leave'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
    /* Losing the race is also news about the list.
     *
     * A teacher's leave is answerable by their HOD and by the principal at
     * once, deliberately — leave should not wait behind whoever is
     * travelling. So both can have it open, and one clicks second. The server
     * refuses that click and names who got there first, but the row
     * underneath still read "pending", which is the one thing it is not. */
    onError: () => {
      qc.invalidateQueries({ queryKey: ['leave'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  /* Applying, which nothing could do.
   *
   * This screen is the approver's queue, and it was the only leave screen
   * there was — reachable from a teacher's own menu under "Leave & self
   * service", where it showed them everybody else's requests and no way to
   * make one. The endpoint has existed all along with no caller, so every
   * member of staff, up to and including the principal, had to ask somebody
   * with database access to take a day off.
   *
   * Everyone gets the form. Approving is the part that needs a right. */
  const [apply, setApply] = useState(false)
  const [form, setForm] = useState({
    from_date: '', to_date: '', reason: '', is_half_day: false, leave_type_id: '',
  })

  /* Which kind of leave this is.
   *
   * The Type column has been on this screen since the start and was always
   * blank, because nothing in the product could create a leave type and the
   * form never asked for one. Without it "how many sick days do I have left"
   * has nothing to answer from, and an approver cannot see that somebody has
   * already used their casual leave.
   *
   * Offered when the school has set any up, and quietly absent when it has
   * not — a required dropdown with nothing in it stops somebody applying for
   * leave, which is worse than an unlabelled request. */
  const types = useQuery({
    queryKey: ['leave-types', 'staff'],
    queryFn: () =>
      api.get<{ items: { id: string; name: string; annual_quota?: number }[] }>(
        '/api/v1/hr/leave-types?applies_to=staff',
      ),
    retry: false,
  })
  const leaveTypes = types.data?.items ?? []
  const [applied, setApplied] = useState('')
  const send = useMutation({
    mutationFn: () =>
      api.post('/api/v1/workflow/leave', {
        ...form,
        leave_type_id: form.leave_type_id || undefined,
      }),
    onSuccess: () => {
      setApplied('Sent. Whoever approves leave here will see it — the head of department or the principal, whichever gets there first.')
      setForm({ from_date: '', to_date: '', reason: '', is_half_day: false, leave_type_id: '' })
      setApply(false)
      qc.invalidateQueries({ queryKey: ['leave'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  const everything = useQuery({
    queryKey: ['leave', 'all', forWhom],
    queryFn: () => {
      const p = new URLSearchParams()
      if (forWhom) p.set('for', forWhom)
      const qs = p.toString()
      return api.get<List<LeaveRow>>(`/api/v1/hr/leave${qs ? `?${qs}` : ''}`)
    },
  })
  const all = everything.data?.items ?? []
  const items = q.data?.items ?? []
  /* Approving on the self-service screen would be the same confusion the other
   * way round: this door is "my leave", and deciding somebody else's belongs
   * behind the entry that says so. */
  const mayDecide = canDecide && !mine

  return (
    <>
      <PageHead
        eyebrow="Attendance & Leave"
        title={
          mine
            ? 'My leave'
            : forWhom === 'staff'
              ? 'Staff leave approvals'
              : 'Staff & student leave approvals'
        }
        description={
          mine
            ? 'Your own leave: what you have applied for, and where each request has got to.'
            : forWhom === 'staff'
              ? 'Leave applied for by staff, awaiting a decision, and the history behind it.'
              : 'Staff and student leave awaiting a decision, and the history behind it.'
        }
      actions={<><ExportButton report="leave" /><PrintButton /></>}
        />
      <PageBody>
        <CellGrid cols={4}>
          {/* Counted from every request, not from the rows the filter left on
              screen. With the filter on "pending" these read as totals and
              showed zero approvals to a school that had approved several —
              a summary that changes when you filter the list underneath it is
              not a summary. */}
          <Stat label="Total requests" value={all.length} hint="Every request" />
          <Stat label="Pending approval" value={all.filter((r) => r.status === 'pending').length} />
          <Stat label="Approved" value={all.filter((r) => r.status === 'approved').length} />
          {/* The fourth box was a headcount split that repeated what the Who
              column already says. Rejected is the one somebody looks for. */}
          <Stat label="Rejected" value={all.filter((r) => r.status === 'rejected').length} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Apply for my leave"
            description="Your own request. It goes to whoever approves leave at this school."
            action={
              <Button variant={apply ? 'ghost' : 'primary'} onClick={() => setApply((v) => !v)}>
                {apply ? 'Cancel' : 'Apply for leave'}
              </Button>
            }
          />
          {apply && (
            <div className="px-5 pb-5">
              <FormGrid>
                <Field label="From" required>
                  <Input
                    type="date"
                    value={form.from_date}
                    onChange={(v) => setForm({ ...form, from_date: v })}
                  />
                </Field>
                <Field label="To" required>
                  <Input
                    type="date"
                    value={form.to_date}
                    onChange={(v) => setForm({ ...form, to_date: v })}
                  />
                </Field>
              </FormGrid>
              {/* Required, because the kind of leave is the whole point of
                  recording it.

                  It was optional and defaulted to nothing, so most
                  applications were filed against no kind at all and the Type
                  column read "—" down the whole list. That is not a
                  cosmetic gap: casual, sick and loss-of-pay are counted
                  differently, deducted differently, and a leave with no kind
                  cannot be counted against a balance at all — which is what
                  the balance tiles beside it are for. */}
              {leaveTypes.length > 0 && (
                <Field label="Kind of leave" required hint="What it is counted against.">
                  <Select
                    value={form.leave_type_id}
                    onChange={(v) => setForm({ ...form, leave_type_id: v })}
                    placeholder="Choose"
                    options={leaveTypes.map((t) => ({
                      value: t.id,
                      label: t.annual_quota ? `${t.name} (${t.annual_quota} a year)` : t.name,
                    }))}
                  />
                </Field>
              )}
              <Field label="Reason" required>
                <Input
                  value={form.reason}
                  onChange={(v) => setForm({ ...form, reason: v })}
                  placeholder="Medical, parent function, examination duty…"
                />
              </Field>
              <label className="mt-2 flex items-center gap-2 text-[13.5px]">
                <input
                  type="checkbox"
                  checked={form.is_half_day}
                  onChange={(e) => setForm({ ...form, is_half_day: e.target.checked })}
                />
                Half day
              </label>
              <FormNotice error={send.error} />
              <Button
                className="mt-3"
                disabled={
                  !form.from_date ||
                  !form.to_date ||
                  !form.reason.trim() ||
                  // Only when there is something to choose. A school that has
                  // not set its leave types up must still be able to apply.
                  (leaveTypes.length > 0 && !form.leave_type_id) ||
                  send.isPending
                }
                onClick={() => send.mutate()}
              >
                {send.isPending ? 'Sending…' : 'Send the request'}
              </Button>
            </div>
          )}
          {!apply && applied && (
            <p className="px-5 pb-4 text-[13.5px] text-muted-foreground">{applied}</p>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Requests"
            description="Most recent first"
            action={
              <Select
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'pending', label: 'Pending' },
                  { value: 'approved', label: 'Approved' },
                  { value: 'rejected', label: 'Rejected' },
                  { value: '', label: 'All' },
                ]}
              />
            }
          />
          <FormNotice error={decide.error} ok={done} />
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            <Table
              head={['Who', 'Type', 'From', 'To', 'Days', 'Reason', 'Status', '']}
              empty={!items.length}
              emptyLabel={status === 'pending' ? 'Nothing awaiting a decision.' : 'No requests.'}
            >
              {items.map((l) => (
                <tr key={l.id}>
                  <Td className="font-medium">
                    {l.who}
                    <span className="block text-[12px] font-normal text-muted-foreground">
                      {/* The column spells it 'staff'. Comparing against
                          'employee' meant every teacher's own leave was
                          labelled "Student" on their own screen. */}
                      {l.subject_kind === 'staff' ? 'Staff' : 'Student'}
                    </span>
                  </Td>
                  {/* Applications filed before the kind was required have
                      none, and there is no honest way to guess one. "Not
                      recorded" says that; a dash reads as data we lost. */}
                  <Td className="text-muted-foreground">
                    {l.leave_type ?? <span className="italic">Not recorded</span>}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(l.from_date)}</Td>
                  <Td className="text-muted-foreground">{formatDate(l.to_date)}</Td>
                  <Td className="tabular-nums">{l.days}</Td>
                  <Td className="text-muted-foreground">
                    <span className="block max-w-[26ch] truncate" title={l.reason}>
                      {l.reason || '—'}
                    </span>
                  </Td>
                  <Td><StatusPill status={l.status} /></Td>
                  <Td>
                    {l.status === 'pending' && mayDecide && (
                      <span className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: l.id, decision: 'approved' })}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          tone="danger"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: l.id, decision: 'rejected' })}
                        >
                          Reject
                        </Button>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
