/* The UPI payment intent, built the way UPI apps read it.

   A `upi://pay?...` URI is what a UPI app decodes off a QR: the payee address,
   a payee name, the amount and a note. It looks like a query string and is
   not one. The apps parse it as an RFC 3986 URI, so a space must be %20 and
   never "+" — URLSearchParams writes "+" and PhonePe, BHIM and Paytm then show
   "Fee+Payment" to the parent, literally. The address is left as typed: the
   specification's own examples write name@bank, and at least one app refuses
   %40 in pa.

   internal/fees/upi.go is the same rule in Go, for anything the server draws.
   The two tests pin one shared example so they cannot drift apart. */

/** The NPCI virtual payment address: handle@psp. Same shape as the CHECK
    constraint on institutions.upi_vpa and fees.ValidVPA. */
export const VPA_RE = /^[A-Za-z0-9._-]{3,}@[A-Za-z0-9]{2,}$/

export function isValidVpa(s: string): boolean {
  return VPA_RE.test(s.trim())
}

/* Field limits from the NPCI linking specification. An app given more
   truncates silently or refuses the code, and neither is something a parent
   can diagnose at a counter. */
const PAYEE_NAME_MAX = 99
const NOTE_MAX = 50

export interface UpiIntent {
  vpa: string
  payeeName: string
  amountPaise: number
  /** What the payer's app shows and what tends to reach the bank narration.
      Put the admission number in it. */
  note?: string
}

/** Paise as the plain decimal an intent wants: "11833.00", no grouping. */
export function upiAmount(paise: number): string {
  const p = Math.round(Math.abs(paise))
  const s = `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`
  return paise < 0 ? `-${s}` : s
}

/** A note from its parts: joined with single spaces, anything a UPI app might
    choke on dropped, clipped to the 50 the specification allows. Characters
    are counted, not bytes, so a Telugu name is not cut through a code point. */
export function upiNote(...parts: (string | number | null | undefined)[]): string {
  const joined = parts
    .filter((p): p is string | number => p !== undefined && p !== null && `${p}`.trim() !== '')
    .map((p) => `${p}`.trim())
    .join(' ')
    // Drop ASCII punctuation other than the few marks an admission or
    // invoice number is written with (dot, slash, hyphen). A blacklist rather
    // than \p{L}, so Telugu survives without needing a Unicode-aware regex
    // the build target may not have.
    .replace(/[!"#$%&'()*+,:;<=>?@[\\\]^_`{|}~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(joined).slice(0, NOTE_MAX).join('').trim()
}

export function buildUpiIntent(i: UpiIntent): string {
  const parts = [
    `pa=${i.vpa.trim()}`,
    `pn=${encodeURIComponent(clip(i.payeeName.trim(), PAYEE_NAME_MAX))}`,
    `am=${upiAmount(i.amountPaise)}`,
    'cu=INR',
  ]
  const note = clip((i.note ?? '').trim(), NOTE_MAX)
  if (note) parts.push(`tn=${encodeURIComponent(note)}`)
  return `upi://pay?${parts.join('&')}`
}

function clip(s: string, n: number): string {
  const r = Array.from(s)
  return r.length <= n ? s : r.slice(0, n).join('').trim()
}
