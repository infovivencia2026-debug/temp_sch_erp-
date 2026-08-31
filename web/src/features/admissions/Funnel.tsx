import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, CalendarHeart, ListOrdered, Megaphone, ScrollText, Users } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Checkbox, Field, FormGrid, FormNotice, Input, Select,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* The admissions funnel.

   The product could record an enquiry, record an application, and move one to
   the other. What it could not answer is anything the admissions head is
   measured on: which advertisement worked, which counsellor is sitting on
   forty untouched leads, who is next on the waiting list, and whether the RTE
   register would survive an inspection. */

interface Source {
  source: string
  enquiries: number
  applied: number
  offered: number
  admitted: number
  conversion_percent?: number
}
interface Lead {
  id: string
  student_name: string
  parent_name?: string
  phone?: string
  class_sought?: string
  source?: string
  utm?: string
  status: string
  assigned_to?: string
  next_follow_up?: string
  created_at: string
  days_silent: number
  follow_up_overdue: boolean
}
interface RegisterRow {
  id: string
  application_no: string
  full_name: string
  class_sought?: string
  category?: string
  quota: string
  rte_status?: string
  status: string
  aadhaar_consent: boolean
  apaar_id?: string
  prior_udise_code?: string
  sibling?: string
  alumni_parent_name?: string
  waitlist_rank?: number
  missing: string[]
}
interface Quota {
  quota: string
  applied: number
  offered: number
  admitted: number
}
interface OpenDay {
  id: string
  name: string
  on_date: string
  venue?: string
  is_published: boolean
  slots: number
  capacity: number
  booked: number
  attended: number
  parents: number
}
interface Sale {
  id: string
  receipt_no: string
  on_date: string
  buyer_name: string
  phone?: string
  kind: string
  quantity: number
  amount_paise: number
  mode: string
}
interface Named {
  id: string
  full_name?: string
  name?: string
}

const TABS = [
  ['leads', 'Leads', Users],
  ['sources', 'Where they came from', Megaphone],
  ['register', 'Quota register', ScrollText],
  ['waitlist', 'Waiting list', ListOrdered],
  ['opendays', 'Open days', CalendarHeart],
  ['prospectus', 'Prospectus', BookOpen],
] as const

const rupees = (p: number) => (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })

/* Which tab each menu entry means.
 *
 * Four entries opened this screen and all four landed on Leads, so "Campus
 * Visits" showed a counsellor assignment form and the open-day diary it names
 * was two clicks away behind a tab nobody knew to press. The tabs were right
 * all along; the doors all led to the same one. */
const VIEWS: Record<string, {
  tab: (typeof TABS)[number][0]
  title: string
  description: string
}> = {
  assign_leads: {
    tab: 'leads',
    title: 'Assign leads',
    description: 'Enquiries nobody is chasing yet. Tick several, pick the counsellor, and they all get an owner and a date.',
  },
  campus_visits: {
    tab: 'opendays',
    title: 'Campus visits',
    description: 'Open houses, tours and counselling days: the slots on offer, who has booked, and who turned up.',
  },
  waitlist: {
    tab: 'waitlist',
    title: 'Waiting list',
    description: 'Who is next if a seat is given up, in order, with the date they went on.',
  },
}

const OPENS_ON = Object.fromEntries(
  Object.entries(VIEWS).map(([k, v]) => [k, v.tab]),
) as Record<string, (typeof TABS)[number][0]>

export default function Funnel() {
  const { featureSlug } = useParams()
  const view = VIEWS[featureSlug ?? '']
  const [tab, setTab] = useState<(typeof TABS)[number][0]>(
    OPENS_ON[featureSlug ?? ''] ?? 'leads')

  /* Walking between two entries that both render this component changes a
     route parameter and nothing else — React keeps it mounted and the initial
     state above never runs again, so the heading would say Campus Visits over
     the leads list. Adjusted during render, so it is right on first paint. */
  const [lastSlug, setLastSlug] = useState(featureSlug)
  if (featureSlug !== lastSlug) {
    setLastSlug(featureSlug)
    setTab(OPENS_ON[featureSlug ?? ''] ?? 'leads')
  }

  const leads = useQuery({
    queryKey: ['leads'],
    queryFn: () => api.get<List<Lead>>('/api/v1/admissions/leads'),
  })
  const register = useQuery({
    queryKey: ['admission-register'],
    queryFn: () =>
      api.get<{
        items: RegisterRow[]
        quotas: Quota[]
        admitted_total: number
        rte_admitted: number
        rte_percent: number
        rte_short_by: number
      }>('/api/v1/admissions/register'),
  })

  if (leads.isLoading) return <Loading label="Opening the funnel…" />
  if (leads.error) return <ErrorState error={leads.error} />

  const rows = leads.data?.items ?? []
  const overdue = rows.filter((l) => l.follow_up_overdue)
  const unassigned = rows.filter((l) => !l.assigned_to)
  const reg = register.data

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        /* Named for the entry that was opened.

           Three entries render this screen and each lands on its own tab, but
           the shell above the tabs was identical — same heading, same four
           totals — so two of them read as the same page with something moved.
           A screen that does not say what you asked for has not answered you. */
        title={view?.title ?? 'The funnel'}
        description={view?.description ?? 'Where enquiries came from, who is chasing them, and the quota register an inspection reads.'}
      />
      <PageBody>
        {/* The lead totals belong to the leads.

            They were shown above every tab, so the waiting list and the
            open-day diary each opened under "Live leads / Nobody chasing /
            Follow-ups overdue" — four numbers about something else. Three
            entries with the same four totals and the same tab strip read as
            one page however different the content below, which is why this
            kept being reported as "still the same". */}
        {!view || view.tab === 'leads' ? (
        <CellGrid cols={4}>
          <Stat label="Live leads" value={rows.length} icon={Users} />
          <Stat
            label="Nobody chasing"
            value={unassigned.length}
            delta={
              unassigned.length
                ? { value: 'Unassigned', positive: false }
                : { value: 'All assigned', positive: true }
            }
          />
          <Stat label="Follow-ups overdue" value={overdue.length} />
          <Stat
            label="RTE share"
            value={reg ? `${reg.rte_percent.toFixed(0)}%` : '—'}
            delta={
              reg && reg.rte_short_by > 0
                ? { value: `${reg.rte_short_by} short of a quarter`, positive: false }
                : { value: 'At or above a quarter', positive: true }
            }
          />
        </CellGrid>
        ) : null}

        {/* The tab strip is for browsing the funnel as a whole. An entry that
            names one register is not browsing — it asked for that register,
            and offering five others beside it is what made three menu entries
            indistinguishable. */}
        {!view && (
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
        )}

        {tab === 'leads' && <Leads rows={rows} />}
        {tab === 'sources' && <Sources />}
        {tab === 'register' && <Register data={reg} />}
        {tab === 'waitlist' && <Waitlist />}
        {tab === 'opendays' && <OpenDays />}
        {tab === 'prospectus' && <Prospectus />}
      </PageBody>
    </>
  )
}

function Leads({ rows }: { rows: Lead[] }) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<string[]>([])
  const [counsellor, setCounsellor] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [note, setNote] = useState('')

  const users = useQuery({
    queryKey: ['users', 'counsellors'],
    queryFn: () => api.get<List<Named>>('/api/v1/admin/users?limit=100'),
  })
  const assign = useMutation({
    mutationFn: () =>
      api.post('/api/v1/admissions/leads/assign', {
        ids: picked,
        assigned_to: counsellor,
        next_follow_up: followUp,
        contacted: true,
        notes: note,
      }),
    onSuccess: () => {
      setPicked([])
      setNote('')
      qc.invalidateQueries({ queryKey: ['leads'] })
    },
  })

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  return (
    <>
      <Card>
        <CardHeader
          title="Hand leads to a counsellor"
          description="A batch, because that is how the work arrives — a morning's forty web enquiries split between three people. Doing it one at a time is the reason nobody does it."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Counsellor">
              <Select
                value={counsellor}
                onChange={setCounsellor}
                placeholder="Choose"
                options={(users.data?.items ?? []).map((u) => ({
                  value: u.id,
                  label: u.full_name ?? u.name ?? u.id,
                }))}
              />
            </Field>
            <Field label="Follow up by">
              <Input type="date" value={followUp} onChange={setFollowUp} />
            </Field>
            <Field label="Note" wide>
              <Input value={note} onChange={setNote} placeholder="Called, sending prospectus." />
            </Field>
          </FormGrid>
          <div className="mt-4 flex items-center gap-3">
            <Button
              disabled={assign.isPending || picked.length === 0 || !counsellor}
              onClick={() => assign.mutate()}
            >
              {assign.isPending ? 'Assigning…' : `Assign ${picked.length || ''}`.trim()}
            </Button>
            {picked.length > 0 && (
              <Button variant="ghost" onClick={() => setPicked([])}>
                Clear
              </Button>
            )}
          </div>
          <FormNotice error={assign.error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Leads"
          description="Overdue follow-ups first, then whoever has been ignored longest."
        />
        {rows.length === 0 ? (
          <EmptyState title="No enquiries" body="Enquiries taken at the desk or online appear here." />
        ) : (
          <Table
            head={[
              { label: '' },
              { label: 'Child' },
              { label: 'Class' },
              { label: 'Came from' },
              { label: 'With' },
              { label: 'Silent' },
              { label: 'Follow up' },
            ]}
          >
            {rows.map((l) => (
              <tr key={l.id}>
                <Td>
                  <Checkbox
                    checked={picked.includes(l.id)}
                    onChange={() => toggle(l.id)}
                    label=""
                    srLabel={`Select ${l.student_name} for assignment to a counsellor`}
                  />
                </Td>
                <Td className="font-medium">
                  {l.student_name}
                  <div className="text-[12px] font-normal text-muted-foreground">
                    {l.parent_name}
                    {l.phone && ` · ${l.phone}`}
                  </div>
                </Td>
                <Td className="text-muted-foreground">{l.class_sought ?? '—'}</Td>
                <Td className="text-muted-foreground">
                  {l.source ?? '—'}
                  {l.utm && <div className="text-[12px]">{l.utm}</div>}
                </Td>
                <Td className="text-muted-foreground">
                  {l.assigned_to ?? <span className="text-destructive">Nobody</span>}
                </Td>
                <Td className="tabular-nums text-muted-foreground">{l.days_silent}d</Td>
                <Td>
                  {l.next_follow_up ? (
                    <Badge tone={l.follow_up_overdue ? 'danger' : 'neutral'}>
                      {formatDate(l.next_follow_up)}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
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

function Sources() {
  const q = useQuery({
    queryKey: ['lead-sources'],
    queryFn: () => api.get<List<Source>>('/api/v1/admissions/sources?period=this_year'),
  })
  const rows = q.data?.items ?? []

  return (
    <Card>
      <CardHeader
        title="Which advertisement worked"
        description="All four numbers come from the same rows, so they always add up — which a dashboard assembled from separate queries famously does not. A conversion rate is withheld below five enquiries: one lead from a newspaper is not a 0% rate, it is not yet a rate."
      />
      {q.isLoading ? (
        <Loading label="Counting…" />
      ) : rows.length === 0 ? (
        <EmptyState title="No enquiries this year" body="Sources appear once enquiries are recorded." />
      ) : (
        <Table
          head={[
            { label: 'Source' },
            { label: 'Enquiries' },
            { label: 'Applied' },
            { label: 'Offered' },
            { label: 'Admitted' },
            { label: 'Conversion' },
          ]}
        >
          {rows.map((s) => (
            <tr key={s.source}>
              <Td className="font-medium">{s.source}</Td>
              <Td className="tabular-nums">{s.enquiries}</Td>
              <Td className="tabular-nums text-muted-foreground">{s.applied}</Td>
              <Td className="tabular-nums text-muted-foreground">{s.offered}</Td>
              <Td className="tabular-nums">{s.admitted}</Td>
              <Td className="tabular-nums">
                {s.conversion_percent == null ? (
                  <span className="text-muted-foreground">too few</span>
                ) : (
                  `${s.conversion_percent.toFixed(0)}%`
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

function Register({
  data,
}: {
  data?: {
    items: RegisterRow[]
    quotas: Quota[]
    admitted_total: number
    rte_admitted: number
    rte_percent: number
    rte_short_by: number
  }
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<Record<string, string | boolean>>({})
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const patch = useMutation({
    mutationFn: (v: Record<string, unknown>) =>
      api.post('/api/v1/admissions/applications/patch', v),
    onSuccess: () => {
      setEditing(null)
      qc.invalidateQueries({ queryKey: ['admission-register'] })
    },
  })

  async function upload(file: File) {
    setImporting(true)
    setResult(null)
    const body = new FormData()
    body.append('file', file)
    const res = await fetch('/api/v1/admissions/rte/import', { method: 'POST', body })
    const json = await res.json()
    setImporting(false)
    setResult(
      res.ok
        ? `${json.matched} of ${json.rows} matched${
            json.unmatched?.length ? `; not found: ${json.unmatched.join(', ')}` : ''
          }`
        : (json.error?.message ?? 'Import failed'),
    )
    qc.invalidateQueries({ queryKey: ['admission-register'] })
  }

  const rows = data?.items ?? []
  const incomplete = rows.filter((r) => r.missing.length > 0)

  return (
    <>
      <Card>
        <CardHeader
          title="Quotas"
          description="A school defends its intake as a whole, so every quota is in one register rather than RTE having a screen of its own."
          action={
            <label className="inline-flex h-9 cursor-pointer items-center rounded-sm border bg-card px-3 text-[14px] hover:bg-accent">
              {importing ? 'Importing…' : 'Import RTE lottery'}
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              />
            </label>
          }
        />
        {result && <p className="px-4 pb-3 text-[13px] text-muted-foreground">{result}</p>}
        <Table
          head={[
            { label: 'Quota' },
            { label: 'Applied' },
            { label: 'Offered' },
            { label: 'Admitted' },
          ]}
        >
          {(data?.quotas ?? []).map((q) => (
            <tr key={q.quota}>
              <Td className="font-medium">{q.quota}</Td>
              <Td className="tabular-nums">{q.applied}</Td>
              <Td className="tabular-nums text-muted-foreground">{q.offered}</Td>
              <Td className="tabular-nums">{q.admitted}</Td>
            </tr>
          ))}
        </Table>
        {data && (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">
            {data.rte_admitted} of {data.admitted_total} admitted under RTE (
            {data.rte_percent.toFixed(1)}%).{' '}
            {data.rte_short_by > 0
              ? `${data.rte_short_by} short of the quarter the Act asks for.`
              : 'At or above the quarter the Act asks for.'}
          </p>
        )}
      </Card>

      <Card>
        <CardHeader
          title="The register"
          description="What an inspection would find missing is named per row, because “three fields short” is not something a clerk can act on at four in the afternoon. Only what each quota requires is judged."
        />
        {incomplete.length > 0 && (
          <p className="border-b bg-destructive/5 px-4 py-2 text-[13px] text-destructive">
            {incomplete.length} of {rows.length} rows are incomplete
          </p>
        )}
        <Table
          head={[
            { label: 'Application' },
            { label: 'Child' },
            { label: 'Quota' },
            { label: 'Status' },
            { label: 'Missing' },
            { label: '' },
          ]}
        >
          {rows.slice(0, 100).map((a) => (
            <tr key={a.id}>
              <Td className="font-mono text-[13px]">{a.application_no}</Td>
              <Td className="font-medium">
                {a.full_name}
                <div className="text-[12px] font-normal text-muted-foreground">
                  {a.class_sought ?? '—'}
                  {a.sibling && ` · sibling of ${a.sibling}`}
                </div>
              </Td>
              <Td>
                <Badge tone={a.quota === 'rte' ? 'warning' : 'neutral'}>{a.quota}</Badge>
                {a.rte_status && (
                  <div className="text-[12px] text-muted-foreground">{a.rte_status}</div>
                )}
              </Td>
              <Td className="text-muted-foreground">{a.status.replace('_', ' ')}</Td>
              <Td className="text-[13px] text-destructive">
                {a.missing.length ? a.missing.join(', ') : ''}
              </Td>
              <Td>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(a.id)
                    setForm({ quota: a.quota })
                  }}
                >
                  Fill in
                </Button>
                {editing === a.id && (
                  <div className="mt-2 w-64 space-y-2">
                    <Select
                      value={String(form.quota ?? a.quota)}
                      onChange={(v) => setForm({ ...form, quota: v })}
                      options={[
                        'general', 'rte', 'ews', 'sibling', 'alumni', 'staff', 'sports', 'management',
                      ].map((q) => ({ value: q, label: q }))}
                    />
                    <Input
                      value={String(form.apaar_id ?? '')}
                      onChange={(v) => setForm({ ...form, apaar_id: v })}
                      placeholder="APAAR ID"
                    />
                    <Input
                      value={String(form.prior_udise_code ?? '')}
                      onChange={(v) => setForm({ ...form, prior_udise_code: v })}
                      placeholder="Previous school UDISE code"
                    />

                    {/* THE CHILD AND THE PARENT.

                        Blank means unchanged, exactly as the two fields above
                        already behave: the register does not carry these
                        values, so prefilling them would mean showing the clerk
                        an empty box that silently blanks a name on save. Only
                        what is typed is sent.

                        Corrects the application and nothing else. A child who
                        has already been enrolled keeps the old spelling on
                        their student record until somebody fixes that too. */}
                    <div className="border-t pt-2 text-[12px] text-muted-foreground">
                      Correct a detail — leave blank to keep what is on file
                    </div>
                    <Input
                      value={String(form.first_name ?? '')}
                      onChange={(v) => setForm({ ...form, first_name: v })}
                      placeholder="Child's first name"
                    />
                    <Input
                      value={String(form.last_name ?? '')}
                      onChange={(v) => setForm({ ...form, last_name: v })}
                      placeholder="Child's last name"
                    />
                    <Input
                      value={String(form.date_of_birth ?? '')}
                      onChange={(v) => setForm({ ...form, date_of_birth: v })}
                      placeholder="Date of birth (YYYY-MM-DD)"
                    />
                    <Select
                      value={String(form.gender ?? '')}
                      onChange={(v) => setForm({ ...form, gender: v })}
                      options={[
                        { value: '', label: 'Gender — unchanged' },
                        ...['male', 'female', 'other'].map((g) => ({ value: g, label: g })),
                      ]}
                    />
                    <Select
                      value={String(form.category ?? '')}
                      onChange={(v) => setForm({ ...form, category: v })}
                      options={[
                        { value: '', label: 'Category — unchanged' },
                        ...['general', 'obc', 'sc', 'st', 'ews', 'other'].map((c) => ({
                          value: c, label: c,
                        })),
                      ]}
                    />
                    <Input
                      value={String(form.parent_name ?? '')}
                      onChange={(v) => setForm({ ...form, parent_name: v })}
                      placeholder="Parent's name"
                    />
                    <Input
                      value={String(form.parent_phone ?? '')}
                      onChange={(v) => setForm({ ...form, parent_phone: v })}
                      placeholder="Parent's phone"
                    />
                    <Input
                      value={String(form.parent_email ?? '')}
                      onChange={(v) => setForm({ ...form, parent_email: v })}
                      placeholder="Parent's email"
                    />
                    <Checkbox
                      checked={Boolean(form.aadhaar_consent)}
                      onChange={(v) => setForm({ ...form, aadhaar_consent: v })}
                      label="Aadhaar consent given"
                    />
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        disabled={patch.isPending}
                        onClick={() => patch.mutate({ id: a.id, ...form })}
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </Table>
        <FormNotice error={patch.error} />
      </Card>
    </>
  )
}

function Waitlist() {
  const qc = useQueryClient()
  const [classId, setClassId] = useState('')
  const [seats, setSeats] = useState('1')

  const list = useQuery({
    queryKey: ['waitlist'],
    queryFn: () =>
      api.get<{ items: RegisterRow[] }>('/api/v1/admissions/register?status=waitlisted'),
  })
  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Named>>('/api/v1/academics/classes'),
  })
  const promote = useMutation({
    mutationFn: () =>
      api.post<{ promoted: string[] }>('/api/v1/admissions/waitlist/promote', {
        class_id: classId,
        seats: Number(seats),
      }),
    onSuccess: () => qc.invalidateQueries(),
  })

  const rows = list.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="A seat opens"
          description="Promotion takes the lowest rank rather than the earliest application: a school that has ranked its list has already decided the order, and promoting by date would quietly overrule it."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Class">
              <Select
                value={classId}
                onChange={setClassId}
                placeholder="Choose a class"
                options={(classes.data?.items ?? []).map((c) => ({
                  value: c.id,
                  label: c.name ?? c.id,
                }))}
              />
            </Field>
            <Field label="Seats">
              <Input value={seats} onChange={setSeats} type="number" />
            </Field>
          </FormGrid>
          <div className="mt-4 flex items-center gap-3">
            <Button disabled={promote.isPending || !classId} onClick={() => promote.mutate()}>
              {promote.isPending ? 'Promoting…' : 'Promote'}
            </Button>
            {promote.isSuccess && promote.data && (
              <span className="text-[13px] text-muted-foreground">
                {promote.data.promoted.length
                  ? `Offered to ${promote.data.promoted.join(', ')}`
                  : 'Nobody was waiting'}
              </span>
            )}
          </div>
          <FormNotice error={promote.error} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Waiting" description="In rank order. Two children cannot hold one place." />
        {rows.length === 0 ? (
          <EmptyState title="Nobody waiting" body="Applications marked waitlisted appear here." />
        ) : (
          <Table
            head={[{ label: 'Rank' }, { label: 'Child' }, { label: 'Class' }, { label: 'Quota' }]}
          >
            {rows.map((a) => (
              <tr key={a.id}>
                <Td className="tabular-nums font-medium">{a.waitlist_rank ?? '—'}</Td>
                <Td>
                  {a.full_name}
                  <div className="text-[12px] text-muted-foreground">{a.application_no}</div>
                </Td>
                <Td className="text-muted-foreground">{a.class_sought ?? '—'}</Td>
                <Td>
                  <Badge tone="neutral">{a.quota}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

function OpenDays() {
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({ capacity: '25' })
  const [times, setTimes] = useState('09:00, 10:00, 11:00')
  const [open, setOpen] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['open-days'],
    queryFn: () => api.get<List<OpenDay>>('/api/v1/admissions/open-days'),
  })
  const slots = useQuery({
    queryKey: ['open-day-slots', open],
    queryFn: () =>
      api.get<List<{ id: string; starts_at: string; capacity: number; booked: number; places_left: number }>>(
        `/api/v1/admissions/open-days/${open}/slots`,
      ),
    enabled: !!open,
  })
  const bookings = useQuery({
    queryKey: ['open-day-bookings', open],
    queryFn: () =>
      api.get<List<{ id: string; starts_at: string; parent_name: string; phone: string; children: number; attended: boolean }>>(
        `/api/v1/admissions/open-days/${open}/bookings`,
      ),
    enabled: !!open,
  })
  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/admissions/open-days', {
        name: form.name,
        on_date: form.on_date,
        venue: form.venue,
        is_published: true,
        capacity: Number(form.capacity || 25),
        slot_times: times.split(',').map((t) => t.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      setForm({ capacity: '25' })
      qc.invalidateQueries({ queryKey: ['open-days'] })
    },
  })
  const book = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post('/api/v1/admissions/open-days/book', v),
    onSuccess: () => qc.invalidateQueries(),
  })

  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })
  const rows = list.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="Schedule an open house"
          description="Capacity lives on each slot rather than the event, because the whole point is to spread two hundred parents across a Saturday morning rather than have them all arrive at ten."
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Name" required>
              <Input value={form.name ?? ''} onChange={set('name')} placeholder="Open House — Grade 1 intake" />
            </Field>
            <Field label="Date" required>
              <Input type="date" value={form.on_date ?? ''} onChange={set('on_date')} />
            </Field>
            <Field label="Venue">
              <Input value={form.venue ?? ''} onChange={set('venue')} placeholder="Main auditorium" />
            </Field>
            <Field label="Places per slot">
              <Input value={form.capacity ?? '25'} onChange={set('capacity')} type="number" />
            </Field>
            <Field label="Slot times" wide hint="Comma separated.">
              <Input value={times} onChange={setTimes} />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button
              disabled={create.isPending || !form.name?.trim() || !form.on_date}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </div>
          <FormNotice error={create.error} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Open days"
          description="Booked and turned up are different facts, and the ratio between them is the only honest measure of whether an open day worked."
        />
        {rows.length === 0 ? (
          <EmptyState title="Nothing scheduled" body="Open houses appear here with their bookings." />
        ) : (
          <Table
            head={[
              { label: 'Event' },
              { label: 'Date' },
              { label: 'Slots' },
              { label: 'Booked' },
              { label: 'Turned up' },
              { label: '' },
            ]}
          >
            {rows.map((e) => (
              <tr key={e.id}>
                <Td className="font-medium">
                  {e.name}
                  {e.venue && (
                    <div className="text-[12px] font-normal text-muted-foreground">{e.venue}</div>
                  )}
                </Td>
                <Td className="text-muted-foreground">{formatDate(e.on_date)}</Td>
                <Td className="tabular-nums text-muted-foreground">
                  {e.slots} · {e.capacity} places
                </Td>
                <Td className="tabular-nums">{e.booked}</Td>
                <Td className="tabular-nums">
                  {e.booked > 0 ? (
                    <Badge tone={e.attended * 2 >= e.booked ? 'success' : 'warning'}>
                      {e.attended} of {e.booked}
                    </Badge>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpen(open === e.id ? null : e.id)}
                  >
                    {open === e.id ? 'Close' : 'Slots'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {open && (
        <Card>
          <CardHeader title="Slots and bookings" description="A slot refuses the booking that would overfill it." />
          <div className="grid gap-4 p-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-[14px] font-medium">Slots</h3>
              {(slots.data?.items ?? []).map((sl) => (
                <div key={sl.id} className="flex items-center justify-between border-b py-2">
                  <span className="tabular-nums">{sl.starts_at}</span>
                  <span className="text-[13px] text-muted-foreground">
                    {sl.booked} of {sl.capacity} · {sl.places_left} left
                  </span>
                  <BookForm slotId={sl.id} full={sl.places_left === 0} onBook={book.mutate} />
                </div>
              ))}
            </div>
            <div>
              <h3 className="mb-2 text-[14px] font-medium">Booked in</h3>
              {(bookings.data?.items ?? []).length === 0 ? (
                <p className="text-[13px] text-muted-foreground">Nobody yet.</p>
              ) : (
                (bookings.data?.items ?? []).map((b) => (
                  <div key={b.id} className="flex items-center justify-between border-b py-2">
                    <div>
                      <span className="font-medium">{b.parent_name}</span>
                      <div className="text-[12px] text-muted-foreground">
                        {b.starts_at} · {b.phone}
                      </div>
                    </div>
                    {b.attended ? (
                      <Badge tone="success">Came</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => book.mutate({ booking_id: b.id })}
                      >
                        Mark arrived
                      </Button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
          <FormNotice error={book.error} />
        </Card>
      )}
    </>
  )
}

function BookForm({
  slotId,
  full,
  onBook,
}: {
  slotId: string
  full: boolean
  onBook: (v: Record<string, unknown>) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')

  if (full) return <Badge tone="neutral">Full</Badge>
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Book
      </Button>
    )
  return (
    <div className="flex flex-wrap gap-1">
      <Input value={name} onChange={setName} placeholder="Parent" className="w-28" />
      <Input value={phone} onChange={setPhone} placeholder="Phone" className="w-28" />
      <Button
        size="sm"
        disabled={!name.trim() || !phone.trim()}
        onClick={() => {
          onBook({ slot_id: slotId, parent_name: name, phone })
          setOpen(false)
          setName('')
          setPhone('')
        }}
      >
        Save
      </Button>
    </div>
  )
}

function Prospectus() {
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({ kind: 'prospectus', mode: 'cash' })
  const [stock, setStock] = useState('')

  const list = useQuery({
    queryKey: ['prospectus'],
    queryFn: () =>
      api.get<{
        items: Sale[]
        received: number
        sold: number
        in_stock: number
        takings_paise: number
      }>('/api/v1/admissions/prospectus?period=this_year'),
  })
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post('/api/v1/admissions/prospectus', v),
    onSuccess: () => {
      setForm({ kind: form.kind, mode: form.mode })
      setStock('')
      qc.invalidateQueries({ queryKey: ['prospectus'] })
    },
  })

  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v })
  const d = list.data

  return (
    <>
      <CellGrid cols={4}>
        <Stat label="Printed" value={d?.received ?? 0} icon={BookOpen} />
        <Stat label="Sold" value={d?.sold ?? 0} />
        <Stat label="In the cupboard" value={d?.in_stock ?? 0} />
        <Stat label="Takings" value={`₹${rupees(d?.takings_paise ?? 0)}`} />
      </CellGrid>

      <Card>
        <CardHeader
          title="Sell a prospectus"
          description="Receipt numbers are gapless within the year and allocated as the sale is recorded — a cash book with a hole in its numbering is a cash book somebody has to explain."
          action={
            <div className="flex gap-2">
              <Input value={stock} onChange={setStock} type="number" placeholder="Add stock" className="w-28" />
              <Button
                variant="secondary"
                disabled={save.isPending || !stock}
                onClick={() => save.mutate({ stock_quantity: Number(stock), kind: form.kind })}
              >
                Receive
              </Button>
            </div>
          }
        />
        <div className="p-4">
          <FormGrid>
            <Field label="Buyer" required>
              <Input value={form.buyer_name ?? ''} onChange={set('buyer_name')} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone ?? ''} onChange={set('phone')} />
            </Field>
            <Field label="What">
              <Select
                value={form.kind ?? 'prospectus'}
                onChange={set('kind')}
                options={[
                  { value: 'prospectus', label: 'Prospectus' },
                  { value: 'application_form', label: 'Application form' },
                  { value: 'kit', label: 'Admission kit' },
                ]}
              />
            </Field>
            <Field label="Amount (₹)" required>
              <Input value={form.amount ?? ''} onChange={set('amount')} type="number" />
            </Field>
            <Field label="Paid by">
              <Select
                value={form.mode ?? 'cash'}
                onChange={set('mode')}
                options={[
                  { value: 'cash', label: 'Cash' },
                  { value: 'card', label: 'Card' },
                  { value: 'upi', label: 'UPI' },
                  { value: 'waived', label: 'Waived' },
                ]}
              />
            </Field>
          </FormGrid>
          <div className="mt-4">
            <Button
              disabled={save.isPending || !form.buyer_name?.trim() || !form.amount}
              onClick={() =>
                save.mutate({
                  buyer_name: form.buyer_name,
                  phone: form.phone,
                  kind: form.kind,
                  mode: form.mode,
                  amount_paise: Math.round(Number(form.amount) * 100),
                })
              }
            >
              {save.isPending ? 'Saving…' : 'Record sale'}
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Sales" description="The counter's own cash book, reconcilable against the cupboard." />
        {(d?.items ?? []).length === 0 ? (
          <EmptyState title="Nothing sold" body="Sales appear here with their receipt numbers." />
        ) : (
          <Table
            head={[
              { label: 'Receipt' },
              { label: 'Date' },
              { label: 'Buyer' },
              { label: 'What' },
              { label: 'Paid' },
              { label: 'Amount' },
            ]}
          >
            {(d?.items ?? []).map((s) => (
              <tr key={s.id}>
                <Td className="font-mono text-[13px]">{s.receipt_no}</Td>
                <Td className="text-muted-foreground">{formatDate(s.on_date)}</Td>
                <Td className="font-medium">
                  {s.buyer_name}
                  {s.phone && (
                    <div className="text-[12px] font-normal text-muted-foreground">{s.phone}</div>
                  )}
                </Td>
                <Td className="text-muted-foreground">
                  {s.kind.replace('_', ' ')}
                  {s.quantity > 1 && ` ×${s.quantity}`}
                </Td>
                <Td className="text-muted-foreground">{s.mode}</Td>
                <Td className="tabular-nums">₹{rupees(s.amount_paise)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}
