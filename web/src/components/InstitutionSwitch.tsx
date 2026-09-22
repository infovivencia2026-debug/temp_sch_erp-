import { Building2 } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, actingInstitution, setActingInstitution, type List } from '@/lib/api'
import { PickerMenu } from './PickerMenu'

/* The cross-school switcher, in the shell header, beside the working year.

   A board member oversees several schools and reads each in turn. The schools
   they may switch between come from GET /api/v1/me/institutions — their board
   memberships plus their home, home first — and switching is the same
   X-Acting-Institution mechanism the platform picker already uses: set the
   acting-institution id, invalidate every query, and the whole app repaints
   under that school's data. The server validates the header against a role the
   user actually holds, so this is never a way into a school they do not oversee.

   Shown only when there is a choice to make. Most users hold exactly one
   membership and see nothing new — the same rule the year switcher follows. A
   plain <select> rather than a menu: readable at a glance, and it works on the
   old browsers this product still has to run on.

   Picking the home school clears the stored choice rather than storing its id,
   so the header falls away and the request scopes to home the ordinary way —
   the mirror of the year switcher clearing on the current year. */

interface Membership {
  id: string
  name: string
  is_home: boolean
}

export function InstitutionSwitch() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['my-institutions'],
    queryFn: () => api.get<List<Membership>>('/api/v1/me/institutions'),
    // The set of schools a person oversees changes rarely; no need to refetch
    // it on every window focus while they work.
    staleTime: 5 * 60 * 1000,
  })

  const items = q.data?.items ?? []
  // One school (or none) needs no switcher — which is most people.
  if (items.length <= 1) return null

  const home = items.find((i) => i.is_home) ?? items[0]
  const acting = actingInstitution()
  // The selected school: the acting id when it names one of these schools,
  // otherwise home (the resting state, no header sent).
  const current = (acting && items.some((i) => i.id === acting) ? acting : home.id)

  const currentItem = items.find((i) => i.id === current) ?? home
  return (
    <PickerMenu
      value={current}
      ariaLabel="Working school"
      onChange={(id) => {
        const picked = items.find((i) => i.id === id)
        // Home clears the header; any other school sets it. Then forget every
        // cached answer so the app reloads under the chosen school.
        setActingInstitution(picked?.is_home ? null : id)
        qc.invalidateQueries()
      }}
      options={items.map((i) => ({
        value: i.id,
        label: `${i.name}${i.is_home ? ' (home)' : ''}`,
      }))}
    >
      <span
        className="flex h-8 min-w-0 shrink items-center gap-1.5 rounded-[7px] bg-surface-hover/60 px-2 text-[12.5px] text-muted-foreground"
        title="The school you are working inside. Every number on the page is about this school."
      >
        <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 max-w-[6.5rem] truncate font-[550] text-foreground sm:max-w-[11rem]">
          {currentItem.name}{currentItem.is_home ? ' (home)' : ''}
        </span>
      </span>
    </PickerMenu>
  )
}

export default InstitutionSwitch
