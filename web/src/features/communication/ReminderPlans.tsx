import { useState } from 'react'
import { AlertTriangle, Ban, Eye, Play, ShieldAlert } from 'lucide-react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, Input, Select, Checkbox, Field, FormGrid, FormNotice,
  SkeletonTiles, ErrorState, EmptyState, Table, Td,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'
import {
  usePlans, useSavePlan, useDeletePlan, useRunPlan, usePreviewPlan,
  blockedReason, outcomeTone, numOr, CHANNEL_LABELS,
  type PlanKind, type PlanDefaults, type PlanPreview, type ReminderPlan, type PlanSaveBody,
} from './message-rules-lib'

/**
 * Reminder plans, as a school operates them.
 *
 * One component behind two catalogue features, because a fee chase and an
 * absence alert are the same sentence with different nouns:
 *
 *     finance.student_dues.automated_fee_reminders
 *     faculty.attendance.absence_alert_to_guardian
 *
 * The generic trigger-rule screen already existed and is not this. A rule
 * there is an event name, a JSON condition and a lead time in minutes — true,
 * complete, and unusable by the bursar who actually decides when a family gets
 * chased. This screen asks the question in the form the school already has an
 * answer to: after how many days, how often, how many times, and what stops it.
 *
 * ---------------------------------------------------------------------------
 * Three things this screen refuses to leave implicit
 *
 *   The dry run is the primary action, not a menu item. "This would message 14
 *   guardians, and here they are" is the only thing that makes it safe to
 *   switch on something that could fire four hundred times. It names people,
 *   and it accounts for the recipient allowlist — which fails closed, so a
 *   school with no policy row would otherwise see a confident 14, watch
 *   nothing arrive, and conclude the product is broken.
 *
 *   Why a plan is not sending is on the plan. A rule whose channel has no
 *   provider looks live, sweeps happily, and has every message refused at the
 *   door. Configured() and the rule's own last_error already carry the answer;
 *   the failure was never that nobody knew, it was that nobody was told.
 *
 *   The stop conditions are legible without opening a form. "Stops the moment
 *   the invoice is paid" and "one message a day however many periods a child
 *   misses" are the promises that make this safe to turn on, so they are
 *   printed beside the plan rather than buried in a help page.
 */

interface Copy {
  eyebrow: string
  title: string
  description: string
  emptyTitle: string
  emptyBody: string
  newLabel: string
}

const COPY: Record<PlanKind, Copy> = {
  fee_reminder: {
    eyebrow: 'Student dues',
    title: 'Automated fee reminders',
    description:
      'Chase an overdue invoice on a schedule you set, and stop the moment it is settled.',
    emptyTitle: 'No fee reminders set up',
    emptyBody:
      'A reminder plan chases overdue invoices for you. Nothing goes out until you create one, and you can see exactly who it would reach before switching it on.',
    newLabel: 'New reminder',
  },
  absence_alert: {
    eyebrow: 'Attendance',
    title: 'Absence alerts to guardians',
    description:
      'Tell a guardian their child is marked absent today — once, after the register is taken, and not if the parent already explained it.',
    emptyTitle: 'No absence alerts set up',
    emptyBody:
      'An alert plan tells guardians about today’s absences. Nothing goes out until you create one, and you can see exactly who it would reach before switching it on.',
    newLabel: 'New alert',
  },
}

/**
 * The stop conditions, in the school's words.
 *
 * Written from the plan rather than hard-coded per kind, because "at most 3
 * chases" and "at most 1" are different promises and a school reading the
 * wrong one is a school that trusted the wrong thing.
 */
function promises(p: ReminderPlan): string[] {
  if (p.kind === 'fee_reminder') {
    const out = [
      p.first_after_days > 0
        ? `Starts ${p.first_after_days} day${p.first_after_days === 1 ? '' : 's'} after the due date`
        : 'Starts on the due date',
      p.repeat_days > 0
        ? `Repeats every ${p.repeat_days} day${p.repeat_days === 1 ? '' : 's'}, ${p.max_attempts} time${p.max_attempts === 1 ? '' : 's'} at most`
        : 'Sends once and does not repeat',
      'Stops the moment the invoice is paid — a queued reminder is withdrawn, not sent',
    ]
    if (p.min_amount_paise > 0) {
      out.push(`Ignores balances under ${formatPaise(p.min_amount_paise)}`)
    }
    return out
  }
  return [
    p.send_at_time
      ? `Looks at the register from ${p.send_at_time} — not at 8am, when half of it is unmarked`
      : 'Looks at the register as soon as the sweep runs',
    'One message per child per day, however many periods they miss',
    p.skip_explained
      ? 'Silent when the parent has already explained the absence, and withdraws an alert if they explain it late'
      : 'Sends even when the parent has already explained the absence',
    'Today’s absences only — a sweep on Monday does not tell forty parents about Friday',
  ]
}

export default function ReminderPlans({ kind }: { kind: PlanKind }) {
  const copy = COPY[kind]
  const plans = usePlans(kind)
  const remove = useDeletePlan(kind)
  const run = useRunPlan(kind)
  const preview = usePreviewPlan()

  const [editing, setEditing] = useState<Partial<ReminderPlan> | null>(null)

  // A failed query is a failure, never an empty state. "No reminders set up"
  // rendered over a 500 is how a school concludes its plans were deleted.
  if (plans.isLoading) return <SkeletonTiles count={4} />
  if (plans.error) return <ErrorState error={plans.error} />

  const items = plans.data?.items ?? []
  const defaults = (plans.data?.kinds ?? []).find((k) => k.kind === kind)
  const channels = plans.data?.channels ?? []
  const templates = plans.data?.templates ?? []
  const guardMode = plans.data?.guard_mode ?? 'allowlist'

  const live = items.filter((p) => p.is_active).length
  const blocked = items.filter((p) => p.is_active && !p.channel_ready).length
  const sent = items.reduce((n, p) => n + p.sent_total, 0)
  const withdrawn = items.reduce((n, p) => n + p.withdrawn, 0)

  const shown = preview.data
  const runs = run.data?.runs ?? []

  return (
    <>
      <PageHead
        eyebrow={copy.eyebrow}
        title={copy.title}
        description={copy.description}
        actions={
          <Button onClick={() => setEditing(blankPlan(kind, defaults, channels))}>
            {copy.newLabel}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Plans" value={items.length} hint={`${live} live`} />
          <Stat
            label="Not sending"
            value={blocked}
            icon={blocked > 0 ? AlertTriangle : undefined}
            hint={blocked > 0 ? 'A live plan whose channel cannot send' : 'Every live plan can send'}
          />
          <Stat label="Messages sent" value={sent} hint="Since these plans were created" />
          <Stat
            label="Withdrawn"
            value={withdrawn}
            hint={
              kind === 'fee_reminder'
                ? 'Pulled back because the invoice was settled'
                : 'Pulled back because the parent explained it'
            }
          />
        </CellGrid>

        {/* The allowlist, stated before anything promises a number.

            It fails closed: a school with no policy row sends to nobody, and
            held messages become 'suppressed' with a reason rather than
            disappearing. A bursar who reads "would send 14" and then watches
            nothing arrive concludes the product is broken, so the condition is
            named here rather than discovered later. */}
        {guardMode !== 'everyone' && (
          <Card className="border-warning/30 bg-warning/5">
            <div className="flex gap-3 p-5">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="text-[14px] leading-relaxed">
                <p className="font-medium">Messages are limited to the recipient allowlist.</p>
                <p className="mt-1 text-muted-foreground">
                  Only numbers and addresses on the school’s messaging allowlist are actually sent
                  to; everything else is recorded as suppressed, with the reason, in the message
                  log. If the list is empty, nothing reaches anybody. The dry run counts this — so
                  a plan that says it would send nothing may be telling you about the allowlist
                  rather than about the plan.
                </p>
              </div>
            </div>
          </Card>
        )}

        {editing && (
          /* key={id} is not decoration.

             Without it React keeps the previous record's state when the form
             switches to another plan, and the operator edits a plan whose
             fields belong to a different one. Ten bugs of exactly this shape
             have shipped in this codebase. 'new' is a stable key for the
             create form, which has no record of its own. */
          <PlanForm
            key={editing.id ?? 'new'}
            kind={kind}
            record={editing}
            channels={channels}
            templates={templates}
            defaults={defaults}
            onClose={() => setEditing(null)}
          />
        )}

        {shown && <PreviewPanel preview={shown} onClose={() => preview.reset()} />}

        {items.length === 0 && !editing ? (
          <EmptyState title={copy.emptyTitle} body={copy.emptyBody} />
        ) : (
          items.map((p) => {
            const why = blockedReason(p)
            const lastRun = runs.find((r) => r.rule_id === p.id)
            return (
              <Card key={p.id}>
                <CardHeader
                  title={p.name}
                  description={`${CHANNEL_LABELS[p.channel] ?? p.channel} · template ${p.template_code} · to guardians`}
                  action={
                    <>
                      <Button
                        size="sm"
                        disabled={preview.isPending}
                        onClick={() => preview.mutate(p.id)}
                        title="See exactly who this would message, without sending anything"
                      >
                        <Eye className="mr-1.5 inline h-3.5 w-3.5" />
                        {preview.isPending ? 'Checking…' : 'Dry run'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={run.isPending || !p.is_active}
                        onClick={() => run.mutate(p.id)}
                        title={
                          p.is_active
                            ? 'Queue what this plan would send right now'
                            : 'Paused — switch it on first'
                        }
                      >
                        <Play className="mr-1.5 inline h-3.5 w-3.5" />
                        Run now
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                      <ConfirmButton
                        variant="ghost"
                        tone="danger"
                        confirmLabel="Delete"
                        question="Anything queued and not yet sent is withdrawn. The record of what was already sent is kept."
                        onConfirm={() => remove.mutate(p.id)}
                      >
                        Delete
                      </ConfirmButton>
                    </>
                  }
                />
                <div className="space-y-4 p-5">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <Badge tone={p.is_active ? 'success' : 'neutral'}>
                      {p.is_active ? 'Live' : 'Paused'}
                    </Badge>
                    {p.is_active && !p.channel_ready && <Badge tone="danger">Cannot send</Badge>}
                    {p.gate && <Badge tone="info">{p.gate}</Badge>}
                    <span className="text-[13px] text-muted-foreground">
                      Last run {p.last_run_at ? whenText(p.last_run_at) : 'never'}
                      {p.last_run_at ? ` · queued ${p.last_queued}` : ''}
                    </span>
                    <span className="text-[13px] text-muted-foreground">
                      {p.waiting} waiting · {p.sent_total} sent · {p.withdrawn} withdrawn
                    </span>
                  </div>

                  {/* Why it is not sending, on the plan itself. The most common
                      way an automation silently does nothing is a channel with
                      no provider: the plan looks live, the sweep runs, and
                      every message is refused at the door. */}
                  {why && (
                    <p className="flex gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
                      <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{why}</span>
                    </p>
                  )}

                  <ul className="space-y-1 text-[13.5px] leading-relaxed text-muted-foreground">
                    {promises(p).map((line) => (
                      <li key={line} className="flex gap-2">
                        <span aria-hidden className="text-muted-foreground/50">
                          •
                        </span>
                        <span>{line}</span>
                      </li>
                    ))}
                    {p.quiet_from && p.quiet_to && (
                      <li className="flex gap-2">
                        <span aria-hidden className="text-muted-foreground/50">
                          •
                        </span>
                        <span>
                          Nothing sent between {p.quiet_from} and {p.quiet_to} — a message falling
                          inside is held until the window ends, never dropped
                        </span>
                      </li>
                    )}
                  </ul>

                  {lastRun && (
                    <p className="rounded-md border bg-muted/40 px-3 py-2 text-[13px]">
                      Run now: queued {lastRun.queued}, already sent {lastRun.already_sent},
                      withdrawn {lastRun.withdrawn}
                      {lastRun.skipped ? ` — skipped (${lastRun.skipped})` : ''}
                      {lastRun.error ? ` — ${lastRun.error}` : ''}. Queued messages leave with the
                      next dispatch, within five minutes.
                    </p>
                  )}
                </div>
              </Card>
            )
          })
        )}

        <FormNotice error={run.error ?? remove.error ?? preview.error ?? undefined} />
      </PageBody>
    </>
  )
}

// --- the dry run -------------------------------------------------------------

/**
 * What the plan would do, named.
 *
 * Five numbers rather than one, because "would send 14" alone is the figure
 * that gets a school to switch something on and then conclude it is broken.
 * Each of the others is a different conversation: already covered is the
 * system working, held is the allowlist, no address is the guardian records,
 * and shares a message is the one-per-occurrence index folding two parents of
 * one child onto a single send.
 */
function PreviewPanel({ preview, onClose }: { preview: PlanPreview; onClose: () => void }) {
  return (
    <Card className="border-primary/30">
      <CardHeader
        title={`Dry run — ${preview.name}`}
        description="Nothing was sent and nothing was queued. This is what would happen if the plan ran right now."
        action={
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        }
      />
      <div className="p-5">
        <p className="text-[15px] leading-relaxed">
          <strong className="text-[20px] font-semibold">{preview.would_send}</strong>{' '}
          {preview.would_send === 1 ? 'guardian would be messaged' : 'guardians would be messaged'}
          {preview.students > 0 && (
            <> about {preview.students} {preview.students === 1 ? 'child' : 'children'}</>
          )}
          .
        </p>
        {preview.gate && (
          <p className="mt-2 text-[13.5px] text-muted-foreground">
            The plan is {preview.gate} before it looks at the register. Pressing Run now overrides
            that.
          </p>
        )}
        {!preview.channel_ready && (
          <p className="mt-2 text-[13.5px] text-destructive">
            None of them would actually leave: {preview.channel_reason}
          </p>
        )}
        {preview.guard_note && (
          <p className="mt-2 text-[13.5px] text-muted-foreground">{preview.guard_note}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-px border-y bg-border sm:grid-cols-5">
        <PreviewCount label="Would send" value={preview.would_send} tone="success" />
        <PreviewCount label="Already covered" value={preview.already_sent} />
        <PreviewCount label="Held by allowlist" value={preview.suppressed} tone="danger" />
        <PreviewCount label="No address" value={preview.no_address} tone="warning" />
        <PreviewCount label="Shares a message" value={preview.collapsed} />
      </div>

      {/* A sibling of the padded body, not inside it: a Table nested in a p-5
          block double-insets and its column rules stop meeting the card edge. */}
      <Table
        head={['Guardian', 'Child', 'Contact', 'What it is about', 'Outcome']}
        empty={preview.sample.length === 0}
        emptyLabel={
          preview.occurrences === 0
            ? 'Nothing matches this plan right now — there is nothing to chase.'
            : 'Every occurrence has already been covered.'
        }
      >
        {preview.sample.map((row, i) => (
          <tr key={`${row.name}-${row.detail ?? ''}-${i}`}>
            <Td>{row.name}</Td>
            <Td>{row.student || '—'}</Td>
            <Td className="tabular-nums">{row.address || '—'}</Td>
            <Td>{row.detail || '—'}</Td>
            <Td>
              <Badge tone={outcomeTone(row.outcome)}>{row.outcome}</Badge>
              {row.reason && (
                <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                  {row.reason}
                </span>
              )}
            </Td>
          </tr>
        ))}
      </Table>

      {preview.truncated > 0 && (
        <p className="border-t px-5 py-3 text-[13px] text-muted-foreground">
          {preview.truncated} more not listed. The counts above cover all of them.
        </p>
      )}
    </Card>
  )
}

function PreviewCount({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'success' | 'danger' | 'warning'
}) {
  const colour =
    value === 0
      ? 'text-muted-foreground'
      : tone === 'success'
        ? 'text-success'
        : tone === 'danger'
          ? 'text-destructive'
          : tone === 'warning'
            ? 'text-warning'
            : ''
  return (
    <div className="bg-card px-5 py-4">
      <p className="text-[12.5px] text-muted-foreground">{label}</p>
      <p className={`mt-1 text-[19px] font-semibold tabular-nums ${colour}`}>{value}</p>
    </div>
  )
}

// --- the form ----------------------------------------------------------------

function blankPlan(
  kind: PlanKind,
  defaults: PlanDefaults | undefined,
  channels: string[],
): Partial<ReminderPlan> {
  return {
    kind,
    name: '',
    // in_app is the safe default: it is the one channel that reaches nobody
    // outside the building, so a plan created and forgotten cannot text a
    // parent by accident.
    channel: channels.includes('in_app') ? 'in_app' : (channels[0] ?? 'in_app'),
    template_code: defaults?.template_code ?? '',
    is_active: false,
    first_after_days: kind === 'fee_reminder' ? 7 : 0,
    min_amount_paise: 0,
    repeat_days: kind === 'fee_reminder' ? 7 : 0,
    max_attempts: kind === 'fee_reminder' ? 3 : 1,
    send_at_time: kind === 'absence_alert' ? '11:30' : '',
    skip_explained: true,
    quiet_from: '21:00',
    quiet_to: '09:00',
  }
}

/**
 * The form, with every number held as a string until save.
 *
 * A numeric control that turns '' into 0 rewrites "chase after 7 days" as
 * "chase on the due date" the instant somebody selects the 7 to replace it —
 * silently, and in the direction that messages more families rather than
 * fewer. So the boxes hold text, Save is refused while a required one is
 * blank, and numOr converts exactly once.
 */
function PlanForm({
  kind,
  record,
  channels,
  templates,
  defaults,
  onClose,
}: {
  kind: PlanKind
  record: Partial<ReminderPlan>
  channels: string[]
  templates: string[]
  defaults?: PlanDefaults
  onClose: () => void
}) {
  const save = useSavePlan(kind)

  const [name, setName] = useState(record.name ?? '')
  const [channel, setChannel] = useState(record.channel ?? 'in_app')
  const [template, setTemplate] = useState(record.template_code ?? defaults?.template_code ?? '')
  const [active, setActive] = useState(record.is_active ?? false)
  const [firstAfter, setFirstAfter] = useState(str(record.first_after_days))
  const [minRupees, setMinRupees] = useState(
    record.min_amount_paise ? String(record.min_amount_paise / 100) : '',
  )
  const [repeat, setRepeat] = useState(str(record.repeat_days))
  const [attempts, setAttempts] = useState(str(record.max_attempts))
  const [sendAt, setSendAt] = useState(record.send_at_time ?? '')
  const [skipExplained, setSkipExplained] = useState(record.skip_explained ?? true)
  const [quietFrom, setQuietFrom] = useState(record.quiet_from ?? '')
  const [quietTo, setQuietTo] = useState(record.quiet_to ?? '')

  const isFee = kind === 'fee_reminder'
  const blankRequired = isFee && (firstAfter.trim() === '' || attempts.trim() === '')
  const canSave = name.trim() !== '' && template.trim() !== '' && !blankRequired

  const body: PlanSaveBody = {
    id: record.id,
    kind,
    name: name.trim(),
    channel,
    template_code: template.trim(),
    is_active: active,
    first_after_days: isFee ? numOr(firstAfter, 7) : 0,
    min_amount_paise: Math.round(numOr(minRupees, 0) * 100),
    repeat_days: isFee ? numOr(repeat, 0) : 0,
    max_attempts: isFee ? numOr(attempts, 1) : 1,
    send_at_time: isFee ? '' : sendAt,
    skip_explained: skipExplained,
    quiet_from: quietFrom,
    quiet_to: quietTo,
  }

  return (
    <Card>
      <CardHeader
        title={record.id ? 'Edit plan' : 'New plan'}
        description={defaults?.description}
      />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field
            label="Name"
            required
            hint="Appears beside every message this plan sends, so “why did this parent get an SMS” is one lookup."
          >
            <Input value={name} onChange={setName} placeholder="Weekly fee chase" />
          </Field>

          <Field label="Channel" required hint="A channel with no provider set up cannot send.">
            <Select
              value={channel}
              onChange={setChannel}
              options={channels.map((c) => ({ value: c, label: CHANNEL_LABELS[c] ?? c }))}
            />
          </Field>

          <Field
            label="Template"
            required
            hint="The school’s own wording where it has written one, and a built-in where it has not."
          >
            <Select
              value={template}
              onChange={setTemplate}
              options={templates.map((c) => ({ value: c, label: c }))}
              placeholder="Choose a template"
            />
          </Field>

          {isFee ? (
            <>
              <Field
                label="First reminder, days after the due date"
                required
                hint="Do not leave this blank — a blank saved as zero would chase every parent on the due date itself."
              >
                <Input value={firstAfter} onChange={setFirstAfter} type="number" placeholder="7" />
              </Field>

              <Field label="Repeat every, days" hint="0 sends once and never comes back.">
                <Input value={repeat} onChange={setRepeat} type="number" placeholder="7" />
              </Field>

              <Field
                label="At most, this many times"
                required
                hint="The cap. Without one, a hardship case is chased until somebody notices."
              >
                <Input value={attempts} onChange={setAttempts} type="number" placeholder="3" />
              </Field>

              <Field label="Ignore balances under (₹)" hint="Leave blank to chase every balance.">
                <Input value={minRupees} onChange={setMinRupees} type="number" placeholder="0" />
              </Field>
            </>
          ) : (
            <>
              <Field
                label="Do not look before"
                hint="The register has to be taken first. At 08:00 half the school is unmarked, so half the school is not yet absent."
              >
                <Input
                  value={sendAt}
                  onChange={setSendAt}
                  type="time"
                  srLabel="Do not look before"
                />
              </Field>
              <Field label="Absences the parent explained" wide>
                <Checkbox
                  checked={skipExplained}
                  onChange={setSkipExplained}
                  label="Say nothing when the absence has already been explained"
                  hint="Covers the parent portal’s one-tap report and an ordinary leave application, pending or approved. An alert already queued is withdrawn if the explanation arrives late."
                />
              </Field>
            </>
          )}

          <Field
            label="Quiet from"
            hint="Both ends or neither. A message falling inside is held to the end of the window, never dropped."
          >
            <Input
              value={quietFrom}
              onChange={setQuietFrom}
              type="time"
              srLabel="Quiet hours start"
            />
          </Field>
          <Field label="Quiet until">
            <Input value={quietTo} onChange={setQuietTo} type="time" srLabel="Quiet hours end" />
          </Field>

          <Field label="Status" wide>
            <Checkbox
              checked={active}
              onChange={setActive}
              label="Live — this plan may send"
              hint="Leave it off until a dry run shows you who it would reach. Pausing later stops new messages; anything already queued is still withdrawn when the reason for it goes away."
            />
          </Field>
        </FormGrid>

        {blankRequired && (
          <p className="text-[13px] text-warning">
            Fill in both the first-reminder day and the cap. A blank is not zero here, and saving
            it as zero would chase every parent on the due date.
          </p>
        )}

        <FormNotice error={save.error ?? undefined} ok={save.isSuccess ? 'Saved.' : undefined} />

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!canSave || save.isPending}
            onClick={() => save.mutate(body, { onSuccess: onClose })}
          >
            {save.isPending ? 'Saving…' : 'Save plan'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  )
}

function str(n: number | undefined): string {
  return n === undefined || n === null ? '' : String(n)
}

// Relative, because "is this working" is a question about how long ago, not
// about a timestamp somebody has to subtract from now in their head.
function whenText(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}
