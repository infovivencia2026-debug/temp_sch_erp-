import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarHeart, GraduationCap, HandCoins, UserPlus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Checkbox, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate, formatPaise } from '@/lib/utils'

/* The alumni programme.

   The student record already carries 'graduated' and 'alumni', so the
   directory is not a second copy of the child: it is the handful of facts a
   school only learns after they leave. The candidate list is the gap between
   the two — every leaver with no profile yet — because an alumni programme
   dies of nobody ever getting round to entering last year's batch.

   Contactable is consent, not a preference. An alumnus who asked to be left
   alone must drop out of every mailing the office runs. */

interface Alumnus {
  id: string
  student_id: string
  admission_no: string
  full_name: string
  batch_year: number
  occupation?: string
  employer?: string
  higher_study?: string
  city?: string
  country: string
  email?: string
  phone?: string
  contactable: boolean
  notes?: string
  events_attended: number
  contributed_paise: number
  last_contribution_on?: string
}

interface Candidate {
  student_id: string
  admission_no: string
  full_name: string
  status: string
  left_on?: string
  batch_year: number
}

interface AlumniEvent {
  id: string
  title: string
  on_date: string
  venue?: string
  description?: string
  expected?: number
  status: 'planned' | 'open' | 'held' | 'cancelled'
  invited: number
  accepted: number
  attended: number
  guests: number
  raised_paise: number
  academic_year?: string
}

const EVENT_TONE: Record<string, 'neutral' | 'info' | 'success' | 'danger'> = {
  planned: 'neutral',
  open: 'info',
  held: 'success',
  cancelled: 'danger',
}

export default function Alumni() {
  const qc = useQueryClient()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['alumni'] })
    qc.invalidateQueries({ queryKey: ['alumni-events'] })
  }
  const [q, setQ] = useState('')

  const directory = useQuery({
    queryKey: ['alumni', q],
    queryFn: () =>
      api.get<{
        items: Alumnus[]
        candidates: Candidate[]
        summary: {
          alumni: number
          batches: number
          contactable: number
          not_yet_enrolled: number
          contributed_paise: number
        }
      }>(
        '/api/v1/academics/admin/alumni' +
          (q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''),
      ),
  })
  const events = useQuery({
    queryKey: ['alumni-events'],
    queryFn: () => api.get<List<AlumniEvent>>('/api/v1/academics/admin/alumni/events'),
  })

  if (directory.isLoading) return <Loading label="Reading the alumni register…" />
  if (directory.error) return <ErrorState error={directory.error} />

  const rows = directory.data?.items ?? []
  const candidates = directory.data?.candidates ?? []
  const s = directory.data?.summary

  return (
    <>
      <PageHead
        eyebrow="Students"
        title="Alumni programme"
        description="The leaving batches, the reunions, and what past students have given back."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="On the register"
            value={s?.alumni ?? 0}
            icon={GraduationCap}
            hint={`${s?.batches ?? 0} batches`}
          />
          <Stat
            label="Not yet entered"
            value={s?.not_yet_enrolled ?? 0}
            icon={UserPlus}
            delta={
              (s?.not_yet_enrolled ?? 0) > 0
                ? { value: 'Leavers with no profile', positive: false }
                : { value: 'Every leaver is on the register', positive: true }
            }
          />
          <Stat label="Contactable" value={s?.contactable ?? 0} icon={CalendarHeart} />
          <Stat
            label="Contributed"
            value={formatPaise(s?.contributed_paise ?? 0)}
            icon={HandCoins}
          />
        </CellGrid>

        {candidates.length > 0 && (
          <Card>
            <CardHeader
              title="Leavers not yet on the register"
              description="Entered once, they stay on the register for good; the batch year is worked out from the leaving date."
            />
            <Table head={['Student', 'Admission', 'Left', 'Batch', '']}>
              {candidates.slice(0, 15).map((c) => (
                <tr key={c.student_id}>
                  <Td className="font-medium">{c.full_name}</Td>
                  <Td className="text-muted-foreground">{c.admission_no}</Td>
                  <Td>{c.left_on ? formatDate(c.left_on) : '—'}</Td>
                  <Td className="tabular-nums">{c.batch_year}</Td>
                  <Td>
                    <EnrolButton studentID={c.student_id} onSaved={refresh} />
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Directory"
            description="Where they went, and whether they agreed to be written to."
            action={
              <Input
                value={q}
                onChange={setQ}
                placeholder="Name, employer or occupation"
                className="w-64"
              />
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="Nobody on the register yet"
              body="Add a leaver above, or enter one by hand below."
            />
          ) : (
            <Table
              head={['Name', 'Batch', 'Doing', 'Where', 'Contact', 'Events', 'Given']}
            >
              {rows.map((a) => (
                <tr key={a.id}>
                  <Td className="font-medium">
                    {a.full_name}
                    <span className="block text-[12px] text-muted-foreground">
                      {a.admission_no}
                    </span>
                  </Td>
                  <Td className="tabular-nums">{a.batch_year}</Td>
                  <Td>
                    {a.occupation ?? a.higher_study ?? '—'}
                    {a.employer && (
                      <span className="block text-[12px] text-muted-foreground">
                        {a.employer}
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">
                    {[a.city, a.country].filter(Boolean).join(', ')}
                  </Td>
                  <Td>
                    {a.contactable ? (
                      <span className="text-[13px]">{a.email ?? a.phone ?? 'no address'}</span>
                    ) : (
                      <Badge tone="warning">asked not to be written to</Badge>
                    )}
                  </Td>
                  <Td className="tabular-nums">{a.events_attended || '—'}</Td>
                  <Td className="tabular-nums">
                    {a.contributed_paise ? formatPaise(a.contributed_paise) : '—'}
                    {a.last_contribution_on && (
                      <span className="block text-[12px] text-muted-foreground">
                        {formatDate(a.last_contribution_on)}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Events"
            description="The gap between who said yes and who came is what next year’s catering is ordered from."
          />
          {(events.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No events yet" body="Plan the first reunion below." />
          ) : (
            <Table
              head={['Event', 'Date', 'Venue', 'Status', 'Invited', 'Accepted', 'Came', 'Raised']}
            >
              {(events.data?.items ?? []).map((e) => (
                <tr key={e.id}>
                  <Td className="font-medium">{e.title}</Td>
                  <Td className="whitespace-nowrap">{formatDate(e.on_date)}</Td>
                  <Td className="text-muted-foreground">{e.venue ?? '—'}</Td>
                  <Td>
                    <Badge tone={EVENT_TONE[e.status]}>{e.status}</Badge>
                  </Td>
                  <Td className="tabular-nums">{e.invited || '—'}</Td>
                  <Td className="tabular-nums">{e.accepted || '—'}</Td>
                  <Td className="tabular-nums">
                    {e.attended || '—'}
                    {e.guests > 0 && (
                      <span className="text-[12px] text-muted-foreground">
                        {' '}
                        +{e.guests} guests
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {e.raised_paise ? formatPaise(e.raised_paise) : '—'}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <div className="grid gap-7 lg:grid-cols-2">
          <NewEvent onSaved={refresh} />
          <NewContribution alumni={rows} events={events.data?.items ?? []} onSaved={refresh} />
        </div>

        <EditProfile alumni={rows} onSaved={refresh} />
      </PageBody>
    </>
  )
}

function EnrolButton({ studentID, onSaved }: { studentID: string; onSaved: () => void }) {
  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/academics/admin/alumni/profiles', { student_id: studentID }),
    onSuccess: onSaved,
  })
  return (
    <Button size="sm" variant="secondary" disabled={save.isPending} onClick={() => save.mutate()}>
      Add to register
    </Button>
  )
}

function NewEvent({ onSaved }: { onSaved: () => void }) {
  const [title, setTitle] = useState('')
  const [onDate, setOnDate] = useState('')
  const [venue, setVenue] = useState('')
  const [expected, setExpected] = useState('')
  const [status, setStatus] = useState('planned')
  const [description, setDescription] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/academics/admin/alumni/events', {
        title,
        on_date: onDate,
        venue,
        description,
        expected: expected ? Number(expected) : undefined,
        status,
      }),
    onSuccess: () => {
      setTitle('')
      setVenue('')
      setDescription('')
      onSaved()
    },
  })

  return (
    <Card>
      <CardHeader title="Plan an event" />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Title" required>
            <Input value={title} onChange={setTitle} placeholder="Silver Jubilee Meet" />
          </Field>
          <Field label="Date" required>
            <Input type="date" value={onDate} onChange={setOnDate} />
          </Field>
          <Field label="Venue">
            <Input value={venue} onChange={setVenue} placeholder="School grounds" />
          </Field>
          <Field label="Expected">
            <Input type="number" value={expected} onChange={setExpected} />
          </Field>
          <Field label="Status">
            <Select
              value={status}
              onChange={setStatus}
              options={[
                { value: 'planned', label: 'Planned' },
                { value: 'open', label: 'Open for RSVP' },
                { value: 'held', label: 'Held' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
            />
          </Field>
          <Field label="Description" wide>
            <Textarea value={description} onChange={setDescription} rows={2} />
          </Field>
        </FormGrid>
        <div className="mt-5 flex items-center gap-3">
          <Button
            disabled={save.isPending || !title.trim() || !onDate}
            onClick={() => save.mutate()}
          >
            Save event
          </Button>
          <FormNotice error={save.error} />
        </div>
      </div>
    </Card>
  )
}

function NewContribution({
  alumni,
  events,
  onSaved,
}: {
  alumni: Alumnus[]
  events: AlumniEvent[]
  onSaved: () => void
}) {
  const [profileID, setProfileID] = useState('')
  const [eventID, setEventID] = useState('')
  const [rupees, setRupees] = useState('')
  const [kind, setKind] = useState('cash')
  const [purpose, setPurpose] = useState('')
  const [receipt, setReceipt] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/academics/admin/alumni/contributions', {
        alumni_profile_id: profileID,
        event_id: eventID,
        amount_paise: Math.round(Number(rupees) * 100),
        kind,
        purpose,
        receipt_no: receipt,
      }),
    onSuccess: () => {
      setRupees('')
      setPurpose('')
      setReceipt('')
      onSaved()
    },
  })

  return (
    <Card>
      <CardHeader
        title="Record a gift"
        description="Kept out of the fee ledger on purpose: a donation posted there reads as school income against a student account."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Alumnus" required>
            <Select
              value={profileID}
              onChange={setProfileID}
              options={alumni.map((a) => ({
                value: a.id,
                label: `${a.full_name} · ${a.batch_year}`,
              }))}
              placeholder="Pick one"
            />
          </Field>
          <Field label="Against an event">
            <Select
              value={eventID}
              onChange={setEventID}
              options={events.map((e) => ({ value: e.id, label: e.title }))}
              placeholder="Not tied to one"
            />
          </Field>
          <Field label="Amount (₹)" required>
            <Input type="number" value={rupees} onChange={setRupees} placeholder="25000" />
          </Field>
          <Field label="Kind">
            <Select
              value={kind}
              onChange={setKind}
              options={[
                { value: 'cash', label: 'Cash' },
                { value: 'kind', label: 'In kind' },
                { value: 'scholarship', label: 'Scholarship' },
                { value: 'infrastructure', label: 'Infrastructure' },
              ]}
            />
          </Field>
          <Field label="Purpose">
            <Input value={purpose} onChange={setPurpose} placeholder="Two fee waivers" />
          </Field>
          <Field label="Receipt number" hint="Unique where given; leave blank if none was issued.">
            <Input value={receipt} onChange={setReceipt} placeholder="AL/2026/001" />
          </Field>
        </FormGrid>
        <div className="mt-5 flex items-center gap-3">
          <Button
            disabled={save.isPending || !profileID || !Number(rupees)}
            onClick={() => save.mutate()}
          >
            Record gift
          </Button>
          <FormNotice error={save.error} />
        </div>
      </div>
    </Card>
  )
}

function EditProfile({ alumni, onSaved }: { alumni: Alumnus[]; onSaved: () => void }) {
  const [id, setID] = useState('')
  const picked = alumni.find((a) => a.id === id)
  const [occupation, setOccupation] = useState('')
  const [employer, setEmployer] = useState('')
  const [city, setCity] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [contactable, setContactable] = useState(true)

  const choose = (v: string) => {
    setID(v)
    const a = alumni.find((x) => x.id === v)
    setOccupation(a?.occupation ?? '')
    setEmployer(a?.employer ?? '')
    setCity(a?.city ?? '')
    setEmail(a?.email ?? '')
    setPhone(a?.phone ?? '')
    setContactable(a?.contactable ?? true)
  }

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/academics/admin/alumni/profiles', {
        student_id: picked?.student_id,
        occupation,
        employer,
        city,
        email,
        phone,
        contactable,
      }),
    onSuccess: onSaved,
  })

  if (alumni.length === 0) return null

  return (
    <Card>
      <CardHeader
        title="Update a record"
        description="Contactable is consent. Unticking it drops them out of every mailing the office runs."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Alumnus" required wide>
            <Select
              value={id}
              onChange={choose}
              options={alumni.map((a) => ({
                value: a.id,
                label: `${a.full_name} · ${a.batch_year}`,
              }))}
              placeholder="Pick one"
            />
          </Field>
          <Field label="Occupation">
            <Input value={occupation} onChange={setOccupation} />
          </Field>
          <Field label="Employer">
            <Input value={employer} onChange={setEmployer} />
          </Field>
          <Field label="City">
            <Input value={city} onChange={setCity} />
          </Field>
          <Field label="Email">
            <Input value={email} onChange={setEmail} />
          </Field>
          <Field label="Phone">
            <Input value={phone} onChange={setPhone} />
          </Field>
        </FormGrid>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <Checkbox
            checked={contactable}
            onChange={setContactable}
            label="May be written to"
          />
          <Button disabled={save.isPending || !id} onClick={() => save.mutate()}>
            Save
          </Button>
          <FormNotice error={save.error} ok={save.isSuccess ? 'Saved.' : undefined} />
        </div>
      </div>
    </Card>
  )
}
