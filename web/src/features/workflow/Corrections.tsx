import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Button, Select, Input, Loading, ErrorState, EmptyState, FormNotice,
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

interface Mark {
  id: string
  student_id: string
  full_name: string
  admission_no: string
  on_date: string
  status: string
}

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

  /* Raising one. The register for a section and a day, so the teacher points
     at the mark that is wrong rather than being asked for its id. */
  const [asking, setAsking] = useState(false)
  const [sectionId, setSectionId] = useState('')
  const [onDate, setOnDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [toStatus, setToStatus] = useState<Record<string, string>>({})
  const [why, setWhy] = useState<Record<string, string>>({})

  const mySections = useQuery({
    queryKey: ['sections', 'mine'],
    queryFn: () => api.get<List<{ id: string; name: string; class_name: string }>>(
      '/api/v1/academics/sections?mine=true'),
  })

  const register = useQuery({
    queryKey: ['attendance', sectionId, onDate],
    enabled: asking && !!sectionId && !!onDate,
    queryFn: () => api.get<List<Mark>>(
      `/api/v1/attendance?section_id=${sectionId}&on_date=${onDate}`),
  })

  const raise = useMutation({
    mutationFn: (m: Mark) => api.post('/api/v1/attendance-workflow/corrections', {
      attendance_id: m.id,
      to_status: toStatus[m.id],
      reason: why[m.id]?.trim(),
    }),
    onSuccess: () => {
      setDone('Correction requested. It waits on somebody who can amend the register.')
      qc.invalidateQueries({ queryKey: ['corrections'] })
    },
  })

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
            title="Correct a mark"
            description="The register as it stands. Ask for a change against the row that is wrong."
            action={
              <Button variant={asking ? 'ghost' : 'primary'} size="sm"
                onClick={() => setAsking((v) => !v)}>
                {asking ? 'Close' : 'Request a correction'}
              </Button>
            }
          />
          {asking && (
            <>
              <div className="flex flex-wrap items-end gap-3 p-5">
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">Section</span>
                  <div className="w-52">
                    <Select
                      value={sectionId}
                      onChange={setSectionId}
                      placeholder="Which section"
                      options={(mySections.data?.items ?? []).map((x) => ({
                        value: x.id, label: `${x.class_name}-${x.name}`,
                      }))}
                    />
                  </div>
                </label>
                <label className="flex flex-col gap-1.5 text-[13px]">
                  <span className="text-muted-foreground">Date</span>
                  <div className="w-44">
                    <Input type="date" value={onDate} onChange={setOnDate} />
                  </div>
                </label>
              </div>

              {!sectionId ? null : register.isLoading ? (
                <Loading />
              ) : (register.data?.items ?? []).length === 0 ? (
                <EmptyState
                  title="Nothing marked that day"
                  body="There is no register for this section on that date, so there is nothing to correct."
                />
              ) : (
                <Table wide head={['Student', 'Marked', 'Change to', 'Why', '']}>
                  {(register.data?.items ?? []).map((m) => (
                    <tr key={m.id}>
                      <Td className="font-medium">
                        {m.full_name}
                        <div className="font-mono text-[12px] text-muted-foreground">
                          {m.admission_no}
                        </div>
                      </Td>
                      <Td><StatusPill status={m.status} /></Td>
                      <Td>
                        <div className="w-36">
                          <Select
                            value={toStatus[m.id] ?? ''}
                            onChange={(v) => setToStatus((t) => ({ ...t, [m.id]: v }))}
                            placeholder="No change"
                            options={['present', 'absent', 'late', 'excused', 'half_day']
                              .filter((x) => x !== m.status)
                              .map((x) => ({ value: x, label: x.replace('_', ' ') }))}
                          />
                        </div>
                      </Td>
                      <Td>
                        <div className="w-52">
                          <Input
                            value={why[m.id] ?? ''}
                            onChange={(v) => setWhy((w) => ({ ...w, [m.id]: v }))}
                            srLabel={`Why ${m.full_name}'s mark is wrong`}
                            placeholder="Came in late with a note"
                          />
                        </div>
                      </Td>
                      <Td>
                        {/* Both required. A correction with no reason is one
                            the approver has to ring somebody about, and
                            attendance drives exam eligibility — an unexplained
                            amendment is exactly what the approval exists for. */}
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!toStatus[m.id] || !(why[m.id] ?? '').trim() || raise.isPending}
                          onClick={() => raise.mutate(m)}
                        >
                          Request
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
              <div className="border-t px-5 py-3">
                <FormNotice error={raise.error} />
              </div>
            </>
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
