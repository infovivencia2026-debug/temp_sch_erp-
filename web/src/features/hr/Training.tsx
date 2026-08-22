import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Award, BookOpen, FileCheck2, TriangleAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Field, FormGrid, FormNotice,
  Input, Select, Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'

/* Staff training and workshop logs.

   The list of workshops is the easy half. The half that matters is the second
   tab: hours completed against hours required, per teacher, per year. CBSE
   asks a school to evidence fifty hours of annual in-service training for its
   teaching staff, and "here are the workshops we ran" does not answer that —
   the answer is a number per teacher and the names of the ones who are short.

   Certificates are files on the shelf employee_documents already uses; nothing
   here re-implements storage. */

interface Programme {
  id: string
  code: string
  title: string
  category?: string
  provider?: string
  provider_kind: string
  mode: string
  venue?: string
  starts_on: string
  ends_on: string
  hours: number
  is_mandatory: boolean
  counts_towards_requirement: boolean
  nominated: number
  completed: number
  hours_logged?: number
}

interface Compliance {
  employee_id: string
  employee_code: string
  full_name: string
  designation?: string
  department?: string
  programmes_completed: number
  hours_completed: number
  hours_required?: number
  shortfall?: number
  compliant?: boolean
  certificates_on_file: number
}

interface Requirement {
  id: string
  academic_year?: string
  designation?: string
  designation_category?: string
  required_hours: number
  authority?: string
}

interface Employee { id: string; full_name?: string; name?: string; employee_code?: string }

const TABS = [
  ['compliance', 'Training compliance', FileCheck2],
  ['programmes', 'Log a workshop', BookOpen],
] as const

export default function Training() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('compliance')

  const compliance = useQuery({
    queryKey: ['hr-growth', 'compliance'],
    queryFn: () => api.get<List<Compliance>>('/api/v1/hr-growth/training/compliance'),
  })
  const programmes = useQuery({
    queryKey: ['hr-growth', 'programmes'],
    queryFn: () => api.get<List<Programme>>('/api/v1/hr-growth/training/programmes'),
  })

  if (compliance.isLoading) return <Loading label="Counting training hours…" />
  if (compliance.error) return <ErrorState error={compliance.error} />

  const rows = compliance.data?.items ?? []
  const tracked = rows.filter((r) => r.hours_required != null)
  const short = tracked.filter((r) => r.compliant === false)
  const totalHours = rows.reduce((n, r) => n + r.hours_completed, 0)
  const certificates = rows.reduce((n, r) => n + r.certificates_on_file, 0)

  return (
    <>
      <PageHead
        eyebrow="Hiring & growth"
        title="Staff training & workshop logs"
        description="What each member of staff attended, run by whom, for how many hours, and the certificate. The report an affiliation inspection asks for is the first tab."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Staff short of their hours" value={short.length} icon={TriangleAlert}
            delta={short.length
              ? { value: 'Evidence an inspection would ask for', positive: false }
              : { value: 'Everyone tracked has met the requirement', positive: true }} />
          <Stat label="Hours logged" value={totalHours.toFixed(0)} icon={BookOpen}
            period="This academic year" />
          <Stat
            label="Programmes run"
            value={programmes.error ? '—' : programmes.data?.items.length ?? 0}
            hint={programmes.error ? 'The programme list could not be read' : undefined}
          />
          <Stat label="Certificates on file" value={certificates} icon={Award} />
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

        {tab === 'compliance' && <ComplianceTab rows={rows} />}
        {tab === 'programmes' && <ProgrammesTab programmes={programmes.data?.items ?? []} />}
      </PageBody>
    </>
  )
}

function ComplianceTab({ rows }: { rows: Compliance[] }) {
  const requirements = useQuery({
    queryKey: ['hr-growth', 'requirements'],
    queryFn: () => api.get<List<Requirement>>('/api/v1/hr-growth/training/requirements'),
  })

  return (
    <>
      <Card>
        <CardHeader
          title="What is expected"
          description="The training hours your board requires each year — CBSE asks fifty of teaching staff. Set the figure your board uses; a school that holds itself to more can say so."
        />
        {/* "No requirement set" is a statement about what the school holds
            itself to; a failed request is not entitled to make it. */}
        {requirements.error && <ErrorState error={requirements.error} />}
        <Table head={['Applies to', 'Year', { label: 'Hours', align: 'right' }, 'Authority']}
          empty={(requirements.data?.items ?? []).length === 0 && !requirements.error}
          emptyLabel="No requirement set.">
          {(requirements.data?.items ?? []).map((q) => (
            <tr key={q.id}>
              <Td>
                {q.designation ?? (q.designation_category
                  ? `All ${q.designation_category.replace(/_/g, ' ')} staff`
                  : 'Everybody')}
              </Td>
              <Td>{q.academic_year ?? 'Every year'}</Td>
              <Td className="text-right">{q.required_hours}</Td>
              <Td>{q.authority ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <CardHeader
          title="Hours completed against requirement"
          description="Who is falling behind on required hours, furthest short first — a report sorted by name is one nobody acts on. Staff with no requirement set are listed rather than dropped: that is a gap in the policy, not an absent person."
        />
        <Table
          head={['Staff', 'Role', { label: 'Done', align: 'right' },
            { label: 'Required', align: 'right' }, { label: 'Short by', align: 'right' },
            'Certificates', 'Status']}
          empty={rows.length === 0}
          emptyLabel="No active staff to report on."
        >
          {rows.map((r) => (
            <tr key={r.employee_id}>
              <Td>
                <span className="font-medium">{r.full_name}</span>
                <span className="block text-[12.5px] text-muted-foreground">{r.employee_code}</span>
              </Td>
              <Td>
                {r.designation ?? '—'}
                {r.department && (
                  <span className="block text-[12.5px] text-muted-foreground">{r.department}</span>
                )}
              </Td>
              <Td className="text-right">{r.hours_completed.toFixed(1)}</Td>
              <Td className="text-right">{r.hours_required?.toFixed(0) ?? '—'}</Td>
              <Td className="text-right">
                {r.shortfall != null && r.shortfall > 0
                  ? <span className="font-medium text-destructive">{r.shortfall.toFixed(1)}</span>
                  : '—'}
              </Td>
              <Td>{r.certificates_on_file}</Td>
              <Td>
                {r.compliant == null
                  ? <Badge tone="neutral">No requirement set</Badge>
                  : r.compliant
                    ? <Badge tone="success">Met</Badge>
                    : <Badge tone="danger">Short</Badge>}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}

/* Both writes here — saving a programme and logging who attended — are
   employees.write (hr_growth.go:117,119). The compliance figures and the
   requirement table are reads on the group's employees.read. */
function ProgrammesTab({ programmes }: { programmes: Programme[] }) {
  const mayWrite = useCan()('hr.employees.write')
  const qc = useQueryClient()
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [provider, setProvider] = useState('')
  const [providerKind, setProviderKind] = useState('external')
  const [mode, setMode] = useState('in_person')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [hours, setHours] = useState('')
  const [logging, setLogging] = useState<Programme | null>(null)

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr-growth/training/programmes', {
        code, title,
        provider: provider || undefined,
        provider_kind: providerKind,
        mode,
        starts_on: startsOn,
        ends_on: endsOn || undefined,
        hours: Number(hours),
      }),
    onSuccess: () => {
      setCode(''); setTitle(''); setProvider(''); setStartsOn(''); setEndsOn(''); setHours('')
      qc.invalidateQueries({ queryKey: ['hr-growth'] })
    },
  })

  return (
    <>
      <Card>
        <CardHeader
          title="Log a workshop"
          description="Name the body that ran it. 'CBSE COE Hyderabad' is what an inspection asks for; 'external' is not."
        />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Reference" required><Input value={code} onChange={setCode} placeholder="CBSE/NEP/2026-1" /></Field>
            <Field label="Title" required><Input value={title} onChange={setTitle} placeholder="NEP pedagogy workshop" /></Field>
            <Field label="Run by"><Input value={provider} onChange={setProvider} placeholder="CBSE COE Hyderabad" /></Field>
            <Field label="Kind of provider">
              <Select value={providerKind} onChange={setProviderKind} options={[
                { value: 'board', label: 'Board (CBSE, state)' },
                { value: 'government', label: 'Government' },
                { value: 'university', label: 'University' },
                { value: 'external', label: 'External agency' },
                { value: 'internal', label: 'In-house' },
                { value: 'ngo', label: 'NGO' },
                { value: 'vendor', label: 'Vendor' },
              ]} />
            </Field>
            <Field label="Mode">
              <Select value={mode} onChange={setMode} options={[
                { value: 'in_person', label: 'In person' },
                { value: 'online', label: 'Online' },
                { value: 'hybrid', label: 'Hybrid' },
              ]} />
            </Field>
            <Field label="Starts on" required><Input value={startsOn} onChange={setStartsOn} type="date" /></Field>
            <Field label="Ends on"><Input value={endsOn} onChange={setEndsOn} type="date" /></Field>
            <Field label="Contact hours" required hint="What one attendee earns by completing it">
              <Input value={hours} onChange={setHours} type="number" placeholder="12" />
            </Field>
          </FormGrid>
          <FormNotice error={create.error} ok={create.isSuccess ? 'Workshop logged.' : undefined} />
          <Button onClick={() => create.mutate()}
            disabled={!mayWrite || !code || !title || !startsOn || !hours || create.isPending}>
            {create.isPending ? 'Saving…' : 'Log the workshop'}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Workshops and training" />
        <Table
          head={['Reference', 'Title', 'Run by', 'When', { label: 'Hours', align: 'right' },
            'Attended', 'Counts', '']}
          empty={programmes.length === 0}
          emptyLabel="Nothing logged yet."
        >
          {programmes.map((p) => (
            <tr key={p.id}>
              <Td><span className="font-medium">{p.code}</span></Td>
              <Td>
                {p.title}
                {p.is_mandatory && (
                  <span className="block text-[12.5px] text-warning">Mandatory</span>
                )}
              </Td>
              <Td>
                {p.provider ?? '—'}
                <span className="block text-[12.5px] text-muted-foreground">
                  {p.provider_kind.replace(/_/g, ' ')} · {p.mode.replace(/_/g, ' ')}
                </span>
              </Td>
              <Td>{formatDate(p.starts_on)}</Td>
              <Td className="text-right">{p.hours}</Td>
              <Td>
                {p.completed}/{p.nominated}
                {p.hours_logged != null && (
                  <span className="block text-[12.5px] text-muted-foreground">
                    {p.hours_logged.toFixed(0)} hrs logged
                  </span>
                )}
              </Td>
              <Td>
                {p.counts_towards_requirement
                  ? <Badge tone="success">Yes</Badge>
                  : <Badge tone="neutral">No</Badge>}
              </Td>
              <Td className="text-right">
                {mayWrite && (
                  <Button size="sm" variant="ghost" onClick={() => setLogging(p)}>
                    Record attendance
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {logging && (
        /* Keyed by the programme: the card holds who attended, their hours and
           their certificate number, and those belong to the programme they were
           entered against. */
        <AttendanceCard
          key={logging.id}
          programme={logging}
          onDone={() => {
            setLogging(null)
            qc.invalidateQueries({ queryKey: ['hr-growth'] })
          }}
        />
      )}
    </>
  )
}

/* Recording who actually turned up.

   Hours are left blank by default and fall back to the programme's, which is
   the usual case. The field exists because a teacher who left after the first
   morning completed three hours, not thirty, and a compliance report built on
   the optimistic number is worse than none. */
function AttendanceCard({ programme, onDone }: { programme: Programme; onDone: () => void }) {
  const mayWrite = useCan()('hr.employees.write')
  const [employee, setEmployee] = useState('')
  const [status, setStatus] = useState('completed')
  const [hours, setHours] = useState('')
  const [certNo, setCertNo] = useState('')
  const [certOn, setCertOn] = useState('')

  const employees = useQuery({
    queryKey: ['employees', 'training'],
    queryFn: () => api.get<List<Employee>>('/api/v1/hr/employees?limit=300'),
  })

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr-growth/training/records', {
        programme_id: programme.id,
        employee_ids: [employee],
        status,
        hours_completed: hours ? Number(hours) : undefined,
        certificate_no: certNo || undefined,
        certificate_issued_on: certOn || undefined,
      }),
    onSuccess: onDone,
  })

  const nameOf = (e: Employee) => e.full_name ?? e.name ?? e.id

  return (
    <Card>
      <CardHeader
        title={`Attendance — ${programme.title}`}
        description={`${programme.hours} contact hours. Leave hours blank to credit the full programme; enter a figure only if they did not complete it.`}
        action={<Button variant="ghost" size="sm" onClick={onDone}>Close</Button>}
      />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Member of staff" required>
            <Select value={employee} onChange={setEmployee} placeholder="Choose"
              options={(employees.data?.items ?? []).map((e) => ({
                value: e.id, label: `${nameOf(e)}${e.employee_code ? ` — ${e.employee_code}` : ''}`,
              }))} />
          </Field>
          <Field label="Outcome">
            <Select value={status} onChange={setStatus} options={[
              { value: 'completed', label: 'Completed' },
              { value: 'attended', label: 'Attended, not certified' },
              { value: 'absent', label: 'Did not attend' },
              { value: 'withdrawn', label: 'Withdrawn' },
              { value: 'nominated', label: 'Nominated only' },
            ]} />
          </Field>
          <Field label="Hours completed" hint={`Blank credits all ${programme.hours}`}>
            <Input value={hours} onChange={setHours} type="number" />
          </Field>
          <Field label="Certificate number"><Input value={certNo} onChange={setCertNo} placeholder="CBSE/2026/00912" /></Field>
          <Field label="Certificate issued on"><Input value={certOn} onChange={setCertOn} type="date" /></Field>
        </FormGrid>
        <FormNotice error={save.error} />
        <Button onClick={() => save.mutate()}
          disabled={!mayWrite || !employee || save.isPending}>
          {save.isPending ? 'Saving…' : 'Record'}
        </Button>
      </div>
    </Card>
  )
}
