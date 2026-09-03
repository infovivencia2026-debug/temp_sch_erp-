import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, SkeletonTable, ErrorState,
} from '@/components/ui'
import { useRouteFeature } from '@/lib/catalog'

interface WorkloadRow {
  user_id: string; full_name: string; employee_code: string
  department?: string; weekly_periods: number; subjects: number; sections: number
}

export default function StaffWorkload() {
  const nav = useRouteFeature()
  const { data, isLoading, error } = useQuery({
    queryKey: ['staff-workload'],
    queryFn: () => api.get<List<WorkloadRow>>('/api/v1/principal/staff-workload'),
  })

  const rows = data?.items ?? []
  // 30 periods/week is the usual full-time ceiling; 0 means nothing timetabled.
  const overloaded = rows.filter((r) => r.weekly_periods > 30).length
  const idle = rows.filter((r) => r.weekly_periods === 0).length
  const avg = rows.length
    ? Math.round(rows.reduce((a, r) => a + r.weekly_periods, 0) / rows.length)
    : 0

  return (
    <>
      {/* Clicked under Academics as "Teacher Assignment", opened as
          "Administration / Staff allocation & workload" — a different section
          and a different noun, which is two chances to think you have
          mis-clicked before you have read a number. The catalogue's name
          wins; it is the one the menu and the search box already use. */}
      <PageHead
        eyebrow={nav.section?.name ?? 'Academics'}
        title={nav.feature?.name ?? 'Teacher Assignment'}
        description="Teacher period allocations and weekly teaching load, to spot overload and gaps."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Teaching staff" value={rows.length} />
          <Stat label="Average load" value={`${avg}`} hint="Periods per week" />
          <Stat label="Overloaded" value={overloaded} hint="Above 30 periods" />
          <Stat label="Unallocated" value={idle} hint="No periods timetabled" />
        </CellGrid>

        <Card>
          <CardHeader title="Workload by teacher" description="Sorted by weekly period count" />
          {isLoading ? (
            <SkeletonTable columns={7} />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table
              head={['Code', 'Teacher', 'Department', 'Periods/week', 'Subjects', 'Sections', 'Load']}
              empty={!rows.length}
            >
              {rows.map((t) => (
                <tr key={t.user_id}>
                  <Td className="font-mono text-[12px]">{t.employee_code}</Td>
                  <Td className="font-medium">{t.full_name}</Td>
                  <Td className="text-muted-foreground">{t.department ?? '—'}</Td>
                  <Td>{t.weekly_periods}</Td>
                  <Td>{t.subjects}</Td>
                  <Td>{t.sections}</Td>
                  <Td>
                    <Badge
                      tone={
                        t.weekly_periods > 30 ? 'danger'
                        : t.weekly_periods > 24 ? 'warning'
                        : t.weekly_periods === 0 ? 'neutral'
                        : 'success'
                      }
                    >
                      {t.weekly_periods > 30 ? 'Overloaded'
                        : t.weekly_periods > 24 ? 'Heavy'
                        : t.weekly_periods === 0 ? 'Unallocated'
                        : 'Normal'}
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
