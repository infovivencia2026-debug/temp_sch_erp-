import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, ClipboardList, GraduationCap, UserCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { useCan } from '@/lib/session'
import { formatPaise } from '@/lib/utils'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Field, FormGrid, FormNotice,
  Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'

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
  if (!min && !max) return '—'
  if (min && max) return `${formatPaise(min)} – ${formatPaise(max)}`
  return formatPaise((min ?? max) as number)
}

const TABS = [
  ['posts', 'Posts', Briefcase],
  ['pipeline', 'Pipeline', ClipboardList],
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

  if (vacancies.isLoading) return <Loading label="Reading the open posts…" />
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
        title="Recruitment"
        description="The post, the people applying for it, and the demo lesson that actually decides. A hire made here creates the staff record; it does not ask somebody to type it again."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Approved posts" value={open.length} icon={Briefcase}
            hint={seatsToFill ? `${seatsToFill} position${seatsToFill === 1 ? '' : 's'} still to fill` : 'Every position taken'} />
          <Stat label="Awaiting approval" value={awaiting.length}
            delta={awaiting.length
              ? { value: 'Nobody may be interviewed yet', positive: false }
              : { value: 'Nothing waiting on a signature', positive: true }} />
          <Stat label="Candidates in process" value={inProcess} icon={ClipboardList} />
          <Stat label="Joined" value={joined} icon={UserCheck} />
        </CellGrid>

        <div className="flex flex-wrap gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)} aria-current={tab === k}
              className={tab === k
                ? '-mb-px flex items-center gap-1.5 border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                : '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {tab === 'posts' && <PostsTab posts={posts} />}
        {tab === 'pipeline' && <PipelineTab posts={posts} stages={stages} />}
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
        salary_min_paise: minSalary ? Math.round(Number(minSalary) * 100) : undefined,
        salary_max_paise: maxSalary ? Math.round(Number(maxSalary) * 100) : undefined,
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
                  <div className="flex justify-end gap-2">
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
              options={openPosts.map((v) => ({ value: v.id, label: `${v.code} — ${v.title}` }))} />
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
        <Table
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
                {c.qualification ?? '—'}
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
                  ? '—'
                  : `${c.days_since_move} days`}
              </Td>
              <Td className="text-right">
                {mayWrite && c.stage !== 'joined' && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Select
                      value=""
                      onChange={(stage) => stage && move.mutate({ id: c.id, stage })}
                      placeholder="Move to…"
                      options={STAGES.filter(([s]) => s !== c.stage).map(([value, label]) => ({ value, label }))}
                    />
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
          <Field label="Employee code" required hint="The school's own numbering — payroll already knows it">
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
