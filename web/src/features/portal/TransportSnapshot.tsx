import { useQuery } from '@tanstack/react-query'
import { BusFront, Clock, MapPin } from 'lucide-react'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, Badge, EmptyState, CellGrid, Stat } from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import {
  ageText, minutes, usePoll, useSecondsSince, withDrift,
  STATE_LABEL, STATE_TONE, type ChildBusFeed, type ChildBusRow,
} from './child-bus'
import { useTabVisible } from '@/lib/visible'
import { walkText } from './transport-prefs'

/* The at-a-glance answer, for the two minutes before the school run.

   Deliberately not the map. A parent standing at the door wants six facts
   about each child -- which route, which bus, which stop, what time it is
   meant to be there, whether it has already been, and how far off it is --
   and a plot with a scale bar is slower to read than a line of text for every
   one of them. The map screen is a click away for the parent who wants to
   watch it move.

   Distances here carry the same warning as the map: straight line, not road
   distance, and no arrival time is derived from it. An ETA computed from
   crows-flies metres is a guess with a clock's face on it, and a parent who
   comes down to the gate on the strength of it once does not trust this
   screen again. */

export default function TransportSnapshot() {
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

  if (feed.isLoading) return <ScreenSkeleton label="Reading today's transport…" />
  if (feed.error && !feed.data) return <ScreenError error={feed.error} />

  /* Stale is not counted as running. A tile that says "1 on a run now" over a
     bus whose last fix is half an hour old is the screen telling a parent the
     one thing it must never tell them, so the silent ones get their own count
     and their own sentence underneath. */
  const running = rows.filter((r) => r.state === 'running').length
  const silent = rows.filter((r) => r.state === 'stale' || r.state === 'no_signal').length
  const arrived = rows.filter((r) => r.state === 'arrived').length

  return (
    <>
      <PageHead
        eyebrow="My child's bus"
        title="Transport snapshot"
        description="Every child of yours who travels by school bus: their route, the vehicle, their stop and the time it is due — and, while a run is open, whether the bus has been yet and how far away it is."
      />
      <Freshness query={feed} />
      <PageBody>
        {rows.length === 0 ? (
          <EmptyState
            title="No child of yours is on a school bus"
            body="This page lists children with a current transport allocation. If your child travels by bus and is not listed here, the transport office holds that record — this screen only reports it."
          />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Children on a bus" value={rows.length} icon={BusFront} />
              <Stat label="On a run now" value={running} icon={MapPin} />
              <Stat label="Already at the stop" value={arrived} icon={Clock} />
            </CellGrid>

            {silent > 0 && (
              <p className="text-[13px] text-destructive">
                {silent === 1 ? 'One bus is' : `${silent} buses are`} on an open run but not
                reporting a position. Where a distance is shown below it is where the bus was, not
                where it is.
              </p>
            )}

            {rows.map((row) => (
              <SnapshotCard key={row.student_id} row={row} staleAfter={staleAfter} />
            ))}

            <p className="text-[12.5px] text-muted-foreground">
              {every && visible
                ? `Refreshing every ${every} seconds while this tab is in front of you. You choose that speed under Alerts & preferences.`
                : 'Not refreshing — nothing is on a run, or this tab is in the background.'}
            </p>
          </>
        )}
      </PageBody>
    </>
  )
}

function SnapshotCard({ row, staleAfter }: { row: ChildBusRow; staleAfter: number }) {
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
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3 lg:grid-cols-5">
          <Fact label="Route" value={row.route} />
          <Fact label="Bus" value={row.registration_no || 'Not assigned'} />
          <Fact label="Their stop" value={row.stop ?? 'Not recorded'} />
          <Fact
            label="Due at the stop"
            value={row.scheduled_at ?? 'No time set'}
            note={row.scheduled_at ? undefined : 'The route timetable has no time for this stop.'}
          />
          <Fact
            label={row.arrived_at ? 'Arrived' : 'Straight-line distance'}
            value={
              row.arrived_at
                ? row.arrived_at
                : row.metres_away != null
                  ? `${row.metres_away.toLocaleString('en-IN')} m`
                  : '—'
            }
            note={
              row.arrived_at
                ? 'Recorded when the bus entered the stop’s geofence.'
                : row.metres_away != null
                  ? `As the crow flies — ${walkText(row.metres_away)}. The road is longer.`
                  : undefined
            }
          />
          {/* The number a parent is actually waiting for. It was the one thing
              this screen could not say, on a screen that knew the bus to the
              metre. */}
          {!row.arrived_at && row.eta_minutes != null && (
            <Fact
              label="Arrives in about"
              value={`${row.eta_minutes} min`}
              note="At the speed the bus is doing now, in a straight line. Traffic and turns make it longer."
            />
          )}
        </dl>

        <p className="max-w-3xl text-[13.5px] leading-relaxed text-muted-foreground">
          {line(row, staleAfter)}
        </p>
      </div>
    </Card>
  )
}

/* One sentence per state, short — the map screen carries the long version.

   Six states, six sentences, because only two of them mean anything is wrong
   and collapsing "your school has not switched tracking on" into the same
   grey nothing as "the driver's phone has died" sends a parent to ring the
   office about a system working exactly as configured. */
function line(row: ChildBusRow, staleAfter: number): string {
  switch (row.state) {
    case 'not_published':
      return 'Your school does not publish live bus positions to parents, so there is no distance or arrival time on this card. The route, bus and stop above are still today’s.'
    case 'not_running':
      return 'No run is open on this bus right now. Positions exist only while the driver has a trip running; outside those hours the phone reports nothing at all, by design.'
    case 'no_signal':
      return 'The run is open but no position has come through yet — usually the phone still finding satellites, sometimes location permission switched off on it. The transport office sees the same thing.'
    case 'stale':
      return `The last position is over ${minutes(staleAfter)} old (${ageText(row.age_seconds)}), so the distance above is where the bus was, not where it is. A tunnel, a dead patch of network, or a flat phone.`
    case 'arrived':
      return `The bus reached ${row.stop ?? 'the stop'} at ${row.arrived_at}. Nothing further is tracked for this stop on this run.`
    case 'running':
      return row.metres_away != null
        ? `On the way. Position last updated ${ageText(row.age_seconds)}.`
        : `On the way. ${row.stop ?? 'This stop'} has no coordinates recorded, so no distance can be worked out — the transport office can add them.`
  }
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-[12px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
      {note && <p className="mt-0.5 text-[12px] font-normal text-muted-foreground">{note}</p>}
    </div>
  )
}
