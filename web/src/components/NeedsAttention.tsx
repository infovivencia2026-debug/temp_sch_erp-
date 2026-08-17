import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CircleAlert, Info, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { useActiveRole, useCatalog } from '@/lib/catalog'
import { cn } from '@/lib/utils'

/* The panel every role opens the product to read.

   One component, not seventeen dashboards. The server decides what is in it —
   which probes the caller's permissions make meaningful, and which rows their
   scope reaches — so a class teacher's "attendance not marked" is their two
   sections and a vice principal's is the school, from the same request.

   The rule that keeps it worth reading: nothing with a count of zero is ever
   listed. A panel that reassures you about the fourteen things that are fine
   is a panel people stop reading, and then they stop seeing the one that
   isn't. */

interface AttentionItem {
  key: string
  severity: 'critical' | 'warning' | 'info'
  count: number
  headline: string
  detail?: string
  action: string
  href?: string
  amount_paise?: number
}

interface SummaryStat {
  label: string
  value: string
  hint?: string
}

interface AttentionResponse {
  role: string
  greeting: string
  items: AttentionItem[]
  summary: SummaryStat[]
}

const ICON = {
  critical: CircleAlert,
  warning: AlertTriangle,
  info: Info,
}

export default function NeedsAttention({ name }: { name?: string }) {
  const navigate = useNavigate()
  const role = useActiveRole()
  const catalog = useCatalog()

  const q = useQuery({
    queryKey: ['attention', role?.key],
    queryFn: () => api.get<AttentionResponse>(`/api/v1/attention?role=${role?.key ?? ''}`),
    // A school day moves; a panel that answers "what needs me now" should not
    // be answering it from ten minutes ago.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })

  if (q.isLoading || q.error || !q.data) return null
  /* Defaulted at the point of use as well as on the server.

     The server now always sends arrays, but this panel renders on every
     role's Home and is the first thing drawn after sign-in: if it throws,
     the route blanks with no error boundary to catch it. A missing list is
     worth rendering nothing over, not worth taking the page down. */
  const { greeting } = q.data
  const items = q.data.items ?? []
  const summary = q.data.summary ?? []

  /* An attention item names a destination in the abstract — "attendance",
     "fees" — and the concrete route depends on which workspace this role keeps
     that in. Resolving it here rather than server-side keeps the engine from
     having to know the shape of seventeen navigation trees. */
  function hrefFor(target?: string) {
    if (!target || !role) return null
    for (const section of role.sections) {
      for (const f of section.features) {
        if (!f.live || !f.in_scope) continue
        const hay = `${section.slug} ${f.slug}`
        if (hay.includes(target)) return `/${role.key}/${section.slug}/${f.slug}`
      }
    }
    return null
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-display text-[26px] font-semibold tracking-[-0.02em]">
          {greeting}
          {name ? `, ${name}` : ''}
        </h2>
        {items.length === 0 && (
          <p className="mt-1 text-[14px] text-muted-foreground">
            Nothing needs you right now.
          </p>
        )}
      </div>

      {items.length > 0 && (
        <section>
          <p className="eyebrow mb-2">Needs your attention</p>
          <ul className="divide-y rounded-md border bg-card">
            {items.map((item) => {
              const Icon = ICON[item.severity]
              const href = hrefFor(item.href)
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    disabled={!href}
                    onClick={() => href && navigate(href)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
                      href ? 'hover:bg-accent' : 'cursor-default',
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        item.severity === 'critical' && 'text-destructive',
                        item.severity === 'warning' && 'text-[hsl(var(--warning,38_92%_40%))]',
                        item.severity === 'info' && 'text-muted-foreground',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">
                        {item.headline}
                      </span>
                      {item.detail && (
                        <span className="block text-[12.5px] text-muted-foreground">
                          {item.detail}
                        </span>
                      )}
                    </span>
                    {href && (
                      <span className="flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground">
                        {item.action}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {summary.length > 0 && (
        <section>
          <p className="eyebrow mb-2">Today</p>
          <div className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 lg:grid-cols-4">
            {summary.map((s) => (
              <div key={s.label} className="bg-card px-4 py-3">
                <p className="font-display text-[24px] font-semibold leading-none tracking-[-0.02em] tabular-nums">
                  {s.value}
                </p>
                <p className="mt-1.5 text-[12px] text-muted-foreground">{s.label}</p>
                {s.hint && <p className="text-[11.5px] text-muted-foreground/70">{s.hint}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {catalog.roles.length > 1 && (
        <p className="text-[12.5px] text-muted-foreground">
          This is your {role?.name} workspace. Switch roles from the top bar to see what needs
          you elsewhere.
        </p>
      )}
    </div>
  )
}

/* One status vocabulary, rendered one way.

   The tones come from the database's own enums — invoices already distinguish
   partial from overdue, applications already carry the enquiry-to-enrolled
   ladder — so this maps rather than invents. A second vocabulary in the client
   would be a second answer to "what does partial mean". */
const TONE: Record<string, string> = {
  paid: 'good', success: 'good', partial: 'warn', unpaid: 'warn',
  overdue: 'bad', failed: 'bad', bounced: 'bad', refunded: 'neutral',
  cancelled: 'neutral', draft: 'neutral',
  present: 'good', late: 'warn', half_day: 'warn',
  absent: 'bad', leave: 'neutral', holiday: 'neutral', week_off: 'neutral',
  new: 'neutral', contacted: 'neutral', visit_scheduled: 'neutral',
  submitted: 'neutral', under_review: 'warn', documents_pending: 'warn',
  test_scheduled: 'neutral', interviewed: 'neutral', waitlisted: 'warn',
  offered: 'good', accepted: 'good', applied: 'good',
  rejected: 'bad', withdrawn: 'neutral', lost: 'bad',
  pending: 'warn', approved: 'good', requested: 'warn', issued: 'good',
  active: 'good', promoted: 'good', detained: 'warn',
  transferred: 'neutral', completed: 'good',
}

const TONE_CLASS: Record<string, string> = {
  good: 'border-transparent bg-[hsl(var(--ok,152_45%_92%))] text-[hsl(var(--ok-fg,152_60%_24%))]',
  warn: 'border-transparent bg-[hsl(var(--warn,38_92%_92%))] text-[hsl(var(--warn-fg,32_80%_28%))]',
  bad: 'border-transparent bg-destructive/10 text-destructive',
  neutral: 'border-border bg-transparent text-muted-foreground',
}

/** Renders a record's status the same way everywhere it appears. */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const key = status.trim().toLowerCase().replace(/[\s-]+/g, '_')
  const tone = TONE[key] ?? 'neutral'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-4',
        TONE_CLASS[tone],
        className,
      )}
    >
      {key.replace(/_/g, ' ')}
    </span>
  )
}
