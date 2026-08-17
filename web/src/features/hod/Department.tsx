import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState,
} from '@/components/ui'

interface DeptKPIs {
  departments: number; faculty: number; students: number
  sections: number; pending_approvals: number
}
interface DeptFaculty {
  user_id: string; full_name: string; employee_code: string
  department?: string; designation?: string; weekly_periods: number
}

/**
 * Department scope is the one the schema cannot enforce for us: every row here
 * belongs to the same institution, so RLS admits all of it. The API filters on
 * departments.head_user_id — this screen simply reflects what came back.
 */
export default function Department() {
  const kpis = useQuery({
    queryKey: ['dept-dashboard'],
    queryFn: () => api.get<DeptKPIs>('/api/v1/department/dashboard'),
  })
  const faculty = useQuery({
    queryKey: ['dept-faculty'],
    queryFn: () => api.get<List<DeptFaculty>>('/api/v1/department/faculty'),
  })

  if (kpis.isLoading) return <Loading />
  if (kpis.error) return <ErrorState error={kpis.error} />
  const k = kpis.data!

  return (
    <>
      <PageHead
        eyebrow="Department Workspace"
        title="Department overview"
        description="Faculty, students, sections and approvals for the departments you head."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Departments" value={k.departments} hint="You are head of" />
          <Stat label="Faculty" value={k.faculty} />
          <Stat label="Students" value={k.students} hint="Through taught sections" />
          <Stat label="Pending approvals" value={k.pending_approvals} hint="Leave requests" />
        </CellGrid>

        <Card>
          <CardHeader
            title="Faculty directory"
            description={`${faculty.data?.items.length ?? 0} in your departments`}
          />
          {faculty.isLoading ? (
            <Loading />
          ) : faculty.error ? (
            <ErrorState error={faculty.error} />
          ) : (
            <Table
              head={['Code', 'Name', 'Department', 'Designation', 'Periods/week', 'Load']}
              empty={!faculty.data?.items.length}
              emptyLabel="No faculty in your departments."
            >
              {(faculty.data?.items ?? []).map((f) => (
                <tr key={f.user_id}>
                  <Td className="font-mono text-[12px]">{f.employee_code}</Td>
                  <Td className="font-medium">{f.full_name}</Td>
                  <Td className="text-muted-foreground">{f.department ?? '—'}</Td>
                  <Td className="text-muted-foreground">{f.designation ?? '—'}</Td>
                  <Td>{f.weekly_periods}</Td>
                  <Td>
                    <Badge tone={f.weekly_periods > 30 ? 'danger' : f.weekly_periods > 24 ? 'warning' : 'success'}>
                      {f.weekly_periods > 30 ? 'Overloaded' : f.weekly_periods > 24 ? 'Heavy' : 'Normal'}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
