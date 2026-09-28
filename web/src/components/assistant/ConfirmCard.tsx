import { ArrowRight, Check, Wand2, X } from 'lucide-react'
import type { AgentCard } from './agent'

/* A change the assistant prepared, as a card with a clear diff: the headline
   counts (recipients, rows, amount), then each thing that changes, before and
   after. Only Confirm writes, and the server re-checks both the permission and
   that these are exactly the arguments it prepared. */

export function ConfirmCard({ card, onConfirm, onCancel }: { card: AgentCard; onConfirm: () => void; onCancel: () => void }) {
  const state = card.state ?? 'idle'
  const accent = 'hsl(var(--brand-accent,var(--primary)))'
  return (
    <div className="assistant-action mt-2 rounded-[11px] border bg-card/60 p-3 text-foreground">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Wand2 className="size-3.5" style={{ color: accent }} aria-hidden />
        {card.title}
        {card.sensitive && (
          <span className="ml-auto rounded-md bg-destructive/10 px-1.5 py-0.5 text-[12px] font-medium text-destructive">Check carefully</span>
        )}
      </div>
      <p className="mt-1.5 text-[13px] leading-snug">{card.summary}</p>

      {card.counts && card.counts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-[12px]">
          {card.counts.map((c, i) => (
            <span key={i} className="rounded-md bg-muted px-2 py-0.5">
              <span className="font-semibold tabular-nums">{c.value}</span> <span className="text-muted-foreground">{c.label}</span>
            </span>
          ))}
        </div>
      )}

      {card.changes && card.changes.length > 0 ? (
        <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-[12px]">
          {card.changes.map((ch, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 font-medium">{ch.label}</span>
              {ch.before !== undefined && (
                <>
                  <span className="rounded bg-muted px-1.5 text-muted-foreground line-through">{ch.before}</span>
                  <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
                </>
              )}
              <span className="min-w-0 whitespace-pre-wrap rounded px-1.5" style={{ background: `color-mix(in srgb, ${accent} 14%, transparent)` }}>{ch.after}</span>
            </li>
          ))}
        </ul>
      ) : (card.before || card.after) && (
        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <span className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground line-through">{card.before || '-'}</span>
          <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
          <span className="rounded-md px-2 py-0.5 font-medium" style={{ background: `color-mix(in srgb, ${accent} 14%, transparent)` }}>{card.after || '-'}</span>
        </div>
      )}

      {state === 'done' && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-400">
          <Check className="size-4" aria-hidden /> {card.result}
        </div>
      )}
      {state === 'cancelled' && <div className="mt-2.5 text-[12.5px] text-muted-foreground">Cancelled, nothing was changed.</div>}
      {state === 'error' && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-destructive"><X className="size-4" aria-hidden /> {card.result}</div>
      )}
      {(state === 'idle' || state === 'error') && (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold transition-opacity hover:opacity-90
                       bg-[hsl(var(--brand-accent,var(--primary)))] text-[hsl(var(--brand-accent-foreground,var(--primary-foreground)))]"
          >
            {state === 'error' ? 'Try again' : 'Confirm'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[8px] border px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent"
          >
            Cancel
          </button>
        </div>
      )}
      {state === 'busy' && <div className="mt-2.5 text-[12.5px] text-muted-foreground">Making the change…</div>}
    </div>
  )
}
