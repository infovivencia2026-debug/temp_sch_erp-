/* Insights (worker/src/routes/comms/yajur_connect_insights.ts): how the
   school's WhatsApp messages did over the last 7, 30 or 90 days. Delivery
   funnel, read rate by class, parent replies and reply time. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, ErrorState, Loading, SEG_BAR_FILL, segClass } from '@/components/ui'

/* The original app's periods (owner, 2026-11-23: "insights like Connect"). */
type Days = 7 | 30 | 90 | 'year' | 'all'
const PERIODS: { key: Days; label: string }[] = [
  { key: 7, label: '7 days' }, { key: 30, label: '30 days' }, { key: 'year', label: 'This year' }, { key: 'all', label: 'All' },
]
const PERIOD_TEXT: Record<string, string> = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', year: 'This year', all: 'All history' }

interface ConnectInsightsData {
  days: Days
  sent: number
  delivered: number
  read: number
  failed: number
  blocked: number
  pending: number
  delivered_pct: number
  read_pct: number
  replies: number
  reply_minutes: number | null
  by_class: { name: string; sent: number; read: number; read_pct: number }[]
  /** Inbound messages per half hour of the day, UTC, 48 slots. */
  inbound_slots: number[]
  top_templates: { code: string; name: string; sent: number; read: number; read_pct: number }[]
  failures: { reason: string; n: number }[]
  conversations: number
  estimated_cost_paise: number
}

const n = (v: number) => v.toLocaleString('en-IN')

function replyTime(m: number | null): string {
  if (m === null) return '-'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `${h} h ${r} min` : `${h} h`
}

/* Which hour of the viewer's clock the most parent messages arrive in. */
function busiestHour(slots: number[]): { label: string; count: number } | null {
  const byHour = new Array<number>(24).fill(0)
  slots.forEach((c, i) => { byHour[new Date(Date.UTC(2000, 0, 1, 0, i * 30)).getHours()] += c })
  let best = 0
  byHour.forEach((c, h) => { if (c > byHour[best]) best = h })
  if (!byHour[best]) return null
  const fmt = (h: number) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: true }).format(new Date(2000, 0, 1, h))
  return { label: `${fmt(best)} to ${fmt((best + 1) % 24)}`, count: byHour[best] }
}

function Bar({ label, value, max, right, cls }: { label: string; value: number; max: number; right: string; cls: string }) {
  const w = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{right}</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label}: ${right}`}>
        <div className={`h-full rounded-full ${cls}`} style={{ width: `${w}%` }} />
      </div>
    </div>
  )
}

function Head({ title, note }: { title: string; note?: string }) {
  return (
    <div className="border-b px-[var(--card-pad)] py-3">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
    </div>
  )
}

export default function ConnectInsights() {
  const [days, setDays] = useState<Days>(30)
  const q = useQuery({
    queryKey: ['connect', 'insights', days],
    queryFn: () => api.get<ConnectInsightsData>(`/api/v1/comms/yajur-connect/insights?days=${days}`),
  })

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold sm:text-[22px]">Insights</h1>
          <p className="text-[14px] text-muted-foreground">How your messages are doing.</p>
        </div>
        <div className={SEG_BAR_FILL} role="tablist" aria-label="Period">
          {PERIODS.map((d) => (
            <button key={d.key} type="button" role="tab" aria-selected={days === d.key} className={segClass(days === d.key)} onClick={() => setDays(d.key)}>
              {d.label}
            </button>
          ))}
        </div>
      </div>
      {q.isLoading ? <Loading /> : q.error || !q.data ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <Body d={q.data} />}
    </div>
  )
}

function Body({ d }: { d: ConnectInsightsData }) {
  const period = PERIOD_TEXT[String(d.days)] ?? ''
  const replied = d.replies
  const busy = busiestHour(d.inbound_slots)
  const classMax = Math.max(1, ...d.by_class.map((x) => x.read_pct))
  const notes = [
    d.failed > 0 && `${n(d.failed)} failed`,
    d.blocked > 0 && `${n(d.blocked)} not sent (opted out or blocked)`,
    d.pending > 0 && `${n(d.pending)} still waiting`,
  ].filter(Boolean)
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Messages sent" value={n(d.sent)} detail={d.pending ? `${n(d.pending)} still waiting` : 'Reached WhatsApp'} period={period} />
        <Tile label="Delivered" value={d.sent ? `${d.delivered_pct}%` : '-'} detail={d.sent ? `${n(d.delivered)} of ${n(d.sent)} sent` : 'No messages sent'} period={period} />
        <Tile label="Read rate" value={d.sent ? `${d.read_pct}%` : '-'} detail={d.sent ? `${n(d.read)} of ${n(d.sent)} read` : 'No messages sent'} period={period} />
        <Tile label="Parent replies" value={n(d.replies)} detail={busy ? `Most arrive ${busy.label}` : 'No replies yet'} period={period} />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <Head title="Delivery funnel" note="Each step is part of the one before it." />
          <div className="space-y-3 p-[var(--card-pad)]">
            <Bar label="Sent" value={d.sent} max={d.sent} right={n(d.sent)} cls="bg-primary" />
            <Bar label="Delivered" value={d.delivered} max={d.sent} right={`${n(d.delivered)} · ${d.delivered_pct}%`} cls="bg-success" />
            <Bar label="Read" value={d.read} max={d.sent} right={`${n(d.read)} · ${d.read_pct}%`} cls="bg-info" />
            <Bar label="Replied" value={Math.min(replied, d.sent)} max={d.sent} right={`${n(replied)}`} cls="bg-warning" />
            {d.failed > 0 && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{`${n(d.failed)} failed, never reached the parent`}</p>}
            {notes.length > 0 && <p className="border-t pt-3 text-sm text-muted-foreground">{notes.join(' · ')}</p>}
          </div>
        </Card>

        <Card className="min-w-0">
          <Head title="Read rate by class" note="Read messages as a share of those sent to each class's parents." />
          {d.by_class.length === 0
            ? <p className="p-[var(--card-pad)] text-sm text-muted-foreground">No messages sent in this period.</p>
            : <div className="space-y-3 p-[var(--card-pad)]">
                {d.by_class.map((x) => (
                  <Bar key={x.name} label={x.name} value={x.read_pct} max={classMax} right={`${x.read_pct}% · ${n(x.read)} of ${n(x.sent)}`} cls="bg-primary" />
                ))}
              </div>}
        </Card>

        <Card className="min-w-0">
          <Head title="Top templates" note="The messages the school sent most, and how many were read." />
          {d.top_templates.length === 0
            ? <p className="p-[var(--card-pad)] text-sm text-muted-foreground">No sends yet.</p>
            : <div className="space-y-3 p-[var(--card-pad)]">
                {d.top_templates.map((t) => (
                  <Bar key={t.code} label={t.name} value={t.sent} max={Math.max(1, ...d.top_templates.map((x) => x.sent))} right={`${n(t.sent)} sent · ${t.read_pct}% read`} cls="bg-primary" />
                ))}
              </div>}
        </Card>

        <Card className="min-w-0">
          <Head title="Why messages failed" note="The reason WhatsApp or the queue gave, most common first." />
          {d.failures.length === 0
            ? <p className="p-[var(--card-pad)] text-sm text-muted-foreground">No failures recorded.</p>
            : <ul className="divide-y">
                {d.failures.map((f) => (
                  <li key={f.reason} className="flex items-start gap-3 px-[var(--card-pad)] py-3 text-sm">
                    <span className="min-w-0 flex-1 break-words">{f.reason}</span>
                    <span className="shrink-0 rounded-full bg-destructive/10 px-2.5 py-0.5 font-semibold tabular-nums text-destructive">{n(f.n)}</span>
                  </li>
                ))}
              </ul>}
        </Card>

        <Card className="min-w-0">
          <Head title="Conversations & cost" note="WhatsApp charges once per number per 24 hours a message is sent (about Rs 0.35 for a school notice)." />
          <div className="grid grid-cols-2 gap-3 p-[var(--card-pad)]">
            <div className="rounded-2xl bg-muted/50 px-4 py-3"><div className="text-2xl font-bold tabular-nums">{n(d.conversations)}</div><div className="text-sm text-muted-foreground">Conversations</div></div>
            <div className="rounded-2xl bg-muted/50 px-4 py-3"><div className="text-2xl font-bold tabular-nums">{`Rs ${(d.estimated_cost_paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}</div><div className="text-sm text-muted-foreground">Estimated spend</div></div>
          </div>
          <p className="px-[var(--card-pad)] pb-[var(--card-pad)] text-[12.5px] text-muted-foreground">An estimate from what was sent; the bill from Meta is the exact figure.</p>
        </Card>

        <Card className="min-w-0">
          <Head title="Reply time" note="From a parent's message to the school's answer." />
          <div className="p-[var(--card-pad)]">
            <div className="text-[28px] font-extrabold">{replyTime(d.reply_minutes)}</div>
            <div className="text-sm text-muted-foreground">{d.reply_minutes === null ? 'No reply sent after a parent wrote in' : `Average, ${period.toLowerCase()}`}{busy ? ` · most parent messages arrive ${busy.label}` : ''}</div>
          </div>
        </Card>
      </div>
    </>
  )
}

/* Headline tile: same rounded card and hover lift as the Overview cards (owner, 2026-11-24: "why cards are box?"). */
function Tile({ label, value, detail, period }: { label: string; value: string; detail: string; period: string }) {
  return (
    <div className="rounded-[20px] border bg-card p-5 shadow-sm transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-[32px] font-extrabold leading-tight tabular-nums">{value}</div>
      <div className="text-sm">{detail}</div>
      <div className="mt-1 text-xs text-muted-foreground">{period}</div>
    </div>
  )
}
