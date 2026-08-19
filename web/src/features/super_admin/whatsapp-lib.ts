import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Types and hooks for WhatsApp Business Cloud, and for the recipient guard.
 *
 * Two features, one file, because one screen shows both — and it shows both
 * because a school connecting its WhatsApp account is exactly the school that
 * must not discover the guard afterwards.
 *
 * Every path matches mountWhatsApp in internal/api/whatsapp.go. The guard's
 * routes sit under /messaging rather than /whatsapp on purpose: it governs
 * every channel, and hiding it behind a channel's path would invite the next
 * channel to grow its own.
 */

const BASE = '/api/v1/admin'

/** The school's WhatsApp Business Cloud account, as the server reports it. */
export interface WhatsAppSettings {
  phone_number_id: string
  waba_id: string
  business_number: string
  api_version: string
  default_language: string
  /** Off, and it should stay off. See the screen's own note. */
  allow_free_text: boolean
  enabled: boolean
  /** A token is stored. The token itself is never returned to the browser. */
  has_token: boolean
  configured: boolean
  reason?: string
  endpoint: string
  /** cloud = Meta's own API, gateway = a reseller, none = nothing stored. */
  mode: 'cloud' | 'gateway' | 'none'
  last_ok_at?: string
  last_error?: string
  queued: number
  sent_today: number
  failed_today: number
  suppressed_today: number
}

/** One of this product's templates, and the approved template behind it. */
export interface WhatsAppTemplate {
  code: string
  body: string
  /** The {{names}} the body uses, in the order they appear. */
  placeholders: string[]
  wa_template_name: string
  wa_language: string
  /** Ordered: position i is the approved template's body parameter {{i+1}}. */
  wa_params: string[]
  is_active: boolean
  built_in: boolean
  /** False means this template cannot be sent on WhatsApp at all. */
  mapped: boolean
}

export interface WhatsAppLogRow {
  id: string
  recipient: string
  subject?: string
  status: string
  provider?: string
  template_code?: string
  error?: string
  attempts: number
  queued_at: string
  sent_at?: string
}

export interface AllowedRecipient {
  id: string
  kind: 'phone' | 'email'
  raw: string
  normalised: string
  label: string
  created_at: string
}

export interface RecipientPolicy {
  mode: 'allowlist' | 'everyone'
  note: string
  items: AllowedRecipient[]
  /** False when nothing can currently leave the building. */
  sending: boolean
  /** The sentence the banner shows. Written by the server so the screen and
   *  the dispatcher can never disagree about what is happening. */
  explanation: string
  updated_at?: string
}

export function useWhatsAppSettings() {
  return useQuery({
    queryKey: ['whatsapp', 'settings'],
    queryFn: () => api.get<WhatsAppSettings>(`${BASE}/whatsapp/settings`),
  })
}

export function useWhatsAppTemplates() {
  return useQuery({
    queryKey: ['whatsapp', 'templates'],
    queryFn: () => api.get<{ items: WhatsAppTemplate[] }>(`${BASE}/whatsapp/templates`),
  })
}

export function useWhatsAppLog() {
  return useQuery({
    queryKey: ['whatsapp', 'log'],
    queryFn: () => api.get<{ items: WhatsAppLogRow[] }>(`${BASE}/whatsapp/log`),
  })
}

export function useRecipientPolicy() {
  return useQuery({
    queryKey: ['whatsapp', 'recipients'],
    queryFn: () => api.get<RecipientPolicy>(`${BASE}/messaging/recipients`),
  })
}

/**
 * A write that refreshes everything on the screen.
 *
 * Saving the account changes the queue counts; adding an allowlist entry
 * changes the banner. Invalidating the whole 'whatsapp' key rather than one
 * entry is deliberate — the alternative is a screen that says "suppressed"
 * beside a list that now permits the number.
 */
function useWhatsAppWrite<TResult, TBody>(fn: (body: TBody) => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp'] }),
  })
}

export interface WhatsAppSaveBody {
  phone_number_id: string
  waba_id: string
  business_number: string
  api_version: string
  default_language: string
  allow_free_text: boolean
  enabled: boolean
  /** Omitted entirely when untouched, which keeps the stored token. */
  token?: string
}

export function useSaveWhatsApp() {
  return useWhatsAppWrite<WhatsAppSettings, WhatsAppSaveBody>((body) =>
    api.put(`${BASE}/whatsapp/settings`, body),
  )
}

export function useForgetWhatsApp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.del<WhatsAppSettings>(`${BASE}/whatsapp/settings`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp'] }),
  })
}

export function useTestWhatsApp() {
  return useWhatsAppWrite<
    { ok: boolean; message: string; message_id: string },
    { to: string; template_code: string }
  >((body) => api.post(`${BASE}/whatsapp/test`, body))
}

export function useSaveWhatsAppTemplate() {
  return useWhatsAppWrite<
    { items: WhatsAppTemplate[] },
    {
      code: string
      body: string
      wa_template_name: string
      wa_language: string
      wa_params: string[]
      is_active: boolean
    }
  >((body) => api.put(`${BASE}/whatsapp/templates`, body))
}

export function useSetRecipientMode() {
  return useWhatsAppWrite<RecipientPolicy, { mode: string; note: string; confirm: string }>(
    (body) => api.put(`${BASE}/messaging/recipients/mode`, body),
  )
}

export function useAddRecipient() {
  return useWhatsAppWrite<RecipientPolicy, { value: string; label: string }>((body) =>
    api.post(`${BASE}/messaging/recipients`, body),
  )
}

export function useRemoveRecipient() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.del<RecipientPolicy>(`${BASE}/messaging/recipients/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp'] }),
  })
}

/** The tone a delivery status should be read in. */
export function waStatusTone(status: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'sent' || status === 'delivered' || status === 'read') return 'success'
  if (status === 'failed' || status === 'bounced') return 'danger'
  // Suppressed is a warning, not a failure: nothing broke, and the school
  // chose it. Reading it as an error sends somebody looking for a fault.
  if (status === 'queued' || status === 'suppressed') return 'warning'
  return 'neutral'
}

/** "14:30 on 18 Aug", or nothing. Times are already India-local from the API. */
export function waWhen(iso?: string): string {
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

/**
 * A recipient, shown as its last four digits.
 *
 * A parent's phone number has no business being readable over an
 * administrator's shoulder, and the log is a screen somebody leaves open.
 * The server redacts its own log lines the same way.
 */
export function waRedact(v: string): string {
  if (!v) return '—'
  if (v.includes('@')) {
    const [name, domain] = v.split('@')
    return `${name.slice(0, 2)}…@${domain}`
  }
  return `…${v.slice(-4)}`
}
