import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Mail, Phone, ShieldBan, UserRound } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Field, FormGrid, FormNotice, Input, Select,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* The front desk.

   Who came in, who rang, what arrived in the post, and who is booked to see
   the principal. Every one of these is a paper register in most Indian
   schools, and every one is asked for after something has gone wrong: who
   signed that man in, who took the call about the fee, where the board's
   envelope went. */

interface Visitor {
  id: string
  pass_no: string
  full_name: string
  phone?: string
  id_type?: string
  id_last4?: string
  purpose: string
  host?: string
  student?: string
  in_at: string
  out_at?: string
  minutes_on_site: number
  inside: boolean
}
interface Block {
  id: string
  full_name: string
  phone?: string
  reason: string
  effective_from: string
  effective_to?: string
  added_by?: string
  in_force: boolean
}
interface Appointment {
  id: string
  with?: string
  student?: string
  visitor_name: string
  phone?: string
  on_date: string
  starts_at: string
  minutes: number
  purpose: string
  status: string
  outcome?: string
}
interface Call {
  id: string
  direction: string
  caller_name: string
  phone?: string
  student?: string
  about: string
  for?: string
  passed_on_at?: string
  action_taken?: string
  at_time: string
  pending: boolean
}
interface Post {
  id: string
  direction: string
  on_date: string
  courier?: string
  tracking_no?: string
  from_party?: string
  to_party?: string
  description: string
  received_by?: string
  handed_over_at?: string
  charges_paise?: number
  undelivered: boolean
}
interface Named {
  id: string
  full_name?: string
  name?: string
}

const TABS = [
  ['visitors', 'Visitors', UserRound],
  ['appointments', 'Appointments', CalendarClock],
  ['calls', 'Calls', Phone],
  ['post', 'Post', Mail],
  ['blocklist', 'Block list', ShieldBan],
] as const

export default function FrontDesk() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('visitors')

  const visitors = useQuery({
    queryKey: ['visitors'],
    queryFn: () => api.get<List<Visitor>>('/api/v1/office/visitors'),
  })
  const calls = useQuery({
    queryKey: ['calls'],
    queryFn: () => api.get<List<Call>>('/api/v1/office/calls?period=this_month'),
  })
  const post = useQuery({
    queryKey: ['courier'],
    queryFn: () => api.get<List<Post>>('/api/v1/office/courier?period=this_month'),
  })

  if (visitors.isLoading) return <Loading label="Opening the desk…" />
  if (visitors.error) return <ErrorState error={visitors.error} />

  const inside = (visitors.data?.items ?? []).filter((v) => v.inside)
  const pending = (calls.data?.items ?? []).filter((c) => c.pending)
  const undelivered = (post.data?.items ?? []).filter((p) => p.undelivered)

  return (
    <>
      <PageHead
        eyebrow="Front office"
        title="The desk"
        description="Who is on the premises, who is booked in, what was said on the telephone and what came in the post."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="On the premises"
            value={inside.length}
            icon={UserRound}
            delta={
              inside.length
                ? { value: 'Not yet signed out', positive: false }
                : { value: 'Everyone signed out', positive: true }
            }
          />
          <Stat label="Visitors today" value={visitors.data?.items.length ?? 0} />
          <Stat label="Messages to pass on" value={pending.length} icon={Phone} />
          <Stat label="Post at the desk" value={undelivered.length} icon={Mail} />
        </CellGrid>

        <div className="flex flex-wrap gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              aria-current={tab === k}
              className={
                tab === k
                  ? '-mb-px flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                  : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'
              }
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {tab === 'visitors' && <Visitors rows={visitors.data?.items ?? []} />}
        {tab === 'appointments' && <Appointments />}
        {tab === 'calls' && <Calls rows={calls.data?.items ?? []} />}
        {tab === 'post' && <PostLog rows={post.data?.items ?? []} />}
        {tab === 'blocklist' && <Blocklist />}
      </PageBody>
    </>
  )
}

function useStaff() {
  return useQuery({
    queryKey: ['employees', 'desk'],
    queryFn: () => api.get<List<Named>>('/api/v1/hr/employees?limit=300'),
  })
}
function useStudents() {
  return useQuery({
    queryKey: ['students', 'desk'],
    queryFn: () => api.get<List<Named>>('/api/v1/students?limit=400'),
  })
}

function Visitors({ rows }: { rows: Visitor[] }) {
  const qc = useQueryClient()
  const staff = useStaff()
  const students = useStudents()
  const [form, setForm] = useState<Record<string, string>>({ id_type: 'Aadhaar' })

  const signIn = useMutation({
    mutationFn: () => api.post<{ pass_no: string }>('/api/v1/office/visitors', form),
    onSuccess: () => {
      setForm({ id_type: form.id_type })
      qc.invalidateQueries({ queryKey: ['visitors'] })
    },
  })
  const signOut = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/office/visitors/${id}/out`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['visitors'] }),
  })

  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })

  return (
    <>
      <Card>
        <CardHeader
          title="Sign somebody in"
          description="The pass number is the day's next, allocated as the pass is issued so two counters cannot hand out the same one. Anyone on the block list is refused here rather than left to memory."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Name" required>
              <Input value={form.full_name ?? ''} onChange={set('full_name')} placeholder="Ramesh Kumar" />
            </Field>
            <Field label="Phone">
              <Input value={form.phone ?? ''} onChange={set('phone')} />
            </Field>
            <Field label="Identification">
              <Select
                value={form.id_type ?? 'Aadhaar'}
                onChange={set('id_type')}
                options={[
                  { value: 'Aadhaar', label: 'Aadhaar' },
                  { value: 'Driving licence', label: 'Driving licence' },
                  { value: 'Voter ID', label: 'Voter ID' },
                  { value: 'Employee ID', label: 'Employee ID' },
                ]}
              />
            </Field>
            <Field label="Last four digits" hint="Only the last four are kept.">
              <Input value={form.id_last4 ?? ''} onChange={set('id_last4')} />
            </Field>
            <Field label="Here to see">
              <Select
                value={form.host_employee_id ?? ''}
                onChange={set('host_employee_id')}
                placeholder="A staff member"
                options={(staff.data?.items ?? []).map((e) => ({
                  value: e.id,
                  label: e.full_name ?? e.name ?? e.id,
                }))}
              />
            </Field>
            <Field label="About which child" hint="Naming the child is what makes an unauthorised pickup visible.">
              <Select
                value={form.student_id ?? ''}
                onChange={set('student_id')}
                placeholder="None"
                options={(students.data?.items ?? []).map((s) => ({
                  value: s.id,
                  label: s.full_name ?? s.id,
                }))}
              />
            </Field>
            <Field label="Purpose" wide required>
              <Input value={form.purpose ?? ''} onChange={set('purpose')} placeholder="Meeting the class teacher" />
            </Field>
          </FormGrid>
          <div className="mt-4 flex items-center gap-3">
            <Button
              disabled={signIn.isPending || !form.full_name?.trim() || !form.purpose?.trim()}
              onClick={() => signIn.mutate()}
            >
              {signIn.isPending ? 'Issuing…' : 'Issue pass'}
            </Button>
            {signIn.isSuccess && signIn.data && (
              <Badge tone="success">Pass {signIn.data.pass_no}</Badge>
            )}
          </div>
          <FormNotice error={signIn.error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Today"
          description="Still inside first, longest first — the order the desk needs at closing time."
        />
        {rows.length === 0 ? (
          <EmptyState title="Nobody yet" body="Passes issued today appear here." />
        ) : (
          <Table
            head={[
              { label: 'Pass' },
              { label: 'Visitor' },
              { label: 'To see' },
              { label: 'In' },
              { label: 'Out' },
              { label: 'On site' },
              { label: '' },
            ]}
          >
            {rows.map((v) => (
              <tr key={v.id}>
                <Td className="font-mono">{v.pass_no}</Td>
                <Td className="font-medium">
                  {v.full_name}
                  <div className="text-[12px] font-normal text-muted-foreground">
                    {v.purpose}
                    {v.phone && ` · ${v.phone}`}
                  </div>
                </Td>
                <Td className="text-muted-foreground">
                  {v.host ?? '—'}
                  {v.student && <div className="text-[12px]">re {v.student}</div>}
                </Td>
                <Td className="tabular-nums text-muted-foreground">{v.in_at.slice(11)}</Td>
                <Td className="tabular-nums text-muted-foreground">{v.out_at?.slice(11) ?? '—'}</Td>
                <Td className="tabular-nums">
                  {v.inside ? (
                    <Badge tone={v.minutes_on_site > 120 ? 'warning' : 'neutral'}>
                      {v.minutes_on_site} min
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">{v.minutes_on_site} min</span>
                  )}
                </Td>
                <Td>
                  {v.inside && (
                    <Button
                      size="sm"
                      disabled={signOut.isPending}
                      onClick={() => signOut.mutate(v.id)}
                    >
                      Sign out
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <FormNotice error={signOut.error} />
      </Card>
    </>
  )
}

function Appointments() {
  const qc = useQueryClient()
  const staff = useStaff()
  const students = useStudents()
  const [form, setForm] = useState<Record<string, string>>({})
  const [closing, setClosing] = useState<string | null>(null)
  const [outcome, setOutcome] = useState('')

  const list = useQuery({
    queryKey: ['appointments'],
    queryFn: () => api.get<List<Appointment>>('/api/v1/office/appointments'),
  })
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post('/api/v1/office/appointments', v),
    onSuccess: () => {
      setClosing(null)
      setForm({})
      qc.invalidateQueries({ queryKey: ['appointments'] })
    },
  })

  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })
  const rows = list.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="Book a meeting"
          description="The point is to stop parents queueing outside the principal's door, so one person cannot be booked twice at one time."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Who is coming" required>
              <Input value={form.visitor_name ?? ''} onChange={set('visitor_name')} placeholder="Lakshmi Menon" />
            </Field>
            <Field label="Phone">
              <Input value={form.phone ?? ''} onChange={set('phone')} />
            </Field>
            <Field label="To see">
              <Select
                value={form.with_employee_id ?? ''}
                onChange={set('with_employee_id')}
                placeholder="A staff member"
                options={(staff.data?.items ?? []).map((e) => ({
                  value: e.id,
                  label: e.full_name ?? e.name ?? e.id,
                }))}
              />
            </Field>
            <Field label="About which child">
              <Select
                value={form.student_id ?? ''}
                onChange={set('student_id')}
                placeholder="None"
                options={(students.data?.items ?? []).map((s) => ({
                  value: s.id,
                  label: s.full_name ?? s.id,
                }))}
              />
            </Field>
            <Field label="Date" required>
              <Input type="date" value={form.on_date ?? ''} onChange={set('on_date')} />
            </Field>
            <Field label="Time" required>
              <Input type="time" value={form.starts_at ?? ''} onChange={set('starts_at')} />
            </Field>
            <Field label="What it is about" wide required>
              <Input value={form.purpose ?? ''} onChange={set('purpose')} placeholder="Discuss falling maths marks" />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button
              disabled={
                save.isPending ||
                !form.visitor_name?.trim() ||
                !form.on_date ||
                !form.starts_at ||
                !form.purpose?.trim()
              }
              onClick={() => save.mutate(form)}
            >
              {save.isPending ? 'Booking…' : 'Book'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="The next thirty days"
          description="A diary looks forward. Every other list here reports on what has happened; this one would be useless if it did."
        />
        {rows.length === 0 ? (
          <EmptyState title="Nothing booked" body="Meetings appear here in date order." />
        ) : (
          <Table
            head={[
              { label: 'When' },
              { label: 'Who' },
              { label: 'With' },
              { label: 'About' },
              { label: 'Status' },
              { label: '' },
            ]}
          >
            {rows.map((a) => (
              <tr key={a.id}>
                <Td className="text-muted-foreground">
                  {formatDate(a.on_date)}
                  <div className="text-[12px] tabular-nums">{a.starts_at}</div>
                </Td>
                <Td className="font-medium">
                  {a.visitor_name}
                  {a.phone && (
                    <div className="text-[12px] font-normal text-muted-foreground">{a.phone}</div>
                  )}
                </Td>
                <Td className="text-muted-foreground">
                  {a.with ?? '—'}
                  {a.student && <div className="text-[12px]">re {a.student}</div>}
                </Td>
                <Td>
                  {a.purpose}
                  {a.outcome && (
                    <div className="text-[12px] text-success">{a.outcome}</div>
                  )}
                </Td>
                <Td>
                  <Badge
                    tone={
                      a.status === 'met'
                        ? 'success'
                        : a.status === 'no_show'
                          ? 'warning'
                          : a.status === 'cancelled'
                            ? 'neutral'
                            : 'neutral'
                    }
                  >
                    {a.status.replace('_', ' ')}
                  </Badge>
                </Td>
                <Td>
                  {a.status === 'booked' && (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        onClick={() => {
                          setClosing(a.id)
                          setOutcome('')
                        }}
                      >
                        Met
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={save.isPending}
                        onClick={() => save.mutate({ id: a.id, status: 'no_show' })}
                      >
                        No show
                      </Button>
                    </div>
                  )}
                  {closing === a.id && (
                    <div className="mt-2 space-y-2">
                      <Input
                        value={outcome}
                        onChange={setOutcome}
                        placeholder="What was agreed"
                      />
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          disabled={save.isPending || outcome.trim() === ''}
                          onClick={() => save.mutate({ id: a.id, status: 'met', outcome })}
                        >
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

function Calls({ rows }: { rows: Call[] }) {
  const qc = useQueryClient()
  const staff = useStaff()
  const students = useStudents()
  const [form, setForm] = useState<Record<string, string>>({ direction: 'in' })

  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post('/api/v1/office/calls', v),
    onSuccess: () => {
      setForm({ direction: form.direction })
      qc.invalidateQueries({ queryKey: ['calls'] })
    },
  })
  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })

  return (
    <>
      <Card>
        <CardHeader
          title="Log a call"
          description="The commonest complaint a school receives is “I rang and told somebody”. Without this the school cannot agree or disagree."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Direction">
              <Select
                value={form.direction ?? 'in'}
                onChange={set('direction')}
                options={[
                  { value: 'in', label: 'Incoming' },
                  { value: 'out', label: 'Outgoing' },
                ]}
              />
            </Field>
            <Field label="Who rang" required>
              <Input value={form.caller_name ?? ''} onChange={set('caller_name')} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone ?? ''} onChange={set('phone')} />
            </Field>
            <Field label="About which child">
              <Select
                value={form.student_id ?? ''}
                onChange={set('student_id')}
                placeholder="None"
                options={(students.data?.items ?? []).map((s) => ({
                  value: s.id,
                  label: s.full_name ?? s.id,
                }))}
              />
            </Field>
            <Field label="Message for">
              <Select
                value={form.for_employee_id ?? ''}
                onChange={set('for_employee_id')}
                placeholder="Nobody in particular"
                options={(staff.data?.items ?? []).map((e) => ({
                  value: e.id,
                  label: e.full_name ?? e.name ?? e.id,
                }))}
              />
            </Field>
            <Field label="What was said" wide required>
              <Input
                value={form.about ?? ''}
                onChange={set('about')}
                placeholder="Child will be absent Thursday for a hospital appointment."
              />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button
              disabled={save.isPending || !form.caller_name?.trim() || !form.about?.trim()}
              onClick={() => save.mutate(form)}
            >
              {save.isPending ? 'Saving…' : 'Log call'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="This month"
          description="Messages that have not reached the person they were for come first — that is the desk's own outstanding work."
        />
        {rows.length === 0 ? (
          <EmptyState title="No calls logged" body="Calls appear here newest first." />
        ) : (
          <Table
            head={[
              { label: 'When' },
              { label: 'Caller' },
              { label: 'About' },
              { label: 'For' },
              { label: '' },
            ]}
          >
            {rows.map((c) => (
              <tr key={c.id}>
                <Td className="text-muted-foreground">
                  {formatDate(c.at_time)}
                  <div className="text-[12px] tabular-nums">{c.at_time.slice(11)}</div>
                </Td>
                <Td className="font-medium">
                  {c.caller_name}
                  <div className="text-[12px] font-normal text-muted-foreground">
                    {c.direction === 'in' ? 'incoming' : 'outgoing'}
                    {c.phone && ` · ${c.phone}`}
                  </div>
                </Td>
                <Td>
                  {c.about}
                  {c.student && (
                    <div className="text-[12px] text-muted-foreground">re {c.student}</div>
                  )}
                  {c.action_taken && (
                    <div className="text-[12px] text-success">{c.action_taken}</div>
                  )}
                </Td>
                <Td className="text-muted-foreground">{c.for ?? '—'}</Td>
                <Td>
                  {c.pending ? (
                    <Button
                      size="sm"
                      disabled={save.isPending}
                      onClick={() => save.mutate({ id: c.id, passed_on: true })}
                    >
                      Passed on
                    </Button>
                  ) : c.passed_on_at ? (
                    <Badge tone="success">Delivered</Badge>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

function PostLog({ rows }: { rows: Post[] }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({ direction: 'in' })
  const [handing, setHanding] = useState<string | null>(null)
  const [receiver, setReceiver] = useState('')

  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post('/api/v1/office/courier', v),
    onSuccess: () => {
      setHanding(null)
      setForm({ direction: form.direction })
      qc.invalidateQueries({ queryKey: ['courier'] })
    },
  })
  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })

  return (
    <>
      <Card>
        <CardHeader
          title="Record post"
          description="Schools lose board correspondence, and only ever discover it later. The register records who physically took it and when."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Direction">
              <Select
                value={form.direction ?? 'in'}
                onChange={set('direction')}
                options={[
                  { value: 'in', label: 'Received' },
                  { value: 'out', label: 'Sent' },
                ]}
              />
            </Field>
            <Field label="Courier">
              <Input value={form.courier ?? ''} onChange={set('courier')} placeholder="India Post" />
            </Field>
            <Field label="Tracking number">
              <Input value={form.tracking_no ?? ''} onChange={set('tracking_no')} />
            </Field>
            <Field label={form.direction === 'out' ? 'To' : 'From'}>
              <Input
                value={(form.direction === 'out' ? form.to_party : form.from_party) ?? ''}
                onChange={set(form.direction === 'out' ? 'to_party' : 'from_party')}
                placeholder="BSE Telangana"
              />
            </Field>
            <Field label="What it is" wide required>
              <Input
                value={form.description ?? ''}
                onChange={set('description')}
                placeholder="SSC hall tickets, sealed packet"
              />
            </Field>
            <Field label="Charges (₹)">
              <Input value={form.charges ?? ''} onChange={set('charges')} type="number" />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button
              disabled={save.isPending || !form.description?.trim()}
              onClick={() =>
                save.mutate({
                  ...form,
                  charges_paise: form.charges ? Math.round(Number(form.charges) * 100) : undefined,
                })
              }
            >
              {save.isPending ? 'Saving…' : 'Record'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="This month"
          description="Anything received and still sitting at the desk comes first."
        />
        {rows.length === 0 ? (
          <EmptyState title="Nothing recorded" body="Inward and outward post appears here." />
        ) : (
          <Table
            head={[
              { label: 'Date' },
              { label: 'What' },
              { label: 'Party' },
              { label: 'Tracking' },
              { label: 'Handed to' },
              { label: '' },
            ]}
          >
            {rows.map((p) => (
              <tr key={p.id}>
                <Td className="text-muted-foreground">{formatDate(p.on_date)}</Td>
                <Td className="font-medium">
                  {p.description}
                  <div className="text-[12px] font-normal text-muted-foreground">
                    {p.direction === 'in' ? 'received' : 'sent'}
                    {p.courier && ` · ${p.courier}`}
                  </div>
                </Td>
                <Td className="text-muted-foreground">{p.from_party ?? p.to_party ?? '—'}</Td>
                <Td className="font-mono text-[12px] text-muted-foreground">
                  {p.tracking_no ?? '—'}
                </Td>
                <Td className="text-muted-foreground">
                  {p.received_by ?? (p.direction === 'in' ? 'Still at the desk' : '—')}
                </Td>
                <Td>
                  {p.undelivered && (
                    <>
                      <Button
                        size="sm"
                        onClick={() => {
                          setHanding(p.id)
                          setReceiver('')
                        }}
                      >
                        Hand over
                      </Button>
                      {handing === p.id && (
                        <div className="mt-2 space-y-2">
                          <Input
                            value={receiver}
                            onChange={setReceiver}
                            placeholder="Who took it"
                          />
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              disabled={save.isPending || receiver.trim() === ''}
                              onClick={() =>
                                save.mutate({ id: p.id, hand_over: true, received_by: receiver })
                              }
                            >
                              Save
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setHanding(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

function Blocklist() {
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({})

  const list = useQuery({
    queryKey: ['blocklist'],
    queryFn: () => api.get<List<Block>>('/api/v1/office/blocklist'),
  })
  const save = useMutation({
    mutationFn: () => api.post('/api/v1/office/blocklist', form),
    onSuccess: () => {
      setForm({})
      qc.invalidateQueries({ queryKey: ['blocklist'] })
    },
  })
  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })
  const rows = list.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="Refuse entry"
          description="A reason is required. The case this exists for is usually a custody order, which is exactly when a list nobody can defend becomes a problem — and when the person at the desk is being told a convincing story."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Name" required>
              <Input value={form.full_name ?? ''} onChange={set('full_name')} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone ?? ''} onChange={set('phone')} />
            </Field>
            <Field label="Reason" wide required>
              <Input
                value={form.reason ?? ''}
                onChange={set('reason')}
                placeholder="Interim custody order dated 12 June 2026 — not to collect the child."
              />
            </Field>
            <Field label="In force until" hint="Court orders are varied; a block with no end outlives its order.">
              <Input type="date" value={form.effective_to ?? ''} onChange={set('effective_to')} />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button
              disabled={save.isPending || !form.full_name?.trim() || !form.reason?.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Add to block list'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Block list" description="Checked automatically whenever a pass is issued." />
        {rows.length === 0 ? (
          <EmptyState title="Nobody blocked" body="Entries here refuse a gate pass automatically." />
        ) : (
          <Table
            head={[
              { label: 'Name' },
              { label: 'Reason' },
              { label: 'From' },
              { label: 'Until' },
              { label: 'Added by' },
              { label: '' },
            ]}
          >
            {rows.map((b) => (
              <tr key={b.id}>
                <Td className="font-medium">
                  {b.full_name}
                  {b.phone && (
                    <div className="text-[12px] font-normal text-muted-foreground">{b.phone}</div>
                  )}
                </Td>
                <Td>{b.reason}</Td>
                <Td className="text-muted-foreground">{formatDate(b.effective_from)}</Td>
                <Td className="text-muted-foreground">
                  {b.effective_to ? formatDate(b.effective_to) : 'No end date'}
                </Td>
                <Td className="text-muted-foreground">{b.added_by ?? '—'}</Td>
                <Td>
                  <Badge tone={b.in_force ? 'danger' : 'neutral'}>
                    {b.in_force ? 'In force' : 'Lapsed'}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}
