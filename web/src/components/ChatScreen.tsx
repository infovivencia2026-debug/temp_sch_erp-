import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft } from 'lucide-react'
import { useOverlayHistory } from '@/lib/overlay-history'
import { cn } from '@/lib/utils'

/* A conversation that takes the whole screen.

   The way a phone does it: the list of conversations is one screen, and
   opening one replaces everything -- header, sidebar, dock, the list -- with
   the chat alone and a back arrow. Nothing else competes for the thumb,
   and the composer sits at the bottom edge where the keyboard meets it.

   Drawn over the app in a portal rather than by hiding the chrome piece by
   piece, so no layout has to know about it. Back (the arrow, the browser's
   own Back, Escape) closes it and the list underneath is exactly as it was:
   useOverlayHistory pushes a history entry on open for that. */

/* The circle with the person's initials, as every chat app draws a contact
   without a photo: two letters from the first two words, and a colour that
   is stable for a name so the same person looks the same on every screen. */
export function initialsOf(name: string): string {
  const words = name.replace(/[↔·]/g, ' ').trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?'
}
export function avatarColour(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h} 45% 48%)`
}

/* THE FACE, WHERE THE SCHOOL HOLDS ONE.

   A teacher answering eight families reads "Nikhil Gupta" and has to work out
   which of the four Nikhils that is; a parent knows "the maths sir" long
   before they know his name. Both are answered by a photograph the school
   already has -- the child's on the staff side, the teacher's on the family
   side -- and by the initials everywhere it does not.

   The image is fetched inline (`?inline=1`), which is the one place the file
   endpoint serves something to look at rather than to save. If it will not
   load, the initials underneath it are what remains. */
export function PersonAvatar({
  name,
  photoId,
  size = 44,
  className,
}: {
  name: string
  photoId?: string | null
  size?: number
  className?: string
}) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size }
  if (photoId && !broken) {
    return (
      <img
        src={`/api/v1/files/${photoId}?inline=1`}
        alt=""
        aria-hidden="true"
        loading="lazy"
        onError={() => setBroken(true)}
        className={cn('shrink-0 rounded-full object-cover', className)}
        style={style}
      />
    )
  }
  return (
    <div
      aria-hidden="true"
      className={cn('grid shrink-0 place-items-center rounded-full font-semibold text-white', className)}
      style={{ ...style, backgroundColor: avatarColour(name), fontSize: Math.round(size * 0.36) }}
    >
      {initialsOf(name)}
    </div>
  )
}

export function ChatScreen({
  open,
  title,
  subtitle,
  photoId,
  onBack,
  actions,
  children,
}: {
  open: boolean
  title: ReactNode
  /** The other party's photograph, when the school holds one. */
  photoId?: string | null
  subtitle?: ReactNode
  onBack: () => void
  /** Buttons for the right of the top bar. */
  actions?: ReactNode
  children: ReactNode
}) {
  const back = useOverlayHistory(open, onBack)

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') back()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, back])

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex flex-col bg-background"
      role="dialog"
      aria-modal="true"
      // The bottom inset belongs to the composer, which is the thing actually
      // sitting on the edge; applying it here too left a white band under it.
      //
      // `bottom` is the keyboard, not zero. This surface is `inset-0`, and on
      // iOS -- Safari and the parent app's WKWebView alike -- the layout
      // viewport does not shrink for the keyboard, so inset-0 kept the
      // composer a keyboard's height below the bottom of the screen: the
      // parent could see the conversation and not the box they were typing
      // into. Lifting the whole surface rather than padding it means the
      // message list shortens too, so the last message stays the thing above
      // the composer instead of being covered by it. --kb is 0px wherever the
      // engine already resized for the keyboard (lib/keyboard.ts).
      style={{ paddingTop: 'env(safe-area-inset-top)', bottom: 'var(--kb, 0px)' }}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-[#f0f2f5] px-1.5 py-1.5 text-[#111b21] sm:px-3">
        <button
          type="button"
          onClick={back}
          aria-label="Back"
          title="Back"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-muted"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        {typeof title === 'string' && <PersonAvatar name={title} photoId={photoId} size={40} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold leading-tight">{title}</div>
          {subtitle && <div className="truncate text-[12.5px] text-[#667781]">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>,
    document.body,
  )
}
