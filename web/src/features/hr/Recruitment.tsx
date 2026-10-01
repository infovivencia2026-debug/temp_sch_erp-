import { useState } from 'react'
import { rupeesToPaise } from '@/lib/money'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, ClipboardList, GraduationCap, Handshake, UserCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { useCan } from '@/lib/session'
import { formatPaise } from '@/lib/utils'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Field, FormGrid, FormNotice,
  Input, Select, Textarea, SkeletonTiles, ErrorState, EmptyState, tabClass, TAB_BAR } from '@/components/ui'

/* Recruitment: the post, the people, and the day one of them becomes staff.

   A vacancy is raised and approved before anybody is interviewed, because the
   expensive mistake in an Indian school is not a bad hire — it is a post
   nobody authorised that payroll then carries for a year.

   The demo lesson is a first-class stage rather than a note on an interview.
   Schools here do not hire a teacher on a conversation; they watch them teach
   a real section for a period and ask the class afterwards.

   The screen's centre of gravity is the Hire button. Everything else records
   an intention; that one creates an employee through the same path the staff
   screen uses, keeps the candidate's record as the evidence for the
   appointment, and closes the post if it took the last position. It is the
   only place 'joined' can come from, which is why no stage dropdown offers
   it. */

interface Vacancy {
  id: string
  code: string
  title: string
  department?: string
  designation?: string
  subject?: string
  employment_type?: string
  positions: number
  salary_min_paise?: number
  salary_max_paise?: number
  min_qualification?: string
  status: string
  raised_by?: string
  raised_on: string
  approved_by?: string
  approved_on?: string
  closes_on?: string
  applicants: number
  in_process: number
  joined: number
  remaining: number
}

interface Candidate {
  id: string
  vacancy_id: string
  vacancy_code: string
  vacancy_title: string
  full_name: string
  email?: string
  phone?: string
  qualification?: string
  experience_years?: number
  current_employer?: string
  expected_salary_paise?: number
  notice_period_days?: number
  source: string
  stage: string
  applied_on: string
  rating?: number
  employee_id?: string
  employee_code?: string
  days_since_move: number
  interviews: number
  has_live_offer: boolean
}

interface FunnelStage {
  stage: string
  count: number
  median_days_waiting?: number
}

interface Designation { id: string; name: string }

const STAGES = [
  ['applied', 'Applied'],
  ['screened', 'Screened'],
  ['shortlisted', 'Shortlisted'],
  ['interviewed', 'Interviewed'],
  ['demo_lesson', 'Demo lesson'],
  ['offered', 'Offered'],
  ['rejected', 'Rejected'],
  ['withdrawn', 'Withdrawn'],
] as const

const STAGE_LABEL: Record<string, string> = {
  ...Object.fromEntries(STAGES),
  joined: 'Joined',
}

function stageTone(stage: string) {
  if (stage === 'joined') return 'success' as const
  if (stage === 'rejected' || stage === 'withdrawn') return 'neutral' as const
  if (stage === 'offered') return 'primary' as const
  return 'info' as const
}

function statusTone(status: string) {
  if (status === 'approved') return 'success' as const
  if (status === 'pending_approval') return 'warning' as const
  if (status === 'filled') return 'primary' as const
  if (status === 'rejected') return 'danger' as const
  return 'neutral' as const
}

// A band, not a figure. What is actually offered is settled candidate by
// candidate, so a vacancy showing one number would be read as a promise.
function band(min?: number, max?: number) {
  if (!min && !max) return '-'
  if (min && max) return `${formatPaise(min)} – ${formatPaise(max)}`
  return formatPaise((min ?? max) as number)
}

const TABS = [
  ['posts', 'Posts', Briefcase],
  ['pipeline', 'Pipeline', ClipboardList],
  ['interviews', 'Interviews & offers', Handshake],
] as const

export default function Recruitment() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('posts')

  const vacancies = useQuery({
    queryKey: ['hr-growth', 'vacancies'],
    queryFn: () => api.get<List<Vacancy>>('/api/v1/hr-growth/vacancies'),
  })
  const funnel = useQuery({
    queryKey: ['hr-growth', 'funnel'],
    queryFn: () => api.get<List<FunnelStage>>('/api/v1/hr-growth/recruitment/funnel'),
  })

  if (vacancies.isLoading) return <SkeletonTiles count={4} label="Reading the open posts…" />
  if (vacancies.error) return <ErrorState error={vacancies.error} />

  const posts = vacancies.data?.items ?? []
  const open = posts.filter((v) => v.status === 'approved')
  const awaiting = posts.filter((v) => v.status === 'pending_approval')
  const stages = funnel.data?.items ?? []
  const inProcess = stages
    .filter((s) => !['joined', 'rejected', 'withdrawn'].includes(s.stage))
    .reduce((n, s) => n + s.count, 0)
  const joined = stages.find((s) => s.stage === 'joined')?.count ?? 0
  const seatsToFill = open.reduce((n, v) => n + v.remaining, 0)

  return (
    <>
      <PageHead
        eyebrow="Hiring & growth"
        title="Staff hiring"
        description="Create job openings, track who applies and how their demo lesson went, and turn a hire into a staff record without typing the details a second time."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Open job positions" value={open.length} icon={Briefcase}
            hint={seatsToFill ? `${seatsToFill} position${seatsToFill === 1 ? '' : 's'} still to fill` : 'Every position taken'} />
          <Stat label="Waiting for approval" value={awaiting.length}
            delta={awaiting.length
              ? { value: 'Nobody may be interviewed yet', positive: false }
              : { value: 'Nothing waiting on a signature', positive: true }} />
          <Stat label="Active applicants" value={inProcess} icon={ClipboardList} />
          <Stat label="Hired staff" value={joined} icon={UserCheck} />
        </CellGrid>

        <div className={TAB_BAR}>
          {TABS.map(([k, label, Icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)} aria-current={tab === k}
              className={tab === k
                ? tabClass(true)
                : tabClass(false)}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {tab === 'posts' && <PostsTab posts={posts} />}
        {tab === 'pipeline' && <PipelineTab posts={posts} stages={stages} />}
        {tab === 'interviews' && <InterviewsTab />}
      </PageBody>
    </>
  )
}

/* Every write in this file is employees.write (hr_growth.go:85-96); the reads
   ride the group's employees.read. So an HR reader sees the pipeline and the
   posts and is not offered the buttons that would 403.

   Note for whoever wires up the reviewer's screen: POST
   /appraisal/records/{id}/review is deliberately NOT write-gated, because the
   reviewer is a head of department holding employees.read only and the handler
   checks they are the named reviewer. Do not wrap that control in this flag. */
function PostsTab({ posts }: { posts: Vacancy[] }) {
  const mayWrite = useCan()('hr.employees.write')
  const qc = useQueryClient()
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [designation, setDesignation] = useState('')
  const [positions, setPositions] = useState('1')
  const [minSalary, setMinSalary] = useState('')
  const [maxSalary, setMaxSalary] = useState('')
  const [qualification, setQualification] = useState('')
  const [justification, setJustification] = useState('')

  const designations = useQuery({
    queryKey: ['hr-growth', 'designations'],
    queryFn: () => api.get<List<Designation>>('/api/v1/hr-growth/designations'),
    retry: false,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['hr-growth'] })

  const raise = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr-growth/vacancies', {
        code,
        title,
        designation_id: designation || undefined,
        positions: Number(positions) || 1,
        // Rupees on the form, paise on the wire. Money is bigint paise
        // everywhere below this line and never a float.
        salary_min_paise: minSalary ? rupeesToPaise(minSalary) : undefined,
        salary_max_paise: maxSalary ? rupeesToPaise(maxSalary) : undefined,
        min_qualification: qualification || undefined,
        justification: justification || undefined,
        submit: true,
      }),
    onSuccess: () => {
      setCode(''); setTitle(''); setPositions('1')
      setMinSalary(''); setMaxSalary(''); setQualification(''); setJustification('')
      invalidate()
    },
  })

  const decide = useMutation({
    mutationFn: (v: { id: string; action: string }) =>
      api.post(`/api/v1/hr-growth/vacancies/${v.id}/decide`, { action: v.action }),
    onSuccess: invalidate,
  })

  return (
    <>
      <Card>
        <CardHeader
          title="Raise a post"
          description="Approval comes before advertising, not after. A vacancy sits at 'pending approval' until somebody with the budget signs it, and no candidate can be moved through a post that was never authorised."
        />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Reference" required hint="Printed on the advertisement and quoted by everyone who rings">
              <Input value={code} onChange={setCode} placeholder="VAC/2026/07" />
            </Field>
            <Field label="Post" required>
              <Input value={title} onChange={setTitle} placeholder="TGT Science" />
            </Field>
            <Field
              label="Designation"
              hint={designations.error ? 'The list of roles could not be loaded.' : undefined}
            >
              <Select value={designation} onChange={setDesignation}
                placeholder={designations.error ? 'Unavailable' : 'Not specified'}
                options={(designations.data?.items ?? []).map((d) => ({ value: d.id, label: d.name }))} />
            </Field>
            <Field label="Positions" hint="Three PRTs against one requisition is one post with three seats">
              <Input value={positions} onChange={setPositions} type="number" />
            </Field>
            <Field label="Band from (₹ a month)">
              <Input value={minSalary} onChange={setMinSalary} type="number" placeholder="25000" />
            </Field>
            <Field label="Band to (₹ a month)">
              <Input value={maxSalary} onChange={setMaxSalary} type="number" placeholder="35000" />
            </Field>
            <Field label="Minimum qualification" wide>
              <Input value={qualification} onChange={setQualification} placeholder="M.Sc with B.Ed, CTET qualified" />
            </Field>
            <Field label="Why the post is needed" wide hint="This is what the approver reads">
              <Textarea value={justification} onChange={setJustification}
                placeholder="Section 8-C added; current Science load is 34 periods against a 28 ceiling." />
            </Field>
          </FormGrid>
          <FormNotice error={raise.error} ok={raise.isSuccess ? 'Post raised for approval.' : undefined} />
          <Button onClick={() => raise.mutate()}
            disabled={!mayWrite || !code || !title || raise.isPending}>
            {raise.isPending ? 'Raising…' : 'Raise for approval'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Posts" description="Approved posts first; a closed vacancy is history." />
        <Table
          head={['Reference', 'Post', 'Band', 'Seats', 'Applicants', 'Status', '']}
          empty={posts.length === 0}
          emptyLabel="No posts raised yet."
        >
          {posts.map((v) => (
            <tr key={v.id}>
              <Td><span className="font-medium">{v.code}</span></Td>
              <Td>
                {v.title}
                {v.designation && (
                  <span className="block text-[12.5px] text-muted-foreground">{v.designation}</span>
                )}
              </Td>
              <Td>{band(v.salary_min_paise, v.salary_max_paise)}</Td>
              <Td>
                {v.joined}/{v.positions}
                {v.remaining > 0 && (
                  <span className="block text-[12.5px] text-muted-foreground">
                    {v.remaining} to fill
                  </span>
                )}
              </Td>
              <Td>
                {v.applicants}
                {v.in_process > 0 && (
                  <span className="block text-[12.5px] text-muted-foreground">
                    {v.in_process} in process
                  </span>
                )}
              </Td>
              <Td><Badge tone={statusTone(v.status)}>{v.status.replace(/_/g, ' ')}</Badge></Td>
              <Td className="text-right">
                {mayWrite && v.status === 'pending_approval' && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" onClick={() => decide.mutate({ id: v.id, action: 'approve' })}>
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => decide.mutate({ id: v.id, action: 'reject' })}>
                      Reject
                    </Button>
                  </div>
                )}
                {mayWrite && v.status === 'approved' && (
                  <Button size="sm" variant="ghost"
                    onClick={() => decide.mutate({ id: v.id, action: 'close' })}>
                    Close
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}

function PipelineTab({ posts, stages }: { posts: Vacancy[]; stages: FunnelStage[] }) {
  const mayWrite = useCan()('hr.employees.write')
  const qc = useQueryClient()
  const [vacancy, setVacancy] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [qualification, setQualification] = useState('')
  const [experience, setExperience] = useState('')
  const [hiring, setHiring] = useState<Candidate | null>(null)

  const candidates = useQuery({
    queryKey: ['hr-growth', 'candidates', vacancy],
    queryFn: () =>
      api.get<List<Candidate>>(
        `/api/v1/hr-growth/candidates${vacancy ? `?vacancy_id=${vacancy}` : ''}`,
      ),
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['hr-growth'] })

  const add = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr-growth/candidates', {
        vacancy_id: vacancy,
        full_name: name,
        phone: phone || undefined,
        email: email || undefined,
        qualification: qualification || undefined,
        experience_years: experience ? Number(experience) : undefined,
      }),
    onSuccess: () => {
      setName(''); setPhone(''); setEmail(''); setQualification(''); setExperience('')
      invalidate()
    },
  })

  const move = useMutation({
    mutationFn: (v: { id: string; stage: string }) =>
      api.post(`/api/v1/hr-growth/candidates/${v.id}/stage`, { stage: v.stage }),
    onSuccess: invalidate,
  })

  const openPosts = posts.filter((v) => v.status === 'approved' || v.status === 'filled')
  const rows = candidates.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="The funnel"
          description="How many at each stage, and how long they have been sitting there. A shortlist nobody has rung in three weeks has already taken another job."
        />
        {stages.length === 0 ? (
          <EmptyState title="No candidates yet" body="Add one below and the funnel fills in." />
        ) : (
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-5">
            {stages.map((s) => (
              <div key={s.stage} className="bg-background p-4">
                <p className="text-[13px] text-muted-foreground">{STAGE_LABEL[s.stage] ?? s.stage}</p>
                <p className="mt-1 text-[22px] font-semibold tracking-[-0.02em]">{s.count}</p>
                {s.median_days_waiting != null && (
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {Math.round(s.median_days_waiting)} days typical
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Add a candidate"
          description="A phone number or an email is enough to start. Everything else can be filled in when the file arrives."
          action={
            <Select value={vacancy} onChange={setVacancy} placeholder="All posts"
              options={openPosts.map((v) => ({ value: v.id, label: `${v.code} · ${v.title}` }))} />
          }
        />
        {!vacancy ? (
          <EmptyState title="Choose a post" body="Candidates are always against a specific vacancy." />
        ) : (
          <div className="space-y-5 p-5">
            <FormGrid>
              <Field label="Name" required><Input value={name} onChange={setName} /></Field>
              <Field label="Phone"><Input value={phone} onChange={setPhone} placeholder="98xxxxxxxx" /></Field>
              <Field label="Email"><Input value={email} onChange={setEmail} type="email" /></Field>
              <Field label="Qualification"><Input value={qualification} onChange={setQualification} placeholder="M.Sc B.Ed" /></Field>
              <Field label="Years of experience"><Input value={experience} onChange={setExperience} type="number" /></Field>
            </FormGrid>
            <FormNotice error={add.error} ok={add.isSuccess ? 'Candidate added.' : undefined} />
            <Button onClick={() => add.mutate()}
              disabled={!mayWrite || !name || (!phone && !email) || add.isPending}>
              {add.isPending ? 'Adding…' : 'Add candidate'}
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Candidates"
          description="Whoever has been waiting longest, first."
        />
        {/* Six columns with a dropdown and a button in the last one: without
            `wide` the width was divided equally, the Select was squeezed to a
            chevron, and its open menu was clipped by the row it sat in. */}
        <Table
          wide
          head={['Name', 'Post', 'Qualification', 'Stage', 'Waiting', '']}
          empty={rows.length === 0}
          emptyLabel="Nobody has applied against this post yet."
        >
          {rows.map((c) => (
            <tr key={c.id}>
              <Td>
                <span className="font-medium">{c.full_name}</span>
                <span className="block text-[12.5px] text-muted-foreground">
                  {c.phone ?? c.email}
                </span>
              </Td>
              <Td>{c.vacancy_code}</Td>
              <Td>
                {c.qualification ?? '-'}
                {c.experience_years != null && (
                  <span className="block text-[12.5px] text-muted-foreground">
                    {c.experience_years} yrs
                  </span>
                )}
              </Td>
              <Td>
                <Badge tone={stageTone(c.stage)}>{STAGE_LABEL[c.stage] ?? c.stage}</Badge>
                {c.employee_code && (
                  <span className="block text-[12.5px] text-muted-foreground">
                    {c.employee_code}
                  </span>
                )}
              </Td>
              <Td>
                {['joined', 'rejected', 'withdrawn'].includes(c.stage)
                  ? '-'
                  : `${c.days_since_move} days`}
              </Td>
              <Td className="text-right">
                {mayWrite && c.stage !== 'joined' && (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {/* Room to read the stage it is moving to. A Select given
                        no width collapses to its chevron in a crowded row, and
                        "Move to…" is the only thing that says what it does. */}
                    <div className="w-48 min-w-[11rem] text-left">
                      <Select
                        value=""
                        onChange={(stage) => stage && move.mutate({ id: c.id, stage })}
                        placeholder="Move to…"
                        options={STAGES.filter(([s]) => s !== c.stage).map(([value, label]) => ({ value, label }))}
                      />
                    </div>
                    <Button size="sm" onClick={() => setHiring(c)}>Hire</Button>
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {hiring && (
        /* Keyed by the candidate. The card holds the employee code, the joining
           date and the employment type; opening a second candidate reused them,
           so one person could be appointed on another's terms — and an employee
           code is unique, so the mistake surfaces as a constraint violation on
           a screen that had shown the number as already filled in. */
        <HireCard
          key={hiring.id}
          candidate={hiring}
          onDone={() => { setHiring(null); invalidate() }}
        />
      )}
    </>
  )
}

/* The hire.

   A separate card rather than an inline button because this is the one action
   on the screen that creates something outside recruitment. The employee code
   is asked for rather than generated: it is the school's own numbering and
   payroll already knows it. */
function HireCard({ candidate, onDone }: { candidate: Candidate; onDone: () => void }) {
  const mayWrite = useCan()('hr.employees.write')
  const [employeeCode, setEmployeeCode] = useState('')
  const [joinedOn, setJoinedOn] = useState('')
  const [employmentType, setEmploymentType] = useState('probation')
  const [createLogin, setCreateLogin] = useState(true)

  const hire = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/hr-growth/candidates/${candidate.id}/hire`, {
        employee_code: employeeCode,
        joined_on: joinedOn || undefined,
        employment_type: employmentType,
        create_login: createLogin && !!candidate.email,
        role_key: createLogin && candidate.email ? 'faculty' : undefined,
      }),
    onSuccess: onDone,
  })

  return (
    <Card>
      <CardHeader
        title={`Appoint ${candidate.full_name}`}
        description="This creates the staff record through the same path the employees screen uses, and keeps the candidate's file as the evidence for the appointment. If this was the last open position the post closes itself."
        action={<Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>}
      />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Employee code" required hint="The school's own numbering, payroll already knows it">
            <Input value={employeeCode} onChange={setEmployeeCode} placeholder="E-2026-041" />
          </Field>
          <Field label="Joining date"><Input value={joinedOn} onChange={setJoinedOn} type="date" /></Field>
          <Field label="Appointment type">
            <Select value={employmentType} onChange={setEmploymentType} options={[
              { value: 'probation', label: 'Probation' },
              { value: 'permanent', label: 'Permanent' },
              { value: 'contract', label: 'Contract' },
              { value: 'part_time', label: 'Part time' },
              { value: 'visiting', label: 'Visiting' },
            ]} />
          </Field>
          <Field label="Create a login"
            hint={candidate.email
              ? 'Invited, with no password until they set one'
              : 'No email on file, so no login can be created'}>
            <Select
              value={createLogin && candidate.email ? 'yes' : 'no'}
              onChange={(v) => setCreateLogin(v === 'yes')}
              options={[
                { value: 'yes', label: candidate.email ? 'Yes, invite them' : 'Not possible' },
                { value: 'no', label: 'No, records only' },
              ]}
            />
          </Field>
        </FormGrid>
        <FormNotice error={hire.error} />
        <div className="flex items-center gap-2">
          <Button onClick={() => hire.mutate()}
            disabled={!mayWrite || !employeeCode || hire.isPending}>
            {hire.isPending ? 'Appointing…' : 'Appoint and create staff record'}
          </Button>
          <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <GraduationCap className="h-3.5 w-3.5" aria-hidden />
            {candidate.interviews} interview{candidate.interviews === 1 ? '' : 's'} on file
          </span>
        </div>
      </div>
    </Card>
  )
}

/* Interviews and offers.

   The server kept both (job_interviews, job_offers) and nothing called them:
   a candidate could be moved to "Interviewed" or "Offered" with no record of
   the round, the panel's verdict or the salary put in writing. One row each
   to schedule and to issue, and the two outcomes recorded in place. */
interface Interview {
  id: string
  candidate: string
  vacancy_code: string
  round: string
  scheduled_at?: string
  mode: string
  venue?: string
  result: string
  score?: number
  remarks?: string
}

interface Offer {
  id: string
  candidate: string
  vacancy_code: string
  offered_on: string
  gross_monthly_paise: number
  joining_on?: string
  valid_until?: string
  status: string
  lapsed: boolean
}

function InterviewsTab() {
  const mayWrite = useCan()('hr.employees.write')
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['hr-growth'] })

  const candidates = useQuery({
    queryKey: ['hr-growth', 'candidates', ''],
    queryFn: () => api.get<List<Candidate>>('/api/v1/hr-growth/candidates'),
  })
  const interviews = useQuery({
    queryKey: ['hr-growth', 'interviews'],
    queryFn: () => api.get<List<Interview>>('/api/v1/hr-growth/interviews'),
  })
  const offers = useQuery({
    queryKey: ['hr-growth', 'offers'],
    queryFn: () => api.get<List<Offer>>('/api/v1/hr-growth/offers'),
  })

  const [cand, setCand] = useState('')
  const [round, setRound] = useState('')
  const [when, setWhen] = useState('')
  const [venue, setVenue] = useState('')
  const schedule = useMutation({
    mutationFn: () => api.post('/api/v1/hr-growth/interviews', {
      candidate_id: cand, round, scheduled_at: when || undefined, venue: venue || undefined,
    }),
    onSuccess: () => { setRound(''); setWhen(''); setVenue(''); invalidate() },
  })
  const result = useMutation({
    mutationFn: (v: { id: string; result: string }) =>
      api.post(`/api/v1/hr-growth/interviews/${v.id}/result`, { result: v.result }),
    onSuccess: invalidate,
  })

  const [offerCand, setOfferCand] = useState('')
  const [gross, setGross] = useState('')
  const [joining, setJoining] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const issue = useMutation({
    mutationFn: () => api.post('/api/v1/hr-growth/offers', {
      candidate_id: offerCand,
      gross_monthly_paise: rupeesToPaise(gross),
      joining_on: joining || undefined,
      valid_until: validUntil || undefined,
      send: true,
    }),
    onSuccess: () => { setGross(''); setJoining(''); setValidUntil(''); invalidate() },
  })
  const respond = useMutation({
    mutationFn: (v: { id: string; status: string }) =>
      api.post(`/api/v1/hr-growth/offers/${v.id}/respond`, { status: v.status }),
    onSuccess: invalidate,
  })

  const live = (candidates.data?.items ?? []).filter((c) => !['joined', 'rejected', 'withdrawn'].includes(c.stage))
  const candOptions = live.map((c) => ({ value: c.id, label: `${c.full_name} · ${c.vacancy_code}` }))
  const ivs = interviews.data?.items ?? []
  const offs = offers.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader title="Interviews" description="Each round, when and where, and what the panel decided." />
        {mayWrite && (
          <div className="px-5 pb-4">
            <FormGrid>
              <Field label="Candidate">
                <Select value={cand} onChange={setCand} placeholder="Choose a candidate" options={candOptions} />
              </Field>
              <Field label="Round">
                <Input value={round} onChange={setRound} placeholder="e.g. Panel, Principal" />
              </Field>
              <Field label="When">
                <Input type="datetime-local" value={when} onChange={setWhen} />
              </Field>
              <Field label="Venue">
                <Input value={venue} onChange={setVenue} />
              </Field>
            </FormGrid>
            <div className="mt-3">
              <Button disabled={!cand || !round.trim() || schedule.isPending} onClick={() => schedule.mutate()}>
                {schedule.isPending ? 'Scheduling…' : 'Schedule interview'}
              </Button>
            </div>
          </div>
        )}
        <FormNotice error={schedule.error ?? result.error} />
        {interviews.error ? <ErrorState error={interviews.error} /> : (
          <Table loading={interviews.isLoading} head={['Candidate', 'Round', 'When', 'Result', '']}
            empty={!ivs.length} emptyLabel="No interviews scheduled.">
            {ivs.map((i) => (
              <tr key={i.id}>
                <Td className="font-medium">{i.candidate}<span className="block text-[12px] font-normal text-muted-foreground">{i.vacancy_code}</span></Td>
                <Td>{i.round}</Td>
                <Td className="text-muted-foreground">{[i.scheduled_at, i.venue].filter(Boolean).join(' · ') || '-'}</Td>
                <Td><Badge tone={i.result === 'pass' ? 'success' : i.result === 'scheduled' ? 'info' : 'neutral'}>{i.result.replace('_', ' ')}</Badge></Td>
                <Td>
                  {mayWrite && i.result === 'scheduled' && (
                    <div className="flex gap-1">
                      {(['pass', 'fail', 'no_show'] as const).map((r) => (
                        <Button key={r} size="sm" variant={r === 'pass' ? 'primary' : 'secondary'}
                          disabled={result.isPending} onClick={() => result.mutate({ id: i.id, result: r })}>
                          {r === 'pass' ? 'Pass' : r === 'fail' ? 'Fail' : 'No show'}
                        </Button>
                      ))}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Offers" description="The salary put in writing, and whether the candidate took it." />
        {mayWrite && (
          <div className="px-5 pb-4">
            <FormGrid>
              <Field label="Candidate">
                <Select value={offerCand} onChange={setOfferCand} placeholder="Choose a candidate"
                  options={live.filter((c) => !c.has_live_offer).map((c) => ({ value: c.id, label: `${c.full_name} · ${c.vacancy_code}` }))} />
              </Field>
              <Field label="Gross monthly (₹)">
                <Input value={gross} onChange={setGross} />
              </Field>
              <Field label="Joining on">
                <Input type="date" value={joining} onChange={setJoining} />
              </Field>
              <Field label="Valid until">
                <Input type="date" value={validUntil} onChange={setValidUntil} />
              </Field>
            </FormGrid>
            <div className="mt-3">
              <Button disabled={!offerCand || !(Number(gross) > 0) || issue.isPending} onClick={() => issue.mutate()}>
                {issue.isPending ? 'Issuing…' : 'Issue offer'}
              </Button>
            </div>
          </div>
        )}
        <FormNotice error={issue.error ?? respond.error} />
        {offers.error ? <ErrorState error={offers.error} /> : (
          <Table loading={offers.isLoading} head={['Candidate', 'Gross / month', 'Joining', 'Status', '']}
            empty={!offs.length} emptyLabel="No offers issued.">
            {offs.map((o) => (
              <tr key={o.id}>
                <Td className="font-medium">{o.candidate}<span className="block text-[12px] font-normal text-muted-foreground">{o.vacancy_code} · {o.offered_on}</span></Td>
                <Td className="tabular-nums">{formatPaise(o.gross_monthly_paise)}</Td>
                <Td className="text-muted-foreground">{o.joining_on ?? '-'}</Td>
                <Td><Badge tone={o.status === 'accepted' ? 'success' : o.lapsed ? 'warning' : 'neutral'}>{o.lapsed ? 'lapsed' : o.status}</Badge></Td>
                <Td>
                  {mayWrite && (o.status === 'sent' || o.status === 'draft') && (
                    <div className="flex gap-1">
                      <Button size="sm" disabled={respond.isPending} onClick={() => respond.mutate({ id: o.id, status: 'accepted' })}>Accepted</Button>
                      <Button size="sm" variant="secondary" disabled={respond.isPending} onClick={() => respond.mutate({ id: o.id, status: 'declined' })}>Declined</Button>
                      <Button size="sm" variant="ghost" disabled={respond.isPending} onClick={() => respond.mutate({ id: o.id, status: 'withdrawn' })}>Withdraw</Button>
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
