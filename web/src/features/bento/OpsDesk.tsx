import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from './bento-kit'
import { Gauge, Rows } from './bento-cards'
import { Facts, PersonaCard, PersonaPage, Say, useShape } from './persona-kit'
import { Widget } from './WidgetLayer'
import { inClassic } from './classic-board'

/* THE OPERATIONS DESK.

   Four cells, one per thing an operations clerk is answerable for, each over
   the list that role already reads: stock (inventory.read), vehicles
   (transport.read), loans (library.read) and beds (hostel.read). The one
   gauge is occupied over beds, both counted by the server. */

interface Stock {
  id: string
  name: string
  on_hand: number
  reorder_level: number
  below_reorder: boolean
}
interface Vehicle {
  id: string
  registration_no: string
  route?: string
  driver?: string
  next_expiry?: string
  status: string
}
interface Loan {
  id: string
  overdue: boolean
  returned_on?: string
}
interface Room {
  room_id: string
  beds: number
  occupied: number
  free: number
}

function daysUntil(iso?: string): number | null {
  if (!iso) return null
  const ms = Date.parse(`${iso}T00:00:00`)
  if (!Number.isFinite(ms)) return null
  const n = new Date()
  const mid = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  return Math.round((ms - mid) / 86_400_000)
}

function OpsDesk() {
  const stock = useQuery({
    queryKey: ['ops-stock'],
    queryFn: () => api.get<List<Stock>>('/api/v1/ops/inventory/stock'),
  })
  const vehicles = useQuery({
    queryKey: ['ops-vehicles'],
    queryFn: () => api.get<List<Vehicle>>('/api/v1/ops/transport/vehicles'),
  })
  const loans = useQuery({
    queryKey: ['ops-loans'],
    queryFn: () => api.get<List<Loan>>('/api/v1/ops/library/loans'),
  })
  const rooms = useQuery({
    queryKey: ['ops-rooms'],
    queryFn: () => api.get<List<Room>>('/api/v1/ops/hostel/occupancy'),
  })
  const toStores = useFeatureHref('operations.stores.stock_movements')
  const toVehicles = useFeatureHref('operations.transport.vehicles_routes')
  const toLibrary = useFeatureHref('operations.library.issue_return')
  const toHostel = useFeatureHref('operations.hostel.hostel_rooms')

  if (stock.isLoading || vehicles.isLoading || loans.isLoading || rooms.isLoading) {
    return <BentoLoading message="Reading stores, buses, loans and beds…" />
  }
  const failed = stock.error ?? vehicles.error ?? loans.error ?? rooms.error
  if (failed) return <BentoError message={String(failed)} />

  return (
    <PersonaPage eyebrow="Home" title="Operations desk" dashboard="ops_desk">
      <Widget id="stock" label="Stores" size="large" index={0}>
        {(span) => <StockCell span={span} items={stock.data?.items ?? []} to={toStores} />}
      </Widget>
      <Widget id="buses" label="Buses" size="small" index={1}>
        {(span) => <BusCell span={span} items={vehicles.data?.items ?? []} to={toVehicles} />}
      </Widget>
      <Widget id="loans" label="Library" size="small" index={2}>
        {(span) => <LoanCell span={span} items={loans.data?.items ?? []} to={toLibrary} />}
      </Widget>
      <Widget id="beds" label="Hostel" size="small" index={3}>
        {(span) => <BedCell span={span} items={rooms.data?.items ?? []} to={toHostel} />}
      </Widget>
    </PersonaPage>
  )
}

function StockCell({ span, items, to }: { span: CellSpan; items: Stock[]; to?: string }) {
  const { tall } = useShape()
  const low = items.filter((s) => s.below_reorder)
  const rows = low
    .map((s) => ({ label: s.name, value: Math.max(1, s.reorder_level - s.on_hand) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, tall ? 8 : 4)
  return (
    <PersonaCard
      span={span}
      ground="operations"
      title="Below reorder level"
      glyph="▤"
      value={low.length}
      change={items.length === 0 ? 'No item in the register' : `of ${items.length} items`}
      to={to}
      cueLabel="Open stock and movements"
    >
      {low.length === 0 ? <Say>Nothing needs ordering</Say> : <Rows items={rows} srLabel="Items by how far below reorder level" />}
    </PersonaCard>
  )
}

function BusCell({ span, items, to }: { span: CellSpan; items: Vehicle[]; to?: string }) {
  const live = items.filter((v) => v.status !== 'retired')
  const lapsing = live.filter((v) => {
    const d = daysUntil(v.next_expiry)
    return d !== null && d <= 30
  }).length
  const facts = [
    { label: 'Papers lapse within 30 days', value: String(lapsing) },
    { label: 'Without a route', value: String(live.filter((v) => !v.route).length) },
    { label: 'Without a driver', value: String(live.filter((v) => !v.driver).length) },
  ]
  return (
    <PersonaCard
      span={span}
      title="Buses"
      glyph="⛟"
      value={live.length}
      change={lapsing > 0 ? `${lapsing} with papers about to lapse` : 'Papers in date'}
      to={to}
      cueLabel="Open vehicles and routes"
    >
      {live.length === 0 ? <Say>No vehicle is registered</Say> : <Facts items={facts} srLabel="Buses needing attention" />}
    </PersonaCard>
  )
}

function LoanCell({ span, items, to }: { span: CellSpan; items: Loan[]; to?: string }) {
  const out = items.filter((l) => !l.returned_on)
  const overdue = out.filter((l) => l.overdue).length
  return (
    <PersonaCard
      span={span}
      title="Books out"
      glyph="▯"
      value={out.length}
      change={overdue === 0 ? 'None overdue' : `${overdue} overdue`}
      to={to}
      cueLabel="Open issue and return"
    >
      {out.length === 0 ? (
        <Say>Nothing is on loan</Say>
      ) : (
        <Gauge value={overdue} total={out.length} srLabel="Overdue loans out of books on loan" />
      )}
    </PersonaCard>
  )
}

function BedCell({ span, items, to }: { span: CellSpan; items: Room[]; to?: string }) {
  const beds = items.reduce((a, r) => a + r.beds, 0)
  const occupied = items.reduce((a, r) => a + r.occupied, 0)
  return (
    <PersonaCard
      span={span}
      title="Beds free"
      glyph="⌂"
      value={beds - occupied}
      change={beds === 0 ? 'No hostel room set up' : `${occupied} of ${beds} occupied`}
      to={to}
      cueLabel="Open hostel and rooms"
    >
      {beds === 0 ? <Say>No room has beds yet</Say> : <Gauge value={occupied} total={beds} srLabel="Beds occupied out of beds" />}
    </PersonaCard>
  )
}

export const Classic = inClassic(OpsDesk)
export default OpsDesk
