import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { api, type List, type Page, type Student } from '@/lib/api'

/* ONE ROSTER, NOT THIRTEEN.

   The whole staff list and the whole student list are what a name-picker
   needs, and thirteen screens each asked for their own copy under their own
   query key: `['employees','payroll']`, `['employees','welfare']`,
   `['students','laundry']`, `['students','room-checks']` and so on. React
   Query caches per key, so identical answers to an identical URL were fetched,
   stored and expired thirteen separate times — and a warden who walks from
   room checks to laundry to visitors paid for the same three hundred students
   three times over. On Cloud Run that is three billed requests and three Neon
   reads for one unchanged list.

   One key each, and five minutes of staleness. A roster changes when somebody
   is admitted or appointed, which is a handful of times a term; the mutations
   that do it invalidate ['students'] and ['employees'], and this key sits
   under those prefixes, so a new arrival still appears at once.

   The hooks return the query untouched, so every call site keeps the shape it
   already reads (`students.data?.items`, `employees.isLoading`). */

const ROSTER_STALE = 5 * 60_000

/** Everyone on the payroll, for a name-picker. */
export function useEmployeeRoster<T = EmployeeName>(): UseQueryResult<List<T>> {
  return useQuery({
    queryKey: ['employees', 'roster'],
    queryFn: () => api.get<List<T>>('/api/v1/hr/employees?limit=300'),
    staleTime: ROSTER_STALE,
  })
}

/** The name and code every HR picker reads off an employee. */
export interface EmployeeName {
  id: string
  full_name?: string
  name?: string
  employee_code?: string
}

/* THE PICKERS ARE STILL ASKING FOR A NUMBER, AND A NUMBER IS STILL WRONG.

   A dropdown wants every child who might be typed, and there is no page size
   that is right for that: 300 lost the behaviour log's children, 500 fits one
   school and not the next, and a million fits nothing. The real answer is
   server-side typeahead -- the endpoint already takes `q` -- so the picker
   asks for the twenty names matching what has been typed instead of the roll.
   That is a change to every picker's props, not to this file, and it is not
   made here.

   What IS made here is holding the line while that waits. The API's page size
   is now 200, so a single `limit=500` would come back quietly short -- the
   exact silent clamp that lost children before. So this walks the cursor
   instead, up to a bounded number of pages: no worse than the old 500 at any
   roll it used to serve, and honest about stopping rather than pretending the
   first page was everybody. The bound is what says out loud that this is a
   stopgap: a school past it needs the typeahead, not a bigger bound. */
const ROSTER_PAGE = 200
const ROSTER_MAX_PAGES = 5

async function walkRoster<T>(path: string): Promise<List<T>> {
  const items: T[] = []
  let cursor = ''
  for (let i = 0; i < ROSTER_MAX_PAGES; i++) {
    const qs = new URLSearchParams({ limit: String(ROSTER_PAGE) })
    if (cursor) qs.set('cursor', cursor)
    const page = await api.get<Page<T>>(`${path}?${qs.toString()}`)
    items.push(...page.items)
    if (!page.next_cursor) break
    cursor = page.next_cursor
  }
  return { items }
}

export function useStudentRoster<T = Student>(): UseQueryResult<List<T>> {
  return useQuery({
    queryKey: ['students', 'roster'],
    queryFn: () => walkRoster<T>('/api/v1/students'),
    staleTime: ROSTER_STALE,
  })
}
