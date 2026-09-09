import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Crosshair, Pipette, Plus, RotateCcw, X } from 'lucide-react'
import { useApp, BG_TARGETS } from '@/hooks/useAppState'
import { cx } from '@/lib/utils'

/* ===========================================================================
   BACKGROUND COLOUR

   Each interface remembers its own background, because the twenty-one are
   meant to look unrelated — one colour applied to all of them would undo that.
   The choice is stored per interface and re-applied when you return to it.

   What actually changes is --background and --ground. Everything else in the
   palette is derived from the theme tokens, so a card, a rail and a chart all
   follow without being told. The one thing that cannot be left to the tokens
   is text: on a dark choice the foreground has to flip, or the page is
   unreadable — so the picker measures the colour and decides.
   =========================================================================== */

/* ------------------------------------------------------------ colour maths */

export interface Hsl { h: number; s: number; l: number }

export const hslCss = (c: Hsl) => `${Math.round(c.h)} ${Math.round(c.s)}% ${Math.round(c.l)}%`

export function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const S = s / 100, L = l / 100
  const c = (1 - Math.abs(2 * L - 1)) * S
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = L - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

export function hexToHsl(hex: string): Hsl | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: s * 100, l: l * 100 }
}

export const hslToHex = (c: Hsl) =>
  '#' + hslToRgb(c).map((v) => v.toString(16).padStart(2, '0')).join('')

/** Relative luminance, for deciding whether text on this colour must be light. */
export function luminance(c: Hsl) {
  const [r, g, b] = hslToRgb(c).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const isDarkColour = (c: Hsl) => luminance(c) < 0.4

/* ------------------------------------------------------------------ swatches */

const PRESETS: { name: string; hsl: Hsl }[] = [
  { name: 'Ink', hsl: { h: 222, s: 18, l: 11 } },
  { name: 'Blue', hsl: { h: 214, s: 95, l: 52 } },
  { name: 'Green', hsl: { h: 145, s: 63, l: 42 } },
  { name: 'Amber', hsl: { h: 43, s: 96, l: 56 } },
  { name: 'Red', hsl: { h: 4, s: 86, l: 58 } },
]

/** The grid: eleven hues by nine steps, plus a greyscale row across the top. */
const GRID = (() => {
  const rows: Hsl[][] = []
  rows.push(Array.from({ length: 12 }, (_, i) => ({ h: 0, s: 0, l: 100 - (i * 100) / 11 })))
  for (const l of [92, 84, 74, 64, 54, 44, 34, 24]) {
    rows.push(Array.from({ length: 12 }, (_, i) => ({ h: (i * 360) / 12, s: 72, l })))
  }
  return rows
})()

/* ---------------------------------------------------------------- pick mode */

/* What each region of the interface is called, in the order it should win:
   the dock is inside the page, a card is inside the work area, and the first
   match walking up from the pointer is the most specific thing under it. */
const REGIONS: { target: string; name: string; match: string }[] = [
  { target: 'dock', name: 'Bottom bar', match: '.halo-dock, nav.chrome, [class*="bottom-3"]' },
  { target: 'topbar', name: 'Top bar', match: 'header, .chrome, .edu-topbar' },
  { target: 'sidebar', name: 'Side bar', match: 'aside, .edu-sidebar, .nexus-panel, .vector-strip, .pulse-rail, .halo-panel' },
  { target: 'cards', name: 'Cards', match: '.card, .surface, .edu-panel, article' },
  { target: 'page', name: 'Work area', match: '#main, .page-shell, body' },
]

function regionAt(x: number, y: number) {
  const stack = document.elementsFromPoint(x, y) as HTMLElement[]
  /* Skip the overlay and the dialog's own full-screen wrapper. Excluding only
     the inner card left the wrapper on top of everything, so every point
     resolved to it and then fell through to the page. */
  const el = stack.find((e) => !e.closest('[data-pick-overlay], [data-picker-root]')) ?? null
  if (!el) return null
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
    const hit = REGIONS.find((r) => n!.matches(r.match))
    if (hit) return { ...hit, rect: n.getBoundingClientRect() }
  }
  const page = REGIONS[REGIONS.length - 1]
  return { ...page, rect: document.body.getBoundingClientRect() }
}

/** Point at a part of the interface and it becomes the thing being coloured. */
function PickOverlay({ onPick, onCancel }: { onPick: (t: string) => void; onCancel: () => void }) {
  const [found, setFound] = useState<ReturnType<typeof regionAt>>(null)

  useEffect(() => {
    const move = (e: PointerEvent) => setFound(regionAt(e.clientX, e.clientY))
    const click = (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation()
      const r = regionAt(e.clientX, e.clientY)
      if (r) onPick(r.target)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('pointermove', move)
    window.addEventListener('click', click, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('click', click, true)
      window.removeEventListener('keydown', esc)
    }
  }, [onPick, onCancel])

  return createPortal(
    <div data-pick-overlay className="fixed inset-0 z-[97] cursor-crosshair">
      {found && (
        <>
          <div
            className="pointer-events-none fixed rounded-lg ring-2 ring-[hsl(var(--primary))] transition-all duration-100"
            style={{
              left: found.rect.left, top: found.rect.top,
              width: found.rect.width, height: found.rect.height,
              background: 'hsl(var(--primary) / 0.14)',
            }}
          />
          <div
            className="pointer-events-none fixed rounded-md bg-[hsl(var(--primary))] px-2 py-1 text-[11.5px] font-semibold text-[hsl(var(--primary-foreground))] shadow"
            style={{ left: found.rect.left + 8, top: Math.max(found.rect.top + 8, 8) }}
          >
            {found.name}
          </div>
        </>
      )}
      {/* At the top: the bottom edge belongs to the dock, and the hint was
          covering the very thing you were trying to point at. */}
      <p className="pointer-events-none fixed left-1/2 top-6 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-[12.5px] font-medium text-background shadow-lg">
        Click a part of the interface to colour it · Esc to cancel
      </p>
    </div>,
    document.body,
  )
}

/* -------------------------------------------------------------------- dialog */

export function BackgroundPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp()
  const current = app.background ?? null
  const [draft, setDraft] = useState<Hsl>(current ?? { h: 265, s: 62, l: 24 })
  const [mode, setMode] = useState<'background' | 'text' | 'accent'>('background')
  const [paletteName, setPaletteName] = useState('')

  useEffect(() => {
    if (!open) return
    const current = mode === 'accent' ? app.accent
      : mode === 'text' ? app.inks[app.bgTarget]
      : app.backgrounds[app.bgTarget]
    setDraft(current ?? app.background ?? { h: 265, s: 62, l: 24 })
  }, [open, app.ui, app.bgTarget, mode])

  const preview = useMemo(() => hslToHex(draft), [draft])

  /* Draggable: the point of choosing a colour is watching the page take it,
     and a dialog fixed to the middle covers the part you want to watch. */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [picking, setPicking] = useState(false)
  const onGrab = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const card = e.currentTarget.parentElement as HTMLElement
    const r = card.getBoundingClientRect()
    const dx = e.clientX - r.left, dy = e.clientY - r.top
    const move = (ev: PointerEvent) => setPos({
      x: Math.min(Math.max(ev.clientX - dx, 8), window.innerWidth - r.width - 8),
      y: Math.min(Math.max(ev.clientY - dy, 8), window.innerHeight - r.height - 8),
    })
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!open) return null

  const apply = (c: Hsl) => {
    setDraft(c)
    if (mode === 'accent') app.setAccent(c)
    else if (mode === 'text') app.setInkFor(app.bgTarget, c)
    else app.setBackgroundFor(app.bgTarget, c)
  }
  const targetName = BG_TARGETS.find((t) => t.id === app.bgTarget)?.name ?? 'All'

  return createPortal(
    <div data-picker-root className="fixed inset-0 z-[95] flex items-end justify-center sm:items-center sm:p-4"
      role="dialog" aria-modal="true" aria-label="Colour settings">
      {/* Barely there. Blurring the page hid the one thing the dialog exists to
          change; a faint scrim is enough to say the dialog has focus while
          leaving the interface readable underneath it. */}
      <div className={cx('absolute inset-0 bg-foreground/10', picking && 'hidden')} onClick={onClose} />
      {picking && (
        <PickOverlay
          onPick={(t) => { app.setBgTarget(t as any); setPicking(false) }}
          onCancel={() => setPicking(false)}
        />
      )}

      <div
        className={cx('cmdk relative flex max-h-[92dvh] w-full max-w-[460px] flex-col overflow-y-auto rounded-t-2xl bg-[hsl(var(--card))] sm:rounded-2xl',
          picking && 'pointer-events-none opacity-0')}
        style={pos ? { position: 'fixed', left: pos.x, top: pos.y, margin: 0 } : undefined}
      >
        <header onPointerDown={onGrab}
          className="flex cursor-grab items-center gap-2 border-b px-4 py-3 active:cursor-grabbing">
          <Pipette className="h-4 w-4 shrink-0 text-[hsl(var(--primary))]" />
          <h2 className="flex-1 text-center text-[15px] font-semibold">Colour settings</h2>
          <button onClick={onClose} aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Whether the wheel paints the surface or the words on it. */}
        <div className="mx-4 mt-3 grid grid-cols-3 gap-1 rounded-lg bg-[hsl(var(--muted)/0.6)] p-1" role="tablist">
          {(['background', 'text', 'accent'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              className={cx('h-8 rounded-md text-[12.5px] font-medium capitalize transition-colors',
                mode === m ? 'bg-[hsl(var(--card))] shadow-sm' : 'muted hover:text-foreground')}>
              {m === 'background' ? 'Background' : m === 'text' ? 'Text' : 'Accent'}
            </button>
          ))}
        </div>

        {/* The accent is one colour for the whole interface, not one per
            surface, so the element picker below is irrelevant while it is
            selected — buttons, links and the focus ring all read from it. */}
        {mode === 'accent' && (
          <p className="mx-4 mt-2 text-[11px] muted">
            One colour for buttons, links and selected states, across every surface.
          </p>
        )}

        {/* One palette, not three. Asking which colour model you would like
            before asking which colour is the confusing part. */}
        <div className="px-4 py-4">
          <Spectrum value={draft} onChange={apply} />
        </div>

        {/* The page behind is blurred, so the effect of a choice would only be
            visible after closing. This is that page in miniature: it uses the
            same tokens the interface does, so it changes as the colour is
            picked rather than after. */}
        <div className="border-t px-4 py-3">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] muted">Preview</p>
          <div className="flex h-[104px] overflow-hidden rounded-lg ring-1 ring-black/10"
            style={{ background: 'hsl(var(--background))' }}>
            <div className="w-[54px] shrink-0 px-1.5 pt-2" style={{ background: 'hsl(var(--rail))' }}>
              <p className="truncate text-[7.5px] font-semibold"
                style={{ color: 'hsl(var(--rail-foreground, var(--foreground)))' }}>Menu</p>
              <p className="mt-1 truncate text-[7px]"
                style={{ color: 'hsl(var(--rail-foreground, var(--foreground)) / 0.7)' }}>Students</p>
              <p className="mt-0.5 truncate text-[7px]"
                style={{ color: 'hsl(var(--rail-foreground, var(--foreground)) / 0.7)' }}>Fees</p>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex h-[18px] items-center gap-1 px-2" style={{ background: 'hsl(var(--chrome))' }}>
                <span className="truncate text-[7.5px] font-semibold"
                  style={{ color: 'hsl(var(--chrome-foreground, var(--foreground)))' }}>Dashboard</span>
                <span className="ml-auto h-2 w-6 rounded-sm" style={{ background: 'hsl(var(--primary))' }} />
              </div>
              <p className="px-2 pt-1.5 text-[8px] font-semibold"
                style={{ color: 'hsl(var(--foreground))' }}>Sample text on the work area</p>
              <div className="flex gap-1.5 px-2 pb-2 pt-1.5">
                {[['Students', '2,840'], ['Collected', '8.4L']].map(([label, value]) => (
                  <div key={label} className="min-w-0 flex-1 rounded p-1.5"
                    style={{ background: 'hsl(var(--card))', boxShadow: '0 0 0 1px hsl(var(--border))' }}>
                    <span className="block truncate text-[7px] font-semibold uppercase tracking-wider"
                      style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
                    <span className="mt-0.5 block truncate text-[11px] font-semibold"
                      style={{ color: 'hsl(var(--card-foreground))' }}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Which surface the wheel paints. Each one changes a single element
            and leaves the others, so a bar can be given its own colour without
            the page following. */}
        <div className={cx('border-t px-4 py-3', mode === 'accent' && 'hidden')}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] muted">
              Select element
            </p>
            {/* The list names the regions; this points at them. Naming is
                quicker once you know the names, pointing is quicker before. */}
            <button
              onClick={() => setPicking(true)}
              className="flex min-h-[30px] items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors hover:bg-accent"
            >
              <Crosshair className="h-3.5 w-3.5" /> Pick on page
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {BG_TARGETS.map((t) => {
              const on = app.bgTarget === t.id
              const painted = !!app.backgrounds[t.id]
              return (
                <button
                  key={t.id}
                  onClick={() => app.setBgTarget(t.id)}
                  aria-pressed={on}
                  className={cx('flex min-h-[34px] items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors',
                    on ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]'
                       : 'hover:bg-accent')}
                >
                  {t.name}
                  {(painted || !!app.inks[t.id]) && (
                    <span className="h-2 w-2 rounded-full bg-[hsl(var(--primary))]" aria-label="has a colour" />
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* ------------------------------------------------------- Saved */}
        {/* A colour arrived at by turning a wheel is unrepeatable unless it is
            kept. A palette holds the whole scheme — every surface, every ink
            and the accent — so applying one restores what was actually seen,
            not an approximation of it. Kept across interfaces, since the
            reason to save a scheme is to use it on another one. */}
        <div className="border-t px-4 py-3">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] muted">
            Saved palettes
          </p>

          {app.palettes.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {app.palettes.map((pl) => (
                <span key={pl.id}
                  className="group flex min-h-[32px] items-center gap-1.5 rounded-lg border pl-1.5 pr-1 text-[12.5px]">
                  <button onClick={() => app.applyPalette(pl.id)}
                    className="flex items-center gap-1.5 rounded px-1 py-1" title={`Apply ${pl.name}`}>
                    {/* The scheme's own colours, so it is recognisable without
                        having to remember what the name referred to. */}
                    <span className="flex">
                      {(['page', 'topbar', 'sidebar', 'cards'] as const).map((k) => {
                        const c = pl.parts[k] ?? pl.accent
                        return (
                          <span key={k}
                            className="-ml-1 h-3.5 w-3.5 rounded-full ring-1 ring-black/15 first:ml-0"
                            style={{ background: c ? `hsl(${c.h} ${c.s}% ${c.l}%)` : 'hsl(var(--muted))' }} />
                        )
                      })}
                    </span>
                    {pl.name}
                  </button>
                  <button onClick={() => app.deletePalette(pl.id)} aria-label={`Delete ${pl.name}`}
                    className="grid h-6 w-6 place-items-center rounded opacity-45 hover:bg-accent hover:opacity-100">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-1.5">
            <input
              value={paletteName}
              onChange={(e) => setPaletteName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                app.savePalette(paletteName)
                setPaletteName('')
              }}
              placeholder="Name this scheme"
              className="field h-9 min-w-0 flex-1 rounded-lg border px-2.5 text-[12.5px]"
            />
            <button
              onClick={() => { app.savePalette(paletteName); setPaletteName('') }}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors hover:bg-accent"
            >
              <Plus className="h-3.5 w-3.5" /> Save
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t px-4 py-3">
          <button
            title="Clear every colour on this interface"
            onClick={() => {
              // Reset means "give me the interface back": every element, not
              // just the one selected, and then its own light or dark palette.
              app.setBackground(null)
              app.setAccent(null)
              BG_TARGETS.forEach((t) => {
                app.setBackgroundFor(t.id, null)
                app.setInkFor(t.id, null)
              })
              onClose()
            }}
            className="flex h-10 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors hover:bg-accent">
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </button>
          <p className="min-w-0 flex-1 truncate text-[11.5px] muted">
            {targetName} · {mode === 'text' ? 'text' : 'background'} · {app.uiDef.label} only
          </p>
          <button onClick={onClose}
            className="flex h-10 items-center gap-1.5 rounded-lg bg-[hsl(var(--primary))] px-4 text-[13px] font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90">
            <Check className="h-4 w-4" /> Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ pieces */

function Spectrum({ value, onChange }: { value: Hsl; onChange: (c: Hsl) => void }) {
  /* A wheel rather than a rectangle: hue is a cycle, and a strip has to cut it
     somewhere — red ends up at both edges, so the two colours furthest apart on
     screen are the same one. On a wheel the angle is the hue and the distance
     from the middle is the saturation, which is what those two actually are. */
  const at = (e: React.MouseEvent<HTMLDivElement>): Hsl => {
    const r = e.currentTarget.getBoundingClientRect()
    const cx = r.width / 2, cy = r.height / 2
    const dx = e.clientX - r.left - cx, dy = e.clientY - r.top - cy
    const dist = Math.min(Math.hypot(dx, dy) / Math.min(cx, cy), 1)
    // Clockwise from twelve o'clock, matching `conic-gradient(from 0deg)`, so
    // the angle and the hue are the same number.
    const angle = (Math.atan2(dx, -dy) * 180) / Math.PI
    return { h: (angle + 360) % 360, s: Math.round(dist * 100), l: value.l }
  }

  /* The click is the choice. Repainting the whole interface as the cursor
     crossed the wheel meant it changed constantly on the way to the colour you
     wanted, which is closer to strobing than to previewing. Nothing happens
     until you commit. */
  const commit = (e: React.MouseEvent<HTMLDivElement>) => onChange(at(e))

  // Where the current colour sits, so the wheel shows its own state.
  // Same mapping in reverse: hue is the angle from twelve, saturation the radius.
  const rad = (value.h - 90) * (Math.PI / 180)
  const rDist = (value.s / 100) * 50

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        onClick={commit}
        role="application"
        aria-label="Colour wheel"
        className="relative aspect-square w-[240px] cursor-crosshair overflow-hidden rounded-full"
        style={{
          background:
            /* A wider, softer white core: a hard edge at 72% drew a visible
               ring where the wash ended. */
            'radial-gradient(circle at 50% 50%, #fff 0%, rgba(255,255,255,.55) 34%, rgba(255,255,255,0) 78%),' +
            'conic-gradient(from 0deg, hsl(0 100% 50%), hsl(5 100% 50%), hsl(10 100% 50%), hsl(15 100% 50%), hsl(20 100% 50%), hsl(25 100% 50%), hsl(30 100% 50%), hsl(35 100% 50%), hsl(40 100% 50%), hsl(45 100% 50%), hsl(50 100% 50%), hsl(55 100% 50%), hsl(60 100% 50%), hsl(65 100% 50%), hsl(70 100% 50%), hsl(75 100% 50%), hsl(80 100% 50%), hsl(85 100% 50%), hsl(90 100% 50%), hsl(95 100% 50%), hsl(100 100% 50%), hsl(105 100% 50%), hsl(110 100% 50%), hsl(115 100% 50%), hsl(120 100% 50%), hsl(125 100% 50%), hsl(130 100% 50%), hsl(135 100% 50%), hsl(140 100% 50%), hsl(145 100% 50%), hsl(150 100% 50%), hsl(155 100% 50%), hsl(160 100% 50%), hsl(165 100% 50%), hsl(170 100% 50%), hsl(175 100% 50%), hsl(180 100% 50%), hsl(185 100% 50%), hsl(190 100% 50%), hsl(195 100% 50%), hsl(200 100% 50%), hsl(205 100% 50%), hsl(210 100% 50%), hsl(215 100% 50%), hsl(220 100% 50%), hsl(225 100% 50%), hsl(230 100% 50%), hsl(235 100% 50%), hsl(240 100% 50%), hsl(245 100% 50%), hsl(250 100% 50%), hsl(255 100% 50%), hsl(260 100% 50%), hsl(265 100% 50%), hsl(270 100% 50%), hsl(275 100% 50%), hsl(280 100% 50%), hsl(285 100% 50%), hsl(290 100% 50%), hsl(295 100% 50%), hsl(300 100% 50%), hsl(305 100% 50%), hsl(310 100% 50%), hsl(315 100% 50%), hsl(320 100% 50%), hsl(325 100% 50%), hsl(330 100% 50%), hsl(335 100% 50%), hsl(340 100% 50%), hsl(345 100% 50%), hsl(350 100% 50%), hsl(355 100% 50%), hsl(360 100% 50%))',
          filter: 'saturate(1.05)',
          boxShadow: 'inset 0 0 40px rgba(255,255,255,.35), 0 18px 44px -22px rgba(0,0,0,.5)',
        }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow transition-all duration-200"
          style={{
            left: `${50 + Math.cos(rad) * rDist}%`,
            top: `${50 + Math.sin(rad) * rDist}%`,
            // The wheel is a hue ring washed to white at its centre, so the
            // marker mixes the same way — otherwise it disagrees with the very
            // pixel it sits on.
            background: `color-mix(in srgb, hsl(${Math.round(value.h)} 100% 50%) ${Math.round(value.s)}%, white)`,
          }}
        />
      </div>

      <p className="-mt-1 text-[11.5px] muted">Click the wheel to choose a colour</p>

      {/* The wheel carries hue and saturation; lightness is the third axis and
          has nowhere to live on a disc, so it sits beneath it. */}
      <div className="w-full">
        <Slider label="Lightness" min={0} max={100} value={value.l}
          track={`linear-gradient(to right, #000, hsl(${value.h} ${value.s}% 50%), #fff)`}
          onChange={(l) => onChange({ ...value, l })} />
      </div>
    </div>
  )
}

function Slider({ label, min, max, value, track, onChange }: {
  label: string; min: number; max: number; value: number; track: string; onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[12px] font-medium">
        {label}
        <span className="tabular-nums muted">{Math.round(value)}</span>
      </span>
      <input
        type="range" min={min} max={max} value={Math.round(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        data-plain-focus
        className="mt-1.5 h-6 w-full cursor-pointer appearance-none rounded-full"
        style={{ background: track }}
      />
    </label>
  )
}
