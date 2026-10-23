import { useEffect } from 'react'
import { X, Download } from 'lucide-react'

/* A PROFILE PICTURE, FULL SCREEN (Yajur, 2026-10-15: "should view like
   WhatsApp or Instagram, profile picture"). Chat already opens its photos
   this way (components/Chat.tsx ImageViewer); this is the same look for the
   small round photo on a person's own record -- tap it, see it full size on
   black, tap the black or Escape to leave. */
export function PhotoViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[140] flex flex-col bg-black/95" role="dialog" aria-modal="true" aria-label={name}>
      <div className="flex shrink-0 items-center gap-3 px-3 py-3 text-white">
        <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10">
          <X className="h-5 w-5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[14px]">{name}</span>
        <a href={src.replace('?inline=1', '').replace('&inline=1', '')} download={name} aria-label={`Download ${name}`}
          className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10">
          <Download className="h-5 w-5" />
        </a>
      </div>
      {/* The picture itself takes the rest; a tap on the black closes. */}
      <button type="button" onClick={onClose} aria-label="Close" className="flex min-h-0 flex-1 cursor-default items-center justify-center p-3">
        <img loading="lazy" decoding="async" src={src} alt={name} className="max-h-full max-w-full rounded-lg object-contain" />
      </button>
    </div>
  )
}
