import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { useMyGroups } from '@/components/GroupReportLink'
import { api, setActingInstitution } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button, Select,
  SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

/* The combined report for a school group's admin (Seller → School groups).

   Every number is read live from each school's own records by the server,
   which decides which schools this person may see; nothing here widens that.
   "Today" and "this month" are each school's own. */

interface Numbers {
  students: number
  staff: number
  collected_month_paise: number
  outstanding_paise: number
  attendance_marked_today: number
  attendance_present_today: number
  attendance_pct?: number
}
interface SchoolRow extends Numbers { id: string; name: string; short_name: string; status: string; reachable: boolean }
interface Dashboard { id: string; name: string; totals: Numbers & { schools: number }; schools: SchoolRow[] }

export default function GroupReport() {
  const { groupId } = useParams()
  const qc = useQueryClient()
  const mine = useMyGroups()
  const groups = mine.data?.items ?? []
  const [picked, setPicked] = useState<string>('')
  const id = picked || groupId || groups[0]?.id || ''

  const dash = useQuery({
    queryKey: ['group-dashboard', id],
    queryFn: () => api.get<Dashboard>(`/api/v1/groups/${id}/dashboard`),
    enabled: !!id,
  })

  if (mine.isLoading && !mine.data) return <SkeletonTable columns={4} />
  if (mine.error) return <ErrorState error={mine.error} />
  if (!id) {
    return (
      <>
        <PageHead eyebrow="Group" title="Group report" />
        <PageBody>
          <EmptyState title="No group" body="You are not an admin of a school group. The seller makes group admins." />
        </PageBody>
      </>
    )
  }

  const d = dash.data
  const t = d?.totals
  return (
    <>
      <PageHead
        eyebrow="Group"
        title={d?.name ?? 'Group report'}
        description="Every school in the group, added up and side by side. Today and this month are each school's own."
        actions={groups.length > 1 && (
          <div className="w-64">
            <Select
              value={id}
              onChange={setPicked}
              allowCustom={false}
              options={groups.map((g) => ({ value: g.id, label: g.name }))}
            />
          </div>
        )}
      />
      <PageBody>
        {dash.isLoading ? (
          <SkeletonTable columns={5} />
        ) : dash.error ? (
          <ErrorState error={dash.error} />
        ) : t && d ? (
          <>
            <CellGrid cols={4}>
              <Stat label="Students" value={t.students} hint={`${t.schools} ${t.schools === 1 ? 'school' : 'schools'}`} />
              <Stat
                label="Attendance today"
                value={t.attendance_pct != null ? `${t.attendance_pct}%` : 'not marked'}
                hint={`${t.attendance_present_today} of ${t.attendance_marked_today} marked present`}
              />
              <Stat label="Fees collected" value={formatPaise(t.collected_month_paise)} period="This month" />
              <Stat label="Fees outstanding" value={formatPaise(t.outstanding_paise)} hint={`${t.staff} staff`} />
            </CellGrid>
            <Card>
              <CardHeader title="By school" />
              {d.schools.length === 0 ? (
                <EmptyState title="No schools" body="This group has no schools you can see yet." />
              ) : (
                <Table wide head={['School', 'Students', 'Staff', 'Attendance today', 'Collected this month', 'Outstanding', '']}>
                  {d.schools.map((s) => (
                    <tr key={s.id}>
                      <Td className="whitespace-nowrap font-medium">
                        {s.name}
                        {s.status !== 'active' && <> <Badge tone="danger">{s.status}</Badge></>}
                        {!s.reachable && <span className="block text-[12px] font-normal text-muted-foreground">could not be read</span>}
                      </Td>
                      <Td className="num">{s.students}</Td>
                      <Td className="num">{s.staff}</Td>
                      <Td className="num">{s.attendance_pct != null ? `${s.attendance_pct}%` : <span className="text-muted-foreground">not marked</span>}</Td>
                      <Td className="num">{formatPaise(s.collected_month_paise)}</Td>
                      <Td className="num">{formatPaise(s.outstanding_paise)}</Td>
                      <Td className="whitespace-nowrap">
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="secondary"
                            title="Work inside this school"
                            onClick={() => { setActingInstitution(s.id); qc.invalidateQueries() }}
                          >
                            Open
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </>
        ) : null}
      </PageBody>
    </>
  )
}
