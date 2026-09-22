import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown, Check, CheckCheck, Clock, Download, FileText, Image as ImageIcon,
  Mic, MoreVertical, Paperclip, Pencil, Reply, Search, Send, Square, Trash2, X,
} from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
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
    if (!atBottom) return
    told.current = lastIncoming
    onSeen()
  }, [lastIncoming, atBottom, onSeen])

  /* Find something in a long thread. A conversation about one child runs for a
     year; "what did we agree about the bus" is a search, not a scroll. */
  const [finding, setFinding] = useState(false)
  const [needle, setNeedle] = useState('')
  const all = useMemo(() => [...messages, ...outgoing], [messages, outgoing])
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
    for (const f of picked) {
      try {
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
  const [outgoing, setOutgoing] = useState<ChatMessage[]>([])

  const deliver = useCallback(
    async (draftMsg: ChatMessage, payload: { body: string; attachments: Attachment[]; reply_to_id?: string }) => {
      try {
        await onSend(payload)
        // The refetch carries the real message; drop our stand-in.
        setOutgoing((cur) => cur.filter((m) => m.id !== draftMsg.id))
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
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
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
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
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
          shown.map((m) => {
            const day = m.at.slice(0, 10)
            const sep = day !== lastDay
            lastDay = day
            return (
              <div key={m.id}>
                {sep && (
                  <div className="my-3 flex justify-center">
                    <span className="chat-daypill rounded-md px-2.5 py-1 text-[11.5px] font-medium shadow-sm">
                      {dayLabel(day)}
                    </span>
                  </div>
                )}
                <div className={cn('group mb-1.5 flex items-end gap-1', m.mine ? 'justify-end' : 'justify-start')}>
                  {/* Answer this one. Left of your own bubble, right of theirs,
                      so the control never sits where the text begins. */}
                  {!m.deleted && !m.pending && !m.failed && canSend && m.mine && (
                    <BubbleActions
                      m={m}
                      onReply={() => setReplyTo(m)}
                      onEdit={onEdit ? () => { setEditing(m); setDraft(m.body) } : undefined}
                      onUnsend={onUnsend ? () => void onUnsend(m.id) : undefined}
                    />
                  )}
                  <div
                    className={cn(
                      'chat-bubble relative max-w-[85%] rounded-lg px-2.5 py-1.5 text-[14px] shadow-sm sm:max-w-[70%]',
                      m.mine ? 'chat-mine rounded-tr-sm' : 'chat-theirs rounded-tl-sm',
                      m.failed && 'ring-1 ring-destructive',
                      m.pending && 'opacity-80',
                    )}
                  >
                    {showSender && !m.mine && m.sender && (
                      <p className="mb-0.5 text-[12px] font-semibold text-primary">{m.sender}</p>
                    )}
                    {/* What it answers, quoted. */}
                    {m.reply_to_id && (m.reply_body || m.reply_sender) && (
                      <div className="mb-1 border-l-2 border-primary/60 bg-black/5 px-2 py-1 text-[12.5px]">
                        {m.reply_sender && <div className="font-semibold text-primary">{m.reply_sender}</div>}
                        <div className="line-clamp-2 text-muted-foreground">{m.reply_body || 'Attachment'}</div>
                      </div>
                    )}
                    {m.deleted ? (
                      <p className="italic text-muted-foreground">This message was withdrawn.</p>
                    ) : (
                      <>
                        {(m.attachments ?? []).map((a) => (
                          <AttachmentView key={a.file_id} a={a} />
                        ))}
                        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                      </>
                    )}
                    <p className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] leading-none text-muted-foreground">
                      {m.edited && !m.deleted && <span className="italic">edited</span>}
                      <span>{timeOf(m.at)}</span>
                      {m.mine &&
                        (m.failed ? (
                          <span className="font-semibold text-destructive">not sent</span>
                        ) : m.pending ? (
                          <Clock className="h-3.5 w-3.5" aria-label="Sending" />
                        ) : m.read_at ? (
                          <CheckCheck className="h-3.5 w-3.5 text-[#53bdeb]" aria-label={`Seen ${formatDateTime(m.read_at)}`} />
                        ) : (
                          <Check className="h-3.5 w-3.5" aria-label="Sent" />
                        ))}
                    </p>
                    {m.failed && (
                      <p className="mt-1 flex gap-3 text-[12px] font-semibold">
                        <button type="button" className="text-primary" onClick={() => retry(m)}>Retry</button>
                        <button type="button" className="text-muted-foreground" onClick={() => discard(m)}>Discard</button>
                      </p>
                    )}
                  </div>
                  {!m.deleted && !m.pending && !m.failed && canSend && !m.mine && (
                    <BubbleActions m={m} onReply={() => setReplyTo(m)} />
                  )}
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
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground" aria-live="polite">
            <span className="inline-flex gap-0.5" aria-hidden="true">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
            </span>
            typing…
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
          className="absolute bottom-[4.5rem] right-4 z-10 inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-2 text-[12.5px] font-semibold text-primary-foreground shadow-lg"
        >
          <ArrowDown className="h-4 w-4" />
          {behind > 0 ? `${behind} new` : 'Latest'}
        </button>
      )}

      {canSend ? (
        <div
          /* The bar sits on the bottom edge. It used to carry even padding top
             and bottom on top of the screen's own safe-area inset, which on a
             desktop — where that inset is zero — read as a band of empty white
             under the box. The gap above the box stays; below it is only the
             phone's home-indicator allowance, and nothing when there is none. */
          className="border-t bg-muted/40 px-2 pt-2 sm:px-3"
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
                <span key={f.file_id} className="inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-1 text-[12.5px]">
                  {isImage(f) ? <ImageIcon className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
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
              {uploading > 0 && (
                <span className="inline-flex items-center rounded-md border border-dashed px-2 py-1 text-[12.5px] text-muted-foreground">
                  Uploading {uploading}…
                </span>
              )}
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
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted"
              title="Find in this conversation"
              aria-label="Find in this conversation"
              onClick={() => setFinding((v) => !v)}
            >
              <Search className="h-5 w-5" />
            </button>
            {/* A voice note is an attachment, so it lives behind the same
                permission as one. */}
            {allowAttachments && (
              <VoiceButton
                disabled={files.length >= 10}
                onRecorded={(file) => void upload(file)}
              />
            )}
            {allowAttachments && (
              <button
                type="button"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted"
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
              className="chat-composer min-h-[40px] flex-1 resize-none rounded-2xl border bg-background px-3.5 py-2 text-[14px] leading-6 outline-none focus:ring-2 focus:ring-primary/30"
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
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
              disabled={sending || uploading > 0 || (!draft.trim() && files.length === 0)}
              aria-label="Send"
              title="Send (Enter)"
            >
              <Send className="h-4.5 w-4.5" />
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

function isAudio(a: Attachment) {
  return (a.content_type ?? '').startsWith('audio/')
}

function AttachmentView({ a }: { a: Attachment }) {
  /* A voice note plays where it was sent. The browser's own player: it knows
     the codecs, it has the scrub bar and the speed control, and it is the one
     control on the page a person has already used somewhere else. */
  if (isAudio(a)) {
    return (
      <div className="mb-1 flex items-center gap-2">
        <audio controls preload="none" src={a.url} className="h-9 max-w-[230px]" />
        <a
          href={a.url}
          download={a.name}
          title={`Download ${a.name}`}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-black/5"
        >
          <Download className="h-4 w-4" />
        </a>
      </div>
    )
  }
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
      className="mb-1 flex items-center gap-2 rounded-md bg-black/5 px-2 py-1.5 text-[13px] hover:bg-black/10"
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
  background-color: #efeae2;
  background-image: radial-gradient(rgba(0,0,0,0.035) 1px, transparent 1px);
  background-size: 14px 14px;
  background-attachment: local;
  background-repeat: repeat;
}
.chat-theirs { background-color: #ffffff; color: #111b21; }
.chat-mine { background-color: #d9fdd3; color: #111b21; }
.chat-bubble .text-muted-foreground { color: #667781; }
/* The composer is one line that grows with the text and nothing a person can
   drag: a hand-resized box is a layout nobody asked for and it does not
   survive the next render. */
.chat-composer { resize: none; background-color: #ffffff; color: #111b21; }
.chat-composer::placeholder { color: #8696a0; }
.chat-daypill { background-color: rgba(255,255,255,0.92); color: #667781; }
`

/* What you can do to one message: answer it, and -- if it is yours and recent
   -- change or withdraw it. A menu rather than three buttons on every bubble,
   because a thread of two hundred messages with six hundred controls in it is
   not a conversation. */
function BubbleActions({
  m,
  onReply,
  onEdit,
  onUnsend,
}: {
  m: ChatMessage
  onReply: () => void
  onEdit?: () => void
  onUnsend?: () => void
}) {
  const [open, setOpen] = useState(false)
  const mine = m.mine && (onEdit || onUnsend)
  if (!mine) {
    return (
      <button
        type="button"
        onClick={onReply}
        title="Reply"
        aria-label="Reply to this message"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-black/5 focus:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-60"
      >
        <Reply className="h-4 w-4" />
      </button>
    )
  }
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="More"
        className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-black/5 focus:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-60"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <>
          {/* A click anywhere else closes it; no library, no portal. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-8 right-0 z-30 w-40 overflow-hidden rounded-lg border bg-card py-1 text-[13px] shadow-lg">
            <MenuItem icon={<Reply className="h-4 w-4" />} label="Reply" onClick={() => { setOpen(false); onReply() }} />
            {onEdit && <MenuItem icon={<Pencil className="h-4 w-4" />} label="Edit" onClick={() => { setOpen(false); onEdit() }} />}
            {onUnsend && (
              <MenuItem
                icon={<Trash2 className="h-4 w-4" />}
                label="Unsend"
                danger
                onClick={() => { setOpen(false); onUnsend() }}
              />
            )}
          </div>
        </>
      )}
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
        'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent',
        danger && 'text-destructive',
      )}
    >
      {icon}
      {label}
    </button>
  )
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
      className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-40"
    >
      <Mic className="h-5 w-5" />
    </button>
  )
}
