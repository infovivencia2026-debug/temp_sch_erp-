import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { FleetMap } from '@/components/FleetMap'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Loading, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import {
  ageText, hasPlot, stateSentence, usePoll, useSecondsSince, useTabVisible, withDrift,
  STATE_LABEL, STATE_TONE, type ChildBusFeed, type ChildBusRow,
} from './child-bus'


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

  if (feed.isLoading) return <Loading label="Finding your child's bus…" />
  if (feed.error) return <ScreenError error={feed.error} />

  return (
    <>
      <PageHead
        eyebrow="My child's bus"
        title="Live bus tracking"
        description="The bus, your child's stop, and the straight-line distance between them. That distance is how far away it is, not how long it will take — the bus still has roads, turns and other stops between the two."
      />
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
                : 'Not refreshing — nothing is on a run, or this tab is in the background.'}
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
          <Fact label="Scheduled" value={row.scheduled_at ?? '—'} />
          <Fact
            label="Straight-line distance"
            value={row.metres_away != null ? `${row.metres_away} m` : '—'}
          />
          <Fact
            label="Arrives in about"
            value={row.eta_minutes != null ? `${row.eta_minutes} min` : '—'}
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
          /* The streets, because that is the question.

             A parent knows their own road and not a pair of decimal degrees,
             so "has it turned into our road yet" is a question only streets
             can answer. The straight line to the stop and its distance are
             drawn on the map itself rather than in a second plot underneath:
             one picture, with the number sitting on the thing it measures. */
          /* 460px WAS MORE THAN HALF A PHONE.

             On an 844px handset a fixed 460px map is 54% of the screen, and
             everything the parent came to read -- whether the bus is running,
             how far away it is, how many minutes -- sat below the fold under
             it. The map is the centrepiece on a desktop, where 460px is a
             third of the window; on a phone it has to leave room for the
             sentence that explains it.

             Expressed against the viewport rather than as a smaller fixed
             number so it stays a proportion of whatever screen it is on:
             roughly a third of a phone, and back to 460px the moment there is
             a window big enough to deserve it. */
          <FleetMap
            className="h-[min(38vh,460px)] sm:h-[460px]"
            vehicles={
              hasPlot(row)
                ? [
                    {
                      id: 'bus',
                      label: row.registration_no || 'Bus',
                      latitude: row.latitude!,
                      longitude: row.longitude!,
                      state: row.state === 'stale' ? 'stale' : 'running',
                      note: `no fix · ${ageText(row.age_seconds)}`,
                    },
                  ]
                : []
            }
            stops={
              /* THE WHOLE ROUTE, WITH OURS SINGLED OUT.

                 One stop and a bus on a blank field said how far and nothing
                 about where the bus was on its way. Every stop on the route
                 is drawn, numbered in running order, and the child's own is
                 the big green one with its alert circle. A route whose stops
                 carry no positions falls back to the one stop it did before. */
              (row.stops ?? []).length > 0
                ? row.stops.map((s) => {
                    const mine = s.id === row.stop_id
                    return {
                      id: s.id,
                      name: mine ? `${s.sequence}. ${s.name} · your stop` : `${s.sequence}. ${s.name}`,
                      latitude: s.latitude,
                      longitude: s.longitude,
                      geofence_m: mine ? row.proximity_m : undefined,
                      mine,
                    }
                  })
                : row.stop_latitude != null && row.stop_longitude != null
                  ? [
                      {
                        id: 'stop',
                        name: row.stop ?? 'Your stop',
                        latitude: row.stop_latitude,
                        longitude: row.stop_longitude,
                        geofence_m: row.proximity_m,
                        mine: true,
                      },
                    ]
                  : []
            }
            link={
              hasPlot(row) && row.stop_latitude != null && row.stop_longitude != null
                ? {
                    from: { latitude: row.latitude!, longitude: row.longitude! },
                    to: { latitude: row.stop_latitude, longitude: row.stop_longitude },
                    label:
                      row.metres_away != null ? `${row.metres_away} m straight line` : undefined,
                  }
                : null
            }
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

