import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, type QueueStat, type JobStatus, type EnqueueResponse, type List, type Section } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Button, Select, Loading, ErrorState } from '@/components/ui'
import { useCan } from '@/lib/session'

const STATE_TONE: Record<string, 'success' | 'danger' | 'primary' | 'neutral'> = {
  completed: 'success', active: 'primary', pending: 'neutral',
  scheduled: 'neutral', retry: 'primary', archived: 'danger',
}

export default function Jobs() {
  const can = useCan()
  const [tracked, setTracked] = useState<string[]>([])

  const queues = useQuery({
    queryKey: ['queues'],
    queryFn: () => api.get<{ queues: Record<string, QueueStat> }>('/api/v1/jobs/queues'),
    // Queue depth is the thing you watch while a backlog drains, so this is
    // one of the few places polling is the right call.
    refetchInterval: 5_000,
  })

  if (queues.isLoading) return <Loading />
  if (queues.error) return <ErrorState error={queues.error} />

  const entries = Object.entries(queues.data?.queues ?? {})
    .sort((a, b) => b[1].priority - a[1].priority)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Queues"
          description="Weighted, not strictly ordered — low-priority work still drains while bulk is busy."
        />
        <Table head={['Queue', 'Weight', 'Pending', 'Active', 'Scheduled', 'Retry', 'Archived', 'Processed', 'Failed']}
          empty={!entries.length}>
          {entries.map(([name, q]) => (
            <tr key={name}>
              <Td className="font-medium">
                {name} {q.paused && <Badge tone="danger">paused</Badge>}
              </Td>
              <Td className="tabular-nums">{q.priority}</Td>
              <Td className="tabular-nums">{q.pending}</Td>
              <Td className="tabular-nums">{q.active}</Td>
              <Td className="tabular-nums">{q.scheduled}</Td>
              <Td className="tabular-nums">{q.retry}</Td>
              <Td className="tabular-nums">
                {q.archived > 0 ? <Badge tone="danger">{q.archived}</Badge> : 0}
              </Td>
              <Td className="tabular-nums">{q.processed}</Td>
              <Td className="tabular-nums">
                {q.failed > 0 ? <Badge tone="danger">{q.failed}</Badge> : 0}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {can('admin.jobs.enqueue') && <Enqueue onQueued={(id) => setTracked((t) => [id, ...t])} />}

      {tracked.length > 0 && (
        <Card>
          <CardHeader title="Tracked jobs" description="Polled until they leave the 24h retention window." />
          <Table head={['Task', 'Type', 'Queue', 'State', 'Attempts', 'Last error']} empty={false}>
            {tracked.map((id) => <JobRow key={id} id={id} />)}
          </Table>
        </Card>
      )}
    </div>
  )
}

function Enqueue({ onQueued }: { onQueued: (taskID: string) => void }) {
  const [sectionId, setSectionId] = useState('')

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })

  const fanout = useMutation({
    mutationFn: () =>
      api.post<EnqueueResponse>('/api/v1/jobs', {
        type: 'fee:reminder_fanout',
        payload: { template_key: 'fee.overdue' },
      }),
    onSuccess: (r) => onQueued(r.task_id),
  })

  const exportStudents = useMutation({
    mutationFn: () =>
      api.post<EnqueueResponse>('/api/v1/jobs', {
        type: 'export:build',
        payload: { kind: 'students', format: 'csv' },
      }),
    onSuccess: (r) => onQueued(r.task_id),
  })

  return (
    <Card>
      <CardHeader
        title="Trigger background work"
        description="These return 202 immediately — nothing heavy runs inside a request."
      />
      <div className="flex flex-wrap items-center gap-3 p-4">
        <Button onClick={() => fanout.mutate()} disabled={fanout.isPending}>
          Fee reminder fan-out
        </Button>
        <Button onClick={() => exportStudents.mutate()} disabled={exportStudents.isPending}>
          Export students (CSV)
        </Button>
        <div className="flex items-center gap-2">
          <Select
            value={sectionId}
            onChange={setSectionId}
            placeholder="Section for report cards"
            options={(sections.data?.items ?? []).map((s) => ({
              value: s.id, label: `${s.class_name}-${s.name}`,
            }))}
          />
          <Button disabled title="Needs an exam to be selected">Generate report cards</Button>
        </div>
      </div>
      {(fanout.isError || exportStudents.isError) && (
        <p className="px-4 pb-4 text-xs text-destructive">
          {(fanout.error ?? exportStudents.error) instanceof Error
            ? (fanout.error ?? exportStudents.error as Error).message
            : 'Could not enqueue'}
        </p>
      )}
    </Card>
  )
}

function JobRow({ id }: { id: string }) {
  const { data, error } = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.get<JobStatus>(`/api/v1/jobs/${id}`),
    // Stop hammering the inspector once the task reaches a terminal state.
    refetchInterval: (q) => {
      const s = q.state.data?.state
      return s === 'completed' || s === 'archived' ? false : 2_000
    },
    retry: false,
  })

  if (error) {
    return (
      <tr>
        <Td className="font-mono text-xs">{id.slice(0, 8)}</Td>
        <Td className="text-xs text-muted-foreground" >—</Td>
        <Td>—</Td>
        <Td><Badge tone="neutral">expired</Badge></Td>
        <Td>—</Td>
        <Td className="text-xs text-muted-foreground">Outside the retention window</Td>
      </tr>
    )
  }
  if (!data) {
    return (
      <tr>
        <Td className="font-mono text-xs">{id.slice(0, 8)}</Td>
        <Td colSpan={5}>…</Td>
      </tr>
    )
  }
  return (
    <tr>
      <Td className="font-mono text-xs">{data.id.slice(0, 8)}</Td>
      <Td className="text-xs">{data.type}</Td>
      <Td>{data.queue}</Td>
      <Td><Badge tone={STATE_TONE[data.state] ?? 'neutral'}>{data.state}</Badge></Td>
      <Td className="tabular-nums">{data.retried}/{data.max_retry}</Td>
      <Td className="max-w-xs truncate text-xs text-destructive">{data.last_error ?? ''}</Td>
    </tr>
  )
}
