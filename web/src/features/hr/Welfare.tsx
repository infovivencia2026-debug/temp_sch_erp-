import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Award, Cake, MessageSquareWarning } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Checkbox, Field, FormGrid, FormNotice,
  Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'

/* The three things a school does for its staff that cost nothing.

   A diary of birthdays and anniversaries, a channel for complaints that
   actually protects the person making them, and a wall for the awards a
   staff room reads on the way in.

   The grievance form's anonymous option is real: when it is ticked, neither
   the employee nor the account raising it is stored, and the database refuses
   the row otherwise. A cell that promises anonymity and keeps the name is
   worse than none, because the staff find out the first time somebody is
   asked about a complaint they thought was untraceable. */

interface Employee { id: string; full_name?: string; name?: string }

interface Celebration {
  employee_id: string
  full_name: string
  designation?: string
  kind: string
  on_date: string
  years: number
  days_away: number
  greeted: boolean
}

interface Grievance {
  id: string
  reference_no: string
  is_anonymous: boolean
  full_name?: string
  category: string
  severity: string
  subject: string
  description: string
  status: string
  assigned_to?: string
  resolution?: string
  raised_at: string
  resolved_at?: string
  open_days: number
}

interface Recognition {
  id: string
  employee_id: string
  full_name: string
  designation?: string
  campus?: string
  award_code: string
  title: string
  citation?: string
  period?: string
  awarded_on: string
  nominated_by?: string
  published: boolean
}

const TABS = [
  ['diary', 'Birthdays & anniversaries', Cake],
  ['grievances', 'Grievance cell', MessageSquareWarning],
  ['wall', 'Recognition wall', Award],
] as const

const nameOf = (e: Employee) => e.full_name ?? e.name ?? e.id

function useEmployees() {
  return useQuery({
    queryKey: ['employees', 'welfare'],
    queryFn: () => api.get<List<Employee>>('/api/v1/hr/employees?limit=300'),
  })
}

export default function Welfare() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('diary')

  const diary = useQuery({
    queryKey: ['hr', 'celebrations'],
    queryFn: () => api.get<List<Celebration>>('/api/v1/hr/celebrations?days=30'),
  })
  const grievances = useQuery({
    queryKey: ['hr', 'grievances'],
    queryFn: () => api.get<List<Grievance>>('/api/v1/hr/grievances'),
  })

  if (diary.isLoading) return <Loading label="Reading the diary…" />
  if (diary.error) return <ErrorState error={diary.error} />

  const days = diary.data?.items ?? []
  const today = days.filter((d) => d.days_away === 0)
  const open = (grievances.data?.items ?? []).filter(
    (g) => !['resolved', 'closed', 'withdrawn'].includes(g.status),
  )
  const oldest = open.reduce((m, g) => Math.max(m, g.open_days), 0)

  return (
    <>
      <PageHead
        eyebrow="People"
        title="Staff welfare"
        description="Whose day it is, what the staff room is unhappy about, and who the school has thanked."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Today" value={today.length} icon={Cake}
            hint={today.length ? today.map((t) => t.full_name).join(', ') : 'Nobody today'} />
          <Stat label="In the next 30 days" value={days.length} />
          <Stat label="Grievances open" value={open.length} icon={MessageSquareWarning}
            delta={oldest > 14
              ? { value: `Oldest ${oldest} days`, positive: false }
              : open.length ? { value: `Oldest ${oldest} days`, positive: true } : undefined} />
          <Stat label="High severity" value={open.filter((g) => g.severity === 'high').length} />
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

        {tab === 'diary' && <DiaryTab rows={days} />}
        {tab === 'grievances' && <GrievanceTab rows={grievances.data?.items ?? []} />}
        {tab === 'wall' && <WallTab />}
      </PageBody>
    </>
  )
}

function DiaryTab({ rows }: { rows: Celebration[] }) {
  const qc = useQueryClient()
  const greet = useMutation({
    mutationFn: (c: Celebration) =>
      api.post<{ greeted: boolean; already_sent: boolean }>('/api/v1/hr/celebrations/greet', {
        employee_id: c.employee_id, kind: c.kind, on_date: c.on_date, years: c.years,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'celebrations'] }),
  })

  return (
    <Card>
      <CardHeader title="The next thirty days"
        description="Worked out from each employee's date of birth and date of joining, so a corrected date corrects the diary. Ages are not published; years of service are." />
      {rows.length === 0 ? (
        <EmptyState title="Nothing coming up"
          body="Nobody has a birthday or an anniversary in the next month." />
      ) : (
        <Table head={['Who', 'Occasion', 'Date', 'In', 'Greeted', '']}>
          {rows.map((c) => (
            <tr key={`${c.employee_id}-${c.kind}-${c.on_date}`}>
              <Td className="font-medium">{c.full_name}
                <div className="text-[12px] font-normal text-muted-foreground">{c.designation ?? '—'}</div>
              </Td>
              <Td>
                {c.kind === 'birthday' ? 'Birthday' : `${c.years} years at the school`}
              </Td>
              <Td className="text-muted-foreground">{c.on_date}</Td>
              <Td className="tabular-nums text-muted-foreground">
                {c.days_away === 0 ? 'today' : `${c.days_away} days`}
              </Td>
              <Td>{c.greeted ? <Badge tone="success">sent</Badge> : <Badge tone="neutral">not yet</Badge>}</Td>
              <Td>
                <Button size="sm" variant="secondary" disabled={c.greeted || greet.isPending}
                  onClick={() => greet.mutate(c)}>
                  Wish them
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <div className="border-t p-5"><FormNotice error={greet.error} /></div>
    </Card>
  )
}

function GrievanceTab({ rows }: { rows: Grievance[] }) {
  const qc = useQueryClient()
  const employees = useEmployees()
  const [anonymous, setAnonymous] = useState(true)
  const [employeeId, setEmployeeId] = useState('')
  const [category, setCategory] = useState('workload')
  const [severity, setSeverity] = useState('medium')
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')

  const raise = useMutation({
    mutationFn: () =>
      api.post<{ reference_no: string }>('/api/v1/hr/grievances', {
        is_anonymous: anonymous,
        employee_id: anonymous ? undefined : employeeId,
        category, severity, subject, description,
      }),
    onSuccess: () => {
      setSubject(''); setDescription('')
      qc.invalidateQueries({ queryKey: ['hr', 'grievances'] })
    },
  })

  return (
    <>
      <Card>
        <CardHeader title="Raise a complaint"
          description="Anonymous means anonymous: neither the employee nor the account raising it is stored, and the record cannot be traced back afterwards." />
        <div className="space-y-5 p-5">
          <Checkbox checked={anonymous} onChange={setAnonymous}
            label="Raise this anonymously"
            hint="Nothing identifying the reporter is written down" />
          <FormGrid>
            {!anonymous && (
              <Field label="Employee" required>
                <Select value={employeeId} onChange={setEmployeeId} placeholder="Choose an employee"
                  options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: nameOf(e) }))} />
              </Field>
            )}
            <Field label="About">
              <Select value={category} onChange={setCategory} options={[
                { value: 'harassment', label: 'Harassment' },
                { value: 'pay', label: 'Pay' },
                { value: 'workload', label: 'Workload' },
                { value: 'facilities', label: 'Facilities' },
                { value: 'discrimination', label: 'Discrimination' },
                { value: 'safety', label: 'Safety' },
                { value: 'management', label: 'Management' },
                { value: 'other', label: 'Other' },
              ]} />
            </Field>
            <Field label="Severity">
              <Select value={severity} onChange={setSeverity} options={[
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
              ]} />
            </Field>
            <Field label="Subject" required wide>
              <Input value={subject} onChange={setSubject} placeholder="Substitution load" />
            </Field>
            <Field label="What happened" required wide>
              <Textarea value={description} onChange={setDescription} rows={4} />
            </Field>
          </FormGrid>
          <FormNotice error={raise.error}
            ok={raise.data ? `Recorded as ${raise.data.reference_no}. Quote that to follow it up.` : undefined} />
          <Button onClick={() => raise.mutate()}
            disabled={!subject || !description || (!anonymous && !employeeId) || raise.isPending}>
            Raise it
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="The cell"
          description="Open complaints first, worst first, oldest first. A grievance cell is judged on how long things sit here." />
        <Table head={['Reference', 'From', 'About', 'Subject', 'Severity', 'Open', 'Status', '']}
          empty={rows.length === 0} emptyLabel="Nothing has been raised.">
          {rows.map((g) => <GrievanceLine key={g.id} row={g} />)}
        </Table>
      </Card>
    </>
  )
}

function GrievanceLine({ row }: { row: Grievance }) {
  const qc = useQueryClient()
  const [resolution, setResolution] = useState(row.resolution ?? '')
  const decide = useMutation({
    mutationFn: (status: string) =>
      api.post(`/api/v1/hr/grievances/${row.id}/decide`, {
        status, resolution: resolution || undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'grievances'] }),
  })
  const settled = ['resolved', 'closed', 'withdrawn'].includes(row.status)

  return (
    <tr>
      <Td className="font-medium tabular-nums">{row.reference_no}</Td>
      <Td className="text-muted-foreground">
        {row.is_anonymous ? <Badge tone="info">anonymous</Badge> : (row.full_name ?? '—')}
      </Td>
      <Td className="text-muted-foreground">{row.category}</Td>
      <Td>
        {row.subject}
        <div className="text-[12px] text-muted-foreground">{row.description.slice(0, 90)}</div>
      </Td>
      <Td>
        <Badge tone={row.severity === 'high' ? 'danger' : row.severity === 'medium' ? 'warning' : 'neutral'}>
          {row.severity}
        </Badge>
      </Td>
      <Td className="tabular-nums text-muted-foreground">{row.open_days}d</Td>
      <Td><Badge tone={settled ? 'success' : 'warning'}>{row.status}</Badge></Td>
      <Td>
        {settled ? (
          <span className="text-[12px] text-muted-foreground">{row.resolution}</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <Input value={resolution} onChange={setResolution} placeholder="What was done" />
            <Button size="sm" variant="secondary" onClick={() => decide.mutate('investigating')}>
              Investigating
            </Button>
            <Button size="sm" disabled={!resolution} onClick={() => decide.mutate('resolved')}>
              Resolve
            </Button>
          </div>
        )}
      </Td>
    </tr>
  )
}

function WallTab() {
  const qc = useQueryClient()
  const employees = useEmployees()
  const [employeeId, setEmployeeId] = useState('')
  const [award, setAward] = useState('teacher_of_the_month')
  const [title, setTitle] = useState('Teacher of the Month')
  const [citation, setCitation] = useState('')

  const wall = useQuery({
    queryKey: ['hr', 'recognitions'],
    queryFn: () => api.get<List<Recognition>>('/api/v1/hr/recognitions'),
  })
  const give = useMutation({
    mutationFn: () =>
      api.post('/api/v1/hr/recognitions', {
        employee_id: employeeId, award_code: award, title,
        citation: citation || undefined,
      }),
    onSuccess: () => {
      setCitation('')
      qc.invalidateQueries({ queryKey: ['hr', 'recognitions'] })
    },
  })

  const rows = wall.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader title="Name somebody"
          description="There is one teacher of the month, and the database says so — naming a second for the same month is refused rather than quietly shown beside the first." />
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Employee" required>
              <Select value={employeeId} onChange={setEmployeeId} placeholder="Choose an employee"
                options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: nameOf(e) }))} />
            </Field>
            <Field label="Award">
              <Select value={award} onChange={(v) => {
                setAward(v)
                if (v === 'teacher_of_the_month') setTitle('Teacher of the Month')
              }} options={[
                { value: 'teacher_of_the_month', label: 'Teacher of the Month' },
                { value: 'peer_praise', label: 'Peer praise' },
                { value: 'long_service', label: 'Long service' },
                { value: 'achievement', label: 'Achievement' },
                { value: 'student_choice', label: "Students' choice" },
                { value: 'principals_commendation', label: "Principal's commendation" },
              ]} />
            </Field>
            <Field label="Title" required wide><Input value={title} onChange={setTitle} /></Field>
            <Field label="Citation" wide
              hint="What they actually did. An award with no sentence under it is a name on a board.">
              <Textarea value={citation} onChange={setCitation} rows={2} />
            </Field>
          </FormGrid>
          <FormNotice error={give.error} ok={give.isSuccess ? 'On the wall.' : undefined} />
          <Button onClick={() => give.mutate()} disabled={!employeeId || !title || give.isPending}>
            Put it on the wall
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="The wall" />
        {rows.length === 0 ? (
          <EmptyState title="Nothing on the wall yet" body="Name somebody above." />
        ) : (
          <div className="divide-y">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-[15px] font-medium">{r.full_name}</p>
                  <p className="text-[13px] text-muted-foreground">
                    {r.title}{r.period ? ` · ${r.period}` : ''}{r.campus ? ` · ${r.campus}` : ''}
                  </p>
                  {r.citation && <p className="mt-1.5 text-[13px]">{r.citation}</p>}
                </div>
                <div className="shrink-0 text-right text-[12px] text-muted-foreground">
                  <div>{r.awarded_on}</div>
                  {r.nominated_by && <div>nominated by {r.nominated_by}</div>}
                  {!r.published && <Badge tone="neutral">unpublished</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
