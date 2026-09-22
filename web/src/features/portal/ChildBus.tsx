import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { RouteGuidance } from '@/components/RouteGuidance'
import { PageHead, PageBody, Card, CardHeader, Badge, EmptyState } from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import {
  ageText, hasPlot, stateSentence, usePoll, useSecondsSince, withDrift,
  STATE_LABEL, STATE_TONE, type ChildBusFeed, type ChildBusRow,
} from './child-bus'
import { useTabVisible } from '@/lib/visible'


export default function ChildBus() {
  const visible = useTabVisible()
  const feed = useQuery({
    queryKey: ['me-child-bus'],
    queryFn: () => api.get<ChildBusFeed>('/api/v1/me/child-bus'),
  })

  const staleAfter = feed.data?.stale_after_seconds ?? 60
  /* Age the cached rows by however long the answer has been sitting here, so
     a paused poll cannot leave a bus looking live. */
  const drift = useSecondsSince(feed.dataUpdatedAt)
  const rows = (feed.data?.items ?? []).map((r) => withDrift(r, drift, staleAfter))
  const every = usePoll(rows, visible, () => void feed.refetch())

  if (feed.isLoading) return <ScreenSkeleton label="Finding your child's bus…" />
  if (feed.error && !feed.data) return <ScreenError error={feed.error} />

  return (
    <>
      <PageHead
        eyebrow="My child's bus"
        title="Live bus tracking"
        description="The bus, your child's stop, and the straight-line distance between them. That distance is how far away it is, not how long it will take, the bus still has roads, turns and other stops between the two."
      />
      <Freshness query={feed} />
      <PageBody>
        {rows.length === 0 ? (
          <EmptyState
            title="No child of yours is on a school bus"
            body="This page shows children with a current transport allocation. If your child travels by bus and is not listed, the transport office holds that record."
          />
        ) : (
          <>
            {rows.map((row) => (
              <ChildCard key={row.student_id} row={row} staleAfter={staleAfter} />
            ))}
            <p className="text-[12.5px] text-muted-foreground">
              {every && visible
                ? `Refreshing every ${every} seconds while this tab is in front of you.`
                : 'Not refreshing, nothing is on a run, or this tab is in the background.'}
            </p>
          </>
        )}
      </PageBody>
    </>
  )
}

function ChildCard({ row, staleAfter }: { row: ChildBusRow; staleAfter: number }) {
  return (
    <Card>
      <CardHeader
        title={row.student_name}
        description={`${row.route}${row.registration_no ? ` · ${row.registration_no}` : ''}${
          row.direction ? ` · ${row.direction === 'drop' ? 'Afternoon drop' : 'Morning pickup'}` : ''
        }`}
        action={<Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>}
      />
      <div className="space-y-4 px-5 py-4">
        <p className="max-w-2xl text-[14px] leading-relaxed text-muted-foreground">
          {stateSentence(row, staleAfter)}
        </p>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
          <Fact label="Stop" value={row.stop ?? 'Not recorded'} />
          <Fact label="Scheduled" value={row.scheduled_at ?? '-'} />
          <Fact
            label="Straight-line distance"
            value={row.metres_away != null ? `${row.metres_away} m` : '-'}
          />
          <Fact
            label="Arrives in about"
            value={row.eta_minutes != null ? `${row.eta_minutes} min` : '-'}
          />
          <Fact label="Last position" value={ageText(row.age_seconds)} />
        </dl>

        {hasPlot(row) || (row.stop_latitude != null && row.stop_longitude != null) ? (
          /* THE MAP IS THERE BEFORE THE BUS IS.

             It used to appear only once the bus had a position, so on the
             morning the driver's phone was still finding satellites a parent
             opened "Live bus tracking" and found a card of words and no map
             at all — which reads as the map being broken, not as the bus
             being quiet. The stop is known before any bus moves, so the map
             is drawn around the stop and the bus joins it when it reports.
             The sentence above already says why there is no bus on it. */
          /* THE JOURNEY, NOT A PLOT.

             The map used to be a street map with a dot, a dashed line and a
             number, and the facts sat in a grid above it. It is now the
             navigation panel (components/RouteGuidance.tsx): a quiet map with
             the run drawn through its stops in one colour, a timeline down
             the left -- your stop, the next stop and how far, the speed, what
             is still to come -- and the minutes in the corner. The grid of
             facts above stays, because it is what a screen reader reads and
             what prints; the panel is the same facts drawn. */
          /* THE WHOLE ROUTE, WITH OURS SINGLED OUT.

             One stop and a bus on a blank field said how far and nothing
             about where the bus was on its way. Every stop on the route is
             drawn and the child's own is filled in the accent with its alert
             circle. A route whose stops carry no positions falls back to the
             one stop it did before. */
          <RouteGuidance
            row={{
              vehicle: hasPlot(row)
                ? {
                    id: 'bus',
                    label: row.registration_no || 'Bus',
                    latitude: row.latitude!,
                    longitude: row.longitude!,
                    heading_deg: row.heading_deg,
                    state: row.state === 'stale' ? 'stale' : 'running',
                    note: `no fix · ${ageText(row.age_seconds)}`,
                  }
                : undefined,
              stops:
                (row.stops ?? []).length > 0
                  ? row.stops
                  : row.stop_latitude != null && row.stop_longitude != null
                    ? [
                        {
                          id: 'stop',
                          name: row.stop ?? 'Your stop',
                          sequence: 1,
                          latitude: row.stop_latitude,
                          longitude: row.stop_longitude,
                        },
                      ]
                    : [],
              myStopId: (row.stops ?? []).length > 0 ? row.stop_id : 'stop',
              myStopName: row.stop,
              latitude: hasPlot(row) ? row.latitude : undefined,
              longitude: hasPlot(row) ? row.longitude : undefined,
              metresAway: row.metres_away,
              etaMinutes: row.state === 'running' ? row.eta_minutes : undefined,
              speedKmph: row.state === 'running' ? row.speed_kmph : undefined,
              proximityM: row.proximity_m,
              scheduledAt: row.scheduled_at,
              status:
                row.state === 'running' || row.state === 'arrived'
                  ? undefined
                  : STATE_LABEL[row.state],
              /* The marker glides from the last fix to this one over most of
                 the poll interval, so a bus that reports every ten seconds is
                 seen moving rather than appearing ten seconds further on. */
              glideMs: Math.min(row.refresh_seconds || 15, 15) * 900,
            }}
          />
        ) : (
          /* No map rather than an empty one. A blank box under a sentence that
             already said why is a second, wordless claim that something is
             broken. */
          null
        )}

        {row.state === 'running' && row.metres_away != null && (
          <p className="text-[12.5px] text-muted-foreground">
            {row.metres_away} m is measured in a straight line across the map, not along the road.
            {row.eta_minutes != null
              ? ` The ${row.eta_minutes} minutes is that distance at the speed the bus is doing now, so traffic and the turns it still has to make will both make it longer.`
              : ''}
            The bus may have turns, traffic and other stops to make first, so this is a distance,
            not an arrival time. You will be alerted when it comes within {row.proximity_m} m.
          </p>
        )}
      </div>
    </Card>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  )
}

