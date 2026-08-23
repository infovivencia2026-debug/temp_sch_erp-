import { useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, Plus, RotateCcw, X } from 'lucide-react'
import {
  usePaint, usePalettes, savePalette, deletePalette, applyPalette, resetPaint,
  REGIONS, CHANNELS, BUILT_IN_PALETTES, hslCss,
  type Region, type Channel, type Hsl,
} from '@/lib/paint'
import { useT } from '@/lib/i18n'
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

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = ref.current
    if (!cv) return
    const box = cv.getBoundingClientRect()
    const dx = e.clientX - box.left - box.width / 2
    const dy = e.clientY - box.top - box.height / 2
    const r = box.width / 2
    const dist = Math.min(Math.sqrt(dx * dx + dy * dy), r)
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
    if (deg < 0) deg += 360
    onPick(deg, (dist / r) * 100)
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
        onClick={pick}
        style={{ width: SIZE, height: SIZE }}
        className="cursor-crosshair rounded-full shadow-[var(--lift-panel)]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2
                   rounded-full border-2 border-white shadow"
        style={{ left: mx, top: my }}
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
  const t = useT()
  const [channel, setChannel] = useState<Channel>('bg')
  const [region, setRegion] = useState<Region>('workarea')
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

  return (
    <div className={cn(picking && 'opacity-25')}>

        <div className="px-5 py-4">
          {/* Channel */}
          <div className="mb-4 grid grid-cols-3 gap-1 rounded-[10px] bg-muted p-1">
            {CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setChannel(c)}
                className={cn(
                  'rounded-[8px] px-3 py-1.5 text-[13px] transition-colors',
                  channel === c ? 'bg-popover font-medium shadow-[var(--lift-panel)]' : 'text-muted-foreground',
                )}
              >
                {t(`bento.colour.channel.${c}`)}
              </button>
            ))}
          </div>

          {channel === 'accent' && (
            <>
              <p className="mb-3 text-[12.5px] text-muted-foreground">
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
                    className="flex items-center gap-1.5 rounded-full border px-2.5 py-1
                               text-[12.5px] transition-colors hover:bg-accent"
                  >
                    <span
                      aria-hidden="true"
                      className="size-3 rounded-full"
                      style={{ background: `hsl(${p.hsl.h} ${p.hsl.s}% ${p.hsl.l}%)` }}
                    />
                    {t(`bento.settings.accent.${p.id}`)}
                  </button>
                ))}
              </div>
            </>
          )}

          <WheelCanvas value={current} onPick={(h, s) => update({ h, s })} />
          <p className="mt-2 text-center text-[12.5px] text-muted-foreground">
            {t('bento.colour.wheel_hint')}
          </p>

          <div className="mt-4">
            <div className="flex items-baseline justify-between">
              <label htmlFor="lightness" className="text-[13px] font-medium">
                {t('bento.colour.lightness')}
              </label>
              <span className="text-[13px] tabular-nums text-muted-foreground">
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
              className="mt-1.5 h-2 w-full cursor-pointer appearance-none rounded-full"
              style={{
                background: `linear-gradient(to right, hsl(${current.h} ${current.s}% 0%), hsl(${current.h} ${current.s}% 50%), hsl(${current.h} ${current.s}% 100%))`,
              }}
            />
          </div>
        </div>

        {/* Preview: a wireframe of the product, painted with the same tokens
            the product is. Not a swatch — a swatch tells you the colour and not
            what it does to a screen made of five regions. */}
        <div className="border-t px-5 py-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t('bento.colour.preview')}
          </p>
          <div
            className="overflow-hidden rounded-[10px] border text-[11px]"
            style={{ background: 'hsl(var(--paint-workarea-bg, var(--background)))' }}
          >
            <div className="flex">
              <div
                className="w-[74px] shrink-0 p-2"
                style={{
                  background: 'hsl(var(--paint-sidebar-bg, var(--sidebar)))',
                  color: 'hsl(var(--paint-sidebar-text, var(--foreground)))',
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
                    background: 'hsl(var(--paint-topbar-bg, var(--card)))',
                    color: 'hsl(var(--paint-topbar-text, var(--foreground)))',
                  }}
                >
                  <span className="font-semibold">Dashboard</span>
                  <span
                    className="h-2 w-8 rounded-full"
                    style={{ background: 'hsl(var(--paint-workarea-accent, var(--primary)))' }}
                  />
                </div>
                <div
                  className="p-2"
                  style={{ color: 'hsl(var(--paint-workarea-text, var(--foreground)))' }}
                >
                  <p className="font-medium">Sample text on the work area</p>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    {[['STUDENTS', '2,840'], ['COLLECTED', '8.4L']].map(([k, v]) => (
                      <div
                        key={k}
                        className="rounded-[6px] border p-1.5"
                        style={{
                          background: 'hsl(var(--paint-cards-bg, var(--card)))',
                          color: 'hsl(var(--paint-cards-text, var(--foreground)))',
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
          <div className="border-t px-5 py-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                {t('bento.colour.select_element')}
              </p>
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px]
                           transition-colors hover:bg-accent"
              >
                <Crosshair className="size-3.5" aria-hidden="true" />
                {t('bento.colour.pick_on_page')}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {REGIONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRegion(r)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-[12.5px] transition-colors',
                    region === r
                      ? 'border-primary bg-primary-soft font-medium text-primary'
                      : 'hover:bg-accent',
                  )}
                >
                  {t(`bento.colour.region.${r}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Palettes */}
        <div className="border-t px-5 py-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t('bento.colour.saved')}
          </p>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('bento.colour.name_placeholder')}
              className="h-9 min-w-0 flex-1 rounded-[10px] border bg-background px-3 text-[13px]
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="button"
              disabled={!name.trim() || painted === 0}
              onClick={() => {
                savePalette(name)
                setName('')
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-[10px] border px-3 text-[13px]
                         transition-colors hover:bg-accent disabled:opacity-40"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('bento.colour.save')}
            </button>
          </div>
          {/* The shipped sets. No forget button: they are read-only, so
              applying one and then editing it saves a copy under whatever name
              the person gives it rather than overwriting what ships. The
              swatches are the palette's own five mapped shades, in the order
              they are applied — ground, card, raised, accent, ink. */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {BUILT_IN_PALETTES.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => applyPalette(p.name)}
                className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px]
                           transition-colors hover:bg-accent"
              >
                <span className="flex" aria-hidden="true">
                  {(['workarea.bg', 'cards.bg', 'students.bg', 'cards.accent', 'cards.text'] as const)
                    .map((k) => {
                      const v = p.paint[k]
                      return (
                        <span
                          key={k}
                          className="size-3 rounded-full ring-1 ring-black/20 -ml-1 first:ml-0"
                          style={{ background: v ? hslCss(v) : 'transparent' }}
                        />
                      )
                    })}
                </span>
                {p.name}
              </button>
            ))}
          </div>
          {palettes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {palettes.map((p) => (
                <span key={p.name} className="flex items-center rounded-full border text-[12.5px]">
                  <button
                    type="button"
                    onClick={() => applyPalette(p.name)}
                    className="rounded-l-full px-3 py-1.5 transition-colors hover:bg-accent"
                  >
                    {p.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePalette(p.name)}
                    aria-label={`${t('bento.colour.forget')} ${p.name}`}
                    className="rounded-r-full px-2 py-1.5 text-muted-foreground transition-colors
                               hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t px-5 py-3">
          <button
            type="button"
            onClick={() => resetPaint()}
            className="flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-[13px]
                       transition-colors hover:bg-accent"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t('bento.colour.reset')}
          </button>
          <p className="min-w-0 flex-1 truncate text-center text-[12px] text-muted-foreground">
            {channel === 'accent'
              ? t('bento.colour.channel.accent')
              : `${t(`bento.colour.region.${region}`)} · ${t(`bento.colour.channel.${channel}`)}`}
          </p>
        </footer>
    </div>
  )
}
