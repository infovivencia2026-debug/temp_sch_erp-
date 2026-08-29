import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Paise, not rupees: money is stored as bigint paise throughout the schema
// (invoices.net_paise, payments.amount_paise) so no total is ever a float.
export function formatPaise(paise: number, locale = 'en-IN') {
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100)
}

export function formatDate(iso?: string | null, locale = 'en-IN') {
  if (!iso) return '—'
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(iso))
}

/* The day and the time of day.
 *
 * For the records where when-in-the-day is part of the fact: a remark typed
 * during the lesson it is about reads differently from one typed on Friday
 * evening, and somebody reading a child's file after a complaint is asking
 * exactly that.
 *
 * Not a replacement for formatDate. Most dates in a school are days — a due
 * date, a date of birth, the day a fee was taken — and putting a time on them
 * implies a precision the record does not have.
 */
export function formatDateTime(iso?: string | null, locale = 'en-IN') {
  if (!iso) return '—'
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso))
}

/* A TIME OF DAY, IN THE NOTATION THE READER USES.

   Every time in this product was printed as the raw HH:MM the API sends, so a
   period starting at half past two read "14:30". Correct, unambiguous, and not
   how anybody in an Indian school says it — a bell is at 2:30 pm and a teacher
   reading 14:30 translates before understanding it.

   Twelve-hour by default, twenty-four for a school that keeps its timetable
   that way. The preference lives in lib/appearance.ts and arrives here as an
   attribute on the root, because a plain formatting function cannot call a
   hook and this is called from a hundred render paths that are not components.

   Takes HH:MM or HH:MM:SS — the shape every endpoint in this product returns
   for a time — rather than a Date, because these are wall-clock times with no
   date attached and building a Date around one invites a timezone that is not
   in the data.
*/
export function formatTime(hhmm?: string | null): string {
  if (!hhmm) return '—'
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim())
  if (!m) return hhmm
  const h = Number(m[1])
  const min = m[2]
  if (!Number.isFinite(h) || h > 23) return hhmm

  const twentyFour =
    typeof document !== 'undefined' &&
    document.documentElement.dataset.clock === '24h'
  if (twentyFour) return `${String(h).padStart(2, '0')}:${min}`

  // 00:xx is 12 am and 12:xx is 12 pm; the modulo alone gets both wrong.
  const suffix = h < 12 ? 'am' : 'pm'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve}:${min} ${suffix}`
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
