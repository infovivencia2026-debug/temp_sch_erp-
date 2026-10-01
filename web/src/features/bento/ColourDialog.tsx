import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Crosshair, Plus, RotateCcw, X } from 'lucide-react'
import {
  usePaint, usePalettes, savePalette, deletePalette, applyPalette, resetPaint,
  PICKABLE_REGIONS, CHANNELS, BUILT_IN_PALETTES, currentPalette,
  type Region, type Channel, type Hsl,
} from '@/lib/paint'
import { applyPersonality } from '@/lib/personality'
import { useT } from '@/lib/i18n'
import { useLayout } from '@/lib/layout'
import { cn } from '@/lib/utils'
import { useAppearance, GLOWS, type Glow } from '@/lib/appearance'

/* The coloured glow under cards and figures, one setting for the whole app.
   Subtle is the default; Off keeps plain shadows; Strong is the full bloom. */
function GlowRow() {
  const { appearance, set } = useAppearance()
  const label: Record<Glow, string> = { off: 'Off', faint: 'Faint', subtle: 'Subtle', medium: 'Medium', strong: 'Strong' }
  return (
    <div className="px-5 pt-4">
      <p className={cn('mb-2 text-[11px] font-semibold uppercase tracking-[0.06em]', INK)}>Glow</p>
      <div role="radiogroup" aria-label="Glow" className="flex gap-1 rounded-full bg-[hsl(var(--muted))] p-1">
        {GLOWS.map((g) => (
          <button key={g} type="button" role="radio" aria-checked={appearance.glow === g}
            onClick={() => set('glow', g)}
            className={cn('min-h-9 flex-1 rounded-full px-3 text-[13px] font-medium transition-colors',
              appearance.glow === g ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            {label[g]}
          </button>
        ))}
      </div>
    </div>
  )
}

/* Painting the interface, region by region.

   The wheel is hue by angle and saturation by radius, with lightness on its
   own slider beneath. That split is not decoration: on a wheel that encodes
   lightness as well, every dark colour crowds into the middle and becomes
   unpickable, which is why colour pickers have looked like this since
   Photoshop 3.

   The wheel is drawn on a canvas rather than assembled from gradients. A
   conic-gradient plus a radial mask gets close and bands visibly on the
   diagonals; per-pixel HSL does not, and it is thirty lines. */

const SIZE = 220

export * from './bento-ink'
import { INK,EDGE,WASH,RING,CHOSEN,SELECTED,SEAM,SLIDER,inkOn } from './bento-ink'

/* The slider thumb is dressed in bento-theme.css (`.bento-slider`), in the
   accent. A <style> element here once did it, and nothing ever mounted it,
   so every slider drew the browser's own blue. */

/* Exported so the dashboard arranger can offer the SAME wheel rather than a
   second one. Two colour pickers in one product is how they drift apart. */
export function WheelCanvas({
  value,
  onPick,
}: {
  value: Hsl
  onPick: (h: number, s: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = SIZE * dpr
    cv.height = SIZE * dpr
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(cv.width, cv.height)
    const r = cv.width / 2

    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const dx = x - r
        const dy = y - r
        const dist = Math.sqrt(dx * dx + dy * dy)
        const i = (y * cv.width + x) * 4
        if (dist > r) {
          img.data[i + 3] = 0
          continue
        }
        // Angle from 12 o'clock, clockwise, so red sits at the top the way
        // every other wheel a person has used puts it.
        let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
        if (deg < 0) deg += 360
        const [rr, gg, bb] = hslToRgb(deg, (dist / r) * 100, 50)
        img.data[i] = rr
        img.data[i + 1] = gg
        img.data[i + 2] = bb
        // Feather the last pixel so the rim is not a staircase.
        img.data[i + 3] = dist > r - dpr ? 255 * (r - dist) / dpr : 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [])

  /* THE WHEEL FOLLOWS THE FINGER.

     It listened for a click and nothing else, and a click is delivered on
     RELEASE. So the way everybody uses a colour wheel -- press somewhere and
     drag until the colour is right -- did nothing at all until you let go, at
     which point the colour jumped to wherever your finger happened to be. No
     live feedback, no way to hunt for a shade, and on a touchscreen a drag
     that scrolled the dialog instead.

     Pointer events with capture: the wheel keeps receiving the drag even when
     it leaves the canvas, which is what makes the rim reachable -- the last
     few degrees of saturation are exactly where the cursor slips outside. */
  const at = (clientX: number, clientY: number) => {
    const cv = ref.current
    if (!cv) return
    const box = cv.getBoundingClientRect()
    const dx = clientX - box.left - box.width / 2
    const dy = clientY - box.top - box.height / 2
    const r = box.width / 2
    // Clamped rather than ignored: dragging past the rim should hold full
    // saturation at that hue, not stop responding.
    const dist = Math.min(Math.sqrt(dx * dx + dy * dy), r)
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
    if (deg < 0) deg += 360
    onPick(deg, (dist / r) * 100)
  }

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Stops the browser treating the drag as a scroll or a text selection,
    // which is what made this feel broken on a touchscreen.
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    at(e.clientX, e.clientY)
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    at(e.clientX, e.clientY)
  }

  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // The marker's position is derived from the value, not remembered from the
  // click — so it is still right after a palette is applied or the dialog is
  // reopened.
  const rad = ((value.h - 90) * Math.PI) / 180
  /* As PERCENTAGES, not pixels. The wheel is drawn at a fixed internal
     resolution but shown at whatever width the panel allows -- 220px is wider
     than a narrow tab, and a fixed-pixel marker (and a fixed-pixel box) spilled
     the wheel out of its container. A percentage tracks the rendered size, so
     the marker stays on the point it names however small the wheel is drawn. */
  const mxPct = (0.5 + Math.cos(rad) * (value.s / 100) * 0.5) * 100
  const myPct = (0.5 + Math.sin(rad) * (value.s / 100) * 0.5) * 100

  return (
    <div
      className="relative mx-auto"
      style={{ width: SIZE, maxWidth: '100%', aspectRatio: '1 / 1' }}
    >
      <canvas
        ref={ref}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        // touch-none for the same reason as preventDefault above: without it
        // the browser claims the gesture as a scroll before the wheel sees it.
        style={{ width: '100%', height: '100%', touchAction: 'none' }}
        className="cursor-crosshair rounded-full shadow-[var(--lift-panel)]"
      />
      {/* Two-tone, because this marker sits on every hue there is and a single
          ring is invisible against one of them. The card and the ink are the
          one pair a palette guarantees contrasts, so whichever the wheel is
          under the marker, one of the two rings shows. It was `border-white`:
          a named colour, and identical in all four palettes. */}
      {/* WHITE AND BLACK, NOT THE THEME'S TWO COLOURS.

          The marker was drawn in --bento-card and --bento-ink, which are
          whatever the palette makes them -- and inside a card that has been
          given a colour they are that colour and its ink. So the one control
          that has to stay visible against every hue on the wheel was painted
          in a pair that can land on top of the hue it is sitting on.

          Plain white with a black ring outside it and a black ring inside:
          three edges, of which at least two contrast with anything the wheel
          can show underneath. It also carries the chosen colour in its
          middle, so the marker says what it is pointing at.

          Drawn a little larger, because at 16px sitting on the rim it was
          half off the wheel and read as clipped rather than as placed. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute size-[18px] -translate-x-1/2 -translate-y-1/2
                   rounded-full border-[3px] border-white"
        style={{
          left: `${mxPct}%`,
          top: `${myPct}%`,
          background: `hsl(${value.h} ${value.s}% ${value.l}%)`,
          boxShadow: '0 0 0 1px rgba(0,0,0,.85), inset 0 0 0 1px rgba(0,0,0,.35)',
        }}
      />
    </div>
  )
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100
  const L = l / 100
  const c = (1 - Math.abs(2 * L - 1)) * S
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = L - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

const DEFAULT_PICK: Hsl = { h: 262, s: 70, l: 24 }

/** The named accents, kept as data so the swatch and the wheel agree. */
const PRESETS: { id: 'blue' | 'mint' | 'violet' | 'amber' | 'rose'; hsl: Hsl }[] = [
  { id: 'blue', hsl: { h: 217, s: 91, l: 60 } },
  { id: 'mint', hsl: { h: 163, s: 70, l: 32 } },
  { id: 'violet', hsl: { h: 262, s: 72, l: 52 } },
  { id: 'amber', hsl: { h: 32, s: 88, l: 40 } },
  { id: 'rose', hsl: { h: 344, s: 76, l: 46 } },
]

/** The named colours each channel opens on, before the wheel. A few quiet
    grounds and a few inks: the shades people ask for by name. */
const SWATCHES: Record<'bg' | 'text', { name: string; hsl: Hsl }[]> = {
  bg: [
    { name: 'Paper', hsl: { h: 0, s: 0, l: 100 } },
    { name: 'Mist', hsl: { h: 210, s: 20, l: 96 } },
    { name: 'Cream', hsl: { h: 42, s: 60, l: 94 } },
    { name: 'Sage', hsl: { h: 140, s: 22, l: 92 } },
    { name: 'Sky', hsl: { h: 205, s: 60, l: 94 } },
    { name: 'Blush', hsl: { h: 345, s: 50, l: 95 } },
    { name: 'Slate', hsl: { h: 215, s: 20, l: 20 } },
    { name: 'Night', hsl: { h: 225, s: 25, l: 9 } },
  ],
  text: [
    { name: 'Ink', hsl: { h: 0, s: 0, l: 9 } },
    { name: 'Graphite', hsl: { h: 215, s: 15, l: 25 } },
    { name: 'Navy', hsl: { h: 220, s: 60, l: 22 } },
    { name: 'Forest', hsl: { h: 150, s: 45, l: 20 } },
    { name: 'Plum', hsl: { h: 290, s: 40, l: 25 } },
    { name: 'Cloud', hsl: { h: 210, s: 20, l: 88 } },
    { name: 'White', hsl: { h: 0, s: 0, l: 100 } },
  ],
}

/** A painted value is the swatch when all three numbers agree. */
function same(a: Hsl | undefined, b: Hsl) {
  return !!a && Math.round(a.h) === b.h && Math.round(a.s) === b.s && Math.round(a.l) === b.l
}

/* The colour engine, without a window of its own.

   It was a second dialog beside Appearance, which meant two doors in the menu
   to two halves of one question — how should this look. It is a section now,
   and ColourDialog is gone rather than kept as a wrapper nobody opens. */
/* What was clicked, as an element the picker offers.

   Only the work area, the bars and the dock carry data-paint; a card is many
   elements and a button is hundreds, so neither is tagged. The picker reads
   them off the thing under the pointer instead: a button first, because a
   button sits inside a card and the nearer answer is the one meant, then a
   card or a bento cell, then the tagged region behind it. A status-tinted
   cell names its tint. */
function regionUnder(target: HTMLElement | null): Region | undefined {
  if (!target) return undefined
  if (target.closest('.btn, button, [role="button"]')) return 'buttons'
  const tone = target.closest<HTMLElement>('[data-tone]')?.dataset.tone
  if (tone === 'critical' || tone === 'warning' || tone === 'success') return tone
  if (target.closest('.card, .bento-cell, .bento-widget')) return 'cards'
  const r = target.closest<HTMLElement>('[data-paint]')?.dataset.paint
  return r && (PICKABLE_REGIONS as readonly string[]).includes(r) ? (r as Region) : undefined
}

export function ColourPanel({
  onPickingChange,
}: {
  /* Told upward, because the panel cannot get out of its own way.

     It lives inside a modal whose backdrop covers the page, so while the
     crosshair is armed every click lands on that backdrop and closes the
     dialog. The panel can fade itself and still be unreachable; only the
     dialog can stop intercepting. */
  onPickingChange?: (picking: boolean) => void
} = {}) {
  const { paint, set } = usePaint()
  const palettes = usePalettes()
  const active = currentPalette()
  const t = useT()
  const [channel, setChannel] = useState<Channel>('bg')
  const [region, setRegion] = useState<Region>('workarea')
  const { layout } = useLayout()

  /* Only the regions this layout actually has.

     Bento has no top bar and no side bar — that is the point of it — so two of
     these chips painted properties nothing on screen reads, and the person
     clicking them got no feedback because there was nothing to give. The
     bottom bar is the dock here, and says so. */
  const regions = useMemo(
    () => (layout === 'bento'
      ? PICKABLE_REGIONS.filter((r) => r !== 'topbar' && r !== 'sidebar')
      : PICKABLE_REGIONS),
    [layout],
  )
  const regionLabel = (r: Region) =>
    layout === 'bento' && r === 'bottombar'
      ? t('bento.colour.region.dock')
      : t(`bento.colour.region.${r}`)

  /* Switching layout with a now-hidden region selected would leave the editor
     pointed at a chip nobody can see. */
  useEffect(() => {
    if (!regions.includes(region)) setRegion('workarea')
  }, [regions, region])
  const [name, setName] = useState('')
  const [picking, setPicking] = useState(false)

  const current = paint[`${region}.${channel}`] ?? DEFAULT_PICK

  /* Pick on page: the cursor becomes a crosshair and the next click on
     anything tagged with data-paint selects that region.

     Capture phase, so the click is claimed before the thing underneath acts on
     it — otherwise aiming at a card in the work area would open the card. */
  useEffect(() => {
    onPickingChange?.(picking)
  }, [picking, onPickingChange])

  /* AND DISARMED WHEN THIS PANEL GOES AWAY.
   *
   * The line above tells the dialog we are aiming; nothing told it we had
   * stopped. Switching tabs unmounts this panel, so a crosshair armed on
   * Colour and abandoned by clicking "Appearance" left the dialog believing
   * it was still being aimed -- and while it believes that it drops to a
   * quarter opacity, drops its scrim, and ignores Escape. The result was a
   * settings window you could see the page through, could not read, and could
   * not close: the state that made it transparent lived in a component that
   * no longer existed to turn it off.
   *
   * Its own listeners and the crosshair cursor were already cleaned up on
   * unmount by the effect below. This is the one that was not. */
  useEffect(() => () => onPickingChange?.(false), [onPickingChange])

  useEffect(() => {
    if (!picking) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      /* A click inside the dialog is somebody changing their mind or reaching
         for another control, not a pick. Cancelling on it — rather than
         treating it as "no region" — is what lets the crosshair be abandoned
         without also being disarmed by every stray click on the panel. */
      if (target?.closest('[data-appearance-dialog]')) {
        e.preventDefault()
        e.stopPropagation()
        setPicking(false)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      setPicking(false)
      const r = regionUnder(target)
      if (r) setRegion(r)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicking(false)
    }
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey)
    document.body.style.cursor = 'crosshair'
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey)
      document.body.style.cursor = ''
    }
  }, [picking])


  const painted = useMemo(() => Object.keys(paint).length, [paint])
  const wheelRef = useRef<HTMLDetailsElement>(null)


  const update = (next: Partial<Hsl>) => set(region, channel, { ...current, ...next })

  /* What the wireframe below shows for one region.

     A region somebody has painted shows their colour. A region they have not
     used to fall through to the CLASSIC theme — `var(--background)`,
     `var(--card)`, `var(--primary)` — which is a set of shadcn HSL triplets no
     palette writes to. So the preview of the palette was drawn in the other
     layout's colours: measured identical across all four, including the blue
     accent bar, while the page behind it was near-black. The fallback is the
     matching bento token now, which is the thing the preview claims to be
     previewing.

     The fallback cannot live inside `hsl(...)` the way the painted value does:
     paint stores an unwrapped `H S% L%` triplet and a token is hex. So the
     branch is here rather than in CSS. */
  const shown = (key: `${Region}.${Channel}`, token: string) => {
    const v = paint[key]
    return v ? `hsl(${v.h} ${v.s}% ${v.l}%)` : `var(${token})`
  }

  return (
    <div className={cn(picking && 'opacity-25')}>
        {picking && createPortal(
          <div
            /* Outside the dialog on purpose: the dialog is invisible while
               aiming, and this is the one thing left on screen that says what
               is happening and how to stop. A click on it cancels, the same
               as Esc. */
            role="status"
            onClick={() => setPicking(false)}
            className="fixed left-1/2 top-3 z-[80] -translate-x-1/2 cursor-pointer rounded-full
                       border bg-card px-4 py-2 text-[12.5px] shadow-[var(--lift-float)]"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
          >
            <Crosshair className="mr-1.5 inline size-3.5 align-[-2px]" aria-hidden="true" />
            {t('bento.colour.picking_hint')}
          </div>,
          document.body,
        )}

        {/* Glow: how strongly cards glow in their colour, everywhere. */}
        <GlowRow />

        {/* Palettes: saved sets and the shipped ones, first, because picking one
            is the whole act for most people; the wheel below is for the few who
            then want to change a region. */}
        <div className="px-5 py-4">
          <p className={cn('mb-2 text-[11px] font-semibold uppercase tracking-[0.06em]', INK)}>
            {t('bento.colour.saved')}
          </p>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('bento.colour.name_placeholder')}
              /* `bg-background` is the PAGE, and the page is now near-black
                 while this field sits on paper: a black box with black text
                 in it, in every palette that inverts the two. The field is a
                 surface on the card, so it takes the card. */
              className={cn(
                'h-9 min-w-0 flex-1 rounded-[10px] border px-3 text-[13px]',
                'bg-[var(--bento-card)] placeholder:text-[color-mix(in_srgb,var(--bento-ink)_60%,transparent)]',
                EDGE, RING, INK,
              )}
            />
            <button
              type="button"
              disabled={!name.trim() || painted === 0}
              onClick={() => {
                savePalette(name)
                setName('')
              }}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-[10px] border px-3 text-[13px]',
                'transition-colors disabled:opacity-40', EDGE, WASH, RING, INK,
              )}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('bento.colour.save')}
            </button>
          </div>
          {/* The shipped sets, grouped by the mode they were built for.

              Four light and four dark, taken from VS Code's own themes (Light
              Modern, Quiet Light, Solarized, High Contrast; Dark Modern,
              Monokai, Solarized Dark, Abyss), because those are looks people
              already know by name and have already chosen once. Grouped by
              ground because a palette is designed against one: a dark set
              applied in light mode is not a light theme, it is a dark board
              sitting in a light window. Grouping says which is which before
              it is clicked rather than after.

              Read-only, so applying one and then editing a region saves a copy
              under the person's own name rather than overwriting what ships.
              The swatches are the palette's own ground, card, a domain tint,
              its accent and its ink. */}
          {(['light', 'dark'] as const).map((mode) => (
            <div key={mode} className="mt-4">
              <p className={cn('mb-2 text-[12px] font-medium', INK)}>
                {t(`bento.colour.mode.${mode}`)}
              </p>
              {/* PREVIEW CARDS, NOT PILLS.

                  A pill with five 12px dots told you a palette's name and not
                  what it looks like; nobody can assemble a screen from five
                  dots. Each choice is now a small mock of the app painted in
                  that palette's own tokens -- the page, a card on it, a line
                  of ink and one of muted text, the accent and a domain colour
                  as chips -- with the name under it. The chosen one wears the
                  accent: a ring round the mock, a check in its corner, and the
                  name on the accent's tint. The mock's outline is mixed from
                  the ink of the palette in force, not from the palette it
                  shows, so a dark mock on a light card is still bounded. */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {BUILT_IN_PALETTES.filter((p) => p.mode === mode).map((p) => {
                  const on = active === p.name
                  const k = p.tokens
                  return (
                    <button
                      key={p.name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => { applyPersonality('classic'); applyPalette(p.name) }}
                      className={cn(
                        'flex w-full min-w-0 flex-col gap-1.5 rounded-[12px] p-1.5 text-left transition-colors',
                        RING,
                        on ? SELECTED : cn(WASH, INK),
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'relative block h-[60px] w-full overflow-hidden rounded-[8px] border',
                          on ? '!border-[var(--sel-strong)] ring-1 ring-[var(--sel-strong)]' : EDGE,
                        )}
                        style={{ background: k['--bento-bg'] }}
                      >
                        <span
                          className="absolute inset-x-[8px] top-[8px] bottom-[-4px] rounded-t-[6px] border px-[8px] pt-[8px]"
                          style={{ background: k['--bento-card'], borderColor: k['--bento-line'] }}
                        >
                          <span className="block h-[5px] w-[64%] rounded-full" style={{ background: k['--bento-ink'] }} />
                          <span className="mt-[5px] block h-[4px] w-[42%] rounded-full" style={{ background: k['--bento-muted'] }} />
                          <span className="mt-[7px] flex gap-[4px]">
                            <span className="h-[9px] w-[24px] rounded-full" style={{ background: k['--bento-mint'] }} />
                            <span className="h-[9px] w-[14px] rounded-full" style={{ background: k['--dom-students'] }} />
                          </span>
                        </span>
                        {on ? (
                          <span className="absolute right-[5px] top-[5px] grid size-[18px] place-items-center rounded-full bg-[var(--sel-strong)] text-[var(--sel-ground)] shadow-sm">
                            <Check className="size-3" strokeWidth={3} />
                          </span>
                        ) : (
                          <span
                            className="absolute right-[5px] top-[5px] grid size-[18px] place-items-center rounded-full border opacity-55"
                            style={{ background: k['--bento-card'], borderColor: k['--bento-line'], color: k['--bento-muted'] }}
                          >
                            <X className="size-3" strokeWidth={2.5} />
                          </span>
                        )}
                      </span>
                      <span className={cn('min-w-0 truncate px-1 text-[12.5px]', on ? 'font-semibold' : 'font-medium')}>
                        {p.name}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          {palettes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {palettes.map((p) => (
                <span key={p.name} className={cn('flex items-center rounded-full border text-[12.5px]', EDGE)}>
                  <button
                    type="button"
                    onClick={() => { applyPersonality('classic'); applyPalette(p.name) }}
                    className={cn('rounded-l-full px-3 py-1.5 transition-colors', WASH, RING, INK)}
                  >
                    {p.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePalette(p.name)}
                    aria-label={`${t('bento.colour.forget')} ${p.name}`}
                    className={cn('rounded-r-full px-2 py-1.5 transition-colors', WASH, RING, INK)}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>


        <div className={cn('border-t px-5 py-4', SEAM)}>
          {/* Channel.

              The track was `bg-muted` and the chosen tab `bg-popover` — the
              raised shade and the card. On the default palette those are the
              same paper, so the whole segmented control disappeared and there
              was no way to see which channel you were editing. */}
          <div className="mb-4 grid min-w-0 grid-cols-3 gap-1 rounded-[10px] p-1
                          bg-[color-mix(in_srgb,var(--bento-ink)_8%,transparent)]">
            {CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setChannel(c)}
                className={cn(
                  'min-w-0 truncate rounded-[8px] border !border-transparent px-3 py-1.5 text-[13px] transition-colors',
                  RING,
                  channel === c ? `${CHOSEN} font-medium` : INK,
                )}
              >
                {t(`bento.colour.channel.${c}`)}
              </button>
            ))}
          </div>

          {channel === 'accent' && (
            <p className={cn('mb-3 text-[12.5px]', INK)}>
              {t('bento.colour.accent_note')}
            </p>
          )}
          {/* CURATED FIRST, THE WHEEL ON REQUEST.

              The wheel was the biggest thing on the page and the thing fewest
              people want: most arrive to pick a palette, and the rest want "a
              warmer paper" or "a navy ink", which is one tap on a named
              swatch. So each channel opens on a short row of named colours --
              for the accent, the five named accents that were always here --
              and the wheel with its lightness track sits behind "Custom
              colour", unchanged, for anybody who wants an exact shade. Every
              swatch writes the same token the wheel does, so picking one and
              then fine-tuning it on the wheel is one continuous act.

              The accent swatches still write the work area's accent, as the
              named accents always did; the wheel writes the chosen region. */}
          <div role="group" aria-label={t(`bento.colour.channel.${channel}`)} className="mb-4 grid grid-cols-4 gap-x-1 gap-y-2 sm:grid-cols-8">
            {(channel === 'accent'
              ? PRESETS.map((p) => ({ key: p.id, name: t(`bento.settings.accent.${p.id}`), hsl: p.hsl, write: () => set('workarea', 'accent', p.hsl), on: same(paint['workarea.accent'], p.hsl) }))
              : SWATCHES[channel].map((w) => ({ key: w.name, name: w.name, hsl: w.hsl, write: () => update(w.hsl), on: same(paint[`${region}.${channel}`], w.hsl) }))
            ).map((w) => (
              <button
                key={w.key}
                type="button"
                aria-pressed={w.on}
                onClick={w.write}
                className={cn(
                  'flex min-w-0 flex-col items-center gap-1 rounded-[10px] px-1 py-1.5 text-[11.5px] transition-colors',
                  RING,
                  w.on ? cn(SELECTED, 'font-semibold') : cn(WASH, INK),
                )}
              >
                <span
                  aria-hidden="true"
                  /* The swatch is the colour itself, so its outline has to
                     come from the card it sits on rather than from it. */
                  className={cn(
                    'grid size-8 place-items-center rounded-full border',
                    w.on ? '!border-[var(--sel-strong)] ring-2 ring-[var(--sel-strong)] ring-offset-2 ring-offset-[var(--sel-tint)]' : EDGE,
                  )}
                  style={{ background: `hsl(${w.hsl.h} ${w.hsl.s}% ${w.hsl.l}%)` }}
                >
                  {/* Tick on the chosen one, a faint cross on the rest
                      (owner, 2026-10-01: "add tick / cross in colour
                      selection"), both in whichever ink reads on that
                      swatch. */}
                  {w.on ? (
                    <Check
                      className="size-4"
                      strokeWidth={3}
                      style={{ color: w.hsl.l > 55 ? '#000' : '#fff' }}
                    />
                  ) : (
                    <X
                      className="size-3.5 opacity-45"
                      strokeWidth={2.5}
                      style={{ color: w.hsl.l > 55 ? '#000' : '#fff' }}
                    />
                  )}
                </span>
                <span className="w-full truncate text-center">{w.name}</span>
              </button>
            ))}
          </div>

          <details ref={wheelRef} className={cn('group rounded-[12px] border', EDGE)}>
            <summary
              className={cn(
                'flex min-h-[44px] cursor-pointer list-none items-center gap-2.5 rounded-[12px] px-3 text-[13px] font-medium',
                '[&::-webkit-details-marker]:hidden transition-colors',
                WASH, RING, INK,
              )}
            >
              <span
                aria-hidden="true"
                className={cn('size-5 shrink-0 rounded-full border', EDGE)}
                style={{ background: `hsl(${current.h} ${current.s}% ${current.l}%)` }}
              />
              <span className="flex-1">Custom colour</span>
              <ChevronDown className="size-4 opacity-60 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
            </summary>
            <div className="px-3 pb-4 pt-2">
              <WheelCanvas value={current} onPick={(h, s) => update({ h, s })} />
              <p className={cn('mt-2 text-center text-[12.5px]', INK)}>
                {t('bento.colour.wheel_hint')}
              </p>

              <div className="mt-4">
                <div className="flex items-baseline justify-between">
                  <label htmlFor="lightness" className={cn('text-[13px] font-medium', INK)}>
                    {t('bento.colour.lightness')}
                  </label>
                  <span className={cn('text-[13px] tabular-nums', INK)}>
                    {Math.round(current.l)}
                  </span>
                </div>
                <input
                  id="lightness"
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(current.l)}
                  onChange={(e) => update({ l: Number(e.target.value) })}
                  className={cn('mt-2 h-2 w-full cursor-pointer appearance-none rounded-full', SLIDER, RING)}
                  style={{
                    /* The track stays the colour being chosen -- it is the
                       value, not chrome. The handle is the accent-ringed one
                       from bento-theme.css. */
                    background: `linear-gradient(to right, hsl(${current.h} ${current.s}% 0%), hsl(${current.h} ${current.s}% 50%), hsl(${current.h} ${current.s}% 100%))`,
                  }}
                />
              </div>
              {/* A WAY OUT (owner, 2026-10-01: "there is no way to exit the
                  box of the colour wheel"). The fold's own summary scrolls
                  off the top of a phone once the wheel is open, so the
                  foot carries its own Done: it writes nothing more -- the
                  wheel already wrote on every pick -- it only closes the
                  fold and brings the summary back into view. */}
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => { const d = wheelRef.current; if (d) { d.open = false; d.scrollIntoView({ block: 'nearest' }) } }}
                  className={cn('inline-flex min-h-[40px] items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold', SELECTED, RING)}
                >
                  <Check className="size-4" strokeWidth={3} aria-hidden="true" />
                  {t('bento.colour.wheel_done')}
                </button>
              </div>
            </div>
          </details>
        </div>

        {/* Preview: a wireframe of the product, painted with the same tokens
            the product is. Not a swatch — a swatch tells you the colour and not
            what it does to a screen made of five regions. */}
        <div className={cn('border-t px-5 py-4', SEAM)}>
          <p className={cn('mb-2 text-[11px] font-semibold uppercase tracking-[0.06em]', INK)}>
            {t('bento.colour.preview')}
          </p>
          <div
            className={cn('overflow-hidden rounded-[10px] border text-[11px]', EDGE)}
            style={{ background: shown('workarea.bg', '--bento-bg') }}
          >
            <div className="flex">
              <div
                className="w-[74px] shrink-0 p-2"
                style={{
                  background: shown('sidebar.bg', '--bento-card-2'),
                  color: shown('sidebar.text', '--bento-ink'),
                }}
              >
                <p className="font-semibold">Menu</p>
                <p className="mt-1 opacity-70">Students</p>
                <p className="opacity-70">Fees</p>
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className="flex items-center justify-between p-2"
                  style={{
                    background: shown('topbar.bg', '--bento-card'),
                    color: shown('topbar.text', '--bento-ink'),
                  }}
                >
                  <span className="font-semibold">Dashboard</span>
                  <span
                    className="h-2 w-8 rounded-full"
                    style={{ background: shown('workarea.accent', '--bento-mint') }}
                  />
                </div>
                <div
                  className="p-2"
                  /* The work area is the one region of this preview whose
                     ground is the PAGE. `--bento-ink` is the card's ink, so
                     the unpainted fallback drew the specimen black on the
                     near-black page — 1.06:1, inside the dialog somebody opens
                     because they cannot read something. Derived from whatever
                     ground the preview is actually showing, painted or not. */
                  style={{
                    color: paint['workarea.text']
                      ? shown('workarea.text', '--bento-ink')
                      : inkOn(shown('workarea.bg', '--bento-bg')),
                  }}
                >
                  <p className="font-medium">Sample text on the work area</p>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    {[['STUDENTS', '2,840'], ['COLLECTED', '8.4L']].map(([k, v]) => (
                      <div
                        key={k}
                        className={cn('rounded-[6px] border p-1.5', EDGE)}
                        style={{
                          background: shown('cards.bg', '--bento-card'),
                          color: shown('cards.text', '--bento-ink'),
                        }}
                      >
                        <p className="opacity-60">{k}</p>
                        <p className="text-[13px] font-semibold">{v}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Target */}
        {channel !== 'accent' && (
          <div className={cn('border-t px-5 py-4', SEAM)}>
            <div className="mb-2 flex items-center justify-between">
              <p className={cn('text-[11px] font-semibold uppercase tracking-[0.06em]', INK)}>
                {t('bento.colour.select_element')}
              </p>
              <button
                type="button"
                onClick={() => setPicking(true)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px]',
                  'transition-colors', EDGE, WASH, RING, INK,
                )}
              >
                <Crosshair className="size-3.5" aria-hidden="true" />
                {t('bento.colour.pick_on_page')}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {regions.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRegion(r)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-[12.5px] transition-colors',
                    RING,
                    region === r
                      ? `${CHOSEN} font-medium`
                      : cn(EDGE, WASH, INK),
                  )}
                >
                  {regionLabel(r)}
                </button>
              ))}
            </div>
          </div>
        )}

        <footer className={cn('flex items-center gap-3 border-t px-5 py-3', SEAM)}>
          <button
            type="button"
            onClick={() => resetPaint()}
            className={cn(
              'flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-[13px]',
              'transition-colors', EDGE, WASH, RING, INK,
            )}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t('bento.colour.reset')}
          </button>
          <p className={cn('min-w-0 flex-1 truncate text-center text-[12px]', INK)}>
            {channel === 'accent'
              ? t('bento.colour.channel.accent')
              : `${t(`bento.colour.region.${region}`)} · ${t(`bento.colour.channel.${channel}`)}`}
          </p>
        </footer>
    </div>
  )
}
