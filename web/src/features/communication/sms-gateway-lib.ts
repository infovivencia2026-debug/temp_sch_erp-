import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Types and hooks for the phone SMS gateway.
 *
 * Every path is relative to /api/v1/sms-gateway, which is where mountSMSGateway
 * puts them — the top level of the authenticated group, not under /admin,
 * because the wire contract in docs/SMS_GATEWAY_CONTRACT.md fixes the paths and
 * the Android half is built against them.
 *
 * Written once here so a field renamed in internal/api/sms_gateway.go fails to
 * compile in one place rather than rendering as `undefined` on a screen whose
 * whole job is telling a school whether its messages are going out.
 */

const BASE = '/api/v1/sms-gateway'

/**
 * How healthy one handset is, as the server judged it.
 *
 * The judgement is deliberately not made here. "Stale" is a comparison between
 * a heartbeat and a window, and a client that computed it would be a second
 * opinion — with a different clock, on a laptop whose time may be wrong, about
 * the one question this screen exists to answer.
 */
export type DeviceHealth = 'live' | 'stale' | 'paused' | 'never'

export interface GatewayDevice {
  id: string
  name: string
  android_version?: string
  sim_operator?: string
  app_version?: string
  paired_at: string
  last_seen_at?: string
  /** Already rendered by the server: "40 minutes", "3 hours". */
  silent_for?: string
  health: DeviceHealth
  battery_pct?: number
  charging?: boolean
  signal_dbm?: number
  sim_ready?: boolean
  paused: boolean
  poll_seconds: number
  per_minute_cap: number
  sent_today: number
  failed_today: number
  parts_today: number
}

export interface GatewayFailure {
  message_id: string
  device?: string
  at: string
  reason: string
  state: string
}

export interface GatewayOverview {
  /** Whether this school has actually chosen the phone gateway for SMS. */
  selected: boolean
  /** The provider's own answer — the sentence the dispatcher would refuse with. */
  configured: boolean
  reason?: string
  devices: GatewayDevice[]
  failures: GatewayFailure[]
  waiting: number
  in_flight: number
  sent_today: number
  failed_today: number
  parts_today: number
  /** The compliance sentence, served rather than hard-coded in this client. */
  advisory: string
}

export interface PairCode {
  pair_code: string
  expires_at: string
  valid_minutes: number
}

export function useSMSGateway() {
  return useQuery({
    queryKey: ['sms-gateway'],
    queryFn: () => api.get<GatewayOverview>(BASE),
    /* A dead gateway is the thing this screen is for, so it must not need a
       reload to notice one. Thirty seconds against a twenty-second heartbeat
       means an administrator watching the screen sees a phone go quiet within
       about a minute of it happening. */
    refetchInterval: 30_000,
  })
}

function useGatewayWrite<TResult, TBody>(fn: (body: TBody) => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sms-gateway'] }),
  })
}

export function usePairPhone() {
  return useGatewayWrite<PairCode, void>(() => api.post(`${BASE}/pair`, {}))
}

export function useUpdateDevice(id: string) {
  return useGatewayWrite<
    { ok: boolean },
    { name?: string; paused?: boolean; poll_seconds?: number; per_minute_cap?: number }
  >((body) => api.put(`${BASE}/devices/${id}`, body))
}

export function useRevokeDevice(id: string) {
  return useGatewayWrite<{ ok: boolean }, { reason: string }>((body) =>
    api.post(`${BASE}/devices/${id}/revoke`, body),
  )
}

/**
 * The tone a handset's health should be read in.
 *
 * Stale is `danger`, not `warning`, and that is the whole argument of this
 * screen. A gateway that has silently died is worse than no gateway, because
 * the school believes messages are going out — so the phone that stopped
 * reporting has to look like a fault, not like a note.
 */
export function healthTone(h: DeviceHealth): 'success' | 'danger' | 'warning' | 'neutral' {
  if (h === 'live') return 'success'
  if (h === 'stale') return 'danger'
  if (h === 'never') return 'warning'
  return 'neutral'
}

export function healthLabel(d: GatewayDevice): string {
  switch (d.health) {
    case 'live':
      return 'Sending'
    case 'stale':
      return `Silent for ${d.silent_for ?? 'a while'}`
    case 'never':
      return 'Never reported in'
    default:
      return 'Paused'
  }
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

/**
 * Signal strength as bars rather than dBm.
 *
 * -91 dBm means nothing to an office administrator and everything to the
 * person who has to decide whether to move the phone to a windowsill. The
 * thresholds are the ordinary GSM ones.
 */
export function signalWords(dbm?: number): string {
  if (dbm === undefined || dbm === null) return 'unknown'
  if (dbm >= -70) return 'strong'
  if (dbm >= -85) return 'good'
  if (dbm >= -100) return 'weak'
  return 'very weak'
}
