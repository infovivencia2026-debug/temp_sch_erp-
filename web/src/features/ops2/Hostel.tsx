import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState,
} from '@/components/ui'

interface Room {
  block: string; room_no: string; beds: number
  occupied: number; free: number; gender?: string
}

export default function Hostel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['hostel'],
    queryFn: () => api.get<List<Room>>('/api/v1/ops/hostel/occupancy'),
  })
  const rows = data?.items ?? []
  const beds = rows.reduce((a, r) => a + r.beds, 0)
  const occupied = rows.reduce((a, r) => a + r.occupied, 0)

  return (
    <>
      <PageHead
        eyebrow="Hostel Management"
        title="Occupancy"
        description="Rooms, beds and free capacity. One boarder per bed is enforced by the database, not by the screen."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Rooms" value={rows.length} />
          <Stat label="Beds" value={beds} />
          <Stat label="Occupied" value={occupied}
            hint={beds ? `${Math.round((occupied / beds) * 100)}% full` : undefined} />
          <Stat label="Free" value={beds - occupied} />
        </CellGrid>
        <Card>
          <CardHeader title="Rooms" />
          {isLoading ? <Loading /> : error ? <ErrorState error={error} /> : (
            <Table head={['Block', 'Room', 'Gender', 'Beds', 'Occupied', 'Free']} empty={!rows.length}
              emptyLabel="No hostel rooms configured.">
              {rows.map((r) => (
                <tr key={`${r.block}-${r.room_no}`}>
                  <Td className="font-medium">{r.block}</Td>
                  <Td>{r.room_no}</Td>
                  <Td>{r.gender ?? '—'}</Td>
                  <Td>{r.beds}</Td>
                  <Td>{r.occupied}</Td>
                  <Td>
                    <Badge tone={r.free === 0 ? 'danger' : r.free < 2 ? 'warning' : 'success'}>
                      {r.free}
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
