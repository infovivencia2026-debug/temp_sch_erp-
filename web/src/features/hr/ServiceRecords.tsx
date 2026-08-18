import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookMarked, GraduationCap, HeartPulse, ShieldAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Checkbox, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'

/* What a school has to be able to produce when somebody asks.

   The service book a DEO inspection asks for by name, the degrees and TET
   certificates a board counts, the annual fitness certificate a food handler
   works under, and the police verification everyone working with children
   needs. Four registers, one screen, because they are all answers to the same
   question about the same person.

   Two things here are not conveniences. An attested service book page cannot
   be edited afterwards — corrections are further pages — and every fitness
   certificate and completed background check carries the date it stops being
   true, because a record that reads as compliant for ever is worse than none. */

interface Employee { id: string; full_name?: string; name?: string }

interface BookEntry {
  id: string
  employee_id: string
  full_name: string
  entry_kind: string
  event_date: string
  title: string
  particulars?: string
  order_no?: string
  designation?: string
  pay_paise?: number
  attested_by?: string
  attested_on?: string
  source: string
}

interface Qualification {
  id: string
  employee_id: string
  employee_code: string
  full_name: string
  qualification: string
  level: string
  discipline?: string
  board_university?: string
  year_of_passing?: number
  percentage?: number
  registration_no?: string
  is_teaching_qualification: boolean
  valid_until?: string
  verified_on?: string
  verified_by?: string
  lapsed: boolean
}

interface Medical {
  id: string
  employee_code: string
  full_name: string
  purpose: string
  issued_on: string
  valid_until: string
  fit: boolean
  examined_by?: string
  clinic?: string
  restrictions?: string
  days_left: number
  expired: boolean
}

interface Background {
  id: string
  employee_id: string
  employee_code: string
  full_name: string
  kind: string
  agency?: string
  requested_on: string
  reference_no?: string
  status: string
  completed_on?: string
  valid_until?: string
  findings?: string
  days_left?: number
  expired: boolean
}

const TABS = [
  ['book', 'Service book', BookMarked],
  ['qualifications', 'Qualifications', GraduationCap],
  ['medical', 'Medical fitness', HeartPulse],
  ['background', 'Background checks', ShieldAlert],
] as const

const nameOf = (e: Employee) => e.full_name ?? e.name ?? e.id

function useEmployees() {
  return useQuery({
    queryKey: ['employees', 'records'],
    queryFn: () => api.get<List<Employee>>('/api/v1/hr/employees?limit=300'),
  })
}

export default function ServiceRecords() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('book')

  const medical = useQuery({
    queryKey: ['hr', 'medical'],
    queryFn: () => api.get<List<Medical>>('/api/v1/hr/medical-fitness'),
  })
  const background = useQuery({
    queryKey: ['hr', 'background'],
    queryFn: () => api.get<List<Background>>('/api/v1/hr/background-checks'),
  })

  if (medical.error) return <ErrorState error={medical.error} />

  const meds = medical.data?.items ?? []
  const checks = background.data?.items ?? []
  const expiring = meds.filter((m) => m.days_left <= 60)
  const noPolice = checks.filter((c) => c.status !== 'clear' || c.expired)

  return (
    <>
      <PageHead
        eyebrow="Employees"
        title="Service records and verification"
        description="The service book, the qualifications a board counts, and the two clearances that expire — medical fitness and police verification."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Fitness certificates" value={meds.length} icon={HeartPulse} />
          <Stat label="Expiring within 60 days" value={expiring.length}
            delta={expiring.length
              ? { value: 'Book the examinations', positive: false }
              : { value: 'Nothing falls due', positive: true }} />
          <Stat label="Background checks" value={checks.length} icon={ShieldAlert} />
          <Stat label="Not currently clear" value={noPolice.length}
            hint="Requested, adverse, or lapsed past its re-check date" />
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

        {tab === 'book' && <ServiceBookTab />}
        {tab === 'qualifications' && <QualificationsTab />}
        {tab === 'medical' && <MedicalTab rows={meds} />}
        {tab === 'background' && <BackgroundTab rows={checks} />}
      </PageBody>
    </>
  )
}

function ServiceBookTab() {
  const qc = useQueryClient()
  const employees = useEmployees()
  const [employeeId, setEmployeeId] = useState('')
  const [kind, setKind] = useState('increment')
  const [eventDate, setEventDate] = useState('')
  const [title, setTitle] = useState('')
  const [particulars, setParticulars] = useState('')
  const [orderNo, setOrderNo] = useState('')
  const [pay, setPay] = useState('')

  const book = useQuery({
    queryKey: ['hr', 'service-book', employeeId],
    queryFn: () =>
      api.get<List<BookEntry>>(
        `/api/v1/hr/service-book${employeeId ? `?employee_id=${employeeId}` : ''}`,
      ),
  })
  const add = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr/service-book', {
        employee_id: employeeId, entry_kind: kind, event_date: eventDate, title,
        particulars: particulars || undefined,
        order_no: orderNo || undefined,
        pay_paise: pay ? Math.round(Number(pay) * 100) : undefined,
      }),
    onSuccess: () => {
      setTitle(''); setParticulars(''); setOrderNo(''); setPay('')
      qc.invalidateQueries({ queryKey: ['hr', 'service-book'] })
    },
  })
  const attest = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/hr/service-book/${id}/attest`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'service-book'] }),
  })

  const rows = book.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader title="Add a page"
          description="A page per event, in the order they happened. Once attested it can never be altered; a correction is a further page citing the order that made it."
          action={
            <Select value={employeeId} onChange={setEmployeeId} placeholder="Everybody"
              options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: nameOf(e) }))} />
          } />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Entry">
              <Select value={kind} onChange={setKind} options={[
                { value: 'appointment', label: 'Appointment' },
                { value: 'confirmation', label: 'Confirmation' },
                { value: 'promotion', label: 'Promotion' },
                { value: 'increment', label: 'Increment' },
                { value: 'transfer', label: 'Transfer' },
                { value: 'deputation', label: 'Deputation' },
                { value: 'leave_without_pay', label: 'Leave without pay' },
                { value: 'suspension', label: 'Suspension' },
                { value: 'punishment', label: 'Punishment' },
                { value: 'award', label: 'Award' },
                { value: 'training', label: 'Training' },
                { value: 'qualification', label: 'Qualification' },
                { value: 'retirement', label: 'Retirement' },
                { value: 'other', label: 'Other' },
              ]} />
            </Field>
            <Field label="Date of the event" required>
              <Input value={eventDate} onChange={setEventDate} type="date" />
            </Field>
            <Field label="Title" required wide>
              <Input value={title} onChange={setTitle} placeholder="Annual increment" />
            </Field>
            <Field label="Order number"><Input value={orderNo} onChange={setOrderNo} placeholder="VHS/INC/2026/22" /></Field>
            <Field label="Pay after the order (₹)"><Input value={pay} onChange={setPay} type="number" /></Field>
            <Field label="Particulars" wide><Textarea value={particulars} onChange={setParticulars} rows={2} /></Field>
          </FormGrid>
          <FormNotice error={add.error} />
          <Button onClick={() => add.mutate()} disabled={!employeeId || !title || !eventDate || add.isPending}>
            Add the page
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title={employeeId ? 'The book' : 'Every page on file'}
          description="Read forwards. A service record is a chronology, not a feed." />
        {book.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState title="No pages yet"
            body="The appointment page is written for you when an onboarding file is completed." />
        ) : (
          <Table head={['Date', 'Employee', 'Entry', 'Particulars', 'Order', 'Attested', '']}>
            {rows.map((e) => (
              <tr key={e.id}>
                <Td className="tabular-nums text-muted-foreground">{e.event_date}</Td>
                <Td className="font-medium">{e.full_name}</Td>
                <Td>
                  {e.title}
                  <div className="text-[12px] text-muted-foreground">
                    {e.entry_kind.replace(/_/g, ' ')}
                    {e.source !== 'manual' && ` · raised by ${e.source}`}
                  </div>
                </Td>
                <Td className="text-muted-foreground">{e.particulars ?? '—'}</Td>
                <Td className="text-muted-foreground">{e.order_no ?? '—'}</Td>
                <Td>
                  {e.attested_on
                    ? <Badge tone="success">{e.attested_on}</Badge>
                    : <Badge tone="warning">draft</Badge>}
                </Td>
                <Td>
                  {!e.attested_on && (
                    <ConfirmButton confirmLabel="Attest" size="sm"
                      question="After this the page can never be edited."
                      onConfirm={() => attest.mutate(e.id)}>
                      Attest
                    </ConfirmButton>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="border-t p-5"><FormNotice error={attest.error} /></div>
      </Card>
    </>
  )
}

function QualificationsTab() {
  const qc = useQueryClient()
  const employees = useEmployees()
  const [employeeId, setEmployeeId] = useState('')
  const [qualification, setQualification] = useState('')
  const [level, setLevel] = useState('graduate')
  const [discipline, setDiscipline] = useState('')
  const [board, setBoard] = useState('')
  const [year, setYear] = useState('')
  const [percentage, setPercentage] = useState('')
  const [teaching, setTeaching] = useState(false)
  const [validUntil, setValidUntil] = useState('')
  const [verified, setVerified] = useState(false)
  const [ref, setRef] = useState('')

  const list = useQuery({
    queryKey: ['hr', 'qualifications'],
    queryFn: () => api.get<List<Qualification>>('/api/v1/hr/qualifications'),
  })
  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr/qualifications', {
        employee_id: employeeId, qualification, level,
        discipline: discipline || undefined,
        board_university: board || undefined,
        year_of_passing: year ? Number(year) : undefined,
        percentage: percentage ? Number(percentage) : undefined,
        is_teaching_qualification: teaching,
        valid_until: validUntil || undefined,
        verified,
        verification_ref: ref || undefined,
      }),
    onSuccess: () => {
      setQualification(''); setDiscipline(''); setBoard(''); setYear(''); setPercentage('')
      qc.invalidateQueries({ queryKey: ['hr', 'qualifications'] })
    },
  })

  const rows = list.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader title="Record a qualification"
          description="employees.qualification holds one line for a directory card. This holds the four degrees, their universities and the TET a board actually counts." />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Employee" required>
              <Select value={employeeId} onChange={setEmployeeId} placeholder="Choose an employee"
                options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: nameOf(e) }))} />
            </Field>
            <Field label="Qualification" required>
              <Input value={qualification} onChange={setQualification} placeholder="B.Ed" />
            </Field>
            <Field label="Level">
              <Select value={level} onChange={setLevel} options={[
                { value: 'school', label: 'School' },
                { value: 'diploma', label: 'Diploma' },
                { value: 'graduate', label: 'Graduate' },
                { value: 'post_graduate', label: 'Post graduate' },
                { value: 'doctorate', label: 'Doctorate' },
                { value: 'professional', label: 'Professional' },
                { value: 'certification', label: 'Certification' },
              ]} />
            </Field>
            <Field label="Subject"><Input value={discipline} onChange={setDiscipline} placeholder="Mathematics" /></Field>
            <Field label="Board or university"><Input value={board} onChange={setBoard} placeholder="Osmania University" /></Field>
            <Field label="Year of passing"><Input value={year} onChange={setYear} type="number" placeholder="2014" /></Field>
            <Field label="Percentage"><Input value={percentage} onChange={setPercentage} type="number" /></Field>
            <Field label="Valid until" hint="Some state TETs expire; leave blank when the qualification does not">
              <Input value={validUntil} onChange={setValidUntil} type="date" />
            </Field>
            <Field label="Verification reference"><Input value={ref} onChange={setRef} placeholder="OU/2014/44821" /></Field>
          </FormGrid>
          <div className="flex flex-wrap gap-5">
            <Checkbox checked={teaching} onChange={setTeaching}
              label="Counts as a teaching qualification"
              hint="B.Ed, D.El.Ed, TET and CTET. Flagged rather than guessed from the name." />
            <Checkbox checked={verified} onChange={setVerified}
              label="Original seen and verified today" />
          </div>
          <FormNotice error={save.error} ok={save.isSuccess ? 'Recorded.' : undefined} />
          <Button onClick={() => save.mutate()} disabled={!employeeId || !qualification || save.isPending}>
            Record it
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="The register" />
        <Table head={['Employee', 'Qualification', 'Subject', 'Board', 'Year', '%', 'Teaching', 'Verified']}
          empty={rows.length === 0} emptyLabel="Nothing recorded yet.">
          {rows.map((q) => (
            <tr key={q.id}>
              <Td className="font-medium">{q.full_name}
                <div className="text-[12px] font-normal text-muted-foreground">{q.employee_code}</div>
              </Td>
              <Td>
                {q.qualification}
                {q.lapsed && <div className="text-[12px] text-destructive">lapsed {q.valid_until}</div>}
              </Td>
              <Td className="text-muted-foreground">{q.discipline ?? '—'}</Td>
              <Td className="text-muted-foreground">{q.board_university ?? '—'}</Td>
              <Td className="tabular-nums text-muted-foreground">{q.year_of_passing ?? '—'}</Td>
              <Td className="tabular-nums text-muted-foreground">{q.percentage ?? '—'}</Td>
              <Td>{q.is_teaching_qualification ? <Badge tone="info">yes</Badge> : '—'}</Td>
              <Td>{q.verified_on ? <Badge tone="success">{q.verified_on}</Badge> : <Badge tone="warning">not seen</Badge>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}

function MedicalTab({ rows }: { rows: Medical[] }) {
  const qc = useQueryClient()
  const employees = useEmployees()
  const [employeeId, setEmployeeId] = useState('')
  const [purpose, setPurpose] = useState('general')
  const [issuedOn, setIssuedOn] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [fit, setFit] = useState(true)
  const [examinedBy, setExaminedBy] = useState('')
  const [clinic, setClinic] = useState('')
  const [restrictions, setRestrictions] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr/medical-fitness', {
        employee_id: employeeId, purpose, issued_on: issuedOn, valid_until: validUntil,
        fit,
        examined_by: examinedBy || undefined,
        clinic: clinic || undefined,
        restrictions: restrictions || undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'medical'] }),
  })

  return (
    <>
      <Card>
        <CardHeader title="Record a fitness certificate"
          description="The expiry is required. A registry row with no expiry reads as compliant for ever and nobody is ever told to book the next examination." />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Employee" required>
              <Select value={employeeId} onChange={setEmployeeId} placeholder="Choose an employee"
                options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: nameOf(e) }))} />
            </Field>
            <Field label="Examined for">
              <Select value={purpose} onChange={setPurpose} options={[
                { value: 'general', label: 'General fitness' },
                { value: 'food_handler', label: 'Food handler' },
                { value: 'driver', label: 'Driver' },
                { value: 'nanny', label: 'Nanny / ayah' },
                { value: 'hostel', label: 'Hostel staff' },
                { value: 'lab', label: 'Laboratory' },
                { value: 'sports', label: 'Sports' },
              ]} />
            </Field>
            <Field label="Issued on" required><Input value={issuedOn} onChange={setIssuedOn} type="date" /></Field>
            <Field label="Valid until" required><Input value={validUntil} onChange={setValidUntil} type="date" /></Field>
            <Field label="Examined by"><Input value={examinedBy} onChange={setExaminedBy} placeholder="Dr S Rao" /></Field>
            <Field label="Clinic"><Input value={clinic} onChange={setClinic} /></Field>
            <Field label="Restrictions" wide
              hint="Required when the person is not fit: an unfit certificate with nothing written on it cannot be acted on">
              <Textarea value={restrictions} onChange={setRestrictions} rows={2} />
            </Field>
          </FormGrid>
          <Checkbox checked={fit} onChange={setFit} label="Fit for the duties examined" />
          <FormNotice error={save.error} ok={save.isSuccess ? 'Recorded.' : undefined} />
          <Button onClick={() => save.mutate()}
            disabled={!employeeId || !issuedOn || !validUntil || save.isPending}>
            Record it
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="The registry"
          description="Expired certificates are shown rather than filtered out. A registry that lists only the valid ones answers who is covered and hides who is not." />
        <Table head={['Employee', 'For', 'Issued', 'Valid until', 'Days left', 'Fit', 'Restrictions']}
          empty={rows.length === 0} emptyLabel="Nothing recorded yet.">
          {rows.map((m) => (
            <tr key={m.id}>
              <Td className="font-medium">{m.full_name}
                <div className="text-[12px] font-normal text-muted-foreground">{m.employee_code}</div>
              </Td>
              <Td className="text-muted-foreground">{m.purpose.replace(/_/g, ' ')}</Td>
              <Td className="text-muted-foreground">{m.issued_on}</Td>
              <Td className="text-muted-foreground">{m.valid_until}</Td>
              <Td className={m.expired ? 'tabular-nums text-destructive' : 'tabular-nums'}>
                {m.expired ? 'expired' : m.days_left}
              </Td>
              <Td>{m.fit ? <Badge tone="success">fit</Badge> : <Badge tone="danger">not fit</Badge>}</Td>
              <Td className="text-muted-foreground">{m.restrictions ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}

function BackgroundTab({ rows }: { rows: Background[] }) {
  const qc = useQueryClient()
  const employees = useEmployees()
  const [employeeId, setEmployeeId] = useState('')
  const [kind, setKind] = useState('police')
  const [agency, setAgency] = useState('')
  const [reference, setReference] = useState('')

  const raise = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr/background-checks', {
        employee_id: employeeId, kind,
        agency: agency || undefined,
        reference_no: reference || undefined,
      }),
    onSuccess: () => {
      setReference('')
      qc.invalidateQueries({ queryKey: ['hr', 'background'] })
    },
  })
  const close = useMutation({
    mutationFn: (v: { id: string; status: string; completed_on: string; valid_until?: string; findings?: string }) =>
      api.post('/api/v1/hr/background-checks', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'background'] }),
  })

  return (
    <>
      <Card>
        <CardHeader title="Raise a verification"
          description="Only one check of a kind may be in flight per person; two open police verifications means two agencies were paid for the same answer." />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Employee" required>
              <Select value={employeeId} onChange={setEmployeeId} placeholder="Choose an employee"
                options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: nameOf(e) }))} />
            </Field>
            <Field label="Check">
              <Select value={kind} onChange={setKind} options={[
                { value: 'police', label: 'Police verification' },
                { value: 'court', label: 'Court records' },
                { value: 'address', label: 'Address' },
                { value: 'education', label: 'Education' },
                { value: 'previous_employer', label: 'Previous employer' },
                { value: 'reference', label: 'Reference' },
              ]} />
            </Field>
            <Field label="Agency"><Input value={agency} onChange={setAgency} placeholder="Cyberabad Police" /></Field>
            <Field label="Reference"><Input value={reference} onChange={setReference} placeholder="CYB/PV/2026/771" /></Field>
          </FormGrid>
          <FormNotice error={raise.error} />
          <Button onClick={() => raise.mutate()} disabled={!employeeId || raise.isPending}>Raise it</Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Verifications"
          description="A clear result must carry the date it has to be repeated by. Police verification with no re-check date still reads as compliant nine years after the constable who signed it retired." />
        <Table head={['Employee', 'Check', 'Agency', 'Requested', 'Status', 'Re-check by', '']}
          empty={rows.length === 0} emptyLabel="Nothing raised yet.">
          {rows.map((b) => (
            <BackgroundLine key={b.id} row={b} onClose={(v) => close.mutate({ id: b.id, ...v })} />
          ))}
        </Table>
        <div className="border-t p-5"><FormNotice error={close.error} /></div>
      </Card>
    </>
  )
}

function BackgroundLine({
  row,
  onClose,
}: {
  row: Background
  onClose: (v: { status: string; completed_on: string; valid_until?: string; findings?: string }) => void
}) {
  const [validUntil, setValidUntil] = useState(row.valid_until ?? '')
  const [findings, setFindings] = useState(row.findings ?? '')
  const done = row.status === 'clear' || row.status === 'adverse'
  const today = new Date().toISOString().slice(0, 10)

  return (
    <tr>
      <Td className="font-medium">{row.full_name}
        <div className="text-[12px] font-normal text-muted-foreground">{row.employee_code}</div>
      </Td>
      <Td className="text-muted-foreground">{row.kind.replace(/_/g, ' ')}</Td>
      <Td className="text-muted-foreground">{row.agency ?? '—'}</Td>
      <Td className="text-muted-foreground">{row.requested_on}</Td>
      <Td>
        <Badge tone={row.expired ? 'danger' : row.status === 'clear' ? 'success'
          : row.status === 'adverse' ? 'danger' : 'warning'}>
          {row.expired ? 'lapsed' : row.status.replace(/_/g, ' ')}
        </Badge>
      </Td>
      <Td className="w-40">
        {done ? (
          <span className="text-muted-foreground">{row.valid_until ?? '—'}</span>
        ) : (
          <Input value={validUntil} onChange={setValidUntil} type="date" />
        )}
      </Td>
      <Td>
        {!done && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Input value={findings} onChange={setFindings} placeholder="Findings, if adverse" />
            <Button size="sm" disabled={!validUntil}
              onClick={() => onClose({ status: 'clear', completed_on: today, valid_until: validUntil })}>
              Clear
            </Button>
            <Button size="sm" variant="secondary" tone="danger" disabled={!findings}
              onClick={() => onClose({ status: 'adverse', completed_on: today, findings })}>
              Adverse
            </Button>
          </div>
        )}
      </Td>
    </tr>
  )
}
