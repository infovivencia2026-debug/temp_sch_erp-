/* RUPEES TYPED BY A PERSON, PAISE ON THE WIRE.

   A clerk typed "13,000" into the fee counter and ₹13 was collected: the
   amount went through parseFloat, which reads up to the first character it
   does not understand and stops, so the comma ended the number at 13. Indian
   amounts are written with commas -- 13,000 and 1,25,000 -- by everyone who
   has ever written one, and a form that punishes that with a receipt for
   thirteen rupees is a form that loses money.

   One parser, used everywhere an amount is read from a box. It accepts what
   people type: commas in any grouping, a rupee sign, spaces, a leading
   "Rs.". It refuses what is not a number at all -- "13abc" is not ₹13 -- so
   a typo blocks the save instead of collecting the wrong amount. */

/** The rupees in a typed string, or NaN when the string is not an amount. */
export function parseRupees(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN
  if (raw === null || raw === undefined) return NaN
  const s = String(raw)
    .trim()
    .replace(/^(rs\.?|inr|₹)\s*/i, '')
    .replace(/[,\s]/g, '')
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** Paise for a typed rupee amount; 0 for an empty or unreadable box, so a
 *  "must be more than zero" check is what stops the save. Rounded, never
 *  floored: ₹1,234.56 must not become ₹1,234.55. */
export function rupeesToPaise(raw: string | number | null | undefined): number {
  const n = parseRupees(raw)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/** True when the box holds something that is not an amount (letters, two
 *  dots): the form should say so rather than treat it as zero. */
export function isBadAmount(raw: string): boolean {
  return raw.trim() !== '' && Number.isNaN(parseRupees(raw))
}
