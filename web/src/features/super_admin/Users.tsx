import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Pencil, ShieldCheck, UserPlus, UserX, UserCheck, X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Input, Loading, ErrorState,
  Field, FormGrid, FormNotice,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { RolePicker, useRoleCatalog } from './RolePicker'

interface AdminUser {
  id: string
  full_name: string
  email?: string
  phone?: string
  status: string
  mfa_enabled: boolean
  last_login_at?: string
  roles: string[]
  institution?: string
  active_sessions: number
}

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  active: 'success',
  suspended: 'danger',
  invited: 'warning',
  archived: 'neutral',
}

export default function Users() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')

  const params = new URLSearchParams()
  if (search.trim()) params.set('q', search.trim())
  if (status) params.set('status', status)

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-users', params.toString()],
    queryFn: () => api.get<List<AdminUser>>(`/api/v1/admin/users?${params}`),
  })

  const { roles, presets } = useRoleCatalog()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AdminUser | null>(null)

  const setStatusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.put(`/api/v1/admin/users/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  })

  const users = data?.items ?? []
  const active = users.filter((u) => u.status === 'active').length
  const withMfa = users.filter((u) => u.mfa_enabled).length
  const signedIn = users.filter((u) => u.active_sessions > 0).length

  return (
    <>
      <PageHead
        eyebrow="Access & Security"
        title="Users"
        description="One person can hold several roles at once. The roles stay separate — the account switches between them rather than merging into one super-user."
        actions={
          <Button onClick={() => { setEditing(null); setCreating((c) => !c) }}>
            {creating ? <X className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
            {creating ? 'Cancel' : 'New account'}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Users" value={users.length} icon={ShieldCheck} />
          <Stat label="Active" value={active} hint={`${users.length - active} not active`} />
          <Stat label="Signed in now" value={signedIn} hint="With a live session" />
          <Stat
            label="Two-factor"
            value={withMfa}
            delta={{
              value: users.length ? `${Math.round((withMfa / users.length) * 100)}% enrolled` : '—',
              positive: withMfa * 2 >= users.length,
            }}
          />
        </CellGrid>

        {creating && (
          <AccountForm
            roles={roles}
            presets={presets}
            onClose={() => setCreating(false)}
          />
        )}
        {editing && (
          <AccountForm
            roles={roles}
            presets={presets}
            user={editing}
            onClose={() => setEditing(null)}
          />
        )}

        <Card>
          <CardHeader
            title="Directory"
            description={`${users.length} user${users.length === 1 ? '' : 's'}`}
            action={
              <>
                <Input value={search} onChange={setSearch} placeholder="Name, email or phone" />
                <Select
                  value={status}
                  onChange={setStatus}
                  placeholder="Any status"
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'invited', label: 'Invited' },
                    { value: 'suspended', label: 'Suspended' },
                    { value: 'archived', label: 'Archived' },
                  ]}
                />
              </>
            }
          />
          {isLoading ? (
            <Loading />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table
              head={['Name', 'Contact', 'Roles', 'Sessions', 'Last login', 'Status', '']}
              empty={!users.length}
              emptyLabel="No users match those filters."
            >
              {users.map((u) => (
                <tr key={u.id}>
                  <Td className="font-medium">
                    {u.full_name}
                    {u.mfa_enabled && (
                      <ShieldCheck className="ml-1.5 inline h-3.5 w-3.5 text-success" aria-label="2FA on" />
                    )}
                    {u.institution && (
                      <span className="ml-2 text-[12px] text-muted-foreground">{u.institution}</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{u.email ?? u.phone ?? '—'}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length ? (
                        u.roles.slice(0, 3).map((r) => <Badge key={r}>{r}</Badge>)
                      ) : (
                        <span className="text-muted-foreground">none</span>
                      )}
                      {u.roles.length > 3 && <Badge>+{u.roles.length - 3}</Badge>}
                    </div>
                  </Td>
                  <Td>{u.active_sessions || '—'}</Td>
                  <Td className="text-muted-foreground">{formatDate(u.last_login_at)}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[u.status] ?? 'neutral'}>{u.status}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Change this account's roles"
                      onClick={() => { setCreating(false); setEditing(u) }}
                    >
                      <Pencil className="h-3.5 w-3.5" /> Roles
                    </Button>
                    {u.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={setStatusMut.isPending}
                        onClick={() => setStatusMut.mutate({ id: u.id, status: 'suspended' })}
                      >
                        <UserX className="h-3.5 w-3.5" /> Suspend
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={setStatusMut.isPending}
                        onClick={() => setStatusMut.mutate({ id: u.id, status: 'active' })}
                      >
                        <UserCheck className="h-3.5 w-3.5" /> Activate
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {setStatusMut.isError && (
            <p className="border-t px-5 py-2.5 text-[13px] text-destructive">
              {setStatusMut.error instanceof Error ? setStatusMut.error.message : 'Could not update user'}
            </p>
          )}
        </Card>
      </PageBody>
    </>
  )
}

/**
 * One form for both cases.
 *
 * Creating an account and re-roling an existing one are the same decision made
 * at different times, and a school's commonest access change — the clerk who
 * takes over the fee counter when the accountant leaves — is the second one.
 * Splitting them into two screens buries it.
 */
function AccountForm({
  roles,
  presets,
  user,
  onClose,
}: {
  roles: ReturnType<typeof useRoleCatalog>['roles']
  presets: ReturnType<typeof useRoleCatalog>['presets']
  user?: AdminUser
  onClose: () => void
}) {
  const qc = useQueryClient()
  const editing = !!user
  const [f, setF] = useState({ full_name: user?.full_name ?? '', email: user?.email ?? '', phone: user?.phone ?? '' })
  const [picked, setPicked] = useState<string[]>(user?.roles ?? [])
  const [tempPassword, setTempPassword] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      if (editing) {
        return api.put(`/api/v1/admin/users/${user!.id}/roles`, { role_keys: picked })
      }
      return api.post<{ temporary_password?: string }>('/api/v1/admin/users', {
        ...f,
        role_keys: picked,
        set_password: true,
      })
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      const pw = (res as { temporary_password?: string } | undefined)?.temporary_password
      // The one-time password is shown rather than emailed: a new school has
      // no mail configured yet, and the admin is usually sitting next to the
      // person whose account they just made.
      if (pw) setTempPassword(pw)
      else onClose()
    },
  })

  const reset = useMutation({
    mutationFn: () => api.post<{ temporary_password?: string }>(`/api/v1/admin/users/${user!.id}/reset-password`, {}),
    onSuccess: (res) => setTempPassword(res?.temporary_password ?? null),
  })

  if (tempPassword) {
    return (
      <Card className="p-5">
        <p className="text-[14px] font-medium">Account ready</p>
        <p className="mt-1 text-[14px] text-muted-foreground">
          Give them this one-time password. It is shown once and cannot be retrieved later.
        </p>
        <p className="mt-3 rounded-md bg-muted px-3 py-2 font-mono text-[15px] tracking-wider">
          {tempPassword}
        </p>
        <div className="mt-4">
          <Button onClick={onClose}>Done</Button>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title={editing ? `Roles for ${user!.full_name}` : 'New account'}
        description={
          editing
            ? 'Adding a role grants a whole workspace; removing one takes it away at the next request.'
            : 'A person, not a role. Give them everything they do — one login for all of it.'
        }
        action={
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        }
      />
      <div className="space-y-5 px-5 py-5">
        {!editing && (
          <FormGrid>
            <Field label="Full name" required>
              <Input value={f.full_name} onChange={(x) => setF({ ...f, full_name: x })} placeholder="Lakshmi Reddy" />
            </Field>
            <Field label="Email" hint="Either an email or a phone is needed to sign in.">
              <Input type="email" value={f.email} onChange={(x) => setF({ ...f, email: x })} />
            </Field>
            <Field label="Phone">
              <Input value={f.phone} onChange={(x) => setF({ ...f, phone: x })} placeholder="9848012345" />
            </Field>
          </FormGrid>
        )}

        <RolePicker value={picked} onChange={setPicked} roles={roles} presets={presets} />

        <FormNotice error={save.error ?? reset.error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending || (!editing && !f.full_name.trim())}>
            {save.isPending ? 'Saving…' : editing ? 'Save roles' : 'Create account'}
          </Button>
          {editing && (
            <Button variant="secondary" onClick={() => reset.mutate()} disabled={reset.isPending}>
              <KeyRound className="h-3.5 w-3.5" />
              {reset.isPending ? 'Resetting…' : 'Reset password'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  )
}
