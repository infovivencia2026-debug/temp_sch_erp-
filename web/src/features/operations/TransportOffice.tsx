import { lazy, Suspense, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, Bus, BusFront, Fuel, IdCard, MapPin, QrCode, Route, ShieldCheck, Users,
} from 'lucide-react'
import { ApiError, api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Checkbox, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, SkeletonTable, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'
import { useSession } from '@/lib/session'

/* Lazy: maplibre and its stylesheet are a few hundred kilobytes, and most
   visits to this screen are about fuel or a driver's licence, not a stop's
   coordinates. */
const MapPointPicker = lazy(() => import('@/components/MapPointPicker'))
// qrcode and a canvas, only for the office that actually opens a sticker.
const BusSticker = lazy(() => import('@/components/BusSticker'))

/** A stop's coordinates as a point, or null while either box is empty or junk. */
function pointOf(s: { latitude: string; longitude: string }): { lat: number; lng: number } | null {
  const lat = Number(s.latitude)
  const lng = Number(s.longitude)
  if (!s.latitude.trim() || !s.longitude.trim()) return null
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
}

/* The transport office.

   The product knew which bus ran which route and which child was on it. What
   it could not answer is everything a transport manager is actually asked:
   whose licence expires next month, who got on the bus this morning, what the
   diesel cost, and where the 3:15 has got to.

   Live GPS tracking, geofenced arrival alerts, speeding detection, fuel-tank
   telematics and in-bus CCTV are absent on purpose. Each needs a certified
   device in the vehicle and a vendor feed; a screen that draws a bus on a map
   from no position data would be a lie told convincingly. */

interface Staff {
  id: string
  employee_id: string
  name: string
  role: string
  licence_no?: string
  licence_expiry?: string
  badge_no?: string
  police_verified_on?: string
  medical_expiry?: string
  phone?: string
  vehicle?: string
  days_to_lapse?: number
  lapsed_item?: string
}
interface Allocation {
  id: string
  student_id: string
  full_name: string
  admission_no: string
  class_name?: string
  route?: string
  route_id?: string
  pickup_stop?: string
  pickup_time?: string
  fare_paise?: number
}
interface BusRow {
  student_id: string
  full_name: string
  admission_no: string
  stop?: string
  status: 'boarded' | 'alighted' | 'absent' | 'not_scanned'
  boarded_at?: string
  alighted_at?: string
  still_aboard: boolean
}
interface VLog {
  id: string
  vehicle: string
  vehicle_id: string
  kind: string
  on_date: string
  odometer_km?: number
  litres?: number
  amount_paise: number
  vendor?: string
  next_due_on?: string
  km_per_litre?: number
}
interface Check {
  id: string
  vehicle: string
  route?: string
  on_date: string
  leg: string
  driver?: string
  cleared: boolean
  breathalyser?: number
  failed_items: string[]
  remarks?: string
  checked_by?: string
}
interface Incident {
  id: string
  vehicle?: string
  route?: string
  on_date: string
  leg?: string
  kind: string
  delay_minutes?: number
  description: string
  replacement_vehicle?: string
  parents_informed: boolean
  resolved_at?: string
  resolution?: string
  children_affected: number
}
interface Named {
  id: string
  name?: string
  registration_no?: string
  full_name?: string
  /* What tells two children of the same name apart.

     A roll with three "Rahul Iyer" on it is ordinary, and a picker showing
     only the name asks the office to guess. Guessing here puts a child on a
     bus that does not go to their house, and bills the fare to the wrong
     family. The admission number is what a school already uses to settle it,
     and it is already on every row of the table below. */
  admission_no?: string
}

/** A name, plus whatever makes it unambiguous. */
function pickerLabel(n: Named): string {
  const name = n.full_name ?? n.name ?? n.id
  return n.admission_no ? `${name} · ${n.admission_no}` : name
}
interface Fleet {
  id: string
  registration_no: string
  /* The six digits on the sticker in the cab, issued with the bus. What the
     driver scans or types to say which bus he is in today, because he is not
     on the same one every morning. */
  bus_code?: string
  model?: string
  capacity?: number
  route?: string
  driver?: string
  next_expiry?: string
  status: string
  // The register only ever showed names. The edit form rewrites the whole
  // row, so it also needs the ids and dates it is about to overwrite.
  route_id?: string
  driver_employee_id?: string
  attendant_employee_id?: string
  insurance_expiry?: string
  fitness_expiry?: string
  permit_expiry?: string
  puc_expiry?: string
}

const TABS = [
  ['register', 'Bus register', Users],
  ['buses', 'Buses', Bus],
  ['routes', 'Routes', Route],
  ['checks', 'Safety checks', ShieldCheck],
  ['incidents', 'Delays', AlertTriangle],
  ['staff', 'Drivers', IdCard],
  ['allocation', 'Allocation', BusFront],
  ['logs', 'Fuel & servicing', Fuel],
] as const

const rupees = (p: number) => (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })

export default function TransportOffice() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('register')

  const staff = useQuery({
    queryKey: ['transport-staff'],
    queryFn: () => api.get<List<Staff>>('/api/v1/ops/transport/staff'),
  })
  const incidents = useQuery({
    queryKey: ['transport-incidents'],
    queryFn: () => api.get<List<Incident>>('/api/v1/ops/transport/incidents?period=this_month'),
  })

  if (staff.isLoading) return <SkeletonTiles count={4} label="Opening the transport office…" />
  if (staff.error) return <ErrorState error={staff.error} />

  const lapsing = (staff.data?.items ?? []).filter(
    (s) => s.days_to_lapse == null || s.days_to_lapse < 30,
  )
  const openIncidents = (incidents.data?.items ?? []).filter((i) => !i.resolved_at)

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title="The bus office"
        description="Who is driving, who is on board, what it cost to run and what went wrong today."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Drivers & attendants" value={staff.data?.items.length ?? 0} icon={IdCard} />
          <Stat
            label="Papers lapsing"
            value={lapsing.length}
            icon={AlertTriangle}
            delta={
              lapsing.length
                ? { value: 'Licence, medical or police check', positive: false }
                : { value: 'All current', positive: true }
            }
          />
          <Stat label="Open incidents" value={openIncidents.length} icon={BusFront} />
          <Stat label="This month" value={incidents.data?.items.length ?? 0} />
        </CellGrid>

        <div className="flex flex-wrap gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              aria-current={tab === k}
              className={
                tab === k
                  ? '-mb-px flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                  : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'
              }
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {tab === 'register' && <BusRegister />}
        {tab === 'buses' && <Buses />}
        {tab === 'routes' && <Routes />}
        {tab === 'checks' && <SafetyChecks />}
        {tab === 'incidents' && <Incidents rows={incidents.data?.items ?? []} />}
        {tab === 'staff' && <Drivers rows={staff.data?.items ?? []} />}
        {tab === 'allocation' && <Allocations />}
        {tab === 'logs' && <Logs />}
      </PageBody>
    </>
  )
}

function useRoutes() {
  return useQuery({
    queryKey: ['transport-routes'],
    queryFn: () => api.get<List<Named>>('/api/v1/ops/transport/routes'),
  })
}
function useVehicles() {
  return useQuery({
    queryKey: ['transport-vehicles'],
    queryFn: () => api.get<List<Named>>('/api/v1/ops/transport/vehicles'),
  })
}

function BusRegister() {
  const qc = useQueryClient()
  const routes = useRoutes()
  const [routeId, setRouteId] = useState('')
  const [leg, setLeg] = useState('morning')

  const reg = useQuery({
    queryKey: ['bus-register', routeId, leg],
    queryFn: () =>
      api.get<List<BusRow>>(
        `/api/v1/ops/transport/attendance?leg=${leg}${routeId ? `&route_id=${routeId}` : ''}`,
      ),
  })
  const mark = useMutation({
    mutationFn: (v: { student_id: string; status: string }) =>
      api.post('/api/v1/ops/transport/attendance', { ...v, leg, route_id: routeId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bus-register'] }),
  })

  const rows = reg.data?.items ?? []
  const aboard = rows.filter((r) => r.still_aboard)
  const unscanned = rows.filter((r) => r.status === 'not_scanned')

  return (
    <>
      <Card>
        <CardHeader
          title="Today's run"
          description="Built from the allocation, so a child nobody scanned shows as not scanned rather than not appearing. A register that silently omits the missing child is the failure worth designing against."
          action={
            <div className="flex gap-2">
              <Select
                value={leg}
                onChange={setLeg}
                options={[
                  { value: 'morning', label: 'Morning' },
                  { value: 'afternoon', label: 'Afternoon' },
                ]}
              />
              <Select
                value={routeId}
                onChange={setRouteId}
                placeholder="All routes"
                options={(routes.data?.items ?? []).map((r) => ({
                  value: r.id,
                  label: r.name ?? r.id,
                }))}
              />
            </div>
          }
        />
        {aboard.length > 0 && (
          <div className="border-b bg-destructive/5 px-4 py-3">
            <p className="text-[13px] font-medium text-destructive">
              {aboard.length} still on the bus — boarded and never seen to get off
            </p>
            <p className="text-[13px] text-muted-foreground">
              {aboard.map((a) => a.full_name).join(', ')}
            </p>
          </div>
        )}
        {reg.isLoading ? (
          <SkeletonTable columns={7} label="Loading the register…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nobody allocated to this route"
            body="Assign children to a route and stop on the Allocation tab."
          />
        ) : (
          <Table
            head={[
              { label: 'Child' },
              { label: 'Stop' },
              { label: 'On' },
              { label: 'Off' },
              { label: 'Status' },
              { label: '' },
            ]}
          >
            {rows.map((r) => (
              <tr key={r.student_id}>
                <Td className="font-medium">
                  {r.full_name}
                  <div className="text-[12px] font-normal text-muted-foreground">
                    {r.admission_no}
                  </div>
                </Td>
                <Td className="text-muted-foreground">{r.stop ?? '—'}</Td>
                <Td className="tabular-nums text-muted-foreground">{r.boarded_at ?? '—'}</Td>
                <Td className="tabular-nums text-muted-foreground">{r.alighted_at ?? '—'}</Td>
                <Td>
                  <Badge
                    tone={
                      r.still_aboard
                        ? 'danger'
                        : r.status === 'alighted'
                          ? 'success'
                          : r.status === 'absent'
                            ? 'neutral'
                            : 'warning'
                    }
                  >
                    {r.still_aboard ? 'Still aboard' : r.status.replace('_', ' ')}
                  </Badge>
                </Td>
                <Td>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={mark.isPending}
                      onClick={() => mark.mutate({ student_id: r.student_id, status: 'boarded' })}
                    >
                      On
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={mark.isPending}
                      onClick={() => mark.mutate({ student_id: r.student_id, status: 'alighted' })}
                    >
                      Off
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={mark.isPending}
                      onClick={() => mark.mutate({ student_id: r.student_id, status: 'absent' })}
                    >
                      Absent
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <FormNotice error={mark.error} />
      </Card>
      {unscanned.length > 0 && (
        <Card>
          <CardHeader
            title="Not scanned"
            description="Allocated to this run and unaccounted for. Worth a phone call before the bus leaves."
          />
          <p className="px-4 pb-4 text-[13px] text-muted-foreground">
            {unscanned.map((u) => u.full_name).join(', ')}
          </p>
        </Card>
      )}
    </>
  )
}

function SafetyChecks() {
  const qc = useQueryClient()
  const vehicles = useVehicles()
  const routes = useRoutes()
  const [vehicleId, setVehicleId] = useState('')
  const [routeId, setRouteId] = useState('')
  const [leg, setLeg] = useState('morning')
  const [items, setItems] = useState({
    brakes_ok: false,
    tyres_ok: false,
    lights_ok: false,
    first_aid_ok: false,
    extinguisher_ok: false,
    doors_ok: false,
  })
  const [breath, setBreath] = useState('0')
  const [remarks, setRemarks] = useState('')

  const list = useQuery({
    queryKey: ['trip-checks'],
    queryFn: () => api.get<List<Check>>('/api/v1/ops/transport/checks'),
  })
  const save = useMutation({
    mutationFn: () =>
      api.post<{ cleared: boolean }>('/api/v1/ops/transport/checks', {
        vehicle_id: vehicleId,
        route_id: routeId,
        leg,
        ...items,
        breathalyser: Number(breath),
        remarks,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trip-checks'] }),
  })

  const wouldClear =
    Object.values(items).every(Boolean) && Number(breath) === 0

  return (
    <>
      <Card>
        <CardHeader
          title="Before the bus moves"
          description="Cleared is worked out from the answers, never ticked. A screen that lets someone clear a bus over a failed brake check is not a safety record — and this is the one row here a court would read."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Vehicle" required>
              <Select
                value={vehicleId}
                onChange={setVehicleId}
                placeholder="Choose a bus"
                options={(vehicles.data?.items ?? []).map((v) => ({
                  value: v.id,
                  label: v.registration_no ?? v.id,
                }))}
              />
            </Field>
            <Field label="Route">
              <Select
                value={routeId}
                onChange={setRouteId}
                placeholder="Optional"
                options={(routes.data?.items ?? []).map((r) => ({
                  value: r.id,
                  label: r.name ?? r.id,
                }))}
              />
            </Field>
            <Field label="Leg">
              <Select
                value={leg}
                onChange={setLeg}
                options={[
                  { value: 'morning', label: 'Morning' },
                  { value: 'afternoon', label: 'Afternoon' },
                ]}
              />
            </Field>
            <Field label="Breathalyser" hint="Recorded as a reading, not a pass mark.">
              <Input value={breath} onChange={setBreath} type="number" />
            </Field>
          </FormGrid>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {(
              [
                ['brakes_ok', 'Brakes'],
                ['tyres_ok', 'Tyres'],
                ['lights_ok', 'Lights & indicators'],
                ['first_aid_ok', 'First-aid box'],
                ['extinguisher_ok', 'Fire extinguisher'],
                ['doors_ok', 'Doors & emergency exit'],
              ] as const
            ).map(([k, label]) => (
              <Checkbox
                key={k}
                checked={items[k]}
                onChange={(v) => setItems({ ...items, [k]: v })}
                label={label}
              />
            ))}
          </div>
          <div className="mt-4">
            <Field label="Remarks">
              <Input value={remarks} onChange={setRemarks} placeholder="Anything the driver reported" />
            </Field>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button disabled={save.isPending || !vehicleId} onClick={() => save.mutate()}>
              {save.isPending ? 'Recording…' : 'Record check'}
            </Button>
            <Badge tone={wouldClear ? 'success' : 'danger'}>
              {wouldClear ? 'Would clear' : 'Would not clear'}
            </Badge>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Last fortnight" description="Every check signed, and what failed where it did." />
        {(list.data?.items ?? []).length === 0 ? (
          <EmptyState title="No checks recorded" body="Each bus is checked before each leg." />
        ) : (
          <Table
            head={[
              { label: 'Date' },
              { label: 'Bus' },
              { label: 'Leg' },
              { label: 'Cleared' },
              { label: 'Failed' },
              { label: 'Signed by' },
            ]}
          >
            {(list.data?.items ?? []).map((c) => (
              <tr key={c.id}>
                <Td className="text-muted-foreground">{formatDate(c.on_date)}</Td>
                <Td className="font-medium">{c.vehicle}</Td>
                <Td className="text-muted-foreground">{c.leg}</Td>
                <Td>
                  <Badge tone={c.cleared ? 'success' : 'danger'}>{c.cleared ? 'Yes' : 'No'}</Badge>
                </Td>
                <Td className="text-muted-foreground">
                  {c.failed_items.length ? c.failed_items.join(', ') : '—'}
                  {c.remarks && <div className="text-[12px]">{c.remarks}</div>}
                </Td>
                <Td className="text-muted-foreground">{c.checked_by ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

function Incidents({ rows }: { rows: Incident[] }) {
  const qc = useQueryClient()
  const vehicles = useVehicles()
  const routes = useRoutes()
  const [kind, setKind] = useState('delay')
  const [routeId, setRouteId] = useState('')
  const [vehicleId, setVehicleId] = useState('')
  const [delay, setDelay] = useState('')
  const [description, setDescription] = useState('')
  const [replacement, setReplacement] = useState('')
  const [informed, setInformed] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [resolution, setResolution] = useState('')

  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post('/api/v1/ops/transport/incidents', v),
    onSuccess: () => {
      setDescription('')
      setClosing(null)
      qc.invalidateQueries({ queryKey: ['transport-incidents'] })
    },
  })

  return (
    <>
      <Card>
        <CardHeader
          title="Report a delay or breakdown"
          description="Naming the replacement bus is what makes this a dispatch record rather than a note."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="What happened">
              <Select
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'delay', label: 'Running late' },
                  { value: 'breakdown', label: 'Breakdown' },
                  { value: 'diversion', label: 'Diversion' },
                  { value: 'accident', label: 'Accident' },
                  { value: 'other', label: 'Other' },
                ]}
              />
            </Field>
            <Field label="Route">
              <Select
                value={routeId}
                onChange={setRouteId}
                placeholder="Choose a route"
                options={(routes.data?.items ?? []).map((r) => ({ value: r.id, label: r.name ?? r.id }))}
              />
            </Field>
            <Field label="Bus">
              <Select
                value={vehicleId}
                onChange={setVehicleId}
                placeholder="Choose a bus"
                options={(vehicles.data?.items ?? []).map((v) => ({
                  value: v.id,
                  label: v.registration_no ?? v.id,
                }))}
              />
            </Field>
            <Field label="Delay in minutes">
              <Input value={delay} onChange={setDelay} type="number" placeholder="20" />
            </Field>
            <Field label="Replacement bus">
              <Select
                value={replacement}
                onChange={setReplacement}
                placeholder="None sent"
                options={(vehicles.data?.items ?? []).map((v) => ({
                  value: v.id,
                  label: v.registration_no ?? v.id,
                }))}
              />
            </Field>
            <Field label="Details" wide required>
              <Textarea
                rows={2}
                value={description}
                onChange={setDescription}
                placeholder="Clutch cable snapped at Suchitra Circle."
              />
            </Field>
          </FormGrid>
          <div className="mt-3">
            <Checkbox checked={informed} onChange={setInformed} label="Parents have been told" />
          </div>
          <div className="mt-4">
            <Button
              disabled={save.isPending || description.trim() === ''}
              onClick={() =>
                save.mutate({
                  kind,
                  route_id: routeId,
                  vehicle_id: vehicleId,
                  delay_minutes: delay ? Number(delay) : undefined,
                  description,
                  replacement_vehicle_id: replacement,
                  parents_informed: informed,
                })
              }
            >
              {save.isPending ? 'Reporting…' : 'Report'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader title="This month" description="Open first. The child count is the size of the phone call." />
        {rows.length === 0 ? (
          <EmptyState title="Nothing went wrong" body="Delays and breakdowns appear here." />
        ) : (
          <ul className="divide-y">
            {rows.map((i) => (
              <li key={i.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-[16rem] flex-1">
                    <div className="font-medium">
                      {i.route ?? 'Unassigned route'}
                      {i.vehicle && <span className="text-muted-foreground"> · {i.vehicle}</span>}
                    </div>
                    <div className="text-[13px] text-muted-foreground">{i.description}</div>
                    <div className="text-[12px] text-muted-foreground">
                      {formatDate(i.on_date)}
                      {i.delay_minutes ? ` · ${i.delay_minutes} min late` : ''}
                      {` · ${i.children_affected} children`}
                      {i.replacement_vehicle && ` · replaced by ${i.replacement_vehicle}`}
                    </div>
                    {i.resolution && (
                      <div className="text-[12px] text-success">{i.resolution}</div>
                    )}
                  </div>
                  <Badge tone={i.parents_informed ? 'success' : 'warning'}>
                    {i.parents_informed ? 'Parents told' : 'Parents not told'}
                  </Badge>
                  <Badge tone={i.resolved_at ? 'neutral' : 'danger'}>
                    {i.resolved_at ? 'Closed' : 'Open'}
                  </Badge>
                  {!i.resolved_at && (
                    <Button size="sm" onClick={() => { setClosing(i.id); setResolution('') }}>
                      Close
                    </Button>
                  )}
                </div>
                {closing === i.id && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Input
                      value={resolution}
                      onChange={setResolution}
                      placeholder="How it ended"
                      className="min-w-[18rem] flex-1"
                    />
                    <Button
                      disabled={save.isPending || resolution.trim() === ''}
                      onClick={() => save.mutate({ id: i.id, resolution, parents_informed: true })}
                    >
                      Save
                    </Button>
                    <Button variant="ghost" onClick={() => setClosing(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}

function Drivers({ rows }: { rows: Staff[] }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({ role: 'driver' })

  const employees = useQuery({
    // Not /hr/employees: that sits behind EmployeesRead, which neither the
    // transport manager nor operations staff hold, so it answered 403 and the
    // dropdown rendered empty for exactly the people who need it.
    queryKey: ['transport-assignable-staff'],
    queryFn: () => api.get<List<Named>>('/api/v1/ops/transport/assignable-staff'),
  })
  const save = useMutation({
    mutationFn: () => api.post('/api/v1/ops/transport/staff', form),
    onSuccess: () => {
      setOpen(false)
      qc.invalidateQueries({ queryKey: ['transport-staff'] })
    },
  })

  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })

  return (
    <>
      <Card>
        <CardHeader
          title="Drivers and attendants"
          description="Kept apart from the staff record because these facts belong to the job: a teacher has no licence expiry. Everything here is what a transport inspection asks for."
          action={
            <Button variant="secondary" onClick={() => setOpen(!open)}>
              {open ? 'Close' : 'Add or update'}
            </Button>
          }
        />
        {open && (
          <div className="border-b p-4">
            <FormGrid>
              <Field label="Staff member" required>
                <Select
                  value={form.employee_id ?? ''}
                  onChange={set('employee_id')}
                  placeholder="Choose"
                  options={(employees.data?.items ?? []).map((e) => ({
                    value: e.id,
                    label: e.full_name ?? e.name ?? e.id,
                  }))}
                />
              </Field>
              <Field label="Role">
                <Select
                  value={form.role ?? 'driver'}
                  onChange={set('role')}
                  options={[
                    { value: 'driver', label: 'Driver' },
                    { value: 'attendant', label: 'Attendant' },
                    { value: 'cleaner', label: 'Cleaner' },
                  ]}
                />
              </Field>
              <Field label="Licence number">
                <Input value={form.licence_no ?? ''} onChange={set('licence_no')} placeholder="TS09 2019 0012345" />
              </Field>
              <Field label="Licence expiry" hint="Required once a licence number is entered.">
                <Input type="date" value={form.licence_expiry ?? ''} onChange={set('licence_expiry')} />
              </Field>
              <Field label="Badge number">
                <Input value={form.badge_no ?? ''} onChange={set('badge_no')} />
              </Field>
              <Field label="Police verified on" hint="The date, not a tick — a tick proves nothing.">
                <Input type="date" value={form.police_verified_on ?? ''} onChange={set('police_verified_on')} />
              </Field>
              <Field label="Medical expiry">
                <Input type="date" value={form.medical_expiry ?? ''} onChange={set('medical_expiry')} />
              </Field>
              <Field label="Phone">
                <Input value={form.phone ?? ''} onChange={set('phone')} />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <Button disabled={save.isPending || !form.employee_id} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
            <FormNotice error={save.error} />
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyState title="Nobody recorded" body="Add the drivers and attendants who carry children." />
        ) : (
          <Table
            head={[
              { label: 'Name' },
              { label: 'Role' },
              { label: 'Bus' },
              { label: 'Licence' },
              { label: 'Police check' },
              { label: 'Next lapse' },
              { label: 'Sign-in' },
            ]}
          >
            {rows.map((s) => (
              <tr key={s.id}>
                <Td className="font-medium">
                  {s.name}
                  {s.phone && (
                    <div className="text-[12px] font-normal text-muted-foreground">{s.phone}</div>
                  )}
                </Td>
                <Td className="text-muted-foreground">{s.role}</Td>
                <Td className="text-muted-foreground">{s.vehicle ?? '—'}</Td>
                <Td className="text-muted-foreground">
                  {s.licence_no ?? '—'}
                  {s.licence_expiry && (
                    <div className="text-[12px]">to {formatDate(s.licence_expiry)}</div>
                  )}
                </Td>
                <Td className="text-muted-foreground">
                  {s.police_verified_on ? formatDate(s.police_verified_on) : 'Never'}
                </Td>
                <Td>
                  {s.days_to_lapse == null ? (
                    <Badge tone="danger">Nothing on file</Badge>
                  ) : s.days_to_lapse < 0 ? (
                    <Badge tone="danger">{s.lapsed_item} expired</Badge>
                  ) : s.days_to_lapse < 30 ? (
                    <Badge tone="warning">
                      {s.lapsed_item} in {s.days_to_lapse}d
                    </Badge>
                  ) : (
                    <span className={cn('text-[13px] text-muted-foreground')}>
                      {s.lapsed_item} in {s.days_to_lapse}d
                    </span>
                  )}
                </Td>
                <Td>
                  <DriverSignIn staff={s} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

/* WHAT THE DRIVER TYPES INTO THE HANDSET.

   This table knew everything about a driver except the one thing the office is
   asked for at six in the morning: what he signs in with. The endpoint to issue
   a PIN has existed all along and no screen called it, so the answer was "ring
   somebody who can open the staff record".

   The number is the sign-in name — bus_driver_signin.go matches phone, email or
   username — so it is shown as such rather than as another contact detail. A
   driver with no number cannot be issued one at all, and says so here rather
   than failing when the button is pressed.

   Shown once, like every other credential in this product: nothing can read a
   PIN back out, so it stays on screen until dismissed rather than flashing
   past. */
function DriverSignIn({ staff }: { staff: Staff }) {
  const [pin, setPin] = useState<string | null>(null)
  const issue = useMutation({
    mutationFn: () =>
      api.post<{ pin: string }>(`/api/v1/setup/employees/${staff.employee_id}/pin`, {}),
    onSuccess: (res) => setPin(res.pin),
  })

  if (!staff.phone) {
    return (
      <span className="text-[13px] text-muted-foreground">
        No mobile on record
      </span>
    )
  }

  return (
    <div className="space-y-1">
      <div className="font-mono text-[13px]">{staff.phone}</div>
      {pin ? (
        <div className="text-[13px]">
          PIN <span className="font-mono font-semibold">{pin}</span>
          <button
            type="button"
            onClick={() => setPin(null)}
            className="ml-2 text-[12px] text-muted-foreground underline underline-offset-2"
          >
            done
          </button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={issue.isPending}
          onClick={() => issue.mutate()}
        >
          {issue.isPending ? 'Issuing…' : 'Issue PIN'}
        </Button>
      )}
      {issue.error && (
        <div className="text-[12px] text-destructive">
          {issue.error instanceof Error ? issue.error.message : 'Could not issue a PIN'}
        </div>
      )}
    </div>
  )
}

function Allocations() {
  const qc = useQueryClient()
  const routes = useRoutes()
  const [studentId, setStudentId] = useState('')
  const [routeId, setRouteId] = useState('')
  const [stopId, setStopId] = useState('')

  const list = useQuery({
    queryKey: ['transport-allocations'],
    queryFn: () => api.get<List<Allocation>>('/api/v1/ops/transport/allocations'),
  })
  const students = useQuery({
    queryKey: ['students', 'for-transport'],
    queryFn: () => api.get<List<Named>>('/api/v1/students?limit=400'),
  })
  const stops = useQuery({
    queryKey: ['route-stops', routeId],
    queryFn: () =>
      api.get<List<{ id: string; name: string; fare_paise: number; pickup_time?: string }>>(
        `/api/v1/ops/transport/routes/${routeId}/stops`,
      ),
    enabled: !!routeId,
  })
  const save = useMutation({
    mutationFn: () =>
      api.post<{ fare_paise: number }>('/api/v1/ops/transport/allocations', {
        student_id: studentId,
        route_id: routeId,
        pickup_stop_id: stopId,
      }),
    onSuccess: () => {
      setStudentId('')
      qc.invalidateQueries({ queryKey: ['transport-allocations'] })
    },
  })

  const chosen = (stops.data?.items ?? []).find((s) => s.id === stopId)
  const rows = list.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="Put a child on a route"
          description="The fare follows the stop rather than being typed, because a transport fee that disagrees with the stop it came from is an argument at the counter every August. Moving a child closes the old allocation instead of deleting it — the fee already raised has to stay explicable."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Child" required>
              <Select
                value={studentId}
                onChange={setStudentId}
                placeholder="Choose a child"
                options={(students.data?.items ?? []).map((s) => ({
                  value: s.id,
                  label: pickerLabel(s),
                }))}
              />
            </Field>
            <Field label="Route" required>
              <Select
                value={routeId}
                onChange={(v) => {
                  setRouteId(v)
                  setStopId('')
                }}
                placeholder="Choose a route"
                options={(routes.data?.items ?? []).map((r) => ({ value: r.id, label: r.name ?? r.id }))}
              />
            </Field>
            <Field label="Stop" required>
              <Select
                value={stopId}
                onChange={setStopId}
                placeholder={routeId ? 'Choose a stop' : 'Pick a route first'}
                options={(stops.data?.items ?? []).map((s) => ({
                  value: s.id,
                  label: `${s.name}${s.pickup_time ? ` · ${s.pickup_time}` : ''}`,
                }))}
              />
            </Field>
            <Field label="Fare this implies">
              <div className="flex h-9 items-center text-[14px] tabular-nums">
                {chosen ? `₹${rupees(chosen.fare_paise)}` : '—'}
              </div>
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button
              disabled={save.isPending || !studentId || !routeId || !stopId}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Allocate'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Who rides what" description="Current allocations, in stop order along each route." />
        {rows.length === 0 ? (
          <EmptyState title="Nobody allocated" body="Put children on routes above." />
        ) : (
          <Table
            head={[
              { label: 'Child' },
              { label: 'Class' },
              { label: 'Route' },
              { label: 'Stop' },
              { label: 'Pick-up' },
              { label: 'Fare' },
            ]}
          >
            {rows.map((a) => (
              <tr key={a.id}>
                <Td className="font-medium">
                  {a.full_name}
                  <div className="text-[12px] font-normal text-muted-foreground">
                    {a.admission_no}
                  </div>
                </Td>
                <Td className="text-muted-foreground">{a.class_name ?? '—'}</Td>
                <Td>{a.route ?? '—'}</Td>
                <Td className="text-muted-foreground">{a.pickup_stop ?? '—'}</Td>
                <Td className="tabular-nums text-muted-foreground">{a.pickup_time ?? '—'}</Td>
                <Td className="tabular-nums">
                  {a.fare_paise ? `₹${rupees(a.fare_paise)}` : '—'}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

function Logs() {
  const qc = useQueryClient()
  const vehicles = useVehicles()
  const [form, setForm] = useState<Record<string, string>>({ kind: 'fuel' })

  const list = useQuery({
    queryKey: ['vehicle-logs'],
    queryFn: () => api.get<List<VLog>>('/api/v1/ops/transport/logs?period=this_year'),
  })
  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/ops/transport/logs', {
        vehicle_id: form.vehicle_id,
        kind: form.kind,
        on_date: form.on_date,
        odometer_km: form.odometer_km ? Number(form.odometer_km) : undefined,
        litres: form.litres ? Number(form.litres) : undefined,
        amount_paise: Math.round(Number(form.amount || 0) * 100),
        vendor: form.vendor,
        next_due_on: form.next_due_on,
      }),
    onSuccess: () => {
      setForm({ kind: form.kind, vehicle_id: form.vehicle_id })
      qc.invalidateQueries({ queryKey: ['vehicle-logs'] })
    },
  })

  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })
  const rows = list.data?.items ?? []
  const spend = rows.reduce((n, r) => n + r.amount_paise, 0)
  const mileages = rows.filter((r) => r.km_per_litre).map((r) => r.km_per_litre!)
  const avg = mileages.length ? mileages.reduce((a, b) => a + b, 0) / mileages.length : null

  return (
    <>
      <CellGrid cols={3}>
        <Stat label="Spent this year" value={`₹${rupees(spend)}`} icon={Fuel} />
        <Stat label="Average mileage" value={avg ? `${avg.toFixed(1)} km/l` : '—'} />
        <Stat label="Entries" value={rows.length} />
      </CellGrid>

      <Card>
        <CardHeader
          title="Record fuel, servicing or a repair"
          description="One table for all three, because the number a school governs by is cost per kilometre per vehicle, and that needs them together."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Vehicle" required>
              <Select
                value={form.vehicle_id ?? ''}
                onChange={set('vehicle_id')}
                placeholder="Choose a bus"
                options={(vehicles.data?.items ?? []).map((v) => ({
                  value: v.id,
                  label: v.registration_no ?? v.id,
                }))}
              />
            </Field>
            <Field label="Kind">
              <Select
                value={form.kind ?? 'fuel'}
                onChange={set('kind')}
                options={[
                  { value: 'fuel', label: 'Fuel' },
                  { value: 'service', label: 'Service' },
                  { value: 'repair', label: 'Repair' },
                  { value: 'tyre', label: 'Tyres' },
                  { value: 'insurance', label: 'Insurance' },
                  { value: 'other', label: 'Other' },
                ]}
              />
            </Field>
            <Field label="Date">
              <Input type="date" value={form.on_date ?? ''} onChange={set('on_date')} />
            </Field>
            <Field label="Odometer (km)" hint="A reading lower than an earlier one is refused.">
              <Input value={form.odometer_km ?? ''} onChange={set('odometer_km')} type="number" />
            </Field>
            {form.kind === 'fuel' && (
              <Field label="Litres" required>
                <Input value={form.litres ?? ''} onChange={set('litres')} type="number" />
              </Field>
            )}
            <Field label="Amount (₹)">
              <Input value={form.amount ?? ''} onChange={set('amount')} type="number" />
            </Field>
            <Field label="Vendor">
              <Input value={form.vendor ?? ''} onChange={set('vendor')} placeholder="HP Kompally" />
            </Field>
            <Field label="Next due">
              <Input type="date" value={form.next_due_on ?? ''} onChange={set('next_due_on')} />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button disabled={save.isPending || !form.vehicle_id} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Record'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader title="This year" description="Mileage is worked out from consecutive odometer readings, not trusted from a form." />
        {rows.length === 0 ? (
          <EmptyState title="Nothing recorded" body="Fuel and servicing entries appear here." />
        ) : (
          <Table
            head={[
              { label: 'Date' },
              { label: 'Bus' },
              { label: 'Kind' },
              { label: 'Odometer' },
              { label: 'Litres' },
              { label: 'Mileage' },
              { label: 'Amount' },
            ]}
          >
            {rows.map((l) => (
              <tr key={l.id}>
                <Td className="text-muted-foreground">{formatDate(l.on_date)}</Td>
                <Td className="font-medium">{l.vehicle}</Td>
                <Td className="text-muted-foreground">
                  {l.kind}
                  {l.vendor && <div className="text-[12px]">{l.vendor}</div>}
                </Td>
                <Td className="tabular-nums text-muted-foreground">
                  {l.odometer_km?.toLocaleString('en-IN') ?? '—'}
                </Td>
                <Td className="tabular-nums text-muted-foreground">{l.litres ?? '—'}</Td>
                <Td className="tabular-nums">
                  {l.km_per_litre ? `${l.km_per_litre} km/l` : '—'}
                </Td>
                <Td className="tabular-nums">₹{rupees(l.amount_paise)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

/* THE FLEET ITSELF, WHICH NOTHING COULD EDIT.

   Buses could be read and never written. A bus arrived, or a driver changed,
   and the only way to record it was a seed script, so the driver on file was
   whoever the demo data said it was. That matters beyond tidiness: the bus
   tracker signs a driver in against the bus they are recorded on, so a bus
   with no driver is a phone that cannot start a trip, however well the rest of
   transport is set up. Those rows are marked here rather than left to be
   noticed. */

function busError(e: unknown) {
  if (e instanceof ApiError) {
    if (e.code === 'duplicate_registration')
      return 'A bus with that registration is already on the fleet. It may be recorded as retired or under maintenance.'
    if (e.code === 'driver_assigned') return e.message
    return e.message
  }
  if (e instanceof Error) return e.message
  return null
}

const BLANK: Record<string, string> = {
  registration_no: '', model: '', capacity: '40', status: 'active',
  driver_employee_id: '', attendant_employee_id: '',
  insurance_expiry: '', fitness_expiry: '', permit_expiry: '', puc_expiry: '',
  route_id: '',
}

interface RouteRow {
  id: string
  name: string
  code?: string
  vehicle?: string
  distance_km?: string
  stops: number
  riders: number
  is_active: boolean
}
interface StopRow {
  id: string
  name: string
  sequence: number
  pickup_time?: string
  drop_time?: string
  latitude?: string
  longitude?: string
  fare_paise: number
  geofence_m?: number
  riders: number
}
interface StopForm {
  name: string
  pickup_time: string
  drop_time: string
  latitude: string
  longitude: string
  /* How near the bus has to be for the school to call it arrived. Blank means
     the school-wide default, which is what every stop in the product used to
     be stuck with: there was nowhere to widen the circle for the one stop on a
     dual carriageway where the bus pulls in fifty metres past the shelter. */
  geofence_m: string
}

const BLANK_STOP: StopForm = {
  name: '', pickup_time: '', drop_time: '', latitude: '', longitude: '', geofence_m: '',
}
const BLANK_ROUTE = { name: '', code: '', vehicle_id: '', distance_km: '' }

function Routes() {
  const qc = useQueryClient()
  const vehicles = useVehicles()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState({ ...BLANK_ROUTE })
  const [stops, setStops] = useState<StopForm[]>([{ ...BLANK_STOP }])
  // Which stop's map is open, if any. One at a time: two maplibre canvases in
  // one form is a scroll position nobody can hold on to.
  const [picking, setPicking] = useState<number | null>(null)

  const list = useQuery({
    queryKey: ['transport-routes'],
    queryFn: () => api.get<List<RouteRow>>('/api/v1/ops/transport/routes'),
  })

  const close = () => {
    setOpen(false)
    setEditing(null)
    setForm({ ...BLANK_ROUTE })
    setStops([{ ...BLANK_STOP }])
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        code: form.code.trim(),
        vehicle_id: form.vehicle_id,
        distance_km: form.distance_km.trim(),
        /* Sent in array order and with no sequence number of our own: the
           server numbers the run from the order it receives, so dragging a
           stop up here is the whole of reordering the run. Blank rows are
           dropped so the always-present empty row at the bottom of the
           editor does not become a nameless stop on the driver's screen. */
        stops: stops
          .filter((s) => s.name.trim() !== '')
          .map((s) => ({
            name: s.name.trim(),
            sequence: 0,
            pickup_time: s.pickup_time,
            drop_time: s.drop_time,
            latitude: s.latitude.trim(),
            longitude: s.longitude.trim(),
            // Absent, not zero, when the office left it blank: a zero radius
            // is a stop the bus can never be said to have reached.
            geofence_m: s.geofence_m.trim() === '' ? undefined : Number(s.geofence_m),
          })),
      }
      return editing
        ? api.put<{ id: string }>(`/api/v1/ops/transport/routes/${editing}`, body)
        : api.post<{ id: string }>('/api/v1/ops/transport/routes', body)
    },
    onSuccess: (saved) => {
      close()
      qc.invalidateQueries({ queryKey: ['transport-routes'] })
      qc.invalidateQueries({ queryKey: ['transport-vehicles'] })
      // The stop list is cached per route and was just replaced wholesale, so
      // the allocation screen would keep offering stops that no longer exist.
      qc.invalidateQueries({ queryKey: ['route-stops', saved.id] })
    },
  })

  const retire = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/ops/transport/routes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport-routes'] }),
  })

  const set = (k: keyof typeof BLANK_ROUTE) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const setStop = (i: number, k: keyof StopForm) => (v: string) =>
    setStops((list) => list.map((s, n) => (n === i ? { ...s, [k]: v } : s)))
  const moveStop = (i: number, by: number) =>
    setStops((list) => {
      const to = i + by
      if (to < 0 || to >= list.length) return list
      const next = [...list]
      const [row] = next.splice(i, 1)
      next.splice(to, 0, row)
      return next
    })

  const busOptions = (vehicles.data?.items ?? []).map((v) => ({
    value: v.id,
    label: v.registration_no ?? v.name ?? v.id,
  }))

  const edit = async (r: RouteRow) => {
    setEditing(r.id)
    setOpen(true)
    save.reset()
    /* The routes list names the bus by its registration, not its id, so the
       bus is matched back by the plate the list printed. Without this the
       form saved a route with a blank vehicle_id and quietly took the bus off
       a route that was only being renamed. */
    const bus = (vehicles.data?.items ?? []).find((v) => v.registration_no === r.vehicle)
    setForm({
      name: r.name,
      code: r.code ?? '',
      vehicle_id: bus?.id ?? '',
      distance_km: r.distance_km ?? '',
    })
    setStops([{ ...BLANK_STOP }])
    const existing = await qc.fetchQuery({
      queryKey: ['route-stops', r.id],
      queryFn: () => api.get<List<StopRow>>(`/api/v1/ops/transport/routes/${r.id}/stops`),
    })
    setStops([
      ...existing.items.map((s) => ({
        name: s.name,
        pickup_time: s.pickup_time ?? '',
        drop_time: s.drop_time ?? '',
        latitude: s.latitude ?? '',
        longitude: s.longitude ?? '',
        // Blank, not "0", when the stop uses the school default: an editor
        // that reads a null back as a zero saves a circle nothing can enter.
        geofence_m: s.geofence_m != null ? String(s.geofence_m) : '',
      })),
      { ...BLANK_STOP },
    ])
  }

  const rows = list.data?.items ?? []
  const named = stops.filter((s) => s.name.trim() !== '').length
  const stopless = rows.filter((r) => r.is_active && r.stops === 0)

  return (
    <Card>
      <CardHeader
        title={editing ? 'Edit this route' : 'Add a route'}
        description="A route is the run and the stops on it. The stops are what the arrival alerts, the attendance scan and the allocation screen are all reading, so a route saved without them is only half a route."
        action={
          <Button variant="secondary" onClick={() => (open ? close() : (save.reset(), setOpen(true)))}>
            {open ? 'Close' : 'Add a route'}
          </Button>
        }
      />
      {open && (
        <div className="border-b p-4">
          <FormGrid>
            <Field label="Name" required>
              <Input value={form.name} onChange={set('name')} placeholder="Kukatpally morning" />
            </Field>
            <Field label="Code" hint="Short label the office and the drivers use.">
              <Input value={form.code} onChange={set('code')} placeholder="R-01" />
            </Field>
            <Field label="Bus" hint="A bus runs one route at a time. Putting it here takes it off any other route.">
              <Select
                value={form.vehicle_id}
                onChange={set('vehicle_id')}
                placeholder="No bus yet"
                options={busOptions}
              />
            </Field>
            <Field label="Distance (km)">
              <Input value={form.distance_km} onChange={set('distance_km')} placeholder="18.5" />
            </Field>
          </FormGrid>

          <div className="mt-5">
            <p className="text-[14px] font-medium">Stops, in the order the bus reaches them</p>
            <p className="text-[13px] text-muted-foreground">
              The order here is the order on the driver's screen. Coordinates are optional and
              only decide where the arrival alert fires.
            </p>
            {named === 0 && (
              <div className="mt-3 rounded-md bg-destructive/5 px-3 py-2">
                <p className="text-[13px] font-medium text-destructive">
                  This route has no stops
                </p>
                <p className="text-[13px] text-muted-foreground">
                  The bus still tracks and parents still watch it move, but nothing can be said
                  about where it has reached: no arrival alerts, no attendance scan at a stop,
                  and no answer to "has it passed us yet". Children cannot be allocated either,
                  because allocation asks for a pickup stop.
                </p>
              </div>
            )}
            <div className="mt-3 space-y-3">
              {stops.map((s, i) => (
                <div key={i} className="rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[13px] font-medium text-muted-foreground">
                      Stop {i + 1}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => moveStop(i, -1)}>
                        Up
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={i === stops.length - 1}
                        onClick={() => moveStop(i, 1)}
                      >
                        Down
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setStops((l) => (l.length === 1 ? [{ ...BLANK_STOP }] : l.filter((_, n) => n !== i)))}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  <FormGrid>
                    <Field label="Stop name">
                      <Input value={s.name} onChange={setStop(i, 'name')} placeholder="JNTU crossroads" />
                    </Field>
                    <Field label="Pickup time">
                      <Input type="time" value={s.pickup_time} onChange={setStop(i, 'pickup_time')} />
                    </Field>
                    <Field label="Drop time">
                      <Input type="time" value={s.drop_time} onChange={setStop(i, 'drop_time')} />
                    </Field>
                    <Field label="Latitude">
                      <Input value={s.latitude} onChange={setStop(i, 'latitude')} placeholder="17.4933" />
                    </Field>
                    <Field label="Longitude">
                      <Input value={s.longitude} onChange={setStop(i, 'longitude')} placeholder="78.3915" />
                    </Field>
                    {/* Left blank for almost every stop. It exists for the one
                        on a dual carriageway where the bus pulls in fifty
                        metres past the shelter and the school-wide circle
                        never quite catches it. */}
                    <Field
                      label="Arrival circle (m)"
                      hint="Leave blank to use the school's default."
                    >
                      <Input
                        value={s.geofence_m}
                        onChange={setStop(i, 'geofence_m')}
                        placeholder="120"
                      />
                    </Field>
                  </FormGrid>

                  {/* Nobody knows the junction is 17.4933, 78.3915. The office
                      was opening a maps app, long-pressing the corner, and
                      pasting half a string into each box — and a transposed
                      digit puts the arrival alert in another district with
                      nothing on this screen to say so. */}
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setPicking(picking === i ? null : i)}
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      {picking === i
                        ? 'Close the map'
                        : s.latitude && s.longitude
                          ? 'Move it on the map'
                          : 'Choose on map'}
                    </Button>
                  </div>
                  {picking === i && (
                    <Suspense fallback={<Loading />}>
                      <MapPointPicker
                        value={pointOf(s)}
                        /* Somewhere near the rest of this route, so the office
                           is not panning across the country to find the town. */
                        fallback={stops.map(pointOf).find((p) => p !== null) ?? null}
                        onPick={(p) => {
                          setStops((l) =>
                            l.map((row, n) =>
                              n === i
                                ? { ...row, latitude: String(p.lat), longitude: String(p.lng) }
                                : row,
                            ),
                          )
                          setPicking(null)
                        }}
                        onClose={() => setPicking(null)}
                      />
                    </Suspense>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={() => setStops((l) => [...l, { ...BLANK_STOP }])}>
                Add a stop
              </Button>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Button disabled={save.isPending || form.name.trim() === ''} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add the route'}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
            )}
            <span className="text-[13px] text-muted-foreground">
              {named === 1 ? '1 stop' : `${named} stops`}
            </span>
          </div>
          {save.error && (
            <div className="mt-3">
              <FormNotice error={save.error instanceof Error ? save.error : new Error('Could not save this route')} />
            </div>
          )}
        </div>
      )}

      {list.isLoading ? (
        <SkeletonTable columns={8} label="Loading the routes…" />
      ) : list.error ? (
        <ErrorState error={list.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No routes yet"
          body="A bus with no route has nowhere to go, and a child cannot be allocated to one. Add the run and the stops along it."
        />
      ) : (
        <>
          {stopless.length > 0 && (
            <div className="border-b bg-destructive/5 px-4 py-3">
              <p className="text-[13px] font-medium text-destructive">
                {stopless.length} route{stopless.length === 1 ? '' : 's'} with no stops
              </p>
              <p className="text-[13px] text-muted-foreground">
                {stopless.map((r) => r.name).join(', ')} · the bus tracks, but nothing can say
                where it has reached and nobody can be allocated to it.
              </p>
            </div>
          )}
          <Table
            head={[
              { label: 'Route' },
              { label: 'Bus' },
              { label: 'Stops' },
              { label: 'Riders' },
              { label: 'Distance' },
              { label: 'Status' },
              { label: '' },
            ]}
          >
            {rows.map((r) => (
              <tr key={r.id} className={cn(r.is_active && r.stops === 0 && 'bg-destructive/5')}>
                <Td className="font-medium">
                  {r.name}
                  {r.code && (
                    <div className="font-mono text-[12px] font-normal text-muted-foreground">
                      {r.code}
                    </div>
                  )}
                </Td>
                <Td className="text-muted-foreground">
                  {r.vehicle ? (
                    <span className="font-mono text-[13px]">{r.vehicle}</span>
                  ) : (
                    <Badge tone="warning">No bus</Badge>
                  )}
                </Td>
                <Td className="tabular-nums">
                  {r.stops === 0 ? <Badge tone="danger">None</Badge> : r.stops}
                </Td>
                <Td className="tabular-nums text-muted-foreground">{r.riders}</Td>
                <Td className="tabular-nums text-muted-foreground">
                  {r.distance_km ? `${r.distance_km} km` : '—'}
                </Td>
                <Td>
                  <Badge tone={r.is_active ? 'success' : 'neutral'}>
                    {r.is_active ? 'Running' : 'Retired'}
                  </Badge>
                </Td>
                <Td>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void edit(r)}>
                      Edit
                    </Button>
                    {r.is_active && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={retire.isPending}
                        onClick={() => retire.mutate(r.id)}
                      >
                        Retire
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </Card>
  )
}

function Buses() {
  const qc = useQueryClient()
  const routes = useRoutes()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<Record<string, string>>(BLANK)

  const list = useQuery({
    queryKey: ['transport-vehicles'],
    queryFn: () => api.get<List<Fleet>>('/api/v1/ops/transport/vehicles'),
  })
  // The same key the Drivers tab uses, so the staff list is fetched once.
  const employees = useQuery({
    // Not /hr/employees: that sits behind EmployeesRead, which neither the
    // transport manager nor operations staff hold, so it answered 403 and the
    // dropdown rendered empty for exactly the people who need it.
    queryKey: ['transport-assignable-staff'],
    queryFn: () => api.get<List<Named>>('/api/v1/ops/transport/assignable-staff'),
  })

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        registration_no: form.registration_no.trim(),
        model: form.model,
        capacity: Number(form.capacity || 0),
        driver_employee_id: form.driver_employee_id,
        attendant_employee_id: form.attendant_employee_id,
        insurance_expiry: form.insurance_expiry,
        fitness_expiry: form.fitness_expiry,
        permit_expiry: form.permit_expiry,
        puc_expiry: form.puc_expiry,
        status: form.status,
      }
      const saved = editing
        ? await api.put<{ id: string }>(`/api/v1/ops/transport/vehicles/${editing}`, body)
        : await api.post<{ id: string }>('/api/v1/ops/transport/vehicles', body)
      /* Sent on every save, blank included, now that editing prefills the
         route it found. Skipping the blank case meant a route could be put on
         a bus and never taken off it again from this form. */
      await api.put(`/api/v1/ops/transport/vehicles/${saved.id}/route`, {
        route_id: form.route_id ?? '',
      })
      return saved
    },
    onSuccess: () => {
      setOpen(false)
      setEditing(null)
      setForm(BLANK)
      qc.invalidateQueries({ queryKey: ['transport-vehicles'] })
      qc.invalidateQueries({ queryKey: ['transport-routes'] })
      qc.invalidateQueries({ queryKey: ['transport-staff'] })
    },
  })

  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })
  const drivers = (employees.data?.items ?? []).map((e) => ({
    value: e.id,
    label: e.full_name ?? e.name ?? e.id,
  }))
  const session = useSession()
  const rows = list.data?.items ?? []
  const driverless = rows.filter((v) => !v.driver && v.status === 'active')
  // Whose sticker is open. One at a time: these are printed one bus at a time
  // and two QR codes on a page is a sticker in the wrong windscreen.
  const [sticker, setSticker] = useState<string | null>(null)

  const edit = (v: Fleet) => {
    setEditing(v.id)
    setOpen(true)
    save.reset()
    setForm({
      ...BLANK,
      registration_no: v.registration_no,
      model: v.model ?? '',
      capacity: String(v.capacity ?? 40),
      status: v.status,
      driver_employee_id: v.driver_employee_id ?? '',
      attendant_employee_id: v.attendant_employee_id ?? '',
      insurance_expiry: v.insurance_expiry ?? '',
      fitness_expiry: v.fitness_expiry ?? '',
      permit_expiry: v.permit_expiry ?? '',
      puc_expiry: v.puc_expiry ?? '',
      route_id: v.route_id ?? '',
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title={editing ? 'Edit this bus' : 'Add a bus'}
          description="The driver is the field that does the work. The tracker app signs a driver in against the bus they are recorded on, so a bus with nobody named here cannot start a trip however well everything else is set up."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                if (open) { setOpen(false); setEditing(null); setForm(BLANK) }
                else { save.reset(); setOpen(true) }
              }}
            >
              {open ? 'Close' : 'Add a bus'}
            </Button>
          }
        />
        {open && (
          <div className="border-b p-4">
            <FormGrid>
              <Field label="Registration" required>
                <Input
                  value={form.registration_no}
                  onChange={set('registration_no')}
                  placeholder="TS09 UB 1234"
                />
              </Field>
              <Field label="Model">
                <Input value={form.model} onChange={set('model')} placeholder="Tata Starbus" />
              </Field>
              <Field label="Seats">
                <Input value={form.capacity} onChange={set('capacity')} type="number" />
              </Field>
              <Field label="Status">
                <Select
                  value={form.status}
                  onChange={set('status')}
                  options={[
                    { value: 'active', label: 'In service' },
                    { value: 'maintenance', label: 'Off the road' },
                    { value: 'retired', label: 'Retired' },
                  ]}
                />
              </Field>
              <Field label="Driver" hint="Without this the driver's phone cannot sign in to this bus.">
                <Select
                  value={form.driver_employee_id}
                  onChange={set('driver_employee_id')}
                  placeholder="Nobody yet"
                  options={drivers}
                />
              </Field>
              <Field label="Attendant">
                <Select
                  value={form.attendant_employee_id}
                  onChange={set('attendant_employee_id')}
                  placeholder="Nobody yet"
                  options={drivers}
                />
              </Field>
              <Field label="Route">
                <Select
                  value={form.route_id}
                  onChange={set('route_id')}
                  placeholder="Leave the route as it is"
                  options={(routes.data?.items ?? []).map((r) => ({
                    value: r.id,
                    label: r.name ?? r.id,
                  }))}
                />
              </Field>
              <Field label="Insurance expiry">
                <Input type="date" value={form.insurance_expiry} onChange={set('insurance_expiry')} />
              </Field>
              <Field label="Fitness expiry">
                <Input type="date" value={form.fitness_expiry} onChange={set('fitness_expiry')} />
              </Field>
              <Field label="Permit expiry">
                <Input type="date" value={form.permit_expiry} onChange={set('permit_expiry')} />
              </Field>
              <Field label="PUC expiry">
                <Input type="date" value={form.puc_expiry} onChange={set('puc_expiry')} />
              </Field>
            </FormGrid>
            <div className="mt-4 flex items-center gap-3">
              <Button
                disabled={save.isPending || form.registration_no.trim() === ''}
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add the bus'}
              </Button>
              {editing && (
                <Button
                  variant="ghost"
                  onClick={() => { setEditing(null); setForm(BLANK); save.reset() }}
                >
                  Cancel
                </Button>
              )}
            </div>
            {save.error && (
              <div className="mt-3">
                <FormNotice error={new Error(busError(save.error) ?? 'Could not save this bus')} />
              </div>
            )}
          </div>
        )}

        {list.isLoading ? (
          <SkeletonTable columns={9} label="Loading the fleet…" />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : rows.length === 0 ? (
          <EmptyState title="No buses on the fleet" body="Add the buses that carry children, and name who drives each one." />
        ) : (
          <>
            {driverless.length > 0 && (
              <div className="border-b bg-destructive/5 px-4 py-3">
                <p className="text-[13px] font-medium text-destructive">
                  {driverless.length} in service with no driver named
                </p>
                <p className="text-[13px] text-muted-foreground">
                  {driverless.map((v) => v.registration_no).join(', ')} · nobody can sign in
                  to these on the tracker app.
                </p>
              </div>
            )}
            <Table
              head={[
                { label: 'Bus' },
                { label: 'Bus code' },
                { label: 'Driver' },
                { label: 'Route' },
                { label: 'Seats' },
                { label: 'Papers lapse' },
                { label: 'Status' },
                { label: '' },
              ]}
            >
              {rows.map((v) => {
                const noDriver = !v.driver
                return (
                  <tr key={v.id} className={cn(noDriver && 'bg-destructive/5')}>
                    <Td className="font-medium">
                      <span className="font-mono text-[13px]">{v.registration_no}</span>
                      {v.model && (
                        <div className="text-[12px] font-normal text-muted-foreground">{v.model}</div>
                      )}
                    </Td>
                    <Td>
                      {v.bus_code ? (
                        <span className="font-mono text-[15px] font-semibold tabular-nums">
                          {v.bus_code}
                        </span>
                      ) : (
                        <span className="text-[13px] text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td>
                      {noDriver ? (
                        <Badge tone="danger">No driver</Badge>
                      ) : (
                        <span className="text-[14px]">{v.driver}</span>
                      )}
                    </Td>
                    <Td className="text-muted-foreground">{v.route ?? 'Unassigned'}</Td>
                    <Td className="tabular-nums text-muted-foreground">{v.capacity ?? '—'}</Td>
                    <Td className="text-muted-foreground">
                      {v.next_expiry ? formatDate(v.next_expiry) : '—'}
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          v.status === 'active'
                            ? 'success'
                            : v.status === 'retired'
                              ? 'neutral'
                              : 'warning'
                        }
                      >
                        {v.status === 'active'
                          ? 'In service'
                          : v.status === 'maintenance'
                            ? 'Off the road'
                            : v.status}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        {v.bus_code && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setSticker(sticker === v.id ? null : v.id)}
                          >
                            <QrCode className="h-3.5 w-3.5" />
                            {sticker === v.id ? 'Hide' : 'Sticker'}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => edit(v)}>
                          Edit
                        </Button>
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </Table>
            {/* Under the table rather than in a dialog: printing is the point,
                and a print of a modal is a print of a modal. */}
            {sticker && (
              <div className="border-t p-5">
                <Suspense fallback={<Loading />}>
                  {(() => {
                    const bus = rows.find((v) => v.id === sticker)
                    return bus?.bus_code ? (
                      <BusSticker
                        code={bus.bus_code}
                        registration={bus.registration_no}
                        schoolName={session.institution?.name}
                      />
                    ) : null
                  })()}
                </Suspense>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  )
}
