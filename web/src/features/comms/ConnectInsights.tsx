/* Insights (worker/src/routes/comms/yajur_connect_insights.ts): how the
   school's WhatsApp messages did over the last 7, 30 or 90 days. Delivery
   funnel, read rate by class, parent replies and reply time. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, ErrorState, Loading, Stat, SEG_BAR_FILL, segClass } from '@/components/ui'

type Days = 7 | 30 | 90
const PERIODS: Days[] = [7, 30, 90]

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
            <button key={d} type="button" role="tab" aria-selected={days === d} className={segClass(days === d)} onClick={() => setDays(d)}>
              {`${d} days`}
            </button>
          ))}
        </div>
      </div>
      {q.isLoading ? <Loading /> : q.error || !q.data ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <Body d={q.data} />}
    </div>
  )
}

function Body({ d }: { d: ConnectInsightsData }) {
  const period = `Last ${d.days} days`
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
        <Stat label="Delivered" value={d.sent ? `${d.delivered_pct}%` : '-'} detail={d.sent ? `${n(d.delivered)} of ${n(d.sent)} sent` : 'No messages sent'} period={period} />
        <Stat label="Read" value={d.sent ? `${d.read_pct}%` : '-'} detail={d.sent ? `${n(d.read)} of ${n(d.sent)} sent` : 'No messages sent'} period={period} />
        <Stat label="Parent replies" value={n(d.replies)} detail={busy ? `Most arrive ${busy.label}` : 'No replies yet'} period={period} />
        <Stat label="Average reply time" value={replyTime(d.reply_minutes)} detail={d.reply_minutes === null ? 'No reply sent after a parent wrote in' : "From a parent's message to the school's answer"} period={period} />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <Head title="Delivery funnel" note="Each step is part of the one before it." />
          <div className="space-y-3 p-[var(--card-pad)]">
            <Bar label="Sent" value={d.sent} max={d.sent} right={n(d.sent)} cls="bg-primary" />
            <Bar label="Delivered" value={d.delivered} max={d.sent} right={`${n(d.delivered)} · ${d.delivered_pct}%`} cls="bg-success" />
            <Bar label="Read" value={d.read} max={d.sent} right={`${n(d.read)} · ${d.read_pct}%`} cls="bg-info" />
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
      </div>
    </>
  )
}
