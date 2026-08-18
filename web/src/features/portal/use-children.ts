import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'

export interface PortalChild {
  student_id: string
  full_name: string
  admission_no?: string
  class_name?: string
  section_name?: string
}

/* Which child a screen is about.

   Every family screen needs this and each one wrote it slightly differently
   before it lived here — one defaulted to the first child, one to none, and the
   second silently filed against nobody. A parent of one child should never be
   asked; a parent of three must be, because the wrong answer books leave for
   the wrong sibling.

   The selection is deliberately not remembered across screens. A parent who
   last looked at one child's fees is not thereby reporting that child absent. */
export function useChildren() {
  const query = useQuery({
    queryKey: ['my-students'],
    queryFn: () => api.get<List<PortalChild>>('/api/v1/portal/students'),
  })
  const children = query.data?.items ?? []
  const [chosen, setChosen] = useState('')
  // One child needs no choosing, so the id is theirs whether or not the picker
  // was ever rendered.
  const studentId = children.length === 1 ? children[0].student_id : chosen
  const child = children.find((c) => c.student_id === studentId)
  return { query, children, studentId, child, chosen, setChosen }
}

/** Options for a <Select> of the caller's children. */
export function childOptions(children: PortalChild[]) {
  return children.map((c) => ({
    value: c.student_id,
    label: c.class_name ? `${c.full_name} · ${c.class_name} ${c.section_name ?? ''}`.trim() : c.full_name,
  }))
}
