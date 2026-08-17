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

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
