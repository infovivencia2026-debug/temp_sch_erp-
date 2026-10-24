import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Badge, Dialog, ErrorState, Loading } from '@/components/ui'
import { formatDate, formatDateTime, formatPaise } from '@/lib/utils'

/* SCHOOL 360: one school's account on one sheet (GET /seller/school360/{id}).
   Plan and renewal, seats bought against children enrolled, use, storage,
   faults, money owed, open tickets and the last backup, with the churn-risk
   reasons and the rule that produced them. Opened from Schools and from
   Renewals. Read only: each figure has its own screen to act on it. */

export interface School360Data {
  school: { id: string; name: string; slug: string; status: string }
  plan: { code: string; name: string | null; status: string; renews_on: string | null; renews_in_days: number | null } | null
  students: { licensed: number | null; actual: number | null; over_by: number }
  last_sign_in: string | null
  storage: { used_bytes: number | null; limit_gb: number | null }
  errors_24h: number
  failed_jobs_24h: number
  failed_payments_30d: number
  failed_messages_7d: number | null
  billing: { unpaid_invoices: number; balance_paise: number; oldest_due_on: string | null; past_due: boolean }
  open_tickets: number | null
  last_backup_at: string | null
  adoption: { active_users_7d: number; users: number | null; pct: number | null }
  setup: { completed: number; total: number; ready: boolean } | null
  risk: string[]
  risk_rule: string
  reachable: boolean
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(bytes >= 1024 ** 3 ? 1 : 2)

function Row({ label, children, warn }: { label: string; children: React.ReactNode; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-[13px] text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 text-right text-[14px] tabular-nums ${warn ? 'font-medium text-destructive' : ''}`}>{children}</dd>
    </div>
  )
}

export function School360({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['seller-school360', id], queryFn: () => api.get<School360Data>(`/api/v1/seller/school360/${id}`) })
  const d = q.data
  const unknown = 'Not readable'
  return (
    <Dialog onClose={onClose} size="lg" title={d?.school.name ?? 'School'} description={d ? `/${d.school.slug}` : undefined}>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} />}
      {d && (
        <div className="space-y-4">
          <div className="rounded-[var(--radius-card)] bg-muted/40 p-3">
            {d.risk.length ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="danger">At risk</Badge>
                {d.risk.map((r) => <span key={r} className="text-[13.5px]">{r}</span>)}
              </div>
            ) : (
              <Badge tone="success">No risk signals</Badge>
            )}
            <p className="mt-2 text-[12.5px] text-muted-foreground">{d.risk_rule}</p>
          </div>
          {!d.reachable && <p className="text-[13px] text-muted-foreground">The school's own database could not be read, so its counts are missing.</p>}
          <dl className="divide-y">
            <Row label="Plan">
              {d.plan ? `${d.plan.name ?? d.plan.code} · ${d.plan.status.replace('_', ' ')}` : 'No subscription'}
              {d.school.status === 'suspended' && <Badge tone="danger" className="ml-2">School suspended</Badge>}
            </Row>
            <Row label="Renews" warn={d.plan?.renews_in_days != null && d.plan.renews_in_days < 0}>
              {d.plan?.renews_on ? `${formatDate(d.plan.renews_on)} (${d.plan.renews_in_days! >= 0 ? `in ${d.plan.renews_in_days} days` : `${-d.plan.renews_in_days!} days ago`})` : 'Not set'}
            </Row>
            <Row label="Students, enrolled against licensed" warn={d.students.over_by > 0}>
              {d.students.actual ?? unknown} / {d.students.licensed ?? 'no limit'}{d.students.over_by > 0 && ` · ${d.students.over_by} over`}
            </Row>
            <Row label="Last sign-in" warn={d.risk.some((r) => r.startsWith('No sign-in'))}>{d.last_sign_in ? formatDateTime(d.last_sign_in) : 'Never'}</Row>
            <Row label="Signed in this week" warn={d.risk.includes('Low use')}>
              {d.adoption.users === null ? unknown : `${d.adoption.active_users_7d} of ${d.adoption.users} users${d.adoption.pct !== null ? ` (${d.adoption.pct}%)` : ''}`}
            </Row>
            {d.setup && <Row label="Setup">{d.setup.completed} of {d.setup.total} steps</Row>}
            <Row label="Storage">
              {d.storage.used_bytes === null ? unknown : `${gb(d.storage.used_bytes)} GB`}{d.storage.limit_gb != null && ` of ${d.storage.limit_gb} GB`}
            </Row>
            <Row label="Errors, last 24 hours" warn={d.errors_24h > 0}>{d.errors_24h}</Row>
            <Row label="Failed jobs, last 24 hours" warn={d.failed_jobs_24h > 0}>{d.failed_jobs_24h}</Row>
            <Row label="Failed messages, last 7 days" warn={(d.failed_messages_7d ?? 0) > 0}>{d.failed_messages_7d ?? unknown}</Row>
            <Row label="Failed online payments, last 30 days" warn={d.failed_payments_30d > 0}>{d.failed_payments_30d}</Row>
            <Row label="Unpaid invoices" warn={d.billing.past_due}>
              {d.billing.unpaid_invoices ? `${d.billing.unpaid_invoices} · ${formatPaise(d.billing.balance_paise)}` : 'None'}
              {d.billing.oldest_due_on && ` · oldest due ${formatDate(d.billing.oldest_due_on)}`}
            </Row>
            <Row label="Open tickets">{d.open_tickets ?? unknown}</Row>
            <Row label="Last backup" warn={!d.last_backup_at}>{d.last_backup_at ? formatDateTime(d.last_backup_at) : 'None yet'}</Row>
          </dl>
        </div>
      )}
    </Dialog>
  )
}
