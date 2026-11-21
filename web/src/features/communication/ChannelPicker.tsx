import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Bell, Check, Lock, Mail, MessageCircle, MessageSquareText } from 'lucide-react'
import { cn } from '@/lib/utils'
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

/* Each way of sending is a card (owner, 2026-11-20: "plain checkboxes look
   weak"). The whole card is the control: role=checkbox, Space or Enter toggles,
   48px+ on phones. Selected = primary border, a soft tint and a check badge that
   scales in (transform/opacity only, instant under reduced motion). A channel
   that is not set up is a muted card with a lock and a link to fix it. */
const CARDS: { ch: Channel; label: string; note: string; off: string; Icon: typeof Bell }[] = [
  { ch: 'in_app', label: 'In app', note: 'The bell and the home screen', off: '', Icon: Bell },
  { ch: 'whatsapp', label: 'Yajur Connect', note: 'The school chat number', off: 'Set up', Icon: MessageCircle },
  { ch: 'sms', label: 'SMS', note: 'A text to the phone on record', off: 'Renew DLT', Icon: MessageSquareText },
  { ch: 'email', label: 'Email', note: 'To the email on record', off: 'Set up', Icon: Mail },
]

export function ChannelPicker({ value, onChange, email = false, lockInApp = false, estimate }: {
  value: Channel[]
  onChange: (v: Channel[]) => void
  /** Offer email as well (fee reminders). */
  email?: boolean
  /** In app cannot be switched off here (the automatic reminder plan always posts it). */
  lockInApp?: boolean
  /** The live estimate, so each ticked card can show whom it reaches and what it costs. */
  estimate?: Estimate
}) {
  const health = useMessagingHealth()
  const live = (ch: Channel) => ch === 'in_app' || (health.data?.channels.find((x) => x.channel === ch)?.live ?? false)
  const price = (ch: Channel) => health.data?.channels.find((x) => x.channel === ch)?.cost_paise ?? 0
  const cards = CARDS.filter((p) => p.ch !== 'email' || (email && live('email')))

  /* A channel that is not live cannot stay ticked: it would count and cost
     nothing and send nothing. */
  useEffect(() => {
    if (!health.data) return
    const kept = value.filter((ch) => live(ch) && !(ch === 'whatsapp' && estimate?.connect_ready === false))
    if (kept.length !== value.length) onChange(kept)
  })

  const set = (ch: Channel, on: boolean) => onChange(on ? [...value.filter((x) => x !== ch), ch] : value.filter((x) => x !== ch))

  const figure = (ch: Channel, on: boolean) => {
    const each = ch === 'in_app' ? 'Free' : `${rupees(price(ch))} each`
    if (!on || !estimate) return each
    const n = estimate.by_channel[ch] ?? 0
    const cost = ch === 'in_app' ? 'Free' : rupees(n * price(ch))
    return `${n} ${n === 1 ? 'parent' : 'parents'} · ${cost}`
  }

  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-medium">Send by</legend>
      <div className={cn('grid grid-cols-1 gap-2 sm:gap-3', cards.length > 3 ? 'sm:grid-cols-2 xl:grid-cols-4' : 'sm:grid-cols-3')}>
        {cards.map((p) => {
          const noTemplate = p.ch === 'whatsapp' && estimate?.connect_ready === false
          const ok = live(p.ch) && !noTemplate
          const locked = p.ch === 'in_app' && lockInApp
          const on = ok && (locked || value.includes(p.ch))
          const disabled = !ok || locked
          const toggle = () => { if (!disabled) set(p.ch, !on) }
          return (
            <div
              key={p.ch}
              role="checkbox"
              aria-checked={on}
              aria-disabled={disabled || undefined}
              aria-label={p.label}
              tabIndex={disabled ? -1 : 0}
              onClick={toggle}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle() } }}
              className={cn(
                'relative flex min-h-[64px] items-start gap-3 rounded-[12px] border p-3 text-left outline-none',
                'transition-transform duration-150 ease-out motion-reduce:transition-none',
                'focus-visible:ring-2 focus-visible:ring-primary/50',
                on ? 'border-primary bg-primary/[0.07]' : 'border-border bg-card',
                disabled ? (ok ? 'cursor-default' : 'cursor-not-allowed') : 'cursor-pointer hover:border-primary/60 active:scale-[0.98]',
              )}
            >
              <p.Icon aria-hidden className={cn('mt-0.5 h-6 w-6 shrink-0 sm:h-5 sm:w-5', on ? 'text-primary' : 'text-muted-foreground', !ok && 'opacity-60')} strokeWidth={1.75} />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[16px] font-medium sm:text-[14px]', !ok && 'text-muted-foreground')}>{p.label}</span>
                <span className="block text-[14px] text-muted-foreground sm:text-[12px]">{p.note}</span>
                <span className={cn('mt-1 block text-[14px] font-medium tabular-nums sm:text-[12px]', on ? 'text-primary' : 'text-muted-foreground')}>
                  {noTemplate
                    ? <a href="/go/message_channels" onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">No Yajur Connect template for this message: set one in Message Channels → Wording</a>
                    : !ok
                    ? (health.isLoading ? 'Checking…' : (
                      <a href="/go/message_channels" onClick={(e) => e.stopPropagation()} className="text-primary underline-offset-2 hover:underline">
                        {p.off} → Message Channels
                      </a>))
                    : figure(p.ch, on)}
                </span>
              </span>
              <span
                aria-hidden
                className={cn(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full border',
                  !ok ? 'border-transparent' : on ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                )}
              >
                {!ok
                  ? <Lock className="h-4 w-4 text-muted-foreground" />
                  : <Check className={cn('h-4 w-4 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none', on ? 'scale-100 opacity-100' : 'scale-50 opacity-0')} strokeWidth={2.5} />}
              </span>
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}

/* A tick that reads as a choice, not a form box: a pill with a check, used for
   "Select all absent (12)" and, without text, for the per-row tick in a list. */
export function TickChip({ on, onChange, label, srLabel, disabled }: {
  on: boolean
  onChange: (v: boolean) => void
  label?: string
  srLabel?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={srLabel}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        'inline-flex min-h-[48px] items-center gap-2 rounded-full border text-[16px] outline-none sm:min-h-[36px] sm:text-[13px]',
        'transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-primary/50',
        label ? 'px-3' : 'min-w-[48px] justify-center sm:min-w-[36px]',
        on ? 'border-primary bg-primary/[0.08] text-primary' : 'border-border bg-card',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-primary/60',
      )}
    >
      <span aria-hidden className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
        <Check className={cn('h-3.5 w-3.5 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none', on ? 'scale-100 opacity-100' : 'scale-50 opacity-0')} strokeWidth={2.5} />
      </span>
      {label && <span className="whitespace-nowrap">{label}</span>}
    </button>
  )
}

/** What the ticked channels reach and cost: one of the estimate's three addressing forms. */
export function useChannelEstimate(
  key: unknown[],
  body: { message_type: string; kind?: string; channels: Channel[]; test?: boolean; audience_role?: string; section_ids?: string[]; student_ids?: string[]; user_ids?: string[] },
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['channel-estimate', ...key, body.channels.slice().sort().join(','), !!body.test],
    queryFn: () => api.post<Estimate>('/api/v1/admin/messaging/estimate', body),
    enabled: (enabled || !!body.test) && body.channels.length > 0,
    staleTime: 30_000,
  })
}

export function ChannelEstimate({ e }: { e: Estimate }) {
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
        Reaches <strong>{e.recipients}</strong> {e.recipients === 1 ? 'parent' : 'parents'}
        {parts.length ? `: ${parts.join(' · ')}` : ''}. Estimated <strong>{rupees(e.estimated_cost_paise)}</strong>.
      </p>
      {e.goes_to && (
        <p className="text-muted-foreground">
          Goes to: {e.goes_to === 'primary' ? 'the primary parent only' : 'every linked parent'}
          {' '}(<a href="/go/privacy" className="text-primary hover:underline">change in Privacy</a>).
        </p>
      )}
      <HealthWarnings warnings={e.warnings} compact />
    </div>
  )
}

/* "Send to test parent only" (owner, 2026-11-20). Unticked by default. When
   ticked, whatever is picked above goes only to the school's test parents:
   the numbers on Message Channels -> allowlist. The banner says so in a
   colour that cannot be missed. */
export function TestSendTick({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="space-y-2">
      <TickChip on={on} onChange={onChange} label="Send to test parent only" />
      {on && (
        <p role="status" className="rounded-[12px] border border-warning/60 bg-warning/10 px-3 py-2 text-[14px] sm:text-[13px]">
          <strong>Test send.</strong> Only the test parents on the allowlist in{' '}
          <a href="/go/message_channels" className="text-primary hover:underline">Message Channels</a> get this, whoever is picked above.
        </p>
      )}
    </div>
  )
}

/** "Send to 12 parents", or "Test send to 1 parent". */
export const sendTo = (n: number, test: boolean) => `${test ? 'Test send' : 'Send'} to ${n} ${n === 1 ? 'parent' : 'parents'}`

/** The line shown in place of the estimate when every box is unticked. */
export const NOTHING_TICKED = 'Choose at least one way to send.'
