import { useLocation } from 'react-router-dom'
import type { ApiRole, ApiSection } from '@/lib/catalog'
import { rememberedChildId, useChildProfile } from './parent-child'

/* THE PARENT MENU, AS THE OWNER LAID IT OUT (2026-11-26).

   - Concerns is a group of its own, not a line under Communication. Its
     screen keeps its address (/parent/communication/concerns): `path` names
     the section the link is built from, so bookmarks and permissions are the
     catalogue's as before.
   - Academics gains Subjects and ECA, both views of the Homework screen
     (`?view=subjects`, `?view=eca`). ECA is listed only when the child on
     screen is enrolled in an activity.

   Nothing is renamed in the catalogue, so no school loses a screen. */
export type NavSection = ApiSection & { path?: string }

export const sectionPath = (s: ApiSection) => (s as NavSection).path ?? s.slug

export function parentSections(sections: ApiSection[], hasEca: boolean): NavSection[] {
  const out: NavSection[] = sections.map((s) => ({ ...s, features: [...s.features] }))
  const comm = out.find((s) => s.slug !== 'concerns' && s.features.some((f) => f.slug === 'concerns'))
  if (comm && comm.features.length > 1) {
    const f = comm.features.find((x) => x.slug === 'concerns')!
    comm.features = comm.features.filter((x) => x !== f)
    out.splice(out.indexOf(comm) + 1, 0, { ...comm, slug: 'concerns', name: 'Concerns', workspace: 'Concerns', path: sectionPath(comm), features: [f] })
  }
  const acad = out.find((s) => s.features.some((f) => f.slug === 'homework_academics'))
  if (acad) {
    const at = acad.features.findIndex((f) => f.slug === 'homework_academics')
    const hw = acad.features[at]
    const extra = [{ ...hw, key: `${hw.key}#subjects`, slug: 'homework_academics?view=subjects', name: 'Subjects', summary: 'Your child\'s subjects, each with its teacher, periods a week, homework and marks.' }]
    if (hasEca) extra.push({ ...hw, key: `${hw.key}#eca`, slug: 'homework_academics?view=eca', name: 'ECA', summary: 'The extra-curricular activities your child is enrolled in.' })
    acad.features.splice(at, 1, { ...hw, name: 'Homework' }, ...extra)
  }
  return out
}

/** The role with the parent menu applied; any other role unchanged. */
export function useParentNavRole<R extends ApiRole | undefined>(role: R): R {
  const { search } = useLocation()
  const isParent = role?.key === 'parent'
  const q = new URLSearchParams(search)
  let year = q.get('ay') ?? ''
  if (!year) { try { year = localStorage.getItem('portal-year') ?? '' } catch { /* private mode */ } }
  const sid = q.get('student_id') || rememberedChildId()
  const profile = useChildProfile(sid || null, year, isParent)
  if (!isParent || !role) return role
  return { ...role, sections: parentSections(role.sections, (profile.data?.eca.length ?? 0) > 0) } as R
}

/** Which of Homework / Subjects / ECA a menu link stands for is lit. */
export function viewMatches(slug: string, search: string): boolean {
  if (!slug.startsWith('homework_academics')) return true
  const want = slug.includes('?') ? new URLSearchParams(slug.split('?')[1]).get('view') ?? '' : ''
  const have = new URLSearchParams(search).get('view') ?? ''
  const norm = have === 'subject' ? 'subjects' : have === 'diary' ? '' : have
  return want === norm
}
