import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from './bento-kit'
import { Facts, PersonaCard, PersonaPage, Say, useShape } from './persona-kit'
import { Widget } from './WidgetLayer'
import { inClassic } from './classic-board'
import type { MyBus } from '../operations/DriverRun'

/* THE DRIVER'S DAY.

   The real driver's screen is the Android bus app: the phone is the tracker,
   the pre-trip check and the roll are done there. This board is what a
   driver at a desk, or on a borrowed browser, needs: which bus, which route,
   whether today's check went in, and where the app is. Everything comes from
   one call, `/ops/transport/my-bus`, which finds the bus from the caller's
   own employee row and cannot be pointed at anybody else's. */

function today(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

function DriverDay() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['my-bus'],
    queryFn: () => api.get<MyBus>('/api/v1/ops/transport/my-bus'),
  })
  const toBus = useFeatureHref('driver.transport.my_bus_route')

  if (isLoading) return <BentoLoading message="Finding your bus…" />
  if (error) return <BentoError message={String(error)} />
  const d = data!

  return (
    <PersonaPage eyebrow="Home" title="My run" dashboard="driver_day">
      <Widget id="bus" label="My bus" size="large" index={0}>
        {(span) => <BusCell span={span} d={d} to={toBus} />}
      </Widget>
      <Widget id="stops" label="Stops" size="small" index={1}>
        {(span) => <StopsCell span={span} d={d} to={toBus} />}
      </Widget>
      <Widget id="check" label="Today's check" size="small" index={2}>
        {(span) => <CheckCell span={span} d={d} to={toBus} />}
      </Widget>
      <Widget id="app" label="The bus app" size="small" index={3}>
        {(span) => <AppCell span={span} />}
      </Widget>
    </PersonaPage>
  )
}

function BusCell({ span, d, to }: { span: CellSpan; d: MyBus; to?: string }) {
  const facts = [
    { label: 'Route', value: d.route_name ? `${d.route_name}${d.route_code ? ` · ${d.route_code}` : ''}` : 'Not set' },
    { label: 'Riders', value: String(d.riders) },
    { label: 'Seats', value: d.capacity != null ? String(d.capacity) : '—' },
    { label: 'Attendant', value: d.attendant || '—' },
    { label: 'Papers lapse', value: d.next_expiry || '—' },
  ]
  return (
    <PersonaCard
      span={span}
      ground="operations"
      title="My bus"
      glyph="⛟"
      value={d.registration_no || '—'}
      change={
        d.note ??
        (d.trip_direction
          ? `On the ${d.trip_direction} run since ${d.trip_started_at?.slice(11, 16) ?? ''}`
          : d.tracker_paired
            ? 'Phone paired as the tracker'
            : 'No phone paired yet')
      }
      to={d.note ? undefined : to}
      cueLabel="Open my bus and route"
    >
      {d.note ? <Say>{d.note}</Say> : <Facts items={facts} srLabel="The bus and its route" />}
    </PersonaCard>
  )
}

function StopsCell({ span, d, to }: { span: CellSpan; d: MyBus; to?: string }) {
  const { tall } = useShape()
  const facts = d.stops.slice(0, tall ? 8 : 4).map((s) => ({
    label: s.name,
    value: s.pickup_time ?? s.drop_time ?? '—',
  }))
  return (
    <PersonaCard
      span={span}
      title="Stops"
      glyph="◉"
      value={d.stops.length}
      change={d.stops.length ? `First pickup ${d.stops[0].pickup_time ?? '—'}` : 'No stop on the route'}
      to={d.note ? undefined : to}
      cueLabel="Open my bus and route"
    >
      {facts.length === 0 ? <Say>No stops to show</Say> : <Facts items={facts} srLabel="Stops in order with pickup time" />}
    </PersonaCard>
  )
}

function CheckCell({ span, d, to }: { span: CellSpan; d: MyBus; to?: string }) {
  const day = today()
  const mine = d.checks.filter((c) => c.on_date === day)
  const cleared = mine.length > 0 && mine.every((c) => c.cleared)
  const facts = mine.map((c) => ({
    label: c.leg,
    value: c.cleared ? 'Cleared' : c.failed_items.join(', ') || 'Not cleared',
  }))
  return (
    <PersonaCard
      span={span}
      title="Today's check"
      glyph="✓"
      value={mine.length === 0 ? 'Not yet' : cleared ? 'Cleared' : 'Faults'}
      change={mine.length === 0 ? 'Done from the bus app before the run' : `${mine.length} recorded today`}
      to={d.note ? undefined : to}
      cueLabel="Open my bus and route"
    >
      {facts.length === 0 ? <Say>No pre-trip check recorded today</Say> : <Facts items={facts} srLabel="Pre-trip checks today" />}
    </PersonaCard>
  )
}

function AppCell({ span }: { span: CellSpan }) {
  return (
    <PersonaCard
      span={span}
      title="The bus app"
      glyph="▣"
      value="Android"
      change="Sign in with your phone number and PIN"
      cueLabel="About the bus app"
    >
      <Say>Install the school bus app on your phone. It is the tracker, the pre-trip check and the roll; nothing else is needed.</Say>
    </PersonaCard>
  )
}

export const Classic = inClassic(DriverDay)
export default DriverDay
