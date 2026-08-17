import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

interface HRKPIs {
  headcount: number; present_today: number; absent_today: number
  leave_pending: number; new_joiners_30d: number; departments: number
}
interface EmployeeRow {
  id: string; employee_code: string; full_name: string
  department?: string; designation?: string; phone?: string
  email?: string; joined_on: string; status: string
}

export default function HRDashboard() {
  const kpis = useQuery({
    queryKey: ['hr-dashboard'],
    queryFn: () => api.get<HRKPIs>('/api/v1/hr/dashboard'),
  })
  const staff = useQuery({
    queryKey: ['hr-employees'],
    queryFn: () => api.get<List<EmployeeRow>>('/api/v1/hr/employees?status=active'),
  })

  if (kpis.isLoading) return <Loading />
  if (kpis.error) return <ErrorState error={kpis.error} />
  const k = kpis.data!

  return (
    <>
      <PageHead
        eyebrow="Dashboard"
        title="HR overview"
        description="Headcount, attendance today, pending leave and new joiners."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Headcount" value={k.headcount} hint={`${k.departments} departments`} />
          <Stat
            label="Present today"
            value={k.present_today}
            delta={{ value: `${k.absent_today} absent`, positive: k.absent_today === 0 }}
          />
          <Stat label="Leave pending" value={k.leave_pending} hint="Awaiting approval" />
          <Stat label="New joiners" value={k.new_joiners_30d} hint="Last 30 days" />
        </CellGrid>

        <Card>
          <CardHeader
            title="Employee directory"
            description={`${staff.data?.items.length ?? 0} active employees`}
          />
          {staff.isLoading ? (
            <Loading />
          ) : staff.error ? (
            <ErrorState error={staff.error} />
          ) : (
            <Table
              head={['Code', 'Name', 'Department', 'Designation', 'Contact', 'Joined', 'Status']}
              empty={!staff.data?.items.length}
              emptyLabel="No employees on record."
            >
              {(staff.data?.items ?? []).map((e) => (
                <tr key={e.id}>
                  <Td className="font-mono text-[12px]">{e.employee_code}</Td>
                  <Td className="font-medium">{e.full_name}</Td>
                  <Td className="text-muted-foreground">{e.department ?? '—'}</Td>
                  <Td className="text-muted-foreground">{e.designation ?? '—'}</Td>
                  <Td className="text-muted-foreground">{e.email ?? e.phone ?? '—'}</Td>
                  <Td className="text-muted-foreground">{formatDate(e.joined_on)}</Td>
                  <Td><Badge tone={e.status === 'active' ? 'success' : 'neutral'}>{e.status}</Badge></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
