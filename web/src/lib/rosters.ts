import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { api, type List, type Student } from '@/lib/api'

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

/* 500, not 300: six of the seven screens asked for 300 and the behaviour log
   asked for 500. Sharing one cache means sharing one limit, and the larger is
   the only one that cannot silently lose the child somebody is looking for. */
export function useStudentRoster<T = Student>(): UseQueryResult<List<T>> {
  return useQuery({
    queryKey: ['students', 'roster'],
    queryFn: () => api.get<List<T>>('/api/v1/students?limit=500'),
    staleTime: ROSTER_STALE,
  })
}
