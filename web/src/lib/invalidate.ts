import type { QueryClient, QueryKey } from '@tanstack/react-query'

/* WHAT A SETUP SAVE CAN HAVE MOVED.

   `qc.invalidateQueries()` with no key refetches every mounted query — on a
   screen with a dashboard, a notification bell and an attention strip that is
   a dozen requests for a save that changed one table. On a server billed per
   request, each of those was a bill. Mutations name what they touched; the
   setup screens, where one save can ripple through several tables, name this
   list instead of everything. */
export const SETUP_KEYS: QueryKey[] = [
  ['institution'], ['inst-options'], ['campuses'], ['years'], ['academic-years'],
  ['classes'], ['sections'], ['subjects'], ['class-subjects'], ['teachers'],
  ['periods'], ['bell-schedules'], ['grading-scales'], ['fee-heads'],
  ['fee-structures'], ['setup'], ['setup-status'], ['attention'],
]

/** What a bulk upload or a new person can have changed, beyond setup. */
export const ROSTER_KEYS: QueryKey[] = [
  ['students'], ['employees'], ['teachers'], ['users'], ['staff'], ['hr'],
  ['admission-register'], ['import-history'],
]

export function invalidateKeys(qc: QueryClient, keys: QueryKey[]): Promise<void> {
  return Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }))).then(() => undefined)
}
