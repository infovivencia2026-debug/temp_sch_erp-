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
}: {
  value: string
  onChange: (v: string) => void
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

  return (
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
  )
}
