import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Badge, Button } from '@/components/ui'
import { cn } from '@/lib/utils'

/* ONE NOTIFICATION ROW, used by the bell drawer and the staff home panel.

   Icon tile (or a status thumbnail) | title + time, tag chips, one-line
   snippet | View, inline and centred so it never sits on the text
   (owner, 2026-10-24). Hover lift is pointer-only and off under reduced
   motion: see `.note-row` in styles/motion.css. */

type Tone = 'primary' | 'info' | 'success' | 'warning' | 'destructive'

const TONE: Record<Tone, string> = {
  primary: 'bg-primary/10 text-primary',
  info: 'bg-info/10 text-info',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
}

const FAMILY_TONE: Record<string, Tone> = {
  Fees: 'warning', Attendance: 'success', Homework: 'info', Results: 'info',
  Lessons: 'info', Timetable: 'info', Notice: 'destructive',
}

export function kindTone(label: string): Tone {
  return FAMILY_TONE[label] ?? 'primary'
}

/** The channel a message went by, only when its text says so. */
export function channelOf(text?: string): string | undefined {
  const m = text?.match(/\b(whatsapp|sms|e-?mail)\b/i)
  if (!m) return undefined
  const c = m[1].toLowerCase()
  return c === 'whatsapp' ? 'WhatsApp' : c === 'sms' ? 'SMS' : 'Email'
}

export interface NotificationRowProps {
  title: string
  time: string
  label: string
  icon: LucideIcon
  /** In place of the icon tile (a status thumbnail). */
  media?: ReactNode
  /** Second tag after the kind (e.g. the channel or "Photo"). */
  extra?: string
  snippet?: ReactNode
  /** Snippet shown in full (read here). */
  expanded?: boolean
  unread?: boolean
  pending?: boolean
  viewLabel?: string
  onOpen?: () => void
  onView: () => void
}

export default function NotificationRow({
  title, time, label, icon: Icon, media, extra, snippet, expanded, unread, pending,
  viewLabel = 'View', onOpen, onView,
}: NotificationRowProps) {
  const tone = TONE[kindTone(label)]
  const main = (
    <>
      {media ?? (
        <span className={cn('grid size-[38px] shrink-0 place-items-center rounded-[11px]', tone)} aria-hidden>
          <Icon className="size-[18px]" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn('min-w-0 truncate text-[14px] sm:text-[13.5px]', unread || pending ? 'font-bold' : 'font-semibold')}>{title}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground sm:text-[11px]">{time}</span>
        </span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
          <span className={cn('truncate rounded-full px-1.5 py-px text-[12px] font-semibold capitalize sm:text-[11px]', tone)}>{label}</span>
          {extra && <span className="rounded-full bg-muted px-1.5 py-px text-[12px] font-medium text-muted-foreground sm:text-[11px]">{extra}</span>}
          {pending && <Badge tone="warning">Pending</Badge>}
        </span>
        {snippet && (
          <span className={cn('mt-1 block text-[14px] text-muted-foreground sm:text-[12.5px]', !expanded && 'truncate')}>{snippet}</span>
        )}
      </span>
    </>
  )
  return (
    <div className={cn('note-row group flex items-center gap-3 rounded-[17px] border bg-card px-3.5 py-3 shadow-sm [@media(hover:hover)]:hover:border-foreground/25 [@media(hover:hover)]:hover:shadow-md',
      unread || pending ? 'border-primary/30' : 'border-border')}>
      {onOpen
        ? <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">{main}</button>
        : <div className="flex min-w-0 flex-1 items-center gap-3">{main}</div>}
      <Button size="sm" variant="secondary" className="shrink-0 max-sm:min-h-[48px] [@media(hover:hover)]:group-hover:bg-primary [@media(hover:hover)]:group-hover:text-primary-foreground" onClick={onView}>{viewLabel}</Button>
    </div>
  )
}
