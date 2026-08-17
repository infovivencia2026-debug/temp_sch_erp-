import { useQuery } from '@tanstack/react-query'
import { Check, Sparkles } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { cn } from '@/lib/utils'

/* Choosing what an account can do, both ways round.

   A preset is the fast path: "office staff" is admissions, front desk and the
   fee counter, and nobody setting up a school on a Tuesday afternoon wants to
   reason about that from thirteen checkboxes. But presets are a summary of a
   real school's shape, not a constraint on it — the accountant who also runs
   the library is not an edge case in a 400-pupil school, they are Tuesday.

   So both are live at once. Pick a preset and the boxes tick; tick a box and
   the selection stops matching a preset and says so. Neither is the "advanced"
   mode hidden behind a disclosure: the roles are always visible, because the
   question an admin actually has is "what will this person be able to see",
   and only the individual list answers it. */

export interface Role {
  key: string
  name: string
  description: string
  permissions: number
  users: number
}
export interface Preset {
  key: string
  name: string
  description: string
  role_keys: string[]
  recommended: boolean
}

const same = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join()

export function useRoleCatalog() {
  const roles = useQuery({
    queryKey: ['assignable-roles'],
    queryFn: () => api.get<List<Role>>('/api/v1/admin/assignable-roles'),
  })
  const presets = useQuery({
    queryKey: ['role-presets'],
    queryFn: () => api.get<List<Preset>>('/api/v1/admin/role-presets'),
  })
  return { roles: roles.data?.items ?? [], presets: presets.data?.items ?? [] }
}

export function RolePicker({
  value,
  onChange,
  roles,
  presets,
}: {
  value: string[]
  onChange: (next: string[]) => void
  roles: Role[]
  presets: Preset[]
}) {
  const matched = presets.find((p) => same(p.role_keys, value))
  const picked = new Set(value)

  const toggle = (key: string) =>
    onChange(picked.has(key) ? value.filter((k) => k !== key) : [...value, key])

  const totalPermissions = roles
    .filter((r) => picked.has(r.key))
    .reduce((max, r) => Math.max(max, r.permissions), 0)

  return (
    <div className="space-y-4">
      <div>
        <p className="eyebrow mb-2">Start from a common shape</p>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => {
            const on = matched?.key === p.key
            return (
              <button
                key={p.key}
                type="button"
                title={p.description}
                onClick={() => onChange(p.role_keys)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] transition-colors duration-150',
                  on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                )}
              >
                {p.recommended && !on && <Sparkles className="h-3 w-3 text-primary" />}
                {on && <Check className="h-3 w-3" strokeWidth={3} />}
                {p.name}
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-[13px] text-muted-foreground">
          {matched
            ? matched.description
            : value.length
              ? 'A custom combination — no preset matches these roles exactly.'
              : 'Or tick the individual roles below.'}
        </p>
      </div>

      <div className="border-t pt-4">
        <div className="mb-2 flex items-baseline justify-between">
          <p className="eyebrow">Roles on this account</p>
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-[13px] text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {roles.map((r) => {
            const on = picked.has(r.key)
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => toggle(r.key)}
                className={cn(
                  'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                  on ? 'border-primary/40 bg-accent' : 'hover:bg-accent/60',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[3px] border',
                    on ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}
                >
                  {on && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px]">{r.name}</span>
                  <span className="block text-[13px] leading-snug text-muted-foreground">
                    {r.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {value.length > 0 && (
        <p className="text-[13px] text-muted-foreground">
          {value.length} role{value.length === 1 ? '' : 's'}
          {totalPermissions > 0 && ` · up to ${totalPermissions} permissions`}. Each role keeps its
          own workspace — this person switches between them from the left rail rather than seeing
          one merged screen.
        </p>
      )}
    </div>
  )
}
