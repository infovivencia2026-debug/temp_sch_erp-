import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Shared types and hooks for the messaging tier.
 *
 * Two screens — the SMTP integration and the trigger rules — sit on one Go
 * file, and both need the provider list: one to configure it, the other to say
 * why a rule cannot fire. Written once here so a field renamed in
 * internal/api/messaging.go fails to compile in one place.
 *
 * Every path is relative to /api/v1/admin/messaging, which is where
 * mountMessaging puts them.
 */

const BASE = '/api/v1/admin/messaging'

/** One channel's provider, as the server reports it. */
export interface Provider {
  channel: string
  label: string
  provider: string
  /** Whether a send would be attempted at all. */
  configured: boolean
  /** Why not, in a sentence an administrator can act on. */
  reason?: string
  enabled: boolean
  /** A password or API key is stored. The value itself is never returned. */
  has_secret: boolean
  settings: Record<string, unknown>
  last_ok_at?: string
  last_error?: string
  queued: number
  sent_today: number
  failed_today: number
}

export interface SmtpSettings {
  host?: string
  port?: number
  username?: string
  from_address?: string
  from_name?: string
  security?: string
}

export interface TriggerRule {
  id: string
  name: string
  event: string
  condition: Record<string, unknown>
  audience: string
  channel: string
  template_code: string
  lead_minutes: number
  quiet_from: string
  quiet_to: string
  is_active: boolean
  last_run_at?: string
  last_queued: number
  last_error?: string
  /** False when the rule's channel has no working provider behind it. */
  channel_ready: boolean
  channel_reason?: string
}

export interface TriggerEvent {
  event: string
  description: string
  /** The fact names a condition may test, comma separated. */
  facts: string
  swept: boolean
}

export interface MessageTemplate {
  code: string
  channel: string
  subject: string
  body: string
  dlt_template_id: string
  is_active: boolean
  built_in: boolean
  editable: boolean
}

export interface LogRow {
  id: string
  channel: string
  recipient: string
  subject?: string
  status: string
  provider?: string
  template_code?: string
  source_kind?: string
  rule?: string
  occurrence_key?: string
  error?: string
  attempts: number
  queued_at: string
  sent_at?: string
  /** Set when the message is held until the end of a quiet period. */
  send_after?: string
}

export interface SweepResult {
  rule_id: string
  rule: string
  event: string
  occurrences: number
  queued: number
  already_sent: number
  error?: string
}

interface Listed<T> {
  items: T[]
}

export function useProviders() {
  return useQuery({
    queryKey: ['messaging', 'providers'],
    queryFn: () => api.get<Listed<Provider>>(`${BASE}/providers`),
  })
}

export function useMessageLog(query = '') {
  return useQuery({
    queryKey: ['messaging', 'log', query],
    queryFn: () => api.get<Listed<LogRow>>(`${BASE}/log${query}`),
  })
}

export function useTemplates() {
  return useQuery({
    queryKey: ['messaging', 'templates'],
    queryFn: () => api.get<Listed<MessageTemplate>>(`${BASE}/templates`),
  })
}

export function useTriggers() {
  return useQuery({
    queryKey: ['messaging', 'triggers'],
    queryFn: () =>
      api.get<{
        items: TriggerRule[]
        events: TriggerEvent[]
        audiences: string[]
        channels: string[]
      }>(`${BASE}/triggers`),
  })
}

/**
 * A write that refreshes what it changed.
 *
 * Every messaging write moves something another panel on the same screen
 * displays — saving the SMTP host changes the queue counts, running the sweep
 * changes the log. Invalidating the whole 'messaging' key rather than one
 * entry is deliberate: the alternative is a screen that saves and then shows
 * the previous state until the operator reloads.
 */
function useMessagingWrite<TResult, TBody>(
  fn: (body: TBody) => Promise<TResult>,
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messaging'] }),
  })
}

export function useSaveProvider(channel: string) {
  return useMessagingWrite<{ items: Provider[] }, {
    enabled: boolean
    settings: Record<string, unknown>
    secret?: string
  }>((body) => api.put(`${BASE}/providers/${channel}`, body))
}

export function useForgetProvider(channel: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.del<{ items: Provider[] }>(`${BASE}/providers/${channel}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messaging'] }),
  })
}

export function useTestProvider(channel: string) {
  return useMessagingWrite<{ ok: boolean; message: string }, { to: string }>(
    (body) => api.post(`${BASE}/providers/${channel}/test`, body),
  )
}

export function useSaveTemplate() {
  return useMessagingWrite<{ ok: boolean }, MessageTemplate>((body) =>
    api.put(`${BASE}/templates`, {
      code: body.code,
      channel: body.channel,
      subject: body.subject,
      body: body.body,
      dlt_template_id: body.dlt_template_id,
      is_active: body.is_active,
    }),
  )
}

export function useSaveRule() {
  return useMessagingWrite<{ id: string }, Partial<TriggerRule>>((body) =>
    api.post(`${BASE}/triggers`, body),
  )
}

export function useDeleteRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`${BASE}/triggers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messaging'] }),
  })
}

export function useRunSweep() {
  return useMessagingWrite<
    { results: SweepResult[]; sent?: number; failed?: number },
    { rule_id?: string; dispatch: boolean }
  >((body) => api.post(`${BASE}/triggers/run`, body))
}

export function useDispatch() {
  return useMessagingWrite<{ sent: number; failed: number }, { limit?: number }>(
    (body) => api.post(`${BASE}/dispatch`, body),
  )
}

/** The tone a delivery status should be read in. */
export function statusTone(status: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'sent' || status === 'delivered') return 'success'
  if (status === 'failed' || status === 'bounced') return 'danger'
  if (status === 'queued') return 'warning'
  return 'neutral'
}

/** "14:30 on 18 Aug", or nothing. Times are already India-local from the API. */
export function when(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/* ── MESSAGE CREDITS ────────────────────────────────────────────────────────
   What is left to spend on the channels that cost money, and where it went.
   `metered` is not the same fact as a zero balance: a school nobody has
   metered sends freely, and the screen has to be able to say so rather than
   showing "0 left" beside a channel that is working perfectly. */

export interface CreditBalance {
  channel: string
  metered: boolean
  balance: number
  low_water: number
  low: boolean
  empty: boolean
}

export interface CreditEntry {
  id: string
  delta: number
  reason: string
  note?: string
  actor?: string
  created_at: string
}

export interface SmsPreset {
  id: string
  label: string
  note: string
  endpoint: string
  method: string
  encoding: string
  params: Record<string, string>
  needs: string[]
}

export function useCredits() {
  return useQuery({
    queryKey: ['messaging', 'credits'],
    queryFn: () => api.get<Listed<CreditBalance>>(`${BASE}/credits`),
  })
}

export function useCreditEntries(channel: string) {
  return useQuery({
    queryKey: ['messaging', 'credits', channel, 'entries'],
    queryFn: () => api.get<Listed<CreditEntry>>(`${BASE}/credits/${channel}/entries`),
  })
}

export function useTopUpCredits(channel: string) {
  return useMessagingWrite<{ channel: string; balance: number }, {
    delta?: number
    low_water?: number
    note?: string
    reason?: string
  }>((body) => api.post(`${BASE}/credits/${channel}`, body))
}

/* Fetched rather than bundled: the shapes live with the provider that consumes
   them, so a vendor changing its endpoint is a server deploy and not a client
   rebuild. */
export function useSmsPresets() {
  return useQuery({
    queryKey: ['messaging', 'sms-presets'],
    queryFn: () => api.get<Listed<SmsPreset>>(`${BASE}/sms-presets`),
    staleTime: 60 * 60 * 1000,
  })
}

/* Back to unmetered, which no amount of topping down can reach: a balance of
   zero is a stopped channel, not an absent meter. */
export function useStopMetering(channel: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.del<{ channel: string; metered: boolean }>(`${BASE}/credits/${channel}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messaging'] }),
  })
}
