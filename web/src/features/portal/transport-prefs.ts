import { api } from '@/lib/api'
import type { ChildBusRow } from './child-bus'

/* The two settings a family owns, and the rules both screens obey.

   They are two catalogue entries and two screens, but one endpoint and one
   row: POST /api/v1/me/child-bus/prefs writes refresh_seconds and
   proximity_m together. A screen that sent only its own field would silently
   reset the other one to the server's default -- a parent who set a 300 m
   alert, then changed the map speed, would find their alert back at 800 m
   with nothing on either screen having said so. So both values travel on
   every save, and the screen that does not own a value carries the one the
   feed just reported. That rule lives here because it is the kind of thing
   that gets forgotten in the second screen. */

export const REFRESH_MIN = 10
export const REFRESH_MAX = 300
export const PROXIMITY_MIN = 100
export const PROXIMITY_MAX = 5000

/* Rejected with the bound named, never clamped.

   The server refuses outside these ranges and says so; the form refuses in
   the same words rather than quietly rounding, because a setting that becomes
   a different setting on save is what a person reports as the app being
   broken -- and they are right to. */
export function refreshError(seconds: number): string | null {
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds))
    return 'Enter a whole number of seconds.'
  if (seconds < REFRESH_MIN)
    return `${seconds} s is faster than the school allows. The quickest is ${REFRESH_MIN} seconds.`
  if (seconds > REFRESH_MAX)
    return `${seconds} s is slower than the school allows. The slowest is ${REFRESH_MAX} seconds (5 minutes).`
  return null
}

export function proximityError(metres: number): string | null {
  if (!Number.isFinite(metres) || !Number.isInteger(metres))
    return 'Enter a whole number of metres.'
  if (metres < PROXIMITY_MIN)
    return `${metres} m is closer than the alert can be set. The nearest is ${PROXIMITY_MIN} m — by then the bus is at the stop.`
  if (metres > PROXIMITY_MAX)
    return `${metres} m is further than the alert can be set. The furthest is ${PROXIMITY_MAX} m (5 km).`
  return null
}

/* Metres are not how anyone judges "should I go down yet".

   A walking pace of 80 m a minute is the ordinary adult one, so 800 m reads
   as the ten minutes it actually is. The number is the setting; this sentence
   is what makes it choosable. */
export function walkText(metres: number): string {
  const mins = Math.round(metres / 80)
  if (metres < 200) return 'about a minute or two on foot — practically at the stop'
  if (mins <= 1) return 'about a minute on foot'
  if (metres >= 1000)
    return `${(metres / 1000).toFixed(metres % 1000 === 0 ? 0 : 1)} km — roughly a ${mins}-minute walk`
  return `roughly a ${mins}-minute walk`
}

/* What a refresh rate costs, in the currency a parent pays it in.

   The phone drawing the map is the parent's, and a ten-second poll on a
   school run is twenty minutes of screen and radio. Saying "battery" plainly
   is the difference between an informed choice and a flat handset at noon. */
export function batteryText(seconds: number): string {
  if (seconds <= 15)
    return 'The freshest picture available, and the most battery: the map fetches several times a minute for the whole run.'
  if (seconds <= 45)
    return 'A good balance — the bus moves a street or so between updates, and the drain is modest.'
  if (seconds <= 120)
    return 'Easy on the battery. The bus may be a few hundred metres past where the map shows it.'
  return 'Barely touches the battery, but the map is a rough guide rather than a live position.'
}

export interface WatchPrefBody {
  /** Omitted means every child of mine. */
  student_id?: string
  refresh_seconds: number
  proximity_m: number
  notify_approach?: boolean
}

export function savePrefs(body: WatchPrefBody) {
  return api.post<{ saved: boolean }>('/api/v1/me/child-bus/prefs', body)
}

/** The "all my children" sentinel, kept out of the URL-ish space of real ids. */
export const ALL_CHILDREN = ''

/* Should the family be asked which child this applies to?

   A parent with one child on one bus has no distinction to make, and a
   dropdown with a single entry is a question that teaches them the app is
   more complicated than it is. A parent with three children on two routes has
   a real choice and must be given it. So the control appears only when there
   is more than one child to tell apart. */
export function needsChildChoice(rows: ChildBusRow[]): boolean {
  return rows.length > 1
}

export function childOptions(rows: ChildBusRow[]) {
  return [
    { value: ALL_CHILDREN, label: 'All my children' },
    ...rows.map((r) => ({
      value: r.student_id,
      label: `${r.student_name} — ${r.route}`,
    })),
  ]
}

/* What is in force for the chosen target, as the server just reported it.

   With "all my children" selected there is no single row to read, and the
   rows can legitimately disagree -- a per-child setting overrides the
   all-children one server-side. Rather than pick one silently, the caller is
   told whether the rows agree, so a mixed set can say so instead of
   presenting one child's number as the family's. */
export function currentFor(
  rows: ChildBusRow[],
  studentID: string,
): { refresh: number; proximity: number; mixed: boolean } {
  const scope = studentID ? rows.filter((r) => r.student_id === studentID) : rows
  if (scope.length === 0) return { refresh: 20, proximity: 800, mixed: false }
  const refresh = scope[0].refresh_seconds || 20
  const proximity = scope[0].proximity_m || 800
  const mixed = scope.some(
    (r) => (r.refresh_seconds || 20) !== refresh || (r.proximity_m || 800) !== proximity,
  )
  return { refresh, proximity, mixed }
}
