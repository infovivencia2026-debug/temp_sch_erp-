import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, UserX } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Select, FormNotice, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'

/* Night prep.

   Not the school register and not the morning roll call: a boarder can be in
   the building and absent from the study hall, and that gap is the only reason
   a warden takes this at all.

   The sheet arrives with every current boarder on it, marked or not. A
   register that shows only what has been ticked cannot answer the question
   asked at nine o'clock, which is who is missing. Anyone the gate has signed
   out on an outpass is called out here, because marking them absent would
   start a search for a child the warden released themselves. */

interface Mark {
  student_id: string
  student_name: string
  admission_no: string
  block: string
  room_no: string
  id?: string
  status: string
  minutes_late?: number
  remarks?: string
  hall?: string
  marked_at?: string
  marked_by?: string
  on_outpass: boolean
}

const STATUSES = [
  { value: 'present', label: 'Present' },
  { value: 'late', label: 'Late' },
  { value: 'absent', label: 'Absent' },
  { value: 'excused', label: 'Excused' },
  { value: 'sick_bay', label: 'Sick bay' },
  { value: 'on_outpass', label: 'On outpass' },
]

const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  present: 'success',
  late: 'warning',
  absent: 'danger',
  excused: 'neutral',
  sick_bay: 'neutral',
  on_outpass: 'neutral',
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

interface Draft {
  status: string
  minutes_late: string
  remarks: string
}

export default function HostelNightStudy() {
  const qc = useQueryClient()
  const [date, setDate] = useState(today())
  const [session, setSession] = useState('night')
  const [hall, setHall] = useState('')
  const [draft, setDraft] = useState<Record<string, Draft>>({})

  const list = useQuery({
    queryKey: ['night-study', date, session],
    queryFn: () =>
      api.get<List<Mark>>(`/api/v1/ops/hostel/night-study?on_date=${date}&session=${session}`),
  })
  const save = useMutation({
    mutationFn: (marks: unknown[]) =>
      api.post('/api/v1/ops/hostel/night-study', {
        on_date: date,
        session,
        hall: hall || undefined,
        marks,
      }),
    onSuccess: () => {
      setDraft({})
      qc.invalidateQueries({ queryKey: ['night-study'] })
    },
  })

  if (list.isLoading) return <SkeletonTiles count={4} label="Loading the prep register…" />
  if (list.error) return <ErrorState error={list.error} />

  const rows = list.data?.items ?? []
  const valueFor = (r: Mark): Draft =>
    draft[r.student_id] ?? {
      status: r.status || (r.on_outpass ? 'on_outpass' : ''),
      minutes_late: r.minutes_late != null ? String(r.minutes_late) : '',
      remarks: r.remarks ?? '',
    }

  const marked = rows.filter((r) => r.status).length
  const missing = rows.filter((r) => r.status === 'absent').length
  const late = rows.filter((r) => r.status === 'late').length
  const unmarked = rows.length - marked

  const set = (id: string, patch: Partial<Draft>, base: Draft) =>
    setDraft((d) => ({ ...d, [id]: { ...base, ...patch } }))

  // An excusal with no reason is refused by the server; the button says so
  // rather than letting the warden save forty rows and lose the lot.
  const unjustified = Object.values(draft).some(
    (d) => d.status === 'excused' && d.remarks.trim() === '',
  )

  const submit = () =>
    save.mutate(
      Object.entries(draft)
        .filter(([, d]) => d.status !== '')
        .map(([student_id, d]) => ({
          student_id,
          status: d.status,
          minutes_late: d.minutes_late ? Number(d.minutes_late) : undefined,
          remarks: d.remarks || undefined,
        })),
    )

  return (
    <>
      <PageHead
        eyebrow="Hostel"
        title="Night study attendance"
        description="Who sat in prep, who did not, and who the gate had already let out."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Boarders on the sheet" value={rows.length} icon={BookOpen} period={date} />
          <Stat
            label="Not yet marked"
            value={unmarked}
            hint={unmarked ? 'The register is not finished' : 'Everyone accounted for'}
          />
          <Stat
            label="Absent"
            value={missing}
            icon={UserX}
            delta={
              missing
                ? { value: 'Somebody should go and look', positive: false }
                : { value: 'Nobody missing from prep', positive: true }
            }
          />
          <Stat label="Late" value={late} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Prep register"
            description="Every current boarder, marked or not. A sheet that shows only the ticks cannot tell you who is missing."
            action={
              <span className="flex flex-wrap items-center gap-2">
                <Input type="date" value={date} onChange={setDate} />
                <Select
                  value={session}
                  onChange={setSession}
                  options={[
                    { value: 'evening', label: 'Evening sitting' },
                    { value: 'night', label: 'Night sitting' },
                  ]}
                />
                <Input value={hall} onChange={setHall} placeholder="Prep hall" />
              </span>
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No boarders allocated"
              body="Children appear here once they have been given a bed in the hostel."
            />
          ) : (
            <>
              <Table head={['Boarder', 'Room', 'Mark', 'Late by', 'Reason', 'Last marked']}>
                {rows.map((r) => {
                  const v = valueFor(r)
                  return (
                    <tr key={r.student_id}>
                      <Td className="font-medium">
                        {r.student_name}
                        <div className="text-[12px] font-normal text-muted-foreground">
                          {r.admission_no}
                        </div>
                        {r.on_outpass && (
                          <div className="text-[12px] text-[hsl(var(--warning))]">
                            Signed out on an outpass
                          </div>
                        )}
                      </Td>
                      <Td className="text-muted-foreground">
                        {r.block}
                        <div className="text-[12px]">Room {r.room_no}</div>
                      </Td>
                      <Td>
                        <Select
                          value={v.status}
                          onChange={(s) => set(r.student_id, { status: s }, v)}
                          placeholder="Not marked"
                          options={STATUSES}
                        />
                        {r.status && !draft[r.student_id] && (
                          <div className="mt-1">
                            <Badge tone={TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
                          </div>
                        )}
                      </Td>
                      <Td>
                        {v.status === 'late' ? (
                          <Input
                            value={v.minutes_late}
                            onChange={(m) => set(r.student_id, { minutes_late: m }, v)}
                            placeholder="min"
                          />
                        ) : (
                          <span className="text-[13px] text-muted-foreground">
                            {r.minutes_late != null ? `${r.minutes_late} min` : '—'}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Input
                          value={v.remarks}
                          onChange={(m) => set(r.student_id, { remarks: m }, v)}
                          placeholder={v.status === 'excused' ? 'Required' : 'Optional'}
                        />
                      </Td>
                      <Td className="text-[12px] text-muted-foreground">
                        {r.marked_at ? `${r.marked_at.slice(11)} · ${r.marked_by ?? ''}` : '—'}
                        {r.hall && <div>{r.hall}</div>}
                      </Td>
                    </tr>
                  )
                })}
              </Table>
              <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
                <Button
                  disabled={save.isPending || Object.keys(draft).length === 0 || unjustified}
                  onClick={submit}
                >
                  {save.isPending
                    ? 'Saving…'
                    : `Save ${Object.keys(draft).length} mark${
                        Object.keys(draft).length === 1 ? '' : 's'
                      }`}
                </Button>
                {Object.keys(draft).length > 0 && (
                  <Button variant="ghost" onClick={() => setDraft({})}>
                    Discard
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() =>
                    setDraft(
                      Object.fromEntries(
                        rows
                          .filter((r) => !r.status && !r.on_outpass)
                          .map((r) => [
                            r.student_id,
                            { status: 'present', minutes_late: '', remarks: '' },
                          ]),
                      ),
                    )
                  }
                >
                  Mark the unmarked present
                </Button>
                {unjustified && (
                  <span className="text-[13px] text-destructive">
                    An excusal needs a reason before it can be saved.
                  </span>
                )}
              </div>
            </>
          )}
          <FormNotice error={save.error} />
        </Card>
      </PageBody>
    </>
  )
}
