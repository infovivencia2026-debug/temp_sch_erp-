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

/** Chosen. It was inverted -- a slab of ink with the card as its word --
    because the accent-on-its-own-tint pairing it wore before measured
    1.1-4.3:1. Correct, and grey on grey: the one screen where a school picks
    its colours was the one screen that showed none of them. It is the accent
    again now, through two tokens built to clear the bar (bento-theme.css,
    measured in lib/paint.test.ts): the accent's tint as the ground and the
    accent taken halfway to black or white as the word, 4.5:1 or better in
    every built-in palette. The border is the strong accent too, so the chosen
    thing is also outlined, not only tinted. */
export const CHOSEN = '!border-[var(--sel-strong)] bg-[var(--sel-tint)] text-[var(--sel-strong)]'

/** The same pair without the border, for things that have none. */
export const SELECTED = 'bg-[var(--sel-tint)] text-[var(--sel-strong)]'

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
/* The fallbacks matter for the CLASSIC layout. --bento-card and --bento-ink are
   defined only under [data-layout='bento'], but these dialogs are portalled to
   <body> and open in the classic layout too -- where the vars are undefined and
   the panel background resolved to TRANSPARENT, so in dark mode the page showed
   straight through the Settings window. The app's own popover tokens (defined in
   both layouts and both themes) are the fallback; in bento the vars win and the
   fallback never fires. */
export const SURFACE =
  'bg-[var(--bento-card,hsl(var(--popover)))] text-[var(--bento-ink,hsl(var(--popover-foreground)))]'

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
