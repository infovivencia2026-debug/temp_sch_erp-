import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, IndianRupee, Trash2 } from 'lucide-react'
import { api, type List, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea, Checkbox,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'

/* The room handover.

   A boarder is shown a room with four chairs and two fans at check-in and
   billed for what is missing at check-out, so both inspections are the same
   shape and the same list.

   The charge is per line rather than a total, because a family disputing a
   bill disputes one broken chair: a single figure gives them nothing to argue
   with and the school nothing to justify. A line with a charge and no
   description is refused outright. */

interface Check {
  id: string
  room_id: string
  block: string
  room_no: string
  student_id?: string
  student_name?: string
  admission_no?: string
  kind: string
  on_date: string
  checked_by?: string
  boarder_signed: boolean
  remarks?: string
  items: number
  faults: number
  charge_paise: number
}

interface Line {
  id: string
  item: string
  expected: number
  found: number
  condition: string
  damage_note?: string
  charge_paise: number
}

interface Room {
  room_id: string
  block: string
  room_no: string
  beds: number
  occupied: number
}

const KINDS = [
  { value: 'check_in', label: 'Check-in' },
  { value: 'check_out', label: 'Check-out' },
  { value: 'routine', label: 'Routine walk' },
]

const CONDITIONS = [
  { value: 'good', label: 'Good' },
  { value: 'worn', label: 'Worn' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'missing', label: 'Missing' },
]

const CONDITION_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = {
  good: 'neutral',
  worn: 'warning',
  damaged: 'danger',
  missing: 'danger',
}

// What is actually screwed to the wall of an Indian hostel room. A starting
// list, not a fixture: every school adds and removes from it.
const DEFAULT_LIST = [
  'Cot', 'Mattress', 'Study table', 'Study chair', 'Almirah', 'Ceiling fan',
  'Tube light', 'Window pane', 'Door latch', 'Power socket', 'Curtain', 'Dustbin',
]

interface Draft {
  item: string
  expected: string
  found: string
  condition: string
  damage_note: string
  charge_rupees: string
}

const blankLine = (item = ''): Draft => ({
  item,
  expected: '1',
  found: '1',
  condition: 'good',
  damage_note: '',
  charge_rupees: '',
})

export default function HostelRoomChecks() {
  const qc = useQueryClient()
  const [kind, setKind] = useState('')
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [head, setHead] = useState({
    room_id: '',
    student_id: '',
    kind: 'check_in',
    on_date: '',
    boarder_signed: false,
    remarks: '',
  })
  const [lines, setLines] = useState<Draft[]>(DEFAULT_LIST.slice(0, 6).map(blankLine))

  const rooms = useQuery({
    queryKey: ['hostel-occupancy'],
    queryFn: () => api.get<List<Room>>('/api/v1/ops/hostel/occupancy'),
  })
  const students = useQuery({
    queryKey: ['students', 'room-checks'],
    queryFn: () => api.get<List<Student>>('/api/v1/students?limit=300'),
  })
  const list = useQuery({
    queryKey: ['room-checks', kind],
    queryFn: () => api.get<List<Check>>(`/api/v1/ops/hostel/room-checks?kind=${kind}`),
  })

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/ops/hostel/room-checks', {
        ...head,
        on_date: head.on_date || undefined,
        student_id: head.student_id || undefined,
        items: lines
          .filter((l) => l.item.trim() !== '')
          .map((l) => ({
            item: l.item,
            expected: Number(l.expected || 1),
            found: Number(l.found || 0),
            condition: l.condition,
            damage_note: l.damage_note || undefined,
            // Rupees on the form, paise on the wire: the schema stores money
            // as bigint paise everywhere and a float never touches it.
            charge_paise: Math.round(Number(l.charge_rupees || 0) * 100),
          })),
      }),
    onSuccess: () => {
      setOpen(false)
      qc.invalidateQueries({ queryKey: ['room-checks'] })
    },
  })

  if (list.isLoading) return <Loading label="Loading inspections…" />
  if (list.error) return <ErrorState error={list.error} />

  const rows = list.data?.items ?? []
  const recoverable = rows.reduce((n, c) => n + c.charge_paise, 0)
  const faults = rows.reduce((n, c) => n + c.faults, 0)
  const unsigned = rows.filter((c) => c.student_id && !c.boarder_signed).length

  const setLine = (i: number, patch: Partial<Draft>) =>
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)))

  // The server refuses a charge with no description; the form says so first so
  // a whole checklist is not rejected after the boarder has walked away.
  const unexplained = lines.some(
    (l) => Number(l.charge_rupees || 0) > 0 && l.damage_note.trim() === '',
  )

  return (
    <>
      <PageHead
        eyebrow="Hostel"
        title="Room inventory checklists"
        description="What was in the room when the boarder moved in, and what was there when they moved out."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Inspections" value={rows.length} icon={ClipboardCheck} />
          <Stat label="Items damaged or missing" value={faults} />
          <Stat
            label="Recoverable"
            value={formatPaise(recoverable)}
            icon={IndianRupee}
            hint="Charged per line, never as a lump sum"
          />
          <Stat
            label="Not signed by the boarder"
            value={unsigned}
            hint={unsigned ? 'A charge here is hard to defend' : 'Every sheet agreed'}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Inspections"
            description="Check-in and check-out use the same list, so the two can be read against each other."
            action={
              <span className="flex items-center gap-2">
                <Select
                  value={kind}
                  onChange={setKind}
                  options={[{ value: '', label: 'All' }, ...KINDS]}
                />
                <Button size="sm" onClick={() => setOpen((v) => !v)}>
                  {open ? 'Close' : 'Walk a room'}
                </Button>
              </span>
            }
          />
          {open && (
            <div className="space-y-4 px-4 pb-4">
              <FormGrid>
                <Field label="Room" required>
                  <Select
                    value={head.room_id}
                    onChange={(v) => setHead({ ...head, room_id: v })}
                    placeholder="Choose a room"
                    options={(rooms.data?.items ?? []).map((r) => ({
                      value: r.room_id,
                      label: `${r.block} · Room ${r.room_no} (${r.occupied}/${r.beds})`,
                    }))}
                  />
                </Field>
                <Field
                  label="Boarder"
                  hint="Leave blank for a walk of an empty room between terms"
                >
                  <Select
                    value={head.student_id}
                    onChange={(v) => setHead({ ...head, student_id: v })}
                    placeholder="No boarder"
                    options={(students.data?.items ?? []).map((s) => ({
                      value: s.id,
                      label: `${s.full_name} · ${s.admission_no}`,
                    }))}
                  />
                </Field>
                <Field label="Kind" required>
                  <Select
                    value={head.kind}
                    onChange={(v) => setHead({ ...head, kind: v })}
                    options={KINDS}
                  />
                </Field>
                <Field label="Date">
                  <Input
                    type="date"
                    value={head.on_date}
                    onChange={(v) => setHead({ ...head, on_date: v })}
                  />
                </Field>
                <Field label="Remarks" wide>
                  <Textarea
                    rows={2}
                    value={head.remarks}
                    onChange={(v) => setHead({ ...head, remarks: v })}
                  />
                </Field>
              </FormGrid>

              <div className="space-y-2">
                <p className="text-[13px] font-medium text-secondary-foreground">The list</p>
                <Table
                  head={['Item', 'Should be', 'Found', 'Condition', 'What is wrong with it', '₹', '']}
                >
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <Td>
                        <Input
                          value={l.item}
                          onChange={(v) => setLine(i, { item: v })}
                          list="hostel-fittings"
                          placeholder="Ceiling fan"
                        />
                      </Td>
                      <Td>
                        <Input
                          value={l.expected}
                          onChange={(v) => setLine(i, { expected: v })}
                        />
                      </Td>
                      <Td>
                        <Input value={l.found} onChange={(v) => setLine(i, { found: v })} />
                      </Td>
                      <Td>
                        <Select
                          value={l.condition}
                          onChange={(v) => setLine(i, { condition: v })}
                          options={CONDITIONS}
                        />
                      </Td>
                      <Td>
                        <Input
                          value={l.damage_note}
                          onChange={(v) => setLine(i, { damage_note: v })}
                          placeholder={
                            Number(l.charge_rupees || 0) > 0 ? 'Required to charge' : 'Optional'
                          }
                        />
                      </Td>
                      <Td>
                        <Input
                          value={l.charge_rupees}
                          onChange={(v) => setLine(i, { charge_rupees: v })}
                          placeholder="0"
                        />
                      </Td>
                      <Td>
                        <Button
                          size="sm"
                          variant="ghost"
                          tone="danger"
                          title="Remove this line"
                          onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </Table>
                <datalist id="hostel-fittings">
                  {DEFAULT_LIST.map((x) => (
                    <option key={x} value={x} />
                  ))}
                </datalist>
                <Button size="sm" variant="secondary" onClick={() => setLines([...lines, blankLine()])}>
                  Add a line
                </Button>
              </div>

              <Checkbox
                checked={head.boarder_signed}
                onChange={(v) => setHead({ ...head, boarder_signed: v })}
                label="The boarder has seen and agreed this list"
                hint="A recovery raised against a child who never saw the sheet is the argument this settles."
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={save.isPending || !head.room_id || unexplained}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? 'Saving…' : 'Save the checklist'}
                </Button>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                {unexplained && (
                  <span className="text-[13px] text-destructive">
                    A charge needs a line saying what was broken.
                  </span>
                )}
              </div>
              <FormNotice error={save.error} />
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState
              title="No inspections yet"
              body="Walk a room at check-in so there is something to compare the check-out against."
            />
          ) : (
            <Table head={['Room', 'Boarder', 'Kind', 'Date', 'Lines', 'Recoverable', '']}>
              {rows.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">
                    {c.block}
                    <div className="text-[12px] font-normal text-muted-foreground">
                      Room {c.room_no}
                    </div>
                  </Td>
                  <Td>
                    {c.student_name ?? <span className="text-muted-foreground">Empty room</span>}
                    {c.admission_no && (
                      <div className="text-[12px] text-muted-foreground">{c.admission_no}</div>
                    )}
                    {c.student_id && !c.boarder_signed && (
                      <div className="text-[12px] text-[hsl(var(--warning))]">Not signed</div>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={c.kind === 'check_out' ? 'warning' : 'neutral'}>
                      {KINDS.find((k) => k.value === c.kind)?.label ?? c.kind}
                    </Badge>
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(c.on_date)}</Td>
                  <Td className="tabular-nums">
                    {c.items}
                    {c.faults > 0 && (
                      <div className="text-[12px] text-destructive">{c.faults} at fault</div>
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {c.charge_paise > 0 ? formatPaise(c.charge_paise) : '—'}
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                    >
                      {expanded === c.id ? 'Hide' : 'The list'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {expanded && <Lines checkId={expanded} />}
      </PageBody>
    </>
  )
}

function Lines({ checkId }: { checkId: string }) {
  const q = useQuery({
    queryKey: ['room-check-items', checkId],
    queryFn: () => api.get<List<Line>>(`/api/v1/ops/hostel/room-checks/${checkId}/items`),
  })
  const rows = q.data?.items ?? []

  return (
    <Card>
      <CardHeader
        title="The list"
        description="One line per thing, one charge per line."
      />
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing on this sheet" />
      ) : (
        <Table head={['Item', 'Should be', 'Found', 'Condition', 'What is wrong', 'Charge']}>
          {rows.map((l) => (
            <tr key={l.id}>
              <Td className="font-medium">{l.item}</Td>
              <Td className="tabular-nums text-muted-foreground">{l.expected}</Td>
              <Td className="tabular-nums">{l.found}</Td>
              <Td>
                <Badge tone={CONDITION_TONE[l.condition] ?? 'neutral'}>{l.condition}</Badge>
              </Td>
              <Td className="text-[13px]">{l.damage_note ?? '—'}</Td>
              <Td className="tabular-nums">
                {l.charge_paise > 0 ? formatPaise(l.charge_paise) : '—'}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
