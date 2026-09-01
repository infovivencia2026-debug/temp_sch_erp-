import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List, type Section } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, Input, Select, Loading, ErrorState, FormNotice, Checkbox, Badge, Field,
} from '@/components/ui'
import { Plus } from 'lucide-react'
import Documents from './Documents'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
import { StatusPill } from '@/components/NeedsAttention'
import { useCan } from '@/lib/session'
import { formatDate, cn } from '@/lib/utils'

/* The application, from submitted to enrolled.
 *
 * Four endpoints existed for this ladder — assessment, decision, enrol, plus
 * the list — and only the list had a caller. So an application could be taken
 * and then not moved: no way to schedule a test, issue an offer, or turn an
 * accepted applicant into a student.
 *
 * The stages are a real sequence, so the screen shows where each applicant
 * has got to and offers only the step that comes next. A decision button on a
 * candidate who has not sat the test is a way to make a mistake quickly.
 */

interface Application {
  id: string
  application_no: string
  name: string
  class_sought?: string
  parent_name: string
  parent_phone: string
  is_rte: boolean
  status: string
  created_at: string
  /* Absent where the school charges no form fee, so the column disappears
     rather than showing a row of dashes. */
  form_fee_paise?: number
  form_fee_paid_at?: string
  /* Counted over the required documents only: an optional caste certificate
     for a child not claiming one must not leave an application looking
     incomplete for ever. */
  docs_required: number
  docs_verified: number
  docs_rejected: number
}

/* The ladder, in order. Anything not listed — withdrawn, rejected — is a
   terminal state and offers nothing further. */
const LADDER = [
  'draft', 'submitted', 'under_review', 'documents_pending',
  'test_scheduled', 'interviewed', 'offered', 'accepted',
]

function stageIndex(status: string) {
  return LADDER.indexOf(status)
}

/* Five entries, five stages of one ladder.
 *
 * All applications, Document check, Entrance exams, Interviews and the
 * approvals queue are the same screen — because an application is one thing
 * that moves, and splitting it into five screens would mean five copies of the
 * same row and a decision button on each. What differs is where each entry
 * lands: the stage that entry is about.
 *
 * Without that they were five names for one unfiltered list, which is how a
 * menu grows entries that lead nowhere new. A person who clicks "Document
 * check" has already told you what they want to see.
 */
/* Which rung an entry opens on, by real slug.

   Only the forms list opens unfiltered. Document verification deliberately
   does NOT filter to documents_pending: an application can be short of a
   birth certificate at any stage, and filtering to one status hid most of the
   queue the screen exists to show. It sorts by outstanding paperwork instead. */
const OPENS_ON: Record<string, string> = {}

/* Keyed by the slug the catalogue actually generates.

   These were written against slugs that do not exist — document_check for
   document_verification, entrance_exams for entrance_tests — so neither the
   heading nor the opening filter ever matched anything, and every entry showed
   "Applications" over the unfiltered list. That is why two entries looked
   identical: they were. */
const TITLES: Record<string, [string, string]> = {
  application_forms: ['Application forms',
    'Every form submitted, and where it has got to on the ladder.'],
  document_verification: ['Document verification',
    'What each applicant still owes the office. Attach what they bring, verify it, or send it back with a reason.'],
}

export default function Applications() {
  const { featureSlug } = useParams()
  const [title, description] = TITLES[featureSlug ?? ''] ?? [
    'Applications',
    'Every application and where it has got to on the ladder.',
  ]

  const qc = useQueryClient()
  const can = useCan()
  const mayWrite = can('admissions.write')
  const mayEnrol = can('students.write')

  /* The paperwork queue is a different question from the application list,
     and shares only its rows. */
  const checking = featureSlug === 'document_verification'

  const [status, setStatus] = useState(OPENS_ON[featureSlug ?? ''] ?? '')

  /* Following the menu between entries, not only into one.
   *
   * All five entries render this component, so walking from "Document check"
   * to "Interviews" changes a route parameter and nothing else — React keeps
   * it mounted and the initial state above never runs again. The heading said
   * Interviews over a list still filtered to documents pending. Adjusted
   * during render so it is right on the first paint. */
  const [lastSlug, setLastSlug] = useState(featureSlug)
  if (featureSlug !== lastSlug) {
    setLastSlug(featureSlug)
    setStatus(OPENS_ON[featureSlug ?? ''] ?? '')
  }
  const [adding, setAdding] = useState(
    () => new URLSearchParams(window.location.search).has('student'),
  )
  const blank = {
    first_name: '', last_name: '', date_of_birth: '', gender: '', category: '',
    class_sought: '', parent_name: '', parent_phone: '', parent_email: '',
    address: '', previous_school: '', is_rte: false,
    /* Rupees here, paise on the wire. A clerk types 500, not 50000. */
    form_fee: '', form_fee_paid: false, form_fee_receipt: '',
    /* Set when the application came from an enquiry: the server marks that
       enquiry converted, which is what makes the funnel countable. */
    enquiry_id: '',
  }
  /* Arriving from an enquiry with the lead already taken down.
   *
   * Read once, into the initial state, rather than in an effect: an effect
   * would overwrite whatever the clerk had typed every time the component
   * re-rendered with the parameters still in the address bar. */
  const [params] = useSearchParams()
  const [form, setForm] = useState(() => {
    const student = params.get('student')
    if (!student) return blank
    const bits = student.trim().split(/\s+/)
    return {
      ...blank,
      enquiry_id: params.get('from') ?? '',
      first_name: bits[0] ?? '',
      last_name: bits.slice(1).join(' '),
      parent_name: params.get('parent') ?? '',
      parent_phone: params.get('phone') ?? '',
    }
  })
  const set = (k: keyof typeof blank) => (v: string) => setForm((f) => ({ ...f, [k]: v }))

  const [open, setOpen] = useState<Application | null>(null)
  const [remarks, setRemarks] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [score, setScore] = useState('')
  const [sectionId, setSectionId] = useState('')
  /* The bus, asked for at the desk.

     A parent says "we live at Subedari and he will use the bus" while filling
     in the form. Nobody wrote it down: naming transport in the services list
     only billed for a bus, and putting the child on one meant the transport
     office opening a second screen later and finding the student again. So the
     ordinary outcome was an invoice for transport and no seat on it. */
  const [routeId, setRouteId] = useState('')
  const [pickupStopId, setPickupStopId] = useState('')
  const [note, setNote] = useState('')

  const apps = useQuery({
    queryKey: ['applications', status],
    queryFn: () =>
      api.get<List<Application>>(`/api/v1/admissions/applications${status ? `?status=${status}` : ''}`),
  })
  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })

  function after() {
    qc.invalidateQueries({ queryKey: ['applications'] })
    qc.invalidateQueries({ queryKey: ['attention'] })
    setRemarks(''); setScore(''); setScheduledAt('')
  }

  const assess = useMutation({
    mutationFn: (kind: 'entrance_test' | 'interview') =>
      api.post(`/api/v1/admissions/workflow/applications/${open!.id}/assessment`, {
        kind,
        scheduled_at: scheduledAt || undefined,
        score: score ? Number(score) : undefined,
        max_score: score ? 100 : undefined,
        remarks,
      }),
    onSuccess: (_r, kind) => {
      setNote(kind === 'entrance_test' ? 'Entrance test recorded.' : 'Interview recorded.')
      after()
    },
  })

  const decide = useMutation({
    mutationFn: (v: { decision: string; remarks?: string }) =>
      api.post(`/api/v1/admissions/workflow/applications/${open!.id}/decision`, {
        decision: v.decision, remarks: v.remarks ?? remarks,
      }),
    onSuccess: (_r, v) => {
      setNote(
        v.decision === 'offered'
          ? 'Offer issued. The parent can be told to pay the admission fee.'
          : v.decision === 'waitlisted'
            ? 'Waitlisted — no seat yet, and ranked against the queue.'
            : v.decision === 'on_hold'
              /* Said differently from waitlisted on purpose: the seat is
                 there, and the reason is what somebody picking this up in
                 three weeks will have to act on. */
              ? 'On hold. The seat is held and the reason is on the record.'
              : 'Rejected.',
      )
      after()
    },
  })

  /* THE PARENT'S LOGIN, AT THE MOMENT IT IS ISSUED.

     Enrolling now creates the family's portal account and messages it to them.
     The password comes back in this response and nowhere else -- nothing in
     this product can read a password back out afterwards -- so if the message
     does not arrive, this screen is the only copy that ever existed. The
     parent is usually still standing at the desk, which is the one moment it
     can be handed over by hand. */
  const [login, setLogin] = useState<ParentLogin | null>(null)

  const enrol = useMutation({
    mutationFn: () =>
      api.post<{ parent_login?: ParentLogin }>(
        `/api/v1/admissions/workflow/applications/${open!.id}/enrol`,
        {
          section_id: sectionId,
          // Omitted entirely for a walker. The server treats an absent route
          // as "no bus asked for" rather than as an error.
          ...(routeId && pickupStopId
            ? { transport: { route_id: routeId, pickup_stop_id: pickupStopId } }
            : {}),
        },
      ),
    onSuccess: (res) => {
      setNote('Enrolled. The applicant is now a student with an admission number.')
      setLogin(res.parent_login?.sign_in_as ? res.parent_login : null)
      setOpen(null); setSectionId(''); setRouteId(''); setPickupStopId('')
      after()
      qc.invalidateQueries({ queryKey: ['students'] })
    },
  })

  /* The class sought is a uuid, not a name — the endpoint rejects anything
     else — so the form has to offer the real classes rather than free text. */
  /* Which rungs this school uses. Both default on, so a school that has never
     opened the setting behaves exactly as it did. */
  /* Only the routes a bus is actually on. A route with no vehicle cannot be
     driven, and offering it here is how a child ends up allocated to a service
     that does not run. */
  const routes = useQuery({
    queryKey: ['transport-routes', 'for-admission'],
    queryFn: () => api.get<List<{ id: string; name: string; code?: string }>>(
      '/api/v1/ops/transport/routes'),
  })
  const stops = useQuery({
    enabled: routeId !== '',
    queryKey: ['route-stops', 'for-admission', routeId],
    queryFn: () => api.get<List<{ id: string; name: string; pickup_time?: string }>>(
      `/api/v1/ops/transport/routes/${routeId}/stops`),
  })

  const stages = useQuery({
    queryKey: ['admissions', 'stages'],
    queryFn: () => api.get<{ entrance_test: boolean; interview: boolean }>(
      '/api/v1/admissions/workflow/stages'),
  })
  const usesTest = stages.data?.entrance_test ?? true
  const usesInterview = stages.data?.interview ?? true

  const saveStages = useMutation({
    mutationFn: (v: { entrance_test: boolean; interview: boolean }) =>
      api.put('/api/v1/admissions/workflow/stages', v),
    onSuccess: () => {
      /* The catalogue decides the menu from these, so the nav has to be
         refetched too — otherwise the entries stay until a reload. */
      qc.invalidateQueries({ queryKey: ['admissions', 'stages'] })
      qc.invalidateQueries({ queryKey: ['catalog'] })
      setNote('Admission steps updated.')
    },
  })

  const classes = useQuery({
    queryKey: ['academics', 'classes'],
    queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/academics/classes'),
  })

  const create = useMutation({
    mutationFn: () => api.post('/api/v1/admissions/workflow/applications', {
      ...form,
      form_fee: undefined,
      enquiry_id: form.enquiry_id || undefined,
      /* Rupees to paise at the boundary, so nothing downstream has to wonder
         which unit it is holding. */
      form_fee_paise: form.form_fee.trim()
        ? Math.round(Number(form.form_fee) * 100)
        : undefined,
      form_fee_paid: form.form_fee.trim() ? form.form_fee_paid : undefined,
      form_fee_receipt: form.form_fee_receipt || undefined,
      /* Sent only when filled: the server takes an empty date as a bad date
         rather than as "not answered". */
      date_of_birth: form.date_of_birth || undefined,
      gender: form.gender || undefined,
      category: form.category || undefined,
      parent_email: form.parent_email || undefined,
      address: form.address || undefined,
      previous_school: form.previous_school || undefined,
    }),
    onSuccess: () => {
      setForm(blank)
      setAdding(false)
      setNote('Application filed.')
      qc.invalidateQueries({ queryKey: ['applications'] })
    },
  })

  const items = apps.data?.items ?? []
  /* By the child's name, the parent's, the phone or the application number —
     the four things somebody at the desk has in front of them. */
  const { q: term, setQ: setTerm, shown } = useSearch(items,
    (a) => [a.application_no, a.name, a.parent_name, a.parent_phone, a.class_sought, a.status])

  /* Schools that charge no form fee should not carry an empty column down
     every row, so the column appears only once some form has a fee on it. */
  const anyFee = items.some((a) => a.form_fee_paise != null)

  /* Required paperwork all verified. Zero required documents counts as done
     rather than as outstanding — an application raised before the checklist
     existed has none, and it is not the clerk's fault. */
  const fullyChecked = (a: Application) =>
    a.docs_required === 0 || a.docs_verified >= a.docs_required
  const shortOfDocs = items.filter((a) => !fullyChecked(a))

  const count = (s: string) => items.filter((a) => a.status === s).length
  const live = items.filter((a) => !['rejected', 'withdrawn'].includes(a.status))

  /* The ladder this school actually climbs. Indices still come from the full
     LADDER, so an application already sitting on a rung the school has since
     switched off is still drawn in the right place rather than jumping. */
  const rungs = LADDER.filter((x) =>
    (x !== 'test_scheduled' || usesTest) && (x !== 'interviewed' || usesInterview))

  const stage = open ? stageIndex(open.status) : -1
  const terminal = open ? ['rejected', 'withdrawn'].includes(open.status) : false

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        title={title}
        description={description}
      />
      <PageBody>
        {/* Two grids rather than one holding a conditional.

            CellGrid counts its children with Children.toArray to lay the
            tracks out, and a fragment counts as one child however many Stats
            are inside it — so the four cards planned themselves as a single
            column and stacked down the page. */}
        {checking ? (
          <CellGrid cols={4}>
            <Stat label="Applications" value={live.length} />
            <Stat
              label="Short of a document"
              value={shortOfDocs.length}
              hint={shortOfDocs.length ? 'These cannot be given a seat yet' : 'Nothing outstanding'}
            />
            <Stat
              label="Rejected documents"
              value={items.filter((a) => a.docs_rejected > 0).length}
              hint={items.some((a) => a.docs_rejected > 0) ? 'The parent has to bring these back' : undefined}
            />
            <Stat label="Fully verified" value={items.filter(fullyChecked).length} />
          </CellGrid>
        ) : (
          <CellGrid cols={4}>
            <Stat label="Live applications" value={live.length} />
            <Stat label="Awaiting documents" value={count('documents_pending')} />
            <Stat label="Offered" value={count('offered')} hint="Waiting on the parent" />
            <Stat label="Accepted" value={count('accepted')} hint={count('accepted') ? 'Ready to enrol' : undefined} />
          </CellGrid>
        )}

        <FormNotice
          error={assess.error || decide.error || enrol.error || create.error}
          ok={note}
        />

        {login && <ParentLoginCard login={login} onClose={() => setLogin(null)} />}

        {mayWrite && !checking && (
          <Card>
            <CardHeader
              title="Which steps this school uses"
              description="Switch off what you do not run — the menu entry and the stage go with it."
            />
            <div className="flex flex-wrap gap-6 p-5">
              <Checkbox
                checked={usesTest}
                onChange={(v) => saveStages.mutate({ entrance_test: v, interview: usesInterview })}
                label="Entrance test"
                hint="An admission test applicants sit before a decision."
              />
              <Checkbox
                checked={usesInterview}
                onChange={(v) => saveStages.mutate({ entrance_test: usesTest, interview: v })}
                label="Interview"
                hint="A meeting with the child or the parents before a decision."
              />
            </div>
          </Card>
        )}

        {adding && (
          <Card>
            <CardHeader
              title="New application"
              description="What the form says. An application number is issued on save."
            />
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">First name *</span>
                <Input value={form.first_name} onChange={set('first_name')} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Last name</span>
                <Input value={form.last_name} onChange={set('last_name')} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Date of birth</span>
                <Input type="date" value={form.date_of_birth} onChange={set('date_of_birth')} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Class sought *</span>
                <Select
                  value={form.class_sought}
                  onChange={set('class_sought')}
                  placeholder={classes.isLoading ? 'Loading\u2026' : 'Pick a class'}
                  options={(classes.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Gender</span>
                <Select
                  value={form.gender}
                  onChange={set('gender')}
                  placeholder="Not stated"
                  options={[
                    { value: 'male', label: 'Male' },
                    { value: 'female', label: 'Female' },
                    { value: 'other', label: 'Other' },
                  ]}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Category</span>
                <Select
                  value={form.category}
                  onChange={set('category')}
                  placeholder="Not stated"
                  options={[
                    { value: 'general', label: 'General' },
                    { value: 'obc', label: 'OBC' },
                    { value: 'sc', label: 'SC' },
                    { value: 'st', label: 'ST' },
                    { value: 'ews', label: 'EWS' },
                    { value: 'other', label: 'Other' },
                  ]}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Parent name *</span>
                <Input value={form.parent_name} onChange={set('parent_name')} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Parent phone *</span>
                <Input value={form.parent_phone} onChange={set('parent_phone')} placeholder="98xxxxxxxx" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Parent email</span>
                <Input value={form.parent_email} onChange={set('parent_email')} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Previous school</span>
                <Input value={form.previous_school} onChange={set('previous_school')} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] lg:col-span-2">
                <span className="text-muted-foreground">Address</span>
                <Input value={form.address} onChange={set('address')} />
              </label>

              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Form fee (&#8377;)</span>
                <Input value={form.form_fee} onChange={set('form_fee')} placeholder="Leave blank if none" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Receipt no.</span>
                <Input
                  value={form.form_fee_receipt}
                  onChange={set('form_fee_receipt')}
                />
              </label>
              <div className="flex items-end gap-4 lg:col-span-2">
                <Checkbox
                  checked={form.form_fee_paid}
                  onChange={(v) => setForm((f) => ({ ...f, form_fee_paid: v }))}
                  label="Fee taken now"
                />
                <Checkbox
                  checked={form.is_rte}
                  onChange={(v) => setForm((f) => ({ ...f, is_rte: v }))}
                  label="RTE applicant"
                />
              </div>
            </div>
            <div className="flex gap-2 border-t px-5 py-4">
              <Button
                disabled={
                  !form.first_name.trim() || !form.parent_name.trim() ||
                  !form.parent_phone.trim() || !form.class_sought || create.isPending
                }
                onClick={() => create.mutate()}
              >
                {create.isPending ? 'Filing\u2026' : 'File application'}
              </Button>
              <Button variant="ghost" onClick={() => { setAdding(false); setForm(blank) }}>
                Cancel
              </Button>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Applicants"
            description="Select one to move it along"
            action={
              <span className="flex flex-wrap items-center gap-2">
                <Showing shown={shown.length} total={items.length} noun="applications" />
                <SearchBox value={term} onChange={setTerm} placeholder="Name, parent, phone or no." />
                <Select
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: '', label: 'All' },
                    ...rungs.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
                    { value: 'waitlisted', label: 'waitlisted' },
                    { value: 'rejected', label: 'rejected' },
                  ]}
                />
                <ExportRows
                  rows={shown}
                  name="applications"
                  columns={[
                    { header: 'Application no', value: (a) => a.application_no },
                    { header: 'Applicant', value: (a) => a.name },
                    { header: 'Class', value: (a) => a.class_sought },
                    { header: 'Parent', value: (a) => a.parent_name },
                    { header: 'Phone', value: (a) => a.parent_phone },
                    { header: 'RTE', value: (a) => (a.is_rte ? 'yes' : 'no') },
                    { header: 'Status', value: (a) => a.status },
                    { header: 'Applied', value: (a) => a.created_at },
                    {
                      header: 'Form fee',
                      value: (a) => (a.form_fee_paise == null ? '' : a.form_fee_paise / 100),
                    },
                    { header: 'Fee paid on', value: (a) => a.form_fee_paid_at },
                  ]}
                />
                {mayWrite && !checking && (
                  <Button size="sm" onClick={() => setAdding((v) => !v)}>
                    <Plus className="h-3.5 w-3.5" />
                    New application
                  </Button>
                )}
              </span>
            }
          />
          {apps.isLoading ? (
            <Loading />
          ) : apps.error ? (
            <ErrorState error={apps.error} />
          ) : (
            <Table
              wide
              head={['Application', 'Applicant', 'Class', 'Parent',
                     ...(checking ? ['Documents'] : ['Status']), 'Applied',
                     ...(anyFee ? ['Form fee'] : []), '']}
              empty={!shown.length}
              emptyLabel={term ? 'No application matches that.' : 'No applications yet.'}
            >
              {(checking
                /* Outstanding first, and among those the ones with something
                   rejected — a parent already sent away once. */
                ? [...shown].sort((x, y) =>
                    Number(fullyChecked(x)) - Number(fullyChecked(y)) ||
                    y.docs_rejected - x.docs_rejected)
                : shown
              ).map((a) => (
                <tr key={a.id} className={cn(open?.id === a.id && 'bg-accent')}>
                  <Td className="font-mono text-[12px]">{a.application_no}</Td>
                  <Td className="font-medium">
                    {a.name}
                    {a.is_rte && (
                      <span className="ml-1.5 rounded-sm border px-1 text-[11px] text-muted-foreground">
                        RTE
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{a.class_sought ?? '—'}</Td>
                  <Td>
                    {a.parent_name}
                    <a href={`tel:${a.parent_phone}`} className="block text-[12px] text-primary">
                      {a.parent_phone}
                    </a>
                  </Td>
                  <Td>
                    {checking ? (
                      a.docs_rejected > 0 ? (
                        <Badge tone="danger">
                          {a.docs_rejected} rejected
                        </Badge>
                      ) : fullyChecked(a) ? (
                        <Badge tone="success">all verified</Badge>
                      ) : (
                        <Badge tone="warning">
                          {a.docs_verified} of {a.docs_required} verified
                        </Badge>
                      )
                    ) : (
                      <StatusPill status={a.status} />
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(a.created_at)}</Td>
                  {anyFee && (
                    <Td className="num">
                      {a.form_fee_paise == null ? (
                        <span className="text-muted-foreground">&mdash;</span>
                      ) : a.form_fee_paid_at ? (
                        <Badge tone="success">&#8377;{a.form_fee_paise / 100} paid</Badge>
                      ) : (
                        <Badge tone="warning">&#8377;{a.form_fee_paise / 100} due</Badge>
                      )}
                    </Td>
                  )}
                  <Td>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => { setOpen(open?.id === a.id ? null : a); setNote('') }}
                    >
                      Open
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {open && (
          <Card>
            <CardHeader
              title={`${open.name} · ${open.application_no}`}
              description={`${open.class_sought ?? 'Class not set'} · parent ${open.parent_name}`}
              action={<Button variant="ghost" onClick={() => setOpen(null)}>Close</Button>}
            />

            {/* Where this applicant has got to. A ladder read left to right
                says more than a status word on its own. */}
            <div className="flex flex-wrap items-center gap-1 border-b px-5 py-4">
              {rungs.map((s) => {
                const i = LADDER.indexOf(s)
                return (
                <span
                  key={s}
                  className={cn(
                    'rounded-[6px] px-2 py-1 text-[12px]',
                    i < stage && 'text-muted-foreground',
                    i === stage && 'bg-nav-active font-medium text-foreground',
                    i > stage && 'text-muted-foreground/50',
                  )}
                >
                  {s.replace(/_/g, ' ')}
                </span>
                )
              })}
              {/* WHERE IT STANDS, ALWAYS.

                  The pill was drawn only for a rejected or withdrawn
                  application, so the moment somebody pressed "Offer a place"
                  the buttons vanished and nothing appeared in their place. The
                  screen had recorded the decision and did not say so, which
                  reads as a button that did nothing. */}
              <StatusPill status={open.status} className="ml-2" />
            </div>

            {terminal ? (
              <div className="px-5 py-6 text-[14px] text-muted-foreground">
                This application is closed. Nothing further to do.
              </div>
            ) : (
              <div className="flex flex-col gap-5 p-5">
                {/* The paperwork first: a decision taken before the birth
                    certificate is checked is a decision taken twice.

                    AND ONLY UNTIL THE DECISION IS TAKEN. Once a place is
                    offered the checklist has done its work, and leaving it at
                    the top of the panel puts three inches of ticked boxes
                    between the reader and the thing that is now next —
                    accepting, enrolling, or chasing the family. */}
                {stage < stageIndex('offered') && (
                  <Documents applicationId={open.id} canWrite={mayWrite} />
                )}

                {/* Assessment — schedule or score a test or interview. */}
                {mayWrite && (usesTest || usesInterview) && stage < stageIndex('offered') && (
                  <div>
                    <p className="eyebrow mb-2">
                      {usesTest && usesInterview ? 'Entrance test or interview'
                        : usesTest ? 'Entrance test' : 'Interview'}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="flex flex-col gap-1.5 text-[13px]">
                        <span className="text-muted-foreground">Scheduled for</span>
                        <Input value={scheduledAt} onChange={setScheduledAt} type="date" />
                      </label>
                      <label className="flex flex-col gap-1.5 text-[13px]">
                        <span className="text-muted-foreground">Score out of 100</span>
                        <Input value={score} onChange={setScore} placeholder="leave blank to schedule" />
                      </label>
                      <label className="flex flex-col gap-1.5 text-[13px]">
                        <span className="text-muted-foreground">Remarks</span>
                        <Input value={remarks} onChange={setRemarks} />
                      </label>
                    </div>
                    <div className="mt-3 flex gap-2">
                      {usesTest && (
                        <Button size="sm" variant="secondary" disabled={assess.isPending}
                          onClick={() => assess.mutate('entrance_test')}>
                          Record entrance test
                        </Button>
                      )}
                      {usesInterview && (
                        <Button size="sm" variant="secondary" disabled={assess.isPending}
                          onClick={() => assess.mutate('interview')}>
                          Record interview
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {/* Decision. */}
                {mayWrite && stage < stageIndex('offered') && (
                  <div className="border-t pt-5">
                    <p className="eyebrow mb-2">Decision</p>
                    <div className="flex flex-wrap gap-2">
                      <Button disabled={decide.isPending} onClick={() => decide.mutate({ decision: 'offered' })}>
                        Offer a place
                      </Button>
                      <Button variant="secondary" disabled={decide.isPending}
                        onClick={() => decide.mutate({ decision: 'waitlisted' })}>
                        Waitlist
                      </Button>
                      {/* HOLD IS NOT WAITLIST. Waitlisted means there is no
                          seat and the child is ranked; a hold means the seat
                          is there and something else is unsettled — the fee,
                          a concession decision, a document. */}
                      <Button variant="secondary" disabled={decide.isPending}
                        onClick={() => {
                          const why = window.prompt(
                            'What is being waited on? Whoever picks this up will not have been in the room.')
                          if (why && why.trim()) {
                            decide.mutate({ decision: 'on_hold', remarks: why.trim() })
                          }
                        }}>
                        Hold
                      </Button>
                      <Button variant="secondary" tone="danger" disabled={decide.isPending}
                        onClick={() => decide.mutate({ decision: 'rejected' })}>
                        Reject
                      </Button>
                    </div>
                  </div>
                )}

                {/* Enrol — only once the parent has accepted. Turning an
                    applicant into a student is the one irreversible step here,
                    so it appears only when it is actually the next one. */}
                {/* THE SERVER TAKES 'offered'; THIS DEMANDED 'accepted'.

                    Only enrolApplicant ever sets accepted, and it sets it AS
                    PART OF enrolling — so an offered application could never
                    reach the form that would have accepted it. The normal path
                    for every new admission was a deadlock, and the screen said
                    nothing because by its own logic there was simply nothing
                    to show. Both states now, matching the handler. */}
                {(open.status === 'offered' || open.status === 'accepted') && mayEnrol && (
                  <div className="border-t pt-5">
                    <p className="eyebrow mb-2">Enrol</p>
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1.5 text-[13px]">
                        <span className="text-muted-foreground">Into section</span>
                        <Select
                          value={sectionId}
                          onChange={setSectionId}
                          placeholder="Select…"
                          options={(sections.data?.items ?? []).map((s) => ({
                            value: s.id,
                            label: `${s.class_name}-${s.name} (${s.enrolled}/${s.capacity})`,
                          }))}
                        />
                      </label>
                      <label className="flex flex-col gap-1.5 text-[13px]">
                        <span className="text-muted-foreground">Bus route</span>
                        <Select
                          value={routeId}
                          onChange={(v) => { setRouteId(v); setPickupStopId('') }}
                          placeholder="Walks or own transport"
                          options={(routes.data?.items ?? []).map((r) => ({
                            value: r.id,
                            label: r.code ? `${r.name} (${r.code})` : r.name,
                          }))}
                        />
                      </label>
                      {routeId && (
                        <label className="flex flex-col gap-1.5 text-[13px]">
                          <span className="text-muted-foreground">Boards at</span>
                          <Select
                            value={pickupStopId}
                            onChange={setPickupStopId}
                            placeholder={stops.isFetching ? 'Loading…' : 'Select…'}
                            options={(stops.data?.items ?? []).map((st) => ({
                              value: st.id,
                              label: st.pickup_time ? `${st.name} · ${st.pickup_time}` : st.name,
                            }))}
                          />
                        </label>
                      )}
                      <Button
                        disabled={!sectionId || (!!routeId && !pickupStopId) || enrol.isPending}
                        onClick={() => enrol.mutate()}
                      >
                        {enrol.isPending ? 'Enrolling…' : 'Create the student record'}
                      </Button>
                    </div>
                    <p className="mt-2 text-[12.5px] text-muted-foreground">
                      This issues an admission number and creates the enrolment. The application
                      stays on file against the new student.
                    </p>
                  </div>
                )}

                {open.status === 'offered' && (
                  <p className="text-[13.5px] text-muted-foreground">
                    An offer is out. The parent accepts by paying the admission fee — once the
                    payment is recorded, this application becomes enrollable.
                  </p>
                )}
              </div>
            )}
          </Card>
        )}
      </PageBody>
    </>
  )
}

interface ParentLogin {
  sign_in_as?: string
  password?: string
  full_name?: string
  existing?: boolean
  sent_to?: string[]
  note?: string
}

/* Shown once, and said so.

   Deliberately not a toast. A toast that carries a password is a password the
   office loses by looking away, and the one thing this card must survive is
   the clerk turning round to speak to the parent. It stays until dismissed. */
function ParentLoginCard({ login, onClose }: { login: ParentLogin; onClose: () => void }) {
  const sent = login.sent_to ?? []
  return (
    <Card>
      <CardHeader
        title={login.existing ? 'This parent already has a login' : "The parent's login"}
        description={
          login.existing
            ? 'A second child on the same account. The password is unchanged, so it is not shown.'
            : 'Give this to the parent now. The password cannot be read back once this card is closed.'
        }
        action={<Button variant="secondary" onClick={onClose}>Done</Button>}
      />
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Sign in as">
          <p className="select-all font-mono text-[15px]">{login.sign_in_as}</p>
        </Field>
        {login.password && (
          <Field label="Password">
            <p className="select-all font-mono text-[15px]">{login.password}</p>
          </Field>
        )}
      </div>
      <div className="border-t px-4 py-3 text-[13px] text-muted-foreground">
        {sent.length > 0
          ? `Also sent by ${sent.join(', ')}.`
          : 'Not sent: this parent has no phone or email on record, so read it out now.'}
        {login.note ? ` ${login.note}` : ''}
      </div>
    </Card>
  )
}
