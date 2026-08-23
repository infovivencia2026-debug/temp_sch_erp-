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
  /* What you open on depends on why you are here.
   *
   * "Pending" is the right default for somebody who decides leave — the queue
   * is the job. It is the wrong default for everybody else: your own request
   * disappears from this screen the moment it is answered, which is exactly
   * when you came to look at it. An applicant opens on all statuses and sees
   * their own history, decided or not. */
  const canDecide = can('hr.leave.approve')
  const [status, setStatus] = useState(canDecide ? 'pending' : '')
  const [done, setDone] = useState('')

  /* Whose leave this screen is about.
   *
   * One table holds both, and one screen showing both put children into HR's
   * queue beside the teachers — in a module that exists for employees. The
   * workspace in the URL says which door somebody came through: HR's is staff,
   * everybody else's is unchanged, and the principal still sees one queue
   * because they genuinely decide both from the same desk. */
  const workspace = useLocation().pathname.split('/')[1]
  const forWhom = workspace === 'hr' ? 'staff' : ''

  /* Which door somebody came through.
   *
   * One screen serves two jobs — deciding other people's leave, and taking
   * your own — and it was always drawing the approver's. So "My Profile →
   * Leave & self service" opened a page headed "Staff & student leave
   * approvals", which is somebody else's work under a menu entry that
   * promised your own. The feature in the URL says which was meant. */
  const { featureSlug } = useParams()
  const mine = featureSlug === 'leave_self_service'

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
  const [form, setForm] = useState({ from_date: '', to_date: '', reason: '', is_half_day: false })
  const [applied, setApplied] = useState('')
  const send = useMutation({
    mutationFn: () => api.post('/api/v1/workflow/leave', form),
    onSuccess: () => {
      setApplied('Sent. Whoever approves leave here will see it — the head of department or the principal, whichever gets there first.')
      setForm({ from_date: '', to_date: '', reason: '', is_half_day: false })
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
              <Field label="Reason" required>
                <Input
                  value={form.reason}
                  onChange={(v) => setForm({ ...form, reason: v })}
                  placeholder="Medical, family function, examination duty…"
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
                disabled={!form.from_date || !form.to_date || !form.reason.trim() || send.isPending}
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
                      {l.subject_kind === 'employee' ? 'Staff' : 'Student'}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{l.leave_type ?? '—'}</Td>
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
