import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown, Check, CheckCheck, Download, FileText, Image as ImageIcon,
  Paperclip, Search, Send, X,
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
  /** Set once the other side opened it; drawn as two blue ticks. */
  read_at?: string
  attachments?: Attachment[]
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
  /* A floor and a viewport-relative ceiling, not a fixed 28rem cap: capped, the
     paper stopped a third of the way down a tall card and the composer floated
     over empty white. It now fills the card it is given (flex-1 on the root)
     and only the viewport bounds it, so the thread scrolls inside itself
     rather than scrolling the page. */
  height = 'min-h-[14rem] max-h-[70vh]',
  live,
}: {
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
  }

  /* Find something in a long thread. A conversation about one child runs for a
     year; "what did we agree about the bus" is a search, not a scroll. */
  const [finding, setFinding] = useState(false)
  const [needle, setNeedle] = useState('')
  const shown = useMemo(() => {
    const q = needle.trim().toLowerCase()
    if (!q) return messages
    return messages.filter(
      (m) =>
        (m.body ?? '').toLowerCase().includes(q) ||
        (m.sender ?? '').toLowerCase().includes(q) ||
        (m.attachments ?? []).some((a) => a.name.toLowerCase().includes(q)),
    )
  }, [messages, needle])

  // The box grows with what is typed, up to about five lines.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }, [draft])

  const upload = async (list: FileList | null) => {
    if (!list || !list.length) return
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

  const submit = () => {
    const body = draft.trim()
    if ((!body && files.length === 0) || sending || uploading > 0) return
    const out = { body, attachments: files }
    setDraft('')
    setFiles([])
    void onSend(out)
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
                <div className={cn('mb-1.5 flex', m.mine ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'chat-bubble relative max-w-[85%] rounded-lg px-2.5 py-1.5 text-[14px] shadow-sm sm:max-w-[70%]',
                      m.mine ? 'chat-mine rounded-tr-sm' : 'chat-theirs rounded-tl-sm',
                    )}
                  >
                    {showSender && !m.mine && m.sender && (
                      <p className="mb-0.5 text-[12px] font-semibold text-primary">{m.sender}</p>
                    )}
                    {(m.attachments ?? []).map((a) => (
                      <AttachmentView key={a.file_id} a={a} />
                    ))}
                    {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                    <p className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] leading-none text-muted-foreground">
                      <span>{timeOf(m.at)}</span>
                      {m.mine &&
                        (m.read_at ? (
                          <CheckCheck className="h-3.5 w-3.5 text-[#53bdeb]" aria-label={`Read ${formatDateTime(m.read_at)}`} />
                        ) : (
                          <Check className="h-3.5 w-3.5" aria-label="Sent" />
                        ))}
                    </p>
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
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void upload(e.target.files)}
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,audio/*,video/*"
            />
            <button
              type="button"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted"
              title="Find in this conversation"
              aria-label="Find in this conversation"
              onClick={() => setFinding((v) => !v)}
            >
              <Search className="h-5 w-5" />
            </button>
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

function AttachmentView({ a }: { a: Attachment }) {
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
