import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, FormNotice, Loading, Table, Td } from '@/components/ui'
import { CHANNEL_NAMES } from './delivery-lib'

/* Delivery per notice: how many families each notice reached, on which
   channel, who it did not reach, and a button to resend to them by a channel
   not yet tried. Statuses come from the providers' own receipts (WhatsApp
   status webhooks, the email provider's events, the SMS vendor's delivery
   reports) and, for in-app, whether the notification was opened. */

interface Counts { total: number; queued: number; held: number; sent: number; delivered: number; read: number; failed: number; suppressed: number }
interface Source { kind: string; id: string; title: string; at: string; counts: Counts; not_received: number }
interface Person { key: string; name: string; status: string; received: boolean; attempts: { channel: string; status: string; error?: string; at?: string }[] }
interface Detail { kind: string; id: string; title: string; counts: Counts; people: Person[] }

const TONE: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  read: 'success', delivered: 'success', sent: 'info', queued: 'neutral', held: 'neutral', failed: 'danger', suppressed: 'warning',
}
const WORD: Record<string, string> = {
  read: 'Read', delivered: 'Delivered', sent: 'Sent', queued: 'Queued', held: 'In tonight’s digest', failed: 'Failed', suppressed: 'Held back',
}

function CountLine({ c }: { c: Counts }) {
  return (
    <span className="flex flex-wrap gap-1">
      {(['read', 'delivered', 'sent', 'queued', 'held', 'failed', 'suppressed'] as const).filter((k) => c[k]).map((k) => (
        <Badge key={k} tone={TONE[k]}>{c[k]} {WORD[k].toLowerCase()}</Badge>
      ))}
    </span>
  )
}

export default function DeliveryReceipts() {
  const [open, setOpen] = useState<Source | null>(null)
  const list = useQuery({
    queryKey: ['message-deliveries'],
    queryFn: () => api.get<{ items: Source[] }>('/api/v1/admin/messaging/deliveries'),
    refetchInterval: 60_000,
  })
  if (open) return <DeliveryDetail src={open} onBack={() => setOpen(null)} />
  if (list.isPending) return <Loading label="Reading deliveries…" />
  if (list.error) return <ErrorState error={list.error} />
  const items = list.data?.items ?? []
  return (
    <Card>
      <CardHeader title="Delivery per notice" description="Every notice and alert sent to families, with what the providers reported back." />
      {items.length === 0 ? <EmptyState title="Nothing sent yet" /> : (
        <Table head={['Notice', 'Sent', 'Status', 'Not received', '']}>
          {items.map((s) => (
            <tr key={s.kind + s.id}>
              <Td>{s.title}<div className="text-[12px] text-muted-foreground">{s.kind.replace('_', ' ')}</div></Td>
              <Td>{s.at?.slice(0, 16).replace('T', ' ')}</Td>
              <Td><CountLine c={s.counts} /></Td>
              <Td>{s.not_received ? <Badge tone="danger">{s.not_received}</Badge> : '—'}</Td>
              <Td><Button size="sm" variant="secondary" onClick={() => setOpen(s)}>Open</Button></Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

function DeliveryDetail({ src, onBack }: { src: Source; onBack: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['message-delivery', src.kind, src.id],
    queryFn: () => api.get<Detail>(`/api/v1/admin/messaging/deliveries/${src.kind}/${src.id}`),
  })
  const resend = useMutation({
    mutationFn: (keys?: string[]) => api.post<{ queued: number; skipped: number; reasons: string[] }>(
      `/api/v1/admin/messaging/deliveries/${src.kind}/${src.id}/resend`, { keys }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['message-delivery', src.kind, src.id] })
      qc.invalidateQueries({ queryKey: ['message-deliveries'] })
    },
  })
  if (q.isPending) return <Loading label="Reading receipts…" />
  if (q.error || !q.data) return <ErrorState error={q.error} />
  const missed = q.data.people.filter((p) => !p.received && p.status !== 'queued' && p.status !== 'held')
  return (
    <Card>
      <CardHeader title={q.data.title} description="Per family: the best status any channel reached, and every attempt."
        action={<Button size="sm" variant="ghost" onClick={onBack}>Back</Button>} />
      <div className="space-y-3 px-5 py-4">
        <CountLine c={q.data.counts} />
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!missed.length} pending={resend.isPending} onClick={() => resend.mutate(undefined)}>
            Resend to {missed.length} by another channel
          </Button>
          <FormNotice error={resend.error}
            ok={resend.data ? `${resend.data.queued} queued, ${resend.data.skipped} skipped${resend.data.reasons.length ? ': ' + resend.data.reasons.join('; ') : ''}` : undefined} />
        </div>
      </div>
      <Table head={['Recipient', 'Status', 'Attempts', '']}>
        {q.data.people.map((p) => (
          <tr key={p.key}>
            <Td>{p.name || p.key}</Td>
            <Td><Badge tone={TONE[p.status] ?? 'neutral'}>{WORD[p.status] ?? p.status}</Badge></Td>
            <Td>
              <ul className="space-y-0.5 text-[12px]">
                {p.attempts.map((a, i) => (
                  <li key={i}>{CHANNEL_NAMES[a.channel] ?? a.channel}: {WORD[a.status] ?? a.status}{a.error ? ` · ${a.error}` : ''}</li>
                ))}
              </ul>
            </Td>
            <Td>{!p.received && p.status !== 'queued' && p.status !== 'held' && (
              <Button size="sm" variant="secondary" onClick={() => resend.mutate([p.key])}>Resend</Button>
            )}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
