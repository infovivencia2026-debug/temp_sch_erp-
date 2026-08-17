import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

interface AdmissionsKPIs {
  enquiries: number; new_enquiries: number; applications: number
  incomplete: number; admitted: number; enrolled: number; follow_ups_due: number
}
interface EnquiryRow {
  id: string; student_name: string; parent_name?: string; phone: string
  source: string; status: string; next_follow_up?: string
  assigned_to?: string; created_at: string
}

export default function AdmissionsDashboard() {
  const kpis = useQuery({
    queryKey: ['admissions-dashboard'],
    queryFn: () => api.get<AdmissionsKPIs>('/api/v1/admissions/dashboard'),
  })
  const enquiries = useQuery({
    queryKey: ['admissions-enquiries'],
    queryFn: () => api.get<List<EnquiryRow>>('/api/v1/admissions/enquiries'),
  })

  if (kpis.isLoading) return <Loading />
  if (kpis.error) return <ErrorState error={kpis.error} />
  const k = kpis.data!
  // Funnel conversion is the number the admissions team is actually measured on.
  const conversion = k.enquiries ? Math.round((k.enrolled / k.enquiries) * 100) : 0

  return (
    <>
      <PageHead
        eyebrow="Dashboard"
        title="Admissions overview"
        description="Enquiries, applications, offers and enrolment conversion."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Enquiries" value={k.enquiries} hint={`${k.new_enquiries} new`} />
          <Stat label="Applications" value={k.applications} hint={`${k.incomplete} incomplete`} />
          <Stat label="Admitted" value={k.admitted} />
          <Stat
            label="Enrolled"
            value={k.enrolled}
            delta={{ value: `${conversion}% conversion`, positive: conversion >= 30 }}
          />
        </CellGrid>

        <Card>
          <CardHeader title="Follow-ups due" description={`${k.follow_ups_due} enquiries need contact today`} />
          {enquiries.isLoading ? (
            <Loading />
          ) : enquiries.error ? (
            <ErrorState error={enquiries.error} />
          ) : (
            <Table
              head={['Student', 'Parent', 'Phone', 'Source', 'Assigned', 'Follow-up', 'Status']}
              empty={!enquiries.data?.items.length}
              emptyLabel="No enquiries recorded."
            >
              {(enquiries.data?.items ?? []).map((e) => (
                <tr key={e.id}>
                  <Td className="font-medium">{e.student_name}</Td>
                  <Td className="text-muted-foreground">{e.parent_name ?? '—'}</Td>
                  <Td className="font-mono text-[12px]">{e.phone}</Td>
                  <Td><Badge>{e.source}</Badge></Td>
                  <Td className="text-muted-foreground">{e.assigned_to ?? 'unassigned'}</Td>
                  <Td className="text-muted-foreground">{formatDate(e.next_follow_up)}</Td>
                  <Td><Badge tone={e.status === 'new' ? 'primary' : 'neutral'}>{e.status}</Badge></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
