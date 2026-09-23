import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown, Check, CheckCheck, Clock, Download, FileText,
  Copy, Mic, Paperclip, Pause, Play, Reply, Search, Send, Square, Trash2, X,
} from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { shrinkImage } from '@/lib/shrink-image'
import { Loading } from '@/components/ui'
import { sendTyping, useTyping, type TypingTarget } from '@/lib/live-stream'

/* A conversation, drawn the way every phone in the country draws one.

   Bubbles: yours on the right in green, theirs on the left in white, the
   time in the corner, one tick when sent and two blue ticks when read. A
   pill between days. A composer at the bottom with a paperclip, a box that
   grows as you type, and a round send button. Enter sends, Shift+Enter
   breaks the line. Every chat in the product -- staff to staff, teacher to
   parent, the counsellor's thread -- uses this one component, so a parent
   who learned it once knows all of them.

   Files go up first (POST /api/v1/files, the same upload every other
   screen uses), then the message names them. A photo shows inside the
   bubble; anything else is a chip with the name and size that opens the
   file. Old, weak browsers are the audience: no CSS grid tricks, no
   backdrop filters, and the composer works with fetch alone. */

export interface Attachment {
  file_id: string
  name: string
  size_bytes: number
  content_type: string
  url: string
}

export interface ChatMessage {
  id: string
  body: string
  /** ISO time the message was sent. */
  at: string
  mine: boolean
  /** Who wrote it; shown on the other side's bubbles in a group. */
  sender?: string
  /** Set once the other side has actually seen it; drawn as two blue ticks. */
  read_at?: string
  attachments?: Attachment[]
  /** What this message answers, quoted as it read when it was quoted. */
  reply_to_id?: string
  reply_body?: string
  reply_sender?: string
  edited?: boolean
  /** Withdrawn by its author: the row stays, the words are gone. */
  deleted?: boolean
  /* Set only on a message this screen is still sending, or failed to send.
     A bubble is on the paper the moment Send is pressed -- on a corridor
     connection the old wait for the server looked like nothing had happened,
     and people pressed Send twice. */
  pending?: boolean
  failed?: boolean
}

export function ChatThread({
  messages,
  loading,
  empty,
  onSend,
  sending,
  canSend = true,
  cannotSendNote,
  placeholder = 'Type a message',
  error,
  showSender = false,
  /** False where the channel cannot carry a file (the desk's reply into a
      parent thread): the paperclip is not drawn rather than drawn and
      ignored. */
  allowAttachments = true,
  /* A floor and a viewport-relative ceiling, not a fixed 28rem cap: capped, the
     paper stopped a third of the way down a tall card and the composer floated
     over empty white. It now fills the card it is given (flex-1 on the root)
     and only the viewport bounds it, so the thread scrolls inside itself
     rather than scrolling the page. */
  height = 'min-h-[14rem] max-h-[70vh]',
  live,
  onLoadOlder,
  hasMore = false,
  loadingOlder = false,
  onSeen,
  onEdit,
  onUnsend,
}: {
  /** Fetch the page above the oldest message on screen. */
  onLoadOlder?: () => void
  hasMore?: boolean
  loadingOlder?: boolean
  /** Called when the other side's newest message has actually been on screen. */
  onSeen?: () => void
  /** Change or withdraw one of the caller's own messages, within the window. */
  onEdit?: (id: string, body: string) => Promise<unknown> | void
  onUnsend?: (id: string) => Promise<unknown> | void
  /** Which conversation this is, on the live bus: shows "typing…" from the
      other party and signals our own typing to them. Omit for no live. */
  live?: TypingTarget
  messages: ChatMessage[]
  loading?: boolean
  /** What to say when there is nothing yet. */
  empty?: ReactNode
  onSend: (m: { body: string; attachments: Attachment[] }) => void | Promise<unknown>
  sending?: boolean
  canSend?: boolean
  /** Shown instead of the composer when canSend is false. */
  cannotSendNote?: ReactNode
  placeholder?: string
  error?: unknown
  /** Name the author on their bubbles: for a thread with more than two people. */
  showSender?: boolean
  allowAttachments?: boolean
  height?: string
}) {
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  /* What is on its way up, drawn from the device so a picture is on screen
     the moment it is chosen. */
  const [pending, setPending] = useState<{ key: string; name: string; preview: string | null }[]>([])
  const scroller = useRef<HTMLDivElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const box = useRef<HTMLTextAreaElement | null>(null)

  /* FOLLOW THE CONVERSATION, DO NOT DRAG THE READER BACK TO IT.
   *
   * Every arriving message jumped the paper to the bottom, so reading
   * something said an hour ago while the other party was still typing threw
   * the reader out of the place they were reading. The jump now happens only
   * when they were already at the bottom -- which is nearly always -- and
   * otherwise a pill appears saying how many have arrived since, which takes
   * them down when they are ready. */
  const [atBottom, setAtBottom] = useState(true)
  const [behind, setBehind] = useState(0)
  const seen = useRef(messages.length)
  const olderAnchor = useRef<{ h: number; top: number } | null>(null)

  const toBottom = useCallback((smooth = true) => {
    const el = scroller.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    setBehind(0)
  }, [])

  useEffect(() => {
    const grew = messages.length - seen.current
    seen.current = messages.length
    if (atBottom) toBottom(false)
    else if (grew > 0) setBehind((n) => n + grew)
  }, [messages.length, loading, atBottom, toBottom])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    setAtBottom(bottom)
    if (bottom) setBehind(0)
    /* Older messages, when the reader reaches the top of what is loaded.
       The anchor is taken first so the page that arrives above does not shove
       the line they were reading off the screen. */
    if (el.scrollTop < 80 && hasMore && !loadingOlder && onLoadOlder) {
      olderAnchor.current = { h: el.scrollHeight, top: el.scrollTop }
      onLoadOlder()
    }
  }

  // Put the reader back where they were, now that the page has been prepended.
  useEffect(() => {
    const el = scroller.current
    const a = olderAnchor.current
    if (!el || !a || loadingOlder) return
    olderAnchor.current = null
    el.scrollTop = el.scrollHeight - a.h + a.top
  }, [messages.length, loadingOlder])

  /* THE TICK MEANS SEEN.
     read_at used to be set when the thread was fetched, so a message was
     marked read while its recipient was still walking to the staff room. It is
     now reported when the newest incoming message has actually been drawn and
     the window has focus. */
  const lastIncoming = useMemo(
    () => [...messages].reverse().find((m) => !m.mine)?.id,
    [messages],
  )
  const told = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!onSeen || !lastIncoming || told.current === lastIncoming) return
    if (typeof document !== 'undefined' && document.hidden) return
    /* Not "only at the bottom". A thread short enough to need no scrolling
       never reports being at the bottom on some browsers, so the tick never
       turned blue at all on the conversations most likely to be read at a
       glance. On screen and looked at is read. */
    told.current = lastIncoming
    onSeen()
  }, [lastIncoming, onSeen])

  /* Find something in a long thread. A conversation about one child runs for a
     year; "what did we agree about the bus" is a search, not a scroll. */
  const [finding, setFinding] = useState(false)
  const findBox = useRef<HTMLInputElement | null>(null)
  // autoFocus alone does not raise a phone keyboard; asking for the focus
  // after the bar is on screen does.
  useEffect(() => {
    if (finding) setTimeout(() => findBox.current?.focus(), 30)
  }, [finding])
  const [needle, setNeedle] = useState('')
  /* Messages this screen has sent and the server has not yet confirmed. They
     sit at the end of the thread with a clock on them; see `submit`. Declared
     here because the list the screen renders is the two together. */
  const [outgoing, setOutgoing] = useState<ChatMessage[]>([])
  /* A stand-in is retired when the thread comes back carrying it. Matching on
     the words and the sender rather than an id, because the id the server
     chose is not the one this screen invented. */
  useEffect(() => {
    setOutgoing((cur) => {
      if (cur.length === 0) return cur
      const landed = new Set(messages.filter((m) => m.mine).map((m) => m.body))
      const kept = cur.filter((m) => m.pending || m.failed || !landed.has(m.body))
      return kept.length === cur.length ? cur : kept
    })
  }, [messages])

  /* DELETE HAPPENS ON SCREEN FIRST.
   *
   * Waiting for the server before the message changes meant pressing Delete
   * and watching the words sit there for a second, which reads as a control
   * that did not work -- and on a slow connection, as a broken one. The
   * message becomes "withdrawn" the moment it is asked for, exactly as the
   * server is about to record it, and fades between the two states so the
   * thread does not jump.
   *
   * The request goes behind it. If it fails -- past the fifteen minutes, or
   * no network -- the words come back and the error is shown, which is the
   * honest outcome and the only one worth interrupting somebody for. */
  const [withdrawn, setWithdrawn] = useState<string[]>([])

  const deleteMessage = useCallback(
    (id: string) => {
      if (!onUnsend) return
      setWithdrawn((cur) => (cur.includes(id) ? cur : [...cur, id]))
      void Promise.resolve(onUnsend(id)).catch((e: unknown) => {
        setWithdrawn((cur) => cur.filter((x) => x !== id))
        setUploadError(
          e instanceof Error ? e.message : 'That message could not be withdrawn.',
        )
      })
    },
    [onUnsend],
  )

  const all = useMemo(() => {
    const merged = [...messages, ...outgoing]
    if (withdrawn.length === 0) return merged
    return merged.map((m) => (withdrawn.includes(m.id) ? { ...m, deleted: true, body: '' } : m))
  }, [messages, outgoing, withdrawn])
  const shown = useMemo(() => {
    const q = needle.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (m) =>
        (m.body ?? '').toLowerCase().includes(q) ||
        (m.sender ?? '').toLowerCase().includes(q) ||
        (m.attachments ?? []).some((a) => a.name.toLowerCase().includes(q)),
    )
  }, [all, needle])

  // The box grows with what is typed, up to about five lines.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }, [draft])

  const upload = async (list: FileList | File | null) => {
    if (!list) return
    if (list instanceof File) {
      const dt = new DataTransfer()
      dt.items.add(list)
      list = dt.files
    }
    if (!list.length) return
    setUploadError(null)
    const picked = Array.from(list).slice(0, 10 - files.length)
    setUploading((n) => n + picked.length)
    // Something to look at while it goes: the picture itself, from the
    // device, rather than the word "Uploading" and a number.
    setPending((cur) => [
      ...cur,
      ...picked.map((f) => ({
        key: `${f.name}-${f.size}-${Math.random()}`,
        name: f.name,
        preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
      })),
    ])
    for (const raw of picked) {
      try {
        const f = await shrinkImage(raw)
        const fd = new FormData()
        fd.append('file', f, f.name)
        const res = await fetch('/api/v1/files', { method: 'POST', credentials: 'same-origin', body: fd })
        if (!res.ok) {
          let msg = 'That file could not be uploaded.'
          try {
            const j = await res.json()
            msg = j?.error?.message ?? msg
          } catch {
            /* not JSON */
          }
          throw new Error(msg)
        }
        const j = (await res.json()) as Attachment
        setFiles((cur) => [...cur, { file_id: j.file_id, name: j.name, size_bytes: j.size_bytes, content_type: j.content_type, url: j.url }])
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : 'That file could not be uploaded.')
      } finally {
        setUploading((n) => n - 1)
        setPending((cur) => {
          const [gone, ...rest] = cur
          if (gone?.preview) URL.revokeObjectURL(gone.preview)
          return rest
        })
      }
    }
    if (fileInput.current) fileInput.current.value = ''
  }

  /* SENT IS WHAT THE SCREEN SAYS, NOT WHAT THE SERVER HAS SAID YET.
   *
   * The bubble used to appear when the reply came back. On a 3G phone in a
   * school corridor that is a second of nothing, and people press Send twice.
   * The message is drawn immediately with a clock, becomes an ordinary bubble
   * when the server confirms it, and turns into a red line with Retry if it
   * does not — which is the honest thing to show, rather than a message that
   * looks sent and never arrived. */

  const deliver = useCallback(
    async (draftMsg: ChatMessage, payload: { body: string; attachments: Attachment[]; reply_to_id?: string }) => {
      try {
        await onSend(payload)
        /* Hold the stand-in until the server's own copy is on screen.
           Dropping it the moment the POST returned left a gap -- the bubble
           vanished and came back when the refetch landed, which on a slow
           line is a message that blinks out of existence. `sentBodies` below
           retires it the moment the real one appears. */
        setOutgoing((cur) =>
          cur.map((m) => (m.id === draftMsg.id ? { ...m, pending: false } : m)),
        )
      } catch {
        setOutgoing((cur) =>
          cur.map((m) => (m.id === draftMsg.id ? { ...m, pending: false, failed: true } : m)),
        )
      }
    },
    [onSend],
  )

  const submit = () => {
    const body = draft.trim()
    // Editing writes over the message instead of adding one.
    if (editing) {
      if (!body || !onEdit) return
      const target = editing
      setEditing(null)
      setDraft('')
      void onEdit(target.id, body)
      return
    }
    if ((!body && files.length === 0) || uploading > 0) return
    const payload = { body, attachments: files, reply_to_id: replyTo?.id }
    const stand: ChatMessage = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      body,
      at: new Date().toISOString().slice(0, 16),
      mine: true,
      attachments: files,
      reply_to_id: replyTo?.id,
      reply_body: replyTo?.body,
      reply_sender: replyTo?.sender,
      pending: true,
    }
    setOutgoing((cur) => [...cur, stand])
    setDraft('')
    setFiles([])
    setReplyTo(null)
    void deliver(stand, payload)
  }

  const retry = (m: ChatMessage) => {
    setOutgoing((cur) => cur.map((x) => (x.id === m.id ? { ...x, failed: false, pending: true } : x)))
    void deliver(m, { body: m.body, attachments: m.attachments ?? [], reply_to_id: m.reply_to_id })
  }

  const discard = (m: ChatMessage) => setOutgoing((cur) => cur.filter((x) => x.id !== m.id))

  /* What is being answered, and what is being changed. Only one of each can be
     open at a time: both occupy the composer, and a screen that is doing two
     things at once with the same box is a screen nobody can predict. */
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [editing, setEditing] = useState<ChatMessage | null>(null)

  /* PRESS AND HOLD A MESSAGE.
   *
   * The actions hid behind a control that appeared on hover, which is a thing
   * a finger cannot do: on a phone -- where this product mostly is -- reply,
   * edit and unsend were unreachable unless you happened to find the faint
   * dot beside the bubble. Holding a message is the gesture every messaging
   * app has taught people, and a right-click is the same gesture on a desk.
   *
   * 450ms, and any movement cancels it: a press that turns into a scroll is a
   * scroll, and opening a menu under a thumb that is already moving is how
   * you send a message you meant to read. */
  const [acting, setActing] = useState<{ m: ChatMessage; rect: DOMRect } | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdFrom = useRef<{ x: number; y: number } | null>(null)

  const cancelHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current)
    holdTimer.current = null
    holdFrom.current = null
  }, [])

  /* The hold is confirmed the way a phone confirms one: a tick of haptic and a
     small pop, at the moment the menu appears rather than when the finger
     lands, so a press that became a scroll makes no sound. */
  const confirmHold = useCallback((m: ChatMessage, el: HTMLElement) => {
    setActing({ m, rect: el.getBoundingClientRect() })
    try {
      navigator.vibrate?.(12)
    } catch {
      /* iOS has no vibrate; the pop below is what it gets. */
    }
    popSound()
  }, [])

  const holdHandlers = (m: ChatMessage) =>
    m.pending || m.failed
      ? {}
      : {
          onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
            if (e.pointerType === 'mouse') return // the right-click does this
            const el = e.currentTarget
            holdFrom.current = { x: e.clientX, y: e.clientY }
            holdTimer.current = setTimeout(() => confirmHold(m, el), 500)
          },
          onPointerMove: (e: React.PointerEvent) => {
            const p = holdFrom.current
            if (!p) return
            if (Math.abs(e.clientX - p.x) > 8 || Math.abs(e.clientY - p.y) > 8) cancelHold()
          },
          onPointerUp: cancelHold,
          onPointerCancel: cancelHold,
          onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => {
            e.preventDefault()
            confirmHold(m, e.currentTarget)
          },
        }

  // The other party is typing — a live hint that expires by itself.
  const otherTyping = useTyping(live)

  let lastDay = ''
  return (
    /* flex-1 min-h-0: inside a card laid out as a flex column (the two-pane
       screens), the thread fills the card, so the paper grows and the
       composer sits at the bottom edge — not a quarter of the way down with a
       blank band beneath it. In a plain card it is inert. */
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Find, and how many are showing. The bar only appears when asked for,
          so an ordinary thread is not fronted by a search box nobody wanted. */}
      {finding && (
        /* Sticky and solid, not a faint strip at the top of a thread somebody
           is reading the bottom of: pressing the search button while looking
           at the composer moved something 600px away, which reads as the
           button doing nothing. */
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card px-3 py-2 shadow-sm">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={findBox}
            autoFocus
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setNeedle('')
                setFinding(false)
              }
            }}
            placeholder="Find in this conversation"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          />
          <span className="shrink-0 text-[12px] text-muted-foreground">
            {needle.trim() ? `${shown.length} of ${messages.length}` : `${messages.length}`}
          </span>
          <button
            type="button"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-muted"
            onClick={() => {
              setNeedle('')
              setFinding(false)
            }}
            aria-label="Close search"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div
        ref={scroller}
        onScroll={onScroll}
        className={cn('chat-paper flex-1 overflow-auto px-3 py-3 sm:px-5', height)}
      >
        {hasMore && !loading && !needle && (
          <div className="mb-2 flex justify-center">
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loadingOlder}
              className="rounded-full bg-black/5 px-3 py-1 text-[12px] font-medium text-muted-foreground"
            >
              {loadingOlder ? 'Loading…' : 'Older messages'}
            </button>
          </div>
        )}
        {loading ? (
          <Loading />
        ) : messages.length === 0 ? (
          <div className="grid h-full place-items-center py-8 text-center text-[13px] text-muted-foreground">
            {empty ?? 'Nothing yet. Say hello.'}
          </div>
        ) : shown.length === 0 ? (
          <div className="grid h-full place-items-center py-8 text-center text-[13px] text-muted-foreground">
            Nothing in this conversation matches "{needle}".
          </div>
        ) : (
          shown.map((m, i) => {
            const day = m.at.slice(0, 10)
            const sep = day !== lastDay
            lastDay = day
            /* Runs. Messages from one side, close together, sit as a group:
               tight spacing, one tail on the first. That is what makes a
               thread read as a conversation rather than a list. */
            const prev = shown[i - 1]
            const next = shown[i + 1]
            const sameAs = (o?: ChatMessage) =>
              !!o && o.mine === m.mine && (o.sender ?? '') === (m.sender ?? '') &&
              o.at.slice(0, 10) === day && Math.abs(+new Date(o.at) - +new Date(m.at)) < 5 * 60_000
            const first = sep || !sameAs(prev)
            const last = !sameAs(next)
            return (
              <div key={m.id}>
                {sep && (
                  <div className="my-3 flex justify-center">
                    <span className="chat-daypill rounded-[7.5px] px-3 py-[5px] text-[12.5px] font-medium uppercase tracking-wide">
                      {dayLabel(day)}
                    </span>
                  </div>
                )}
                <div className={cn('group flex items-end gap-1', last ? 'mb-2' : 'mb-[3px]', m.mine ? 'justify-end' : 'justify-start')}>
                  {/* Answer this one. Left of your own bubble, right of theirs,
                      so the control never sits where the text begins. */}
                  <div className={cn('flex max-w-[85%] flex-col sm:max-w-[72%]', m.mine ? 'items-end' : 'items-start')}>
                  <div
                    {...holdHandlers(m)}
                    className={cn(
                      'chat-bubble chat-settle relative select-none px-[16px] py-[12px] text-[15.5px] leading-[1.42]',
                      m.mine ? 'chat-mine' : 'chat-theirs',
                      !first && 'chat-run',
                      m.failed && 'ring-1 ring-destructive',
                      m.pending && 'opacity-80',
                    )}
                  >
                    {showSender && !m.mine && m.sender && first && (
                      <p className="mb-0.5 text-[13.5px] font-semibold" style={{ color: hueFor(m.sender) }}>{m.sender}</p>
                    )}
                    {/* What it answers, quoted. */}
                    {m.reply_to_id && (m.reply_body || m.reply_sender) && (
                      <div className="chat-quote mb-1.5 border-l-2 px-2.5 py-1.5 text-[13.5px]">
                        {m.reply_sender && <div className="chat-quote__who font-semibold">{m.reply_sender}</div>}
                        <div className="chat-quote__body line-clamp-2">{m.reply_body || 'Attachment'}</div>
                      </div>
                    )}
                    {m.deleted ? (
                      <p className="chat-withdrawn italic text-muted-foreground">
                        This message was withdrawn.
                      </p>
                    ) : (
                      <>
                        {(m.attachments ?? []).map((a) => (
                          <AttachmentView key={a.file_id} a={a} />
                        ))}
                        {m.body && <p className="whitespace-pre-wrap break-words">{linkify(m.body)}</p>}
                      </>
                    )}
                    </div>
                    {/* The time sits under the bubble, not inside it: nothing has
                        to be written around it and a one-word message keeps its
                        shape. */}
                    <p className="chat-meta mt-[4px] flex items-center gap-[4px] leading-none">
                      {m.edited && !m.deleted && <span className="italic">edited</span>}
                      <span>{timeOf(m.at)}</span>
                      {m.mine &&
                        (m.failed ? (
                          <span className="font-semibold text-destructive">not sent</span>
                        ) : m.pending ? (
                          <Clock className="h-[15px] w-[15px]" aria-label="Sending" />
                        ) : m.read_at ? (
                          <CheckCheck className="h-4 w-4 text-[#53bdeb]" aria-label={`Seen ${formatDateTime(m.read_at)}`} />
                        ) : (
                          <Check className="h-4 w-4" aria-label="Sent" />
                        ))}
                    </p>
                    {m.failed && (
                      <p className="mt-1 flex gap-3 text-[12px] font-semibold">
                        <button type="button" className="text-primary" onClick={() => retry(m)}>Retry</button>
                        <button type="button" className="text-muted-foreground" onClick={() => discard(m)}>Discard</button>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
        {/* The other party, mid-sentence. A WhatsApp reader expects this;
            without it a reply that lands ten seconds after yours reads as
            the other person ignoring you for ten seconds. Expires on its own
            (lib/live-stream.ts), so a closed tab never leaves it behind. */}
        {otherTyping && (
          <div className="mb-2 flex justify-start" aria-live="polite" aria-label="Typing">
            <div className="chat-bubble chat-theirs chat-tail-theirs relative inline-flex items-center gap-[5px] rounded-[8px] rounded-tl-none px-[12px] py-[11px]">
              <span className="chat-dot" />
              <span className="chat-dot [animation-delay:160ms]" />
              <span className="chat-dot [animation-delay:320ms]" />
            </div>
          </div>
        )}
      </div>

      {/* Back to the newest, and how much has been said meanwhile. Only while
          the reader is somewhere above the bottom, so it is never in the way
          of the conversation it points at. */}
      {!atBottom && !needle && (
        <button
          type="button"
          onClick={() => toBottom()}
          className="chat-jump absolute bottom-[4.75rem] right-4 z-10 grid h-10 w-10 place-items-center rounded-full"
          aria-label={behind > 0 ? `${behind} new messages, jump to latest` : 'Jump to latest'}
          title="Jump to latest"
        >
          <ArrowDown className="h-5 w-5" />
          {behind > 0 && (
            <span className="absolute -top-1.5 right-0 grid min-w-[20px] place-items-center rounded-full bg-[#25d366] px-1.5 py-[2px] text-[11px] font-bold leading-none text-white">
              {behind > 99 ? '99+' : behind}
            </span>
          )}
        </button>
      )}

      {acting && (
        <MessageActions
          m={acting.m}
          rect={acting.rect}
          mine={acting.m.mine}
          onClose={() => setActing(null)}
          onReply={canSend && !acting.m.id.startsWith('pending-') ? () => setReplyTo(acting.m) : undefined}
          onDelete={
            onUnsend && acting.m.mine && !acting.m.deleted && !acting.m.id.startsWith('pending-')
              ? () => deleteMessage(acting.m.id)
              : undefined
          }
        />
      )}

      {canSend ? (
        <div
          /* The bar sits on the bottom edge. It used to carry even padding top
             and bottom on top of the screen's own safe-area inset, which on a
             desktop — where that inset is zero — read as a band of empty white
             under the box. The gap above the box stays; below it is only the
             phone's home-indicator allowance, and nothing when there is none. */
          className="chat-bar px-2 pt-1.5 sm:px-3"
          style={{ paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))' }}
        >
          {(replyTo || editing) && (
            <div className="mb-2 flex items-start gap-2 rounded-md border-l-4 border-primary bg-background px-2.5 py-1.5 text-[12.5px]">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-primary">
                  {editing ? 'Editing your message' : `Replying to ${replyTo?.sender ?? 'this message'}`}
                </div>
                <div className="truncate text-muted-foreground">
                  {(editing ?? replyTo)?.body || 'Attachment'}
                </div>
              </div>
              <button
                type="button"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full hover:bg-muted"
                onClick={() => {
                  if (editing) setDraft('')
                  setEditing(null)
                  setReplyTo(null)
                }}
                aria-label="Cancel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {(files.length > 0 || uploading > 0) && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {files.map((f) => (
                <span key={f.file_id} className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background py-1 pl-1 pr-2 text-[12.5px]">
                  {isImage(f) ? (
                    <img src={f.url} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                  ) : (
                    <FileText className="ml-1 h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="truncate">{f.name}</span>
                  <span className="text-muted-foreground">{sizeOf(f.size_bytes)}</span>
                  <button
                    type="button"
                    className="ml-0.5 rounded p-0.5 hover:bg-muted"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles((cur) => cur.filter((x) => x.file_id !== f.file_id))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {pending.map((p) => (
                <span
                  key={p.key}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed py-1 pl-1 pr-2 text-[12.5px] text-muted-foreground"
                >
                  {p.preview ? (
                    <img src={p.preview} alt="" className="h-8 w-8 shrink-0 animate-pulse rounded object-cover" />
                  ) : (
                    <FileText className="ml-1 h-3.5 w-3.5 shrink-0 animate-pulse" />
                  )}
                  <span className="truncate">{p.name}</span>
                  <span>sending…</span>
                </span>
              ))}
            </div>
          )}
          {uploadError && <p className="mb-1.5 text-[12.5px] text-destructive">{uploadError}</p>}
          {error != null && (
            <p className="mb-1.5 text-[12.5px] text-destructive">
              {error instanceof Error ? error.message : 'Could not send that.'}
            </p>
          )}
          <form
            className="flex items-end gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            {allowAttachments && (
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => void upload(e.target.files)}
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,audio/*,video/*"
              />
            )}
            <button
              type="button"
              className="chat-icon grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-black/5"
              title="Find in this conversation"
              aria-label="Find in this conversation"
              onClick={() => setFinding((v) => !v)}
            >
              <Search className="h-5 w-5" />
            </button>
            {/* A voice note is an attachment, so it lives behind the same
                permission as one. */}
            {allowAttachments && !draft.trim() && (
              <VoiceButton
                disabled={files.length >= 10}
                onRecorded={(file) => void upload(file)}
              />
            )}
            {allowAttachments && (
              <button
                type="button"
                className="chat-icon grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-black/5"
                title="Attach a photo or file"
                aria-label="Attach a photo or file"
                onClick={() => fileInput.current?.click()}
                disabled={files.length >= 10}
              >
                <Paperclip className="h-5 w-5" />
              </button>
            )}
            <textarea
              ref={box}
              value={draft}
              rows={1}
              placeholder={placeholder}
              className="chat-composer min-h-[42px] max-h-[7.5rem] flex-1 resize-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden rounded-[21px] border-0 px-4 py-[11px] text-[15px] leading-5 shadow-sm outline-none focus:shadow-[0_0_0_2px_rgba(0,168,132,0.35)]"
              onChange={(e) => {
                setDraft(e.target.value)
                // "I am typing to you", throttled in sendTyping; only while
                // there is something in the box, so a cleared box goes quiet.
                if (live && e.target.value.trim()) sendTyping(live)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <button
              type="submit"
              className="chat-send grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full text-white transition-transform active:scale-95 disabled:opacity-40"
              disabled={sending || uploading > 0 || (!draft.trim() && files.length === 0)}
              aria-label="Send"
              title="Send (Enter)"
            >
              <Send className="ml-[2px] h-5 w-5" />
            </button>
          </form>
        </div>
      ) : (
        cannotSendNote && <div className="border-t px-4 py-3 text-[13px] text-muted-foreground">{cannotSendNote}</div>
      )}
      <style>{chatCSS}</style>
    </div>
  )
}

/* Web addresses in a message open as links; a parent pasting a form URL
   should not have to copy it out by hand. Only http(s) -- anything else is
   text. */
const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)])/g
function linkify(body: string): ReactNode {
  const parts = body.split(URL_RE)
  if (parts.length === 1) return body
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  )
}

/* One colour per sender name in a group thread, the way a chat app tells
   the counsellor from the class teacher at a glance. Stable for a name. */
function hueFor(name?: string): string {
  let h = 0
  for (const ch of name ?? '') h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h} 55% 38%)`
}

function isAudio(a: Attachment) {
  return (a.content_type ?? '').startsWith('audio/')
}

/* A VOICE NOTE, DRAWN RATHER THAN DELEGATED.
 *
 * The browser's own <audio> is a grey slab with its own colours and its own
 * chrome, and inside a coloured bubble it looks like something that fell into
 * the conversation. This is the control every messaging app draws instead: a
 * round play button, a bar of ticks that fills as it plays and can be tapped
 * to seek, and the length -- counting up while it runs, the total when it is
 * idle.
 *
 * The bars are not a real waveform. Decoding the audio to measure it means
 * downloading and decoding every note in the thread before any of them can be
 * shown, which on a school connection is the wrong trade; the heights are
 * derived from the file's own id, so one note always looks like itself and two
 * notes look different from each other. What is honest here is the position,
 * the length and the playing state, and those are real.
 */
function VoiceNote({ a }: { a: Attachment }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)
  const [len, setLen] = useState(0)

  // A stable, file-specific set of heights: the same note looks the same on
  // every screen and after every reload.
  const bars = useMemo(() => {
    let seed = 0
    for (const ch of a.file_id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
    return Array.from({ length: 27 }, (_, i) => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return 5 + ((seed >>> (i % 7)) % 16)
    })
  }, [a.file_id])

  const toggle = () => {
    const el = audio.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audio.current
    if (!el || !len) return
    const box = e.currentTarget.getBoundingClientRect()
    el.currentTime = ((e.clientX - box.left) / box.width) * len
  }

  const done = len ? Math.min(1, at / len) : 0
  const shown = playing || at > 0 ? at : len

  return (
    <div className="chat-voice mb-1 flex w-[232px] max-w-full items-center gap-2.5">
      <audio
        ref={audio}
        src={a.url}
        preload="metadata"
        onLoadedMetadata={(e) => setLen(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setAt(0)
        }}
        className="hidden"
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className="chat-voice__play grid h-9 w-9 shrink-0 place-items-center rounded-full"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-[2px] h-4 w-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          role="presentation"
          onClick={seek}
          className="flex h-[26px] cursor-pointer items-center gap-[2px]"
        >
          {bars.map((h, i) => (
            <span
              key={i}
              className={cn('chat-voice__bar', i / bars.length <= done && 'is-played')}
              style={{ height: h }}
            />
          ))}
        </div>
        <div className="chat-voice__time mt-0.5 text-[11.5px] tabular-nums">{clock(shown)}</div>
      </div>
      <a
        href={a.url}
        download={a.name}
        title={`Download ${a.name}`}
        className="chat-voice__get grid h-7 w-7 shrink-0 place-items-center rounded-full"
      >
        <Download className="h-3.5 w-3.5" />
      </a>
    </div>
  )
}

/** Seconds as 0:07 / 1:23. */
function clock(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function AttachmentView({ a }: { a: Attachment }) {
  if (isAudio(a)) return <VoiceNote a={a} />
  /* A tap saves the file.
   *
   * The link opened a new tab, which the server answered with
   * Content-Disposition: attachment, so the file downloaded and left an empty
   * tab behind. On a phone that read as nothing having happened. `download`
   * asks for the save directly, under the name the sender gave it rather than
   * the uuid the store keeps it under, and a mark on the row says so. */
  if (isImage(a)) {
    return (
      <a href={a.url} download={a.name} className="relative mb-1 block w-fit" title={`Download ${a.name}`}>
        <img src={a.url} alt={a.name} loading="lazy" className="max-h-64 max-w-full rounded-md" style={{ display: 'block' }} />
        <span className="absolute bottom-1.5 right-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white">
          <Download className="h-4 w-4" />
        </span>
      </a>
    )
  }
  return (
    <a
      href={a.url}
      download={a.name}
      title={`Download ${a.name}`}
      className="chat-file mb-1 flex items-center gap-2 rounded-md px-3 py-2 text-[13px]"
    >
      <FileText className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{a.name}</span>
        <span className="text-[11.5px] text-muted-foreground">{sizeOf(a.size_bytes)}</span>
      </span>
      <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
    </a>
  )
}

function isImage(a: Attachment) {
  return (a.content_type ?? '').startsWith('image/')
}

export function sizeOf(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function timeOf(iso: string) {
  const d = new Date(iso.length <= 16 ? iso + ':00' : iso)
  if (isNaN(d.getTime())) return iso.slice(11, 16)
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}

function dayLabel(day: string) {
  const today = new Date()
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (day === iso(today)) return 'Today'
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (day === iso(y)) return 'Yesterday'
  const d = new Date(day + 'T00:00:00')
  return isNaN(d.getTime()) ? day : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

/* The two bubble colours and the paper behind them, in both themes. Kept as
   a style block here rather than in the global sheet so the component owns
   its look and a screen cannot half-apply it. */
const chatCSS = `
/* One set of colours, light in every theme.

   The paper followed the app's dark mode and a school office reading a
   parent's message on a projector or a cheap phone in daylight got white text
   on near-black, which is what the screenshot showed. A conversation is a
   document; it reads the same way the printed page does, whatever the rest of
   the app is set to.

   The dotted paper is fixed, not scrolled: a pattern that slides under the
   bubbles as the thread scrolls reads as movement in the corner of the eye. */
.chat-paper {
  background-color: #fbfcfe;
}
/* Two bubbles, and they are shapes rather than boxes.

   The old pair were the messaging app everybody copies: a tinted green, a
   1px shadow, a wedge for a tail, the time tucked into the bottom-right of
   the text. This is the other convention and the one the school asked for --
   a wide radius with one corner pulled in to point at the speaker, the
   sender's own words carried in the product's blue, and the time set outside
   the bubble underneath it, where it never has to be written around. */
.chat-theirs {
  background-color: #ffffff;
  color: #202b3c;
  border-radius: 20px 20px 20px 4px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.04);
}
.chat-mine {
  /* NOT THE BRAND COLOUR.

     This took hsl(var(--primary)), so a school themed in red sent every
     message in a red bubble -- which reads as an error, not as something you
     said. A conversation's own blue, fixed, the way every messaging app fixes
     it: the brand belongs to the chrome around the thread, not to the words
     inside it. */
  background-color: #2f6fed;
  color: #ffffff;
  border-radius: 20px 20px 4px 20px;
}
/* A run of bubbles from the same person: only the first points at them, the
   rest are plain, so a paragraph broken into four messages reads as one. */
.chat-theirs.chat-run { border-radius: 20px; }
.chat-mine.chat-run { border-radius: 20px; }
.chat-bubble a { color: inherit; text-decoration: underline; word-break: break-all; }
.chat-mine .text-muted-foreground, .chat-mine a { color: rgba(255,255,255,0.88); }
.chat-theirs .text-muted-foreground { color: #9aa5b6; }
.chat-meta { font-size: 12px; color: #9aa5b6; padding: 0 6px; }
/* A quote and a file row are painted by the bubble they sit in. Left as
   dark-on-light they were unreadable inside the blue one -- a blue name on a
   blue ground -- and that is the whole reason a bubble has a colour. */
.chat-theirs .chat-quote { border-color: hsl(var(--primary)); background: rgba(16, 24, 40, 0.04); border-radius: 10px; }
.chat-theirs .chat-quote__who { color: hsl(var(--primary)); }
.chat-theirs .chat-quote__body { color: #9aa5b6; }
.chat-mine .chat-quote { border-color: rgba(255,255,255,0.75); background: rgba(255,255,255,0.16); border-radius: 10px; }
.chat-mine .chat-quote__who { color: #ffffff; }
.chat-mine .chat-quote__body { color: rgba(255,255,255,0.82); }
/* The browser draws its own audio controls and will not be told otherwise, so
   the player sits on a light panel in both bubbles rather than fighting the
   colour behind it. */
/* The voice note takes the colour of the bubble it is in, the way the words
   do: a white button on blue, a blue button on white, and the bar behind the
   played part dimmed rather than recoloured. */
.chat-voice__bar { width: 2.5px; border-radius: 2px; flex: 1 1 auto; }
.chat-mine .chat-voice__bar { background: rgba(255,255,255,0.42); }
.chat-mine .chat-voice__bar.is-played { background: #ffffff; }
.chat-theirs .chat-voice__bar { background: #ccd7e6; }
.chat-theirs .chat-voice__bar.is-played { background: #2f6fed; }
.chat-mine .chat-voice__play { background: #ffffff; color: #2f6fed; }
.chat-theirs .chat-voice__play { background: #2f6fed; color: #ffffff; }
.chat-mine .chat-voice__time, .chat-mine .chat-voice__get { color: rgba(255,255,255,0.85); }
.chat-theirs .chat-voice__time, .chat-theirs .chat-voice__get { color: #9aa5b6; }
.chat-theirs .chat-file { background: rgba(16, 24, 40, 0.04); }
.chat-theirs .chat-file:hover { background: rgba(16, 24, 40, 0.07); }
.chat-mine .chat-file { background: rgba(255,255,255,0.16); color: #ffffff; }
.chat-mine .chat-file:hover { background: rgba(255,255,255,0.24); }
.chat-mine .chat-file .text-muted-foreground { color: rgba(255,255,255,0.8); }
.chat-daypill {
  background-color: #eef2f7;
  color: #9aa5b6;
  border-radius: 12px;
  padding: 4px 14px;
  box-shadow: none;
}
/* Typing, drawn as the other person's bubble with three breathing dots. */
.chat-dot {
  width: 7px; height: 7px; border-radius: 9999px; background-color: #8696a0;
  animation: chat-dot 1.2s ease-in-out infinite;
}
@keyframes chat-dot {
  0%, 60%, 100% { transform: translateY(0); opacity: .45; }
  30% { transform: translateY(-3px); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) { .chat-dot { animation: none; opacity: .7; } }
/* The bar under the thread and the controls in it. */
.chat-bar { background-color: #f0f2f5; border-top: 1px solid rgba(11,20,26,0.06); }
.chat-icon { color: #54656f; }
.chat-send { background-color: #00a884; }
.chat-send:hover:not(:disabled) { background-color: #06957a; }
.chat-jump { background-color: #ffffff; color: #54656f; box-shadow: 0 2px 6px rgba(11,20,26,0.25); }
/* The composer is one line that grows with the text and nothing a person can
   drag: a hand-resized box is a layout nobody asked for and it does not
   survive the next render. */
.chat-composer { resize: none; background-color: #ffffff; color: #111b21; }
.chat-composer::placeholder { color: #8696a0; }
.chat-daypill { background-color: #ffffff; color: #54656f; box-shadow: 0 1px 0.5px rgba(11,20,26,0.13); }

/* A HELD MESSAGE, AND THE ROOM GOING QUIET AROUND IT.

   The scrim blurs the thread rather than merely darkening it, so the message
   that was held is the only thing in focus; the copy of it is lifted with a
   shadow and a fraction of scale, which is what makes it read as the same
   bubble rising rather than a second one appearing. The menu is the dark
   translucent surface a phone uses for this, whatever theme the rest of the
   app is in: it is a system object, not part of the page. */
.chat-scrim {
  background: rgba(0, 0, 0, 0.42);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  animation: chat-scrim-in 140ms ease-out both;
}
@keyframes chat-scrim-in { from { opacity: 0 } to { opacity: 1 } }
.chat-lift {
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
  animation: chat-lift-in 160ms cubic-bezier(.2,.8,.3,1) both;
  transform-origin: center;
}
@keyframes chat-lift-in {
  from { transform: scale(.97); }
  to   { transform: scale(1.02); }
}
.chat-menu {
  background: rgba(35, 35, 38, 0.95);
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.4);
  animation: chat-menu-in 150ms cubic-bezier(.2,.8,.3,1) both;
}
@keyframes chat-menu-in {
  from { opacity: 0; transform: scale(.94); }
  to   { opacity: 1; transform: scale(1); }
}
.chat-menu__row {
  height: 44px;
  color: #f2f2f7;
  border-bottom: 0.5px solid rgba(255, 255, 255, 0.12);
}
.chat-menu__row:last-child { border-bottom: 0; }
.chat-menu__row:active { background: rgba(255, 255, 255, 0.1); }
.chat-menu__row--danger { color: #ff453a; }
/* The words going, rather than blinking out: the bubble keeps its place in
   the thread and its new sentence arrives over about a fifth of a second. */
/* A withdrawn message is usually shorter than the one it replaces, so the
   bubble changes size. Transitioning the colour and the shadow with it stops
   that being a snap, and the thread above keeps its place because nothing
   else moves. */
.chat-settle { transition: background-color 180ms ease, box-shadow 180ms ease; }
.chat-withdrawn { animation: chat-withdrawn-in 180ms ease-out both; }
@keyframes chat-withdrawn-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
`

/* THE PRESSED MESSAGE, LIFTED OUT OF THE THREAD.
 *
 * A menu pinned beside a bubble is unreadable on a phone: the bubble may be
 * anywhere, the thumb is already on it, and the rest of the conversation goes
 * on competing for the eye. So the whole thread is blurred and darkened, the
 * message that was held is redrawn in exactly the place it occupied -- so it
 * appears to rise out of the page rather than to be replaced by a copy -- and
 * the actions sit under it.
 *
 * Three of them, and no more: answer it, take its words, or take it back.
 * Delete is the author's own recent message only, which is what the server
 * will allow; on anybody else's it is simply not offered rather than offered
 * and refused.
 *
 * Above or below the bubble, whichever has room. A message near the foot of
 * the screen gets its menu above it, which is the arrangement a phone uses
 * and the one that keeps a thumb from covering the choices it is making. */
function MessageActions({
  m,
  rect,
  mine,
  onClose,
  onReply,
  onDelete,
}: {
  m: ChatMessage
  rect: DOMRect
  mine: boolean
  onClose: () => void
  onReply?: () => void
  onDelete?: () => void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const vh = typeof window === 'undefined' ? 800 : window.innerHeight
  const menuH = 44 * [onReply, true, onDelete].filter(Boolean).length + 16
  // Below the bubble if it fits, otherwise above it.
  const below = rect.bottom + 8 + menuH < vh - 16
  const top = below ? rect.bottom + 8 : Math.max(12, rect.top - 8 - menuH)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.body || '')
      setCopied(true)
      setTimeout(onClose, 450)
    } catch {
      // No clipboard permission: closing silently is better than an error
      // about a thing the person can do by selecting the text.
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-[130]" role="dialog" aria-modal="true">
      {/* The thread, still there and plainly out of focus. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="chat-scrim absolute inset-0 cursor-default"
      />

      {/* The held message, where it was. */}
      <div
        className="pointer-events-none absolute"
        style={{
          top: rect.top,
          left: mine ? undefined : rect.left,
          right: mine ? Math.max(8, window.innerWidth - rect.right) : undefined,
          width: rect.width,
        }}
      >
        <div
          className={cn(
            'chat-bubble chat-lift px-[16px] py-[12px] text-[15.5px] leading-[1.42]',
            mine ? 'chat-mine' : 'chat-theirs',
          )}
        >
          <p className="line-clamp-6 whitespace-pre-wrap break-words">
            {m.deleted ? 'This message was withdrawn.' : m.body || 'Attachment'}
          </p>
        </div>
      </div>

      {/* The choices. */}
      <div
        className="chat-menu absolute w-[220px] overflow-hidden rounded-[14px]"
        style={{ top, left: mine ? undefined : rect.left, right: mine ? Math.max(8, window.innerWidth - rect.right) : undefined }}
      >
        {onReply && (
          <MenuItem icon={<Reply className="h-[19px] w-[19px]" />} label="Reply" onClick={() => { onClose(); onReply() }} />
        )}
        <MenuItem icon={<Copy className="h-[19px] w-[19px]" />} label={copied ? 'Copied' : 'Copy'} onClick={() => void copy()} />
        {onDelete && (
          <MenuItem
            icon={<Trash2 className="h-[19px] w-[19px]" />}
            label="Delete"
            danger
            onClick={() => { onClose(); onDelete() }}
          />
        )}
      </div>
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'chat-menu__row flex w-full items-center justify-between gap-3 px-4 text-left text-[15px]',
        danger && 'chat-menu__row--danger',
      )}
    >
      {label}
      {icon}
    </button>
  )
}

/* The small pop a phone makes when a press is taken.
 *
 * Synthesised rather than shipped: a file would be another request, another
 * thing to cache and another thing to get wrong on a browser that will not
 * autoplay it. A short sine falling from 880Hz with an exponential tail is
 * the click; it is quiet, it is 40ms, and if the browser has no audio context
 * it simply does not happen. */
function popSound() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.04)
    gain.gain.setValueAtTime(0.06, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.06)
    osc.onended = () => void ctx.close()
  } catch {
    /* No audio, no sound. The haptic and the menu are the feedback. */
  }
}

/* A VOICE NOTE.
 *
 * Most parents at this school read Telugu more comfortably than they type
 * English, and a teacher between periods has thirty seconds and no hands. The
 * recorder is the browser's own -- no library, no upload format of our
 * invention: it produces an ordinary audio file that goes through the same
 * attachment path as a photo, plays in the bubble with the browser's controls,
 * and downloads like anything else.
 *
 * If the browser will not record, or the person refuses the microphone, the
 * button simply does not appear: an attachment and a typed message still work,
 * and a dead control that asks for a permission every time is worse. */
function VoiceButton({ onRecorded, disabled }: { onRecorded: (f: File) => void; disabled?: boolean }) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<BlobPart[]>([])

  const supported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia

  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setSeconds((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [recording])

  // Two minutes is a long voice note and a very long upload on a school line.
  useEffect(() => {
    if (recording && seconds >= 120) stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, recording])

  if (!supported) return null

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunks.current = []
      mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' })
        if (blob.size > 0) {
          const ext = (mr.mimeType || 'audio/webm').includes('mp4') ? 'm4a' : 'webm'
          onRecorded(new File([blob], `voice-note-${Date.now()}.${ext}`, { type: blob.type }))
        }
      }
      mr.start()
      rec.current = mr
      setSeconds(0)
      setRecording(true)
    } catch {
      // Refused, or no microphone. Nothing to say; the other ways still work.
      setRecording(false)
    }
  }

  function stop() {
    rec.current?.stop()
    rec.current = null
    setRecording(false)
  }

  if (recording) {
    return (
      <button
        type="button"
        onClick={stop}
        title="Stop and attach"
        aria-label="Stop recording and attach"
        className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-destructive px-3 text-[12.5px] font-semibold text-white"
      >
        <Square className="h-3.5 w-3.5" />
        {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={disabled}
      title="Record a voice note"
      aria-label="Record a voice note"
      className="chat-icon grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-black/5 disabled:opacity-40"
    >
      <Mic className="h-5 w-5" />
    </button>
  )
}
