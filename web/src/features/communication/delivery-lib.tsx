import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'

/* Shared by the delivery screens and the compose screens: the honest channel
   status (GET /admin/messaging/health) and the cost estimate
   (POST /admin/messaging/estimate). See worker/src/services/delivery.ts. */

export interface ChannelHealth {
  channel: string
  label: string
  state: 'live' | 'not_configured' | 'no_credit' | 'off'
  live: boolean
  reason: string
  route: string
  provider: string
  credits: number | null
  cost_paise: number
}
export interface Health { channels: ChannelHealth[]; warnings: string[]; reaching_outside_app: boolean }

export interface Estimate {
  message_type: string
  mode: 'instant' | 'digest'
  ladder: string[]
  recipients: number
  by_channel: Record<string, number>
  estimated_cost_paise: number
  note?: string
  warnings: string[]
}

export const CHANNEL_NAMES: Record<string, string> = {
  in_app: 'In-app + push', push: 'Push', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', in_app_only: 'In-app only', digest: 'Digest',
}

export const rupees = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function useMessagingHealth() {
  return useQuery({
    queryKey: ['messaging-health'],
    queryFn: () => api.get<Health>('/api/v1/admin/messaging/health'),
    staleTime: 60_000,
  })
}

export function stateLabel(c: ChannelHealth): string {
  switch (c.state) {
    case 'live': return 'Live'
    case 'no_credit': return 'No credit'
    case 'off': return 'Switched off'
    default: return 'Not set up'
  }
}

/** The loud part: shown on the settings and before sending whenever a channel is not live. */
export function HealthWarnings({ warnings, compact }: { warnings: string[]; compact?: boolean }) {
  if (!warnings.length) return null
  return (
    <div role="alert" className="rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-[13px]">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <ul className="space-y-1">
          {(compact ? warnings.slice(0, 3) : warnings).map((w) => <li key={w}>{w}</li>)}
        </ul>
      </div>
    </div>
  )
}

/** What a send would reach and cost, for the compose screens. */
export function EstimateLine({ e }: { e: Estimate }) {
  const parts = Object.entries(e.by_channel).filter(([, n]) => n > 0).map(([k, n]) => `${n} by ${CHANNEL_NAMES[k] ?? k}`)
  return (
    <div className="space-y-2 text-[13px]">
      <p>
        <strong>{e.recipients}</strong> {e.recipients === 1 ? 'recipient' : 'recipients'}
        {parts.length ? `: ${parts.join(', ')}` : ''}. Estimated cost <strong>{rupees(e.estimated_cost_paise)}</strong>.
      </p>
      {e.note && <p className="text-muted-foreground">{e.note}</p>}
      <HealthWarnings warnings={e.warnings} compact />
    </div>
  )
}
