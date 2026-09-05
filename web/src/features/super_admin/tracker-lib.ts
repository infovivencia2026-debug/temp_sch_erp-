import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Types and hooks for tracker pairing and the school's tracking policy.
 *
 * Written once, against internal/api/bus_tracker_admin.go and the pair handler
 * in internal/api/bus_tracker.go, so a field renamed on the Go side fails to
 * compile here rather than rendering as `undefined` on the screen that is
 * supposed to say which buses are dark.
 *
 * The list is driven from vehicles, not from trackers, and every optional
 * field below is optional for that reason: an unpaired bus is a row with no
 * tracker half at all, and it is the row this screen exists to show.
 */

const BASE = '/api/v1/transport'

export interface TrackerRow {
  vehicle_id: string
  registration_no: string
  vehicle_model?: string
  vehicle_status: string
  route?: string
  driver?: string

  tracker_id?: string
  tracker?: string
  device_model?: string
  app_version?: string

  /** India-local, already formatted by the server as YYYY-MM-DDTHH:MM. */
  last_seen_at?: string
  /** Seconds since the handset last said anything; absent if it never has. */
  quiet_seconds?: number
  battery_pct?: number
  charging?: boolean
  /** False is the dangerous one: online, charged, and giving no fix. */
  location_ok?: boolean

  ping_seconds?: number
  paused?: boolean
  revoked_at?: string
  revoked_reason?: string

  /** Has a live, unrevoked tracker. A revoked row is paired:false with history. */
  paired: boolean
}

export interface TrackerList {
  items: TrackerRow[]
  /** Counted by the server so this screen and the map cannot disagree. */
  unpaired: number
}

export interface TrackingPolicy {
  default_geofence_m: number
  speed_limit_kmph: number
  speeding_hold_secs: number
  trip_timeout_mins: number
  ping_seconds: number
  parents_may_watch: boolean
  watch_window_mins: number
  retain_days: number
  /* The school gate. Absent until the office picks the point on the map;
     once set, the server pins the school as the last stop of every route. */
  school_latitude?: number
  school_longitude?: number
  school_geofence_m?: number
}

export interface TrackingPolicyResponse {
  policy: TrackingPolicy
  /** What switching parents_may_watch on publishes, served rather than typed
      here so the sentence the school reads is the one the repository can be
      audited against. */
  parents_may_watch_notice: string
}

export interface PairCode {
  pair_code: string
  /** RFC 3339 with offset — a real instant, which is what the countdown needs. */
  expires_at: string
  valid_minutes: number
  /** The registration the code will bind the phone to, echoed by the server. */
  vehicle: string
}

export function useTrackers() {
  return useQuery({
    queryKey: ['transport-trackers'],
    queryFn: () => api.get<TrackerList>(`${BASE}/trackers`),
    /* A phone that has gone quiet is the thing this screen reports, so it must
       not need a reload to notice one. Thirty seconds against a fifteen-second
       ping means an office watching the screen sees a bus drop off within
       about a minute. */
    refetchInterval: 30_000,
  })
}

export function useTrackingPolicy() {
  return useQuery({
    queryKey: ['transport-tracking-policy'],
    queryFn: () => api.get<TrackingPolicyResponse>(`${BASE}/tracking-policy`),
  })
}

function useTrackerWrite<TResult, TBody>(fn: (body: TBody) => Promise<TResult>, key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: [key] }),
  })
}

export function usePairTracker() {
  return useTrackerWrite<PairCode, { vehicle_id?: string }>(
    (body) => api.post(`${BASE}/trackers/pair`, body),
    'transport-trackers',
  )
}

export function useUpdateTracker(id: string) {
  return useTrackerWrite<
    { saved: boolean },
    { name?: string; ping_seconds?: number; paused?: boolean }
  >((body) => api.put(`${BASE}/trackers/${id}`, body), 'transport-trackers')
}

export function useRevokeTracker(id: string) {
  // The reason is required by the server and by the schema's CHECK. It is not
  // defaulted here: "revoked" on its own is the note that gets the handset
  // re-paired by the next person on the desk.
  return useTrackerWrite<{ revoked: boolean }, { reason: string }>(
    (body) => api.post(`${BASE}/trackers/${id}/revoke`, body),
    'transport-trackers',
  )
}

export function useSaveTrackingPolicy() {
  return useTrackerWrite<TrackingPolicyResponse, TrackingPolicy>(
    (body) => api.put(`${BASE}/tracking-policy`, body),
    'transport-tracking-policy',
  )
}

/**
 * How a paired handset is doing, judged from what the server sent.
 *
 * `quiet_seconds` is the server's own subtraction against the server's clock;
 * this only bands it. Computing the elapsed time in the browser would be a
 * second opinion from a laptop whose clock may be wrong, about the one
 * question this screen answers.
 */
export type TrackerHealth = 'unpaired' | 'revoked' | 'paused' | 'never' | 'no-fix' | 'quiet' | 'live'

/** Three minutes of silence at a 15-second ping is twelve missed pings. */
const QUIET_AFTER_SECONDS = 180

export function trackerHealth(r: TrackerRow): TrackerHealth {
  if (!r.paired) return r.revoked_at ? 'revoked' : 'unpaired'
  if (r.paused) return 'paused'
  if (r.quiet_seconds === undefined || r.quiet_seconds === null) return 'never'
  if (r.quiet_seconds > QUIET_AFTER_SECONDS) return 'quiet'
  // Reporting in, and the OS is refusing to give it a position. Everything
  // looks healthy and the bus is not on the map, so it is not "live".
  if (r.location_ok === false) return 'no-fix'
  return 'live'
}

export function healthLabel(r: TrackerRow): string {
  switch (trackerHealth(r)) {
    case 'unpaired':
      return 'No phone paired'
    case 'revoked':
      return 'Unpaired'
    case 'paused':
      return 'Paused'
    case 'never':
      return 'Never reported in'
    case 'quiet':
      return `Silent for ${elapsed(r.quiet_seconds)}`
    case 'no-fix':
      return 'No location permission'
    default:
      return 'Reporting'
  }
}

export function healthTone(h: TrackerHealth): 'success' | 'danger' | 'warning' | 'neutral' {
  if (h === 'live') return 'success'
  // A bus with no phone, a phone with no fix and a phone gone quiet are all the
  // same fact to a parent at a bus stop: nothing on the map.
  if (h === 'unpaired' || h === 'quiet' || h === 'no-fix') return 'danger'
  if (h === 'never') return 'warning'
  return 'neutral'
}

/** "4 minutes", "2 hours" — coarse on purpose; nobody acts on seconds. */
export function elapsed(seconds?: number): string {
  if (seconds === undefined || seconds === null) return 'a while'
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} seconds`
  const mins = Math.round(seconds / 60)
  if (mins < 90) return `${mins} minutes`
  const hours = Math.round(mins / 60)
  if (hours < 36) return `${hours} hours`
  return `${Math.round(hours / 24)} days`
}

/** "14:30 on 18 Aug", or nothing. Times from this API are already India-local. */
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

/** Seconds left until an RFC 3339 instant, floored at zero. */
export function secondsUntil(iso: string, now: number): number {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return 0
  return Math.max(0, Math.floor((at - now) / 1000))
}

/** "9:04" — a countdown is read as a clock, not as "544 seconds". */
export function countdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
