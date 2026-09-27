import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Button, ErrorState } from '@/components/ui'

/* School health board: one row per school from the CONTROL snapshot
   (refreshed every 15 minutes), a detail view per school recomputed live. */

interface Problem { key: string; label: string; count: number; link: string; hint: string }
interface Alert { metric: string; level: number; pct: number; message: string; raised_at: string }
export interface SchoolHealthRow {
  id: string; name: string; slug: string; reachable: boolean
  last_activity_at: string | null; signins_today: number
  active_7d: Record<string, number>; active_30d: Record<string, number>
  setup: { completed: number; total: number; ready: boolean } | null
  errors_24h: number; jobs_failed_24h: number
  subscription: { plan_code: string; status: string; renews_on: string | null; trial_ends_on: string | null } | null
  problems: Problem[]; problem_total: number; alerts: Alert[]; computed_at?: string
}

const when = (s: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never')
const roles = (m: Record<string, number>) =>
  Object.entries(m).filter(([k]) => k !== 'total').sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['seller-health', id], queryFn: () => api.get<SchoolHealthRow>(`/api/v1/seller/health/${id}`) })
  const h = q.data
  return (
    <Card>
      <CardHeader title={h ? `${h.name}: data problems` : 'Loading…'} action={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>} />
      {q.error ? <ErrorState error={q.error} /> : (
        <div className="space-y-3 px-5 py-4 text-[13px]">
          {h && (
            <>
              <p>Last activity {when(h.last_activity_at)}; {h.signins_today} sign-ins today. Active 7 days: {h.active_7d.total ?? 0} ({roles(h.active_7d) || 'none'}). Active 30 days: {h.active_30d.total ?? 0} ({roles(h.active_30d) || 'none'}).</p>
              {h.alerts.map((a) => <p key={a.metric}><Badge tone={a.level >= 100 ? 'danger' : 'warning'}>{a.level}%</Badge> {a.message}</p>)}
            </>
          )}
          <Table head={['Problem', { label: 'Count', align: 'right' }, 'What to do', 'Fix']} loading={q.isPending} empty={!!h && h.problems.length === 0}
            emptyLabel="School database not reachable.">
            {h?.problems.map((p) => (
              <tr key={p.key}>
                <Td>{p.label}</Td>
                <Td className="text-right tabular-nums">{p.count > 0 ? <Badge tone="warning">{p.count}</Badge> : '0'}</Td>
                <Td>{p.hint}</Td>
                <Td><a className="text-primary underline" href={p.link} title="Opens in the school; act inside the school first">{p.link}</a></Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  )
}

export default function SchoolHealthBoard() {
  const qc = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['seller-health'], queryFn: () => api.get<{ items: SchoolHealthRow[]; computed_at: string | null }>('/api/v1/seller/health') })
  const refresh = useMutation({ mutationFn: () => api.post('/api/v1/seller/health/refresh'), onSuccess: () => qc.invalidateQueries({ queryKey: ['seller-health'] }) })
  const items = q.data?.items ?? []
  return (
    <>
      <Card>
        <CardHeader title={`School health${q.data?.computed_at ? ` (as of ${when(q.data.computed_at)})` : ''}`}
          action={<Button size="sm" variant="secondary" pending={refresh.isPending} onClick={() => refresh.mutate()}>Refresh</Button>} />
        {q.error ? <ErrorState error={q.error} /> : (
          <Table head={['School', 'Last activity', { label: 'Sign-ins today', align: 'right' }, { label: 'Active 7d / 30d', align: 'right' }, 'Setup',
            { label: 'Errors 24h', align: 'right' }, { label: 'Jobs failed', align: 'right' }, 'Subscription', 'Plan limits', { label: 'Data problems', align: 'right' }]}
            loading={q.isPending} empty={items.length === 0} emptyLabel="No snapshot yet. Press Refresh, or wait for the 15-minute job.">
            {items.map((s) => (
              <tr key={s.id} className="cursor-pointer" onClick={() => setOpen(s.id)}>
                <Td>{s.name}{!s.reachable && <> <Badge tone="danger">no database</Badge></>}</Td>
                <Td className="whitespace-nowrap">{when(s.last_activity_at)}</Td>
                <Td className="text-right tabular-nums">{s.signins_today}</Td>
                <Td className="text-right tabular-nums" >{s.active_7d.total ?? 0} / {s.active_30d.total ?? 0}</Td>
                <Td>{s.setup ? <Badge tone={s.setup.ready ? 'success' : 'warning'}>{s.setup.completed}/{s.setup.total}</Badge> : '-'}</Td>
                <Td className="text-right tabular-nums">{s.errors_24h ? <Badge tone="danger">{s.errors_24h}</Badge> : 0}</Td>
                <Td className="text-right tabular-nums">{s.jobs_failed_24h ? <Badge tone="danger">{s.jobs_failed_24h}</Badge> : 0}</Td>
                <Td>{s.subscription ? `${s.subscription.plan_code} · ${s.subscription.status}` : 'none'}</Td>
                <Td>{s.alerts.length ? s.alerts.map((a) => <Badge key={a.metric} tone={a.level >= 100 ? 'danger' : 'warning'}>{a.metric} {a.pct}%</Badge>) : 'ok'}</Td>
                <Td className="text-right tabular-nums">{s.problem_total ? <Badge tone="warning">{s.problem_total}</Badge> : 0}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  )
}
