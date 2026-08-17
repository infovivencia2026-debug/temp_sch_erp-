import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Select, Loading, ErrorState, FormNotice,
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
  const [status, setStatus] = useState('pending')
  const [done, setDone] = useState('')

  const q = useQuery({
    queryKey: ['leave', status],
    queryFn: () => api.get<List<LeaveRow>>(`/api/v1/hr/leave${status ? `?status=${status}` : ''}`),
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

  const items = q.data?.items ?? []
  const pending = items.filter((l) => l.status === 'pending')
  const staff = items.filter((l) => l.subject_kind === 'employee').length
  const mayDecide = can('hr.leave.approve')

  return (
    <>
      <PageHead
        eyebrow="Attendance & Leave"
        title="Leave requests"
        description="Staff and student leave awaiting a decision, and the history behind it."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Showing" value={items.length} hint={status || 'all statuses'} />
          <Stat label="Awaiting decision" value={pending.length} />
          <Stat label="Staff" value={staff} />
          <Stat label="Students" value={items.length - staff} />
        </CellGrid>

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
