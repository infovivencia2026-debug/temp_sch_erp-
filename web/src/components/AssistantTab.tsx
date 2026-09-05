import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Mic, Square, X } from 'lucide-react'
import { AssistantOrb, type OrbState } from '@/components/AssistantOrb'
import { useOverlayHistory } from '@/lib/overlay-history'
import { useDictation } from '@/lib/speech'
import { useSession } from '@/lib/session'
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

/* The fast path, tried first and answered from the catalogue.

   Measured on the production box: a live model answer costs 88 seconds, because
   one vCPU processes a RAG prompt at about 50 tokens per second and the prompt
   is around 2,400 of them. Most questions do not need a model at all -- "how do
   I collect a fee" is answered by the catalogue entry for the screen that
   collects fees, and that lookup is a millisecond.

   Always tried, never skipped: it declines quietly when the question is not one
   it can answer, and the slow path picks it up. */
const FAST = '/api/v1/assistant/ask'
const STORAGE_KEY = 'erp.assistant.conversation'

/** What the draft becomes once a spoken phrase is settled: the two joined by a
    single space, and neither given a stray one when the other is empty. */
function draftWith(existing: string, spoken: string): string {
  if (!spoken) return existing
  return existing ? `${existing} ${spoken}` : spoken
}

/* The same question means different things to different people.

   "How do I collect a fee" has one answer for the accounts clerk who raises the
   receipt and another for the parent who pays it, and the help corpus is
   already split that way -- role-finance.md, role-parent.md, role-faculty.md,
   one per role, beside the common pages.

   Retrieval is similarity against the question, so naming the role in the
   question is what pulls that role's page up and pushes the other eight down.
   It is a prefix rather than a system prompt because the service takes one
   field: this steers the search itself, not just the wording of the answer,
   and the search is where a wrong-role answer is actually decided.

   The role never reaches the reader. It is prepended to what is sent and the
   panel still shows what they typed.

   A user with several roles gets all of them named; a user with none -- which
   is a signed-out session, or platform staff -- gets the question unchanged
   and the common pages, which is the right answer for somebody with no role to
   be answered as. */
function withRole(message: string, roles: string[] | undefined): string {
  if (!roles || roles.length === 0) return message
  return `[Asked by: ${roles.join(', ')}] ${message}`
}

interface Turn {
  role: 'user' | 'bot' | 'error'
  text: string
}

export function AssistantTab() {
  const session = useSession()
  const [open, setOpen] = useState(false)
  /* NOT ON SETTINGS.
   *
   * The orb floats above the dock at a fixed corner, which is right over a
   * page of full-width rows: measured at 390x844 it sat on top of the Account
   * row, so one of the things somebody came to Settings to press was covered
   * by a button for asking questions about something else.
   *
   * It is also the wrong offer there. Settings is where somebody changes a
   * thing they have already decided to change; the assistant belongs on the
   * screens where they are still working something out.
   *
   * Route-based rather than width-based because `/settings` IS the phone
   * case — above the drill-in breakpoint the same content is a dialog opened
   * from the dock, and the orb over a dialog is already handled by `open`. */
  const onSettings = useLocation().pathname.startsWith('/settings')

  /* Back closes the assistant rather than the app. See useOverlayHistory. */
  const closeAssistant = useCallback(() => setOpen(false), [])
  useOverlayHistory(open, closeAssistant)
  const [hover, setHover] = useState(false)
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
      /* The catalogue first.

         Role scoping happens here rather than in the question text: this
         endpoint reads the session cookie, so a parent cannot be answered with
         a staff screen by editing a request body. A failure is not reported --
         if the fast path is unreachable the slow one still works, and saying
         so twice helps nobody. */
      try {
        const quick = await fetch(FAST, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ message }),
        })
        if (quick.ok) {
          const hit = await quick.json()
          if (hit.answered && hit.answer) {
            setState('answering')
            setTurns((t) => [...t, { role: 'bot', text: hit.answer }])
            await new Promise((r) => setTimeout(r, 250))
            return
          }
        }
      } catch { /* the slow path is the fallback, and it is right below */ }

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The slow path is session-authenticated now, like the fast one.
        credentials: 'same-origin',
        body: JSON.stringify({
          message: withRole(message, session.user?.roles),
          conversation_id: conversation.current,
          // Sent as a field as well, for the day the service filters on it
          // rather than being steered by the question text. Ignored today.
          roles: session.user?.roles ?? [],
        }),
      })
      if (!res.ok) {
        /* The server's own sentence, when it sent one. Every refusal this
           route makes -- no key, rate limited, too slow -- is written to be
           read by whoever is looking at the panel, and replacing it with a
           status code throws away the only part that says what to do. */
        const detail = await res.json().catch(() => null)
        throw new Error(detail?.error?.message ?? `The assistant returned ${res.status}.`)
      }
      const data = await res.json()
      if (data.conversation_id) {
        conversation.current = data.conversation_id
        localStorage.setItem(STORAGE_KEY, data.conversation_id)
      }
      setState('answering')
      /* The answer, and not where it came from.

         Every reply used to carry "Sources: common-tasks.md, FEATURES.md,
         role-finance.md" under it. Those filenames are ours, not the
         reader's: a clerk asking how to collect a fee learns nothing from
         being told which markdown file the sentence was assembled out of, and
         the line was longer than some of the answers. It also leaked the shape
         of the corpus to anybody who could open the panel.

         The server still returns them and the field is still in its schema,
         because retrieval is worth debugging. It is simply not shown. */
      setTurns((t) => [...t, { role: 'bot', text: data.answer ?? '' }])
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

  /* Placed after every hook, so the early return cannot change how many run. */
  if (onSettings && !open) return null

  return (
    <>
      {/* The tab. Bottom-RIGHT, settled by asking rather than by inferring.

          It moved left, then right, then left again across one afternoon,
          because "the bot is still on the left corner" reads both as a
          complaint and as a statement of fact and I guessed wrong at it twice.
          The answer, once asked for plainly, was the right-hand corner: left is
          where this product's navigation lives, so a floating control down
          there reads as a nav item come loose.

          The panel is lifted clear of the dock rather than sharing its line:
          the dock is centred and ~44px tall, so a panel anchored at bottom-5
          puts its own text input directly on top of the dock's settings gear —
          two controls in the same pixels, and the one you hit is whichever
          happens to be painted last. */}
      <button data-assistant-orb=""
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        aria-expanded={open}
        aria-label="Assistant"
        title="Assistant"
        className={cn(
          /* THE ORB ALONE. NO WORD BESIDE IT.

             It was a 30px orb in a pill reading "Ask" — the size and shape of a
             status chip, which on a dashboard built out of large coloured cards
             read as one more label and got looked straight past. The first
             correction made everything bigger, the word included. The word was
             the part that did not belong.

             A round button is what a floating control in a corner is, and the
             orb is already the whole message: it is the only thing on the
             screen that moves, it brightens when pointed at, and it changes
             character between thinking and answering. "Ask" told a reader what
             the orb was doing anyway, in a place where nothing else competes
             for the meaning.

             The label survives for anybody who cannot see it — aria-label and
             title both say Assistant — so nothing is lost but the ink.

             transition-transform, not transition-colors: the tint alone was the
             entire hover response and was close to invisible at the corner of a
             busy screen. It lifts and deepens its shadow now, and the orb wakes
             at the same moment. Keyboard focus wakes it too, or the effect
             would exist only for a mouse. */
          /* ABOVE THE DOCK, NOT UNDER IT.

             At 24px from the bottom this button sat inside the phone bar's own
             band — the bar is roughly 90px tall once the home-indicator strip
             is counted, and it is z-50 to this button's z-40. So on a phone the
             assistant was drawn, half covered, and could not be pressed at all:
             every tap landed on the bar behind it.

             `--dock-h` is the bar's measured height including the safe area, so
             this follows it rather than guessing, and falls back to the old
             24px wherever the bar is not pinned to the edge — which is every
             width above 767. */
          `fixed right-6 z-40 grid size-16 place-items-center rounded-full
           border bg-card shadow-xl
           transition-[transform,box-shadow,background-color]
           hover:-translate-y-0.5 hover:bg-accent hover:shadow-2xl
           focus-visible:-translate-y-0.5 focus-visible:outline-none
           focus-visible:ring-2 focus-visible:ring-ring active:translate-y-0`,
          open && 'opacity-0 pointer-events-none',
        )}
        style={{ bottom: 'calc(var(--dock-h, 0px) + 1.25rem)' }}
      >
        <AssistantOrb state={state} size={44} awake={hover} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Assistant"
          className="fixed bottom-28 right-6 z-40 flex h-[min(520px,calc(100vh-9rem))] w-[min(380px,calc(100vw-3rem))]
                     flex-col overflow-hidden rounded-[16px] border bg-card shadow-2xl"
        >
          <header className="flex items-center gap-2.5 border-b px-3 py-2.5">
            <AssistantOrb state={state} size={36} />
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
                Ask about anything in the app. Answers come from the help for your
                role, and it says so when it does not know.
              </p>
            )}
            {turns.map((turn, i) => (
              <div key={i} className={cn('max-w-[86%]', turn.role === 'user' && 'ml-auto')}>
                <p
                  /* EVERY BUBBLE STATES BOTH HALVES OF ITS PAIR.

                     The question was `bg-primary-soft text-primary`, two tokens
                     that both move when somebody paints an accent colour — and
                     they move independently. Paint the accent green in dark
                     mode and --primary-soft resolves to a near-black green
                     while --primary resolves to a mid green on top of it:
                     unreadable, and unreadable only for the people who had
                     customised their colours, which is why it survived.

                     A defined pair instead. --primary/--primary-foreground and
                     --accent/--accent-foreground are each specified together in
                     both themes and stay legible whatever the accent becomes.
                     The bot's turn also names its foreground rather than
                     inheriting: it was relying on the panel's colour reaching
                     it, which is true until the day a painted region sits
                     between them. */
                  className={cn(
                    'whitespace-pre-wrap rounded-[12px] px-3 py-2 text-[13px]',
                    turn.role === 'user' && 'bg-primary text-primary-foreground',
                    turn.role === 'bot' && 'bg-accent text-accent-foreground',
                    turn.role === 'error' &&
                      'bg-destructive text-destructive-foreground',
                  )}
                >
                  {turn.text}
                </p>
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
