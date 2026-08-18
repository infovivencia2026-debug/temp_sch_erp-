import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Shirt } from 'lucide-react'
import { api, type List, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'

/* Laundry.

   Petty until a boarder's blazer goes missing the week before a board exam, at
   which point the school is asked for the token number.

   Counted out and counted back in. The status is worked out from the two
   counts rather than chosen: a warden who takes back nine of ten shirts and
   ticks "returned" has recorded the opposite of what happened, and the tenth
   shirt is the only thing anybody will ask about. */

interface Bundle {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  block?: string
  room_no?: string
  token_no: string
  vendor?: string
  sent_on: string
  due_on?: string
  items_sent: number
  item_detail?: string
  returned_on?: string
  items_returned?: number
  status: 'sent' | 'returned' | 'short' | 'lost'
  charge_paise: number
  damage_note?: string
  overdue: boolean
}

const TONE: Record<Bundle['status'], 'neutral' | 'success' | 'warning' | 'danger'> = {
  sent: 'neutral',
  returned: 'success',
  short: 'warning',
  lost: 'danger',
}

const STATUS_LABEL: Record<Bundle['status'], string> = {
  sent: 'Out',
  returned: 'All back',
  short: 'Came back short',
  lost: 'Nothing came back',
}

export default function HostelLaundry() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState(false)
  const [counting, setCounting] = useState<string | null>(null)
  const [back, setBack] = useState({ items_returned: '', damage_note: '' })
  const [form, setForm] = useState({
    student_id: '',
    token_no: '',
    vendor: '',
    sent_on: '',
    due_on: '',
    items_sent: '',
    item_detail: '',
    charge_rupees: '',
  })

  const students = useQuery({
    queryKey: ['students', 'laundry'],
    queryFn: () => api.get<List<Student>>('/api/v1/students?limit=300'),
  })
  const list = useQuery({
    queryKey: ['laundry', status],
    queryFn: () => api.get<List<Bundle>>(`/api/v1/ops/hostel/laundry?status=${status}`),
  })
  const send = useMutation({
    mutationFn: () =>
      api.post('/api/v1/ops/hostel/laundry', {
        student_id: form.student_id,
        token_no: form.token_no,
        vendor: form.vendor || undefined,
        sent_on: form.sent_on || undefined,
        due_on: form.due_on || undefined,
        items_sent: Number(form.items_sent || 0),
        item_detail: form.item_detail || undefined,
        // Rupees on the form, paise on the wire.
        charge_paise: Math.round(Number(form.charge_rupees || 0) * 100),
      }),
    onSuccess: () => {
      setOpen(false)
      setForm({ ...form, token_no: '', items_sent: '', item_detail: '', charge_rupees: '' })
      qc.invalidateQueries({ queryKey: ['laundry'] })
    },
  })
  const receive = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/ops/hostel/laundry/${id}/return`, {
        items_returned: Number(back.items_returned || 0),
        damage_note: back.damage_note || undefined,
      }),
    onSuccess: () => {
      setCounting(null)
      setBack({ items_returned: '', damage_note: '' })
      qc.invalidateQueries({ queryKey: ['laundry'] })
    },
  })

  if (list.isLoading) return <Loading label="Loading the laundry book…" />
  if (list.error) return <ErrorState error={list.error} />

  const rows = list.data?.items ?? []
  const out = rows.filter((b) => b.status === 'sent')
  const overdue = rows.filter((b) => b.overdue)
  const missing = rows.filter((b) => b.status === 'short' || b.status === 'lost')
  const pieces = out.reduce((n, b) => n + b.items_sent, 0)

  const bundle = rows.find((b) => b.id === counting)
  const short = bundle != null && Number(back.items_returned || 0) < bundle.items_sent

  return (
    <>
      <PageHead
        eyebrow="Hostel"
        title="Boarder laundry"
        description="Counted out under a token, counted back in against it."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Bundles out" value={out.length} icon={Shirt} />
          <Stat label="Pieces with the dhobi" value={pieces} />
          <Stat
            label="Past their due date"
            value={overdue.length}
            icon={AlertTriangle}
            hint={overdue.length ? 'Chase the vendor' : 'Nothing late'}
          />
          <Stat
            label="Short or lost"
            value={missing.length}
            hint={missing.length ? 'Each one has a note saying what is missing' : 'Nothing missing'}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Laundry book"
            description="Still out first, so the bundle nobody has chased is the first thing on the page."
            action={
              <span className="flex items-center gap-2">
                <Select
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: '', label: 'All' },
                    { value: 'sent', label: 'Still out' },
                    { value: 'returned', label: 'All back' },
                    { value: 'short', label: 'Came back short' },
                    { value: 'lost', label: 'Lost' },
                  ]}
                />
                <Button size="sm" onClick={() => setOpen((v) => !v)}>
                  {open ? 'Close' : 'Send a bundle'}
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
                <Field label="Token number" required hint="What is on the tag the boarder keeps">
                  <Input
                    value={form.token_no}
                    onChange={(v) => setForm({ ...form, token_no: v })}
                    placeholder="L-0147"
                  />
                </Field>
                <Field label="Pieces going out" required>
                  <Input
                    value={form.items_sent}
                    onChange={(v) => setForm({ ...form, items_sent: v })}
                    placeholder="10"
                  />
                </Field>
                <Field label="Vendor">
                  <Input
                    value={form.vendor}
                    onChange={(v) => setForm({ ...form, vendor: v })}
                    placeholder="Sri Sai Dhobi"
                  />
                </Field>
                <Field label="Sent on">
                  <Input
                    type="date"
                    value={form.sent_on}
                    onChange={(v) => setForm({ ...form, sent_on: v })}
                  />
                </Field>
                <Field label="Due back">
                  <Input
                    type="date"
                    value={form.due_on}
                    onChange={(v) => setForm({ ...form, due_on: v })}
                  />
                </Field>
                <Field label="Charge (₹)">
                  <Input
                    value={form.charge_rupees}
                    onChange={(v) => setForm({ ...form, charge_rupees: v })}
                    placeholder="120"
                  />
                </Field>
                <Field label="What is in it" wide hint="The list a missing blazer is argued from">
                  <Textarea
                    rows={2}
                    value={form.item_detail}
                    onChange={(v) => setForm({ ...form, item_detail: v })}
                    placeholder="4 shirts, 3 trousers, 2 towels, 1 blazer"
                  />
                </Field>
              </FormGrid>
              <div className="flex items-center gap-2">
                <Button
                  disabled={
                    send.isPending ||
                    !form.student_id ||
                    form.token_no.trim() === '' ||
                    Number(form.items_sent || 0) <= 0
                  }
                  onClick={() => send.mutate()}
                >
                  {send.isPending ? 'Saving…' : 'Send bundle'}
                </Button>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
              <FormNotice error={send.error} />
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState
              title="Nothing in the book"
              body="Send a bundle out under a token so there is something to count back in."
            />
          ) : (
            <Table head={['Token', 'Boarder', 'Sent', 'Out', 'Back', 'Status', '']}>
              {rows.map((b) => (
                <tr key={b.id}>
                  <Td className="font-mono text-[13px]">
                    {b.token_no}
                    {b.vendor && (
                      <div className="font-sans text-[12px] text-muted-foreground">{b.vendor}</div>
                    )}
                  </Td>
                  <Td className="font-medium">
                    {b.student_name}
                    <div className="text-[12px] font-normal text-muted-foreground">
                      {b.admission_no}
                      {b.room_no && ` · Room ${b.room_no}`}
                    </div>
                  </Td>
                  <Td className="text-muted-foreground">
                    {formatDate(b.sent_on)}
                    {b.due_on && (
                      <div className={b.overdue ? 'text-[12px] text-destructive' : 'text-[12px]'}>
                        Due {formatDate(b.due_on)}
                      </div>
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {b.items_sent}
                    {b.item_detail && (
                      <div className="text-[12px] text-muted-foreground">{b.item_detail}</div>
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {b.items_returned != null ? b.items_returned : '—'}
                    {b.returned_on && (
                      <div className="text-[12px] text-muted-foreground">
                        {formatDate(b.returned_on)}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={TONE[b.status]}>{STATUS_LABEL[b.status]}</Badge>
                    {b.damage_note && (
                      <div className="text-[12px] text-muted-foreground">{b.damage_note}</div>
                    )}
                    {b.charge_paise > 0 && (
                      <div className="text-[12px] tabular-nums text-muted-foreground">
                        {formatPaise(b.charge_paise)}
                      </div>
                    )}
                  </Td>
                  <Td>
                    {b.status === 'sent' && counting !== b.id && (
                      <Button
                        size="sm"
                        onClick={() => {
                          setCounting(b.id)
                          setBack({ items_returned: String(b.items_sent), damage_note: '' })
                        }}
                      >
                        Count it back
                      </Button>
                    )}
                    {counting === b.id && (
                      <div className="mt-1 space-y-2">
                        <Input
                          value={back.items_returned}
                          onChange={(v) => setBack({ ...back, items_returned: v })}
                          placeholder={`of ${b.items_sent}`}
                        />
                        {short && (
                          <Input
                            value={back.damage_note}
                            onChange={(v) => setBack({ ...back, damage_note: v })}
                            placeholder="What is missing"
                          />
                        )}
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            disabled={
                              receive.isPending ||
                              back.items_returned === '' ||
                              (short && back.damage_note.trim() === '')
                            }
                            onClick={() => receive.mutate(b.id)}
                          >
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setCounting(null)}>
                            Cancel
                          </Button>
                        </div>
                        {short && back.damage_note.trim() === '' && (
                          <p className="text-[12px] text-destructive">
                            Say what is missing — a bundle counted back short with no note is an
                            argument the warden loses next week.
                          </p>
                        )}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <FormNotice error={receive.error} />
        </Card>
      </PageBody>
    </>
  )
}
