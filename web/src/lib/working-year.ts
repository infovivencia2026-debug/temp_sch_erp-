import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/* The year this person is working in.

   One flag on the server says which year is being taught, and that flag is
   right for the register and today's meals. It is wrong for the admissions
   clerk in November, who is admitting into next year, and for whoever is
   drawing up next year's sections, fees and timetable. So the working year
   is a per-person choice the server keeps (GET/PUT /working-year) and every
   handler that works across the boundary reads. Screens need send nothing:
   the choice rides the session.

   Kept in the query cache rather than in local state so that the one place
   that changes it -- the switcher in the shell -- can invalidate everything
   else: after a switch, every list on the screen is about a different year. */

export interface WorkingYearRow {
  id: string
  name: string
  starts_on: string
  ends_on: string
  is_current: boolean
  /** Offered by the switcher. A finished year is history, not a choice. */
  open: boolean
}

export interface WorkingYearResponse {
  academic_year_id: string | null
  /** Whether a choice is stored, as opposed to the current year applying. */
  chosen: boolean
  years: WorkingYearRow[]
}

export const WORKING_YEAR_KEY = ['working-year'] as const

export function useWorkingYear() {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: WORKING_YEAR_KEY,
    queryFn: () => api.get<WorkingYearResponse>('/api/v1/working-year'),
    staleTime: 5 * 60_000,
  })
  const set = useMutation({
    mutationFn: (academic_year_id: string | null) =>
      api.put<WorkingYearResponse>('/api/v1/working-year', {
        academic_year_id: academic_year_id ?? '',
      }),
    onSuccess: (res) => {
      qc.setQueryData(WORKING_YEAR_KEY, res)
      /* Everything, not a list of keys: the screens that answer for a year do
         not know they do, which is the whole point of the server resolving
         it. A stale section list after a switch is worse than a refetch. */
      void qc.invalidateQueries()
    },
  })
  const years = query.data?.years ?? []
  const open = years.filter((y) => y.open)
  const current = years.find((y) => y.id === query.data?.academic_year_id) ?? null
  return {
    /** The year in effect, resolved the way the server resolves it. */
    year: current,
    years,
    /** More than one year to work in: the only case the switcher shows. */
    switchable: open.length > 1,
    openYears: open,
    chosen: query.data?.chosen ?? false,
    setYear: (id: string | null) => set.mutate(id),
    saving: set.isPending,
    loaded: query.isSuccess,
  }
}
