import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, DoorOpen, FileSignature, Route, ShieldCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Select, Textarea, SkeletonTable, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import AddStaff from './AddStaff'

/* Joining and leaving.

   The KYC an appointment is conditional on, the interview nobody records, the
   letters a teacher needs for their next job, and the departmental clearances
   the final settlement must not outrun. They are one screen because in a
   school they are one conversation: whether this person may go, and on what
   terms.

   The clearance panel is the point. A settlement cannot be paid until every
   department has signed — the database refuses it — so what is shown here is
   not a checklist to be tidied up afterwards but the gate itself. */

interface Employee { id: string; full_name?: string; name?: string; employee_code?: string }

interface Onboarding {
  id?: string
  employee_id: string
  employee_code: string
  full_name: string
  designation?: string
  joined_on: string
  status: string
  aadhaar_verified_on?: string
  pan_verified_on?: string
  bank_verified_on?: string
  originals_seen_on?: string
  contract_signed_on?: string
  pending: string[]
}

interface Exit {
  id: string
  employee_id: string
  employee_code: string
  full_name: string
  designation?: string
  joined_on: string
  kind: string
  notice_on: string
  last_working_day?: string
  reason?: string
  status: string
  interview_on?: string
  primary_reason?: string
  would_rejoin?: boolean
  feedback?: string
  settlement_status: string
  settlement_paise: number
  relieved_on?: string
  settled_on?: string
  departments: number
  outstanding: number
  dues_paise: number
  can_be_settled: boolean
}

interface Clearance {
  id: string
  department: string
  code: string
  status: string
  dues_paise: number
  remarks?: string
  cleared_by?: string
  cleared_on?: string
}

interface Transfer {
  id: string
  employee_code: string
  full_name: string
  kind: string
  from_campus?: string
  to_campus?: string
  to_institution?: string
  order_no?: string
  effective_from: string
  effective_to?: string
  reported_on?: string
  status: string
  overdue: boolean
}

interface Senior {
  rank: number
  employee_id: string
  employee_code: string
  full_name: string
  designation?: string
  department?: string
  joined_on: string
  confirmed_on?: string
  years_of_service: number
  deputed_days: number
}

interface Certificate {
  serial_no: string
  type: string
  code: string
  full_name: string
  issued_on: string
  status: string
}

const TABS = [
  ['onboarding', 'Onboarding & KYC', ClipboardCheck],
  ['exits', 'Exit & clearance', DoorOpen],
  ['letters', 'Letters issued', FileSignature],
  ['postings', 'Transfer & deputation', Route],
] as const

const rupees = (p: number) => (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })
const nameOf = (e: Employee) => e.full_name ?? e.name ?? e.id

function useEmployees() {
  return useQuery({
    queryKey: ['employees', 'lifecycle'],
    queryFn: () => api.get<List<Employee>>('/api/v1/hr/employees?limit=300'),
  })
}

export default function Lifecycle() {
  const can = useCan()
  const qc = useQueryClient()
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('onboarding')

  const onboarding = useQuery({
    queryKey: ['hr', 'onboarding'],
    queryFn: () => api.get<List<Onboarding>>('/api/v1/hr/onboarding'),
  })
  const exits = useQuery({
    queryKey: ['hr', 'exits'],
    queryFn: () => api.get<List<Exit>>('/api/v1/hr/exits'),
  })

  if (onboarding.isLoading) return <SkeletonTiles count={4} label="Reading the joining files…" />
  if (onboarding.error) return <ErrorState error={onboarding.error} />

  const files = onboarding.data?.items ?? []
  const open = (exits.data?.items ?? []).filter((e) => e.status !== 'settled')
  const unverified = files.filter((f) => f.pending.length > 0)
  const blocked = open.filter((e) => e.outstanding > 0)

  return (
    <>
      <PageHead
        eyebrow="Employees"
        title="Joining and leaving"
        description="The KYC an appointment depends on, the clearances a settlement must not outrun, and the letters a teacher takes to their next school."
      />
      <PageBody>
        {/* Where a joining actually starts.

            This screen is named for people joining and could not add one: its
            onboarding form takes an employee who already exists, and the only
            form that creates one sits at the bottom of the staff directory
            under Records. So somebody hiring a teacher opened "Staff joinings
            & exits", found a checklist for a person who was not there yet, and
            concluded the product could not appoint anybody.

            The same component, not a second implementation — it appoints the
            person, issues the login and hands over the password once. */}
        {can('hr.employees.write') && <AddStaff onDone={() => qc.invalidateQueries()} />}

        <CellGrid cols={4}>
          <Stat label="Files incomplete" value={unverified.length} icon={ClipboardCheck}
            delta={unverified.length
              ? { value: 'Aadhaar or PAN unverified', positive: false }
              : { value: 'Every appointment verified', positive: true }} />
          <Stat label="Exits in progress" value={open.length} icon={DoorOpen} />
          <Stat label="Awaiting a department" value={blocked.length}
            hint="No settlement can be paid until every one has signed" />
          <Stat label="Dues to recover"
            value={`₹${rupees(open.reduce((s, e) => s + e.dues_paise, 0))}`} icon={ShieldCheck} />
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

        {tab === 'onboarding' && <OnboardingTab rows={files} />}
        {tab === 'exits' && <ExitsTab rows={exits.data?.items ?? []} />}
        {tab === 'letters' && <LettersTab />}
        {tab === 'postings' && <PostingsTab />}
      </PageBody>
    </>
  )
}

function OnboardingTab({ rows }: { rows: Onboarding[] }) {
  const qc = useQueryClient()
  const [employeeId, setEmployeeId] = useState('')
  const [aadhaar, setAadhaar] = useState('')
  const [aadhaarRef, setAadhaarRef] = useState('')
  const [pan, setPan] = useState('')
  const [panRef, setPanRef] = useState('')
  const [bank, setBank] = useState('')
  const [originals, setOriginals] = useState('')
  const [contract, setContract] = useState('')
  const [status, setStatus] = useState('submitted')

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr/onboarding', {
        employee_id: employeeId,
        status,
        aadhaar_verified_on: aadhaar || undefined,
        aadhaar_ref: aadhaarRef || undefined,
        pan_verified_on: pan || undefined,
        pan_ref: panRef || undefined,
        bank_verified_on: bank || undefined,
        originals_seen_on: originals || undefined,
        contract_signed_on: contract || undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  })

  const chosen = rows.find((r) => r.employee_id === employeeId)

  return (
    <>
      <Card>
        <CardHeader
          title="Verify a joining file"
          description="Every check is a date, not a tick. A row saying PAN was verified, with no day and nobody attached, is the record an audit treats as unverified."
          action={
            <Select value={employeeId} onChange={setEmployeeId} placeholder="Choose an employee"
              options={rows.map((r) => ({ value: r.employee_id, label: `${r.full_name} — ${r.employee_code}` }))} />
          }
        />
        {!employeeId ? (
          <EmptyState title="Choose an employee" body="Their KYC checks and contract appear here." />
        ) : (
          <div className="space-y-5 p-5">
            {chosen && chosen.pending.length > 0 && (
              <p className="text-[13px] text-destructive">
                Still missing: {chosen.pending.join(', ')}
              </p>
            )}
            <FormGrid>
              <Field label="Aadhaar verified on"><Input value={aadhaar} onChange={setAadhaar} type="date" /></Field>
              <Field label="Aadhaar reference" hint="The acknowledgement the verification returned">
                <Input value={aadhaarRef} onChange={setAadhaarRef} placeholder="XXXX-1234" />
              </Field>
              <Field label="PAN verified on"><Input value={pan} onChange={setPan} type="date" /></Field>
              <Field label="PAN"><Input value={panRef} onChange={setPanRef} placeholder="ABCDE1234F" /></Field>
              <Field label="Bank account verified on"><Input value={bank} onChange={setBank} type="date" /></Field>
              <Field label="Originals seen on" hint="Who checked the degrees against the originals, and when">
                <Input value={originals} onChange={setOriginals} type="date" />
              </Field>
              <Field label="Contract signed on"><Input value={contract} onChange={setContract} type="date" /></Field>
              <Field label="File status">
                <Select value={status} onChange={setStatus} options={[
                  { value: 'invited', label: 'Invited' },
                  { value: 'submitted', label: 'Forms submitted' },
                  { value: 'verified', label: 'KYC verified' },
                  { value: 'completed', label: 'Completed' },
                ]} />
              </Field>
            </FormGrid>
            <FormNotice error={save.error} ok={save.isSuccess ? 'Saved.' : undefined} />
            <Button onClick={() => save.mutate()} disabled={save.isPending}>Save the file</Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Every appointment on file"
          description="Employees with no file at all are listed too. A screen that showed only the started ones would read as nothing to do." />
        <Table head={['Employee', 'Joined', 'Status', 'Aadhaar', 'PAN', 'Contract', 'Outstanding']}
          empty={rows.length === 0} emptyLabel="No employees yet.">
          {rows.map((r) => (
            <tr key={r.employee_id}>
              <Td className="font-medium">
                {r.full_name}
                <div className="text-[12px] font-normal text-muted-foreground">
                  {r.employee_code}{r.designation ? ` · ${r.designation}` : ''}
                </div>
              </Td>
              <Td className="text-muted-foreground">{r.joined_on}</Td>
              <Td><Badge tone={r.status === 'completed' ? 'success' : r.status === 'verified' ? 'info' : 'warning'}>{r.status}</Badge></Td>
              <Td className="text-muted-foreground">{r.aadhaar_verified_on ?? '—'}</Td>
              <Td className="text-muted-foreground">{r.pan_verified_on ?? '—'}</Td>
              <Td className="text-muted-foreground">{r.contract_signed_on ?? '—'}</Td>
              <Td className={r.pending.length ? 'text-destructive' : 'text-muted-foreground'}>
                {r.pending.length ? r.pending.join(', ') : 'nothing'}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}

function ExitsTab({ rows }: { rows: Exit[] }) {
  const qc = useQueryClient()
  const employees = useEmployees()
  const [employeeId, setEmployeeId] = useState('')
  const [kind, setKind] = useState('resignation')
  const [lastDay, setLastDay] = useState('')
  const [reason, setReason] = useState('')
  const [openExit, setOpenExit] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr/exits', {
        employee_id: employeeId, kind,
        last_working_day: lastDay || undefined,
        reason: reason || undefined,
      }),
    onSuccess: () => {
      setReason('')
      qc.invalidateQueries({ queryKey: ['hr'] })
    },
  })

  return (
    <>
      <Card>
        <CardHeader title="Record a notice"
          description="The clearance checklist is raised with the file, not when somebody remembers to ask for it. A settlement cannot be paid against an exit that has no list." />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Employee" required>
              <Select value={employeeId} onChange={setEmployeeId} placeholder="Choose an employee"
                options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: nameOf(e) }))} />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={setKind} options={[
                { value: 'resignation', label: 'Resignation' },
                { value: 'termination', label: 'Termination' },
                { value: 'retirement', label: 'Retirement' },
                { value: 'contract_end', label: 'Contract ended' },
                { value: 'transfer_out', label: 'Transferred out' },
              ]} />
            </Field>
            <Field label="Last working day" hint="What was agreed, which is often not what was asked for">
              <Input value={lastDay} onChange={setLastDay} type="date" />
            </Field>
            <Field label="Reason" wide>
              <Textarea value={reason} onChange={setReason} rows={2}
                placeholder="A termination with no reason on file is the one a tribunal asks about first." />
            </Field>
          </FormGrid>
          <FormNotice error={create.error} />
          <Button onClick={() => create.mutate()} disabled={!employeeId || create.isPending}>
            Open the exit file
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Exits in progress"
          description="Outstanding is the number of departments that have not signed. While it is above zero the final settlement is refused." />
        <Table head={['Employee', 'Kind', 'Notice', 'Last day', 'Interview', 'Clearance', 'Dues', 'Settlement', '']}
          empty={rows.length === 0} emptyLabel="Nobody is leaving.">
          {rows.map((r) => (
            <tr key={r.id}>
              <Td className="font-medium">
                {r.full_name}
                <div className="text-[12px] font-normal text-muted-foreground">{r.employee_code}</div>
              </Td>
              <Td className="text-muted-foreground">{r.kind.replace('_', ' ')}</Td>
              <Td className="text-muted-foreground">{r.notice_on}</Td>
              <Td className="text-muted-foreground">{r.last_working_day ?? '—'}</Td>
              <Td>{r.interview_on ? <Badge tone="success">done</Badge> : <Badge tone="warning">not held</Badge>}</Td>
              <Td>
                <Badge tone={r.outstanding === 0 && r.departments > 0 ? 'success' : 'warning'}>
                  {r.departments - r.outstanding} of {r.departments}
                </Badge>
              </Td>
              <Td className="tabular-nums">{r.dues_paise ? `₹${rupees(r.dues_paise)}` : '—'}</Td>
              <Td>
                <Badge tone={r.settlement_status === 'paid' ? 'success' : 'neutral'}>
                  {r.settlement_status}
                </Badge>
              </Td>
              <Td>
                <Button size="sm" variant="secondary"
                  onClick={() => setOpenExit(openExit === r.id ? '' : r.id)}>
                  {openExit === r.id ? 'Close' : 'Open'}
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {openExit && <ExitDetail exit={rows.find((r) => r.id === openExit)!} />}
    </>
  )
}

function ExitDetail({ exit }: { exit: Exit }) {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['hr'] })

  const clearances = useQuery({
    queryKey: ['hr', 'clearances', exit.id],
    queryFn: () => api.get<List<Clearance>>(`/api/v1/hr/exits/${exit.id}/clearances`),
  })

  const [primaryReason, setPrimaryReason] = useState(exit.primary_reason ?? '')
  const [feedback, setFeedback] = useState(exit.feedback ?? '')
  const [rejoin, setRejoin] = useState(exit.would_rejoin === false ? 'no' : 'yes')
  const [settlement, setSettlement] = useState('')

  const interview = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/hr/exits/${exit.id}/interview`, {
        primary_reason: primaryReason,
        would_rejoin: rejoin === 'yes',
        feedback: feedback || undefined,
      }),
    onSuccess: invalidate,
  })
  const sign = useMutation({
    mutationFn: (v: { department_code: string; status: string; dues_paise: number; remarks?: string }) =>
      api.post(`/api/v1/hr/exits/${exit.id}/clearances`, v),
    onSuccess: invalidate,
  })
  const relieve = useMutation({
    mutationFn: () => api.post(`/api/v1/hr/exits/${exit.id}/relieve`, {}),
    onSuccess: invalidate,
  })
  const settle = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/hr/exits/${exit.id}/settle`, {
        settlement_paise: Math.round(Number(settlement || 0) * 100),
      }),
    onSuccess: invalidate,
  })

  return (
    <>
      <Card>
        <CardHeader title={`Exit interview — ${exit.full_name}`}
          description="Ratings are optional and the reason is not. A school that collects five stars and no sentence learns nothing it can act on." />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Main reason for leaving" required>
              <Input value={primaryReason} onChange={setPrimaryReason} placeholder="Spouse relocation" />
            </Field>
            <Field label="Would they come back?">
              <Select value={rejoin} onChange={setRejoin}
                options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
            </Field>
            <Field label="What they said" wide>
              <Textarea value={feedback} onChange={setFeedback} rows={3} />
            </Field>
          </FormGrid>
          <FormNotice error={interview.error} ok={interview.isSuccess ? 'Recorded.' : undefined} />
          <Button onClick={() => interview.mutate()} disabled={!primaryReason || interview.isPending}>
            Record the interview
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Departmental clearance"
          description="Each department states what is outstanding before the money moves. Dues recorded here are deducted from the settlement, and the settlement is refused while any department is unsigned." />
        {clearances.isLoading ? (
          <SkeletonTable columns={6} label="Reading the checklist…" />
        ) : (
          <Table head={['Department', 'Status', 'Dues', 'Note', 'Signed', '']}
            empty={(clearances.data?.items ?? []).length === 0}>
            {(clearances.data?.items ?? []).map((c) => (
              <ClearanceLine key={c.id} row={c} onSign={(v) => sign.mutate(v)} />
            ))}
          </Table>
        )}
        <div className="border-t p-5">
          <FormNotice error={sign.error} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Relieving and settlement"
          description="The relieving letter and the experience certificate are generated from one snapshot, so the pair the next school reads can never disagree on a date." />
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <ConfirmButton confirmLabel="Relieve" variant="secondary"
              question="Issue the relieving letter and experience certificate?"
              disabled={!exit.can_be_settled || !!exit.relieved_on || relieve.isPending}
              onConfirm={() => relieve.mutate()}>
              Issue the letters
            </ConfirmButton>
            {!exit.can_be_settled && (
              <span className="text-[13px] text-muted-foreground">
                {exit.outstanding} department{exit.outstanding === 1 ? '' : 's'} still to sign.
              </span>
            )}
            {exit.relieved_on && (
              <span className="text-[13px] text-muted-foreground">Relieved on {exit.relieved_on}.</span>
            )}
          </div>
          <FormNotice error={relieve.error} />

          <FormGrid>
            <Field label="Settlement due (₹)" hint={`₹${rupees(exit.dues_paise)} of departmental dues will be deducted`}>
              <Input value={settlement} onChange={setSettlement} type="number" placeholder="45000" />
            </Field>
          </FormGrid>
          <FormNotice error={settle.error}
            ok={settle.isSuccess ? 'Settlement recorded.' : undefined} />
          <ConfirmButton confirmLabel="Pay" question="Pay the final settlement now?"
            variant="primary" disabled={!settlement || settle.isPending}
            onConfirm={() => settle.mutate()}>
            Pay the settlement
          </ConfirmButton>
        </div>
      </Card>
    </>
  )
}

function ClearanceLine({
  row,
  onSign,
}: {
  row: Clearance
  onSign: (v: { department_code: string; status: string; dues_paise: number; remarks?: string }) => void
}) {
  const [dues, setDues] = useState(row.dues_paise ? String(row.dues_paise / 100) : '')
  const [remarks, setRemarks] = useState(row.remarks ?? '')

  const send = (status: string) =>
    onSign({
      department_code: row.code,
      status,
      dues_paise: Math.round(Number(dues || 0) * 100),
      remarks: remarks || undefined,
    })

  return (
    <tr>
      <Td className="font-medium">{row.department}</Td>
      <Td>
        <Badge tone={row.status === 'cleared' ? 'success' : row.status === 'dues' ? 'danger' : 'warning'}>
          {row.status}
        </Badge>
      </Td>
      <Td className="w-32"><Input value={dues} onChange={setDues} type="number" placeholder="0" /></Td>
      <Td><Input value={remarks} onChange={setRemarks} placeholder="Three books not returned" /></Td>
      <Td className="text-muted-foreground">
        {row.cleared_on ?? '—'}
        {row.cleared_by && <div className="text-[12px]">{row.cleared_by}</div>}
      </Td>
      <Td>
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => send('dues')}>Hold</Button>
          <Button size="sm" onClick={() => send('cleared')}>Sign</Button>
        </div>
      </Td>
    </tr>
  )
}

/* The letters a school writes over a career, not only at the end of one.
 *
 * Two existed and both only at the exit. Everything else that goes on the
 * school's letterhead - the appointment letter that starts the employment, the
 * letter confirming a raise, the written warning that has to exist before
 * anybody is dismissed - was typed in Word, printed, signed, and remembered by
 * whoever typed it. The warning is the one that matters: a dismissal challenged
 * at a labour court turns on whether warnings were issued and when, and a file
 * on a clerk's laptop is not a record.
 *
 * Each gets a permanent serial from the school's own series and a snapshot of
 * the facts as they stood, so a letter issued in 2026 cannot change its own
 * contents in 2031. Printing one is logged with the name of whoever printed it.
 */
const LETTER_KINDS = [
  { value: 'APPOINTMENT', label: 'Appointment letter' },
  { value: 'SALARY_REVISION', label: 'Salary revision letter' },
  { value: 'WARNING', label: 'Warning letter' },
  { value: 'SERVICE', label: 'Service certificate' },
]

function LettersTab() {
  const qc = useQueryClient()
  const employees = useEmployees()
  const [employeeId, setEmployeeId] = useState('')
  const [kind, setKind] = useState('APPOINTMENT')
  const [body, setBody] = useState('')
  const [done, setDone] = useState('')

  const letters = useQuery({
    queryKey: ['hr', 'certificates'],
    queryFn: () => api.get<List<Certificate>>('/api/v1/hr/service-certificates'),
  })
  const prints = useQuery({
    queryKey: ['hr', 'letter-prints'],
    queryFn: () =>
      api.get<{ items: { serial_no: string; employee: string; printed_by: string; printed_at: string }[] }>(
        '/api/v1/hr/letters/prints',
      ),
    retry: false,
  })

  const issue = useMutation({
    mutationFn: () =>
      api.post<{ serial_no: string; name: string }>('/api/v1/hr/letters', {
        employee_id: employeeId, kind, body,
      }),
    onSuccess: (r) => {
      setDone(r.name + ' issued - serial ' + r.serial_no + '. It is on the service book too.')
      setBody('')
      qc.invalidateQueries({ queryKey: ['hr', 'certificates'] })
    },
  })

  // Printing is recorded, not prevented. A letter on school letterhead carries
  // the school's authority, so "who issued this" has to have an answer that
  // does not depend on somebody remembering.
  const printed = useMutation({
    mutationFn: (serial_no: string) => api.post('/api/v1/hr/letters/printed', { serial_no }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'letter-prints'] }),
  })

  const rows = letters.data?.items ?? []
  return (
    <>
    <Card>
      <CardHeader
        title="Write a letter"
        description="Appointment, a confirmed raise, a written warning, or a service certificate. Each gets a permanent serial and is kept exactly as it read on the day."
      />
      {done && <FormNotice ok={done} />}
      {issue.error && <FormNotice error={issue.error} />}
      <FormGrid>
        <Field label="Who it is for" required>
          <Select value={employeeId} onChange={setEmployeeId} placeholder="Choose"
            options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: nameOf(e) }))} />
        </Field>
        <Field label="Which letter" required>
          <Select value={kind} onChange={setKind} options={LETTER_KINDS} />
        </Field>
        <Field
          label={kind === 'WARNING' ? 'What the warning is about' : 'What this letter says'}
          hint={
            kind === 'WARNING'
              ? 'Required. A warning with no reason on it is worth nothing at a hearing.'
              : kind === 'SALARY_REVISION'
                ? 'The new salary and when it starts.'
                : 'Optional - the terms, or anything the letter should carry.'
          }
          wide
        >
          <Textarea rows={3} value={body} onChange={setBody} />
        </Field>
      </FormGrid>
      <Button
        onClick={() => issue.mutate()}
        disabled={!employeeId || issue.isPending || (kind === 'WARNING' && !body.trim())}
      >
        Issue the letter
      </Button>
    </Card>

    <Card>
      <CardHeader title="Letters issued"
        description="From the same serial series as a student's transfer certificate, so a serial can never be handed out twice." />
      {letters.isLoading ? (
        <SkeletonTable columns={6} />
      ) : (
        <Table head={['Serial', 'Letter', 'Employee', 'Issued', 'Status', '']} empty={rows.length === 0}
          emptyLabel="No letters issued yet. Write one above, or they are generated when an exit is relieved.">
          {rows.map((c) => (
            <tr key={c.serial_no}>
              <Td className="font-medium tabular-nums">{c.serial_no}</Td>
              <Td>{c.type}</Td>
              <Td>{c.full_name}</Td>
              <Td className="text-muted-foreground">{c.issued_on}</Td>
              <Td><Badge tone="success">{c.status}</Badge></Td>
              <Td>
                <Button size="sm" variant="ghost"
                  onClick={() => { printed.mutate(c.serial_no); window.print() }}>
                  Print
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>

    {(prints.data?.items.length ?? 0) > 0 && (
      <Card className="no-print">
        <CardHeader title="Who printed what"
          description="Every printing of a school letter, with the person who did it. Recorded rather than restricted: the dishonest use of a letter is a thing people do, not a thing software prevents." />
        <Table head={['Serial', 'Employee', 'Printed by', 'When']}>
          {(prints.data?.items ?? []).map((p, i) => (
            <tr key={p.serial_no + '-' + i}>
              <Td className="tabular-nums">{p.serial_no}</Td>
              <Td>{p.employee}</Td>
              <Td className="font-medium">{p.printed_by}</Td>
              <Td className="text-muted-foreground tabular-nums">{p.printed_at}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    )}
    </>
  )
}

function PostingsTab() {
  const qc = useQueryClient()
  const employees = useEmployees()
  const [employeeId, setEmployeeId] = useState('')
  const [kind, setKind] = useState('transfer')
  const [toInstitution, setToInstitution] = useState('')
  const [orderNo, setOrderNo] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')

  const transfers = useQuery({
    queryKey: ['hr', 'transfers'],
    queryFn: () => api.get<List<Transfer>>('/api/v1/hr/transfers'),
  })
  const seniority = useQuery({
    queryKey: ['hr', 'seniority'],
    queryFn: () => api.get<List<Senior>>('/api/v1/hr/seniority'),
  })
  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr/transfers', {
        employee_id: employeeId, kind,
        to_institution: toInstitution || undefined,
        order_no: orderNo || undefined,
        effective_from: from,
        effective_to: to || undefined,
        reason: reason || undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr'] }),
  })

  return (
    <>
      <Card>
        <CardHeader title="Record a posting order"
          description="The destination may be a school this system has never heard of: the transfers a district actually runs go outside it." />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Employee" required>
              <Select value={employeeId} onChange={setEmployeeId} placeholder="Choose an employee"
                options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: nameOf(e) }))} />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={setKind} options={[
                { value: 'transfer', label: 'Transfer' },
                { value: 'deputation', label: 'Deputation' },
                { value: 'promotion', label: 'Promotion' },
                { value: 'posting', label: 'Posting' },
                { value: 'repatriation', label: 'Repatriation' },
              ]} />
            </Field>
            <Field label="To school or office">
              <Input value={toInstitution} onChange={setToInstitution} placeholder="ZPHS Medchal" />
            </Field>
            <Field label="Order number"><Input value={orderNo} onChange={setOrderNo} placeholder="DEO/2026/114" /></Field>
            <Field label="Effective from" required><Input value={from} onChange={setFrom} type="date" /></Field>
            <Field label="Until"
              hint={kind === 'deputation' ? 'Required: a deputation with no end date is a transfer' : 'Leave blank for a permanent move'}>
              <Input value={to} onChange={setTo} type="date" />
            </Field>
            <Field label="Reason" wide><Input value={reason} onChange={setReason} /></Field>
          </FormGrid>
          <FormNotice error={save.error} ok={save.isSuccess ? 'Order recorded.' : undefined} />
          <Button onClick={() => save.mutate()} disabled={!employeeId || !from || save.isPending}>
            Record the order
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Postings on record" />
        <Table head={['Employee', 'Kind', 'To', 'Order', 'From', 'Until', 'Status']}
          empty={(transfers.data?.items ?? []).length === 0} emptyLabel="No postings recorded.">
          {(transfers.data?.items ?? []).map((t) => (
            <tr key={t.id}>
              <Td className="font-medium">{t.full_name}
                <div className="text-[12px] font-normal text-muted-foreground">{t.employee_code}</div>
              </Td>
              <Td className="text-muted-foreground">{t.kind}</Td>
              <Td>{t.to_campus ?? t.to_institution ?? '—'}</Td>
              <Td className="text-muted-foreground">{t.order_no ?? '—'}</Td>
              <Td className="text-muted-foreground">{t.effective_from}</Td>
              <Td className={t.overdue ? 'text-destructive' : 'text-muted-foreground'}>
                {t.effective_to ?? '—'}{t.overdue && ' · overdue'}
              </Td>
              <Td><Badge tone={t.status === 'returned' ? 'success' : 'neutral'}>{t.status}</Badge></Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <CardHeader title="Seniority"
          description="Ordered by confirmation where there is one and by joining otherwise, which is what a service manual says and what transfer counselling runs on. Days on deputation are shown rather than applied: states differ on whether they count." />
        <Table head={['#', 'Employee', 'Designation', 'Joined', 'Confirmed', 'Years', 'Deputed']}
          empty={(seniority.data?.items ?? []).length === 0}>
          {(seniority.data?.items ?? []).map((s) => (
            <tr key={s.employee_id}>
              <Td className="tabular-nums text-muted-foreground">{s.rank}</Td>
              <Td className="font-medium">{s.full_name}
                <div className="text-[12px] font-normal text-muted-foreground">{s.employee_code}</div>
              </Td>
              <Td className="text-muted-foreground">{s.designation ?? '—'}</Td>
              <Td className="text-muted-foreground">{s.joined_on}</Td>
              <Td className="text-muted-foreground">{s.confirmed_on ?? 'on probation'}</Td>
              <Td className="tabular-nums">{s.years_of_service}</Td>
              <Td className="tabular-nums text-muted-foreground">{s.deputed_days || '—'}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}
