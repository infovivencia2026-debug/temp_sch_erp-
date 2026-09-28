import { useState } from 'react'
import { Paperclip, Star, X } from 'lucide-react'
import { Badge, Button, SEG_BAR, Textarea } from '@/components/ui'
import { shrinkImage } from '@/lib/shrink-image'
import { cn, formatDate, formatDateTime } from '@/lib/utils'

/* The pieces the concern screens share: the office's family queue
   (GrievanceHub), HR's staff cell (Welfare), and the raiser's own view
   (portal Concerns, MyConcerns). One stage vocabulary everywhere, so a parent
   and the clerk read the same word for the same state. */

export const STAGES = ['new', 'acknowledged', 'in_progress', 'resolved', 'closed'] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_LABEL: Record<Stage, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
}

const STAGE_TONE: Record<Stage, 'warning' | 'info' | 'primary' | 'success' | 'neutral'> = {
  new: 'warning',
  acknowledged: 'info',
  in_progress: 'primary',
  resolved: 'success',
  closed: 'neutral',
}

export function StageBadge({ stage }: { stage: string }) {
  const s = (STAGES as readonly string[]).includes(stage) ? (stage as Stage) : 'new'
  return <Badge tone={STAGE_TONE[s]}>{STAGE_LABEL[s]}</Badge>
}

/** The stages as a filter row, each with its count. '' is "all". */
export function StageBar({
  counts, value, onChange,
}: { counts?: Partial<Record<Stage, number>>; value: string; onChange: (v: string) => void }) {
  const total = STAGES.reduce((a, s) => a + (counts?.[s] ?? 0), 0)
  const item = (key: string, label: string, n: number) => (
    <button
      key={key}
      type="button"
      aria-pressed={value === key}
      onClick={() => onChange(key)}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors [@media(pointer:coarse)]:py-2.5',
        value === key ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      <span className="tabular-nums text-[12px] text-muted-foreground">{n}</span>
    </button>
  )
  return (
    <div className={SEG_BAR} role="group" aria-label="Stage">
      {item('', 'All', total)}
      {STAGES.map((s) => item(s, STAGE_LABEL[s], counts?.[s] ?? 0))}
    </div>
  )
}

/** The promise and whether it was kept. */
export function SlaCell({
  respondDue, resolveDue, respondBreached, resolveBreached, acknowledged, settled,
}: {
  respondDue?: string; resolveDue?: string; respondBreached?: boolean; resolveBreached?: boolean
  acknowledged?: boolean; settled?: boolean
}) {
  if (!resolveDue && !respondDue) return <span className="text-muted-foreground">No deadline</span>
  return (
    <div className="space-y-0.5 text-[13px]">
      {!acknowledged && !settled && respondDue && (
        <div className={respondBreached ? 'font-medium text-destructive' : 'text-muted-foreground'}>
          Reply by {formatDateTime(respondDue)}
        </div>
      )}
      {resolveDue && (
        <div className={resolveBreached && !settled ? 'font-medium text-destructive' : undefined}>
          {settled ? 'Was due ' : 'Due '}{formatDate(resolveDue)}
        </div>
      )}
      {(respondBreached || resolveBreached) && (
        <Badge tone="danger">{resolveBreached ? 'Past deadline' : 'Reply overdue'}</Badge>
      )}
    </div>
  )
}

export interface TimelineEntry {
  id: string
  kind: string
  body: string
  new_status?: string
  author?: string
  created_at: string
  /** Office side: whether the raiser sees it. */
  visible?: boolean
  /** Written by the raiser. */
  from_raiser?: boolean
}

const KIND_LABEL: Record<string, string> = {
  created: 'Raised',
  note: 'Internal note',
  reply: 'Reply',
  raiser_reply: 'From the raiser',
  status: 'Status',
  assignment: 'Assignment',
  escalation: 'Escalation',
  resolution: 'Resolution',
  reopened: 'Reopened',
}

/** The case's history. `office` marks what the raiser can and cannot see. */
export function Timeline({ items, office, raiserLabel = 'From the raiser' }: { items: TimelineEntry[]; office?: boolean; raiserLabel?: string }) {
  if (items.length === 0) return <p className="text-[13px] text-muted-foreground">Nothing recorded yet.</p>
  return (
    <ol className="space-y-3">
      {items.map((u) => {
        const internal = office && u.visible === false
        const fromRaiser = u.from_raiser || u.kind === 'raiser_reply'
        return (
          <li
            key={u.id}
            className={cn(
              'rounded-md border-l-2 px-3 py-2',
              internal ? 'border-l-warning bg-warning/5' : fromRaiser ? 'border-l-primary bg-primary/5' : 'border-l-border bg-muted/40',
            )}
          >
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">
                {u.kind === 'raiser_reply' ? raiserLabel : KIND_LABEL[u.kind] ?? u.kind}
              </span>
              <span>{u.author ?? 'System'}</span>
              <span>{formatDateTime(u.created_at)}</span>
              {office && (internal
                ? <Badge tone="warning">Internal, not shown to the raiser</Badge>
                : <Badge tone="info">Seen by the raiser</Badge>)}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed">{u.body}</p>
          </li>
        )
      })}
    </ol>
  )
}

/** Attach one file (photo or PDF) to what is being raised. */
export function AttachFile({
  file, onChange,
}: { file: { id: string; name: string } | null; onChange: (f: { id: string; name: string } | null) => void }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground">
        <Paperclip className="h-3.5 w-3.5" aria-hidden />
        {uploading ? 'Uploading…' : file ? 'Replace the file' : 'Attach a photo or PDF'}
        <input
          type="file"
          className="hidden"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          disabled={uploading}
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            setUploading(true)
            setError('')
            try {
              const fd = new FormData()
              fd.append('file', await shrinkImage(f))
              fd.append('purpose', 'concern')
              const res = await fetch('/api/v1/files', { method: 'POST', body: fd, credentials: 'same-origin' })
              if (!res.ok) {
                const j = await res.json().catch(() => null)
                throw new Error(j?.error || 'Upload failed')
              }
              const made = await res.json()
              onChange({ id: made.file_id, name: made.name })
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not upload that file.')
            } finally {
              setUploading(false)
            }
          }}
        />
      </label>
      {file && (
        <span className="inline-flex items-center gap-1 text-[13px]">
          {file.name}
          <button type="button" aria-label="Remove the file" className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => onChange(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
      {error && <span className="text-[13px] text-destructive">{error}</span>}
    </div>
  )
}

export function AttachmentLink({ file }: { file?: { id: string; name: string } }) {
  if (!file) return null
  return (
    <a
      href={`/api/v1/files/${file.id}?inline=1`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
    >
      <Paperclip className="h-3.5 w-3.5" aria-hidden />
      {file.name}
    </a>
  )
}

/** Five stars and an optional note, sent once. */
export function RateResolution({
  onRate, pending,
}: { onRate: (rating: number, note: string) => void; pending?: boolean }) {
  const [rating, setRating] = useState(0)
  const [note, setNote] = useState('')
  return (
    <div className="space-y-2 rounded-md border px-3 py-3">
      <div className="text-[13px] font-medium">How well was this resolved?</div>
      <div className="flex gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} of 5`}
            onClick={() => setRating(n)}
            className="rounded p-1 text-muted-foreground hover:text-warning"
          >
            <Star className={cn('h-5 w-5', n <= rating && 'fill-warning text-warning')} />
          </button>
        ))}
      </div>
      {rating > 0 && (
        <>
          <Textarea rows={2} value={note} onChange={setNote} placeholder="Anything you want the school to know (optional)" />
          <Button size="sm" disabled={pending} onClick={() => onRate(rating, note)}>Send rating</Button>
        </>
      )}
    </div>
  )
}

export function Stars({ value }: { value?: number }) {
  if (!value) return null
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`Rated ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={cn('h-3.5 w-3.5', n <= value ? 'fill-warning text-warning' : 'text-muted-foreground/40')} />
      ))}
    </span>
  )
}
