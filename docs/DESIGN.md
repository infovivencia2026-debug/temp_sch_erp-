# Design system

The register is **neutral admin tool** — Linear, Vercel, Stripe — rather than
dashboard-product. Three rules carry most of it:

- **Colour budget is roughly 90% neutral, 7% accent, 3% semantic.** A screen
  where everything is coloured has no way left to say "this one matters".
- **Depth comes from tonal steps between surfaces, never from shadows.**
- **Every token is defined once in `web/src/index.css`.** This document
  describes that file; it is not a second source of truth. If the two
  disagree, the CSS is right.

---

## Typography

Inter Variable, **self-hosted through the bundle** (`@fontsource-variable/inter`).

Not Google Fonts, for three reasons that matter to a school specifically: a
thin connection should not wait on a third party to render a fee receipt, the
files are available offline, and no parent's browser announces itself to
another company on the way to the attendance register. The variable cut
carries every weight in one file — including the 450 the editorial styles use,
which a static set would need four requests for.

| Element | Size | Weight | Tracking | Leading |
|---|---|---|---|---|
| `html` / `body` | 14px | — | — | 1.5 |
| `h1` | 24px | 600 | −0.02em | 1.25 |
| `h2` | 18px | 600 | −0.015em | 1.35 |
| `h3` | 15px | 600 | −0.01em | 1.4 |
| `.stat` | 28px | 600 | −0.02em | 1.15 |
| `.eyebrow` | 12px | 500 | 0 | — |

14px is the body baseline for dense enterprise software: small enough to fit a
working amount of data on screen, large enough to read all day. 13px was tried
and looked cramped.

`.eyebrow` is sentence case with no letter-spacing. The uppercase, tracked
treatment it used to carry is an editorial device that costs legibility at
small sizes and makes a form look like a brochure.

`font-variant-numeric: tabular-nums` is set on `body`, so every table and KPI
aligns without per-component classes. `svg { stroke-width: 1.75 }` globally.

---

## Colour

### Light

| Token | Value | Use |
|---|---|---|
| `--ground` | `#FAFAFA` | page |
| `--card` | `#FFFFFF` | surface |
| `--foreground` | `#111827` | primary text |
| `--secondary-foreground` | `#4B5563` | secondary text |
| `--muted-foreground` | `220 9% 47%` | hints, table headers, unbuilt items |
| `--border` | `#E5E7EB` | every separator |
| `--primary` | `#2563EB` | the single accent |

47% is the lightest `--muted-foreground` can be and still clear **4.5:1 on
white**, which it has to: it is used for navigation items, table headers and
hints — all read rather than decorative. 55% measured 3.5:1 and was quietly
failing.

The accent is for primary actions, selection and one chart series. **Not** for
headings, icons or decoration.

### Semantic

Each earns its place by meaning something specific.

| Token | Light | Means |
|---|---|---|
| `--success` | `#16A34A` | paid |
| `--warning` | `#D97706` | pending |
| `--destructive` | `#DC2626` | bounced, overdue |
| `--info` | `#0891B2` | informational |

### Dark

Four tonal steps rather than black-and-white:

```
#0A0A0A ground → #111111 card → #181818 popover → #272727 border
```

Four legible layers with no elevation at all, where a black page with white
cards would just glare.

---

## Geometry

| | |
|---|---|
| icon rail | 56px — role switcher, `lg` and up only |
| sidebar | 248px, or a 280px fixed drawer below `lg` |
| header | 56px, sticky; `.chrome` = `bg/0.9` + `backdrop-blur(8px)` |
| `.page-shell` | max-width 1600px, centred |
| `PageHead` | `px-6 sm:px-8`, `pt-5 pb-5`, `border-b` |
| `PageBody` | `px-6 py-6 sm:px-8`, `space-y-6` |

Radius scale by component weight: **control 6px · input 8px · card 10px ·
dialog 12px**.

---

## Components

**Card** — a hairline and a surface. `1px` border, no shadow: on a neutral
ground the border already separates it, and stacked shadows are what make an
admin panel look like 2016.

**CellGrid** — a row of metrics sharing *one* outline, separated by 1px of
border colour showing through a grid gap rather than each cell drawing its own
box. Visually cheaper than four cards side by side. Cells pad 20px.

**Button** — `rounded-sm`, 150ms colour transition. `md` is `h-9 px-3.5 14px`;
`sm` is `h-8 px-2.5 13px`. Primary is a blue fill, secondary is border + card,
ghost is text only. Danger recolours an existing level rather than adding a
variant.

**ConfirmButton** — two-step inline, not `window.confirm`. The browser dialog
cannot be styled, blocks the tab, and says nothing about *what* is about to
happen, so people learn to dismiss it. Here the question replaces the button
in place and names the consequence; it resets on blur and on Escape.

**Field** — 40px tall, radius 8. Focus is `border-primary` plus a
`3px primary/15` ring, not a browser outline.

**Status** — a 6px dot and a word, **not** a filled pill. A row of saturated
lozenges competes with the data for attention and reads as decoration; the dot
carries the colour and the label carries the meaning.

**Table** — horizontal separators only. Vertical rules between every column
turn a table into a spreadsheet grid and make it harder to read across a row.

---

## Density

`--row-py` is a document-level variable keyed off `data-density`, so every
table responds without threading a size prop through the tree.

| Setting | `--row-py` |
|---|---|
| compact | 0.5rem |
| comfortable *(default)* | 0.875rem |
| spacious | 1.125rem |

Persisted to `localStorage`. Comfortable lands a 14px row at about 48px, the
usual floor for a target that is both clicked and scanned in bulk.

---

## Navigation

Three levels: **role → workspace → category → feature**.

Workspaces collapse. Categories collapse too, unless you are inside one or it
holds two items or fewer — hiding two links behind a click costs more than it
saves. A hairline spine threads the features with a dot each.

Three things are **hidden rather than dimmed**: features out of the caller's
scope, `optional`-tier features, and unbuilt ones. A disabled menu item is what
makes an ERP feel like a form you failed to fill in. Advanced tools and the
unbuilt roadmap each have their own toggle at the foot of the rail — separate,
because "show me the Tally export" should not also show forty unbuilt screens.

---

## Responsive

Below 640px every table **becomes cards**. `thead` is dropped, each row gets a
border and radius, and each cell prints its column header from `data-label`
through `::before`.

The first cell keeps its weight and skips the label: it is the row's subject —
a name, a receipt number — and repeating "Name" above a person's name is noise.

---

## Print

A school prints all day: receipts over the counter, hall tickets, report cards,
the register for a file. Two rules do most of the work — hide the chrome, and
stop paying for ink on backgrounds — and the rest is making sure a table does
not tear across a page boundary.

- `aside`, `header.chrome`, `.no-print`, dialogs and live regions: hidden
- Backgrounds forced white, text black, borders to 70% grey
- `thead { display: table-header-group }` so headers repeat on page two
- `page-break-inside: avoid` on rows and cards
- Scroll containers forced to `overflow: visible`, or a printout silently loses
  its right-hand columns
- `.print-only` reveals a receipt or hall ticket; `.print-page` gives it a sheet
- `@page { margin: 14mm }`

---

## Motion

`.reveal` — a 4px rise over 0.25s, once on mount, staggered 40/80/120ms.

Deliberately short. A long slide is theatre, and an operator opening the same
screen forty times a day will notice it forty times.

`prefers-reduced-motion: reduce` removes the animation entirely and clamps all
transitions to 0.01ms.

---

## Accessibility

- `:focus-visible` is a 2px `--ring` outline at 2px offset, everywhere
- `--muted-foreground` is pinned at the 4.5:1 threshold (see Colour)
- Density and theme both persist, so a preference is set once
- Tap highlight is suppressed and `touch-action: manipulation` is set on
  controls, so a double-tap does not zoom
