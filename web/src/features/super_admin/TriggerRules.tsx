import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, Input, Select, Checkbox, Field, FormGrid, FormNotice,
  Loading, ErrorState, Table, Td,
} from '@/components/ui'
import {
  useTriggers, useSaveRule, useDeleteRule, useRunSweep, useTemplates,
  useMessageLog, statusTone, when,
  type TriggerRule, type TriggerEvent, type SweepResult,
} from './messaging-lib'

/**
 * Automated Trigger Rules.
 *
 * "Tell guardians when a child is marked absent" and "remind them a day before
 * the parent-teacher meeting" are the same sentence with different nouns, so
 * they are rows on this screen rather than four separate features. A rule
 * names what happened, which of those occurrences matter, who hears about it,
 * what it says, and how far ahead — and nothing about it requires a release.
 *
 * Two things this screen refuses to hide.
 *
 *   A rule whose channel has no provider is marked as such in the list. It is
 *   the most common way an automation silently does nothing: the rule looks
 *   live, the sweep runs, and every message is refused at the door. Saying so
 *   beside the rule is the difference between a five-minute fix and a term of
 *   parents not being told.
 *
 *   Running the sweep reports what was already sent separately from what was
 *   queued. "Nothing was sent" and "nothing needed sending" look identical if
 *   only one number is shown, and the first is a fault while the second is the
 *   system working exactly as intended.
 */
export default function TriggerRules() {
  const triggers = useTriggers()
  const templates = useTemplates()
  const log = useMessageLog('?limit=60')
  const sweep = useRunSweep()
  const remove = useDeleteRule()

  const [editing, setEditing] = useState<Partial<TriggerRule> | null>(null)

  if (triggers.isLoading) return <Loading />
  if (triggers.error) return <ErrorState error={triggers.error} />

  const rules = triggers.data?.items ?? []
  const events = triggers.data?.events ?? []
  const channels = triggers.data?.channels ?? []
  const audiences = triggers.data?.audiences ?? []
  const codes = Array.from(new Set((templates.data?.items ?? []).map((t) => t.code)))

  const live = rules.filter((r) => r.is_active).length
  const blocked = rules.filter((r) => r.is_active && !r.channel_ready).length
  const results = sweep.data?.results ?? []

  return (
    <>
      <PageHead
        eyebrow="Messaging"
        title="Automated Trigger Rules"
        description="When something happens, who hears about it — configured as rules rather than written as code."
        actions={
          <>
            <Button
              variant="secondary"
              disabled={sweep.isPending || live === 0}
              onClick={() => sweep.mutate({ dispatch: true })}
              title={live === 0 ? 'No live rules to run' : 'Evaluate every live rule against what is happening now'}
            >
              {sweep.isPending ? 'Running…' : 'Run all rules now'}
            </Button>
            <Button onClick={() => setEditing(blankRule(events, channels))}>New rule</Button>
          </>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Rules" value={rules.length} hint={`${live} live`} />
          <Stat
            label="Blocked on a provider"
            value={blocked}
            hint={blocked ? 'These fire and are refused at the door' : 'Every live rule has a way out'}
          />
          <Stat label="Events the sweep can find" value={events.length} />
          <Stat
            label="Queued by the last run"
            value={results.reduce((n, r) => n + r.queued, 0)}
            hint={sweep.data ? `${sweep.data.sent ?? 0} sent` : 'Not run this visit'}
          />
        </CellGrid>

        {editing && (
          <RuleForm
            rule={editing}
            events={events}
            channels={channels}
            audiences={audiences}
            codes={codes}
            onClose={() => setEditing(null)}
          />
        )}

        {results.length > 0 && <SweepReport results={results} />}

        <Card>
          <CardHeader
            title="Rules"
            description="Each row is one sentence: when this happens, tell these people this, that far ahead"
          />
          <Table
            head={['Rule', 'When', 'Who hears', 'How', 'Last run', '']}
            empty={rules.length === 0}
            emptyLabel="No rules yet. A school with none sends nothing automatically — which is a choice, not a fault."
          >
            {rules.map((r) => (
              <tr key={r.id}>
                <Td>
                  <span className="font-medium">{r.name}</span>
                  {!r.is_active && <Badge tone="neutral">paused</Badge>}
                  {r.is_active && !r.channel_ready && (
                    <span className="block text-[12px] text-destructive">
                      cannot send: {r.channel_reason}
                    </span>
                  )}
                </Td>
                <Td>
                  <span className="font-mono text-[12.5px]">{r.event}</span>
                  <span className="block text-[12px] text-muted-foreground">
                    {describeCondition(r.condition)}
                    {r.lead_minutes > 0 && `, ${leadLabel(r.lead_minutes)} ahead`}
                  </span>
                </Td>
                <Td>{audienceLabel(r.audience)}</Td>
                <Td>
                  {r.channel}
                  <span className="block text-[12px] text-muted-foreground">{r.template_code}</span>
                  {r.quiet_from && (
                    <span className="block text-[12px] text-muted-foreground">
                      quiet {r.quiet_from.slice(0, 5)}–{r.quiet_to.slice(0, 5)}
                    </span>
                  )}
                </Td>
                <Td>
                  {when(r.last_run_at)}
                  <span className="block text-[12px] text-muted-foreground">
                    {r.last_error ? r.last_error : `${r.last_queued} queued`}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={sweep.isPending}
                    onClick={() => sweep.mutate({ rule_id: r.id, dispatch: true })}
                  >
                    Run
                  </Button>
                  <ConfirmButton
                    confirmLabel="Delete"
                    question="The rule stops firing. Messages it already sent stay in the log."
                    onConfirm={() => remove.mutate(r.id)}
                    tone="danger"
                  >
                    Delete
                  </ConfirmButton>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="What a rule may listen for"
            description="An event the sweep can find on its own. A feature may also report its own event, which a rule can name before this list grows"
          />
          <Table head={['Event', 'Happens when', 'Facts a condition may test']}>
            {events.map((e) => (
              <tr key={e.event}>
                <Td className="font-mono text-[12.5px]">{e.event}</Td>
                <Td>{e.description}</Td>
                <Td className="font-mono text-[12.5px] text-muted-foreground">{e.facts}</Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="What went out"
            description="Every automated message, with the rule that caused it and the occurrence it was about"
          />
          <Table
            head={['Queued', 'To', 'Rule', 'Channel', 'Status']}
            empty={(log.data?.items ?? []).length === 0}
            emptyLabel="Nothing has been sent yet."
          >
            {(log.data?.items ?? []).map((row) => (
              <tr key={row.id}>
                <Td className="whitespace-nowrap">{when(row.queued_at)}</Td>
                <Td>{row.recipient}</Td>
                <Td>{row.rule ?? row.source_kind ?? 'sent by hand'}</Td>
                <Td>{row.channel}</Td>
                <Td>
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  {row.send_after && row.status === 'queued' && (
                    <span className="block text-[12px] text-muted-foreground">
                      held until {when(row.send_after)}
                    </span>
                  )}
                  {row.error && (
                    <span className="block text-[12px] text-destructive">{row.error}</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}

function blankRule(events: TriggerEvent[], channels: string[]): Partial<TriggerRule> {
  return {
    name: '',
    event: events[0]?.event ?? 'student.absent',
    condition: {},
    audience: 'guardians',
    channel: channels[0] ?? 'email',
    template_code: '',
    lead_minutes: 0,
    quiet_from: '21:00',
    quiet_to: '09:00',
    is_active: true,
  }
}

/**
 * The rule editor.
 *
 * The condition is edited as a small set of named constraints rather than as
 * raw JSON, because the person deciding that a fee chase starts at seven days
 * is a school administrator and not a programmer. Only the two shapes the
 * server evaluates are offered — at least, and at most — which is also the
 * whole vocabulary, so nothing here can express a rule the sweep would then
 * silently ignore.
 */
function RuleForm({
  rule, events, channels, audiences, codes, onClose,
}: {
  rule: Partial<TriggerRule>
  events: TriggerEvent[]
  channels: string[]
  audiences: string[]
  codes: string[]
  onClose: () => void
}) {
  const save = useSaveRule()
  const [v, setV] = useState<Partial<TriggerRule>>(rule)
  const set = <K extends keyof TriggerRule>(k: K, val: TriggerRule[K]) =>
    setV({ ...v, [k]: val })

  const event = events.find((e) => e.event === v.event)
  const facts = (event?.facts ?? '').split(',').map((f) => f.trim()).filter(Boolean)
  const cond = (v.condition ?? {}) as Record<string, unknown>

  const setBound = (prefix: 'min' | 'max', fact: string, raw: string) => {
    const next = { ...cond }
    const key = `${prefix}_${fact}`
    if (raw.trim() === '') delete next[key]
    else next[key] = Number(raw)
    set('condition', next)
  }

  return (
    <Card>
      <CardHeader
        title={v.id ? `Edit "${rule.name}"` : 'New rule'}
        description="When this happens, tell these people this — and not in the middle of the night"
        action={
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    ...(v.id ? { id: v.id } : {}),
                    name: (v.name ?? '').trim(),
                    event: v.event,
                    condition: v.condition ?? {},
                    audience: v.audience,
                    channel: v.channel,
                    template_code: (v.template_code ?? '').trim(),
                    lead_minutes: Number(v.lead_minutes) || 0,
                    quiet_from: v.quiet_from ?? '',
                    quiet_to: v.quiet_to ?? '',
                    is_active: v.is_active ?? true,
                  },
                  { onSuccess: onClose },
                )
              }
            >
              {save.isPending ? 'Saving…' : 'Save rule'}
            </Button>
          </>
        }
      />
      <div className="space-y-5 p-5">
        <FormNotice error={save.error} />

        <FormGrid>
          <Field label="Name" required hint="How the school finds this rule again, and what the message log calls it.">
            <Input value={v.name ?? ''} onChange={(x) => set('name', x)} placeholder="Absence alert to guardians" />
          </Field>
          <Field label="When this happens" required hint={event?.description}>
            <Select
              value={v.event ?? ''}
              onChange={(x) => set('event', x)}
              options={events.map((e) => ({ value: e.event, label: e.event }))}
            />
          </Field>
          <Field label="Who hears about it" required>
            <Select
              value={v.audience ?? 'guardians'}
              onChange={(x) => set('audience', x)}
              options={audiences.map((a) => ({ value: a, label: audienceLabel(a) }))}
            />
          </Field>
          <Field label="How" required hint="A channel with no provider behind it will refuse every message.">
            <Select
              value={v.channel ?? 'email'}
              onChange={(x) => set('channel', x)}
              options={channels.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="What it says" required hint="A template code. Leave one that has no template of its own and the built-in wording is used.">
            <Input value={v.template_code ?? ''} onChange={(x) => set('template_code', x)} list="messaging-template-codes" placeholder="attendance.absent" />
            <datalist id="messaging-template-codes">
              {codes.map((c) => <option key={c} value={c} />)}
            </datalist>
          </Field>
          <Field label="How far ahead (minutes)" hint="1440 is the day before. Zero means at the moment it happens.">
            <Input value={String(v.lead_minutes ?? 0)} onChange={(x) => set('lead_minutes', Number(x) || 0)} />
          </Field>
          <Field label="Quiet from" hint="Nothing is sent inside this window; it is held until the end, never dropped.">
            <Input value={v.quiet_from ?? ''} onChange={(x) => set('quiet_from', x)} placeholder="21:00" />
          </Field>
          <Field label="Quiet until" hint="Both or neither. India's rules put commercial messages outside 21:00–09:00.">
            <Input value={v.quiet_to ?? ''} onChange={(x) => set('quiet_to', x)} placeholder="09:00" />
          </Field>
        </FormGrid>

        {facts.length > 0 && (
          <div className="border-t pt-5">
            <p className="mb-1 text-[13px] font-medium text-secondary-foreground">Which of them</p>
            <p className="mb-3 text-[13px] text-muted-foreground">
              Leave every box empty to act on all of them. A bound left blank is not tested.
            </p>
            <FormGrid>
              {facts.map((f) => (
                <Field key={f} label={f.replace(/_/g, ' ')}>
                  <div className="flex items-center gap-2">
                    <Input
                      value={String(cond[`min_${f}`] ?? '')}
                      onChange={(x) => setBound('min', f, x)}
                      placeholder="at least"
                    />
                    <Input
                      value={String(cond[`max_${f}`] ?? '')}
                      onChange={(x) => setBound('max', f, x)}
                      placeholder="at most"
                    />
                  </div>
                </Field>
              ))}
            </FormGrid>
          </div>
        )}

        <Checkbox
          checked={v.is_active ?? true}
          onChange={(x) => set('is_active', x)}
          label="Live"
          hint="A paused rule keeps its settings and stops firing."
        />
      </div>
    </Card>
  )
}

/* The sweep's own report. Queued and already-sent are shown apart because they
   answer different questions: the first is what this run did, the second is
   proof the run did not send anything twice. */
function SweepReport({ results }: { results: SweepResult[] }) {
  return (
    <Card>
      <CardHeader
        title="Last run"
        description="What each rule found, what it queued, and what it left alone because it had already been sent"
      />
      <Table head={['Rule', 'Occurrences found', 'Queued now', 'Already sent', 'Note']}>
        {results.map((r) => (
          <tr key={r.rule_id}>
            <Td>{r.rule}</Td>
            <Td>{r.occurrences}</Td>
            <Td>{r.queued}</Td>
            <Td>{r.already_sent}</Td>
            <Td className="text-[13px] text-muted-foreground">{r.error ?? '—'}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

function audienceLabel(a: string): string {
  if (a === 'guardians') return "The child's guardians"
  if (a === 'student') return 'The child'
  if (a === 'staff') return 'The member of staff named'
  if (a.startsWith('role:')) return `Everyone with role ${a.slice(5)}`
  return a
}

function leadLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day(s)`
  if (minutes % 60 === 0) return `${minutes / 60} hour(s)`
  return `${minutes} minute(s)`
}

function describeCondition(condition: Record<string, unknown>): string {
  const parts = Object.entries(condition).map(([k, val]) => {
    if (k.startsWith('min_')) return `${k.slice(4).replace(/_/g, ' ')} ≥ ${val}`
    if (k.startsWith('max_')) return `${k.slice(4).replace(/_/g, ' ')} ≤ ${val}`
    return `${k.replace(/_/g, ' ')} = ${val}`
  })
  return parts.length ? parts.join(', ') : 'every occurrence'
}
