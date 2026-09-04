import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from './bento-kit'
import { Rows } from './bento-cards'
import { Facts, PersonaCard, PersonaPage, Say, useShape } from './persona-kit'
import { Widget } from './WidgetLayer'
import { inClassic } from './classic-board'

/* THE SYSTEMS DESK.

   Four cells over four lists an IT administrator already holds the keys to:
   the logins (users.read), the sessions open now and the audit summary
   (audit.read), and the job queues (jobs.read). Every figure is a count the
   server returned; nothing here is a share of a population this payload does
   not carry. */

interface UserRow {
  id: string
  status: string
  record: string
  active_sessions: number
  mfa_enabled: boolean
}
interface SessionRow {
  id: string
  full_name: string
  user_agent?: string
}
interface Queue {
  pending: number
  active: number
  retry: number
  failed: number
  archived: number
}
interface AuditRow {
  entity_type: string
  count: number
}

function ITDesk() {
  const users = useQuery({
    queryKey: ['it-users'],
    queryFn: () => api.get<List<UserRow>>('/api/v1/admin/users'),
  })
  const sessions = useQuery({
    queryKey: ['it-sessions'],
    queryFn: () => api.get<List<SessionRow>>('/api/v1/admin/sessions?active=true'),
  })
  const queues = useQuery({
    queryKey: ['it-queues'],
    queryFn: () => api.get<{ queues: Record<string, Queue> }>('/api/v1/jobs/queues'),
  })
  const audit = useQuery({
    queryKey: ['it-audit'],
    queryFn: () => api.get<List<AuditRow>>('/api/v1/admin/audit/summary'),
  })
  const toUsers = useFeatureHref('it_admin.access.users')
  const toSessions = useFeatureHref('it_admin.access.logins_sessions')
  const toJobs = useFeatureHref('it_admin.systems.background_jobs')
  const toAudit = useFeatureHref('it_admin.systems.audit_log')

  const loading = users.isLoading || sessions.isLoading || queues.isLoading || audit.isLoading
  if (loading) return <BentoLoading message="Reading logins and queues…" />
  const failed = users.error ?? sessions.error ?? queues.error ?? audit.error
  if (failed) return <BentoError message={String(failed)} />

  return (
    <PersonaPage eyebrow="Home" title="Systems desk" dashboard="it_desk">
      <Widget id="logins" label="Logins" size="large" index={0}>
        {(span) => <LoginsCell span={span} users={users.data?.items ?? []} to={toUsers} />}
      </Widget>
      <Widget id="sessions" label="Signed in now" size="small" index={1}>
        {(span) => <SessionsCell span={span} sessions={sessions.data?.items ?? []} to={toSessions} />}
      </Widget>
      <Widget id="jobs" label="Job queues" size="small" index={2}>
        {(span) => <JobsCell span={span} queues={queues.data?.queues ?? {}} to={toJobs} />}
      </Widget>
      <Widget id="audit" label="Audit" size="small" index={3}>
        {(span) => <AuditCell span={span} rows={audit.data?.items ?? []} to={toAudit} />}
      </Widget>
    </PersonaPage>
  )
}

function LoginsCell({ span, users, to }: { span: CellSpan; users: UserRow[]; to?: string }) {
  const active = users.filter((u) => u.status === 'active').length
  const disabled = users.length - active
  const orphaned = users.filter((u) => u.record === 'none').length
  const mfa = users.filter((u) => u.mfa_enabled).length
  const facts = [
    { label: 'Active', value: String(active) },
    { label: 'Disabled', value: String(disabled) },
    { label: 'No person behind it', value: String(orphaned) },
    { label: 'With MFA', value: String(mfa) },
  ]
  return (
    <PersonaCard
      span={span}
      ground="staff"
      title="Logins"
      glyph="⌂"
      value={users.length}
      change={orphaned > 0 ? `${orphaned} belong to nobody on record` : 'Every login has a person behind it'}
      to={to}
      cueLabel="Open users"
    >
      {users.length === 0 ? <Say>No login has been created yet</Say> : <Facts items={facts} srLabel="Logins by state" />}
    </PersonaCard>
  )
}

function SessionsCell({ span, sessions, to }: { span: CellSpan; sessions: SessionRow[]; to?: string }) {
  const { tall } = useShape()
  const byPerson = new Map<string, number>()
  for (const s of sessions) byPerson.set(s.full_name, (byPerson.get(s.full_name) ?? 0) + 1)
  const rows = [...byPerson.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, tall ? 8 : 4)
  return (
    <PersonaCard
      span={span}
      title="Signed in now"
      glyph="●"
      value={sessions.length}
      change={`${byPerson.size} people`}
      to={to}
      cueLabel="Open logins and sessions"
    >
      {sessions.length === 0 ? <Say>Nobody is signed in</Say> : <Rows items={rows} srLabel="Sessions by person" />}
    </PersonaCard>
  )
}

function JobsCell({ span, queues, to }: { span: CellSpan; queues: Record<string, Queue>; to?: string }) {
  const sum = (k: keyof Queue) => Object.values(queues).reduce((a, q) => a + (q[k] ?? 0), 0)
  const failed = sum('failed')
  const retry = sum('retry')
  const facts = [
    { label: 'Waiting', value: String(sum('pending')) },
    { label: 'Running', value: String(sum('active')) },
    { label: 'Retrying', value: String(retry) },
    { label: 'Failed', value: String(failed) },
  ]
  return (
    <PersonaCard
      span={span}
      title="Job queues"
      glyph="↻"
      value={failed + retry}
      change={failed + retry === 0 ? 'Nothing is stuck' : 'Failed or retrying'}
      to={to}
      cueLabel="Open background jobs"
    >
      {Object.keys(queues).length === 0 ? <Say>No queue is reporting</Say> : <Facts items={facts} srLabel="Jobs by state" />}
    </PersonaCard>
  )
}

function AuditCell({ span, rows, to }: { span: CellSpan; rows: AuditRow[]; to?: string }) {
  const { tall } = useShape()
  const items = rows
    .map((r) => ({ label: r.entity_type, value: r.count }))
    .sort((a, b) => b.value - a.value)
    .slice(0, tall ? 8 : 4)
  const total = rows.reduce((a, r) => a + r.count, 0)
  return (
    <PersonaCard
      span={span}
      title="Audit log"
      glyph="≡"
      value={total}
      change={rows.length === 0 ? 'Nothing recorded' : 'Entries by what changed'}
      to={to}
      cueLabel="Open the audit log"
    >
      {items.length === 0 ? <Say>Nothing has been recorded yet</Say> : <Rows items={items} srLabel="Audit entries by record type" />}
    </PersonaCard>
  )
}

export const Classic = inClassic(ITDesk)
export default ITDesk
