import { Check, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolStep } from './agent'

/* What the assistant looked up, drawn in the chat: one compact line per tool
   while it runs ("Listing fee defaulters…"), then its answer as a small table
   or a row of figures. Rows that are records open them. The server caps every
   table (25 rows), so this never has to page. */

export function ToolSteps({ steps, onOpen }: { steps: ToolStep[]; onOpen: (to: string) => void }) {
  if (steps.length === 0) return null
  return (
    <div className="mb-2 space-y-2">
      {steps.map((s) => <Step key={s.id} step={s} onOpen={onOpen} />)}
    </div>
  )
}

function Step({ step, onOpen }: { step: ToolStep; onOpen: (to: string) => void }) {
  const v = step.view
  return (
    <div className="rounded-[10px] border bg-card/60 text-[12.5px]">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground">
        {step.state === 'running' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {step.state === 'done' && <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />}
        {step.state === 'failed' && <X className="size-3.5 text-destructive" aria-hidden />}
        <span className="min-w-0 truncate">
          {step.state === 'running' ? `${step.label}…` : v?.title ?? step.label}
        </span>
        {v?.total !== undefined && v.total > v.rows.length && (
          <span className="ml-auto shrink-0 text-[11px]">{v.rows.length} of {v.total}</span>
        )}
      </div>
      {step.state === 'failed' && step.error && (
        <p className="border-t px-2.5 py-1.5 text-muted-foreground">{step.error}</p>
      )}
      {v?.stats && v.stats.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t px-2.5 py-1.5">
          {v.stats.map((s, i) => (
            <span key={i} className="rounded-md bg-muted px-2 py-0.5">
              <span className="text-muted-foreground">{s.label}</span>{' '}
              <span className="font-semibold tabular-nums text-foreground">{s.value}</span>
            </span>
          ))}
        </div>
      )}
      {v && v.rows.length > 0 && v.columns.length > 0 && (
        <div className="max-h-64 overflow-auto border-t">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-card">
              <tr>
                {v.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {v.rows.map((r, i) => {
                const to = v.row_links?.[i]
                return (
                  <tr
                    key={i}
                    onClick={to ? () => onOpen(to) : undefined}
                    className={cn('border-t border-border/60', to && 'cursor-pointer hover:bg-accent')}
                  >
                    {r.map((cell, j) => (
                      <td key={j} className={cn('px-2.5 py-1 align-top', typeof cell === 'number' && 'tabular-nums', j === 0 && to && 'font-medium text-[hsl(var(--brand-accent,var(--primary)))]')}>
                        {cell === '' ? '-' : cell}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
