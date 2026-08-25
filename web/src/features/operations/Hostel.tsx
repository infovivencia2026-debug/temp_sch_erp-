import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Select, Loading, ErrorState, FormNotice, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatDate, cn } from '@/lib/utils'

/* The hostel, from the warden's side.
 *
 * Occupancy counts told you a bed was taken and not by whom, and the allocate
 * endpoint existed with nothing calling it — the room list did not even carry
 * a room id, so every row named a place the client could not then refer to.
 *
 * The block is laid out as rooms rather than a table because that is how a
 * warden holds it in their head: a floor, a corridor, and which doors have a
 * free bed behind them. Opening a room names its boarders, which is what roll
 * call needs.
 */

interface Room {
  room_id: string
  block: string
  room_no: string
  floor?: number
  beds: number
  occupied: number
  free: number
  gender?: string
}

interface Boarder {
  allocation_id: string
  student_id: string
  name: string
  admission_no: string
  bed_no: number
  allocated_on: string
  class_name?: string
}

export default function Hostel() {
  const qc = useQueryClient()
  const can = useCan()
  const mayAllocate = can('operations.hostel.write')

  const [openRoom, setOpenRoom] = useState<Room | null>(null)
  const [search, setSearch] = useState('')
  const [studentId, setStudentId] = useState('')
  const [bedNo, setBedNo] = useState('')
  const [note, setNote] = useState('')

  const rooms = useQuery({
    queryKey: ['hostel-occupancy'],
    queryFn: () => api.get<List<Room>>('/api/v1/ops/hostel/occupancy'),
  })

  const boarders = useQuery({
    queryKey: ['hostel-boarders', openRoom?.room_id],
    queryFn: () => api.get<List<Boarder>>(`/api/v1/ops/hostel/rooms/${openRoom!.room_id}/boarders`),
    enabled: !!openRoom,
  })

  const candidates = useQuery({
    queryKey: ['hostel-candidates', search],
    queryFn: () => api.get<Page<Student>>(`/api/v1/students?q=${encodeURIComponent(search)}&limit=15`),
    enabled: search.trim().length >= 2,
    placeholderData: keepPreviousData,
  })

  const allocate = useMutation({
    mutationFn: () =>
      api.post('/api/v1/ops/hostel/allocate', {
        room_id: openRoom!.room_id,
        student_id: studentId,
        bed_no: Number(bedNo) || 0,
      }),
    onSuccess: () => {
      setNote('Bed allocated.')
      setStudentId(''); setBedNo(''); setSearch('')
      qc.invalidateQueries({ queryKey: ['hostel-occupancy'] })
      qc.invalidateQueries({ queryKey: ['hostel-boarders'] })
    },
  })

  const all = rooms.data?.items ?? []
  const beds = all.reduce((n, r) => n + r.beds, 0)
  const filled = all.reduce((n, r) => n + r.occupied, 0)
  const blocks = [...new Set(all.map((r) => r.block))]

  /* Which bed numbers are still free in the open room. Offering a list beats
     a number field: the warden knows the room has four beds, not which of
     them the last three allocations used. */
  const takenBeds = new Set((boarders.data?.items ?? []).map((b) => b.bed_no))
  const freeBeds = openRoom
    ? Array.from({ length: openRoom.beds }, (_, i) => i + 1).filter((n) => !takenBeds.has(n))
    : []

  return (
    <>
      <PageHead
        eyebrow="Operations"
        title="Hostel"
        description="Blocks, rooms and who sleeps where."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Blocks" value={blocks.length} />
          <Stat label="Rooms" value={all.length} />
          <Stat label="Beds filled" value={`${filled} / ${beds}`}
            hint={beds ? `${Math.round((filled / beds) * 100)}% occupancy` : undefined} />
          <Stat label="Free beds" value={beds - filled} />
        </CellGrid>

        <FormNotice error={allocate.error} ok={note} />

        {rooms.isLoading ? (
          <Loading />
        ) : rooms.error ? (
          <ErrorState error={rooms.error} />
        ) : !all.length ? (
          <Card>
            <div className="p-6">
              <EmptyState title="No rooms set up" body="Add a block and its rooms to start allocating." />
            </div>
          </Card>
        ) : (
          blocks.map((block) => {
            const inBlock = all.filter((r) => r.block === block)
            const floors = [...new Set(inBlock.map((r) => r.floor ?? 0))].sort()
            return (
              <Card key={block}>
                <CardHeader
                  title={block}
                  description={`${inBlock.reduce((n, r) => n + r.occupied, 0)} of ${inBlock.reduce((n, r) => n + r.beds, 0)} beds · ${inBlock[0].gender ?? 'mixed'}`}
                />
                <div className="flex flex-col gap-4 p-5">
                  {floors.map((f) => (
                    <div key={f}>
                      <p className="eyebrow mb-2">Floor {f}</p>
                      <div className="flex flex-wrap gap-2">
                        {inBlock.filter((r) => (r.floor ?? 0) === f).map((r) => {
                          const full = r.free === 0
                          const open = openRoom?.room_id === r.room_id
                          return (
                            <button
                              key={r.room_id}
                              onClick={() => { setOpenRoom(open ? null : r); setNote('') }}
                              aria-pressed={open}
                              className={cn(
                                'w-[92px] rounded-[8px] border px-2.5 py-2 text-left transition-colors duration-100',
                                open
                                  ? 'border-primary bg-nav-active'
                                  : 'hover:bg-surface-hover',
                              )}
                            >
                              <span className="block text-[14px] font-medium">{r.room_no}</span>
                              <span
                                className={cn(
                                  'block text-[12px] tabular-nums',
                                  full ? 'text-muted-foreground' : 'text-success',
                                )}
                              >
                                {r.occupied}/{r.beds}
                                {!full && ' free'}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )
          })
        )}

        {openRoom && (
          <Card>
            <CardHeader
              title={`${openRoom.block} · Room ${openRoom.room_no}`}
              description={`${openRoom.occupied} of ${openRoom.beds} beds taken`}
              action={<Button variant="ghost" onClick={() => setOpenRoom(null)}>Close</Button>}
            />
            {boarders.isLoading ? (
              <Loading />
            ) : (
              <Table
                head={['Bed', 'Student', 'Admission no.', 'Class', 'Since']}
                empty={!boarders.data?.items.length}
                emptyLabel="Nobody is in this room yet."
              >
                {(boarders.data?.items ?? []).map((b) => (
                  <tr key={b.allocation_id}>
                    <Td className="tabular-nums">{b.bed_no}</Td>
                    <Td className="font-medium">{b.name}</Td>
                    <Td className="font-mono text-[12px]">{b.admission_no}</Td>
                    <Td className="text-muted-foreground">{b.class_name || '—'}</Td>
                    <Td className="text-muted-foreground">{formatDate(b.allocated_on)}</Td>
                  </tr>
                ))}
              </Table>
            )}

            {mayAllocate && freeBeds.length > 0 && (
              <div className="border-t p-5">
                <p className="eyebrow mb-3">Allocate a bed</p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <label className="flex flex-col gap-1.5 text-[13px]">
                    <span className="text-muted-foreground">Find a student</span>
                    <Input value={search} onChange={setSearch} placeholder="Name or admission no." />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px]">
                    <span className="text-muted-foreground">Student</span>
                    <Select
                      value={studentId}
                      onChange={setStudentId}
                      placeholder={search.trim().length < 2 ? 'Search first…' : 'Select…'}
                      options={(candidates.data?.items ?? []).map((s) => ({
                        value: s.id,
                        label: `${s.full_name} · ${s.admission_no}`,
                      }))}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px]">
                    <span className="text-muted-foreground">Bed</span>
                    <Select
                      value={bedNo}
                      onChange={setBedNo}
                      placeholder="Free beds…"
                      options={freeBeds.map((n) => ({ value: String(n), label: `Bed ${n}` }))}
                    />
                  </label>
                </div>
                <div className="mt-4">
                  <Button
                    disabled={!studentId || !bedNo || allocate.isPending}
                    onClick={() => allocate.mutate()}
                  >
                    {allocate.isPending ? 'Allocating…' : 'Allocate'}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}
      </PageBody>
    </>
  )
}
