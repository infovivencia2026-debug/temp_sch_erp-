import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Checkbox } from '@/components/ui'
import { type Estimate, HealthWarnings, rupees, useMessagingHealth } from './delivery-lib'

/* HOW A MESSAGE GOES OUT (owner, 2026-11-20): one row of ticks on every screen
   that sends to families — circulars, Present & absent, fee reminders.

   In app is ticked by default and may be unticked. Yajur Connect is the
   school's WhatsApp. SMS stays greyed out until the DLT registration is renewed
   and the provider is set up in Message Channels. Email shows only where a
   screen offers it and it is set up. The counts and the cost below follow the
   ticks; with nothing ticked there is nothing to send. */

export type Channel = 'in_app' | 'whatsapp' | 'sms' | 'email'
export const DEFAULT_CHANNELS: Channel[] = ['in_app']

const PAID: { ch: Channel; label: string; off: string }[] = [
  { ch: 'whatsapp', label: 'Yajur Connect', off: 'Yajur Connect is not set up yet. Set it up in Message Channels.' },
  { ch: 'sms', label: 'SMS', off: 'SMS needs the DLT renewal. Set it up in Message Channels.' },
  { ch: 'email', label: 'Email', off: 'Email is not set up yet. Set it up in Message Channels.' },
]

export function ChannelPicker({ value, onChange, email = false, lockInApp = false }: {
  value: Channel[]
  onChange: (v: Channel[]) => void
  /** Offer email as well (fee reminders). */
  email?: boolean
  /** In app cannot be switched off here (the automatic reminder plan always posts it). */
  lockInApp?: boolean
}) {
  const health = useMessagingHealth()
  const live = (ch: Channel) => health.data?.channels.find((x) => x.channel === ch)?.live ?? false
  const price = (ch: Channel) => health.data?.channels.find((x) => x.channel === ch)?.cost_paise ?? 0
  const rows = PAID.filter((p) => p.ch !== 'email' || (email && live('email')))

  /* A channel that is not live cannot stay ticked: it would count and cost
     nothing and send nothing. */
  useEffect(() => {
    if (!health.data) return
    const kept = value.filter((ch) => ch === 'in_app' || live(ch))
    if (kept.length !== value.length) onChange(kept)
  })

  const set = (ch: Channel, on: boolean) => onChange(on ? [...value.filter((x) => x !== ch), ch] : value.filter((x) => x !== ch))

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-[13px] font-medium">Send by</legend>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-6">
        <Checkbox
          checked={lockInApp || value.includes('in_app')}
          onChange={(on) => set('in_app', on)}
          disabled={lockInApp}
          label="In app"
          hint="The bell and the home screen. Free."
        />
        {rows.map((p) => {
          const on = live(p.ch)
          return (
            <Checkbox
              key={p.ch}
              checked={on && value.includes(p.ch)}
              onChange={(v) => set(p.ch, v)}
              disabled={!on}
              label={p.label}
              hint={health.isLoading ? 'Checking…' : on ? `${rupees(price(p.ch))} a message` : p.off}
            />
          )
        })}
      </div>
    </fieldset>
  )
}

/** What the ticked channels reach and cost: one of the estimate's three addressing forms. */
export function useChannelEstimate(
  key: unknown[],
  body: { message_type: string; channels: Channel[]; audience_role?: string; section_ids?: string[]; student_ids?: string[]; user_ids?: string[] },
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['channel-estimate', ...key, body.channels.slice().sort().join(',')],
    queryFn: () => api.post<Estimate>('/api/v1/admin/messaging/estimate', body),
    enabled: enabled && body.channels.length > 0,
    staleTime: 30_000,
  })
}

export function ChannelEstimate({ e, noun = 'families' }: { e: Estimate; noun?: string }) {
  const by = e.by_channel
  const parts = [
    by.in_app ? `${by.in_app} in app` : '',
    by.whatsapp ? `${by.whatsapp} by Yajur Connect` : '',
    by.sms ? `${by.sms} by SMS` : '',
    by.email ? `${by.email} by email` : '',
  ].filter(Boolean)
  return (
    <div className="space-y-2 text-[13px]">
      <p>
        Reaches <strong>{e.recipients}</strong> {e.recipients === 1 ? noun.replace(/ies$/, 'y').replace(/s$/, '') : noun}
        {parts.length ? `: ${parts.join(' · ')}` : ''}. Estimated cost <strong>{rupees(e.estimated_cost_paise)}</strong>.
      </p>
      <HealthWarnings warnings={e.warnings} compact />
    </div>
  )
}

/** The line shown in place of the estimate when every box is unticked. */
export const NOTHING_TICKED = 'Choose at least one way to send.'
