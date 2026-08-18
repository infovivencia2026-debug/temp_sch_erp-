import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Video, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Panel, Table, Td,
  Badge, Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState, UnavailableState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { formatDate } from '@/lib/utils'
import {
  useTeachingClasses, useTeachingSubjects,
  type MeetingProvider, type VirtualClass,
} from './teaching'

/* Scheduling and starting a live class.

   BLOCKED: no meeting provider is integrated. Everything here is real except
   the one step that needs Zoom or Google to answer — creating the meeting and
   returning a join link.

   The screen does not paper over that. A session with no link cannot be
   launched and says why; a teacher who made the meeting themselves can paste
   its link and the rest of the flow works. Showing a "Join" button that led
   nowhere would fail in front of a class. */

export default function VirtualClasses() {
  const [composing, setComposing] = useState(false)

  const list = useQuery({
    queryKey: ['virtual-classes'],
    queryFn: () => api.get<List<VirtualClass>>('/api/v1/teaching/virtual-classes'),
  })
  const providers = useQuery({
    queryKey: ['virtual-class-providers'],
    queryFn: () =>
      api.get<List<MeetingProvider>>('/api/v1/teaching/virtual-classes/providers'),
  })

  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const rows = list.data?.items ?? []
  const configured = providers.data?.items ?? []
  const integrated = configured.some((p) => p.integrated)

  return (
    <>
      <PageHead
        eyebrow="Teaching workspace"
        title="Live virtual class launcher"
        description="Schedule a live class for a section and start it when the period comes."
        actions={
          <Button onClick={() => setComposing((c) => !c)}>
            <Plus className="h-3.5 w-3.5" />
            {composing ? 'Close' : 'Schedule a class'}
          </Button>
        }
      />
      <PageBody>
        {!integrated && (
          <Panel>
            <UnavailableState
              title="No meeting provider is connected"
              body={
                configured.length > 0
                  ? `${configured.map((p) => p.display_name).join(', ')} is recorded for this school, but no meeting API is wired to it yet, so the school cannot create meetings automatically. Create the meeting in Zoom or Meet and paste its join link onto the session — everything else on this screen works.`
                  : 'The school has not connected Zoom, Google Meet or Teams, and no meeting API is wired in this build. Create the meeting yourself and paste its join link onto the session — scheduling, the register and the launch record all work.'
              }
              technical={[
                { label: 'Status', value: 'provider integration blocked' },
                { label: 'Launch without a link', value: '503 provider_unconfigured' },
                { label: 'Works today', value: 'join_url pasted by the teacher' },
              ]}
            />
          </Panel>
        )}

        <CellGrid cols={3}>
          <Stat label="Sessions" value={rows.length} icon={Video} />
          <Stat label="Ready to join" value={rows.filter((r) => r.joinable).length} />
          <Stat
            label="Waiting for a link"
            value={rows.filter((r) => r.status === 'provider_pending').length}
          />
        </CellGrid>

        {composing && <Schedule onDone={() => setComposing(false)} />}

        <Card>
          <CardHeader title="Scheduled classes" description="Most recent first" />
          {rows.length === 0 ? (
            <EmptyState
              title="No live classes scheduled"
              body="Schedule one for a section you teach; paste the meeting link and it becomes joinable."
            />
          ) : (
            <Table head={['Topic', 'Class', 'Subject', 'When', 'For', 'Status', '']}>
              {rows.map((v) => (
                <Row key={v.id} session={v} />
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function Row({ session }: { session: VirtualClass }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [link, setLink] = useState('')

  const attach = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/teaching/virtual-classes/${session.id}`, {
        join_url: link,
        status: 'scheduled',
      }),
    onSuccess: () => {
      toast.ok('Link saved')
      setLink('')
      qc.invalidateQueries({ queryKey: ['virtual-classes'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save the link'),
  })

  const launch = useMutation({
    mutationFn: () =>
      api.post<{ join_url?: string }>(
        `/api/v1/teaching/virtual-classes/${session.id}/launch`,
      ),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['virtual-classes'] })
      if (d.join_url) window.open(d.join_url, '_blank', 'noreferrer')
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : 'Could not start the class'),
  })

  const tone =
    session.status === 'live' ? 'success'
      : session.status === 'scheduled' ? 'info'
        : session.status === 'provider_pending' ? 'warning'
          : 'neutral'

  return (
    <tr>
      <Td>
        <span className="font-medium">{session.topic}</span>
        {session.provider_name && (
          <span className="block text-[12px] text-muted-foreground">
            {session.provider_name}
          </span>
        )}
      </Td>
      <Td>{session.class_name} {session.section}</Td>
      <Td>{session.subject ?? '—'}</Td>
      <Td>{formatDate(session.scheduled_at)}</Td>
      <Td>{session.duration_minutes} min</Td>
      <Td>
        <Badge tone={tone}>
          {session.status === 'provider_pending' ? 'needs a link' : session.status}
        </Badge>
      </Td>
      <Td>
        {session.joinable ? (
          <Button size="sm" onClick={() => launch.mutate()}>
            {session.status === 'live' ? 'Rejoin' : 'Start'}
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Input
              value={link}
              onChange={setLink}
              placeholder="Paste the meeting link"
              className="w-52"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => attach.mutate()}
              disabled={!link.trim()}
            >
              Save
            </Button>
          </div>
        )}
      </Td>
    </tr>
  )
}

function Schedule({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const classes = useTeachingClasses()
  const subjects = useTeachingSubjects()

  const [sectionID, setSectionID] = useState('')
  const [classSubjectID, setClassSubjectID] = useState('')
  const [topic, setTopic] = useState('')
  const [agenda, setAgenda] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [duration, setDuration] = useState('40')
  const [joinURL, setJoinURL] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/teaching/virtual-classes', {
        section_id: sectionID,
        class_subject_id: classSubjectID || undefined,
        topic,
        agenda: agenda || undefined,
        // datetime-local has no zone; the school runs on one, so send it as-is
        // and let the server's timestamptz apply it.
        scheduled_at: scheduledAt ? `${scheduledAt}:00+05:30` : '',
        duration_minutes: Number(duration) || 40,
        join_url: joinURL || undefined,
      }),
    onSuccess: () => {
      toast.ok('Class scheduled')
      qc.invalidateQueries({ queryKey: ['virtual-classes'] })
      onDone()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not schedule'),
  })

  return (
    <Card>
      <CardHeader
        title="Schedule a live class"
        description="Paste a meeting link now to make it joinable, or add one later."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Class" required>
            <Select
              value={sectionID}
              onChange={setSectionID}
              placeholder="Choose a class"
              options={(classes.data?.items ?? []).map((c) => ({
                value: c.section_id,
                label: `${c.class_name} ${c.section_name}`,
              }))}
            />
          </Field>
          <Field label="Subject" hint="Optional — a form period has none">
            <Select
              value={classSubjectID}
              onChange={setClassSubjectID}
              placeholder="No particular subject"
              options={(subjects.data?.items ?? []).map((s) => ({
                value: s.class_subject_id,
                label: `${s.class_name} · ${s.subject}`,
              }))}
            />
          </Field>
          <Field label="Topic" required>
            <Input value={topic} onChange={setTopic} placeholder="Revision — trigonometry" />
          </Field>
          <Field label="When" required>
            <Input
              value={scheduledAt}
              onChange={setScheduledAt}
              type="datetime-local"
            />
          </Field>
          <Field label="Minutes">
            <Input value={duration} onChange={setDuration} placeholder="40" />
          </Field>
          <Field
            label="Meeting link"
            hint="Optional. Without one the session waits, and cannot be started."
          >
            <Input value={joinURL} onChange={setJoinURL} placeholder="https://zoom.us/j/…" />
          </Field>
        </FormGrid>
        <Field label="Agenda">
          <Textarea value={agenda} onChange={setAgenda} rows={2} />
        </Field>
        <FormNotice error={save.error} />
        <div className="mt-3 flex gap-2">
          <Button
            onClick={() => save.mutate()}
            disabled={!sectionID || !topic.trim() || !scheduledAt}
          >
            Schedule
          </Button>
          <Button variant="secondary" onClick={onDone}>Cancel</Button>
        </div>
      </div>
    </Card>
  )
}
