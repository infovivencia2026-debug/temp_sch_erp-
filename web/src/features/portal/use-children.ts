import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'

export interface PortalChild {
  student_id: string
  full_name: string
  admission_no?: string
  class_name?: string
  section_name?: string
}

/* Which child the app is about.

   Every family screen needs this and each one wrote it slightly differently
   before it lived here — one defaulted to the first child, one to none, and the
   second silently filed against nobody. A parent of one child should never be
   asked; a parent of three must be, because the wrong answer books leave for
   the wrong sibling.

   The choice sticks across screens. It used to be forgotten between them, on
   the reasoning that a parent who last looked at one child's fees is not
   thereby reporting that child absent — which protects one screen and costs
   every other: a parent of two opening fees, then homework, then the report
   card was asked the same question three times and gave the same answer three
   times.

   What actually protects the writing screens is that they say whose record
   they are on, not that the app has forgotten. Forgetting only moved the risk
   from "acted on the wrong child" to "asked so often nobody reads the
   question".

   Per tab, not per account: sessionStorage, so a parent can hold two children
   open side by side in two tabs — the one case where forgetting was right. */
const CHILD_KEY = 'portal-child'

function remembered(): string {
  try {
    return sessionStorage.getItem(CHILD_KEY) ?? ''
  } catch {
    return '' // private mode; the picker asks again, which is the old behaviour
  }
}

export function useChildren() {
  const query = useQuery({
    queryKey: ['my-students'],
    queryFn: () => api.get<List<PortalChild>>('/api/v1/portal/students'),
  })
  const children = query.data?.items ?? []
  const [chosen, setChosenState] = useState(remembered)

  const setChosen = useCallback((id: string) => {
    setChosenState(id)
    try {
      if (id) sessionStorage.setItem(CHILD_KEY, id)
      else sessionStorage.removeItem(CHILD_KEY)
    } catch {
      /* private mode: the choice holds for this screen and is asked again on
         the next, which is exactly how it behaved before. */
    }
  }, [])

  /* A remembered child who is no longer one of yours.

     A guardian unlinked from a student, or a tab left open across a change of
     school, would otherwise hold an id that matches nobody — and every screen
     would ask the server about a child it will refuse, which reads as the
     product being broken rather than as the link having gone. */
  const known = children.some((c) => c.student_id === chosen)
  const effective = known ? chosen : ''

  // One child needs no choosing, so the id is theirs whether or not the picker
  // was ever rendered.
  const studentId = children.length === 1 ? children[0].student_id : effective
  const child = children.find((c) => c.student_id === studentId)
  return { query, children, studentId, child, chosen: effective, setChosen }
}

/* Whether a screen about one child may load yet.

   A guardian of three who has not chosen sends no student_id, and an endpoint
   that resolves the child with whichChild answers for the eldest — which is the
   wrong child on every screen except by accident. Waiting is the honest state.

   `=== 1`, not `<= 1`. An empty list is not "one child, no need to ask": it is
   the list before it has arrived, the list of an account linked to nobody, or
   the list whose request failed. Nought children is not ready either — there is
   no child for the answer to be about.

   Only for the screens whose endpoint resolves a single child. The school-life
   endpoints take the whole family (familyChildren in portal_school_life.go)
   and mean "all my children" by an absent student_id, and gating those would
   delete a view the picker offers on purpose.

   Lives here rather than beside its first caller so the family screens and the
   learning screens cannot drift into two answers; learning/use-student.ts
   re-exports it. */
export function readyFor(children: PortalChild[], studentId: string) {
  return children.length === 1 || studentId !== ''
}

/** Options for a <Select> of the caller's children. */
export function childOptions(children: PortalChild[]) {
  return children.map((c) => ({
    value: c.student_id,
    label: c.class_name ? `${c.full_name} · ${c.class_name} ${c.section_name ?? ''}`.trim() : c.full_name,
  }))
}
