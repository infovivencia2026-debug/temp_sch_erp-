import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, KeyRound, Pencil, ShieldCheck, SlidersHorizontal, UserPlus, UserX, UserCheck, X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Input, Reload, Loading, ErrorState,
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
  role_keys: string[]
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

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['admin-users', params.toString()],
    queryFn: () => api.get<List<AdminUser>>(`/api/v1/admin/users?${params}`),
  })

  const { roles, presets } = useRoleCatalog()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [handingOver, setHandingOver] = useState<AdminUser | null>(null)
  const [custom, setCustom] = useState(false)

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

        {custom && <CustomAccount onClose={() => setCustom(false)} />}

        {handingOver && (
          <HandOver
            from={handingOver}
            candidates={users.filter((u) => u.id !== handingOver.id)}
            onClose={() => setHandingOver(null)}
          />
        )}

        <Card>
          <CardHeader
            title="Directory"
            description={`${users.length} user${users.length === 1 ? '' : 's'}`}
            action={
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => { setCreating(false); setEditing(null); setHandingOver(null); setCustom((v) => !v) }}
                  title="An account with a role of its own, dialled to exactly what it should see"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Custom account
                </Button>
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
                <Reload onClick={() => refetch()} busy={isFetching} label="Re-read the directory" />
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
                    {u.role_keys.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Hand this account's roles to somebody else"
                        onClick={() => { setCreating(false); setEditing(null); setHandingOver(u) }}
                      >
                        <ArrowRightLeft className="h-3.5 w-3.5" /> Hand over
                      </Button>
                    )}
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
  // Keys, not display names: the picker toggles on key, and seeding it with
  // names left every role unticked and saved an empty set.
  const [picked, setPicked] = useState<string[]>(user?.role_keys ?? [])
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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
      /* The server answers with the roles it could not resolve. Nothing read
         it, so a save that silently applied none looked identical to one that
         worked — which is how a role edit came to revoke everything. */
      const unknown = (res as { unknown_roles?: string[] } | undefined)?.unknown_roles
      if (unknown?.length) {
        setNotice(`The server did not recognise: ${unknown.join(', ')}. Nothing was changed.`)
        return
      }
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

        <FormNotice error={save.error ?? reset.error ?? (notice ? new Error(notice) : undefined)} />
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

/* Handing a job over.

   Two edits used to do this: grant to the joiner, revoke from the leaver. The
   gap between them is a school with two bursars, and a forgotten second edit
   is a school with two bursars for good — which is the failure that actually
   happens, because the satisfying half of the job is done after the first
   edit and nobody is chasing the second.

   One press, one transaction. The server refuses to strip a school's last
   administrator, so the dangerous case comes back as a sentence rather than
   an unrecoverable school. */
function HandOver({
  from,
  candidates,
  onClose,
}: {
  from: AdminUser
  candidates: AdminUser[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [to, setTo] = useState('')
  // Every role by default: "they have left, give their job to this person" is
  // the ordinary case, and picking a subset is the exception.
  const [picked, setPicked] = useState<string[]>(from.role_keys)
  const [leaverStatus, setLeaverStatus] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const move = useMutation({
    mutationFn: () =>
      api.post<{ note?: string }>('/api/v1/admin/users/roles/transfer', {
        from_user_id: from.id,
        to_user_id: to,
        role_keys: picked,
        leaver_status: leaverStatus || undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      setNotice(res?.note ?? 'Handed over.')
    },
    onError: (e: unknown) => setNotice(e instanceof Error ? e.message : 'Could not hand over.'),
  })

  const toName = candidates.find((c) => c.id === to)?.full_name

  return (
    <Card>
      <CardHeader
        title={`Hand over ${from.full_name}’s roles`}
        description="The joiner gains the role exactly when the leaver loses it — one action, so the school is never left with two people holding the same job, or none."
        action={
          <Button size="sm" variant="ghost" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        }
      />
      <div className="space-y-4 px-5 py-4">
        <FormGrid>
          <Field label="Hand over to" required>
            <Select
              value={to}
              onChange={setTo}
              placeholder="Pick the person taking over"
              options={candidates.map((c) => ({
                value: c.id,
                label: `${c.full_name}${c.status === 'active' ? '' : ` (${c.status})`}`,
              }))}
            />
          </Field>
          <Field
            label="Leave the outgoing account"
            hint="Somebody handing over one hat of three is still on the staff, so this is optional."
          >
            <Select
              value={leaverStatus}
              onChange={setLeaverStatus}
              placeholder="As it is"
              options={[
                { value: 'active', label: 'Active' },
                { value: 'suspended', label: 'Suspended' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
          </Field>
        </FormGrid>

        <div>
          <p className="text-[13px] font-medium">Roles moving</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {from.role_keys.map((k, i) => {
              const on = picked.includes(k)
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() =>
                    setPicked(on ? picked.filter((p) => p !== k) : [...picked, k])
                  }
                  className={
                    on
                      ? 'rounded-full border border-primary bg-primary px-3 py-1 text-[13px] text-primary-foreground'
                      : 'rounded-full border border-border px-3 py-1 text-[13px] text-muted-foreground'
                  }
                >
                  {from.roles[i] ?? k}
                </button>
              )
            })}
          </div>
        </div>

        {notice && <FormNotice ok={notice} />}

        <div className="flex items-center gap-3">
          <Button
            onClick={() => move.mutate()}
            disabled={!to || picked.length === 0 || move.isPending}
          >
            <ArrowRightLeft className="h-3.5 w-3.5" />
            {move.isPending ? 'Handing over…' : 'Hand over'}
          </Button>
          <span className="text-[13px] text-muted-foreground">
            {picked.length === 0
              ? 'Pick at least one role.'
              : !to
                ? 'Pick who is taking over.'
                : `${picked.length} role${picked.length === 1 ? '' : 's'} from ${from.full_name} to ${toName}.`}
          </span>
        </div>
      </div>
    </Card>
  )
}

interface RoleTemplate {
  key: string
  name: string
  description?: string
  permissions: number
  installed: boolean
}

interface GenericResult {
  user_id: string
  role_id: string
  role_name: string
  copied_permissions: number
  temporary_password: string
  note: string
  password_note: string
}

/* An account whose job is decided afterwards.

   Every school has somebody the built-in roles do not describe — a
   correspondent who sees fees but not marks, a trustee who sees everything and
   changes nothing. Making one took three screens, and the third, attaching the
   role to the account, is the one that gets forgotten.

   One press here: a role of its own, an account holding it, a password to hand
   over. What it may see and change is then the role grid, which says the two
   things that matter per feature — the level, and how far the data reaches.

   It starts at nothing unless a preset is chosen. An account that begins able
   to see everything is one somebody forgets to restrict, and the forgetting is
   silent. */
function CustomAccount({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ full_name: '', email: '', phone: '', role_name: '' })
  const [copyFrom, setCopyFrom] = useState('')
  const [made, setMade] = useState<GenericResult | null>(null)

  const templates = useQuery({
    queryKey: ['role-templates'],
    queryFn: () => api.get<List<RoleTemplate>>('/api/v1/admin/roles/templates'),
  })

  const create = useMutation({
    mutationFn: () =>
      api.post<GenericResult>('/api/v1/admin/users/generic', {
        ...f,
        role_name: f.role_name || undefined,
        copy_from: copyFrom || undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      setMade(res)
    },
  })

  return (
    <Card>
      <CardHeader
        title="Custom account"
        description="An account with a role of its own. Start from a preset or from nothing, then dial exactly what it can see and edit on the role grid."
        action={
          <Button size="sm" variant="ghost" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        }
      />
      <div className="space-y-4 px-5 py-4">
        {made ? (
          <>
            <FormNotice ok={made.note} />
            <FormGrid>
              <Field label="Temporary password" hint={made.password_note}>
                <Input value={made.temporary_password} onChange={() => {}} />
              </Field>
              <Field label="Its role" hint={`${made.copied_permissions} permissions to start with.`}>
                <Input value={made.role_name} onChange={() => {}} />
              </Field>
            </FormGrid>
            <p className="text-[13px] text-muted-foreground">
              Open Roles &amp; permissions and pick <strong>{made.role_name}</strong> to set what
              it can see and how far that reaches.
            </p>
          </>
        ) : (
          <>
            <FormGrid>
              <Field label="Name" required>
                <Input
                  value={f.full_name}
                  onChange={(v) => setF({ ...f, full_name: v })}
                  placeholder="e.g. Correspondent"
                />
              </Field>
              <Field label="Email">
                <Input value={f.email} onChange={(v) => setF({ ...f, email: v })} />
              </Field>
              <Field label="Phone" hint="An email or a phone — it needs something to sign in with.">
                <Input value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
              </Field>
              <Field label="Call the role" hint="Defaults to the person’s name.">
                <Input
                  value={f.role_name}
                  onChange={(v) => setF({ ...f, role_name: v })}
                  placeholder="e.g. Correspondent"
                />
              </Field>
            </FormGrid>

            <Field
              label="Start from a preset"
              hint="Accounts, HR and the rest are starting points, not the only shapes a school can have. Leave this empty and the account starts able to see nothing."
            >
              <Select
                value={copyFrom}
                onChange={setCopyFrom}
                placeholder="Start from nothing"
                options={(templates.data?.items ?? []).map((t) => ({
                  value: t.key,
                  label: `${t.name} · ${t.permissions} permissions`,
                }))}
              />
            </Field>

            <FormNotice error={create.error} />

            <div className="flex items-center gap-3">
              <Button
                onClick={() => create.mutate()}
                disabled={
                  !f.full_name.trim() ||
                  (!f.email.trim() && !f.phone.trim()) ||
                  create.isPending
                }
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {create.isPending ? 'Creating…' : 'Create account and role'}
              </Button>
              <span className="text-[13px] text-muted-foreground">
                {copyFrom
                  ? 'Starts with that preset’s permissions, and every one of them can be changed.'
                  : 'Starts able to sign in and see nothing.'}
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}
