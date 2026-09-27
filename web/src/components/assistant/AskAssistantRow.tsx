import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { askAssistant } from './agent'

/* The command search's way into the assistant: a question in words, rather
   than a screen or a name, is offered to the assistant as the first row, and
   Enter on it (or on a search with no hits) asks it there. */
export function AskAssistantRow({ q, active, onAsked }: { q: string; active: boolean; onAsked: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => { askAssistant(q.trim()); onAsked() }}
        data-command-hit={active ? 'active' : undefined}
        className={cn('flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-accent', active && 'bg-accent')}
      >
        <Sparkles className="h-4 w-4 shrink-0 text-[hsl(var(--brand-accent,var(--primary)))]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium">Ask the assistant</span>
          <span className="block truncate text-[12px] text-muted-foreground">“{q.trim()}”</span>
        </span>
      </button>
    </li>
  )
}
