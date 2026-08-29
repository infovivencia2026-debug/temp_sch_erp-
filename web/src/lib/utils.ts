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

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
