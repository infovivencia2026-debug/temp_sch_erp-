import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Check, Type, X } from 'lucide-react'
import { TYPEFACES, ensureAllFonts, typefaceById } from '@/lib/typefaces'
import { useAppearance } from '@/lib/appearance'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/* Choosing a typeface by looking at it.

   A list of font names is a list of words in the wrong font. The only way to
   pick a face is to see it set, so every card renders the same specimen in the
   face it offers — letters, a grouped figure and a rupee amount, because this
   is a product where most of the type on screen is money and roll numbers, and
   a face that handles Aa beautifully can still put a comma in an ugly place.

   The specimen is the same string in every card on purpose. Comparison needs a
   constant; fifteen different sample sentences would be fifteen different
   questions. */
const SPECIMEN = 'Aa Bb 12,482 · ₹8.42Cr'

export function AppearanceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { appearance, set } = useAppearance()
  const t = useT()

  /* Every face is fetched when the picker opens, not when the app loads.

     Fifteen families is roughly two megabytes; paying that on every visit so a
     dialog most people never open can draw its specimens would be the whole
     cost of this feature landing on the wrong person. */
  useEffect(() => {
    if (open) ensureAllFonts()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[70] grid place-items-start justify-items-center overflow-y-auto
                 bg-black/40 p-4 pt-[6vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('bento.appearance.title')}
    >
      <div
        className="pop-down w-full max-w-[1040px] overflow-hidden rounded-[16px] border bg-popover
                   shadow-[var(--lift-float)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b px-7 py-5">
          <div>
            <h2 className="text-[21px] font-semibold">{t('bento.appearance.title')}</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {t('bento.appearance.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('bento.launcher.close')}
            className="grid size-8 shrink-0 place-items-center rounded-[8px] text-muted-foreground
                       transition-colors hover:bg-accent hover:text-foreground
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-7 py-6">
          <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
            <Type className="size-4 text-muted-foreground" aria-hidden="true" />
            {t('bento.settings.typeface')}
          </h3>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {TYPEFACES.map((face) => {
              const on = appearance.typeface === face.id
              return (
                <button
                  key={face.id}
                  type="button"
                  onClick={() => set('typeface', face.id)}
                  aria-pressed={on}
                  className={cn(
                    `rounded-[12px] border p-4 text-left transition-colors
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`,
                    on ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent/50',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium">{face.name}</span>
                    {on && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
                  </span>
                  {/* The specimen, set in the face it is offering. font-feature
                      settings are left alone: a face's default figures are the
                      ones somebody will actually get. */}
                  <span
                    className="mt-1 block text-[19px] leading-snug"
                    style={{ fontFamily: face.stack }}
                  >
                    {SPECIMEN}
                  </span>
                  <span className="mt-1.5 block text-[12px] text-muted-foreground">
                    {face.note}
                  </span>
                </button>
              )
            })}
          </div>

          <p className="mt-5 text-[12px] text-muted-foreground">
            {t('bento.appearance.font_note', {
              name: typefaceById(appearance.typeface).name,
            })}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
