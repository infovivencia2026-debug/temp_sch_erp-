import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, DoorOpen, Users } from 'lucide-react'
import { api, type List, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea, Checkbox,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'

/* Relatives visiting a boarder.

   This is not a second gate register. The pass is issued into the school's own
   visitor book — the same one the front desk writes to and the same block list
   it checks — because a warden signing in a boarder's uncle at six in the
   evening is the same physical event as reception signing in a supplier at
   eleven in the morning. Two books would mean a relative barred by a custody
   order refused at the gate and admitted at the hostel, which is the exact
   failure the block list exists to prevent.

   What this screen adds is the part the front desk has no column for: which
   boarder, the claimed relationship, the warden who allowed it, and whether
   the child physically left with the visitor. That last one is the difference
   between a visit and a collection. */

interface Visit {
  id: string
  pass_no: string
  visitor_name: string
  phone?: string
  relationship: string
  student_id: string
  student_name: string
  admission_no: string
  block?: string
  room_no?: string
  in_at: string
  out_at?: string
  met_in?: string
  boarder_released: boolean
  expected_back?: string
  returned_at?: string
  permitted_by?: string
  on_site: boolean
  overdue: boolean
  remarks?: string
}

const ID_TYPES = ['Aadhaar', 'Driving licence', 'Voter ID', 'PAN', 'Passport', 'Other']

function today() {
  return new Date().toISOString().slice(0, 10)
}

function clock(iso?: string) {
  return iso ? iso.slice(11) : '—'
}

export default function HostelVisitors() {
  const qc = useQueryClient()
  const [date, setDate] = useState(today())
  const [onSite, setOnSite] = useState(false)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    student_id: '',
    full_name: '',
    relationship: '',
    phone: '',
    id_type: 'Aadhaar',
    id_last4: '',
    met_in: '',
    boarder_released: false,
    expected_back: '',
    remarks: '',
  })

  const students = useQuery({
    queryKey: ['students', 'hostel-visitors'],
    queryFn: () => api.get<List<Student>>('/api/v1/students?limit=300'),
  })
  const list = useQuery({
    queryKey: ['hostel-visits', date, onSite],
    queryFn: () =>
      api.get<List<Visit>>(`/api/v1/ops/hostel/visits?on_date=${date}&on_site=${onSite}`),
  })
  const signIn = useMutation({
    mutationFn: () =>
      api.post('/api/v1/ops/hostel/visits', {
        ...form,
        expected_back: form.expected_back || undefined,
      }),
    onSuccess: () => {
      setOpen(false)
      setForm({ ...form, full_name: '', relationship: '', phone: '', id_last4: '',
        boarder_released: false, expected_back: '', remarks: '' })
      qc.invalidateQueries({ queryKey: ['hostel-visits'] })
    },
  })
  const signOut = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/ops/hostel/visits/${id}/out`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hostel-visits'] }),
  })

  if (list.isLoading) return <Loading label="Loading the visitor log…" />
  if (list.error) return <ErrorState error={list.error} />

  const rows = list.data?.items ?? []
  const inside = rows.filter((v) => v.on_site)
  const out = rows.filter((v) => v.boarder_released && !v.returned_at)
  const overdue = rows.filter((v) => v.overdue)

  return (
    <>
      <PageHead
        eyebrow="Hostel"
        title="Hostel visitor log"
        description="Who came to see a boarder, who let them in, and whether the child left with them."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Visits today" value={rows.length} icon={Users} period={date} />
          <Stat label="Still on the premises" value={inside.length} icon={DoorOpen} />
          <Stat label="Boarders out with a relative" value={out.length} />
          <Stat
            label="Past their return hour"
            value={overdue.length}
            icon={AlertTriangle}
            delta={
              overdue.length
                ? { value: 'Ring the number on the pass', positive: false }
                : { value: 'Everyone back on time', positive: true }
            }
          />
        </CellGrid>

        {overdue.length > 0 && (
          <Card>
            <CardHeader
              title="Overdue"
              description="A boarder released to a relative and past the hour they were due back. The number is here so it does not have to be looked up."
            />
            <ul className="divide-y">
              {overdue.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-[14rem] flex-1">
                    <div className="font-medium">
                      {v.student_name}
                      {v.room_no && (
                        <span className="text-muted-foreground"> · Room {v.room_no}</span>
                      )}
                    </div>
                    <div className="text-[13px] text-muted-foreground">
                      With {v.visitor_name} ({v.relationship})
                      {v.phone && ` · ${v.phone}`} · due back {clock(v.expected_back)}
                    </div>
                  </div>
                  <Badge tone="danger">Not back</Badge>
                  <Button size="sm" disabled={signOut.isPending} onClick={() => signOut.mutate(v.id)}>
                    Both back
                  </Button>
                </li>
              ))}
            </ul>
            <FormNotice error={signOut.error} />
          </Card>
        )}

        <Card>
          <CardHeader
            title="Visitors"
            description="The pass goes into the school's own visitor book, so the gate and the hostel read one list and check one block list."
            action={
              <span className="flex flex-wrap items-center gap-2">
                <Input type="date" value={date} onChange={setDate} />
                <Button
                  size="sm"
                  variant={onSite ? 'primary' : 'secondary'}
                  onClick={() => setOnSite((v) => !v)}
                >
                  {onSite ? 'Showing those still here' : 'Still here'}
                </Button>
                <Button size="sm" onClick={() => setOpen((v) => !v)}>
                  {open ? 'Close' : 'Sign a visitor in'}
                </Button>
              </span>
            }
          />
          {open && (
            <div className="space-y-4 px-4 pb-4">
              <FormGrid>
                <Field label="Boarder" required>
                  <Select
                    value={form.student_id}
                    onChange={(v) => setForm({ ...form, student_id: v })}
                    placeholder="Choose a boarder"
                    options={(students.data?.items ?? []).map((s) => ({
                      value: s.id,
                      label: `${s.full_name} · ${s.admission_no}`,
                    }))}
                  />
                </Field>
                <Field label="Visitor" required>
                  <Input
                    value={form.full_name}
                    onChange={(v) => setForm({ ...form, full_name: v })}
                    placeholder="Ramesh Kumar"
                  />
                </Field>
                <Field label="Related how" required hint="As claimed at the gate">
                  <Input
                    value={form.relationship}
                    onChange={(v) => setForm({ ...form, relationship: v })}
                    placeholder="Uncle"
                  />
                </Field>
                <Field label="Phone">
                  <Input
                    value={form.phone}
                    onChange={(v) => setForm({ ...form, phone: v })}
                    placeholder="98480 12345"
                  />
                </Field>
                <Field label="Identification">
                  <div className="flex gap-2">
                    <Select
                      value={form.id_type}
                      onChange={(v) => setForm({ ...form, id_type: v })}
                      options={ID_TYPES.map((x) => ({ value: x, label: x }))}
                    />
                    <Input
                      value={form.id_last4}
                      onChange={(v) => setForm({ ...form, id_last4: v })}
                      placeholder="Last 4 digits"
                    />
                  </div>
                </Field>
                <Field label="Met in">
                  <Input
                    value={form.met_in}
                    onChange={(v) => setForm({ ...form, met_in: v })}
                    placeholder="Visitors' parlour"
                  />
                </Field>
                {form.boarder_released && (
                  <Field
                    label="Due back"
                    required
                    hint="A child let off the premises with no hour named is discovered missing at lights-out"
                  >
                    <Input
                      type="datetime-local"
                      value={form.expected_back}
                      onChange={(v) => setForm({ ...form, expected_back: v })}
                    />
                  </Field>
                )}
                <Field label="Remarks" wide>
                  <Textarea
                    rows={2}
                    value={form.remarks}
                    onChange={(v) => setForm({ ...form, remarks: v })}
                  />
                </Field>
              </FormGrid>
              <Checkbox
                checked={form.boarder_released}
                onChange={(v) => setForm({ ...form, boarder_released: v })}
                label="The boarder is going out with them"
                hint="Leaving this unticked means the visit happens on the premises."
              />
              <div className="flex items-center gap-2">
                <Button
                  disabled={
                    signIn.isPending ||
                    !form.student_id ||
                    form.full_name.trim() === '' ||
                    form.relationship.trim() === '' ||
                    (form.boarder_released && form.expected_back === '')
                  }
                  onClick={() => signIn.mutate()}
                >
                  {signIn.isPending ? 'Issuing…' : 'Issue a pass'}
                </Button>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
              <FormNotice error={signIn.error} />
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState
              title="No visitors"
              body={`Nobody has come to see a boarder on ${date}.`}
            />
          ) : (
            <Table head={['Pass', 'Visitor', 'Boarder', 'In', 'Out', 'Child released', '']}>
              {rows.map((v) => (
                <tr key={v.id}>
                  <Td className="font-mono text-[13px]">{v.pass_no}</Td>
                  <Td className="font-medium">
                    {v.visitor_name}
                    <div className="text-[12px] font-normal text-muted-foreground">
                      {v.relationship}
                      {v.phone && ` · ${v.phone}`}
                    </div>
                    {v.permitted_by && (
                      <div className="text-[12px] text-muted-foreground">
                        Allowed by {v.permitted_by}
                      </div>
                    )}
                  </Td>
                  <Td>
                    {v.student_name}
                    <div className="text-[12px] text-muted-foreground">
                      {v.admission_no}
                      {v.room_no && ` · Room ${v.room_no}`}
                    </div>
                    {v.met_in && <div className="text-[12px] text-muted-foreground">{v.met_in}</div>}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{clock(v.in_at)}</Td>
                  <Td className="tabular-nums text-muted-foreground">{clock(v.out_at)}</Td>
                  <Td>
                    {v.boarder_released ? (
                      v.returned_at ? (
                        <Badge tone="success">Back {clock(v.returned_at)}</Badge>
                      ) : v.overdue ? (
                        <Badge tone="danger">Overdue since {clock(v.expected_back)}</Badge>
                      ) : (
                        <Badge tone="warning">Out, due {clock(v.expected_back)}</Badge>
                      )
                    ) : (
                      <span className="text-[13px] text-muted-foreground">On the premises</span>
                    )}
                  </Td>
                  <Td>
                    {v.on_site && (
                      <Button
                        size="sm"
                        disabled={signOut.isPending}
                        onClick={() => signOut.mutate(v.id)}
                      >
                        {v.boarder_released ? 'Both back' : 'Sign out'}
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <FormNotice error={signOut.error} />
        </Card>
      </PageBody>
    </>
  )
}
