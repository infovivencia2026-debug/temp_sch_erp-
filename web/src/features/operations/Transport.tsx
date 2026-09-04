import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { StatusPill } from '@/components/NeedsAttention'
import { useSession } from '@/lib/session'
import { formatPaise, formatDate, cn } from '@/lib/utils'

/* Transport: the fleet, and the runs it makes.
 *
 * Only the vehicle list existed. A bus without its route is a registration
 * number — what the office works with is the run: which stops, in what order,
 * at what time, and how many children board at each.
 *
 * Document expiry leads the fleet table. Insurance, fitness, permit and PUC
 * lapsing is the one thing on this screen that grounds a bus and strands a
 * route, and it is invisible until somebody looks.
 */

interface Route {
  id: string
  name: string
  code?: string
  vehicle?: string
  distance_km?: string
  stops: number
  riders: number
  is_active: boolean
}

interface Stop {
  id: string
  name: string
  sequence: number
  pickup_time?: string
  drop_time?: string
  fare_paise: number
  riders: number
}

interface Vehicle {
  id: string
  registration_no: string
  model?: string
  capacity?: number
  insurance_expiry?: string
  fitness_expiry?: string
  permit_expiry?: string
  puc_expiry?: string
  status?: string
}

/** Days until a document lapses; negative means it already has. */
function daysTo(date?: string) {
  if (!date) return null
  return Math.round((new Date(date).getTime() - Date.now()) / 864e5)
}

function Expiry({ label, date }: { label: string; date?: string }) {
  const d = daysTo(date)
  if (d == null) return <span className="text-muted-foreground">{label} —</span>
  const soon = d <= 45
  return (
    <span className={cn('block text-[12.5px]', soon ? 'font-medium text-destructive' : 'text-muted-foreground')}>
      {label} {formatDate(date)}
      {d < 0 ? ' · expired' : soon ? ` · ${d}d` : ''}
    </span>
  )
}

export default function Transport() {
  const [openRoute, setOpenRoute] = useState<Route | null>(null)

  const routes = useQuery({
    queryKey: ['routes'],
    queryFn: () => api.get<List<Route>>('/api/v1/ops/transport/routes'),
  })
  const vehicles = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api.get<List<Vehicle>>('/api/v1/ops/transport/vehicles'),
  })
  const stops = useQuery({
    queryKey: ['route-stops', openRoute?.id],
    queryFn: () => api.get<List<Stop>>(`/api/v1/ops/transport/routes/${openRoute!.id}/stops`),
    enabled: !!openRoute,
  })

  const rs = routes.data?.items ?? []
  const vs = vehicles.data?.items ?? []
  const riders = rs.reduce((n, r) => n + r.riders, 0)
  const expiring = vs.filter((v) =>
    [v.insurance_expiry, v.fitness_expiry, v.permit_expiry, v.puc_expiry]
      .some((d) => { const x = daysTo(d); return x != null && x <= 45 }),
  ).length

  return (
    <>
      <PageHead
        eyebrow="Operations"
        title="Transport"
        description="Routes, stops and the fleet that runs them."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Routes" value={rs.length} />
          <Stat label="Buses" value={vs.length} />
          <Stat label="Children bussed" value={riders} />
          <Stat
            label="Papers expiring"
            value={expiring}
            hint={expiring ? 'Within 45 days' : 'All current'}
          />
        </CellGrid>

        <Card>
          <CardHeader title="Routes" description="Select a route to see its run" />
          {routes.isLoading ? (
            <SkeletonTable columns={7} />
          ) : routes.error ? (
            <ErrorState error={routes.error} />
          ) : (
            <Table
              head={['Route', 'Code', 'Bus', 'Distance', 'Stops', 'Riders', '']}
              empty={!rs.length}
              emptyLabel="No routes defined."
            >
              {rs.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="font-mono text-[12px] text-muted-foreground">{r.code ?? '—'}</Td>
                  <Td className="font-mono text-[12px]">{r.vehicle ?? 'unassigned'}</Td>
                  <Td className="tabular-nums text-muted-foreground">
                    {r.distance_km ? `${r.distance_km} km` : '—'}
                  </Td>
                  <Td className="tabular-nums">{r.stops}</Td>
                  <Td className="tabular-nums">{r.riders}</Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setOpenRoute(openRoute?.id === r.id ? null : r)}
                    >
                      Stops
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {openRoute && (
          <Card>
            <CardHeader
              title={`${openRoute.name} — the run`}
              description="In order, with pickup and drop times"
              action={<Button variant="ghost" onClick={() => setOpenRoute(null)}>Close</Button>}
            />
            {stops.isLoading ? (
              <SkeletonTable columns={6} />
            ) : !stops.data?.items.length ? (
              <div className="p-6">
                <EmptyState title="No stops on this route" body="Add stops to allocate children to it." />
              </div>
            ) : (
              <Table head={['#', 'Stop', 'Pickup', 'Drop', 'Fare', 'Boarding']}>
                {stops.data.items.map((s) => (
                  <tr key={s.id}>
                    <Td className="tabular-nums text-muted-foreground">{s.sequence}</Td>
                    <Td className="font-medium">{s.name}</Td>
                    <Td className="tabular-nums">{s.pickup_time ?? '—'}</Td>
                    <Td className="tabular-nums">{s.drop_time ?? '—'}</Td>
                    <Td className="tabular-nums">{s.fare_paise ? formatPaise(s.fare_paise) : '—'}</Td>
                    <Td className="tabular-nums">{s.riders}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        <BusTrackers />

        <Card>
          <CardHeader
            title="Fleet"
            description="Insurance, fitness, permit and PUC — anything inside 45 days is flagged"
          />
          {vehicles.isLoading ? (
            <SkeletonTable columns={5} />
          ) : vehicles.error ? (
            <ErrorState error={vehicles.error} />
          ) : (
            <Table
              head={['Registration', 'Model', 'Seats', 'Documents', 'Status']}
              empty={!vs.length}
              emptyLabel="No vehicles on the fleet."
            >
              {vs.map((v) => (
                <tr key={v.id}>
                  <Td className="font-mono text-[13px] font-medium">{v.registration_no}</Td>
                  <Td className="text-muted-foreground">{v.model ?? '—'}</Td>
                  <Td className="tabular-nums">{v.capacity ?? '—'}</Td>
                  <Td>
                    <Expiry label="Insurance" date={v.insurance_expiry} />
                    <Expiry label="Fitness" date={v.fitness_expiry} />
                    <Expiry label="Permit" date={v.permit_expiry} />
                    <Expiry label="PUC" date={v.puc_expiry} />
                  </Td>
                  <Td><StatusPill status={v.status ?? 'active'} /></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}


/* PAIRING A PHONE TO A BUS, ON A SCREEN, AT ANY TIME.

   The code that joins a driver's handset to a vehicle could only be produced
   by calling POST /transport/trackers/pair by hand. Every other half of this
   feature had a screen -- the map, the trips, the policy, the revoke -- and the
   one step a school actually has to perform, on the day a phone is replaced or
   a new bus arrives, had none. So it was done for them by whoever had a
   terminal, which is not a product.

   A code is six digits, single-use and dead in ten minutes, so it is
   shown once with the time it expires and never stored anywhere this screen
   can read it back from. Pressing the button again mints a new one and kills
   the old: that is the recovery path as well as the first-issue path, because
   "it did not work" and "I have lost it" are the same request from the office
   side of the desk.

   AND THE APPROVAL, WHICH IS A DIFFERENT ACT BY A DIFFERENT PERSON. A driver
   who enrols their own phone -- number, PIN, and the plate painted on the bus
   -- produces a row here that holds a real credential and reports nothing. Only
   the principal or a platform administrator can let it in, so the button is
   only rendered for them; anybody else sees what is waiting and who enrolled
   it, which is what lets them go and ask. */
interface TrackerRow {
  vehicle_id: string
  registration_no: string
  route?: string
  driver?: string
  tracker_id?: string
  tracker?: string
  device_model?: string
  last_seen_at?: string
  quiet_seconds?: number
  battery_pct?: number
  location_ok?: boolean
  paused?: boolean
  paired: boolean
  pending: boolean
  enrolled_by?: string
}

interface PairCode {
  pair_code: string
  expires_at: string
  valid_minutes: number
  vehicle: string
}

function BusTrackers() {
  const qc = useQueryClient()
  const session = useSession()
  const roles = session.user?.roles ?? []
  // Only these two may approve, and the server enforces it independently —
  // this hides a button that would 403, it does not decide anything.
  const canApprove = roles.includes('institution_admin') || roles.includes('super_admin')

  const trackers = useQuery({
    queryKey: ['transport-trackers'],
    queryFn: () => api.get<List<TrackerRow>>('/api/v1/transport/trackers'),
  })

  const [code, setCode] = useState<PairCode | null>(null)
  const [failed, setFailed] = useState('')

  const pair = useMutation({
    mutationFn: (v: TrackerRow) =>
      api.post<PairCode>('/api/v1/transport/trackers/pair', {
        vehicle_id: v.vehicle_id,
        name: `Bus ${v.registration_no}`,
      }),
    onSuccess: (c) => { setFailed(''); setCode(c) },
    onError: (e: Error) => { setCode(null); setFailed(e.message) },
  })

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/transport/trackers/${id}/approve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport-trackers'] }),
    onError: (e: Error) => setFailed(e.message),
  })

  const rows = trackers.data?.items ?? []
  const waiting = rows.filter((r) => r.pending).length

  return (
    <Card>
      <CardHeader
        title="Bus trackers"
        description={
          waiting > 0
            ? `${waiting} phone${waiting === 1 ? '' : 's'} registered by a driver and waiting to be let in`
            : "The driver's phone is the GPS unit. Generate a code to pair one, or approve one a driver registered."
        }
      />

      {code && (
        <div className="mb-4 rounded-[10px] border border-primary/40 bg-primary-soft px-4 py-3">
          <p className="text-[12px] uppercase tracking-[0.1em] text-muted-foreground">
            Pairing code for {code.vehicle}
          </p>
          <p className="my-1 font-mono text-[30px] font-semibold tracking-[0.16em] tabular-nums">
            {code.pair_code}
          </p>
          <p className="text-[13px] text-muted-foreground">
            Type it into the app on the driver's phone, with the school server
            address <span className="font-mono">{window.location.origin}</span>.
            It expires in {code.valid_minutes} minutes and works once.
          </p>
        </div>
      )}
      {failed && (
        <p className="mb-4 text-[13px] text-destructive">{failed}</p>
      )}

      {trackers.isLoading ? (
        <SkeletonTable columns={5} />
      ) : trackers.error ? (
        <ErrorState error={trackers.error} />
      ) : (
        <Table
          head={['Bus', 'Phone', 'Last heard', 'State', '']}
          empty={!rows.length}
          emptyLabel="No vehicles on the fleet."
        >
          {rows.map((r) => (
            <tr key={r.vehicle_id}>
              <Td className="font-mono text-[13px] font-medium">
                {r.registration_no}
                {r.route && <span className="ml-2 font-sans text-[12px] text-muted-foreground">{r.route}</span>}
              </Td>
              <Td className="text-muted-foreground">
                {r.tracker ?? '—'}
                {r.enrolled_by && (
                  <span className="block text-[12px]">registered by {r.enrolled_by}</span>
                )}
              </Td>
              <Td className="text-muted-foreground tabular-nums">{r.last_seen_at ?? 'never'}</Td>
              <Td>
                <StatusPill
                  status={
                    r.pending ? 'pending'
                      : !r.paired ? 'not paired'
                      : r.paused ? 'paused'
                      : 'active'
                  }
                />
              </Td>
              <Td className="text-right">
                {r.pending && canApprove && r.tracker_id ? (
                  <Button
                    onClick={() => approve.mutate(r.tracker_id!)}
                    disabled={approve.isPending}
                  >
                    Approve
                  </Button>
                ) : r.pending ? (
                  <span className="text-[12px] text-muted-foreground">
                    the principal approves this
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => pair.mutate(r)}
                    disabled={pair.isPending}
                  >
                    {r.paired ? 'Pair a new phone' : 'Generate code'}
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
