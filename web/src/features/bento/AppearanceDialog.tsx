import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Check, Palette, Type, X } from 'lucide-react'
import { TYPEFACES, ensureAllFonts, typefaceById } from '@/lib/typefaces'
import {
  useAppearance,
  DENSITIES, CORNERS, TEXT_SIZES, BORDERS, SHADOWS, PATTERNS, CONTRASTS,
  type Density, type Corners, type TextSize, type Borders, type Shadow,
  type Pattern, type Contrast,
} from '@/lib/appearance'
import { useT } from '@/lib/i18n'
import { ColourPanel } from './ColourDialog'
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

/* One row of pills per axis.

   The popover used a vertical list because it was 208px wide and had no other
   option. With the width of a dialog the choices fit on one line each, which
   turns eight settings from a scroll into a page somebody can take in — and
   the current value is visible for all of them at once rather than one at a
   time. */
function Axis<T extends string>({
  label,
  value,
  options,
  onPick,
  name,
}: {
  label: string
  value: T
  options: readonly T[]
  onPick: (v: T) => void
  name: (v: T) => string
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      <p className="w-[104px] shrink-0 text-[13px] font-medium">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onPick(o)}
            aria-pressed={value === o}
            className={cn(
              `rounded-full border px-3 py-1 text-[12.5px] transition-colors
               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`,
              value === o
                ? 'border-primary bg-primary-soft font-medium text-primary'
                : 'hover:bg-accent',
            )}
          >
            {name(o)}
          </button>
        ))}
      </div>
    </div>
  )
}

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
        className="pop-down w-full max-w-[1100px] overflow-hidden rounded-[16px] border bg-popover
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

        <div className="max-h-[76vh] overflow-y-auto px-7 py-6">
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

          <div className="mt-7 divide-y border-t pt-1">
            <Axis<TextSize>
              label={t('bento.settings.text')}
              value={appearance.text}
              options={TEXT_SIZES}
              onPick={(v) => set('text', v)}
              name={(v) => t(`bento.settings.text.${v}`)}
            />
            <Axis<Density>
              label={t('bento.settings.density')}
              value={appearance.density}
              options={DENSITIES}
              onPick={(v) => set('density', v)}
              name={(v) => t(`bento.settings.density.${v}`)}
            />
            <Axis<Corners>
              label={t('bento.settings.corners')}
              value={appearance.corners}
              options={CORNERS}
              onPick={(v) => set('corners', v)}
              name={(v) => t(`bento.settings.corners.${v}`)}
            />
            <Axis<Borders>
              label={t('bento.settings.borders')}
              value={appearance.borders}
              options={BORDERS}
              onPick={(v) => set('borders', v)}
              name={(v) => t(`bento.settings.borders.${v}`)}
            />
            <Axis<Shadow>
              label={t('bento.settings.shadow')}
              value={appearance.shadow}
              options={SHADOWS}
              onPick={(v) => set('shadow', v)}
              name={(v) => t(`bento.settings.shadow.${v}`)}
            />
            <Axis<Pattern>
              label={t('bento.settings.pattern')}
              value={appearance.pattern}
              options={PATTERNS}
              onPick={(v) => set('pattern', v)}
              name={(v) => t(`bento.settings.pattern.${v}`)}
            />
            <Axis<Contrast>
              label={t('bento.settings.contrast')}
              value={appearance.contrast}
              options={CONTRASTS}
              onPick={(v) => set('contrast', v)}
              name={(v) => t(`bento.settings.contrast.${v}`)}
            />
          </div>

          {/* Colour, in the same dialog rather than behind a second door.

              Typeface, density and colour are three answers to one question —
              how should this look — and splitting them across two windows made
              somebody close one to reach the other. */}
          <section className="mt-8 border-t pt-6">
            <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
              <Palette className="size-4 text-muted-foreground" aria-hidden="true" />
              {t('bento.colour.title')}
            </h3>
            <ColourPanel />
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}
