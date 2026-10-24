import { ROLES } from '@/catalog.gen'

/* FILLING A CANNED REPLY (Support desk, SupportDesk.tsx).

   {{name}}, {{school}} and {{agent}} are the ticket's people. {{screen:...}}
   names a real screen the way the school's menu shows it, from the same
   catalogue that builds the menu, so a reply never sends someone to a screen
   that was renamed or moved:

     {{screen:fees.fee_dashboard}}                    -> Fees → Fee Dashboard
     {{screen:institution_admin.fees.fee_dashboard}}  -> the same, one role's menu

   The short form is section.feature, looked up in the school administrator's
   menu first and then in any role's. A screen the catalogue does not have is
   left as written, so whoever sends the reply sees it and fixes it. */

const PREFERRED = ['institution_admin']

/** "Section → Feature" for a catalogue id or key, or null when there is no such screen. */
export function screenLabel(ref: string): string | null {
  const parts = ref.trim().split('.')
  if (parts.length < 2 || parts.length > 3) return null
  const [roleKey, sectionSlug, featureSlug] = parts.length === 3 ? parts : [null, parts[0], parts[1]]
  const roles = roleKey ? ROLES.filter((r) => r.key === roleKey)
    : [...ROLES].sort((a, b) => Number(PREFERRED.includes(b.key)) - Number(PREFERRED.includes(a.key)))
  for (const r of roles) {
    const s = r.sections.find((x) => x.slug === sectionSlug)
    const f = s?.features.find((x) => x.slug === featureSlug)
    if (s && f) return s.name === f.name ? f.name : `${s.name} → ${f.name}`
  }
  return null
}

export function fillCanned(body: string, t: { raised_by?: string; school?: string }, agent: string): string {
  return body
    .replace(/\{\{name\}\}/g, (t.raised_by ?? '').split(' ')[0] || 'there')
    .replace(/\{\{school\}\}/g, t.school ?? 'your school')
    .replace(/\{\{agent\}\}/g, agent)
    .replace(/\{\{screen:([a-z0-9_.]+)\}\}/g, (whole, ref: string) => screenLabel(ref) ?? whole)
}
