/* The UPI payment intent, built the way UPI apps read it.

   A `upi://pay?...` URI is what a UPI app decodes off a QR: the payee address,
   a payee name, the amount and a note. It looks like a query string and is
   not one. The apps parse it as an RFC 3986 URI, so a space must be %20 and
   never "+" — URLSearchParams writes "+" and PhonePe, BHIM and Paytm then show
   "Fee+Payment" to the parent, literally. The address is left as typed: the
   specification's own examples write name@bank, and at least one app refuses
   %40 in pa.

   The intent and the QR are now built by the server (internal/fees/upi.go,
   GET /api/v1/fees/upi-code); this file keeps only what the forms need:
   the address check and the note cleaner. */

/** The NPCI virtual payment address: handle@psp. Same shape as the CHECK
    constraint on institutions.upi_vpa and fees.ValidVPA. */
export const VPA_RE = /^[A-Za-z0-9._-]{3,}@[A-Za-z0-9]{2,}$/

export function isValidVpa(s: string): boolean {
  return VPA_RE.test(s.trim())
}

/* Field limits from the NPCI linking specification. An app given more
   truncates silently or refuses the code, and neither is something a parent
   can diagnose at a counter. */
const NOTE_MAX = 50

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

