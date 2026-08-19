import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, Users, PauseCircle, Clock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Checkbox, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import {
  ADMISSIONS_BASE as A, CHANNELS, errText, labelOf, numOrNull, useCampaigns, useLeads,
  type CampaignEnrolment, type CampaignRunResult, type CampaignStep, type OutboxRow,
} from './growth'

/* A nurture sequence for enquiries.

   Touch one on the day the enquiry arrives, touch two three days later, touch
   five a fortnight in — and it stops the moment the family converts or asks to
   be left alone. That last part is not a refinement. A parent who has already
   paid the first instalment and still receives "still thinking it over?" is the
   difference between a system a school trusts and one it switches off, so the
   stop is checked immediately before every send and again whenever a
   counsellor closes a lead.

   Nothing here sends a message. Each touch is queued through the messaging
   foundation, which owns the providers, the templates and the
   send-once index. Two honest notes appear on the screen rather than in a
   release note:

     - Nothing flushes the queue on a schedule on this deployment yet, so
       "Send what is due" is a button. It is idempotent and safe to press
       twice; when a scheduler exists it will call the same code.

     - A school that has not finished buying an SMS gateway sees its touches
       marked "not sent" with the reason, not an error. Failing the run would
       mean one unconfigured channel silently stopping every other sequence. */

const STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger' | 'info'> = {
  queued: 'success',
  pending: 'info',
  skipped: 'warning',
  failed: 'danger',
  active: 'success',
  stopped: 'warning',
  completed: 'neutral',
}

const SEND_LABEL: Record<string, string> = {
  queued: 'Queued to send',
  pending: 'Waiting its turn',
  skipped: 'Not sent',
  failed: 'Could not be prepared',
}

export default function CampaignSequences() {
  const toast = useToast()
  const qc = useQueryClient()
  const campaigns = useCampaigns()
  const leads = useLeads()

  const [campaignID, setCampaignID] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [step, setStep] = useState({
    step_no: '',
    name: '',
    offset_days: '',
    channel: 'sms',
    template_code: '',
    quiet_from: '',
    quiet_to: '',
    is_active: true,
  })
  const [enrolSource, setEnrolSource] = useState('')
  const [outboxStatus, setOutboxStatus] = useState('')

  const steps = useQuery({
    enabled: !!campaignID,
    queryKey: ['admissions-campaign-steps', campaignID],
    queryFn: () => api.get<List<CampaignStep>>(`${A}/campaigns/${campaignID}/steps`),
  })

  const enrolments = useQuery({
    enabled: !!campaignID,
    queryKey: ['admissions-campaign-enrolments', campaignID],
    queryFn: () => api.get<List<CampaignEnrolment>>(`${A}/campaigns/${campaignID}/enrolments`),
  })

  const outbox = useQuery({
    queryKey: ['admissions-campaign-outbox', outboxStatus],
    queryFn: () =>
      api.get<List<OutboxRow>>(
        `${A}/campaigns/outbox${outboxStatus ? `?status=${outboxStatus}` : ''}`,
      ),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admissions-campaigns'] })
    qc.invalidateQueries({ queryKey: ['admissions-campaign-steps'] })
    qc.invalidateQueries({ queryKey: ['admissions-campaign-enrolments'] })
    qc.invalidateQueries({ queryKey: ['admissions-campaign-outbox'] })
  }

  const createCampaign = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`${A}/campaigns`, {
        name,
        description: description || undefined,
        is_active: true,
      }),
    onSuccess: (r) => {
      toast.ok('Sequence created')
      setName('')
      setDescription('')
      setCampaignID(r.id)
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const togglePause = useMutation({
    mutationFn: (c: { id: string; name: string; is_active: boolean }) =>
      api.post(`${A}/campaigns`, { id: c.id, name: c.name, is_active: !c.is_active }),
    onSuccess: () => {
      toast.ok('Saved')
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const saveStep = useMutation({
    mutationFn: () =>
      api.post(`${A}/campaigns/${campaignID}/steps`, {
        step_no: numOrNull(step.step_no) ?? 1,
        name: step.name,
        offset_days: numOrNull(step.offset_days) ?? 0,
        channel: step.channel,
        template_code: step.template_code,
        quiet_from: step.quiet_from || undefined,
        quiet_to: step.quiet_to || undefined,
        is_active: step.is_active,
      }),
    onSuccess: () => {
      toast.ok('Touch saved')
      setStep({ ...step, step_no: '', name: '', offset_days: '', template_code: '' })
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const removeStep = useMutation({
    mutationFn: (id: string) => api.del(`${A}/campaign-steps/${id}`),
    onSuccess: invalidate,
    onError: (e) => toast.error(errText(e)),
  })

  const enrol = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ enrolled: number; already_enrolled: number }>(
        `${A}/campaigns/${campaignID}/enrol`,
        body,
      ),
    onSuccess: (r) => {
      toast.ok(
        `${r.enrolled} enrolled${
          r.already_enrolled ? `, ${r.already_enrolled} already on this sequence` : ''
        }`,
      )
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const stop = useMutation({
    mutationFn: (id: string) => api.post(`${A}/campaign-enrolments/${id}/stop`, {}),
    onSuccess: () => {
      toast.ok('Stopped — nothing further will go out')
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const run = useMutation({
    mutationFn: () => api.post<CampaignRunResult>(`${A}/campaigns/run`, {}),
    onSuccess: (r) => {
      toast.ok(
        `${r.queued} queued, ${r.skipped} not sent, ${r.enrolments_stopped} sequences stopped`,
      )
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  if (campaigns.isLoading) return <Loading />
  if (campaigns.error) return <ErrorState error={campaigns.error} />

  const rows = campaigns.data?.items ?? []
  const current = rows.find((c) => c.id === campaignID)
  const openLeads = (leads.data?.items ?? []).filter(
    (l) => l.status !== 'lost' && l.status !== 'applied',
  )
  const sources = [...new Set(openLeads.map((l) => l.source).filter(Boolean))] as string[]

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        title="Multi-touch campaign sequences"
        description="A planned run of follow-ups for a new enquiry, which stops the moment the family converts or opts out."
        actions={
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            <Send className="h-3.5 w-3.5" />
            Send what is due
          </Button>
        }
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Sequences" value={rows.length} />
          <Stat
            label="Families being nurtured"
            value={rows.reduce((n, c) => n + c.active_leads, 0)}
            icon={Users}
          />
          <Stat
            label="Touches due now"
            value={rows.reduce((n, c) => n + c.touches_due, 0)}
            icon={Clock}
          />
          <Stat
            label="Stopped on conversion or opt-out"
            value={rows.reduce((n, c) => n + c.stopped_leads, 0)}
            icon={PauseCircle}
          />
        </CellGrid>

        <Card>
          <div className="p-5 text-[14px] leading-relaxed text-muted-foreground">
            Touches are queued through the school's existing messaging setup — the same providers,
            templates and send-once rules the rest of the product uses. Nothing on this deployment
            flushes that queue on a schedule yet, so “Send what is due” is a button. Pressing it
            twice is safe: a touch already queued is passed over.
          </div>
        </Card>

        <Card>
          <CardHeader title="Sequences" description="One row per nurture plan." />
          <div className="p-5">
            <FormGrid>
              <Field label="New sequence" hint="For example, “Nursery enquiry nurture”.">
                <Input value={name} onChange={setName} placeholder="Sequence name" />
              </Field>
              <Field label="What it is for">
                <Input
                  value={description}
                  onChange={setDescription}
                  placeholder="Day 0, day 3, day 14"
                />
              </Field>
            </FormGrid>
            <div className="mt-5">
              <FormNotice error={createCampaign.error} />
              <Button
                onClick={() => createCampaign.mutate()}
                disabled={!name.trim() || createCampaign.isPending}
              >
                Create sequence
              </Button>
            </div>
          </div>
          <Table
            head={['Sequence', 'Touches', 'Being nurtured', 'Stopped', 'Queued', 'Due now', '']}
            empty={rows.length === 0}
            emptyLabel="No sequences yet."
          >
            {rows.map((c) => (
              <tr key={c.id} className={c.id === campaignID ? 'bg-muted/40' : undefined}>
                <Td>
                  {c.name}
                  {!c.is_active && (
                    <span className="ml-2">
                      <Badge tone="neutral">Paused</Badge>
                    </span>
                  )}
                  {c.description && (
                    <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                      {c.description}
                    </span>
                  )}
                </Td>
                <Td>{c.steps}</Td>
                <Td>{c.active_leads}</Td>
                <Td>{c.stopped_leads}</Td>
                <Td>{c.messages_queued}</Td>
                <Td>{c.touches_due}</Td>
                <Td>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setCampaignID(c.id)}>
                      Open
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => togglePause.mutate(c)}
                      disabled={togglePause.isPending}
                    >
                      {c.is_active ? 'Pause' : 'Resume'}
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {!campaignID && (
          <EmptyState
            title="Choose a sequence"
            body="Its touches, the families on it and what has gone out all belong to one sequence."
          />
        )}

        {campaignID && (
          <Card key={campaignID}>
            <CardHeader
              title={`${current?.name ?? 'Sequence'} — the touches`}
              description="Days are counted from the moment the lead was enrolled, not from today."
            />
            <div className="space-y-5 p-5">
              <FormGrid>
                <Field label="Touch number" required hint="Its place in the run, 1 to 50.">
                  <Input
                    value={step.step_no}
                    onChange={(v) => setStep({ ...step, step_no: v })}
                    placeholder="1"
                  />
                </Field>
                <Field label="What this touch is" required>
                  <Input
                    value={step.name}
                    onChange={(v) => setStep({ ...step, name: v })}
                    placeholder="Welcome message"
                  />
                </Field>
                <Field label="Days after enrolment" hint="0 sends as soon as the run is next made.">
                  <Input
                    value={step.offset_days}
                    onChange={(v) => setStep({ ...step, offset_days: v })}
                    placeholder="0"
                  />
                </Field>
                <Field label="Channel" required>
                  <Select
                    value={step.channel}
                    onChange={(v) => setStep({ ...step, channel: v })}
                    options={CHANNELS}
                  />
                </Field>
                <Field
                  label="Message template"
                  required
                  hint="A template code from your messaging setup. A code with no template falls back to the built-in wording."
                >
                  <Input
                    value={step.template_code}
                    onChange={(v) => setStep({ ...step, template_code: v })}
                    placeholder="admission_welcome"
                  />
                </Field>
                <Field
                  label="Quiet hours"
                  hint="Both ends or neither. A send landing inside the window is held until it ends, never dropped."
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={step.quiet_from}
                      onChange={(v) => setStep({ ...step, quiet_from: v })}
                      placeholder="21:00"
                      srLabel="Quiet hours start"
                    />
                    <span className="text-[13px] text-muted-foreground">to</span>
                    <Input
                      value={step.quiet_to}
                      onChange={(v) => setStep({ ...step, quiet_to: v })}
                      placeholder="09:00"
                      srLabel="Quiet hours end"
                    />
                  </div>
                </Field>
              </FormGrid>
              <Checkbox
                checked={step.is_active}
                onChange={(v) => setStep({ ...step, is_active: v })}
                label="Active"
              />
              <FormNotice error={saveStep.error} />
              <Button
                onClick={() => saveStep.mutate()}
                disabled={!step.name.trim() || !step.template_code.trim() || saveStep.isPending}
              >
                Save touch
              </Button>
            </div>
            {steps.error ? (
              <div className="p-5">
                <ErrorState error={steps.error} />
              </div>
            ) : (
              <Table
                head={['#', 'Touch', 'Day', 'Channel', 'Template', 'Quiet hours', 'Sent', 'Not sent', '']}
                empty={!steps.isLoading && (steps.data?.items.length ?? 0) === 0}
                emptyLabel="No touches yet. A sequence with no touches enrols nobody."
              >
                {(steps.data?.items ?? []).map((st) => (
                  <tr key={st.id}>
                    <Td>{st.step_no}</Td>
                    <Td>
                      {st.name}
                      {!st.is_active && (
                        <span className="ml-2">
                          <Badge tone="neutral">Off</Badge>
                        </span>
                      )}
                    </Td>
                    <Td>{st.offset_days === 0 ? 'Same day' : `Day ${st.offset_days}`}</Td>
                    <Td>{labelOf(CHANNELS, st.channel)}</Td>
                    <Td className="font-mono text-[12.5px]">{st.template_code}</Td>
                    <Td>
                      {st.quiet_from && st.quiet_to
                        ? `${st.quiet_from.slice(0, 5)}–${st.quiet_to.slice(0, 5)}`
                        : '—'}
                    </Td>
                    <Td>{st.queued}</Td>
                    <Td>{st.skipped}</Td>
                    <Td>
                      <ConfirmButton
                        confirmLabel="Remove"
                        question="A touch already sent is switched off instead."
                        tone="danger"
                        onConfirm={() => removeStep.mutate(st.id)}
                      >
                        Remove
                      </ConfirmButton>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {campaignID && (
          <Card key={`${campaignID}-enrol`}>
            <CardHeader
              title="Who is on it"
              description="Leads already converted, closed lost or opted out are never enrolled."
            />
            <div className="flex flex-wrap items-end gap-3 p-5">
              <div className="min-w-[220px]">
                <Field label="Enrol every open lead from">
                  <Select
                    value={enrolSource}
                    onChange={setEnrolSource}
                    options={sources.map((s) => ({ value: s, label: s }))}
                    placeholder="Any source"
                  />
                </Field>
              </div>
              <Button
                onClick={() =>
                  enrol.mutate(
                    enrolSource
                      ? { source: enrolSource }
                      : { enquiry_ids: openLeads.map((l) => l.id) },
                  )
                }
                disabled={enrol.isPending || (!enrolSource && openLeads.length === 0)}
              >
                Enrol {enrolSource ? `“${enrolSource}” leads` : `${openLeads.length} open leads`}
              </Button>
            </div>
            {enrolments.error ? (
              <div className="p-5">
                <ErrorState error={enrolments.error} />
              </div>
            ) : (
              <Table
                head={['Family', 'Lead', 'On the sequence', 'Sent', 'Left', 'Next', 'Why it stopped', '']}
                empty={!enrolments.isLoading && (enrolments.data?.items.length ?? 0) === 0}
                emptyLabel="Nobody is on this sequence yet."
              >
                {(enrolments.data?.items ?? []).map((e) => (
                  <tr key={e.id}>
                    <Td>
                      {e.student_name}
                      {e.parent_name && (
                        <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                          {e.parent_name} · {e.phone ?? 'no number'}
                        </span>
                      )}
                    </Td>
                    <Td>{e.lead_status}</Td>
                    <Td>
                      <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{e.status}</Badge>
                    </Td>
                    <Td>{e.touches_done}</Td>
                    <Td>{e.touches_remaining}</Td>
                    <Td>{e.next_due ?? '—'}</Td>
                    <Td className="text-[12.5px] text-muted-foreground">
                      {e.stopped_reason ?? '—'}
                    </Td>
                    <Td>
                      {e.status === 'active' && (
                        <ConfirmButton
                          confirmLabel="Stop"
                          question="Everything still planned is cancelled."
                          onConfirm={() => stop.mutate(e.id)}
                        >
                          Stop
                        </ConfirmButton>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        <Card>
          <CardHeader
            title="What has gone out"
            description="Every touch the runner has considered, and what became of it."
            action={
              <div className="w-[200px]">
                <Select
                  value={outboxStatus}
                  onChange={setOutboxStatus}
                  options={[
                    { value: 'queued', label: 'Queued to send' },
                    { value: 'pending', label: 'Waiting its turn' },
                    { value: 'skipped', label: 'Not sent' },
                    { value: 'failed', label: 'Could not be prepared' },
                  ]}
                  placeholder="Everything"
                />
              </div>
            }
          />
          {outbox.error ? (
            <div className="p-5">
              <ErrorState error={outbox.error} />
            </div>
          ) : (
            <Table
              head={['Due', 'Sequence', 'Touch', 'Family', 'Channel', 'What happened', 'Why']}
              empty={!outbox.isLoading && (outbox.data?.items.length ?? 0) === 0}
              emptyLabel="Nothing has been due yet."
            >
              {(outbox.data?.items ?? []).map((o) => (
                <tr key={o.id}>
                  <Td>{o.due_at}</Td>
                  <Td>{o.campaign}</Td>
                  <Td>{o.step}</Td>
                  <Td>{o.student_name}</Td>
                  <Td>{labelOf(CHANNELS, o.channel)}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[o.status] ?? 'neutral'}>
                      {SEND_LABEL[o.status] ?? o.status}
                    </Badge>
                  </Td>
                  <Td className="text-[12.5px] text-muted-foreground">{o.note ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
