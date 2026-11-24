/* Events & reminders (worker/src/routes/comms/yajur_connect_events.ts): the
   upcoming published events from the School Calendar, each with a button
   that opens Send a notice with the event's name and audience filled in.
   Nothing is created or scheduled here. */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Card, EmptyState, ErrorState, Loading, Table, Td } from '@/components/ui'
import { formatDate } from '@/lib/utils'

interface ConnectEvent {
  id: string
  name: string
  kind: string
  on_date: string
  ends_on: string | null
  starts_at: string | null
  venue: string | null
  section_id: string | null
  who: string
}

function when(e: ConnectEvent): string {
  const day = formatDate(e.on_date)
  const to = e.ends_on && e.ends_on !== e.on_date ? ` to ${formatDate(e.ends_on)}` : ''
  return e.starts_at && !to ? `${day}, ${e.starts_at}` : day + to
}

export default function ConnectEvents({ onSend }: { onSend: (prefill: { name: string; sections: string[] }) => void }) {
  const q = useQuery({ queryKey: ['connect', 'events'], queryFn: () => api.get<{ items: ConnectEvent[] }>('/api/v1/comms/yajur-connect/events') })
  const items = q.data?.items ?? []
  return (
    <div className="space-y-3">
      <div>
        <h1 className="sr-only">Events &amp; reminders</h1>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : items.length === 0 ? (
        <Card><EmptyState title="No upcoming events." body="Publish an event in the School Calendar and it appears here with a Send a reminder button." /></Card>
      ) : (
        <Table head={['Event', 'Date', 'Who', '']} noExport noRowHover>
          {items.map((e) => (
            <tr key={e.id}>
              <Td label="Event" className="max-w-[260px] font-medium">
                <div className="truncate">{e.name}</div>
                {e.venue && <div className="truncate text-[12px] font-normal text-muted-foreground">{e.venue}</div>}
              </Td>
              <Td label="Date" className="whitespace-nowrap">{when(e)}</Td>
              <Td label="Who" className="max-w-[200px] truncate">{e.who}</Td>
              <Td label="">
                <Button size="sm" variant="secondary" onClick={() => onSend({ name: e.name, sections: e.section_id ? [e.section_id] : [] })}>Send a reminder</Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}
