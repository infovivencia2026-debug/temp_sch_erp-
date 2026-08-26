# The Bento layout, behind a switch

An experimental dashboard language, opt-in, running beside the current one.

## The rule that makes this safe

**The classic UI is not edited. Not a class, not a token, not a component.**
It is the default, and an account that never touches the switch must render
byte-identically to how it renders today. Every Bento screen is a *new file*
that sits beside the existing one; the router picks between them.

If a Bento screen needs something from a shared component, it copies or wraps —
it does not change the shared one. The moment we edit `ui.tsx` to suit Bento,
the experiment has cost us the thing we were protecting.

## The switch

`user_display_preferences.layout` — `'classic' | 'bento'`, default `'classic'`.
It joins theme, density, locale, high_contrast and reduce_motion on the row that
already exists, and rides the same `GET/PUT /api/v1/portal/preferences/display`
endpoint. One row, one save.

Mirrored to `localStorage` under `erp.layout`, exactly as `Shell.tsx` already
mirrors `erp.theme` and `erp.density`, so the device and the account cannot
disagree and a reload does not flicker.

Two buttons in the header, side by side, labelled **Classic** and **Bento**.
Deliberately not a dropdown: this is for testing and the point is that both
states are one click apart and visibly distinct.

## The layout

A **4-column grid**, 16–24px gaps, generous internal padding. Cells are
declarative: `span={{ col: 2, row: 2 }}`.

**One anchor cell per dashboard**, 2x2 or 2x1, carrying the highest visual
weight and the thing that persona opens the page to see:

| Role | Anchor |
|---|---|
| Student | today's schedule, live |
| Parent | the child's week — attendance, dues, what is owed |
| Faculty | today's classes and what needs marking |
| Institution Admin | attendance and fee collection against target |
| Finance | collection against expectation, ageing |

Everything else is a 1x1 supporting cell.

## Progressive disclosure

A cell shows **one number and one shape** — a figure and a sparkline, a
percentage and a trend. Never a table. The detail lives one interaction away
behind an explicit cue, and that interaction opens the screen that already
exists rather than a second implementation of it.

The test: if a cell needs a scrollbar, it is the wrong cell.

## Glassmorphism, narrowly

`backdrop-filter: blur()` on **transient floating elements only** — a
quick-action panel, a notification, a contextual drawer. A subtle
semi-transparent border sells the refraction.

**Never** on a text container, a data table, or anything a person reads for
longer than a glance. Legibility outranks the effect every time, and blur is
expensive to composite — a dashboard that stutters on a school's five-year-old
desktop has failed regardless of how it photographs.

Honour `reduce_motion`: when it is set, no blur transitions, no entrance
animation. That preference already exists and already means this.

## Contrast polarity

Light cells for anything read as text — notices, receipts, checklists,
syllabus. Higher acuity, faster reading.

Dark cells for a chart whose point is the shape: bright data on a dark ground
draws the eye first. Use it for the one or two metrics that matter most, not
decoratively — if half the dashboard is dark, nothing is emphasised.

Both must satisfy the existing tokens and pass AA. `--success`, `--warning` and
`--info` were each darkened this month to clear 4.5:1; a Bento cell that
reintroduces a raw hex undoes that work.

## What must still be true

- Card bodies keep their padding; a `Table` inside a padded body double-insets.
- A failed query renders an error, never an empty state that reads as a fact.
- Any form editing a record carries `key={record.id}`.
- Unlabelled controls take `srLabel`.
- Every string goes through the i18n catalogue.
- Nothing renders a figure the caller's scope does not permit. A prettier
  dashboard that leaks another child's marks is worse than a plain one.

---

## How a cell's size is decided

Three things, in order.

**1. The stored size.** Each widget is `{ id, w, h, tint? }` in `localStorage`
under `erp.widgets.<dashboard>`; `w` and `h` are integers 1–5. A widget absent
from that list falls back to the size its dashboard declared:

| declared | w × h |
|---|---|
| `small` | 1 × 1 |
| `tall` | 1 × 2 |
| `medium` | 2 × 1 |
| `large` | 2 × 2 |
| `full` | 5 × 1 |

Removal is stored, never inferred from absence — otherwise every widget added
later would be hidden from every existing user, silently and permanently.

**2. Grid geometry.** Five columns at ≥1024px, two at ≥640px. A width is
capped at two below `lg`: a five-wide card on a two-column grid overflows the
page rather than filling it.

**2a. Below 768px the board is paged, not stacked.** A phone gets a home
screen: a fixed **two columns by three rows**, one page at a time, swiped
sideways, with page dots between the last row and the dock. A page never
scrolls in either direction — that is the whole contract, and it is the same
claim the desktop board makes, made per page.

Both spans clamp to 2, which on a two-column page means a 2-wide card is a full
row of the page and a 2×2 is a third of it. Nothing is ever wider than a page.

**Overflow opens a page; it does not drop a card.** This is the one behavioural
difference between the two boards. At ≥768px the board is fifteen slots and a
widget that will not pack into them is dropped to the add tray — the board's
promise is that everything on it is visible at once. Below 768px nothing is
dropped, the pack simply turns a page, and `off` (and therefore the add tray)
holds only what this person removed by hand. Anything reading "not fitted ⇒
offered in the tray" is a desktop statement and must not be generalised.

Paging is **read-only**. On a phone, entering arrange mode drops back to the
stacked scrolling board, because a 2×3 page has no spare row for the toolbar
and no room for the per-card controls. Moving a card between pages needs a
stored page index that `layout.placed` does not have.

`PHONE_COLS`/`PHONE_ROWS` in `lib/widgets.ts` and the `max-width: 767px` block
in `bento-theme.css` must agree, exactly as `BOARD_COLS`/`BOARD_ROWS` and the
`min-width: 1024px` block already do. The page count is computed in JS
(`paginate`) because CSS cannot count pages; `lib/viewport.ts` is the only
sanctioned place to ask how wide the device is.

**3. Row height.** Every row is `minmax(0, 1fr)` — an equal share of the height
left below the header.

```
row height = (board height − (rows − 1) × gap) ÷ rows
col width  = (board width  − 4 × gap) ÷ 5
```

`gap` is `--bento-gap`, and it is set in the same CSS rule the arithmetic reads
it from. When it was not — the persona boards used a `gap-5` utility while the
row height was derived from the token — every ratio on those screens was wrong.

### W:H is a proportion, not an aspect ratio

A 2×2 is twice the width and twice the height of a 1×1. A 1×1 is a landscape
rectangle, not a square.

Squares were tried and reverted. On a 1600×900 laptop the board is 1544×660 and
one column is 297px, so only **two** 297px rows fit above the fold: 15 of the 25
sizes needed scrolling to reach, and the board ran off the bottom of the screen.
Fitting the screen beat literal squareness. If squares are ever wanted again the
lever is fewer columns or a taller window, not a different formula.

## How contents follow the size

Two mechanisms, deliberately separate.

### CSS shedding — the general case

Keyed to `data-w` / `data-h` on the widget wrapper, so one rule covers every
cell and thirty hand-written cells did not each have to learn how to be small.

| Condition | What goes |
|---|---|
| `w = 1` | the supporting sentence; the label truncates to one line |
| `h = 1` | the meter |
| any size | **nothing else** |

The label, the figure and the cue survive every size. A card that has dropped
its own subject or its way out is not a smaller card, it is a broken one.

The figure is `min(what the text-size axis asks for, 26cqw, 34cqh)`, so it grows
until the card runs out and can never overflow it. Measuring the card means
`container-type: size`, which is only safe at `lg` where the row height is
definite — below that the contents *are* the height and the same declaration
would collapse every card to nothing.

### Detail levels — where shedding is not enough

Shedding removes parts. A chart needs to become a **different drawing**: ten
labelled bars in a 1×1 is not a small chart, it is an unreadable one.

`useDetail()` from `lib/widget-size.ts` returns one of three levels:

| Level | When |
|---|---|
| `abstract` | `w ≤ 1` or `w × h ≤ 2` |
| `normal` | otherwise |
| `rich` | `w × h ≥ 8` |

Three named levels rather than a raw number, because thirty cells each deciding
what "small" means is thirty different answers to one question.

Applied so far:

| Component | abstract | normal | rich |
|---|---|---|---|
| `Bars` | last 5 days, no labels, short | as designed | full height, all labels |
| `Sparkline` | last 10 points, short | as designed | taller, more vertical range |

`Meter` and the stat cells are not size-aware and do not need to be — shedding
covers them. Add a level only where a drawing genuinely changes shape.

`useDetail()` returns `normal` for a cell rendered outside a widget, so anything
not yet wrapped behaves exactly as it did before.

### Why the mechanism lives in its own module

`lib/widget-size.ts` contains no components. A hook exported alongside
components makes Vite refuse Fast Refresh and fall back to invalidating the
module — which rebuilds the context object and detaches every consumer from its
provider. In dev that looks precisely like the feature being broken, and it cost
an afternoon once already.
