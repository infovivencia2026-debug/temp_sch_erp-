/* Staff usernames are stored as "<10 digits>.<SCHOOLCODE>" (setup/staff.ts),
   but that form no longer signs anyone in (owner, 2026-10-26: "Block it
   fully"). Staff type their bare phone number or school email; the bare
   number still finds the stored account (login.ts extraRows). So the coded
   form is never typed, and never shown: wherever a sign-in name is handed
   out, the bare number stands in for it. */
export const CODED_USERNAME = /^(\d{10})\.[A-Z]{4}$/

export function isCodedUsername(v: string): boolean {
  return CODED_USERNAME.test(v)
}

/** The sign-in to show for a stored identifier: "9666467868.YJPS" -> "9666467868". */
export function shownSignIn(v: string | null | undefined): string {
  const s = v ?? ''
  const m = CODED_USERNAME.exec(s)
  return m ? m[1] : s
}

/** Personal mail providers (gmail and the like); login.ts refuses them as a sign-in. */
export const PERSONAL_MAIL = /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|rediffmail|rediff|protonmail|proton|zoho|zohomail|gmx|mail|yandex|inbox)\.[a-z.]+$/i

export function isPersonalEmail(v: string | null | undefined): boolean {
  const s = (v ?? '').trim()
  return s.includes('@') && PERSONAL_MAIL.test(s.slice(s.lastIndexOf('@') + 1))
}

export const NO_STAFF_SIGN_IN = 'No school email or phone, add one first'

/* Owner, 2026-11-06: staff sign in only with their school email or phone,
   never a personal email. This is what is shown and sent as their sign-in. */
export function staffSignIn(schoolEmail: string | null | undefined, phone: string | null | undefined): string {
  const se = (schoolEmail ?? '').trim()
  if (se.includes('@') && !isPersonalEmail(se)) return se
  const p = shownSignIn((phone ?? '').trim())
  return p !== '' ? p : NO_STAFF_SIGN_IN
}
