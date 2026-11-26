/* Yajur Connect Overview (worker/src/routes/comms/yajur_connect_overview.ts):
   the Connect home screen. Shortcuts to the tasks, school counts, delivery as
   a funnel, the latest parent replies and the latest notices. Laid out as the
   approved design (Desktop, "Overview - better (real data).html"): every card
   rounded the same, every clickable thing lifts or lights on hover. */
import type { ComponentType } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, ChevronRight, GraduationCap, Megaphone, MessageCircle, NotebookPen, Send, Users } from 'lucide-react'
import type { ConnectRecipientStatus } from '@shared/api/feature_yajur_connect'
import { api } from '@/lib/api'
import { Badge, ErrorState, Loading } from '@/components/ui'
import { PersonAvatar } from '@/components/ChatScreen'
import { cn, formatDateTime } from '@/lib/utils'
import { STATUS_LABEL, STATUS_TONE } from './YajurConnectSend'

export type ConnectTab = 'chats' | 'send' | 'campaigns' | 'log' | 'templates' | 'people' | 'workbooks'

export interface ConnectOverviewData {
  parents: number
  students: number
  notices: number
  delivery: { sent: number; delivered: number; read: number; failed: number; pending: number }
  replies: { id: string; name: string; student_name: string | null; preview: string; at: string; unread: number }[]
  campaigns: { id: string; name: string; audience_label: string; recipient_count: number; created_at: string; counts: Partial<Record<ConnectRecipientStatus, number>> }[]
  connection: 'ready' | 'incomplete' | 'off' | 'not_set_up'
  guard_on: boolean
  test_numbers: number
  autoreplies: { total: number; enabled: number }
}

export const useConnectOverview = () =>
  useQuery({ queryKey: ['connect', 'overview'], queryFn: () => api.get<ConnectOverviewData>('/api/v1/comms/yajur-connect/overview') })

const n = (v: number) => v.toLocaleString('en-IN')
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
/* The one card shape on this screen: rounded, bordered, and it lifts on hover when it does something. */
const CARD = 'rounded-[20px] border bg-card shadow-sm'
const LIFT = 'transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0'

function Shortcut({ icon: Icon, title, detail, onClick, main = false }: { icon: ComponentType<{ className?: string }>; title: string; detail: string; onClick: () => void; main?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('group flex min-h-[76px] w-full items-center gap-3.5 p-4 text-left', CARD, LIFT, main && 'border-primary bg-primary text-primary-foreground hover:border-primary')}>
      <span className={cn('grid size-11 shrink-0 place-items-center rounded-2xl', main ? 'bg-primary-foreground/15' : 'bg-primary/10 text-primary')}><Icon className="h-5 w-5" /></span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        <span className={cn('block text-sm', main ? '' : 'text-muted-foreground')}>{detail}</span>
      </span>
      <ArrowUpRight className={cn('h-5 w-5 shrink-0 self-start transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5', main ? 'opacity-80' : 'text-muted-foreground group-hover:text-primary')} />
    </button>
  )
}

function Count({ icon: Icon, tint, label, value, line, onClick }: { icon: ComponentType<{ className?: string }>; tint: string; label: string; value: string; line: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex w-full items-center gap-3.5 p-4 text-left', CARD, LIFT)}>
      <span className={cn('grid size-11 shrink-0 place-items-center rounded-2xl', tint)}><Icon className="h-5 w-5" /></span>
      <span className="min-w-0">
        <span className="block text-sm text-muted-foreground">{label}</span>
        <span className="block text-[28px] font-extrabold leading-tight tabular-nums">{value}</span>
        <span className="block truncate text-[12.5px] text-muted-foreground">{line}</span>
      </span>
    </button>
  )
}

function Head({ title, action, onClick }: { title: string; action: string; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b px-[var(--card-pad)] py-3">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <button type="button" onClick={onClick}
        className="inline-flex min-h-9 items-center gap-1 rounded-full border px-3.5 text-[13px] transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary">
        {action}<ChevronRight className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}

export default function ConnectOverview({ go }: { go: (tab: ConnectTab, chatId?: string) => void }) {
  const q = useConnectOverview()
  if (q.isLoading) return <Loading />
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const d = q.data, dl = d.delivery
  // message_log keeps one status per message, so a read message was also sent and delivered.
  const sent = dl.sent + dl.delivered + dl.read, delivered = dl.delivered + dl.read, read = dl.read
  const funnel = [
    { label: 'Sent', value: sent, bar: 'bg-primary', w: sent ? 100 : 0, p: '' },
    { label: 'Delivered', value: delivered, bar: 'bg-success', w: pct(delivered, sent), p: `${pct(delivered, sent)}%` },
    { label: 'Read', value: read, bar: 'bg-info', w: pct(read, sent), p: `${pct(read, sent)}%` },
  ]
  const lastNotice = d.campaigns[0]

  return (
    <div className="flex min-w-0 flex-col gap-4 pt-1">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Shortcut main icon={Send} title="Send a notice" detail="Choose classes, preview and send" onClick={() => go('send')} />
        <Shortcut icon={MessageCircle} title="Reply to parents"
          detail={d.replies.some((r) => r.unread > 0) ? `${d.replies.reduce((a, r) => a + r.unread, 0)} new waiting` : 'Continue a conversation'} onClick={() => go('chats')} />
        <Shortcut icon={NotebookPen} title="Share workbooks" detail="The right photo, the right class" onClick={() => go('workbooks')} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Count icon={Users} tint="bg-info/15 text-info" label="Parent contacts" value={n(d.parents)} line="with a phone number" onClick={() => go('people')} />
        <Count icon={GraduationCap} tint="bg-primary/10 text-primary" label="Students" value={n(d.students)} line="on the roll" onClick={() => go('people')} />
        <Count icon={Megaphone} tint="bg-warning/15 text-warning" label="Notices sent" value={n(d.notices)}
          line={lastNotice ? `last on ${formatDateTime(lastNotice.created_at)}` : 'none yet'} onClick={() => go('campaigns')} />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section className={cn('min-w-0 overflow-hidden', CARD)}>
          <Head title="Recent replies" action="All chats" onClick={() => go('chats')} />
          {d.replies.length === 0
            ? <p className="p-[var(--card-pad)] text-sm text-muted-foreground">No replies from parents yet.</p>
            : <ul className="divide-y">
                {d.replies.map((x) => (
                  <li key={x.id}>
                    <button type="button" onClick={() => go('chats', x.id)}
                      className="group flex min-h-[56px] w-full flex-wrap items-center gap-3 px-[var(--card-pad)] py-3 text-left transition-colors hover:bg-primary/5">
                      <PersonAvatar name={x.name} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{x.name}</span>
                        <span className="block truncate text-sm text-muted-foreground">{x.preview || (x.student_name ?? '')}</span>
                      </span>
                      <span className="ml-auto flex min-w-0 max-w-full flex-col items-end gap-1">
                        <span className="text-right text-xs text-muted-foreground">{formatDateTime(x.at)}</span>
                        {x.unread > 0 && <Badge tone="success">{`${x.unread} new`}</Badge>}
                      </span>
                      <span className="hidden shrink-0 items-center text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-primary sm:flex">
                        Open<ChevronRight className="size-3.5" aria-hidden />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>}
        </section>

        <section className={cn('min-w-0 overflow-hidden', CARD)}>
          <Head title="Message delivery" action="Delivery log" onClick={() => go('log')} />
          {/* One funnel, each step a share of what was sent (owner, 2026-11-23). */}
          <div className="space-y-1 p-[var(--card-pad)]">
            {funnel.map((f) => (
              <button key={f.label} type="button" onClick={() => go('log')} className="block w-full rounded-xl px-2 py-2 text-left transition-colors hover:bg-primary/5">
                <span className="mb-1.5 flex items-baseline justify-between text-sm">
                  <span>{f.label}</span>
                  <span className="font-semibold tabular-nums">{n(f.value)}{f.p && <span className="ml-1 font-normal text-muted-foreground">· {f.p}</span>}</span>
                </span>
                <span className="block h-2.5 overflow-hidden rounded-full bg-muted">
                  <span className={cn('block h-full rounded-full', f.bar)} style={{ width: `${f.w}%` }} />
                </span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 px-[var(--card-pad)] pb-[var(--card-pad)]">
            <button type="button" onClick={() => go('log')} className={cn('rounded-2xl bg-destructive/10 px-4 py-3 text-left text-destructive', LIFT)}>
              <span className="block text-xl font-bold tabular-nums">{n(dl.failed)}</span><span className="text-[12.5px]">Failed · see why</span>
            </button>
            <button type="button" onClick={() => go('log')} className={cn('rounded-2xl bg-warning/10 px-4 py-3 text-left text-warning', LIFT)}>
              <span className="block text-xl font-bold tabular-nums">{n(dl.pending)}</span><span className="text-[12.5px]">Waiting to send</span>
            </button>
          </div>
        </section>
      </div>

      <section className={cn('min-w-0 overflow-hidden', CARD)}>
        <Head title="Recent notices" action="Notice history" onClick={() => go('campaigns')} />
        {d.campaigns.length === 0
          ? <p className="p-[var(--card-pad)] text-sm text-muted-foreground">No notices sent yet.</p>
          : <ul className="divide-y">
              {d.campaigns.map((w) => {
                const keys = (Object.keys(STATUS_LABEL) as ConnectRecipientStatus[]).filter((k) => w.counts[k])
                return (
                  <li key={w.id}>
                    <button type="button" onClick={() => go('campaigns')}
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-[var(--card-pad)] py-3 text-left transition-colors hover:bg-primary/5">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Megaphone className="size-5" aria-hidden /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{w.name}</span>
                        <span className="block truncate text-sm text-muted-foreground">
                          {[w.audience_label, `${n(w.recipient_count)} parents`, formatDateTime(w.created_at)].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {keys.map((k) => <Badge key={k} tone={STATUS_TONE[k]}>{`${STATUS_LABEL[k]} ${w.counts[k]}`}</Badge>)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>}
      </section>
    </div>
  )
}
