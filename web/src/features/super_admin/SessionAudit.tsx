import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { useVisibleInterval } from '@/lib/visible'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, ConfirmButton, FormNotice, SkeletonTable, ErrorState,
} from '@/components/ui'

interface SessionRow {
  id: string
  user_id: string
  full_name: string
  ip?: string
  user_agent?: string
  created_at: string
  last_seen_at: string
  expires_at: string
  revoked: boolean
}

function when(iso: string) {
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

/** Collapses a UA string to something a human can scan in a table. */
function agent(ua?: string) {
  if (!ua) return '—'
  const browser = /Firefox\/[\d.]+/.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : /curl/i.test(ua)
            ? 'curl'
            : 'Other'
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${browser} · ${os}` : browser
}

export default function SessionAudit() {
  const qc = useQueryClient()
  const [activeOnly, setActiveOnly] = useState(true)

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-sessions', activeOnly],
    queryFn: () => api.get<List<SessionRow>>(`/api/v1/admin/sessions?active=${activeOnly}`),
    /* Sessions come and go while an administrator watches, so poll; but only
       while the tab is visible, since a hidden audit screen audits nothing. */
    refetchInterval: useVisibleInterval(30_000),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/admin/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-sessions'] }),
  })

  const rows = data?.items ?? []
  const live = rows.filter((r) => !r.revoked)
  const uniqueUsers = new Set(live.map((r) => r.user_id)).size
  const uniqueIPs = new Set(live.map((r) => r.ip).filter(Boolean)).size

  return (
    <>
      <PageHead
        eyebrow="Platform Setup"
        title="Login & session audit"
        description="Real-time login timestamps, IP addresses, browser agents and active sessions."
        actions={
          <Button variant="secondary" onClick={() => setActiveOnly((v) => !v)}>
            {activeOnly ? 'Show all' : 'Active only'}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Live sessions" value={live.length} />
          <Stat label="Distinct users" value={uniqueUsers} />
          <Stat label="Distinct IPs" value={uniqueIPs} hint="Live sessions only" />
        </CellGrid>

        <Card>
          <CardHeader
            title={activeOnly ? 'Active sessions' : 'All sessions'}
            description="Refreshes every 30 seconds"
          />
          {isLoading ? (
            <SkeletonTable columns={7} />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table
              head={['User', 'IP', 'Agent', 'Signed in', 'Last seen', 'State', '']}
              empty={!rows.length}
              emptyLabel="No sessions recorded."
            >
              {rows.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium">{s.full_name}</Td>
                  <Td className="font-mono text-[12px]">{s.ip ?? '—'}</Td>
                  <Td className="text-muted-foreground">{agent(s.user_agent)}</Td>
                  <Td className="text-muted-foreground">{when(s.created_at)}</Td>
                  <Td className="text-muted-foreground">{when(s.last_seen_at)}</Td>
                  <Td>
                    <Badge tone={s.revoked ? 'neutral' : 'success'}>
                      {s.revoked ? 'ended' : 'live'}
                    </Badge>
                  </Td>
                  <Td>
                    {!s.revoked && (
                      // Revoking signs a real person out mid-task, possibly
                      // mid-receipt. Naming them makes it obvious when the
                      // wrong row has been clicked.
                      <ConfirmButton
                        tone="danger"
                        disabled={revoke.isPending}
                        question={`Sign ${s.full_name ?? 'this user'} out immediately?`}
                        confirmLabel="Sign out"
                        onConfirm={() => revoke.mutate(s.id)}
                      >
                        Revoke
                      </ConfirmButton>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {revoke.isError && (
            <div className="border-t px-5 py-3">
              <FormNotice error={revoke.error} />
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}
