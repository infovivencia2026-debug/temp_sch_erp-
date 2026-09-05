import { useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, Plus, RotateCcw, X } from 'lucide-react'
import {
  usePaint, usePalettes, savePalette, deletePalette, applyPalette, resetPaint,
  REGIONS, CHANNELS, BUILT_IN_PALETTES, currentPalette,
  type Region, type Channel, type Hsl,
} from '@/lib/paint'
import { applyPersonality } from '@/lib/personality'
import { useT } from '@/lib/i18n'
import { useLayout } from '@/lib/layout'
import { cn } from '@/lib/utils'

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

/* The vocabulary these three dialogs are painted in.

   They used to wear the app's semantic utilities — `bg-popover`, `bg-accent`,
   `text-muted-foreground`, `focus-visible:ring-ring` — and those resolve to
   the shadcn theme, which is HSL triplets read as `hsl(var(--x))`. A palette
   is fifty-five hex values. The two sets cannot meet, so every one of those
   classes sat unmoved while all four palettes went past it: measured, and the
   swatch rings, the wheel marker and the preview wireframe were identical in
   all four.

   So this dialog names bento tokens, or a mix of one, and nothing else. No
   colour is written here: `--bento-ink` is black or white by construction —
   every palette computes it against its own card — and `--bento-card` is
   whatever that palette's paper is. A mix of the ink is therefore correct on
   a white card and on a near-black one without a branch.

   Exported because AppearanceDialog and BentoSettings are the same surface
   seen from two other doors, and three copies of these strings would drift. */

/** Text and icons. Black or white, decided by the palette against its card. */
export const INK = 'text-[var(--bento-ink)]'

/** A control's own outline: enough ink to clear 3:1 on any of the five
    grounds (measured 3.18:1 on the default paper, 3.6:1 on the darkest card),
    which the palette's `--bento-line` hairline — a divider, not a boundary —
    does not (1.15-1.47:1). */
/* WHY IT IS MARKED IMPORTANT, AND WHAT WAS MEASURED WITHOUT IT.

   The stylesheet repoints every width-only border class to the palette's
   hairline with `[data-layout='bento'] :where(.border, .border-t, …)`. The
   `:where()` is there to keep that rule at the attribute selector's own weight
   so a call site naming a colour still wins — but a Tailwind utility is
   (0,1,0) and so is that rule, and the layout's stylesheet is imported after
   the utilities. Equal weight, later origin: the hairline won every time.

   So EDGE compiled, applied to the right element, and did nothing. Measured on
   the panel it is supposed to bound: 1.38:1 — the hairline, not the edge. It
   is stated as important because it is deliberately overriding a global rule
   for the one job that rule is wrong for. */
export const EDGE = '!border-[color-mix(in_srgb,var(--bento-ink)_45%,transparent)]'

/** A filled shape that has to be seen rather than merely bounded: a slider
    track, a step dot. Heavier than EDGE, worst measured 3.18:1 → 4.34:1. */
export const TRACK = 'bg-[color-mix(in_srgb,var(--bento-ink)_55%,transparent)]'

/** Hover wash, mixed from the ink so one value darkens a light card and
    lightens a dark one. */
export const WASH = 'hover:bg-[color-mix(in_srgb,var(--bento-ink)_10%,transparent)]'

/** The focus ring. It was the accent, which on the default palette is a light
    green on light paper — 1.04:1, a ring you cannot see on the one dialog
    somebody opens *because* they cannot see. The ink always wins against the
    card it is drawn on. */
export const RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bento-ink)]'

/** Chosen. Inverted rather than tinted: the accent-on-its-own-tint pairing
    this used to wear measured 1.1-4.3:1 and put a coloured word on screen,
    which the surface no longer does. Ink on card is 21:1 in every palette. */
export const CHOSEN = '!border-[var(--bento-ink)] bg-[var(--bento-ink)] text-[var(--bento-card)]'

/** A rule between rows, not around a control.

    `.border` on the bento surface resolves to `--bento-line`, which is the
    palette's hairline BETWEEN cards: measured 1.38:1 against the card, which
    is right for a divider inside a panel and wrong for the edge of the panel
    itself or of anything you can press. Those take EDGE; this is for the
    seams — the header rule, the row dividers, the list's own lines — and is
    mixed from the ink so a palette moves it. */
export const SEAM = '!border-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]'

/** A panel that is its own surface: a popover, a menu, a dialog.

    `bg-popover` alone is half an answer. The stylesheet repoints it to
    `--bento-card`, but nothing sets the matching ink, so a portalled panel
    took whatever `color` it inherited from <body> — which on this layout is
    the CARD's ink by luck rather than by construction. Stating both means the
    pair is guaranteed rather than coincidental. */
export const SURFACE = 'bg-[var(--bento-card)] text-[var(--bento-ink)]'

/** The handle on every slider in these dialogs. */
export const SLIDER = 'bento-slider'

/** Black or white, whichever the given ground is further from.

    The one ink token every palette ships — `--bento-ink` — was measured
    against `--bento-card` and nothing else, so it is the wrong answer for any
    surface that is not the card: the page, the dock, a preview of the work
    area. Relative colour syntax asks the ground itself, so no colour is named
    and no palette has a fifty-sixth token to set.

    THE CLAMP IS NOT TIDINESS. `(49 - l) * 100%` is meant to land on 0% or 100%
    and rely on lightness clamping to get there, and as a `color` it does. But
    `l` is a 0-100 number, so the near-black page — l = 4 — produces 4500%, and
    Chromium keeps that as an out-of-gamut `color(srgb 44.88 44.88 44.88)`
    rather than folding it to white. Everything downstream then overflows: a
    12% mix of it is 5.39, which clamps to opaque white, so `color-mix(…
    var(--ink-here) 12%, transparent)` — a faint wash — painted a solid white
    slab. The Done button in the arranger was exactly that: a white pill with
    white letters on it.

    Clamping in the channel keeps the value inside the gamut, so a mix of it
    is a mix and not a flood. */
export function inkOn(ground: string) {
  return `hsl(from ${ground} 0 0% clamp(0%, (49 - l) * 100%, 100%))`
}

/** The same, as the raw declaration a `style` prop wants. */
export const INK_HERE_FROM_PAGE = inkOn('var(--bento-bg)')

/* A thumb a palette can reach, in the one place a utility class cannot go.

   Every slider here — the five scales and the lightness track — was drawing
   the browser's own blue handle, identical under all four palettes and dead
   against the lightness gradient at both ends. `accent-color` would move it,
   but a single-tone thumb is invisible at one end of a black-to-white track
   whichever tone it is. So it is two: the card as the disc and the ink as its
   ring, the pair every palette guarantees, which reads on any track there is.

   A pseudo-element cannot be written as a class, and the palette work in
   bento-theme.css is not this dialog's to edit, so it is declared here beside
   the controls it dresses. */
export function SliderThumbStyle() {
  return (
    <style>{`
      .bento-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 14px; height: 14px; border-radius: 999px;
        background: var(--bento-card);
        box-shadow: 0 0 0 2px var(--bento-ink);
        cursor: pointer;
      }
      .bento-slider::-moz-range-thumb {
        width: 12px; height: 12px; border-radius: 999px;
        background: var(--bento-card);
        border: 2px solid var(--bento-ink);
        cursor: pointer;
      }
    `}</style>
  )
}

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
  const mx = SIZE / 2 + Math.cos(rad) * (value.s / 100) * (SIZE / 2)
  const my = SIZE / 2 + Math.sin(rad) * (value.s / 100) * (SIZE / 2)

  return (
    <div className="relative mx-auto" style={{ width: SIZE, height: SIZE }}>
      <canvas
        ref={ref}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        // touch-none for the same reason as preventDefault above: without it
        // the browser claims the gesture as a scroll before the wheel sees it.
        style={{ width: SIZE, height: SIZE, touchAction: 'none' }}
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
          left: mx,
          top: my,
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

/* The colour engine, without a window of its own.

   It was a second dialog beside Appearance, which meant two doors in the menu
   to two halves of one question — how should this look. It is a section now,
   and ColourDialog is gone rather than kept as a wrapper nobody opens. */
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
      ? REGIONS.filter((r) => r !== 'topbar' && r !== 'sidebar')
      : REGIONS),
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
      const el = target?.closest<HTMLElement>('[data-paint]')
      e.preventDefault()
      e.stopPropagation()
      setPicking(false)
      const r = el?.dataset.paint as Region | undefined
      if (r && (REGIONS as readonly string[]).includes(r)) setRegion(r)
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
            <div key={mode} className="mt-2">
              <p className={cn('mb-1.5 text-[11px]', INK)}>
                {t(`bento.colour.mode.${mode}`)}
              </p>
              {/* A grid, not a wrap: eight names of different lengths wrapped into rows
                  of two and three and one, and read as a jumble. Two equal columns
                  put every set in the same-sized chip. */}
              <div className="grid grid-cols-2 gap-1.5">
                {BUILT_IN_PALETTES.filter((p) => p.mode === mode).map((p) => {
                  const on = active === p.name
                  return (
                    <button
                      key={p.name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => { applyPersonality('classic'); applyPalette(p.name) }}
                      className={cn(
                        'flex w-full min-w-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px] transition-colors',
                        RING,
                        on ? `${CHOSEN} font-medium` : cn(EDGE, WASH, INK),
                      )}
                    >
                      <span className="flex" aria-hidden="true">
                        {([
                          '--bento-bg', '--bento-card', '--dom-students',
                          '--bento-mint', '--bento-ink',
                        ] as const).map((k) => (
                          <span
                            key={k}
                            /* The chip shows a palette's own colour, so its
                               ring cannot be one of them — and `ring-black/20`
                               was a literal, invisible against every dark
                               swatch it circled (measured 1.00-1.02:1). Mixed
                               from the ink of the palette in force, which is
                               the card's opposite by construction. */
                            className="size-3 rounded-full -ml-1 first:ml-0 ring-1
                                       ring-[color-mix(in_srgb,var(--bento-ink)_45%,transparent)]"
                            style={{ background: p.tokens[k] }}
                          />
                        ))}
                      </span>
                      <span className="min-w-0 truncate">{p.name}</span>
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
          <div className="mb-4 grid grid-cols-3 gap-1 rounded-[10px] p-1
                          bg-[color-mix(in_srgb,var(--bento-ink)_8%,transparent)]">
            {CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setChannel(c)}
                className={cn(
                  'rounded-[8px] border !border-transparent px-3 py-1.5 text-[13px] transition-colors',
                  RING,
                  channel === c ? `${CHOSEN} font-medium` : INK,
                )}
              >
                {t(`bento.colour.channel.${c}`)}
              </button>
            ))}
          </div>

          {channel === 'accent' && (
            <>
              <p className={cn('mb-3 text-[12.5px]', INK)}>
                {t('bento.colour.accent_note')}
              </p>
              {/* The five named accents, as a shortcut to the wheel rather than
                  a second mechanism beside it.

                  They used to be their own preference writing a data-accent
                  attribute, which meant two systems could each claim to own the
                  product's accent and the last one touched won. They set the
                  same token the wheel does now, so picking Mint and then
                  dragging the wheel is one continuous act instead of a fight. */}
              <div className="mb-4 flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => set('workarea', 'accent', p.hsl)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-1',
                      'text-[12.5px] transition-colors',
                      EDGE, WASH, RING, INK,
                    )}
                  >
                    <span
                      aria-hidden="true"
                      /* The swatch is the accent itself, so its outline has to
                         come from the card it sits on rather than from it. */
                      className="size-3 rounded-full ring-1
                                 ring-[color-mix(in_srgb,var(--bento-ink)_45%,transparent)]"
                      style={{ background: `hsl(${p.hsl.h} ${p.hsl.s}% ${p.hsl.l}%)` }}
                    />
                    {t(`bento.settings.accent.${p.id}`)}
                  </button>
                ))}
              </div>
            </>
          )}

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
              className={cn('mt-1.5 h-2 w-full cursor-pointer appearance-none rounded-full', SLIDER, RING)}
              style={{
                /* The track stays the colour being chosen — it is the value,
                   not chrome. The handle is the two-tone one above, because
                   the browser's blue was the same blue in every palette. */
                background: `linear-gradient(to right, hsl(${current.h} ${current.s}% 0%), hsl(${current.h} ${current.s}% 50%), hsl(${current.h} ${current.s}% 100%))`,
              }}
            />
          </div>
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
