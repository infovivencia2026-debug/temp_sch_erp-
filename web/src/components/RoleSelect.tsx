import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { Button, Input, Select } from '@/components/ui'
import { useCan } from '@/lib/session'

/* Choosing a role, and inventing one.
 *
 * The list is the school's own roles, not a set of names fixed in the bundle:
 * a school that creates a role expects to be able to put somebody in it from
 * the form where staff are actually created.
 *
 * Creating one is offered only to whoever may write roles, and it always
 * copies an existing role's access. A role with no grants is a role whose
 * holder signs in and sees nothing — which the school reads as a broken
 * account rather than an empty role, and which is why the server's own
 * createRole takes copy_from. "Senior teacher, same access as Teacher" is what
 * a school actually means; "Senior teacher, access to nothing" never is.
 */

interface Role {
  key: string
  name: string
  /* 'catalog' and 'capability' are installed; 'installable' is one this
     school could have and has not set up yet. */
  source?: string
}

export default function RoleSelect({
  value,
  onChange,
  extra,
  onExtra,
}: {
  value: string
  onChange: (v: string) => void
  /* MORE THAN ONE ROLE, because that is how a school of forty runs.
     A head of department also teaches; a principal also keeps the accounts;
     the front desk is also the person who adds a student. Passing these two
     turns the control into a primary role plus any number of others.
     Omitted, it behaves exactly as it did. */
  extra?: string[]
  onExtra?: (v: string[]) => void
}) {
  const qc = useQueryClient()
  const can = useCan()
  const mayCreate = can('access.roles.write')

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [copyFrom, setCopyFrom] = useState('faculty')
  const [err, setErr] = useState('')

  const roles = useQuery({
    queryKey: ['assignable-roles'],
    queryFn: () => api.get<List<Role>>('/api/v1/admin/assignable-roles'),
    staleTime: 5 * 60_000,
  })

  const create = useMutation({
    mutationFn: () =>
      api.post<Role>('/api/v1/admin/roles', { name: name.trim(), copy_from: copyFrom }),
    onSuccess: (made) => {
      qc.invalidateQueries({ queryKey: ['assignable-roles'] })
      onChange(made.key)
      setAdding(false)
      setName('')
      setErr('')
    },
    onError: (e: Error) => setErr(e.message),
  })

  const items = roles.data?.items ?? []

  if (adding) {
    return (
      <div className="space-y-2">
        <Input
          value={name}
          onChange={setName}
          placeholder="Senior teacher"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-muted-foreground">Same access as</span>
          <Select
            value={copyFrom}
            onChange={setCopyFrom}
            options={items.map((r) => ({ value: r.key, label: r.name }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={create.isPending || !name.trim()} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create role'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => { setAdding(false); setErr('') }}>
            Cancel
          </Button>
        </div>
        <p className={err ? 'text-[12px] text-destructive' : 'text-[12px] text-muted-foreground'}>
          {err || 'It starts with the same access as the role you pick, and you can change it afterwards under Roles and permissions.'}
        </p>
      </div>
    )
  }

  const multi = Boolean(onExtra)
  const chosen = extra ?? []

  return (
    <div className={multi ? 'space-y-2' : undefined}>
    <Select
      value={value}
      onChange={(v) => {
        if (v === '__add_role__') { setAdding(true); return }
        onChange(v)
      }}
      placeholder={roles.isLoading ? 'Loading…' : items.length ? 'Choose a role' : 'No roles available'}
      options={[
        /* A role the school has not set up yet is still a role it can appoint
           somebody to — choosing it installs it. Saying so beats offering it
           as though the school already ran a library. */
        ...items.map((r) => ({
          value: r.key,
          label: r.source === 'installable' ? `${r.name} — not set up yet` : r.name,
        })),
        ...(mayCreate && items.length ? [{ value: '__add_role__', label: '+ Add your own role…' }] : []),
      ]}
    />

    {/* THE OTHER HATS.

        Ticks rather than a second dropdown: a person's roles are a set, and a
        set of five with two chosen is read faster as five lines than as a list
        that has to be opened to see what is in it.

        The primary role is hidden from the list rather than shown ticked and
        disabled. It is already named in the control above, and a row that
        cannot be changed invites somebody to try. */}
    {multi && items.length > 0 && (
      <details className="rounded-[3px] border px-3 py-2">
        <summary className="cursor-pointer text-[13px] text-muted-foreground">
          {chosen.length
            ? `Also: ${chosen.length} more ${chosen.length === 1 ? 'role' : 'roles'}`
            : 'Does this person do a second job?'}
        </summary>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {items
            .filter((r) => r.key !== value)
            .map((r) => (
              <label key={r.key} className="flex items-center gap-2 text-[13.5px]">
                <input
                  type="checkbox"
                  checked={chosen.includes(r.key)}
                  onChange={(e) =>
                    onExtra!(
                      e.target.checked
                        ? [...chosen, r.key]
                        : chosen.filter((k) => k !== r.key),
                    )
                  }
                />
                <span className="truncate">{r.name}</span>
              </label>
            ))}
        </div>
        <p className="mt-2 text-[12px] text-muted-foreground">
          They get everything all of these can do, added together. A teacher who
          is also head of department sees both.
        </p>
      </details>
    )}
    </div>
  )
}
