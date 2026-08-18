import { useChildren, childOptions, readyFor, type PortalChild } from '../portal/use-children'

/* Which child a student screen is about.

   A student's own set is one record and they are never asked. A guardian
   reading the same screen has to choose, because the wrong answer here books a
   club ticket for the wrong sibling — so the picker appears only when there is
   genuinely something to pick, and useChildren already decides that.

   Re-exported rather than reimplemented: the family screens settled this
   question first and a second copy would be the one that defaulted to nobody. */
export { useChildren, childOptions, readyFor }
export type { PortalChild }

/** Query string for an endpoint that takes an optional student_id. */
export function studentQuery(studentId: string, ...extra: string[]) {
  const parts = [...(studentId ? [`student_id=${studentId}`] : []), ...extra.filter(Boolean)]
  return parts.length ? `?${parts.join('&')}` : ''
}
