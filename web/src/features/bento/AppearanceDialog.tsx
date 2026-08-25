import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check, LayoutGrid, LogOut, Maximize2, Minimize2, Minus, Palette, Plus,
  Sliders, Type, UserCircle, X, Contrast as RotateCcw,
} from 'lucide-react'
import { resetAppearance } from '@/lib/appearance'
import { TYPEFACES, ensureAllFonts, typefaceById } from '@/lib/typefaces'
import {
  useAppearance,
  CONTRASTS, DOCK_SIZES, ICON_SIZES, SCALE_RANGE,
  type Contrast, type DockSize, type IconSize, type Scales,
} from '@/lib/appearance'
import { useT } from '@/lib/i18n'
import {
  ColourPanel,
  INK, EDGE, TRACK, WASH, RING, CHOSEN, SLIDER, SEAM, SURFACE,
} from './ColourDialog'
import { cn } from '@/lib/utils'
import { useActiveRole } from '@/lib/catalog'
import { useSkin, SKINS, type Skin } from '@/lib/skin'
// Aliased: '@/lib/widgets' exports a useLayout of its own, about where the
// dashboard cards sit. This one is the frame -- sidebar or focus.
import { useLayout as useFrameLayout, LAYOUTS, type Layout } from '@/lib/layout'
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
/** A continuous axis: a slider, and the multiplier it is at.

    These five are not four choices somebody else made — they are a number, and
    the control now says so. The readout is a percentage rather than a raw
    multiplier because 100% gives "back to how it shipped" an obvious target,
    and the button beside it goes straight there.

    Committing on every input event rather than on release is deliberate: the
    whole point of a continuous scale is watching the page answer as you drag
    it, and the write is one custom property and one localStorage line. */
const STEP =
  'grid size-7 shrink-0 place-items-center rounded-full border transition-colors ' +
  'hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function Scale({ axis, label }: { axis: keyof Scales; label: string }) {
  const { appearance, setScale } = useAppearance()
  const r = SCALE_RANGE[axis]
  const v = appearance.scales[axis]

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      <p className={cn('w-[104px] shrink-0 text-[13px] font-medium', INK)}>{label}</p>
      <div className="flex min-w-[240px] flex-1 items-center gap-3">
        {/* Minus and plus either side of the track.

            A slider is good at "somewhere around here" and bad at "one step
            more" — the thumb is 16px and a 1% change is a pixel of travel. The
            buttons give the same axis a precise gesture without taking the coarse
            one away, which is why they flank the track rather than replace it. 5%
            a press: visible, and not so large that three presses cross the whole
            range. */}
        <button
          type="button"
          onClick={() => setScale(axis, Math.max(r.min, Math.round((v - 0.05) * 100) / 100))}
          disabled={v <= r.min}
          aria-label={`${label} smaller`}
          className={cn(STEP, INK)}
        >
          <Minus className="size-3.5" aria-hidden="true" />
        </button>
        <input
          type="range"
          min={r.min}
          max={r.max}
          step={r.step}
          value={v}
          aria-label={label}
          onChange={(e) => setScale(axis, Number(e.target.value))}
          /* The track was `bg-border`, which is the palette's hairline: it
             measured 1.21-1.33:1 against the card in all four, a slider you
             cannot find. Mixed from the ink instead, with the two-tone
             handle. */
          className={cn('h-1.5 flex-1 cursor-pointer appearance-none rounded-full', TRACK, SLIDER, RING)}
        />
        <button
          type="button"
          onClick={() => setScale(axis, Math.min(r.max, Math.round((v + 0.05) * 100) / 100))}
          disabled={v >= r.max}
          aria-label={`${label} bigger`}
          className={cn(STEP, INK)}
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
        <span className={cn('w-[52px] shrink-0 text-right text-[12.5px] font-medium tabular-nums', INK)}>
          {Math.round(v * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setScale(axis, 1)}
          disabled={v === 1}
          aria-label={`Reset ${label}`}
          className={cn(
            'shrink-0 rounded-full border px-2 py-0.5 text-[11px]',
            'transition-colors disabled:opacity-30', EDGE, WASH, RING, INK,
          )}
        >
          100%
        </button>
      </div>
    </div>
  )
}

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
  /* A scale, not a row of buttons.

     Every one of these axes is ORDERED — smaller to larger, tighter to looser,
     flatter to deeper — and a row of named pills asked people to read four or
     five labels to express "a bit more". It also grew the dialog sideways in
     proportion to how many steps an axis happened to have, so the axis with
     the most options looked like the most important one.

     Minus and plus need no reading, and the current step is stated between
     them, so nothing is hidden — only the four you did not choose. */
  const at = options.indexOf(value)
  const step = (d: number) => {
    const next = options[Math.min(options.length - 1, Math.max(0, at + d))]
    if (next && next !== value) onPick(next)
  }
  const arrow = cn(
    'grid size-7 shrink-0 place-items-center rounded-full border transition-colors',
    'disabled:opacity-30 disabled:hover:bg-transparent',
    EDGE, WASH, RING, INK,
  )

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      <p className={cn('w-[104px] shrink-0 text-[13px] font-medium', INK)}>{label}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={at <= 0}
          aria-label={`${label} down`}
          className={arrow}
        >
          <Minus className="size-3.5" aria-hidden="true" />
        </button>

        {/* Fixed width so the two arrows do not shuffle sideways as the word
            between them changes length. */}
        <span
          role="status"
          aria-live="polite"
          className={cn('w-[104px] text-center text-[12.5px] font-medium', INK)}
        >
          {name(value)}
        </span>

        <button
          type="button"
          onClick={() => step(1)}
          disabled={at >= options.length - 1}
          aria-label={`${label} up`}
          className={arrow}
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </button>

        {/* The position on the scale, which the words alone no longer give. */}
        <span aria-hidden="true" className="flex items-center gap-1">
          {options.map((o) => (
            <span
              key={o}
              className={cn(
                'h-1 rounded-full transition-all',
                /* Both marks are ink now: the current step solid, the rest at
                   the track's weight. They were the accent and the hairline,
                   and on the default palette that is a pale green pip on
                   paper beside pips measuring 1.29:1. */
                o === value ? 'w-4 bg-[var(--bento-ink)]' : cn('w-1.5', TRACK),
              )}
            />
          ))}
        </span>
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
      <p className={cn('mb-2 text-[12px]', INK)}>Visible categories in dock</p>
      <div className="flex flex-wrap gap-2">
        {workspaces.map(name => {
          const visible = !hidden.has(name)
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              className={cn(
                'rounded-full border px-3 py-1 text-[12px] transition-colors',
                RING,
                visible
                  ? `${CHOSEN} font-medium`
                  : cn('border-dashed', EDGE, WASH, INK),
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
  const { skin, setSkin } = useSkin()
  const { layout: frame, setLayout: setFrame } = useFrameLayout()
  const [picking, setPicking] = useState(false)
  const onPickingChange = useCallback((v: boolean) => setPicking(v), [])
  const t = useT()
  /* One page at a time, not one long scroll.

     Everything lived on a single 76vh scroller: typeface specimens, seven
     appearance axes, the colour wheel, dock sizing and widget controls. Finding
     the dock's icon size meant scrolling past fifteen font previews, and the
     panel was tall enough that centring it pushed its own header off the top of
     the screen.

     The menu items that open this dialog already say which part somebody
     wanted, so that choice seeds the page rather than being thrown away and
     replaced with a scroll-into-view. */
  type Tab = 'appearance' | 'colour' | 'dock' | 'dashboard'
  const [tab, setTab] = useState<Tab>(initialTab === 'dock' ? 'dock' : initialTab === 'dashboard' ? 'dashboard' : 'appearance')
  useEffect(() => {
    if (!open) return
    setTab(initialTab === 'dock' ? 'dock' : initialTab === 'dashboard' ? 'dashboard' : 'appearance')
  }, [open, initialTab])

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
  /* While this is open, the dock is lifted above it and the panel keeps clear
     of the bottom of the screen.

     Dock Settings changes the dock, and the dialog was drawn over the top of
     it — so the one control you were adjusting was the one thing you could not
     see change. Marking the root rather than passing a prop keeps the dock
     ignorant of this dialog's existence. */
  useEffect(() => {
    if (!open) {
      delete document.documentElement.dataset.appearanceOpen
      return
    }
    document.documentElement.dataset.appearanceOpen = 'true'
    return () => {
      delete document.documentElement.dataset.appearanceOpen
    }
  }, [open])

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
        'appearance-overlay fixed inset-0 z-[70] grid place-items-center overflow-y-auto p-4 sm:p-6',
        picking ? 'pointer-events-none bg-transparent' : 'bg-black/40',
      )}
      onClick={picking ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('bento.appearance.title')}
    >
      <div
        data-appearance-dialog=""
        /* The panel states its own pair, and its edge is a boundary rather
           than a seam.

           `bg-popover` with no ink beside it left the words inheriting from
           <body>; the outer `border` was `--bento-line` at 1.38:1, which is
           not enough to separate a floating dialog from the page behind it. */
        className={cn(
          /* A HEIGHT, not a maximum, and `max-h-full` under it.

             Two things came out of `max-h`. The dialog resized every time
             somebody moved between its four pages — Colour is a wheel and two
             sliders, Dashboard is a list — so the tabs moved under the cursor
             and the whole panel jumped on each switch. And the panel was 88vh
             plus the dock's 132px of clearance, which is taller than the
             window: a centred grid item that overflows its container overflows
             it at BOTH ends, so the top of the dialog, its title and its tabs
             went off the top of the screen with no way to scroll back up.

             Fixed height fixes the first. `max-h-full` fixes the second by
             letting the panel give way to the clearance, which the overlay now
             carries as padding rather than the panel as a margin. */
          `appearance-panel pop-down flex h-[min(88vh,760px)] max-h-full w-full max-w-[980px]
           flex-col overflow-hidden rounded-[16px] border
           shadow-[var(--lift-float)]`,
          SURFACE, EDGE,
          // Still clickable while aiming, so the dialog can be used to cancel.
          picking && 'pointer-events-auto opacity-25',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={cn('flex items-start justify-between gap-4 border-b px-7 py-5', SEAM)}>
          <div>
            <h2 className={cn('text-[21px] font-semibold', INK)}>{t('bento.appearance.title')}</h2>
            <p className={cn('mt-0.5 text-[13px]', INK)}>
              {t('bento.appearance.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('bento.launcher.close')}
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-[8px] transition-colors',
              INK, WASH, RING,
            )}
          >
            <X className="size-4" />
          </button>
        </header>

          {/* The four pages, named. A dialog that opens on one of them with no
              way to see the others is a dialog people think is broken. */}
          <nav className={cn('flex shrink-0 gap-1 border-b px-7 pt-3', SEAM)} aria-label="Settings sections">
            {([
              ['appearance', t('bento.appearance.title')],
              ['colour', 'Colour'],
              ['dock', 'Dock'],
              ['dashboard', 'Dashboard'],
            ] as [Tab, string][]).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id}
                className={cn(
                  'rounded-t-[8px] border-b-2 px-3 py-2 text-[13px] transition-colors',
                  tab === id
                    ? 'border-primary font-medium text-foreground'
                    : cn('border-transparent', INK, WASH),
                )}
              >
                {label}
              </button>
            ))}
          </nav>

        {/* `.scroll-y` draws the bar rather than waiting for the platform to
            fade one in. A dialog with four pages behind its tabs — one of them
            fifteen typeface cards — has to say on its first paint that there is
            more below the fold. See index.css. */}
        <div className="scroll-y min-h-0 flex-1 px-7 py-6">
          {tab === 'appearance' && (<div>
          <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
            <Type className="size-4" aria-hidden="true" />
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
                  /* CHOSEN IS AN OUTLINE HERE, NOT A FILL.

                     The card's whole job is to show a face set in itself, so
                     it cannot be inverted the way the other chosen states in
                     these dialogs are — the specimen has to stay on the paper
                     it will be read on. So the ink does the marking from the
                     edge instead.

                     It was `border-primary ring-primary`, which the stylesheet
                     resolves to the mint accent: 1.29:1 against the card, so
                     the one card in fifteen that is selected was marked with a
                     boundary you cannot see. The ink is 21:1 in every palette,
                     and the check beside the name says the same thing a second
                     way for anybody who cannot use the outline. */
                  className={cn(
                    'rounded-[12px] border p-4 text-left transition-colors',
                    RING, INK,
                    on
                      ? '!border-[var(--bento-ink)] ring-1 ring-[var(--bento-ink)]'
                      : cn(EDGE, WASH),
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium">{face.name}</span>
                    {on && <Check className="size-4 shrink-0" aria-hidden="true" />}
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
                  <span className={cn('mt-1.5 block text-[12px]', INK)}>
                    {face.note}
                  </span>
                </button>
              )
            })}
          </div>

          <p className={cn('mt-5 text-[12px]', INK)}>
            {t('bento.appearance.font_note', {
              name: typefaceById(appearance.typeface).name,
            })}
          </p>

          <div className={cn('mt-7 divide-y border-t pt-1', SEAM, 'divide-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]')}>
            <Scale axis="text" label={t('bento.settings.text')} />
            <Scale axis="density" label={t('bento.settings.density')} />
            <Scale axis="corners" label={t('bento.settings.corners')} />
            <Scale axis="borders" label={t('bento.settings.borders')} />
            <Scale axis="shadow" label={t('bento.settings.shadow')} />
            <Axis<Contrast>
              label={t('bento.settings.contrast')}
              value={appearance.contrast}
              options={CONTRASTS}
              onPick={(v) => set('contrast', v)}
              name={(v) => t(`bento.settings.contrast.${v}`)}
            />
            {/* The frame, which used to be a pane of its own behind the
                settings menu.

                It was the only thing left in that pane once the theme rows
                went, so the menu carried a row called Appearance that led to a
                single choice — and a second row, also called Appearance, that
                led here. Two identical labels going to different places is not
                a hierarchy, it is a coin toss. Whether the screen is framed or
                bare is an answer to the same question the axes above answer,
                so it is asked in the same place. */}
            {/* Layout, which used to be a drill-down pane in the settings
                menu with its chosen value printed on the row.

                It was the fourth separate door into this one dialog: Layout
                opened a pane, and Appearance, Dock Settings and Dashboard
                Widgets each opened a different tab of this window. Four
                gateways to one place is not a menu, it is a guessing game
                about which word means the thing you want. Sidebar-or-focus is
                an answer to the same question every axis below it answers --
                how should this look -- so it is asked here, and the menu now
                has one row. */}
            <Axis<Layout>
              label={t('bento.settings.layout')}
              value={frame}
              options={LAYOUTS}
              onPick={setFrame}
              name={(v) => t(`bento.settings.layout.${v}`)}
            />
            <Axis<Skin>
              label={t('bento.settings.frame')}
              value={skin}
              options={SKINS}
              onPick={setSkin}
              name={(v) => t(`bento.settings.skin.${v}`)}
            />
          </div>

          {/* Colour, in the same dialog rather than behind a second door.

              Typeface, density and colour are three answers to one question —
              how should this look — and splitting them across two windows made
              somebody close one to reach the other. */}
          </div>)}
          {tab === 'colour' && (
          <section className={cn('mt-8 border-t pt-6', SEAM)}>
            <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
              <Palette className="size-4" aria-hidden="true" />
              {t('bento.colour.title')}
            </h3>
            <ColourPanel onPickingChange={onPickingChange} />
          </section>
          )}
          {tab === 'dock' && (
          <section ref={dockRef} className={cn('mt-8 border-t pt-6', SEAM)}>
            <h3 className="mb-4 flex items-center gap-2 text-[13px] font-semibold">
              <LayoutGrid className="size-4" aria-hidden="true" />
              Dock
            </h3>
            <div className={cn(
              'divide-y border-t', SEAM,
              'divide-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]',
            )}>
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
          )}
          {tab === 'dashboard' && (
          <section ref={dashRef} className={cn('mt-8 border-t pt-6', SEAM)}>
            <h3 className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
              <Sliders className="size-4" aria-hidden="true" />
              Dashboard Widgets
            </h3>
            <p className={cn('mb-4 text-[12px]', INK)}>
              Add, remove, resize and reorder the cards on this dashboard.
            </p>
            <DashboardWidgets onArrange={onClose} />
          </section>
          )}
        </div>

        <DialogActions onClose={onClose} />
      </div>
    </div>,
    document.body,
  )
}

/* The four things that were left in the settings menu.

   Pressing the cog used to open a popover, and every substantive row in it
   opened this dialog. That made the menu a waiting room: two surfaces where
   one was wanted, and the answer to "where do I change the font" was one press
   further away than it looked.

   The cog opens this window directly now, so these came with it. They sit in a
   footer rather than becoming a fifth tab because they are not a category of
   preference -- they are three one-way doors and a switch, and a tab implies a
   page of settings behind it. In the footer they are reachable from every tab,
   which is better than where they were.

   Full screen and Reset appearance are about the window and how it looks, so
   they lead. My profile and Sign out are the account, so they are pushed to
   the far end -- nobody signs out by accident from across a dialog. */
function DialogActions({ onClose }: { onClose: () => void }) {
  const t = useT()

  /* Full screen, tracked rather than assumed.

     The control has to say which way it goes, and the state can change without
     it -- Escape and F11 both leave full screen without touching this dialog --
     so it listens rather than remembering what it last asked for. */
  const [full, setFull] = useState(
    () => typeof document !== 'undefined' && !!document.fullscreenElement,
  )
  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFull = () => {
    /* Both calls reject rather than throw -- a browser may refuse full screen
       when the gesture is not trusted -- so the rejection is swallowed and the
       listener above keeps the label truthful either way.

       The dialog closes on the way in: going full screen to look at the
       dashboard and finding a settings window over it is not what anybody
       meant by the button. */
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else {
      void document.documentElement.requestFullscreen().catch(() => {})
      onClose()
    }
  }

  const ACTION = cn(
    'flex items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-[12.5px] transition-colors',
    INK, WASH, RING,
  )

  return (
    <footer className={cn('flex shrink-0 flex-wrap items-center gap-1 border-t px-5 py-2.5', SEAM)}>
      <button type="button" onClick={toggleFull} className={ACTION}>
        {full
          ? <Minimize2 className="size-4 shrink-0" aria-hidden="true" />
          : <Maximize2 className="size-4 shrink-0" aria-hidden="true" />}
        {t(full ? 'bento.settings.fullscreen.exit' : 'bento.settings.fullscreen')}
      </button>

      {/* A way back. Enough axes live in this dialog at once that somebody
          ends up somewhere they cannot retrace, and a settings window with no
          exit from itself is a trap. */}
      <button type="button" onClick={() => resetAppearance()} className={ACTION}>
        <RotateCcw className="size-4 shrink-0" aria-hidden="true" />
        {t('bento.settings.reset')}
      </button>

      <span className="flex-1" />

      {/* /account sits outside the catalogue on purpose -- everybody has a
          name, a password and contact details whatever their role -- which
          once meant the only way in was to type the URL. */}
      <a href="/account" className={ACTION}>
        <UserCircle className="size-4 shrink-0" aria-hidden="true" />
        {t('bento.settings.account')}
      </a>
      <a href="/logout" className={ACTION}>
        <LogOut className="size-4 shrink-0" aria-hidden="true" />
        {t('bento.settings.signout')}
      </a>
    </footer>
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
      <div className={cn('rounded-[10px] border border-dashed p-4 text-[12.5px]', EDGE, INK)}>
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
          /* The accent on its own tint, which is the pairing that does not
             work. `text-primary` resolves to the mint darkened toward the ink
             and `bg-primary-soft` to the mint's own tint — and under the
             default palette those are the same lime, so the label measured
             2.76:1 on its own button. Inverted instead, the way every other
             chosen state in these dialogs is: ink on card, 21:1 in every
             palette, and no coloured word left on the surface. */
          className={cn(
            'rounded-full border px-3 py-1.5 text-[12.5px] transition-colors',
            CHOSEN, RING,
          )}
        >
          Arrange on the dashboard
        </button>
        {arranged && (
          <button
            type="button"
            onClick={reset}
            className={cn(
              'rounded-full border px-3 py-1.5 text-[12.5px] transition-colors',
              EDGE, WASH, RING, INK,
            )}
          >
            Reset to default
          </button>
        )}
      </div>

      <ul className={cn(
        'divide-y rounded-[10px] border', EDGE,
        'divide-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]',
      )}>
        {widgets.map((w) => {
          const off = isRemoved(layout, w.id)
          return (
            <li key={w.id} className="flex items-center gap-3 px-3 py-2">
              {/* "Off the board" is carried by the strike-through, which does
                  not cost the label any contrast. It used to also drop to the
                  muted tone, and a second, weaker signal for a state the first
                  one already states is a row that is harder to read for
                  nothing. */}
              <span className={cn('flex-1 truncate text-[12.5px]', INK, off && 'line-through')}>
                {w.label}
              </span>
              <span className={cn('shrink-0 text-[11px] tabular-nums', INK)}>
                {off ? '—' : `${w.w}×${w.h}`}
              </span>
              <button
                type="button"
                onClick={() => (off ? place(w.id, DIMS[w.size].w, DIMS[w.size].h) : remove(w.id))}
                className={cn(
                  'shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                  EDGE, WASH, RING, INK,
                )}
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
