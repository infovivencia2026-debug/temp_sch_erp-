import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check, KeyRound, Laptop, Pencil, ShieldAlert, ShieldCheck, UserCheck, UserPlus, UserX, X,
} from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, ConfirmButton, Select, Input, Reload, SkeletonTable, ErrorState,
  Field, FormGrid, FormNotice,
} from '@/components/ui'
import { SearchBox } from '@/components/rows'
import { cn, formatDate } from '@/lib/utils'
import { RolePicker, useRoleCatalog, type Role } from '../super_admin/RolePicker'

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

interface CampusRow {
  id: string
  name: string
  code: string
}

interface UserDetail {
  campus_ids: string[]
  all_campuses: boolean
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
    // Walked to the END, page by page. The endpoint returns 200 at a time; a
    // school whose students each have a login runs well past that, and a single
    // fetch showed only the first 200 -- so people were simply missing from the
    // list. Every page is pulled and concatenated so the whole roll is shown
    // (and the record filter and the counts below see everyone).
    queryFn: async () => {
      const items: AdminUser[] = []
      for (let offset = 0; ; offset += 200) {
        const p = new URLSearchParams(params)
        p.set('offset', String(offset))
        const page = await api.get<List<AdminUser>>(`/api/v1/admin/users?${p}`)
        items.push(...(page.items ?? []))
        if ((page.items?.length ?? 0) < 200) break
      }
      return { items } as List<AdminUser>
    },
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

        <DayCodeCard />

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
  const [sent, setSent] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /* The campuses this account is posted to. Empty means every campus — the
     default, and the whole of a single-campus school. The selector is only
     shown once there is more than one campus to choose between (see below), so
     for most schools this stays empty and nothing changes. */
  const campusList = useQuery({
    queryKey: ['setup-campuses'],
    queryFn: () => api.get<List<CampusRow>>('/api/v1/setup/campuses'),
  })
  const campuses = campusList.data?.items ?? []
  const multiCampus = campuses.length > 1

  /* Prefill when editing. The list row does not carry campuses, so the account
     detail is fetched for its campus_ids; until it arrives the state is null so
     an empty payload is never saved over a real restriction. */
  const detail = useQuery({
    enabled: editing,
    queryKey: ['user-detail', user?.id],
    queryFn: () => api.get<UserDetail>(`/api/v1/admin/users/${user!.id}`),
  })
  const [campusIDs, setCampusIDs] = useState<string[] | null>(editing ? null : [])
  if (editing && campusIDs === null && detail.data) {
    setCampusIDs(detail.data.all_campuses ? [] : (detail.data.campus_ids ?? []))
  }
  const toggleCampus = (id: string) =>
    setCampusIDs((prev) => {
      const set = new Set(prev ?? [])
      if (set.has(id)) set.delete(id)
      else set.add(id)
      return [...set]
    })

  const save = useMutation({
    mutationFn: async () => {
      const campus_ids = campusIDs ?? []
      if (editing) {
        return api.put(`/api/v1/admin/users/${user!.id}/roles`, { role_keys: picked, campus_ids })
      }
      return api.post<{ temporary_password?: string; sent_by?: string; sent_to?: string }>('/api/v1/admin/users', {
        ...f,
        role_keys: picked,
        campus_ids,
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
      const pw = (res as { temporary_password?: string; sent_by?: string; sent_to?: string } | undefined)?.temporary_password
      if (pw) {
        setSent(sentLine(res as { sent_by?: string; sent_to?: string }))
        setTempPassword(pw)
      } else onClose()
    },
  })

  const [chosen, setChosen] = useState('')
  const [resetNote, setResetNote] = useState<string | null>(null)
  const reset = useMutation({
    mutationFn: (pw: string) =>
      api.post<{ temporary_password?: string; note?: string; sent_by?: string; sent_to?: string }>(
        `/api/v1/admin/users/${user!.id}/reset-password`,
        pw ? { new_password: pw } : {},
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['school-logins'] })
      if (res?.temporary_password) {
        /* The server now echoes a typed password as well as a generated one,
           so this is the ordinary path rather than the generated-only one. Its
           own sentence is preferred over ours, because only it knows which of
           the two happened. */
        setSent(sentLine(res) ?? res.note ?? null)
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
          {sent ?? 'Give them this one-time password. It is shown once and cannot be retrieved later.'}
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

        {/* Campuses, only when there is more than one to choose from — a
            single-campus school has nothing to pick and the row would be noise.
            Nothing selected means every campus, which is what most accounts
            want and what the server stores as an institution-wide grant. */}
        {multiCampus && (!editing || campusIDs !== null) && (
          <div className="border-t pt-5">
            <div className="mb-2 flex items-baseline justify-between">
              <p className="eyebrow">Campuses</p>
              <span className="text-[13px] text-muted-foreground">
                {(campusIDs ?? []).length === 0
                  ? 'All campuses'
                  : `${(campusIDs ?? []).length} of ${campuses.length}`}
              </span>
            </div>
            <p className="mb-3 text-[13px] text-muted-foreground">
              Which campuses this account can reach. Leave all unselected to give it every campus.
            </p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {campuses.map((c) => {
                const on = (campusIDs ?? []).includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleCampus(c.id)}
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
                      <span className="block text-[14px]">{c.name}</span>
                      <span className="mt-0.5 block font-mono text-[12px] text-muted-foreground">
                        {c.code}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {editing && <PermissionOverrides user={user!} pickedRoles={picked} roles={roles} />}

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

/* One account's extra capabilities, beyond what its roles give.

   Roles are the right unit for almost everybody, but now and then a single
   login needs one key that no role it holds carries — and the alternatives were
   inventing a whole role for one grant, or widening a shared role and handing
   the key to everyone in it. This is the narrow door: a direct grant to this
   account alone, unioned with the role-based keys at sign-in.

   The two are kept visibly apart. A key a role already grants shows ticked and
   locked, labelled "from a role", because taking it away means editing the role
   and not this account. Everything else is a plain toggle, and Save replaces
   the direct set. */
interface PermCatalogItem {
  key: string
  module: string
  description: string
}
interface UserPerms {
  user_id: string
  role_keys: string[]
  direct_keys: string[]
}

// One grantable feature in the "Individual features" exception editor, as served
// by GET /api/v1/admin/features — a flat list de-duplicated by name. `key` is the
// canonical variant to grant; `keys` are ALL variant keys sharing this name, so
// the feature reads as "held" if the account holds any of them and revoking
// clears every variant.
interface FeatureItem {
  key: string
  keys: string[]
  name: string
  summary: string
  unlocks: string[]
}

const MODULE_LABEL: Record<string, string> = {
  students: 'Students',
  academics: 'Academics',
  finance: 'Finance',
  admissions: 'Admissions',
  office: 'Front office',
  hr: 'HR & payroll',
  operations: 'Operations',
  welfare: 'Welfare',
  comms: 'Communication',
  institution: 'Institution',
  access: 'Access & roles',
  admin: 'Administration',
  platform: 'Platform',
  self: 'Self-service',
}

function PermissionOverrides({
  user,
  pickedRoles,
  roles,
}: {
  user: AdminUser
  pickedRoles: string[]
  roles: Role[]
}) {
  const qc = useQueryClient()
  const catalog = useQuery({
    queryKey: ['permission-catalog'],
    queryFn: () => api.get<List<PermCatalogItem>>('/api/v1/admin/permissions'),
  })
  const current = useQuery({
    queryKey: ['user-permissions', user.id],
    queryFn: () => api.get<UserPerms>(`/api/v1/admin/users/${user.id}/permissions`),
  })
  const features = useQuery({
    queryKey: ['feature-catalog'],
    queryFn: () => api.get<List<FeatureItem>>('/api/v1/admin/features'),
  })
  // The feature-tile search. Local to this editor; the tile list is long.
  const [featureSearch, setFeatureSearch] = useState('')

  // The direct set the editor is building. Seeded once the account's current
  // grants arrive; a plain Set kept in a piece of state keyed off the load.
  const [direct, setDirect] = useState<string[] | null>(null)
  const loaded = current.data?.direct_keys
  if (direct === null && loaded) setDirect(loaded)

  /* What the roles grant, computed from the roles ticked RIGHT NOW rather than
     from what was last saved. Tick "Admissions & Front Office" and its keys
     light up ticked-and-locked here immediately, before Save. Falls back to the
     server's role_keys until the role catalogue has loaded, so nothing flickers
     on first paint. */
  const pickedSet = new Set(pickedRoles)
  const liveRoleKeys = roles
    .filter((r) => pickedSet.has(r.key))
    .flatMap((r) => r.permission_keys ?? [])
  const roleKeys = new Set(liveRoleKeys.length ? liveRoleKeys : current.data?.role_keys ?? [])
  const picked = new Set(direct ?? [])

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/admin/users/${user.id}/permissions`, {
        permission_keys: direct ?? [],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-permissions', user.id] })
      qc.invalidateQueries({ queryKey: ['school-logins'] })
    },
  })

  if (catalog.isLoading || current.isLoading) {
    return (
      <div className="border-t pt-5">
        <p className="eyebrow mb-2">Extra permissions</p>
        <p className="text-[13px] text-muted-foreground">Loading the permission list…</p>
      </div>
    )
  }
  if (catalog.error || current.error) {
    return (
      <div className="border-t pt-5">
        <FormNotice error={catalog.error ?? current.error} />
      </div>
    )
  }

  const toggle = (key: string) =>
    setDirect((prev) => {
      const set = new Set(prev ?? [])
      if (set.has(key)) set.delete(key)
      else set.add(key)
      return [...set]
    })

  // Group the catalogue by module, in the order the modules first appear.
  const items = catalog.data?.items ?? []
  const groups: { module: string; items: PermCatalogItem[] }[] = []
  const byModule = new Map<string, PermCatalogItem[]>()
  for (const it of items) {
    if (!byModule.has(it.module)) {
      byModule.set(it.module, [])
      groups.push({ module: it.module, items: byModule.get(it.module)! })
    }
    byModule.get(it.module)!.push(it)
  }

  const extraCount = (direct ?? []).filter((k) => !roleKeys.has(k)).length

  /* The individual-feature exception editor. A grant here is a catalog feature
     key held directly, seeded from the same direct set (so it saves in the one
     PUT alongside the capability picks above and never overwrites them). The
     list is flat and de-duplicated by name, searchable by name (ranked first)
     or summary — it is long. */
  const featureItems = features.data?.items ?? []
  const q = featureSearch.trim().toLowerCase()
  const shownFeatures = q
    ? featureItems
        .filter((f) => f.name.toLowerCase().includes(q) || f.summary.toLowerCase().includes(q))
        // Name matches rank above summary-only matches; order is otherwise stable.
        .sort((a, b) => {
          const an = a.name.toLowerCase().includes(q) ? 0 : 1
          const bn = b.name.toLowerCase().includes(q) ? 0 : 1
          return an - bn
        })
    : featureItems

  // A feature is held if the account holds ANY of its variant keys.
  const featureHeld = (f: FeatureItem) => f.keys.some((k) => picked.has(k))
  // Toggle ON adds the canonical key; toggle OFF removes every variant key.
  const toggleFeature = (f: FeatureItem) =>
    setDirect((prev) => {
      const set = new Set(prev ?? [])
      if (featureHeld(f)) {
        for (const k of f.keys) set.delete(k)
      } else {
        set.add(f.key)
      }
      return [...set]
    })

  return (
    <div className="flex flex-col border-t pt-5">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="eyebrow">Extra permissions</p>
        <span className="text-[13px] text-muted-foreground">
          {extraCount} beyond this account’s roles
        </span>
      </div>
      <p className="mb-3 text-[13px] text-muted-foreground">
        A role grants a whole workspace. This adds one capability to this account only, on top of
        its roles. Keys a role already grants are ticked and locked — change those by editing the
        role.
      </p>

      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.module}>
            <p className="mb-1.5 text-[13px] font-medium">{MODULE_LABEL[g.module] ?? g.module}</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {g.items.map((it) => {
                const fromRole = roleKeys.has(it.key)
                const on = fromRole || picked.has(it.key)
                return (
                  <button
                    key={it.key}
                    type="button"
                    disabled={fromRole}
                    onClick={() => !fromRole && toggle(it.key)}
                    className={cn(
                      'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                      fromRole
                        ? 'cursor-default border-border bg-muted/50'
                        : on
                          ? 'border-primary/40 bg-accent'
                          : 'hover:bg-accent/60',
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
                      <span className="block text-[14px]">{it.description}</span>
                      <span className="mt-0.5 flex items-center gap-1.5">
                        <span className="block font-mono text-[12px] text-muted-foreground">
                          {it.key}
                        </span>
                        {fromRole && (
                          <Badge tone="neutral">from a role</Badge>
                        )}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="order-first mb-5 border-b pb-5">
        <p className="eyebrow mb-1">Individual features (exception — prefer roles)</p>
        <p className="mb-3 text-[13px] text-muted-foreground">
          Normal access should come from a role, which carries a whole workspace. Use this only for a
          one-off: switch on a single menu tile — Take attendance, Class 360, Student 360 — for this
          one account. Enabling a tile also grants the capabilities the screen needs, noted under
          each.
        </p>

        {features.isLoading ? (
          <p className="text-[13px] text-muted-foreground">Loading the feature list…</p>
        ) : features.error ? (
          <FormNotice error={features.error} />
        ) : (
          <>
            <div className="mb-3">
              <SearchBox
                value={featureSearch}
                onChange={setFeatureSearch}
                placeholder="Search features by name"
                className="w-full"
              />
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {shownFeatures.map((f) => {
                const on = featureHeld(f)
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => toggleFeature(f)}
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
                      <span className="block text-[14px] font-medium">{f.name}</span>
                      {f.summary && (
                        <span className="mt-0.5 block text-[12px] text-muted-foreground">
                          {f.summary}
                        </span>
                      )}
                      {f.unlocks.length > 0 && (
                        <span className="mt-0.5 block text-[12px] text-muted-foreground">
                          Also grants: {f.unlocks.join(', ')}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
            {shownFeatures.length === 0 && (
              <p className="text-[13px] text-muted-foreground">No features match.</p>
            )}
          </>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save extra permissions'}
        </Button>
        {save.isSuccess && !save.isPending && (
          <span className="text-[13px] text-muted-foreground">
            Saved. Takes effect the next time they sign in.
          </span>
        )}
      </div>
      {save.isError && (
        <div className="mt-3">
          <FormNotice error={save.error} />
        </div>
      )}
    </div>
  )
}

/* Where the password also went, in one sentence, or the hand-over line when
   the account has no contact a message could reach. */
function sentLine(res: { sent_by?: string; sent_to?: string } | undefined): string | null {
  if (!res?.sent_to) return null
  const by = res.sent_by === 'email' ? 'email' : res.sent_by === 'whatsapp' ? 'WhatsApp' : 'SMS'
  return `Sent to ${res.sent_to} by ${by}. It is also shown here once, in case that does not arrive.`
}


/* The teachers' daily sign-in code.

   A teacher signing in on the classroom panel types her password with the
   class watching the keyboard. This is the school's alternative: one
   six-digit code, the same for every teacher, new every day, typed in the
   password box instead. It expires at midnight, and a session it opened
   cannot change the password -- so what a child learns by watching is
   worth until the bell, and no more. Only accounts with a teaching role
   (faculty, head of department) can use it; the office and the principal
   still sign in with their own passwords.

   The code is shown here for the office to put on the staffroom board, and
   on each teacher's own profile so it reaches them on their phone. */
interface DayCodeState {
  enabled: boolean
  code?: string
  date?: string
  expires_at?: string
}

function DayCodeCard() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['day-code'],
    queryFn: () => api.get<DayCodeState>('/api/v1/admin/day-code'),
  })
  const set = useMutation({
    mutationFn: (body: { enabled: boolean; rotate?: boolean }) =>
      api.put<DayCodeState>('/api/v1/admin/day-code', body),
    onSuccess: (d) => qc.setQueryData(['day-code'], d),
  })
  if (isLoading || !data) return null
  return (
    <Card>
      <CardHeader
        title="Classroom sign-in code"
        action={
          data.enabled ? (
            <div className="flex flex-wrap gap-2">
              <ConfirmButton
                confirmLabel="New code"
                question="Today's code stops working now and every teacher gets the new one."
                onConfirm={() => set.mutate({ enabled: true, rotate: true })}
                disabled={set.isPending}
              >
                New code now
              </ConfirmButton>
              <ConfirmButton
                confirmLabel="Switch off"
                question="Teachers will need their own password on classroom screens from now."
                onConfirm={() => set.mutate({ enabled: false })}
                disabled={set.isPending}
                tone="danger"
              >
                Switch off
              </ConfirmButton>
            </div>
          ) : (
            <Button size="sm" onClick={() => set.mutate({ enabled: true })} disabled={set.isPending}>
              <KeyRound className="h-3.5 w-3.5" />
              Switch on
            </Button>
          )
        }
      />
      <div className="p-5">
        {data.enabled ? (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <div>
              <p className="text-[12px] uppercase tracking-wide text-muted-foreground">Today, {formatDate(data.date!)}</p>
              <p className="mt-1 font-mono text-[34px] font-semibold tracking-[0.18em] tabular-nums">{data.code}</p>
            </div>
            <p className="max-w-md text-[14px] text-muted-foreground">
              Teachers type this in the password box instead of their password when signing in on
              a classroom screen. It changes at midnight, and a sign-in that used it cannot change
              the password. Each teacher can also read it on their own profile.
            </p>
          </div>
        ) : (
          <p className="max-w-2xl text-[14px] text-muted-foreground">
            Off. A teacher signing in on a classroom screen types their own password in front of
            the class. Switch this on to give teachers one shared six-digit code, new every day,
            that works in place of the password for teaching accounts only.
          </p>
        )}
        <FormNotice error={set.error} />
      </div>
    </Card>
  )
}
