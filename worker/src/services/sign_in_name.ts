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
