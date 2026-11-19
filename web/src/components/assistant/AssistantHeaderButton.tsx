import { Sparkles } from 'lucide-react'

/* The assistant on a phone lives in the header, beside search and the bell
   (owner, 2026-11-19: the floating bubble sat over cards and buttons). The
   floating orb is hidden below 768px; this opens the same panel. Drawn only
   while the orb is mounted (AssistantTab sets :root[data-assistant]), so it
   disappears wherever the assistant is off. */
export const ASSISTANT_TOGGLE = 'erp:assistant-toggle'

export function AssistantHeaderButton() {
  return (
    <button
      type="button"
      data-assistant-head=""
      aria-label="Assistant"
      title="Assistant"
      onClick={() => window.dispatchEvent(new Event(ASSISTANT_TOGGLE))}
      className="h-12 w-12 shrink-0 place-items-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Sparkles className="h-5 w-5" aria-hidden />
    </button>
  )
}
