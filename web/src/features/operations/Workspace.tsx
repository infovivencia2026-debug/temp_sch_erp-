import { useQuery } from '@tanstack/react-query'
import { BookOpen, Bus, AlertTriangle, Clock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState,
} from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'

interface OpsKPIs {
  library_titles: number; loans_out: number; loans_overdue: number
  vehicles: number; routes: number; vehicle_docs_expiring: number
  hostel_students: number
}
interface LoanRow {
  id: string; title: string; borrower: string; issued_on: string
  due_on: string; returned_on?: string; fine_paise: number; overdue: boolean
}
interface VehicleRow {
  id: string; registration_no: string; model?: string; capacity: number
  route?: string; driver?: string; next_expiry?: string; status: string
}

/**
 * One workspace for every operations specialism. Which cards carry meaning
 * depends on the user's grants — a librarian and a transport manager share
 * this screen and see the same shape, filled differently.
 */
export default function OperationsWorkspace() {
  const kpis = useQuery({
    queryKey: ['ops-dashboard'],
    queryFn: () => api.get<OpsKPIs>('/api/v1/operations/dashboard'),
  })
  const loans = useQuery({
    queryKey: ['ops-loans'],
    queryFn: () => api.get<List<LoanRow>>('/api/v1/operations/library/loans?open=true'),
    retry: false,
  })
  const vehicles = useQuery({
    queryKey: ['ops-vehicles'],
    queryFn: () => api.get<List<VehicleRow>>('/api/v1/operations/transport/vehicles'),
    retry: false,
  })

  if (kpis.isLoading) return <Loading />
  if (kpis.error) return <ErrorState error={kpis.error} />
  const k = kpis.data!

  return (
    <>
      <PageHead
        eyebrow="Specialist Workspace"
        title="Operations"
        description="Library, transport, hostel and stores — the dashboard changes with your permissions."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Library titles" value={k.library_titles} icon={BookOpen} />
          <Stat
            label="Books on loan"
            value={k.loans_out}
            delta={{ value: `${k.loans_overdue} overdue`, positive: k.loans_overdue === 0 }}
          />
          <Stat label="Vehicles" value={k.vehicles} icon={Bus} hint={`${k.routes} routes`} />
          <Stat
            label="Docs expiring"
            value={k.vehicle_docs_expiring}
            icon={AlertTriangle}
            hint="Within 30 days"
          />
        </CellGrid>

        {/* Each panel is hidden when the role has no grant for it — the query
            403s and we simply do not render the section. */}
        {!loans.error && (
          <Card>
            <CardHeader title="Books on loan" description="Currently issued and not returned" />
            {loans.isLoading ? (
              <Loading />
            ) : (
              <Table
                head={['Title', 'Borrower', 'Issued', 'Due', 'Fine', 'State']}
                empty={!loans.data?.items.length}
                emptyLabel="No books currently on loan."
              >
                {(loans.data?.items ?? []).map((l) => (
                  <tr key={l.id}>
                    <Td className="font-medium">{l.title}</Td>
                    <Td>{l.borrower}</Td>
                    <Td className="text-muted-foreground">{formatDate(l.issued_on)}</Td>
                    <Td className="text-muted-foreground">{formatDate(l.due_on)}</Td>
                    <Td>{l.fine_paise ? formatPaise(l.fine_paise) : '—'}</Td>
                    <Td>
                      <Badge tone={l.overdue ? 'danger' : 'success'}>
                        {l.overdue ? <><Clock className="mr-1 h-3 w-3" />overdue</> : 'on time'}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {!vehicles.error && (
          <Card>
            <CardHeader title="Vehicle registry" description="Buses, routes and statutory document expiry" />
            {vehicles.isLoading ? (
              <Loading />
            ) : (
              <Table
                head={['Registration', 'Model', 'Capacity', 'Route', 'Driver', 'Next expiry', 'Status']}
                empty={!vehicles.data?.items.length}
                emptyLabel="No vehicles registered."
              >
                {(vehicles.data?.items ?? []).map((v) => (
                  <tr key={v.id}>
                    <Td className="font-mono text-[12px]">{v.registration_no}</Td>
                    <Td>{v.model ?? '—'}</Td>
                    <Td>{v.capacity}</Td>
                    <Td className="text-muted-foreground">{v.route ?? 'unassigned'}</Td>
                    <Td className="text-muted-foreground">{v.driver ?? '—'}</Td>
                    <Td className="text-muted-foreground">{formatDate(v.next_expiry)}</Td>
                    <Td><Badge tone={v.status === 'active' ? 'success' : 'neutral'}>{v.status}</Badge></Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}
      </PageBody>
    </>
  )
}
