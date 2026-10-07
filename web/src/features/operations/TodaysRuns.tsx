import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bus, BusFront, IdCard, Route as RouteIcon } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Select,
  SkeletonTiles, ErrorState, EmptyState, PrintButton,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* TODAY'S RUNS, AND THE OFFICE'S FRONT PAGE.

   Both screens here read the same line per route, because they answer the
   same question at different distances: the desk asks "is anything wrong",
   the runs screen asks "what is R-01 doing". Splitting the data would have
   let the two disagree, which on a transport screen means somebody rings a
   driver who is already back.

   Neither screen starts or finishes a trip. A trip exists because a driver's
   phone started one, and ends because that phone ended it. An office that
   could type a bus into motion would show thirty parents a bus tracking
   nowhere. */

interface Run {
  route_id: string
  route: string
  code: string
  vehicle: string
  driver: string
  attendant: string
  riders: number
  capacity: number
  marked: number
  open_incidents: number
  status: 'running' | 'completed' | 'not_started' | 'no_bus' | 'no_driver'
  check?: 'cleared' | 'failed'
  started_at?: string
}

const LOOK: Record<Run['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  running: { label: 'Running', tone: 'success' },
  completed: { label: 'Completed', tone: 'neutral' },
  not_started: { label: 'Not started', tone: 'warning' },
  no_bus: { label: 'No bus', tone: 'danger' },
  no_driver: { label: 'No driver', tone: 'danger' },
}

function useRuns(leg: string) {
  return useQuery({
    queryKey: ['transport-runs', leg],
    queryFn: () => api.get<List<Run> & { on_date: string }>(`/api/v1/ops/transport/runs?leg=${leg}`),
    refetchInterval: 60_000,
  })
}

/** Morning or afternoon: the only choice either screen asks for. */
function LegPicker({ leg, setLeg }: { leg: string; setLeg: (v: string) => void }) {
  return (
    <Select
      value={leg}
      onChange={setLeg}
      options={[
        { value: 'morning', label: 'Morning' },
        { value: 'afternoon', label: 'Afternoon' },
      ]}
    />
  )
}

function RunCard({ r }: { r: Run }) {
  const look = LOOK[r.status]
  /* Not scanned is the number that matters: a child nobody has looked at.
     Floored, because a register can still carry a child whose allocation
     ended today. */
  const unseen = Math.max(r.riders - r.marked, 0)
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-bold">
            {r.route}
            {r.code ? <span className="ml-2 text-[13px] font-normal text-muted-foreground">{r.code}</span> : null}
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {r.vehicle || 'No bus'} · {r.driver || 'No driver'}
            {r.attendant ? ` · ${r.attendant}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {r.check === 'failed' && <Badge tone="danger">Check failed</Badge>}
          {r.check === 'cleared' && <Badge tone="success">Checked</Badge>}
          {r.open_incidents > 0 && <Badge tone="warning">{r.open_incidents} open</Badge>}
          <Badge tone={look.tone}>{look.label}</Badge>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px] tabular-nums">
        <span>
          <span className="text-muted-foreground">Children </span>
          {r.riders}
          {r.capacity ? <span className="text-muted-foreground"> of {r.capacity}</span> : null}
        </span>
        <span>
          <span className="text-muted-foreground">Marked </span>
          {r.marked}
        </span>
        {unseen > 0 && (
          <span className={cn(r.status === 'running' && 'font-semibold text-warning')}>
            <span className="text-muted-foreground">Not scanned </span>
            {unseen}
          </span>
        )}
        {r.started_at && (
          <span>
            <span className="text-muted-foreground">Left </span>
            {r.started_at}
          </span>
        )}
      </div>
    </Card>
  )
}

/** The runs screen: every route today, one card each. */
export default function TodaysRuns() {
  const [leg, setLeg] = useState('morning')
  const runs = useRuns(leg)
  const items = runs.data?.items ?? []

  if (runs.isLoading && !runs.data) return <SkeletonTiles count={3} label="Reading today's runs…" />
  if (runs.error) return <ErrorState error={runs.error} />

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title="Today's runs"
        description="Each route as it stands. A trip starts and ends on the driver's phone, not here."
        actions={
          <div className="flex gap-2">
            <LegPicker leg={leg} setLeg={setLeg} />
            <PrintButton label="Print" title="Today's runs" />
          </div>
        }
      />
      <PageBody>
        {items.length === 0 ? (
          <EmptyState title="No active routes" body="Add a route, and give it a bus and a driver." />
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((r) => <RunCard key={r.route_id} r={r} />)}
          </div>
        )}
      </PageBody>
    </>
  )
}

/* THE OFFICE'S FRONT PAGE.

   Four numbers, then the things wanting doing, then the routes. Deliberately
   not analytics: nobody opening this at seven in the morning wants a trend,
   they want to know whether to pick up the phone. */
export function TransportDashboard() {
  const [leg, setLeg] = useState('morning')
  const runs = useRuns(leg)
  const today = useQuery({
    queryKey: ['transport-today'],
    queryFn: () => api.get<{
      routes: number
      running: number
      completed: number
      not_started: number
      failed_checks: { vehicle: string; leg: string; failed_items: string[] }[]
      expiring: { vehicle: string; kind: string; on_date: string; days: number }[]
      gaps: { route: string; gap: string }[]
      open_incidents: number
    }>('/api/v1/ops/transport/today'),
    refetchInterval: 60_000,
  })

  if (today.isLoading && !today.data) return <SkeletonTiles count={4} label="Opening the transport desk…" />
  if (today.error) return <ErrorState error={today.error} />
  const d = today.data
  const items = runs.data?.items ?? []
  const attention = d
    ? d.failed_checks.length + d.expiring.length + d.gaps.length + (d.open_incidents > 0 ? 1 : 0)
    : 0

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title="Transport desk"
        description="How many buses are out, and what needs attention."
        actions={<LegPicker leg={leg} setLeg={setLeg} />}
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Routes" value={d?.routes ?? 0} icon={RouteIcon} />
          <Stat label="Running" value={d?.running ?? 0} icon={Bus} />
          <Stat label="Completed" value={d?.completed ?? 0} />
          <Stat label="Not started" value={d?.not_started ?? 0} icon={BusFront} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Needs attention"
            description={attention === 0 ? undefined : 'Read this before the phone rings.'}
          />
          <div className="p-4">
            {attention === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                Every route has a bus and a driver, every check passed, and no papers lapse this month.
              </p>
            ) : (
              <ul className="flex flex-col gap-2 text-[13px]">
                {d?.failed_checks.map((f) => (
                  <li key={`${f.vehicle}-${f.leg}`} className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2">
                    <strong>{f.vehicle}</strong> failed its {f.leg} check
                    {f.failed_items.length ? `: ${f.failed_items.join(', ')}` : ''}.
                  </li>
                ))}
                {d?.gaps.map((g) => (
                  <li key={g.route} className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2">
                    <strong>{g.route}</strong> has {g.gap}.
                  </li>
                ))}
                {d?.expiring.map((e) => (
                  <li key={`${e.vehicle}-${e.kind}`} className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2">
                    <strong>{e.vehicle}</strong> — {e.kind}{' '}
                    {e.days < 0
                      ? `expired ${Math.abs(e.days)} days ago`
                      : e.days === 0 ? 'expires today' : `expires in ${e.days} days`}.
                  </li>
                ))}
                {(d?.open_incidents ?? 0) > 0 && (
                  <li className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2">
                    {d?.open_incidents} incident{d?.open_incidents === 1 ? '' : 's'} still open.
                  </li>
                )}
              </ul>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Today's runs" description="The same routes, as they stand now." />
          <div className="flex flex-col gap-3 p-4">
            {items.length === 0
              ? <EmptyState title="No active routes" body="Add a route, and give it a bus and a driver." />
              : items.map((r) => <RunCard key={r.route_id} r={r} />)}
          </div>
        </Card>

        {/* The three things this desk is opened to do, as buttons rather than
            a menu hunt. */}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { window.location.href = '/transport_manager/transport/todays_runs' }}>
            <Bus className="h-3.5 w-3.5" /> Today&rsquo;s runs
          </Button>
          <Button variant="secondary" onClick={() => { window.location.href = '/transport_manager/transport/route_attendance' }}>
            Attendance
          </Button>
          <Button variant="secondary" onClick={() => { window.location.href = '/transport_manager/transport/delays_exceptions' }}>
            <IdCard className="h-3.5 w-3.5" /> Report an issue
          </Button>
        </div>
      </PageBody>
    </>
  )
}
