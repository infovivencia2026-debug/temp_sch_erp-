import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Activity } from 'lucide-react'
import { api, actingInstitution } from '@/lib/api'
import { useCan } from '@/lib/session'
import {
  Card, CardHeader, Table, Td, Badge, Button, ConfirmButton, Input, Checkbox, Select, ErrorState, FormNotice, SkeletonTable,
} from '@/components/ui'
import { formatDateTime } from '@/lib/utils'

/* SESSION ACTIVITY, for the school's administrators.

   Recording is a per-school switch, off until someone here turns it on (and
   the seller can forbid it). While on, each sign-in records its device and
   browser, address and approximate place, sign-in and sign-out, last active
   and total active time, and the screens visited with time on each; changes
   made in the session come from the audit log, already stamped with it.

   Worker: routes/admin/session_activity.ts, services/session_activity.ts. */

export interface ActivitySettings {
  enabled: boolean
  recording: boolean
  seller_blocked: boolean
  retention_days: number
  default_retention_days: number
}

export interface ActivitySession {
  session_id: string
  user_id: string
  full_name: string
  via?: string
  signed_in_at: string
  signed_out_at?: string
  ended_reason?: string
  live: boolean
  ip?: string
  device?: string
  browser?: string
  os?: string
  location?: string
  last_active_at?: string
  active_seconds: number
  screens?: number
  changes?: number
}

interface View { id: number; screen: string; path?: string; started_at: string; seconds: number }
interface Change { id: number; at: string; action: string; entity_type: string; entity_id?: string }

export const ENDED: Record<string, string> = {
  signed_out: 'Signed out',
  idle: 'Timed out (idle)',
  expired: 'Expired',
  revoked: 'Ended by the office',
  all_signed_out: 'Everyone signed out',
  password_changed: 'Password changed',
  deactivated: 'Account deactivated',
}

export function duration(sec: number): string {
  if (!sec) return '0m'
  if (sec < 60) return `${sec}s`
  const m = Math.round(sec / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function screenName(key: string): string {
  const words = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  // Catalogue keys are role.section.feature; the role adds nothing here.
  const parts = key.split('.')
  const [section, ...rest] = parts.length >= 3 ? parts.slice(1) : parts
  return rest.length ? `${words(section)} › ${words(rest.join('.'))}` : words(section)
}

export const deviceText = (s: Pick<ActivitySession, 'device' | 'browser' | 'os'>) =>
  [s.browser, s.os && s.os !== 'Unknown' ? `on ${s.os}` : '', s.device && s.device !== 'Unknown' ? `(${s.device})` : ''].filter(Boolean).join(' ') || 'Unknown device'

export function SessionActivityDesk() {
  const can = useCan()
  if (!can('admin.audit.read')) return null
  return <Desk />
}

function Desk() {
  const can = useCan()
  const qc = useQueryClient()
  const settings = useQuery({
    queryKey: ['session-activity-settings'],
    queryFn: () => api.get<ActivitySettings>('/api/v1/admin/session-activity/settings'),
  })
  const [days, setDays] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (body: { enabled?: boolean; retention_days?: number }) =>
      api.put<ActivitySettings>('/api/v1/admin/session-activity/settings', body),
    onSuccess: (d) => {
      qc.setQueryData(['session-activity-settings'], d)
      setDays(null)
      // The app learns whether to report screens from the session.
      qc.invalidateQueries({ queryKey: ['session'] })
    },
  })

  const s = settings.data
  const canSet = can('institution.settings.write')
  return (
    <Card>
      <CardHeader title="Session activity" />
      <div className="space-y-3 px-[var(--card-pad)] py-4 text-[13.5px]">
        {settings.error ? <ErrorState error={settings.error} /> : !s ? <p className="text-muted-foreground">Loading…</p> : (
          <>
            <p className="text-muted-foreground">
              When this is on, each sign-in records the device and browser, the address and approximate place, when it
              started and ended, how long it was active, and which screens were opened for how long. Changes it made
              come from the audit log. People see a notice on their account page while it is on. Records older than the
              retention period are deleted every night.
            </p>
            {s.seller_blocked && (
              <p className="rounded-md bg-muted/60 px-3 py-2">Recording is not available for this school. Contact us to have it allowed.</p>
            )}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              {canSet ? (
                <Checkbox
                  checked={s.enabled}
                  onChange={(v) => save.mutate({ enabled: v })}
                  label="Record session activity"
                  hint={s.enabled ? (s.recording ? 'On: new activity is being recorded.' : 'On, but not allowed for this school.') : 'Off: no session activity is recorded.'}
                />
              ) : (
                <span>Recording is <b>{s.recording ? 'on' : 'off'}</b>.</span>
              )}
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground">Keep for</span>
                {canSet ? (
                  <span className="w-20"><Input type="number" srLabel="Retention in days" value={days ?? String(s.retention_days)} onChange={setDays} /></span>
                ) : <b>{s.retention_days}</b>}
                <span className="text-muted-foreground">days</span>
                {canSet && days !== null && days !== String(s.retention_days) && (
                  <Button size="sm" variant="secondary" pending={save.isPending} onClick={() => save.mutate({ retention_days: Number(days) })}>Save</Button>
                )}
              </span>
            </div>
            {save.error && <FormNotice error={save.error} />}
          </>
        )}
      </div>
      <SessionList />
    </Card>
  )
}

function SessionList() {
  const can = useCan()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (status) params.set('status', status)
  const qs = params.toString()
  const { data, isLoading, error } = useQuery({
    queryKey: ['session-activity', qs],
    queryFn: () => api.get<{ items: ActivitySession[] }>(`/api/v1/admin/session-activity?${qs}`),
  })
  const end = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/admin/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session-activity'] }),
  })
  const [csvErr, setCsvErr] = useState<string | null>(null)
  async function exportCsv() {
    setCsvErr(null)
    try {
      const acting = actingInstitution()
      const res = await fetch(`/api/v1/admin/session-activity/export?${qs}`, {
        credentials: 'same-origin', headers: acting ? { 'X-Acting-Institution': acting } : {},
      })
      if (!res.ok) throw new Error(`The export failed (${res.status}).`)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `session-activity-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    } catch (e) { setCsvErr(e instanceof Error ? e.message : 'The export failed.') }
  }

  const rows = data?.items ?? []
  return (
    <div className="border-t">
      <div className="flex flex-wrap items-end gap-3 px-[var(--card-pad)] py-3">
        <label className="grid gap-1 text-[12px] text-muted-foreground">Person
          <span className="w-48"><Input value={q} onChange={setQ} placeholder="Name" srLabel="Person" /></span>
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">From
          <span className="w-40"><Input type="date" value={from} onChange={setFrom} srLabel="From" /></span>
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">To
          <span className="w-40"><Input type="date" value={to} onChange={setTo} srLabel="To" /></span>
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">Status
          <span className="w-36"><Select value={status} onChange={setStatus} placeholder="Any"
            options={[{ value: '', label: 'Any' }, { value: 'live', label: 'Live' }, { value: 'ended', label: 'Ended' }]} /></span>
        </label>
        <span className="ml-auto">
          <Button size="sm" variant="secondary" onClick={exportCsv} disabled={!rows.length}>
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </span>
      </div>
      {csvErr && <div className="px-[var(--card-pad)] pb-2"><FormNotice error={new Error(csvErr)} /></div>}
      {isLoading ? <SkeletonTable columns={7} /> : error ? <ErrorState error={error} /> : (
        <Table
          head={['Person', 'Signed in', 'Ended', 'Active', 'Screens', 'Device', 'Address', '']}
          empty={!rows.length}
          emptyLabel="No session activity recorded. Turn recording on above; new sign-ins will appear here."
        >
          {rows.map((r) => (
            <Fragment key={r.session_id}>
              <tr>
                <Td className="font-medium">{r.full_name}</Td>
                <Td className="text-muted-foreground">{formatDateTime(r.signed_in_at)}</Td>
                <Td>{r.live ? <Badge tone="success">Live</Badge> : (
                  <span className="text-muted-foreground">{r.signed_out_at ? formatDateTime(r.signed_out_at) : '-'}
                    {r.ended_reason && <span className="block text-[12px]">{ENDED[r.ended_reason] ?? r.ended_reason}</span>}</span>
                )}</Td>
                <Td>{duration(r.active_seconds)}
                  {r.last_active_at && <span className="block text-[12px] text-muted-foreground">last {formatDateTime(r.last_active_at)}</span>}</Td>
                <Td>{r.screens ?? 0}{r.changes ? <span className="block text-[12px] text-muted-foreground">{r.changes} change{r.changes === 1 ? '' : 's'}</span> : null}</Td>
                <Td>{deviceText(r)}</Td>
                <Td><span className="font-mono text-[12px]">{r.ip ?? '-'}</span>
                  {r.location && <span className="block text-[12px] text-muted-foreground">{r.location}</span>}</Td>
                <Td>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(open === r.session_id ? null : r.session_id)}>
                      <Activity className="h-3.5 w-3.5" /> {open === r.session_id ? 'Hide' : 'Timeline'}
                    </Button>
                    {r.live && can('access.sessions.revoke') && (
                      <ConfirmButton tone="danger" disabled={end.isPending} question={`End ${r.full_name}'s session now?`}
                        confirmLabel="End session" onConfirm={() => end.mutate(r.session_id)}>End session</ConfirmButton>
                    )}
                  </div>
                </Td>
              </tr>
              {open === r.session_id && (
                <tr><td colSpan={8} className="bg-muted/30 px-4 py-3"><Timeline id={r.session_id} /></td></tr>
              )}
            </Fragment>
          ))}
        </Table>
      )}
      {end.error && <div className="border-t px-5 py-3"><FormNotice error={end.error} /></div>}
    </div>
  )
}

/* One session in time order: sign-in, each screen with its time, each change, the end. */
function Timeline({ id }: { id: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['session-activity-detail', id],
    queryFn: () => api.get<{ session: ActivitySession; views: View[]; changes: Change[] }>(`/api/v1/admin/session-activity/${id}`),
  })
  if (isLoading) return <p className="text-[13px] text-muted-foreground">Loading…</p>
  if (error || !data) return <ErrorState error={error} />
  const s = data.session
  type Ev = { at: string; kind: 'in' | 'view' | 'change' | 'out'; text: string; detail?: string }
  const evs: Ev[] = [
    { at: s.signed_in_at, kind: 'in', text: 'Signed in', detail: [deviceText(s), s.ip, s.location].filter(Boolean).join(' · ') },
    ...data.views.map((v): Ev => ({ at: v.started_at, kind: 'view', text: screenName(v.screen), detail: `${duration(v.seconds)} on screen${v.path ? ' · ' + v.path : ''}` })),
    ...data.changes.map((c): Ev => ({ at: c.at, kind: 'change', text: `${c.action} ${c.entity_type.replace(/_/g, ' ')}`, detail: c.entity_id })),
  ]
  if (s.signed_out_at) evs.push({ at: s.signed_out_at, kind: 'out', text: ENDED[s.ended_reason ?? ''] ?? 'Ended' })
  evs.sort((a, b) => a.at.localeCompare(b.at))
  const tone = { in: 'success', view: 'neutral', change: 'warning', out: 'danger' } as const
  return (
    <div className="text-[13px]">
      <p className="mb-2 text-muted-foreground">
        Active {duration(s.active_seconds)} · {data.views.length} screen visit{data.views.length === 1 ? '' : 's'} · {data.changes.length} change{data.changes.length === 1 ? '' : 's'}
      </p>
      <ol className="space-y-1.5 border-l pl-4">
        {evs.map((e, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-3">
            <span className="w-48 shrink-0 whitespace-nowrap text-muted-foreground">{formatDateTime(e.at)}</span>
            <Badge tone={tone[e.kind]}>{e.kind === 'in' ? 'Sign-in' : e.kind === 'view' ? 'Screen' : e.kind === 'change' ? 'Change' : 'End'}</Badge>
            <span className="font-medium">{e.text}</span>
            {e.detail && <span className="text-muted-foreground">{e.detail}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}
