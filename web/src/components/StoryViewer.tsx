import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { X, FileText, Link2, Download, ExternalLink } from 'lucide-react'
import './story-viewer.css'

/* MEDIA THE WAY A PHONE SHOWS A STATUS.

   A picture a teacher shares with a class is looked at, not filed. The
   library list still exists below for finding things later; this is the
   way they are seen first. One poster's items play in order, a bar per
   item filling along the top, tap right to go on and left to go back,
   hold to pause, swipe down or press Escape to close. A picture shows for
   six seconds, a video for its length, a document or a link as a card
   with the one button that opens it. Reaching an item marks it seen, and
   the strip that opened this dims that poster's ring once all are.

   Written as a plain full-screen dialog rather than a library: the
   gestures are four, the state is two numbers, and a dependency for that
   would be the thing that breaks on the next WebView. */

export type StoryMedia = 'image' | 'video' | 'pdf' | 'link' | 'file'

export interface StoryItem {
  id: string
  title: string
  description?: string
  media: StoryMedia
  /** The picture or video source, or the document to open. */
  src?: string
  /** Where a link goes, or a file downloads from. */
  href?: string
  postedAt?: string
  seen: boolean
  tag?: string
}

export interface StoryGroup {
  id: string
  name: string
  items: StoryItem[]
}

const IMAGE_MS = 6000
const CARD_MS = 6000

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

export function timeAgo(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days} d ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export default function StoryViewer({
  groups,
  start = 0,
  onClose,
  onSeen,
}: {
  groups: StoryGroup[]
  /** Which poster to open on. */
  start?: number
  onClose: () => void
  /** Called once per item as it comes on screen, for the seen mark. */
  onSeen?: (item: StoryItem) => void
}) {
  const [g, setG] = useState(Math.min(start, Math.max(0, groups.length - 1)))
  const [i, setI] = useState(() => {
    /* Open on the first thing not yet seen, as a status does; the seen ones
       are still there behind a tap to the left. */
    const first = groups[Math.min(start, groups.length - 1)]?.items.findIndex((it) => !it.seen) ?? 0
    return first < 0 ? 0 : first
  })
  const [progress, setProgress] = useState(0)
  const [paused, setPaused] = useState(false)
  const video = useRef<HTMLVideoElement | null>(null)
  const group = groups[g]
  const item = group?.items[i]

  const goNext = useCallback(() => {
    if (!group) return onClose()
    if (i + 1 < group.items.length) {
      setI(i + 1)
    } else if (g + 1 < groups.length) {
      setG(g + 1)
      setI(0)
    } else {
      onClose()
    }
  }, [g, i, group, groups.length, onClose])

  const goPrev = useCallback(() => {
    if (i > 0) {
      setI(i - 1)
    } else if (g > 0) {
      setG(g - 1)
      setI(0)
    } else {
      setProgress(0)
    }
  }, [g, i])

  /* The clock. A picture and a card run on a timer; a video reports its own
     time. Paused holds whichever it is. */
  useEffect(() => {
    if (!item) return
    setProgress(0)
    if (item.media === 'video') return
    const total = item.media === 'image' ? IMAGE_MS : CARD_MS
    let raf = 0
    let last = performance.now()
    let elapsed = 0
    const tick = (now: number) => {
      if (!paused) elapsed += now - last
      last = now
      const p = Math.min(1, elapsed / total)
      setProgress(p)
      if (p >= 1) {
        goNext()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // goNext changes identity with g/i, which is exactly when this restarts.
  }, [item, paused, goNext])

  useEffect(() => {
    const v = video.current
    if (!v || item?.media !== 'video') return
    if (paused) v.pause()
    else void v.play().catch(() => undefined)
  }, [paused, item])

  useEffect(() => {
    if (item && !item.seen) onSeen?.(item)
  }, [item, onSeen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') goNext()
      else if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === ' ') {
        e.preventDefault()
        setPaused((p) => !p)
      }
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, goNext, goPrev])

  /* Hold to pause, swipe down to close, tap to move. One pointer, three
     outcomes, decided on release by how long and how far it went. */
  const press = useRef<{ t: number; x: number; y: number } | null>(null)
  const onDown = (e: ReactPointerEvent) => {
    press.current = { t: performance.now(), x: e.clientX, y: e.clientY }
    setPaused(true)
  }
  const onUp = (dir: 'prev' | 'next') => (e: ReactPointerEvent) => {
    const p = press.current
    press.current = null
    setPaused(false)
    if (!p) return
    const dy = e.clientY - p.y
    const dx = Math.abs(e.clientX - p.x)
    if (dy > 80 && dx < 60) return onClose()
    if (performance.now() - p.t > 300 || dx > 12 || Math.abs(dy) > 12) return
    if (dir === 'prev') goPrev()
    else goNext()
  }
  const onCancel = () => {
    press.current = null
    setPaused(false)
  }

  if (!group || !item) return null

  return createPortal(
    <div className="story" role="dialog" aria-label="Shared media" aria-modal="true">
      <div className={`story__stage${paused ? ' story__paused' : ''}`}>
        <div className="story__top">
          <div className="story__bars" aria-hidden="true">
            {group.items.map((it, k) => (
              <div key={it.id} className="story__bar">
                <i style={{ '--p': k < i ? '100%' : k === i ? `${progress * 100}%` : '0%' } as CSSProperties} />
              </div>
            ))}
          </div>
          <div className="story__head">
            <div className="story__avatar" aria-hidden="true">{initials(group.name)}</div>
            <div className="story__who">
              <div className="story__name">{group.name}</div>
              <div className="story__when">
                {timeAgo(item.postedAt)}
                {group.items.length > 1 ? ` · ${i + 1} of ${group.items.length}` : ''}
              </div>
            </div>
            <button type="button" className="story__close" onClick={onClose} aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="story__media" aria-live="polite">
          {item.media === 'image' && <img key={item.id} src={item.src} alt={item.title} draggable={false} />}
          {item.media === 'video' && (
            <video
              key={item.id}
              ref={video}
              src={item.src}
              autoPlay
              playsInline
              onTimeUpdate={(e) => {
                const v = e.currentTarget
                if (v.duration > 0) setProgress(v.currentTime / v.duration)
              }}
              onEnded={goNext}
            />
          )}
          {(item.media === 'pdf' || item.media === 'file' || item.media === 'link') && (
            <div className="story__card" key={item.id}>
              <div className="story__card-icon">
                {item.media === 'link' ? <Link2 className="size-7" /> : <FileText className="size-7" />}
              </div>
              <div className="story__card-title">{item.title}</div>
              {item.description && <div className="story__card-sub">{item.description}</div>}
              <a
                className="story__open"
                href={item.href ?? item.src}
                target="_blank"
                rel="noreferrer noopener"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
              >
                {item.media === 'link' ? <ExternalLink className="size-4" /> : item.media === 'pdf' ? <FileText className="size-4" /> : <Download className="size-4" />}
                {item.media === 'link' ? 'Open link' : item.media === 'pdf' ? 'Open' : 'Download'}
              </a>
            </div>
          )}
        </div>

        <button
          type="button"
          className="story__zone story__zone--prev"
          aria-label="Previous"
          onPointerDown={onDown}
          onPointerUp={onUp('prev')}
          onPointerCancel={onCancel}
          onPointerLeave={onCancel}
        />
        <button
          type="button"
          className="story__zone story__zone--next"
          aria-label="Next"
          onPointerDown={onDown}
          onPointerUp={onUp('next')}
          onPointerCancel={onCancel}
          onPointerLeave={onCancel}
        />

        {paused && <div className="story__hint">Paused</div>}

        {(item.media === 'image' || item.media === 'video') && (
          <div className="story__caption">
            {item.tag && <span className="story__tag">{item.tag}</span>}
            <div className="story__title">{item.title}</div>
            {item.description && <div className="story__desc">{item.description}</div>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
