import { useEffect, useRef, useState } from 'react'
import { Mic, Square, X } from 'lucide-react'
import { AssistantOrb, type OrbState } from '@/components/AssistantOrb'
import { useDictation } from '@/lib/speech'
import { cn } from '@/lib/utils'

/* A small tab, and a small panel. Never the whole screen.

   An assistant that takes over the window makes somebody leave the thing they
   were doing to ask a question about it — which is backwards, because the
   question is nearly always about what is on screen. A 360px panel in the
   corner keeps the register, the invoice or the timetable visible while it is
   being asked about.

   WHERE IT POINTS. VITE_ASSISTANT_URL, and there is deliberately no default. A
   chat box that silently posts nowhere is worse than no chat box: it looks
   answerable, takes a question, and fails after the person has typed it. With
   nothing configured the panel says so before they type. */

const ENDPOINT = (import.meta as { env?: Record<string, string> }).env?.VITE_ASSISTANT_URL ?? ''
const STORAGE_KEY = 'erp.assistant.conversation'

/** What the draft becomes once a spoken phrase is settled: the two joined by a
    single space, and neither given a stray one when the other is empty. */
function draftWith(existing: string, spoken: string): string {
  if (!spoken) return existing
  return existing ? `${existing} ${spoken}` : spoken
}

interface Turn {
  role: 'user' | 'bot' | 'error'
  text: string
  sources?: string[]
}

export function AssistantTab() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<OrbState>('idle')
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const conversation = useRef<string | null>(
    typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null,
  )

  /* Speech lands in the DRAFT, not in the conversation.

     Sending on the final result would be quicker by one press and wrong: a
     recogniser mishears a school's name or a roll number often enough that
     asking the question it thinks it heard, with no chance to look first,
     produces an answer to something nobody asked. What was heard goes in the
     box the keyboard writes to, where it can be corrected. `heard` is kept
     apart from what was typed so an interim result — which the recogniser
     revises word by word — replaces the last interim rather than accumulating
     "how how do how do I". */
  const typed = useRef('')
  const dictation = useDictation((text, final) => {
    setDraft(text ? `${typed.current}${typed.current ? ' ' : ''}${text}` : typed.current)
    if (final) typed.current = draftWith(typed.current, text)
  })

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    // Pinned to the newest message. A log that does not follow its own output
    // makes somebody scroll to read the answer they just asked for.
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [turns])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  async function ask() {
    const message = draft.trim()
    if (!message || state !== 'idle') return
    if (dictation.listening) dictation.stop()
    setDraft('')
    typed.current = ''
    setTurns((t) => [...t, { role: 'user', text: message }])

    if (!ENDPOINT) {
      setTurns((t) => [...t, {
        role: 'error',
        text: 'No assistant is connected. Set VITE_ASSISTANT_URL to a chat endpoint and rebuild.',
      }])
      return
    }

    setState('thinking')
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, conversation_id: conversation.current }),
      })
      if (!res.ok) throw new Error(`The assistant returned ${res.status}.`)
      const data = await res.json()
      if (data.conversation_id) {
        conversation.current = data.conversation_id
        localStorage.setItem(STORAGE_KEY, data.conversation_id)
      }
      setState('answering')
      setTurns((t) => [...t, {
        role: 'bot',
        text: data.answer ?? '',
        // Filenames only. A similarity score means something to whoever tuned
        // the threshold and nothing to a clerk.
        sources: [...new Set(((data.sources ?? []) as { filename: string }[]).map((s) => s.filename))],
      }])
      // Long enough for the answering state to be seen; the orb is the only
      // thing that says the turn finished cleanly.
      await new Promise((r) => setTimeout(r, 450))
    } catch (err) {
      setTurns((t) => [...t, { role: 'error', text: (err as Error).message }])
    } finally {
      setState('idle')
      inputRef.current?.focus()
    }
  }

  return (
    <>
      {/* The tab. Bottom-RIGHT, which is where an assistant is looked for.

          It was bottom-left, and left is where this product's navigation lives:
          the sidebar, its groups, its active mark. A floating control in that
          corner reads as one more navigation item that has come loose. The
          right-hand bottom corner is empty in every layout here and is where a
          decade of chat widgets has trained people to look.

          The panel is lifted clear of the dock rather than sharing its line:
          the dock is centred and ~44px tall, so a panel anchored at bottom-5
          puts its own text input directly on top of the dock's settings gear —
          two controls in the same pixels, and the one you hit is whichever
          happens to be painted last. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Assistant"
        className={cn(
          `fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border
           bg-card py-1.5 pl-1.5 pr-3 text-[12.5px] shadow-lg transition-colors
           hover:bg-accent focus-visible:outline-none focus-visible:ring-2
           focus-visible:ring-ring`,
          open && 'opacity-0 pointer-events-none',
        )}
      >
        <AssistantOrb state={state} size={30} />
        <span>Ask</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Assistant"
          className="fixed bottom-24 right-5 z-40 flex h-[min(520px,calc(100vh-8rem))] w-[min(380px,calc(100vw-2.5rem))]
                     flex-col overflow-hidden rounded-[16px] border bg-card shadow-2xl"
        >
          <header className="flex items-center gap-2.5 border-b px-3 py-2.5">
            <AssistantOrb state={state} size={30} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold leading-tight">Assistant</p>
              <p className="text-[11.5px] text-muted-foreground">
                {state === 'thinking' ? 'Looking it up…'
                  : state === 'answering' ? 'Answering'
                  : ENDPOINT ? 'Ready' : 'Not connected'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="grid size-7 place-items-center rounded-full text-muted-foreground
                         transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </header>

          <div ref={logRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {turns.length === 0 && (
              <p className="px-1 text-[12.5px] text-muted-foreground">
                Ask about anything in your documents. Answers cite the file they came from,
                and it says so when it does not know.
              </p>
            )}
            {turns.map((turn, i) => (
              <div key={i} className={cn('max-w-[86%]', turn.role === 'user' && 'ml-auto')}>
                <p
                  className={cn(
                    'whitespace-pre-wrap rounded-[12px] px-3 py-2 text-[13px]',
                    turn.role === 'user' && 'bg-primary-soft text-primary',
                    turn.role === 'bot' && 'bg-accent',
                    turn.role === 'error' && 'bg-destructive/15 text-destructive',
                  )}
                >
                  {turn.text}
                </p>
                {turn.sources && turn.sources.length > 0 && (
                  <p className="mt-1 px-1 text-[11px] text-muted-foreground">
                    Sources: {turn.sources.join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Said above the box, where the answer to "is it hearing me?" has to
              be. The pulsing dot is the only moving thing in the panel while
              recognition is open, which is what distinguishes listening from a
              microphone that was pressed and did not start. */}
          {(dictation.listening || dictation.error) && (
            <p
              role="status"
              className={cn(
                'flex items-center gap-2 border-t px-3 py-1.5 text-[11.5px]',
                dictation.error ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {dictation.listening && (
                <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
              )}
              {dictation.error ?? 'Listening — speak your question.'}
            </p>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); void ask() }}
            className="flex items-center gap-2 border-t px-3 py-2.5"
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                // Typing supersedes anything a half-finished spoken phrase would
                // have been appended to, so the two never fight over the box.
                typed.current = e.target.value
              }}
              maxLength={4000}
              placeholder={dictation.supported ? 'Ask, or press the microphone…' : 'Ask a question…'}
              aria-label="Your question"
              className="min-w-0 flex-1 rounded-full border bg-background px-3 py-1.5 text-[13px]
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {/* Drawn only where it works. Firefox has no speech recognition at
                all, so on Firefox there is no microphone — a button that does
                nothing when pressed is worse than an absent one, because the
                person presses it, waits, and concludes the assistant is
                broken. */}
            {dictation.supported && (
              <button
                type="button"
                onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
                disabled={state !== 'idle'}
                aria-label={dictation.listening ? 'Stop listening' : 'Ask by voice'}
                aria-pressed={dictation.listening}
                title={dictation.listening ? 'Stop listening' : 'Ask by voice'}
                className={cn(
                  `grid size-8 shrink-0 place-items-center rounded-full border transition-colors
                   disabled:opacity-40`,
                  dictation.listening
                    ? 'border-destructive bg-destructive text-white'
                    : 'hover:bg-accent',
                )}
              >
                {dictation.listening
                  ? <Square className="size-3 fill-current" />
                  : <Mic className="size-3.5" />}
              </button>
            )}
            <button
              type="submit"
              disabled={state !== 'idle' || !draft.trim()}
              className="rounded-full bg-primary px-3.5 py-1.5 text-[12.5px] font-medium
                         text-primary-foreground disabled:opacity-40"
            >
              Ask
            </button>
          </form>
        </div>
      )}
    </>
  )
}
