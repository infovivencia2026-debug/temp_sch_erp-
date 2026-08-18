import { useChildren, childOptions, type PortalChild } from '../portal/use-children'

/* Which child a student screen is about.

   A student's own set is one record and they are never asked. A guardian
   reading the same screen has to choose, because the wrong answer here books a
   club ticket for the wrong sibling — so the picker appears only when there is
   genuinely something to pick, and useChildren already decides that.

   Re-exported rather than reimplemented: the family screens settled this
   question first and a second copy would be the one that defaulted to nobody. */
export { useChildren, childOptions }
export type { PortalChild }

/** Query string for an endpoint that takes an optional student_id. */
export function studentQuery(studentId: string, ...extra: string[]) {
  const parts = [...(studentId ? [`student_id=${studentId}`] : []), ...extra.filter(Boolean)]
  return parts.length ? `?${parts.join('&')}` : ''
}

/* Whether a screen may load yet.

   A guardian of three who has not chosen sends no student_id, and the endpoint
   would answer for the eldest — which is the wrong child on every screen except
   by accident. Waiting is the honest state. */
export function readyFor(children: PortalChild[], studentId: string) {
  return children.length <= 1 || studentId !== ''
}
