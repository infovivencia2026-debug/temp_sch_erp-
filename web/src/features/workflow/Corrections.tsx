import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Button, Select, Loading, ErrorState, FormNotice,
} from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import { formatDate } from '@/lib/utils'

/* Attendance corrections.
 *
 * A register is submitted and then someone realises a child was marked absent
 * who was sitting in the room. The teacher raises an amendment; somebody with
 * write.any decides it. Until now the endpoint existed and nothing called it,
 * so the request went into the table and stayed there.
 *
 * The decision applies the change: approving rewrites the attendance row and
 * records who did it, which is why this is a queue and not an edit form on the
 * register.
 */

interface Correction {
  id: string
  student_name: string
  on_date: string
  from_status: string
  to_status: string
  reason: string
  requested_by: string
  status: string
}

export default function Corrections() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('pending')
  const [note, setNote] = useState('')
  const [done, setDone] = useState('')

  const q = useQuery({
    queryKey: ['corrections', status],
    queryFn: () =>
      api.get<List<Correction>>(
        `/api/v1/attendance-workflow/corrections${status ? `?status=${status}` : ''}`,
      ),
  })

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      api.post(`/api/v1/attendance-workflow/corrections/${id}/decide`, { decision, note }),
    onSuccess: (_r, v) => {
      setDone(v.decision === 'approved'
        ? 'Approved — the register has been amended.'
        : 'Rejected. The original mark stands.')
      setNote('')
      qc.invalidateQueries({ queryKey: ['corrections'] })
      // The attention panel counts these; it should not keep claiming one is
      // waiting after it has been decided.
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  const items = q.data?.items ?? []
  const pending = items.filter((c) => c.status === 'pending').length

  return (
    <>
      <PageHead
        eyebrow="Attendance"
        title="Attendance corrections"
        description="Amendments raised by teachers after a register was submitted. Approving rewrites the mark and records who changed it."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Showing" value={items.length} hint={status || 'all statuses'} />
          <Stat label="Awaiting decision" value={pending} />
          <Stat label="Decided" value={items.length - pending} />
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
              head={['Student', 'Date', 'Change', 'Reason', 'Raised by', 'Status', '']}
              empty={!items.length}
              emptyLabel={status === 'pending' ? 'Nothing awaiting a decision.' : 'No requests.'}
            >
              {items.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">{c.student_name}</Td>
                  <Td className="text-muted-foreground">{formatDate(c.on_date)}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusPill status={c.from_status} />
                      <span className="text-muted-foreground">→</span>
                      <StatusPill status={c.to_status} />
                    </span>
                  </Td>
                  <Td className="max-w-[24ch] truncate text-muted-foreground" >{c.reason || '—'}</Td>
                  <Td className="text-muted-foreground">{c.requested_by || '—'}</Td>
                  <Td><StatusPill status={c.status} /></Td>
                  <Td>
                    {c.status === 'pending' && (
                      <span className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: c.id, decision: 'approved' })}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          tone="danger"
                          disabled={decide.isPending}
                          onClick={() => decide.mutate({ id: c.id, decision: 'rejected' })}
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
