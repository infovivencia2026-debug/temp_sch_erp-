import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileWarning, Gavel, MessagesSquare, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Field, FormGrid, FormNotice, Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* The conduct file, from the office's side.

   The same records a class teacher writes into — one table, not two. A second
   discipline table would have meant a suspension the class teacher's own
   screen cannot see, which is exactly the failure this log exists to prevent.

   What the office adds is what happens next: how serious it was judged, who is
   handling it, whether the family came in, and — where it comes to that — the
   dates a child was out of school. An incident nobody closed is the row an
   inspection asks about, so open is the default and closing needs an action
   recorded. */

interface Incident {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  class_name?: string
  section?: string
  occurred_on: string
  category: string
  is_positive: boolean
  severity: 'minor' | 'major' | 'serious'
  status: 'open' | 'under_review' | 'action_taken' | 'closed'
  description: string
  action_taken?: string
  follow_up_on?: string
  suspension_from?: string
  suspension_to?: string
  suspension_days: number
  parent_meeting_on?: string
  parent_meeting_note?: string
  counselling_note?: string
  parent_notified: boolean
  closed_on?: string
  recorded_by?: string
  closed_by?: string
  age_days: number
  prior_incidents: number
}

const SEVERITY: Record<string, 'neutral' | 'warning' | 'danger'> = {
  minor: 'neutral',
  major: 'warning',
  serious: 'danger',
}
const STATUS: Record<string, 'neutral' | 'warning' | 'info' | 'success'> = {
  open: 'warning',
  under_review: 'info',
  action_taken: 'info',
  closed: 'success',
}

export default function DisciplineLog() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('')
  const [severity, setSeverity] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const log = useQuery({
    queryKey: ['incidents', status, severity],
    queryFn: () => {
      const p = new URLSearchParams({ concerns_only: '1' })
      if (status) p.set('status', status)
      if (severity) p.set('severity', severity)
      return api.get<{
        items: Incident[]
        from: string
        to: string
        summary: {
          incidents: number
          open: number
          serious: number
          suspensions: number
          parent_meetings: number
        }
      }>(`/api/v1/academics/admin/incidents?${p.toString()}`)
    },
  })

  if (log.isLoading) return <Loading label="Reading the conduct file…" />
  if (log.error) return <ErrorState error={log.error} />

  const rows = log.data?.items ?? []
  const s = log.data?.summary

  return (
    <>
      <PageHead
        eyebrow="Students"
        title="Disciplinary incident log"
        description="Conduct records escalated by the office: severity, counselling, the parent meeting, and any suspension."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Still open" value={s?.open ?? 0} icon={FileWarning} />
          <Stat label="Serious" value={s?.serious ?? 0} icon={ShieldAlert} />
          <Stat label="Suspensions" value={s?.suspensions ?? 0} icon={Gavel} />
          <Stat label="Parent meetings" value={s?.parent_meetings ?? 0} icon={MessagesSquare} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Incidents"
            description={`${formatDate(log.data?.from)} to ${formatDate(log.data?.to)}. Records are written by teachers; the office escalates and closes them here.`}
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={severity}
                  onChange={setSeverity}
                  options={[
                    { value: 'minor', label: 'Minor' },
                    { value: 'major', label: 'Major' },
                    { value: 'serious', label: 'Serious' },
                  ]}
                  placeholder="Any severity"
                />
                <Select
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: 'open', label: 'Open' },
                    { value: 'under_review', label: 'Under review' },
                    { value: 'action_taken', label: 'Action taken' },
                    { value: 'closed', label: 'Closed' },
                  ]}
                  placeholder="Any status"
                />
              </div>
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing recorded in this window"
              body="Teachers record conduct notes against a child; those that need the office appear here."
            />
          ) : (
            <Table
              head={['Date', 'Student', 'What happened', 'Severity', 'Status', 'Suspension', 'Age', '']}
            >
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap font-medium">
                    {formatDate(r.occurred_on)}
                  </Td>
                  <Td>
                    {r.student_name}
                    <span className="block text-[12px] text-muted-foreground">
                      {r.class_name ? `${r.class_name}-${r.section}` : r.admission_no}
                      {r.prior_incidents > 0 && ` · ${r.prior_incidents} before this`}
                    </span>
                  </Td>
                  <Td>
                    {r.description}
                    {r.action_taken && (
                      <span className="block text-[12px] text-muted-foreground">
                        Action: {r.action_taken}
                      </span>
                    )}
                    {r.parent_meeting_on && (
                      <span className="block text-[12px] text-muted-foreground">
                        Family seen {formatDate(r.parent_meeting_on)}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={SEVERITY[r.severity]}>{r.severity}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={STATUS[r.status]}>{r.status.replace('_', ' ')}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {r.suspension_days > 0
                      ? `${r.suspension_days}d from ${formatDate(r.suspension_from)}`
                      : '—'}
                  </Td>
                  <Td className="tabular-nums">
                    {r.status === 'closed' ? '—' : `${r.age_days}d`}
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                    >
                      {open === r.id ? 'Close' : 'Handle'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {open && (
          <Handle
            incident={rows.find((r) => r.id === open)!}
            onDone={() => {
              setOpen(null)
              qc.invalidateQueries({ queryKey: ['incidents'] })
            }}
          />
        )}
      </PageBody>
    </>
  )
}

function Handle({ incident, onDone }: { incident: Incident; onDone: () => void }) {
  const [severity, setSeverity] = useState(incident.severity)
  const [status, setStatus] = useState(incident.status)
  const [action, setAction] = useState(incident.action_taken ?? '')
  const [meetingOn, setMeetingOn] = useState(incident.parent_meeting_on ?? '')
  const [meetingNote, setMeetingNote] = useState(incident.parent_meeting_note ?? '')
  const [counselling, setCounselling] = useState(incident.counselling_note ?? '')
  const [suspFrom, setSuspFrom] = useState(incident.suspension_from ?? '')
  const [suspTo, setSuspTo] = useState(incident.suspension_to ?? '')
  const [followUp, setFollowUp] = useState(incident.follow_up_on ?? '')

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/academics/admin/incidents/${incident.id}`, {
        severity,
        status,
        action_taken: action,
        parent_meeting_on: meetingOn,
        parent_meeting_note: meetingNote,
        counselling_note: counselling,
        suspension_from: suspFrom,
        suspension_to: suspTo,
        follow_up_on: followUp,
        parent_notified: true,
      }),
    onSuccess: onDone,
  })

  return (
    <Card>
      <CardHeader
        title={`${incident.student_name} — ${formatDate(incident.occurred_on)}`}
        description="Closing an incident needs an action recorded: a closed row with nothing written against it answers nothing later."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Severity">
            <Select
              value={severity}
              onChange={(v) => setSeverity(v as Incident['severity'])}
              options={[
                { value: 'minor', label: 'Minor' },
                { value: 'major', label: 'Major' },
                { value: 'serious', label: 'Serious' },
              ]}
            />
          </Field>
          <Field label="Status">
            <Select
              value={status}
              onChange={(v) => setStatus(v as Incident['status'])}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'under_review', label: 'Under review' },
                { value: 'action_taken', label: 'Action taken' },
                { value: 'closed', label: 'Closed' },
              ]}
            />
          </Field>
          <Field label="Action taken" wide required={status === 'closed'}>
            <Textarea
              value={action}
              onChange={setAction}
              rows={2}
              placeholder="Warned in front of the class teacher; mother informed by telephone"
            />
          </Field>
          <Field label="Parent meeting on">
            <Input type="date" value={meetingOn} onChange={setMeetingOn} />
          </Field>
          <Field label="Follow up on">
            <Input type="date" value={followUp} onChange={setFollowUp} />
          </Field>
          <Field label="Meeting note" wide>
            <Textarea value={meetingNote} onChange={setMeetingNote} rows={2} />
          </Field>
          <Field
            label="Counselling note"
            wide
            hint="Kept apart from the narrative so a conduct extract does not print it."
          >
            <Textarea value={counselling} onChange={setCounselling} rows={2} />
          </Field>
          <Field label="Suspended from">
            <Input type="date" value={suspFrom} onChange={setSuspFrom} />
          </Field>
          <Field label="Suspended to">
            <Input type="date" value={suspTo} onChange={setSuspTo} />
          </Field>
        </FormGrid>
        <div className="mt-5 flex items-center gap-3">
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
          <FormNotice error={save.error} />
        </div>
      </div>
    </Card>
  )
}
