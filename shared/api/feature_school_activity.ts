/* School activity: everything students, parents and staff do on the platform,
   newest first, on one timeline, for the principal. Filter by who (student,
   parent, staff, system), what (types), when (from, to: YYYY-MM-DD, India
   time) and part of a name (q). One page at a time: pass `next` as cursor. */

export interface SchoolActivityEvent {
  id: string
  type: string
  at: string
  title: string
  detail: string
  /** Who did it, by name. */
  by: string
  link: string | null
  who: 'student' | 'parent' | 'staff' | 'system'
}

export interface SchoolActivityPage {
  items: SchoolActivityEvent[]
  next: string | null
  /** The kinds of event this list can show. */
  types: string[]
}

export interface SchoolActivityApi {
  'GET /admin/activity': { res: SchoolActivityPage }
}
