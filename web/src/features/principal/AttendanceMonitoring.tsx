import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Select, Loading, ErrorState,
} from '@/components/ui'

interface ShortageRow {
  student_id: string; admission_no: string; full_name: string
  class_name: string; section_name: string
  present: number; total: number; pct: number
}

/** 75% is the standard board threshold for exam eligibility. */
export default function AttendanceMonitoring() {
  const [threshold, setThreshold] = useState('75')

  const { data, isLoading, error } = useQuery({
    queryKey: ['attendance-shortage', threshold],
    queryFn: () => api.get<List<ShortageRow>>(`/api/v1/principal/attendance-shortage?threshold=${threshold}`),
  })

  const rows = data?.items ?? []
  const critical = rows.filter((r) => r.pct < 60).length

  return (
    <>
      <PageHead
        eyebrow="Academic Monitoring"
        title="Attendance monitoring"
        description="Institution, class and student attendance with the shortage list."
        actions={
          <Select
            value={threshold}
            onChange={setThreshold}
            options={[
              { value: '85', label: 'Below 85%' },
              { value: '75', label: 'Below 75% (board minimum)' },
              { value: '60', label: 'Below 60%' },
            ]}
          />
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Below threshold" value={rows.length} hint={`Under ${threshold}%`} />
          <Stat label="Critical" value={critical} hint="Under 60%" />
          <Stat
            label="Lowest"
            value={rows.length ? `${Math.min(...rows.map((r) => r.pct))}%` : '—'}
          />
        </CellGrid>

        <Card>
          <CardHeader title="Shortage list" description="Students at risk of exam ineligibility" />
          {isLoading ? (
            <Loading />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table
              head={['Admission no.', 'Student', 'Class', 'Present', 'Total', 'Attendance']}
              empty={!rows.length}
              emptyLabel="Every student is above the threshold."
            >
              {rows.map((s) => (
                <tr key={s.student_id}>
                  <Td className="font-mono text-[12px]">{s.admission_no}</Td>
                  <Td className="font-medium">{s.full_name}</Td>
                  <Td>{s.class_name}-{s.section_name}</Td>
                  <Td>{s.present}</Td>
                  <Td>{s.total}</Td>
                  <Td>
                    <Badge tone={s.pct < 60 ? 'danger' : s.pct < 75 ? 'warning' : 'neutral'}>
                      {s.pct}%
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
