import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  KeyRound, Laptop, Pencil, ShieldAlert, ShieldCheck, UserCheck, UserPlus, UserX, X,
} from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, ConfirmButton, Select, Input, Reload, SkeletonTable, ErrorState,
  Field, FormGrid, FormNotice,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { RolePicker, useRoleCatalog } from '../super_admin/RolePicker'

/* Who can sign in to this school.

   The endpoints behind this screen have existed all along, and the
   institution_admin role has held access.users.read, access.users.write,
   access.roles.read, access.roles.write and access.sessions.revoke since the
   role was defined as every non-platform key. What did not exist was any way
   for a principal to reach them: the only catalogued screens over logins were
   super_admin.access_security.users and its sibling audit, and a school
   administrator has no super_admin workspace. So the permission was real and
   the product offered no door.

   The cost of that is not theoretical. One school on this installation is
   carrying 103 active logins belonging to staff, students and guardians whose
   records were deleted -- accounts that can still sign in, still hold their
   roles, and that nobody at the school could see, let alone close.

   This is a school-scoped screen rather than the platform directory rendered
   for a second audience. super_admin/Users.tsx answers a platform question:
   it carries a School column beside every name, because its job is to look
   across tenants, and it has nothing to say about sessions or about a login
   whose person is gone. Those two omissions are precisely the school's
   question. Reusing it with the column hidden would have left a principal a
   screen shaped around somebody else's problem -- which is why
   institution_admin.staff.roles_permissions reuses RolesPermissions unchanged
   (the role grid asks the same question of both audiences) and this one does
   not. */

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
  active_sessions: number
  /** 'staff' | 'student' | 'guardian' | 'none' */
  record: string
}

interface SessionRow {
  id: string
  user_id: string
  full_name: string
  ip?: string
  user_agent?: string
  created_at: string
  last_seen_at: string
  expires_at: string
  revoked: boolean
}

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  active: 'success',
  suspended: 'danger',
  invited: 'warning',
  archived: 'neutral',
}

const RECORD_LABEL: Record<string, string> = {
  staff: 'Staff',
  student: 'Student',
  guardian: 'Guardian',
  none: 'No record',
}

/** Collapses a user-agent string to something readable in a table cell. */
function agent(ua?: string) {
  if (!ua) return 'Unknown device'
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Other'
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${browser} on ${os}` : browser
}

export default function Logins() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [record, setRecord] = useState('')

  const params = new URLSearchParams()
  if (search.trim()) params.set('q', search.trim())
  if (status) params.set('status', status)

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['school-logins', params.toString()],
    queryFn: () => api.get<List<AdminUser>>(`/api/v1/admin/users?${params}`),
  })

  const { roles, presets } = useRoleCatalog()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [devicesFor, setDevicesFor] = useState<AdminUser | null>(null)

  const setStatusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.put(`/api/v1/admin/users/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['school-logins'] }),
  })

  const all = data?.items ?? []
  /* The record filter is applied here rather than sent to the server. The
     directory is capped at 200 rows by the endpoint and the orphan count has
     to be honest about the same page the table is showing, so counting and
     filtering the one list keeps the headline number and the rows below it
     describing the same thing. */
  const users = record ? all.filter((u) => u.record === record) : all
  const active = all.filter((u) => u.status === 'active').length
  const signedIn = all.filter((u) => u.active_sessions > 0).length
  const orphans = all.filter((u) => u.record === 'none' && u.status === 'active')

  return (
    <>
      <PageHead
        eyebrow="Staff"
        title="Logins & access"
        description="Every account that can sign in to this school, what it can reach, and the devices it is signed in on right now."
        actions={
          <Button onClick={() => { setEditing(null); setDevicesFor(null); setCreating((c) => !c) }}>
            {creating ? <X className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
            {creating ? 'Cancel' : 'Issue a login'}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Logins" value={all.length} icon={ShieldCheck} />
          <Stat label="Can sign in" value={active} hint={`${all.length - active} cannot`} />
          <Stat label="Signed in now" value={signedIn} hint="Holding a live session" />
          <Stat
            label="No linked record"
            value={orphans.length}
            icon={ShieldAlert}
            hint="Active logins whose person is gone"
          />
        </CellGrid>

        {/* An account outlives the person it was made for.

            Deleting a student, a guardian link or an employee removes the
            record, not the login. The account stays active, keeps its roles
            and can still sign in, and until this screen existed nobody at the
            school could see that had happened. Naming it at the top rather
            than leaving it to be noticed in a column is the difference between
            a fact being available and a fact being known. */}
        {orphans.length > 0 && record !== 'none' && (
          <Card className="p-5">
            <p className="text-[14px] font-medium">
              {orphans.length} active login{orphans.length === 1 ? ' has' : 's have'} no staff,
              student or guardian record
            </p>
            <p className="mt-1 text-[14px] text-muted-foreground">
              Deleting somebody’s record does not close their login. These accounts can still
              sign in. Review them and deactivate the ones that should be closed — deactivating
              also signs out every device they are currently on.
            </p>
            <div className="mt-3">
              <Button size="sm" variant="secondary" onClick={() => setRecord('none')}>
                Show them
              </Button>
            </div>
          </Card>
        )}

        {creating && (
          <AccountForm roles={roles} presets={presets} onClose={() => setCreating(false)} />
        )}
        {editing && (
          <AccountForm
            roles={roles}
            presets={presets}
            user={editing}
            onClose={() => setEditing(null)}
          />
        )}
        {devicesFor && (
          <Devices user={devicesFor} onClose={() => setDevicesFor(null)} />
        )}

        <Card>
          <CardHeader
            title="Logins"
            description={`${users.length} of ${all.length} account${all.length === 1 ? '' : 's'}`}
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
                <Select
                  value={record}
                  onChange={setRecord}
                  placeholder="Anybody"
                  options={[
                    { value: 'staff', label: 'Staff' },
                    { value: 'student', label: 'Students' },
                    { value: 'guardian', label: 'Guardians' },
                    { value: 'none', label: 'No record' },
                  ]}
                />
                <Reload onClick={() => refetch()} busy={isFetching} label="Re-read the list" />
              </>
            }
          />
          {isLoading ? (
            <SkeletonTable columns={8} />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table
              head={['Name', 'Contact', 'Belongs to', 'Roles', 'Devices', 'Last sign-in', 'Status', '']}
              empty={!users.length}
              emptyLabel="No logins match those filters."
            >
              {users.map((u) => (
                <tr key={u.id}>
                  <Td className="font-medium">
                    {u.full_name}
                    {u.mfa_enabled && (
                      <ShieldCheck
                        className="ml-1.5 inline h-3.5 w-3.5 text-success"
                        aria-label="Two-factor on"
                      />
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{u.email ?? u.phone ?? '—'}</Td>
                  <Td>
                    <Badge tone={u.record === 'none' ? 'danger' : 'neutral'}>
                      {RECORD_LABEL[u.record] ?? u.record}
                    </Badge>
                  </Td>
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
                  <Td>
                    {u.active_sessions ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="The devices this account is signed in on"
                        onClick={() => { setCreating(false); setEditing(null); setDevicesFor(u) }}
                      >
                        <Laptop className="h-3.5 w-3.5" /> {u.active_sessions}
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(u.last_login_at)}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[u.status] ?? 'neutral'}>{u.status}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Change roles, or reset the password"
                      onClick={() => { setCreating(false); setDevicesFor(null); setEditing(u) }}
                    >
                      <Pencil className="h-3.5 w-3.5" /> Roles
                    </Button>
                    {u.status === 'active' ? (
                      /* Deactivating signs the person out of every device in
                         the same transaction on the server. It is still a real
                         person losing access mid-task, so it is confirmed by
                         name: this table is long and the rows look alike. */
                      <ConfirmButton
                        tone="danger"
                        disabled={setStatusMut.isPending}
                        question={`Deactivate ${u.full_name}? They will be signed out of every device and cannot sign in again until reactivated.`}
                        confirmLabel="Deactivate"
                        onConfirm={() => setStatusMut.mutate({ id: u.id, status: 'suspended' })}
                      >
                        <UserX className="h-3.5 w-3.5" /> Deactivate
                      </ConfirmButton>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={setStatusMut.isPending}
                        onClick={() => setStatusMut.mutate({ id: u.id, status: 'active' })}
                      >
                        <UserCheck className="h-3.5 w-3.5" /> Reactivate
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {setStatusMut.isError && (
            <div className="border-t px-5 py-3">
              <FormNotice error={setStatusMut.error} />
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}

/* The devices one account is signed in on.

   Deactivating an account ends every session, which is the blunt answer and
   usually the right one. This is the other one: a teacher who left a browser
   signed in at an internet cafe should lose that session without losing their
   job. The list is asked for per user rather than filtered in the browser,
   because the whole-school session list is capped at 200 rows and a school
   large enough to hit that cap is exactly the school that needs this. */
function Devices({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['school-logins-sessions', user.id],
    queryFn: () =>
      api.get<List<SessionRow>>(`/api/v1/admin/sessions?active=true&user=${user.id}`),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/admin/sessions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['school-logins-sessions', user.id] })
      qc.invalidateQueries({ queryKey: ['school-logins'] })
    },
  })

  const rows = data?.items ?? []

  return (
    <Card>
      <CardHeader
        title={`${user.full_name} is signed in here`}
        description="Signing a device out takes effect immediately. The person keeps their account and can sign in again."
        action={
          <Button size="sm" variant="ghost" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        }
      />
      {isLoading ? (
        <SkeletonTable columns={5} />
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <Table
          head={['Device', 'Address', 'Signed in', 'Last seen', '']}
          empty={!rows.length}
          emptyLabel="Not signed in on any device right now."
        >
          {rows.map((s) => (
            <tr key={s.id}>
              <Td className="font-medium">{agent(s.user_agent)}</Td>
              <Td className="font-mono text-[12px]">{s.ip ?? '—'}</Td>
              <Td className="text-muted-foreground">{formatDate(s.created_at)}</Td>
              <Td className="text-muted-foreground">{formatDate(s.last_seen_at)}</Td>
              <Td>
                <ConfirmButton
                  tone="danger"
                  disabled={revoke.isPending}
                  question={`Sign ${user.full_name} out of this device now?`}
                  confirmLabel="Sign out"
                  onConfirm={() => revoke.mutate(s.id)}
                >
                  Sign out
                </ConfirmButton>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {revoke.isError && (
        <div className="border-t px-5 py-3">
          <FormNotice error={revoke.error} />
        </div>
      )}
    </Card>
  )
}

/* Issuing a login and re-roling one are the same decision at two moments.

   The school's commonest access change is the second: the clerk who takes over
   the fee counter. Splitting the two into separate screens buries it, so this
   is one form with the identity fields shown only when there is no account
   yet. Password reset sits in the same place, because the person asking for it
   is standing at the same row.

   This deliberately mirrors super_admin/Users.tsx rather than importing its
   form: that one is embedded in a platform screen and carries the hand-over
   and custom-role flows a principal does not need next to this. */
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
  const [f, setF] = useState({
    full_name: user?.full_name ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
  })
  // Keys, not display names: the picker toggles on key, and seeding it with
  // names leaves every role unticked and saves an empty set.
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
      /* The server answers with the role keys it could not resolve. Reading it
         matters: a save that applied none looks identical to one that worked,
         and role assignment is replace-semantics, so silence there means every
         role the account had was removed. */
      const unknown = (res as { unknown_roles?: string[] } | undefined)?.unknown_roles
      if (unknown?.length) {
        setNotice(`The server did not recognise: ${unknown.join(', ')}. Nothing was changed.`)
        return
      }
      qc.invalidateQueries({ queryKey: ['school-logins'] })
      const pw = (res as { temporary_password?: string } | undefined)?.temporary_password
      if (pw) setTempPassword(pw)
      else onClose()
    },
  })

  const [chosen, setChosen] = useState('')
  const [resetNote, setResetNote] = useState<string | null>(null)
  const reset = useMutation({
    mutationFn: (pw: string) =>
      api.post<{ temporary_password?: string }>(
        `/api/v1/admin/users/${user!.id}/reset-password`,
        pw ? { new_password: pw } : {},
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['school-logins'] })
      if (res?.temporary_password) {
        setTempPassword(res.temporary_password)
        return
      }
      // Not echoed back, because the administrator typed it. Saying so beats a
      // screen that appears to have done nothing.
      setChosen('')
      setResetNote('That password is in effect and every device of theirs is signed out.')
    },
  })

  if (tempPassword) {
    return (
      <Card className="p-5">
        <p className="text-[14px] font-medium">Password issued</p>
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
        title={editing ? `${user!.full_name}’s access` : 'Issue a login'}
        description={
          editing
            ? 'Adding a role grants a whole workspace; removing one takes it away the next time they sign in.'
            : 'A person, not a job title. Give them everything they do — one login for all of it.'
        }
        action={
          <Button variant="ghost" size="sm" onClick={onClose} title="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        }
      />
      <div className="space-y-5 px-5 py-5">
        {!editing && (
          <FormGrid>
            <Field label="Full name" required>
              <Input
                value={f.full_name}
                onChange={(x) => setF({ ...f, full_name: x })}
                placeholder="Lakshmi Reddy"
              />
            </Field>
            <Field label="Email" hint="Either an email or a phone is needed to sign in.">
              <Input type="email" value={f.email} onChange={(x) => setF({ ...f, email: x })} />
            </Field>
            <Field label="Phone">
              <Input
                value={f.phone}
                onChange={(x) => setF({ ...f, phone: x })}
                placeholder="9848012345"
              />
            </Field>
          </FormGrid>
        )}

        <RolePicker value={picked} onChange={setPicked} roles={roles} presets={presets} />

        {editing && (
          <div className="border-t pt-5">
            <Field
              label="Set a password"
              hint="At least 12 characters. Leave it empty to have one generated and shown once instead."
            >
              <Input
                type="password"
                value={chosen}
                onChange={(x) => { setChosen(x); setResetNote(null) }}
                placeholder="Leave empty to generate one"
              />
            </Field>
          </div>
        )}

        <FormNotice
          error={save.error ?? reset.error ?? (notice ? new Error(notice) : undefined)}
          ok={resetNote ?? undefined}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || (!editing && !f.full_name.trim())}
          >
            {save.isPending ? 'Saving…' : editing ? 'Save roles' : 'Issue the login'}
          </Button>
          {editing && (
            <Button
              variant="secondary"
              onClick={() => reset.mutate(chosen.trim())}
              disabled={reset.isPending || (chosen.trim() !== '' && chosen.trim().length < 12)}
            >
              <KeyRound className="h-3.5 w-3.5" />
              {reset.isPending
                ? 'Resetting…'
                : chosen.trim()
                  ? 'Set this password'
                  : 'Reset password'}
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
