import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Types and hooks for reminder plans — the fee chase and the absence alert.
 *
 * Every path is relative to /api/v1/admin/messaging/plans, which is where
 * mountMessageRules puts them (internal/api/message_rules.go), spliced into the
 * existing /admin group beside mountMessaging.
 *
 * Written once here so that a field renamed in the Go structs fails to compile
 * in one place, rather than rendering as `undefined` on a screen whose entire
 * job is telling a school whether its parents are being messaged.
 */

const BASE = '/api/v1/admin/messaging/plans'

export type PlanKind = 'fee_reminder' | 'absence_alert'

/** What the server says each kind is, so the client carries no second copy. */
export interface PlanDefaults {
  kind: PlanKind
  label: string
  event: string
  template_code: string
  audience: string
  description: string
}

export interface ReminderPlan {
  id: string
  kind: PlanKind
  name: string
  channel: string
  template_code: string
  audience: string
  is_active: boolean

  /** Fee: days overdue before the first chase. */
  first_after_days: number
  /** Fee: don't chase a trivial balance. Paise, never rupees. */
  min_amount_paise: number
  /** Fee: days between chases. 0 sends once. */
  repeat_days: number
  /** Fee: total chases, first included. */
  max_attempts: number
  /** Absence: don't look before this time — the register has to be taken first. */
  send_at_time: string
  /** Absence: leave alone the families who already told the school. */
  skip_explained: boolean
  quiet_from: string
  quiet_to: string

  /* The four fields that answer "is this working", which is the question a
     school asks about an automation and the one a list of rules cannot
     answer. channel_reason is Configured()'s own sentence; last_error is what
     applyRule wrote onto the rule row when it refused. */
  channel_ready: boolean
  channel_reason?: string
  last_run_at?: string
  last_queued: number
  last_error?: string
  /** "waiting until 11:30", when the time-of-day gate is shut. */
  gate?: string
  withdrawn: number
  sent_total: number
  waiting: number
}

export interface PlanList {
  items: ReminderPlan[]
  kinds: PlanDefaults[]
  channels: string[]
  templates: string[]
  /** 'allowlist' | 'everyone'. Allowlist fails closed and sends to nobody. */
  guard_mode: string
}

export interface PreviewRecipient {
  name: string
  student?: string
  /** Masked by the server. The client never sees a full contact. */
  address: string
  detail?: string
  outcome: 'would send' | 'suppressed' | 'no address' | 'covered' | 'already sent'
  reason?: string
}

export interface PlanPreview {
  rule_id: string
  name: string
  kind: PlanKind
  channel: string
  channel_ready: boolean
  channel_reason?: string
  gate?: string
  occurrences: number
  matched: number
  students: number
  would_send: number
  already_sent: number
  suppressed: number
  no_address: number
  collapsed: number
  guard_mode: string
  guard_note?: string
  sample: PreviewRecipient[]
  truncated: number
}

export interface PlanRun {
  rule_id: string
  name: string
  kind: PlanKind
  occurrences: number
  queued: number
  already_sent: number
  withdrawn: number
  skipped?: string
  error?: string
}

export interface PlanSaveBody {
  id?: string
  kind: PlanKind
  name: string
  channel: string
  template_code: string
  is_active: boolean
  first_after_days: number
  min_amount_paise: number
  repeat_days: number
  max_attempts: number
  send_at_time: string
  skip_explained: boolean
  quiet_from: string
  quiet_to: string
}

export function usePlans(kind: PlanKind) {
  return useQuery({
    queryKey: ['message-rules', 'plans', kind],
    queryFn: () => api.get<PlanList>(`${BASE}?kind=${kind}`),
  })
}

function usePlanWrite<TResult, TBody>(kind: PlanKind, fn: (body: TBody) => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['message-rules', 'plans', kind] }),
  })
}

export function useSavePlan(kind: PlanKind) {
  return usePlanWrite<{ id: string }, PlanSaveBody>(kind, (body) => api.post(BASE, body))
}

export function useDeletePlan(kind: PlanKind) {
  return usePlanWrite<{ deleted: boolean; withdrawn: number }, string>(kind, (id) =>
    api.del(`${BASE}/${id}`),
  )
}

/**
 * The dry run.
 *
 * A mutation rather than a query even though it changes nothing on the server,
 * because it is a thing somebody asks for by pressing a button and the answer
 * is about this moment. Cached as a query it would show yesterday's fourteen
 * families beside today's plan.
 */
export function usePreviewPlan() {
  return useMutation({
    mutationFn: (id: string) => api.post<PlanPreview>(`${BASE}/${id}/preview`, {}),
  })
}

export function useRunPlan(kind: PlanKind) {
  return usePlanWrite<{ runs: PlanRun[] }, string>(kind, (id) =>
    api.post(`${BASE}/${id}/run`, {}),
  )
}

export const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  in_app: 'In-app only',
}

/**
 * Why this plan is not sending, in one sentence, or '' if it is.
 *
 * Ordered by what blocks first. A plan that is paused is not sending whatever
 * its provider says, and saying "SMS is not set up" to somebody who switched
 * the plan off last week sends them to the wrong screen.
 */
export function blockedReason(p: ReminderPlan): string {
  if (!p.is_active) return 'Paused — switch it on to start chasing again.'
  if (!p.channel_ready) {
    return p.channel_reason
      ? `${CHANNEL_LABELS[p.channel] ?? p.channel} cannot send: ${p.channel_reason}`
      : `${CHANNEL_LABELS[p.channel] ?? p.channel} is not set up.`
  }
  if (p.last_error) return p.last_error
  return ''
}

export function outcomeTone(
  outcome: PreviewRecipient['outcome'],
): 'success' | 'warning' | 'neutral' | 'danger' {
  switch (outcome) {
    case 'would send':
      return 'success'
    case 'suppressed':
      return 'danger'
    case 'no address':
      return 'warning'
    default:
      return 'neutral'
  }
}

/**
 * A number box that stays empty when it is empty.
 *
 * Typing over a numeric field clears it first, and a control that turned ''
 * into 0 would silently rewrite "chase after 7 days" as "chase immediately"
 * the moment somebody selected the 7 to replace it. So the form holds numbers
 * as strings and converts once, here, on save.
 */
export function numOr(value: string, fallback: number): number {
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : fallback
}
