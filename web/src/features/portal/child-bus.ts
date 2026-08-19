import { useEffect, useState } from 'react'

/* What both parent bus screens agree on.

   The map and the driver-call button are two catalogue entries and two
   screens, but they read the same row from the same endpoint and they must
   never disagree about what a state means: a parent told "no run in progress"
   on one screen and shown a live call button on the other has been given two
   answers to one question, and will believe the wrong one. So the state
   sentences and the poll live here, once. */

export interface ChildBusRow {
  student_id: string
  student_name: string
  route: string
  registration_no: string
  direction?: 'pickup' | 'drop'
  driver?: string
  /** Populated only while a run is open. Absence is a rule, not a gap. */
  driver_phone?: string
  stop?: string
  scheduled_at?: string
  arrived_at?: string
  latitude?: number
  longitude?: number
  stop_latitude?: number
  stop_longitude?: number
  age_seconds?: number
  metres_away?: number
  state: BusState
  refresh_seconds: number
  proximity_m: number
  watchable: boolean
}

export type BusState =
  | 'not_published'
  | 'not_running'
  | 'no_signal'
  | 'stale'
  | 'running'
  | 'arrived'

export interface ChildBusFeed {
  items: ChildBusRow[]
  stale_after_seconds: number
  parents_may_watch: boolean
}

export const STATE_LABEL: Record<BusState, string> = {
  not_published: 'Tracking is off',
  not_running: 'Not running',
  no_signal: 'No signal',
  stale: 'Signal lost',
  running: 'On the way',
  arrived: 'Arrived',
}

export const STATE_TONE: Record<BusState, 'success' | 'danger' | 'warning' | 'neutral'> = {
  not_published: 'neutral',
  not_running: 'neutral',
  no_signal: 'warning',
  stale: 'danger',
  running: 'success',
  arrived: 'success',
}

/* Every state gets its own sentence, because the six of them are six
   different facts and only two of them are anything wrong. Collapsing
   "the school has not switched this on", "today's run has not started" and
   "the bus's phone has gone quiet" into one grey empty state is how a parent
   ends up ringing the office about a feature that is working exactly as the
   school configured it. */
export function stateSentence(row: ChildBusRow, staleAfter: number): string {
  const bus = `${row.route}${row.registration_no ? ` (${row.registration_no})` : ''}`
  switch (row.state) {
    case 'not_published':
      return `Your school has not switched on live bus tracking for families. Nothing is being hidden from you by accident — no position is published to parents at all, and the transport office is the place to ask for it. Everything else on this page about ${bus} is still true.`
    case 'not_running':
      return `No run is in progress on ${bus} right now. That is an answer, not a fault: a bus appears here while the driver has a trip open, and outside those hours the phone deliberately reports nothing.`
    case 'no_signal':
      return `The run on ${bus} is open, but the driver's phone has not sent a position yet. It usually means the phone is still finding satellites, or that location permission on it is switched off. There is nothing for you to do; the office can see the same thing.`
    case 'stale':
      return `${bus} is on a run, but its last position is more than ${minutes(staleAfter)} old. The map below is showing where it was, not where it is. A tunnel or a dead patch of network does this; so does a flat phone.`
    case 'arrived':
      return `${bus} reached ${row.stop ?? 'the stop'} at ${row.arrived_at ?? 'an unrecorded time'}. Tracking for this stop is finished for this run.`
    case 'running':
      return row.metres_away != null
        ? `${bus} is on the way to ${row.stop ?? 'the stop'}.`
        : `${bus} is on the way. ${row.stop ? `${row.stop} has no coordinates recorded, so no distance can be worked out.` : ''}`
  }
}

/** A state where a position is worth plotting at all. */
export function hasPlot(row: ChildBusRow): boolean {
  return (
    (row.state === 'running' || row.state === 'stale') &&
    row.latitude != null &&
    row.longitude != null
  )
}

export function minutes(secs: number): string {
  if (secs < 90) return `${Math.max(1, Math.round(secs))} seconds`
  return `${Math.round(secs / 60)} minutes`
}

export function ageText(secs?: number): string {
  if (secs == null) return 'never'
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`
  const h = Math.floor(secs / 3600)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

/* Is this tab in front of somebody?

   A parent leaves this screen open on a phone and walks away. Polling a
   hidden tab spends their battery and the school's server on a picture nobody
   is looking at, so the poll stops with the tab and resumes with it. */
export function useTabVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  )
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

/* Poll on the fastest interval any row asked for.

   refresh_seconds is per row because a family can set it per child, and the
   server is the one that decides the bounds. One timer at the minimum is the
   honest reading of "poll on the row's own refresh_seconds" for a single
   request that carries every row: refetching per row would be one request per
   child for identical data. */
export function usePoll(rows: ChildBusRow[], enabled: boolean, refetch: () => void) {
  const live = rows.some(
    (r) => r.state === 'running' || r.state === 'stale' || r.state === 'no_signal',
  )
  const every = rows.length ? Math.max(10, Math.min(...rows.map((r) => r.refresh_seconds || 20))) : 0
  useEffect(() => {
    // Nothing is moving: a parked fleet does not need a request every twenty
    // seconds, and the next run will be picked up when the tab is looked at.
    if (!enabled || !live || !every) return
    const t = setInterval(refetch, every * 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, live, every])
  return every
}
