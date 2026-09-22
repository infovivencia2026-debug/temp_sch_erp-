import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Laptop, LogOut, ShieldAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  Card, CardHeader, Table, Td, Badge, Button, ConfirmButton, Input, SkeletonTable, ErrorState, FormNotice,
} from '@/components/ui'
import { formatDateTime } from '@/lib/utils'

/* The principal's security desk: three cards that sit on Logins & access.

   Who is online right now, school-wide, with the flags worth a second look
   and the lever that signs everyone out. The sign-in attempts that failed
   this week -- the pattern a process log used to swallow. And the rules a
   session lives by, per role, with the built-in default shown until the
   school chooses otherwise. */

interface LiveSession {
  id: string
  user_id: string
  full_name: string
  ip?: string
  device: string
  via: string
  ended_reason?: string
  created_at: string
  last_seen_at: string
  revoked: boolean
  roles: string[]
  flags: string[]
}

const FLAG_LABEL: Record<string, { label: string; title: string }> = {
  after_hours: { label: 'After hours', title: 'A staff sign-in between 10 pm and 6 am' },
  many_devices: { label: 'Many devices', title: 'This account holds more than three live sessions' },
  new_device: { label: 'New device', title: 'A money-handling account on a device it has not used before' },
  no_record: { label: 'No record', title: 'The person behind this login has been deleted' },
  failed_first: { label: 'Failed first', title: 'Three or more wrong passwords in the half hour before this sign-in' },
}

export function OnlineNow() {
  const qc = useQueryClient()
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const { data, isLoading, error } = useQuery({
    queryKey: ['sessions-live'],
    queryFn: () => api.get<List<LiveSession>>('/api/v1/admin/sessions/live'),
    refetchInterval: 60_000,
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/admin/sessions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions-live'] })
      qc.invalidateQueries({ queryKey: ['school-logins'] })
    },
  })
  const everyone = useMutation({
    mutationFn: () => api.del('/api/v1/admin/sessions?all=true'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions-live'] })
      qc.invalidateQueries({ queryKey: ['school-logins'] })
    },
  })
  const all = data?.items ?? []
  const rows = flaggedOnly ? all.filter((s) => s.flags.length) : all
  const flagged = all.filter((s) => s.flags.length).length

  return (
    <Card>
      <CardHeader
        title={`Online now · ${all.length}`}
        description={
          flagged
            ? `${flagged} sign-in${flagged === 1 ? '' : 's'} carry a flag worth a look.`
            : 'Every live sign-in at the school, most recent activity first. Refreshes every minute.'
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setFlaggedOnly((v) => !v)}>
              {flaggedOnly ? 'Show all' : 'Flagged only'}
            </Button>
            <ConfirmButton
              tone="danger"
              disabled={everyone.isPending || all.length === 0}
              question="Sign every device at the school out now, except yours? Everyone signs in again with their password."
              confirmLabel="Sign everyone out"
              onConfirm={() => everyone.mutate()}
            >
              <LogOut className="h-3.5 w-3.5" /> Sign everyone out
            </ConfirmButton>
          </div>
        }
      />
      {isLoading ? (
        <SkeletonTable columns={6} />
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <Table
          head={['Who', 'Device', 'Address', 'Signed in', 'Last active', '']}
          empty={!rows.length}
          emptyLabel={flaggedOnly ? 'Nothing flagged right now.' : 'Nobody is signed in right now.'}
        >
          {rows.map((s) => (
            <tr key={s.id}>
              <Td>
                <div className="font-medium">{s.full_name}</div>
                <div className="text-[12px] text-muted-foreground">{s.roles.join(', ') || '—'}</div>
                {s.flags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.flags.map((f) => (
                      <Badge key={f} tone={f === 'no_record' || f === 'failed_first' ? 'danger' : 'warning'}>
                        <span title={FLAG_LABEL[f]?.title}>{FLAG_LABEL[f]?.label ?? f}</span>
                      </Badge>
                    ))}
                  </div>
                )}
              </Td>
              <Td>
                <span className="inline-flex items-center gap-1.5">
                  <Laptop className="h-3.5 w-3.5 text-muted-foreground" /> {s.device}
                </span>
                {s.via !== 'password' && <div className="text-[12px] text-muted-foreground">via {s.via.replace('_', ' ')}</div>}
              </Td>
              <Td className="font-mono text-[12px]">{s.ip ?? '—'}</Td>
              <Td className="text-muted-foreground">{formatDateTime(s.created_at)}</Td>
              <Td className="text-muted-foreground">{formatDateTime(s.last_seen_at)}</Td>
              <Td>
                <ConfirmButton
                  tone="danger"
                  disabled={revoke.isPending}
                  question={`Sign ${s.full_name} out of this device now?`}
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
      {(revoke.isError || everyone.isError) && (
        <div className="border-t px-5 py-3">
          <FormNotice error={revoke.error ?? everyone.error} />
        </div>
      )}
      {everyone.isSuccess && (
        <div className="border-t px-5 py-3 text-[13px] text-muted-foreground">
          Done. Every other device sees the sign-in page on its next request.
        </div>
      )}
    </Card>
  )
}

interface LoginEvent {
  id: number
  at: string
  outcome: string
  identifier?: string
  user_id?: string
  full_name?: string
  via: string
  ip?: string
  device: string
}

const OUTCOME_LABEL: Record<string, string> = {
  success: 'Signed in',
  wrong_password: 'Wrong password',
  no_account: 'No such account',
  locked: 'Locked out',
  school_paused: 'School paused',
  ambiguous: 'Ambiguous identifier',
  mfa_failed: 'Wrong 2FA code',
  mfa_required: 'Asked for 2FA code',
  reauth_ok: 'Password confirmed',
  reauth_failed: 'Password confirm failed',
}

/** Failed and unusual sign-in attempts, last seven days. */
export function SignInAttempts({ user }: { user?: { id: string; full_name: string } }) {
  const [days, setDays] = useState(7)
  const [failedOnly, setFailedOnly] = useState(true)
  const q = new URLSearchParams({ days: String(days), failed: String(failedOnly), limit: '300' })
  if (user) q.set('user', user.id)
  const { data, isLoading, error } = useQuery({
    queryKey: ['login-events', user?.id ?? '', days, failedOnly],
    queryFn: () => api.get<List<LoginEvent>>(`/api/v1/admin/login-events?${q}`),
  })
  const rows = data?.items ?? []
  const locked = rows.filter((r) => r.outcome === 'locked').length
  return (
    <Card>
      <CardHeader
        title={user ? `Sign-in attempts · ${user.full_name}` : `Sign-in attempts · ${failedOnly ? 'failed' : 'all'}`}
        description={
          rows.length === 0
            ? `Nothing ${failedOnly ? 'failed ' : ''}in the last ${days} days.`
            : `${rows.length} in the last ${days} days${locked ? `, ${locked} lockout${locked === 1 ? '' : 's'}` : ''}. Wrong passwords against an account that does not exist are listed under what was typed.`
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setFailedOnly((v) => !v)}>
              {failedOnly ? 'Include successes' : 'Failed only'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDays(days === 7 ? 30 : 7)}>
              {days === 7 ? 'Last 30 days' : 'Last 7 days'}
            </Button>
          </div>
        }
      />
      {isLoading ? (
        <SkeletonTable columns={5} />
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <Table head={['When', 'Who', 'What happened', 'Device', 'Address']} empty={!rows.length} emptyLabel="Nothing to show.">
          {rows.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap text-muted-foreground">{formatDateTime(e.at)}</Td>
              <Td>
                <div className="font-medium">{e.full_name ?? <span className="text-muted-foreground">Unknown</span>}</div>
                {e.identifier && <div className="font-mono text-[12px] text-muted-foreground">{e.identifier}</div>}
              </Td>
              <Td>
                <Badge tone={e.outcome === 'success' || e.outcome === 'reauth_ok' ? 'success' : e.outcome === 'locked' ? 'danger' : 'warning'}>
                  {OUTCOME_LABEL[e.outcome] ?? e.outcome}
                </Badge>
              </Td>
              <Td>{e.device}</Td>
              <Td className="font-mono text-[12px]">{e.ip ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

interface PolicyRow {
  role_key: string
  role_name: string
  absolute_hours: number
  idle_minutes: number
  max_devices: number
  overridden: boolean
}

/** How long a session lives, per role. */
export function SessionRules() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['session-policies'],
    queryFn: () => api.get<List<PolicyRow>>('/api/v1/admin/session-policies'),
  })
  const [draft, setDraft] = useState<Record<string, Partial<PolicyRow>>>({})
  const save = useMutation({
    mutationFn: ({ role, body }: { role: string; body: Partial<PolicyRow> | { reset: true } }) =>
      api.put(`/api/v1/admin/session-policies/${role}`, body),
    onSuccess: (_r, v) => {
      setDraft((d) => {
        const n = { ...d }
        delete n[v.role]
        return n
      })
      qc.invalidateQueries({ queryKey: ['session-policies'] })
    },
  })
  const rows = data?.items ?? []
  const val = (r: PolicyRow, k: 'absolute_hours' | 'idle_minutes' | 'max_devices') =>
    draft[r.role_key]?.[k] ?? r[k]
  const set = (r: PolicyRow, k: 'absolute_hours' | 'idle_minutes' | 'max_devices', v: string) =>
    setDraft((d) => ({ ...d, [r.role_key]: { ...(d[r.role_key] ?? {}), [k]: Number(v) || 0 } }))

  return (
    <Card>
      <CardHeader
        title="Session rules"
        description="How long a sign-in lasts for each role, how long it may sit idle, and how many devices may hold one at once. Signing in on one more device than allowed signs the oldest out. The strictest rule among a person's roles applies. Money actions always ask for the password again after fifteen minutes, whatever the rule."
      />
      {isLoading ? (
        <SkeletonTable columns={5} />
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <Table head={['Role', 'Lasts (hours)', 'Idle limit (minutes)', 'Devices', '']} empty={!rows.length}>
          {rows.map((r) => {
            const dirty = !!draft[r.role_key]
            return (
              <tr key={r.role_key}>
                <Td>
                  <div className="font-medium">{r.role_name}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {r.overridden ? 'Set by this school' : 'Built-in default'}
                  </div>
                </Td>
                <Td>
                  <Input type="number" value={String(val(r, 'absolute_hours'))} onChange={(v) => set(r, 'absolute_hours', v)} className="w-24" />
                </Td>
                <Td>
                  <Input type="number" value={String(val(r, 'idle_minutes'))} onChange={(v) => set(r, 'idle_minutes', v)} className="w-24" />
                </Td>
                <Td>
                  <Input type="number" value={String(val(r, 'max_devices'))} onChange={(v) => set(r, 'max_devices', v)} className="w-20" />
                </Td>
                <Td className="whitespace-nowrap">
                  <Button
                    size="sm"
                    disabled={!dirty || save.isPending}
                    onClick={() =>
                      save.mutate({
                        role: r.role_key,
                        body: {
                          absolute_hours: val(r, 'absolute_hours'),
                          idle_minutes: val(r, 'idle_minutes'),
                          max_devices: val(r, 'max_devices'),
                        },
                      })
                    }
                  >
                    Save
                  </Button>
                  {r.overridden && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={save.isPending}
                      onClick={() => save.mutate({ role: r.role_key, body: { reset: true } })}
                    >
                      Use default
                    </Button>
                  )}
                </Td>
              </tr>
            )
          })}
        </Table>
      )}
      {save.isError && (
        <div className="border-t px-5 py-3">
          <FormNotice error={save.error} />
        </div>
      )}
    </Card>
  )
}

interface DayRow {
  day: string
  ok: number
  failed: number
  screens: number
}

/** Thirty days of sign-ins for one person as a strip: green for a day with
    a sign-in, red where a failure happened, grey for nothing. */
export function SignInStrip({ userId }: { userId: string }) {
  const { data } = useQuery({
    queryKey: ['sign-in-days', userId],
    queryFn: () => api.get<List<DayRow>>(`/api/v1/admin/users/${userId}/sign-in-days?days=30`),
  })
  const days = data?.items ?? []
  if (!days.length) return null
  const okDays = days.filter((d) => d.ok > 0).length
  const failed = days.reduce((a, d) => a + d.failed, 0)
  return (
    <div className="px-5 pb-4">
      <p className="eyebrow mb-1.5">Last 30 days</p>
      <div className="flex flex-wrap gap-[3px]">
        {days.map((d) => (
          <span
            key={d.day}
            title={`${d.day}: ${d.ok} sign-in${d.ok === 1 ? '' : 's'}, ${d.failed} failed, ${d.screens} screen opens`}
            className={
              'block h-4 w-4 rounded-[3px] ' +
              (d.failed > 0 ? 'bg-destructive/70' : d.ok > 0 ? 'bg-success/70' : 'bg-muted')
            }
          />
        ))}
      </div>
      <p className="mt-1.5 text-[12.5px] text-muted-foreground">
        Signed in on {okDays} of {days.length} days
        {failed > 0 && (
          <>
            {' '}· <AlertTriangle className="inline h-3.5 w-3.5 text-destructive" /> {failed} failed attempt{failed === 1 ? '' : 's'}
          </>
        )}
      </p>
    </div>
  )
}

/** The office switching a colleague's two-factor off, for the lost phone. */
export function AdminMFAOff({ user }: { user: { id: string; full_name: string; mfa_enabled: boolean } }) {
  const qc = useQueryClient()
  const off = useMutation({
    mutationFn: () => api.post(`/api/v1/admin/users/${user.id}/mfa/disable`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['school-logins'] }),
  })
  if (!user.mfa_enabled) return null
  return (
    <div className="flex items-center gap-2 px-5 pb-4 text-[13px] text-muted-foreground">
      <ShieldAlert className="h-3.5 w-3.5" /> Two-factor is on for this account.
      <ConfirmButton
        tone="danger"
        disabled={off.isPending}
        question={`Switch two-factor off for ${user.full_name}? Only do this if they have lost the phone with their authenticator app. They can set it up again from their profile.`}
        confirmLabel="Switch off"
        onConfirm={() => off.mutate()}
      >
        Switch off (lost phone)
      </ConfirmButton>
    </div>
  )
}
