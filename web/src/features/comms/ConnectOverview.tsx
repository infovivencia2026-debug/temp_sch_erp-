/* Yajur Connect Overview (worker/src/routes/comms/yajur_connect_overview.ts):
   the Connect home screen. Shortcuts to the tasks, school counts, delivery
   totals, the latest parent replies and the latest notices. */
import type { ComponentType } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, MessageCircle, Send } from 'lucide-react'
import type { ConnectRecipientStatus } from '@shared/api/feature_yajur_connect'
import { api } from '@/lib/api'
import { Badge, Button, Card, ErrorState, Loading, Stat } from '@/components/ui'
import { formatDateTime } from '@/lib/utils'
import { STATUS_LABEL, STATUS_TONE } from './YajurConnectSend'

export type ConnectTab = 'chats' | 'send' | 'campaigns' | 'log' | 'templates' | 'people'

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
  useQuery({ queryKey: ['connect', 'overview'], queryFn: () => api.get<ConnectOverviewData>('/comms/yajur-connect/overview') })

const n = (v: number) => v.toLocaleString('en-IN')

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

function Shortcut({ icon: Icon, title, detail, onClick }: { icon: ComponentType<{ className?: string }>; title: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="card flex min-h-[48px] w-full items-center gap-3 p-4 text-left">
      <Icon className="h-6 w-6 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{title}</span>
        <span className="block truncate text-sm text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
    </button>
  )
}

function Head({ title, action, onClick }: { title: string; action: string; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b px-[var(--card-pad)] py-3">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <Button variant="ghost" size="sm" onClick={onClick}>{action}</Button>
    </div>
  )
}

export default function ConnectOverview({ go }: { go: (tab: ConnectTab, chatId?: string) => void }) {
  const q = useConnectOverview()
  if (q.isLoading) return <Loading />
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const d = q.data, dl = d.delivery
  // message_log keeps one status per message, so a read message was also sent and delivered.
  const delivery = [
    { label: 'Sent', value: dl.sent + dl.delivered + dl.read, cls: '' },
    { label: 'Delivered', value: dl.delivered + dl.read, cls: 'text-success' },
    { label: 'Read', value: dl.read, cls: 'text-primary' },
    { label: 'Failed', value: dl.failed, cls: 'text-destructive' },
    { label: 'Waiting', value: dl.pending, cls: 'text-muted-foreground' },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-2xl font-semibold">{greeting()}</h2>
        <p className="text-sm text-muted-foreground">Your school's WhatsApp messages at a glance.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Shortcut icon={Send} title="Send a notice" detail="Choose classes, preview and send" onClick={() => go('send')} />
        <Shortcut icon={MessageCircle} title="Reply to parents" detail="Continue a conversation" onClick={() => go('chats')} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Parent contacts" value={n(d.parents)} onClick={() => go('people')} />
        <Stat label="Students" value={n(d.students)} onClick={() => go('people')} />
        <Stat label="Notices sent" value={n(d.notices)} onClick={() => go('campaigns')} />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <Head title="Recent replies" action="All chats" onClick={() => go('chats')} />
          {d.replies.length === 0
            ? <p className="p-[var(--card-pad)] text-sm text-muted-foreground">No replies from parents yet.</p>
            : <ul className="divide-y">
                {d.replies.map((x) => (
                  <li key={x.id}>
                    <button type="button" onClick={() => go('chats', x.id)} className="flex min-h-[48px] w-full items-center gap-3 px-[var(--card-pad)] py-3 text-left">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{x.name}</span>
                        <span className="block truncate text-sm text-muted-foreground">{x.preview || (x.student_name ?? '')}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-xs text-muted-foreground">{formatDateTime(x.at)}</span>
                        {x.unread > 0 && <Badge tone="primary">{`${x.unread} new`}</Badge>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>}
        </Card>

        <Card className="min-w-0">
          <Head title="Message delivery" action="Log" onClick={() => go('log')} />
          <div className="grid grid-cols-2 gap-4 p-[var(--card-pad)] sm:grid-cols-5">
            {delivery.map((x) => (
              <div key={x.label} className="min-w-0">
                <div className={`text-2xl font-semibold tabular-nums ${x.cls}`}>{n(x.value)}</div>
                <div className="truncate text-sm text-muted-foreground">{x.label}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="min-w-0">
        <Head title="Recent notices" action="All notices" onClick={() => go('campaigns')} />
        {d.campaigns.length === 0
          ? <p className="p-[var(--card-pad)] text-sm text-muted-foreground">No notices sent yet.</p>
          : <ul className="divide-y">
              {d.campaigns.map((w) => {
                const keys = (Object.keys(STATUS_LABEL) as ConnectRecipientStatus[]).filter((k) => w.counts[k])
                return (
                  <li key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-[var(--card-pad)] py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{w.name}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {[w.audience_label, `${n(w.recipient_count)} parents`, formatDateTime(w.created_at)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {keys.map((k) => <Badge key={k} tone={STATUS_TONE[k]}>{`${STATUS_LABEL[k]} ${w.counts[k]}`}</Badge>)}
                    </span>
                  </li>
                )
              })}
            </ul>}
      </Card>
    </div>
  )
}
