import { useQuery } from '@tanstack/react-query'
import { Fingerprint } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Reload,
  SkeletonTiles, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'

/* Every reader on the installation, on one page.

   Read-only. A reader is registered inside its school, where the act is
   audited; this is the support view — which readers went quiet, which were
   never pointed at us — for the person who looks after thirty campuses. The
   protocol line comes off the server: this is ADMS push and nothing else, so
   a face camera or an RFID gate that does not speak it has no way in. */

interface Device {
  institution_id: string
  school: string
  campus: string | null
  id: string
  serial: string
  name: string
  is_active: boolean
  last_seen_at?: string
  last_push_at?: string
  firmware?: string
  punches_today: number
  unresolved: number
  quiet: boolean
}

interface Resp {
  items: Device[]
  summary: { devices: number; active: number; seen_today: number; quiet: number; never_seen: number; schools: number }
  protocol: string
}

const ago = (iso?: string) => {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`
  return `${Math.round(mins / 1440)} d ago`
}

export default function BiometricFleet() {
  const q = useQuery({
    queryKey: ['biometric-fleet'],
    queryFn: () => api.get<Resp>('/api/v1/admin/biometric-devices'),
  })
  const d = q.data
  const rows = d?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Payments & devices"
        title="Biometric readers"
        actions={<Reload onClick={() => q.refetch()} busy={q.isFetching} />}
      />
      <PageBody>
        {q.isLoading ? (
          <SkeletonTiles count={4} />
        ) : d ? (
          <CellGrid cols={4}>
            <Stat label="Readers" value={d.summary.devices} icon={Fingerprint} hint={`${d.summary.schools} schools`} />
            <Stat label="Seen today" value={d.summary.seen_today} />
            <Stat label="Quiet" value={d.summary.quiet} hint="Active, silent over a day" />
            <Stat label="Never seen" value={d.summary.never_seen} hint="Not yet pointed at us" />
          </CellGrid>
        ) : null}

        <Card>
          <CardHeader title="Fleet" />
          {d && <p className="border-b px-5 py-3 text-[13px] text-muted-foreground">{d.protocol}</p>}
          {q.isLoading ? (
            <SkeletonTable columns={7} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : rows.length === 0 ? (
            <EmptyState title="No readers registered" body="Schools register readers under Staff, Attendance readers." />
          ) : (
            <Table head={['School', 'Reader', 'Serial', 'State', 'Last seen', 'Punches today', 'Unclaimed']}>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">
                    {r.school}
                    {r.campus && <span className="block text-[12px] text-muted-foreground">{r.campus}</span>}
                  </Td>
                  <Td>{r.name}</Td>
                  <Td className="font-mono text-xs">{r.serial}</Td>
                  <Td>
                    {!r.is_active ? (
                      <span className="text-muted-foreground">Not trusted</span>
                    ) : r.quiet ? (
                      <Badge tone="warning">Quiet</Badge>
                    ) : r.last_seen_at ? (
                      <Badge tone="success">Talking</Badge>
                    ) : (
                      <span className="text-muted-foreground">Never seen</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">{ago(r.last_seen_at)}</Td>
                  <Td className="tabular-nums">{r.punches_today}</Td>
                  <Td className="tabular-nums">{r.unresolved > 0 ? <Badge tone="warning">{r.unresolved}</Badge> : '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
