import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Mic, Square, X, Volume2, VolumeX, Headphones, ArrowRight, Wand2, Check, Paperclip, FileSpreadsheet } from 'lucide-react'
import { AssistantOrb, type OrbState } from '@/components/AssistantOrb'
import { useOverlayHistory } from '@/lib/overlay-history'
import { useDictation, speak, speakServer, stopSpeaking, speechOutputSupported, playTypeTick, unlockAudio } from '@/lib/speech'
import { useSession } from '@/lib/session'
import { useCatalog, featurePath, usable, type CatalogResponse } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { PickerMenu } from '@/components/PickerMenu'

/* A tiny, safe Markdown render for the bot's answers.

   The model replies in Markdown -- bold, headings, bullet lists -- and the tab
   was printing the asterisks and hashes raw. This turns the common cases into
   HTML after escaping the text first, so a model that ever echoed a tag cannot
   put markup onto the page. Not a full parser; a help answer does not need
   tables or images. */
function mdToHtml(src: string): string {
  const esc = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const lines = esc.split('\n')
  const out: string[] = []
  let inList = false
  const inline = (s: string) =>
    s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+?)`/g, '<code>$1</code>')
      .replace(/\[(.+?)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  for (const raw of lines) {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*]\s+(.*)/.exec(line)
    const h = /^(#{1,3})\s+(.*)/.exec(line)
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push('<li>' + inline(bullet[1]) + '</li>')
      continue
    }
    if (inList) { out.push('</ul>'); inList = false }
    if (h) {
      out.push('<strong class="md-h">' + inline(h[2]) + '</strong>')
    } else if (line === '') {
      out.push('<br>')
    } else {
      out.push('<div>' + inline(line) + '</div>')
    }
  }
  if (inList) out.push('</ul>')
  return out.join('')
}

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

interface ScreenLink { label: string; to: string }

/* A change the assistant has PROPOSED, drawn as a confirmation card. Nothing is
   written until Confirm is pressed; the card shows the real before/after the
   server computed, and its `state` tracks the one write it can make. */
interface ProposedAction {
  kind: string
  title: string
  summary: string
  before?: string
  after?: string
  sensitive: boolean
  params: Record<string, unknown>
  state?: 'idle' | 'busy' | 'done' | 'cancelled' | 'error'
  result?: string
}

/* A spreadsheet the person attached and is about to import, drawn as a confirm
   card just like a proposed change. `file` is kept so Confirm can re-send the
   exact bytes that were previewed to the commit endpoint; nothing is written
   until then. The server ran the same dry-run the setup screen runs and returned
   these counts and row problems. */
interface ProposedImport {
  entity: string
  label: string
  file: File
  total: number
  ok: number
  rejected: number
  imported?: number
  summary: string
  problems: { row: number; problem?: string }[]
  runId?: string
  state: 'preview' | 'busy' | 'done' | 'cancelled' | 'error'
  result?: string
}

/* What the assistant may import, mirroring the server's allowlist in
   assistant_import.go (assistantImportableEntities). Kept in the same order so
   the two are easy to check against each other. The server re-checks every one,
   so an edit here can only ever narrow what the panel offers, never widen what
   is allowed. */
const IMPORT_KINDS: { value: string; label: string }[] = [
  { value: 'classes', label: 'Classes and sections' },
  { value: 'sections', label: 'Sections' },
  { value: 'subjects', label: 'Subjects' },
  { value: 'periods', label: 'Periods' },
  { value: 'holidays', label: 'Holidays and calendar' },
  { value: 'timetable', label: 'Timetable' },
  { value: 'class_subjects', label: 'Class subjects' },
  { value: 'allocations', label: 'Teacher allocations' },
  { value: 'marks', label: 'Marks' },
  { value: 'marks_grid', label: 'Marks (grid)' },
  { value: 'attendance', label: 'Student attendance' },
  { value: 'staff_attendance', label: 'Staff attendance' },
  { value: 'students', label: 'Students' },
  { value: 'student_history', label: 'Student history' },
  { value: 'fee_heads', label: 'Fee heads' },
  { value: 'fee_structures', label: 'Fee structures' },
  { value: 'fee_payments', label: 'Fee payments' },
  { value: 'punches', label: 'Biometric punches' },
  { value: 'student_exits', label: 'Student exits' },
]

interface Turn {
  role: 'user' | 'bot' | 'error'
  text: string
  /** A proposed data change awaiting confirmation on a card. */
  action?: ProposedAction
  /** A spreadsheet awaiting confirmation to import. */
  imprt?: ProposedImport
  /* The screens the answer is about, each openable in one press. An answer
     often names several ("the Fee Dashboard ... the Fee Default screen ...
     Fee Collection under Reports"); telling somebody where things are and then
     making them go find each is half an answer. Every screen named is resolved
     to a real, role-checked route, so no button points somewhere the reader
     cannot go, and each gets its own button. */
  links?: ScreenLink[]
}

/* Turn a screen's catalogue NAME into a route the reader may actually open.

   The fast-path answer carries the screen it describes; this finds that screen
   across every workspace the reader holds and returns its path, but only when
   the feature is live and in scope for them -- usable(f). A name that matches
   nothing they can reach returns nothing, and no button is shown, which is the
   honest outcome for "that screen exists but not for you". */
function resolveScreen(catalog: CatalogResponse, screen?: string): ScreenLink | undefined {
  const want = screen?.trim().toLowerCase()
  if (!want) return undefined
  for (const role of catalog.roles) {
    for (const section of role.sections) {
      for (const feature of section.features) {
        if (feature.name.trim().toLowerCase() === want && usable(feature)) {
          return {
            label: feature.name,
            to: featurePath(role.key, section.slug, feature.slug),
          }
        }
      }
    }
  }
  return undefined
}

/* EVERY screen the answer NAMES inside its prose, each as its own button.

   The exact-name match above only fires for the fast path, whose screen field
   comes from a different corpus than the catalogue, so it usually finds nothing
   -- and the model's own answers carry no screen field at all. But both kinds of
   answer say their screens in words ("the Fee Dashboard ... the Fee Default
   screen ... Fee Collection under Reports"), so this scans the text for every
   usable feature name that appears in it and returns one link per screen, in the
   order they are mentioned.

   A name must be at least six characters and sit on a word boundary, so a stray
   "Home" or "Fees" does not sprout a button; and a name wholly contained in
   another matched name at an overlapping spot is dropped, so "Fees" under a
   matched "Fee Dashboard" does not double up. Only screens the reader can
   actually open are considered. Capped so a long answer cannot wall itself in
   buttons. */
const MAX_LINKS = 4
function linksFromText(catalog: CatalogResponse, text?: string): ScreenLink[] {
  const hay = text?.toLowerCase() ?? ''
  if (!hay) return []
  const found: { at: number; end: number; link: ScreenLink }[] = []
  const seen = new Set<string>()
  for (const role of catalog.roles) {
    for (const section of role.sections) {
      for (const feature of section.features) {
        const name = feature.name.trim()
        if (name.length < 6 || !usable(feature)) continue
        const to = featurePath(role.key, section.slug, feature.slug)
        if (seen.has(to)) continue
        const n = name.toLowerCase()
        const at = hay.indexOf(n)
        if (at < 0) continue
        const before = at === 0 ? ' ' : hay[at - 1]
        const after = at + n.length >= hay.length ? ' ' : hay[at + n.length]
        if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue // not a whole phrase
        seen.add(to)
        found.push({ at, end: at + n.length, link: { label: name, to } })
      }
    }
  }
  // Drop a match that sits entirely inside a longer one (same span) -- keep the
  // more specific screen name.
  const kept = found.filter((f) =>
    !found.some((g) => g !== f && g.at <= f.at && g.end >= f.end && (g.end - g.at) > (f.end - f.at)))
  kept.sort((a, b) => a.at - b.at)
  return kept.slice(0, MAX_LINKS).map((f) => f.link)
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
  const navigate = useNavigate()
  const catalog = useCatalog()

  /* Back closes the assistant rather than the app. See useOverlayHistory. */
  const closeAssistant = useCallback(() => setOpen(false), [])
  useOverlayHistory(open, closeAssistant)
  const [hover, setHover] = useState(false)
  const [state, setState] = useState<OrbState>('idle')
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /* A spreadsheet the person has attached but not yet previewed, and which kind
     of records they say it holds. Held here, above the input, until Preview
     turns it into a confirm card. */
  const [attachFile, setAttachFile] = useState<File | null>(null)
  const [attachEntity, setAttachEntity] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
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
  /* Voice output and the hands-free loop. speakOn reads each answer aloud;
     handsFree also re-opens the microphone once the answer has been spoken, so
     a question and its reply can go back and forth without touching the
     keyboard. Both remembered per browser. */
  const [speakOn, setSpeakOn] = useState(() => {
    try { return localStorage.getItem('erp.assistant.speak') === '1' } catch { return false }
  })
  const [handsFree, setHandsFree] = useState(false)
  const handsFreeRef = useRef(handsFree)
  handsFreeRef.current = handsFree
  const speakRef = useRef(speakOn)
  speakRef.current = speakOn

  const typed = useRef('')
  const dictation = useDictation((text, final) => {
    setDraft(text ? `${typed.current}${typed.current ? ' ' : ''}${text}` : typed.current)
    if (final) {
      typed.current = draftWith(typed.current, text)
      // Hands-free: the recogniser's final result is the question -- send it
      // without waiting for a keypress, and let the spoken answer restart it.
      if (handsFreeRef.current) {
        const m = typed.current.trim()
        typed.current = ''
        if (m) void ask(m)
      }
    }
  })

  useEffect(() => {
    if (open) inputRef.current?.focus()
    // Closing the panel silences a running answer and shuts the microphone --
    // nobody expects a corner tab to keep talking after it is gone.
    if (!open) {
      stopSpeaking()
      if (dictation.listening) dictation.stop()
      if (handsFreeRef.current) setHandsFree(false)
    }
    // dictation read at call time; adding it re-runs on its own state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    // Pinned to the newest message. A log that does not follow its own output
    // makes somebody scroll to read the answer they just asked for. `state` is a
    // dep so the thinking indicator is scrolled into view when it appears.
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [turns, state])

  /* Read a NEW bot answer aloud when voice output is on, and -- in hands-free
     mode -- re-open the microphone once it has finished, so the conversation
     continues on its own. Guarded by a count so a re-render that does not add a
     message never re-speaks the last one. */
  const spokenCount = useRef(turns.length)
  useEffect(() => {
    if (turns.length <= spokenCount.current) {
      spokenCount.current = turns.length
      return
    }
    spokenCount.current = turns.length
    const last = turns[turns.length - 1]
    if (!last || last.role !== 'bot') return
    if (speakRef.current || handsFreeRef.current) {
      const done = () => {
        if (handsFreeRef.current && dictation.supported && !dictation.listening) dictation.start()
      }
      // The natural server voice first; the browser's own speech only if that
      // did not start (off the cloud, or the voice service refused).
      void speakServer(last.text, done).then((ok) => { if (!ok) speak(last.text, done) })
    }
    // dictation is intentionally not a dep: it is read at call time, and adding
    // it would re-run this on its own state changes and re-speak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns])

  /* The answer PRINTS itself, a few characters at a time, rather than landing
     whole. A block of text appearing at once reads as a page that was already
     there; watching it type says the assistant just wrote it, and gives the eye
     a place to start. Only the newest bot turn prints -- older ones are history
     and show in full -- and it is plain text while printing, swapped for the
     rendered Markdown on the last character so half-formed bold never flashes.

     Honoured off for anyone who asked for less motion, and skipped when the
     answer is being read aloud, where the voice already paces it. */
  /* The knobs, in one place so the feel is easy to change: how long the whole
     answer takes to type, and the floor and ceiling on the per-character delay
     so a one-word reply is not instant and a long one is not tedious. One
     character is revealed per tick; the delay between ticks is the answer's
     length divided into TARGET_MS, clamped. */
  const PRINT_TARGET_MS = 1600
  const PRINT_MIN_MS = 9
  const PRINT_MAX_MS = 26
  // The caret keeps blinking this long after the last character lands, so the
  // answer settles rather than snapping to done.
  const CARET_LINGER_MS = 900

  const [printedLen, setPrintedLen] = useState(0)
  const [printingIdx, setPrintingIdx] = useState(-1)
  const [caretIdx, setCaretIdx] = useState(-1)
  const printCount = useRef(turns.length)
  useEffect(() => {
    if (turns.length <= printCount.current) {
      printCount.current = turns.length
      return
    }
    printCount.current = turns.length
    const i = turns.length - 1
    const last = turns[i]
    if (!last || last.role !== 'bot') return

    // Every answer prints -- it is how the bot shows it just wrote the reply.
    // The one exception is reduced motion, where it lands whole.
    const reduce = typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) return

    const total = last.text.length
    if (total === 0) return
    setPrintingIdx(i)
    setCaretIdx(-1)
    setPrintedLen(0)

    // One character per tick, at a realistic pace: the whole answer aims to
    // finish in about PRINT_TARGET_MS, but never faster than PRINT_MIN_MS or
    // slower than PRINT_MAX_MS per character.
    const delay = Math.max(PRINT_MIN_MS, Math.min(PRINT_MAX_MS, Math.round(PRINT_TARGET_MS / total)))
    let n = 0
    let lingerTimer = 0
    // No printing sound while the answer is also being spoken -- the voice is
    // enough, and ticks under it are just noise.
    const withSound = !speakRef.current && !handsFreeRef.current
    const timer = window.setInterval(() => {
      n += 1
      setPrintedLen(n)
      // A tick every third character: enough to hear the machine, not a buzz.
      if (withSound && n % 3 === 0) playTypeTick()
      if (n >= total) {
        window.clearInterval(timer)
        setPrintingIdx(-1)
        setCaretIdx(i) // caret lingers on the finished, rendered answer
        lingerTimer = window.setTimeout(() => setCaretIdx((c) => (c === i ? -1 : c)), CARET_LINGER_MS)
      }
    }, delay)
    return () => { window.clearInterval(timer); window.clearTimeout(lingerTimer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns])

  // Keep the log pinned to the bottom as the answer prints, not only when a
  // whole turn arrives.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [printedLen])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  async function ask(override?: string) {
    const message = (override ?? draft).trim()
    if (!message || state !== 'idle') return
    // Prime sound on the tap that asked, so the answer -- spoken and ticking --
    // is audible on mobile, where sound is only allowed from a gesture.
    unlockAudio()
    stopSpeaking()
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
            // The screen the fast path names outright, plus any others the
            // answer mentions in prose -- deduped, in order, one button each.
            const named = resolveScreen(catalog, hit.screen)
            const inText = linksFromText(catalog, hit.answer)
            const links = named && !inText.some((l) => l.to === named.to)
              ? [named, ...inText]
              : inText
            setTurns((t) => [...t, { role: 'bot', text: hit.answer, links }])
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
      setTurns((t) => [...t, {
        role: 'bot',
        text: data.answer ?? '',
        links: data.action ? undefined : linksFromText(catalog, data.answer),
        action: data.action ? { ...data.action, state: 'idle' as const } : undefined,
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

  /* Confirm a proposed change. Only this -- a deliberate press on the card --
     writes anything; the chat call only ever proposed. The write is re-checked
     for permission on the server and runs under the person's tenant scope. */
  function setActionState(i: number, patch: Partial<ProposedAction>) {
    setTurns((t) => t.map((tr, idx) => (idx === i && tr.action ? { ...tr, action: { ...tr.action, ...patch } } : tr)))
  }
  async function confirmAction(i: number, action: ProposedAction) {
    setActionState(i, { state: 'busy' })
    try {
      const res = await fetch('/api/v1/assistant/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ kind: action.kind, params: action.params }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error?.message ?? 'The change could not be made.')
      setActionState(i, { state: 'done', result: data.message })
      if (speakRef.current || handsFreeRef.current) void speakServer(data.message).then((ok) => { if (!ok) speak(data.message) })
    } catch (e) {
      setActionState(i, { state: 'error', result: (e as Error).message })
    }
  }

  /* Import a spreadsheet from inside the chat.

     Two steps, both re-checked on the server: preview runs the importer's dry
     run and writes nothing; the card's Confirm re-sends the SAME file to the
     commit endpoint, which writes through the same undoable importer the setup
     screen uses. FormData/fetch only -- nothing a low-end browser lacks. */
  function chooseFile() {
    fileInputRef.current?.click()
  }
  function onFilePicked(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files && e.target.files[0]
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = ''
    if (!f) return
    setAttachFile(f)
    setAttachEntity('')
  }
  function setImportState(i: number, patch: Partial<ProposedImport>) {
    setTurns((t) => t.map((tr, idx) => (idx === i && tr.imprt ? { ...tr, imprt: { ...tr.imprt, ...patch } } : tr)))
  }
  async function previewImport() {
    if (!attachFile || !attachEntity || state !== 'idle') return
    const file = attachFile
    const entity = attachEntity
    const kind = IMPORT_KINDS.find((k) => k.value === entity)
    setState('thinking')
    setTurns((t) => [...t, { role: 'user', text: `Import “${file.name}” as ${kind?.label ?? entity}.` }])
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('entity', entity)
      const res = await fetch('/api/v1/assistant/import/preview', {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error?.message ?? 'That file could not be previewed.')
      setState('answering')
      setTurns((t) => [...t, {
        role: 'bot',
        text: '',
        imprt: {
          entity: data.entity,
          label: data.label,
          file,
          total: data.total,
          ok: data.ok,
          rejected: data.rejected,
          summary: data.summary,
          problems: Array.isArray(data.problems) ? data.problems : [],
          state: 'preview',
        },
      }])
      setAttachFile(null)
      setAttachEntity('')
      await new Promise((r) => setTimeout(r, 200))
    } catch (err) {
      setTurns((t) => [...t, { role: 'error', text: (err as Error).message }])
    } finally {
      setState('idle')
    }
  }
  async function commitImport(i: number, imp: ProposedImport) {
    setImportState(i, { state: 'busy' })
    try {
      const form = new FormData()
      form.append('file', imp.file)
      form.append('entity', imp.entity)
      const res = await fetch('/api/v1/assistant/import/commit', {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error?.message ?? 'The import could not be completed.')
      setImportState(i, {
        state: 'done',
        imported: data.imported,
        rejected: data.rejected,
        runId: data.run_id,
        result: data.summary,
      })
    } catch (e) {
      setImportState(i, { state: 'error', result: (e as Error).message })
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
          /* FULL SCREEN ON A PHONE, a DOCKED PANEL on a desktop.
             On a phone it fills the screen and sits ABOVE the dock and the page
             dots (z over their z-50/z-45), so the pencil and dots no longer show
             through the chat; the safe-area padding keeps the header off the
             notch and the input off the home indicator.

             On a desk it used to be a floating card hovering above the bottom
             right corner: rounded, shadowed, 9rem short of the viewport, with
             the page showing round three of its sides. The owner asked for it
             not to float. It is now a panel docked to the right edge, full
             height, one hairline on its left -- a side pane of the app, the
             way a chat rail sits in a mail client -- so it has a fixed place
             rather than a position, and the page it sits beside stays
             readable up to its edge. */
          style={{
            paddingTop: 'env(safe-area-inset-top, 0px)',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          }}
          className="fixed inset-0 z-[60] flex h-full w-full flex-col overflow-hidden bg-card
                     md:inset-y-0 md:left-auto md:right-0 md:w-[min(40vw,520px)]
                     md:border-l md:shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.18)]"
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
              /* An empty panel says one quiet thing and waits. The four canned
                 starter questions that used to sit here were removed at the
                 owner's request: they were generic, they were the same for
                 every role, and a clerk who has opened this panel two hundred
                 times does not need to be offered "How do I collect a fee?" a
                 two-hundred-and-first. The box below is the whole invitation. */
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 pb-10 text-center">
                <AssistantOrb state="idle" size={40} />
                <p className="text-[13.5px] font-medium leading-tight">
                  Ask about the school, or tell me what to do.
                </p>
                <p className="max-w-[30ch] text-[12px] leading-snug text-muted-foreground">
                  A student, a fee, today's attendance, where a setting lives — or attach a spreadsheet to import.
                </p>
              </div>
            )}
            {turns.map((turn, i) => (
              <div key={i} className={cn('max-w-[86%]', turn.role === 'user' && 'ml-auto')}>
                <div
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
                  {turn.role === 'bot'
                    ? (i === printingIdx
                        ? <span className="md-answer">{turn.text.slice(0, printedLen)}<span className="assistant-caret" aria-hidden="true" /></span>
                        : (
                          <span className="md-answer">
                            <span dangerouslySetInnerHTML={{ __html: mdToHtml(turn.text) }} />
                            {i === caretIdx && <span className="assistant-caret" aria-hidden="true" />}
                          </span>
                        ))
                    : turn.text}
                  {/* One small chip per screen the answer names -- shown once the
                      answer has finished printing, and only once per destination:
                      the model sometimes names the same screen twice, which used
                      to stack four full-width blue slabs down the panel. Deduped
                      by target and laid out inline so they read as quiet "go here"
                      cues, not a wall of buttons. The chip carries the school's
                      accent colour where it set one, the primary otherwise. */}
                  {turn.links && i !== printingIdx && (() => {
                    // Collapse by BOTH destination and visible label: the answer
                    // can name one screen twice, and two catalogue entries can
                    // share a label ("Communication"), either of which showed the
                    // same chip twice. One chip per destination, one per label.
                    const seen = new Set<string>()
                    const unique = turn.links.filter((lnk) => {
                      const label = `l:${lnk.label.toLowerCase()}`
                      if (seen.has(lnk.to) || seen.has(label)) return false
                      seen.add(lnk.to)
                      seen.add(label)
                      return true
                    })
                    return (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {unique.map((lnk) => (
                          <button
                            key={lnk.to}
                            type="button"
                            onClick={() => { navigate(lnk.to); setOpen(false) }}
                            className="inline-flex items-center gap-1 rounded-full
                                       px-2.5 py-1 text-[12px] font-medium
                                       transition-opacity hover:opacity-90
                                       bg-[hsl(var(--brand-accent,var(--primary)))]
                                       text-[hsl(var(--brand-accent-foreground,var(--primary-foreground)))]"
                          >
                            <span className="truncate">Open {lnk.label}</span>
                            <ArrowRight className="size-3 shrink-0" aria-hidden />
                          </button>
                        ))}
                      </div>
                    )
                  })()}

                  {/* A proposed change, as a confirmation card. Nothing is
                      written until Confirm is pressed. It shows the real
                      before -> after the server computed, and once done it stays
                      as a record of what happened. */}
                  {turn.action && i !== printingIdx && (
                    <div className="assistant-action mt-2 rounded-[11px] border bg-card/60 p-3 text-foreground">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <Wand2 className="size-3.5 text-[hsl(var(--brand-accent,var(--primary)))]" aria-hidden />
                        {turn.action.title}
                        {turn.action.sensitive && (
                          <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive">Sensitive</span>
                        )}
                      </div>
                      <p className="mt-1.5 text-[13px] leading-snug">{turn.action.summary}</p>
                      {(turn.action.before || turn.action.after) && (
                        <div className="mt-2 flex items-center gap-2 text-[12px]">
                          <span className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground line-through">{turn.action.before || '—'}</span>
                          <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
                          <span className="rounded-md bg-[hsl(var(--brand-accent,var(--primary)))]/15 px-2 py-0.5 font-medium text-[hsl(var(--brand-accent,var(--primary)))]">{turn.action.after || '—'}</span>
                        </div>
                      )}
                      {turn.action.state === 'done' && (
                        <div className="mt-2.5 flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-400">
                          <Check className="size-4" aria-hidden /> {turn.action.result}
                        </div>
                      )}
                      {turn.action.state === 'cancelled' && (
                        <div className="mt-2.5 text-[12.5px] text-muted-foreground">Cancelled — nothing was changed.</div>
                      )}
                      {turn.action.state === 'error' && (
                        <div className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-destructive"><X className="size-4" aria-hidden /> {turn.action.result}</div>
                      )}
                      {(turn.action.state === 'idle' || turn.action.state === 'error') && (
                        <div className="mt-2.5 flex gap-2">
                          <button
                            type="button"
                            onClick={() => confirmAction(i, turn.action!)}
                            className="flex-1 rounded-[8px] bg-[hsl(var(--brand-accent,var(--primary)))] px-3 py-1.5 text-[12.5px] font-semibold text-[hsl(var(--brand-accent-foreground,var(--primary-foreground)))] transition-opacity hover:opacity-90"
                          >
                            {turn.action.state === 'error' ? 'Try again' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setActionState(i, { state: 'cancelled' })}
                            className="rounded-[8px] border px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                      {turn.action.state === 'busy' && (
                        <div className="mt-2.5 text-[12.5px] text-muted-foreground">Making the change…</div>
                      )}
                    </div>
                  )}

                  {/* An attached spreadsheet, as a confirm card. It shows the
                      server's dry run -- how many rows are ready and which have
                      problems -- and writes nothing until Confirm is pressed,
                      which re-sends the same file to be imported. */}
                  {turn.imprt && i !== printingIdx && (
                    <div className="assistant-action mt-2 rounded-[11px] border bg-card/60 p-3 text-foreground">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <FileSpreadsheet className="size-3.5 text-[hsl(var(--brand-accent,var(--primary)))]" aria-hidden />
                        Import {turn.imprt.label}
                      </div>
                      <p className="mt-1.5 text-[13px] leading-snug">{turn.imprt.summary}</p>
                      {(turn.imprt.state === 'preview' || turn.imprt.state === 'busy' || turn.imprt.state === 'error') && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                          <span className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground">{turn.imprt.total} rows</span>
                          <span className="rounded-md bg-[hsl(var(--brand-accent,var(--primary)))]/15 px-2 py-0.5 font-medium text-[hsl(var(--brand-accent,var(--primary)))]">{turn.imprt.ok} ready</span>
                          {turn.imprt.rejected > 0 && (
                            <span className="rounded-md bg-destructive/15 px-2 py-0.5 font-medium text-destructive">{turn.imprt.rejected} with problems</span>
                          )}
                        </div>
                      )}
                      {turn.imprt.problems.length > 0 && turn.imprt.state !== 'done' && turn.imprt.state !== 'cancelled' && (
                        <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-[12px] text-muted-foreground">
                          {turn.imprt.problems.map((p, pi) => (
                            <li key={pi} className="flex gap-1.5">
                              <span className="shrink-0 font-medium text-foreground">Row {p.row}:</span>
                              <span className="min-w-0">{p.problem || 'could not be read'}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {turn.imprt.state === 'done' && (
                        <div className="mt-2.5 flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-400">
                          <Check className="size-4" aria-hidden /> {turn.imprt.result}
                        </div>
                      )}
                      {turn.imprt.state === 'cancelled' && (
                        <div className="mt-2.5 text-[12.5px] text-muted-foreground">Cancelled — nothing was imported.</div>
                      )}
                      {turn.imprt.state === 'error' && (
                        <div className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-destructive"><X className="size-4" aria-hidden /> {turn.imprt.result}</div>
                      )}
                      {(turn.imprt.state === 'preview' || turn.imprt.state === 'error') && turn.imprt.ok > 0 && (
                        <div className="mt-2.5 flex gap-2">
                          <button
                            type="button"
                            onClick={() => commitImport(i, turn.imprt!)}
                            className="flex-1 rounded-[8px] bg-[hsl(var(--brand-accent,var(--primary)))] px-3 py-1.5 text-[12.5px] font-semibold text-[hsl(var(--brand-accent-foreground,var(--primary-foreground)))] transition-opacity hover:opacity-90"
                          >
                            {turn.imprt.state === 'error' ? 'Try again' : `Import ${turn.imprt.ok} row${turn.imprt.ok === 1 ? '' : 's'}`}
                          </button>
                          <button
                            type="button"
                            onClick={() => setImportState(i, { state: 'cancelled' })}
                            className="rounded-[8px] border px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                      {turn.imprt.state === 'preview' && turn.imprt.ok === 0 && (
                        <div className="mt-2.5 text-[12.5px] text-muted-foreground">No rows are ready to import. Fix the file and attach it again.</div>
                      )}
                      {turn.imprt.state === 'busy' && (
                        <div className="mt-2.5 text-[12.5px] text-muted-foreground">Importing…</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* While the answer is being fetched, a bot-side bubble of three
                pulsing dots -- so a question that was sent does not sit there
                looking unanswered until the reply lands. */}
            {state === 'thinking' && (
              <div className="max-w-[86%]">
                <div className="inline-flex items-center gap-1 rounded-[12px] bg-accent px-3 py-2.5 text-accent-foreground">
                  <span className="assistant-dot" />
                  <span className="assistant-dot" style={{ animationDelay: '0.15s' }} />
                  <span className="assistant-dot" style={{ animationDelay: '0.3s' }} />
                </div>
              </div>
            )}
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

          {/* A spreadsheet has been attached: name it and say what kind of
              records it holds, then Preview runs the server's dry run. Shown
              above the box so it reads as a step before sending. */}
          {attachFile && (
            <div className="flex flex-wrap items-center gap-2 border-t bg-accent/40 px-3 py-2 text-[12px]">
              <FileSpreadsheet className="size-4 shrink-0 text-[hsl(var(--brand-accent,var(--primary)))]" aria-hidden />
              <span className="min-w-0 max-w-[45%] truncate font-medium">{attachFile.name}</span>
              <PickerMenu
                value={attachEntity}
                onChange={setAttachEntity}
                ariaLabel="What kind of records this file holds"
                align="start"
                placeholder="Import as…"
                className="min-w-0 flex-1"
                options={IMPORT_KINDS.map((k) => ({ value: k.value, label: k.label }))}
              />
              <button
                type="button"
                onClick={() => void previewImport()}
                disabled={!attachEntity || state !== 'idle'}
                className="rounded-full bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground disabled:opacity-40"
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => { setAttachFile(null); setAttachEntity('') }}
                aria-label="Remove attached file"
                className="grid size-6 shrink-0 place-items-center rounded-full border hover:bg-accent"
              >
                <X className="size-3" />
              </button>
            </div>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); void ask() }}
            className="flex items-center gap-2 border-t px-3 py-2.5"
          >
            {/* Attach a spreadsheet to import. FileReader/FormData only, so it
                works on low-end browsers; the hidden input is driven by the
                paper-clip beside it. */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={onFilePicked}
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
            />
            <button
              type="button"
              onClick={chooseFile}
              disabled={state !== 'idle'}
              aria-label="Attach a spreadsheet to import"
              title="Attach a spreadsheet to import"
              className="grid size-8 shrink-0 place-items-center rounded-full border transition-colors hover:bg-accent disabled:opacity-40"
            >
              <Paperclip className="size-3.5" />
            </button>
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
              className="min-w-0 flex-1 rounded-[12px] border bg-background px-3.5 py-2 text-[13.5px]
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {/* Drawn only where it works. Firefox has no speech recognition at
                all, so on Firefox there is no microphone — a button that does
                nothing when pressed is worse than an absent one, because the
                person presses it, waits, and concludes the assistant is
                broken. */}
            {/* Read answers aloud. Persisted per browser; turning it off also
                silences whatever is speaking right now. */}
            {speechOutputSupported() && (
              <button
                type="button"
                onClick={() => {
                  setSpeakOn((v) => {
                    const next = !v
                    try { localStorage.setItem('erp.assistant.speak', next ? '1' : '0') } catch { /* private mode */ }
                    if (!next) stopSpeaking()
                    return next
                  })
                }}
                aria-label={speakOn ? 'Turn off spoken answers' : 'Read answers aloud'}
                aria-pressed={speakOn}
                title={speakOn ? 'Spoken answers on' : 'Read answers aloud'}
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-full border transition-colors',
                  speakOn ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                )}
              >
                {speakOn ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
              </button>
            )}
            {/* Hands-free: send on the final spoken phrase and re-open the mic
                once the answer has been read, so a whole exchange needs no
                keypress. Only offered where both halves work. */}
            {dictation.supported && speechOutputSupported() && (
              <button
                type="button"
                onClick={() => {
                  setHandsFree((v) => {
                    const next = !v
                    if (next) {
                      setSpeakOn(true)
                      try { localStorage.setItem('erp.assistant.speak', '1') } catch { /* private mode */ }
                      if (dictation.supported && !dictation.listening) dictation.start()
                    } else {
                      stopSpeaking()
                      if (dictation.listening) dictation.stop()
                    }
                    return next
                  })
                }}
                aria-label={handsFree ? 'Turn off hands-free' : 'Hands-free conversation'}
                aria-pressed={handsFree}
                title={handsFree ? 'Hands-free on' : 'Hands-free conversation'}
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-full border transition-colors',
                  handsFree ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                )}
              >
                <Headphones className="size-3.5" />
              </button>
            )}
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
