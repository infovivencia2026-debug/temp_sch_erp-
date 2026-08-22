import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, LayoutGrid, Palette, Sliders, Type, X } from 'lucide-react'
import { TYPEFACES, ensureAllFonts, typefaceById } from '@/lib/typefaces'
import {
  useAppearance,
  DENSITIES, CORNERS, TEXT_SIZES, BORDERS, SHADOWS, PATTERNS, CONTRASTS,
  DOCK_SIZES, ICON_SIZES,
  type Density, type Corners, type TextSize, type Borders, type Shadow,
  type Pattern, type Contrast, type DockSize, type IconSize,
} from '@/lib/appearance'
import { useT } from '@/lib/i18n'
import { ColourPanel } from './ColourDialog'
import { cn } from '@/lib/utils'
import { useActiveRole } from '@/lib/catalog'
import { useBoard, useLayout, isRemoved, DIMS } from '@/lib/widgets'

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

/** Toggle panel: lets the user hide individual dock category icons. */
function DockItemsToggle() {
  const role = useActiveRole()
  const { appearance, set } = useAppearance()

  // Collect unique workspace names this role has access to
  const workspaces: string[] = []
  for (const s of role?.sections ?? []) {
    if (!workspaces.includes(s.workspace || 'Other')) {
      workspaces.push(s.workspace || 'Other')
    }
  }
  if (!workspaces.length) return null

  const hidden = new Set(
    (appearance.hiddenDockItems ?? '').split(',').map(s => s.trim()).filter(Boolean)
  )

  const toggle = (name: string) => {
    const next = new Set(hidden)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    set('hiddenDockItems', [...next].join(','))
  }

  return (
    <div className="mt-3">
      <p className="mb-2 text-[12px] text-muted-foreground">Visible categories in dock</p>
      <div className="flex flex-wrap gap-2">
        {workspaces.map(name => {
          const visible = !hidden.has(name)
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              className={cn(
                `rounded-full border px-3 py-1 text-[12px] transition-colors
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`,
                visible
                  ? 'border-primary bg-primary-soft font-medium text-primary'
                  : 'border-dashed text-muted-foreground hover:bg-accent',
              )}
            >
              {visible ? '✓ ' : ''}{name}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function AppearanceDialog({
  open,
  onClose,
  initialTab = 'appearance',
}: {
  open: boolean
  onClose: () => void
  initialTab?: 'appearance' | 'dock' | 'dashboard'
}) {
  const { appearance, set } = useAppearance()
  const [picking, setPicking] = useState(false)
  const onPickingChange = useCallback((v: boolean) => setPicking(v), [])
  const t = useT()
  const dockRef = useRef<HTMLElement>(null)
  const dashRef = useRef<HTMLElement>(null)

  /* Every face is fetched when the picker opens, not when the app loads.

     Fifteen families is roughly two megabytes; paying that on every visit so a
     dialog most people never open can draw its specimens would be the whole
     cost of this feature landing on the wrong person. */
  useEffect(() => {
    if (open) ensureAllFonts()
  }, [open])

  /* Scroll to the requested section when the dialog opens */
  useEffect(() => {
    if (!open) return
    const el = initialTab === 'dock' ? dockRef.current : initialTab === 'dashboard' ? dashRef.current : null
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
  }, [open, initialTab])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // The crosshair swallows the first Escape; the dialog takes the second.
      if (e.key === 'Escape' && !picking) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, picking])

  if (!open) return null

  return createPortal(
    <div
      /* While the crosshair is armed the whole dialog stops intercepting, so a
         click reaches the region underneath instead of the backdrop. Fading
         rather than closing: closing would lose the channel and colour already
         chosen, and the point of aiming is to come back and keep working. */
      className={cn(
        'fixed inset-0 z-[70] grid place-items-start justify-items-center overflow-y-auto p-4 pt-[6vh]',
        picking ? 'pointer-events-none bg-transparent' : 'bg-black/40',
      )}
      onClick={picking ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('bento.appearance.title')}
    >
      <div
        data-appearance-dialog=""
        className={cn(
          `pop-down w-full max-w-[1100px] overflow-hidden rounded-[16px] border bg-popover
           shadow-[var(--lift-float)]`,
          // Still clickable while aiming, so the dialog can be used to cancel.
          picking && 'pointer-events-auto opacity-25',
        )}
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
            <ColourPanel onPickingChange={onPickingChange} />
          </section>

          {/* Dock settings — size and per-category visibility */}
          <section ref={dockRef} className="mt-8 border-t pt-6">
            <h3 className="mb-4 flex items-center gap-2 text-[13px] font-semibold">
              <LayoutGrid className="size-4 text-muted-foreground" aria-hidden="true" />
              Dock
            </h3>
            <div className="divide-y border-t">
              <Axis<DockSize>
                label="Bar size"
                value={appearance.dockSize}
                options={DOCK_SIZES}
                onPick={(v) => set('dockSize', v)}
                name={(v) => ({ compact: 'Compact', default: 'Default', large: 'Large' }[v])}
              />
              <Axis<IconSize>
                label="Icon size"
                value={appearance.iconSize}
                options={ICON_SIZES}
                onPick={(v) => set('iconSize', v)}
                name={(v) => ({ small: 'Small', default: 'Default', large: 'Large' }[v])}
              />
            </div>
            <DockItemsToggle />
          </section>

          {/* Dashboard widget shortcuts — focus mode cells */}
          <section ref={dashRef} className="mt-8 border-t pt-6">
            <h3 className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
              <Sliders className="size-4 text-muted-foreground" aria-hidden="true" />
              Dashboard Widgets
            </h3>
            <p className="mb-4 text-[12px] text-muted-foreground">
              Add, remove, resize and reorder the cards on this dashboard.
            </p>
            <DashboardWidgets onArrange={onClose} />
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* Settings' half of the arranger.

   The board itself is where sizing and dragging happen — you size a card by
   looking at it. What belongs HERE is everything you cannot do from the board
   once a card is gone from it: seeing the full roster of what this dashboard
   can show, putting something back, and starting over.

   It reads the board the layer publishes rather than importing any dashboard,
   so it stays correct for the six dashboards that have widgets and honest on
   the screens that do not. */
function DashboardWidgets({ onArrange }: { onArrange: () => void }) {
  const { dashboard, widgets, setArranging } = useBoard()
  const { layout, place, remove, reset } = useLayout(dashboard ?? 'none')

  if (!dashboard || widgets.length === 0) {
    return (
      <div className="rounded-[10px] border border-dashed p-4 text-[12.5px] text-muted-foreground">
        This screen has no arrangeable dashboard. Open one of the dashboards — the
        principal, finance, faculty, parent or student home — and these controls
        will list its cards.
      </div>
    )
  }

  const arranged = layout.placed.length > 0 || layout.removed.length > 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setArranging(true)
            // The board is the thing being arranged, so the dialog covering it
            // gets out of the way rather than asking to be dismissed.
            onArrange()
          }}
          className="rounded-full border border-primary bg-primary-soft px-3 py-1.5 text-[12.5px]
                     text-primary transition-colors focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-ring"
        >
          Arrange on the dashboard
        </button>
        {arranged && (
          <button
            type="button"
            onClick={reset}
            className="rounded-full border px-3 py-1.5 text-[12.5px] text-muted-foreground
                       transition-colors hover:bg-accent hover:text-foreground"
          >
            Reset to default
          </button>
        )}
      </div>

      <ul className="divide-y rounded-[10px] border">
        {widgets.map((w) => {
          const off = isRemoved(layout, w.id)
          return (
            <li key={w.id} className="flex items-center gap-3 px-3 py-2">
              <span className={cn('flex-1 truncate text-[12.5px]', off && 'text-muted-foreground line-through')}>
                {w.label}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {off ? '—' : `${w.w}×${w.h}`}
              </span>
              <button
                type="button"
                onClick={() => (off ? place(w.id, DIMS[w.size].w, DIMS[w.size].h) : remove(w.id))}
                className="shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors hover:bg-accent"
              >
                {off ? 'Add' : 'Remove'}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
