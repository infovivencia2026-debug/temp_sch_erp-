# The bento design system

One document for the board, its tokens, its colour rules, its card vocabulary,
its honesty rules and the traps that have already cost time. Written against
the source as it stands on `operational-erp`; where an older doc disagrees with
the code, the code is recorded here and the disagreement is named.

Two documents remain and are not duplicated:

- `docs/BENTO_CARD_PATTERNS.md` — the product owner's HTML reference for the
  editorial card. Still the contract for the *shape* of a card. Section 4 below
  cross-references it and lists the two places the source has since moved past
  it.
- `docs/BENTO_WIDGET_SPEC.md` — the product owner's per-widget brief: what each
  widget should show at 1x1, 1x2, 2x1 and 2x2. Not restated here; sections 1
  and 6 are the box that spec's size ladder has to fit inside.

---

## 1. The board

**Five columns, three rows, fifteen slots, fixed.**

`web/src/lib/widgets.ts`

```
export const BOARD_COLS = 5
export const BOARD_ROWS = 3
```

Both constants are declared rather than inferred, because the arranger
(`WidgetLayer.tsx`) and the stylesheet (`bento-theme.css`) have to agree about
them and a number that lives in one place cannot drift from the other.

The stylesheet side, `bento-theme.css`, inside `@media (min-width: 1024px)`:

```
.bento-board {
  height: var(--board-h, auto);
  grid-template-rows: repeat(3, minmax(0, 1fr)) !important;
  grid-auto-rows: minmax(0, 1fr) !important;
}
.bento-board > * { overflow: hidden; }
```

Three rows are three rows whatever is on them. An earlier model sized the unit
from the card *count*, so adding one card resized every other card on the
screen — arithmetically correct and chaotic to use. That is gone.

### The four sizes

`MAX_SPAN = 2` in `web/src/features/bento/bento-kit.tsx`. A cell may be **1x1,
2x1, 1x2 or 2x2 and nothing else**. `clampSpan(n)` folds anything larger back
to 2 rather than refusing it, so a wrong number is a slightly small card
instead of a broken layout. `COL` and `ROW` only have entries for 1 and 2.

`spanFor(w, h)` names the four: `one`, `wide`, `tall`, `anchor`. Cells use the
name for typography (the anchor draws a bigger figure); the wrapper owns the
geometry.

The store is deliberately wider than the renderer. `WIDTHS`/`HEIGHTS` in
`widgets.ts` run 1..5 and `DIMS.full` is `{w: 5, h: 1}`, because a layout saved
before the 2x2 ceiling existed must still load. Those numbers never reach the
grid: `drawnDims()` in `WidgetLayer.tsx` runs `dimsOf()` through `clampSpan`
before any fit arithmetic, so the simulation and the picture are about one
board. The steppers walk `STEPS = WIDTHS.filter(n => n <= MAX_SPAN)` — a
control that offers a 3 is offering a width the renderer throws away, and every
later question about whether the board is full is then answered about a board
nobody is looking at.

### How the ceiling is enforced — the `fitted` pack

In `WidgetLayer`:

```
const maxRows = BOARD_ROWS
const fitted = new Set<string>()
{
  const packed: { w: number; h: number }[] = []
  for (const d of candidates) {
    const dim = drawnDims(layout, d.id, d.size)
    if (rowsNeeded([...packed, dim]) > maxRows) continue
    packed.push(dim)
    fitted.add(d.id)
  }
}
const visible = candidates.filter((d) => fitted.has(d.id))
const off = declared.filter((d) => !fitted.has(d.id))
```

Four things about this are load-bearing:

- `candidates` is sorted by `orderOf(...)`, **not** mount order. Cells render in
  source order and are positioned by CSS `order`; simulating the pack against
  the mount order answered a question about a board nobody sees, and diverged
  the moment somebody reordered a card.
- `rowsNeeded(items, cols = 5)` in `widgets.ts` simulates `grid-auto-flow:
  dense` — each item takes the first position it fits in, scanning left to right
  then top to bottom. There is no way to ask the browser this before the fact,
  so it is simulated: same column count, same dense flow, same order.
- `continue`, not `break`. The pack is dense, so a 1x1 further down the list can
  still drop into a gap a 2x1 could not use.
- `visible` and `fitted` are one list. They had drifted: `Widget` rendered from
  `fitted` while the resize check `fitsAt` simulated against everything that
  merely *qualified*, so a card that lost the pack — and was therefore not on
  screen — still took up room in the answer to "can this one grow?". The board
  looked half empty and refused every resize into the gap.

Before this pack the ceiling was advisory. The add button was disabled when the
board was full and a resize was refused past three rows, but `Widget` itself
only checked the removed list, so a dashboard that declared twenty-four cells
drew twenty-four cells, six rows deep.

### `optional`, and why an unfitting widget goes to the tray

`BoardWidget.optional` (`widgets.ts`): *declared but NOT placed by default — it
waits in the add tray.* The board is a fixed fifteen slots; a dashboard with
more cells worth offering than slots to hold them has to choose, and the honest
choice is to ship the core board full and let the rest be added deliberately —
rather than placing everything and letting the overflow squash every row until
the text inside clips. `PrincipalDashboard.tsx` declares roughly two dozen
`optional` widgets for this reason.

`isOn(d)` decides membership in this order:

1. an explicit placement in `layout.placed` always wins — it is a decision this
   person made, and it outranks both the removed list and the widget's default;
2. otherwise a removed widget is off;
3. otherwise `!d.optional`.

Anything that loses the pack lands in `off` and is **offered in the add tray**,
not dropped: the board is capped, not the dashboard. `Layout.removed` is stored
rather than inferred from absence for a related reason — inferring "not in the
list means removed" would hide every newly shipped widget from every existing
user, permanently and silently.

---

## 2. The tokens, and the confusion that cost the most

### The semantics, stated precisely

For each of the twelve domains — `students`, `academics`, `attendance`,
`finance`, `staff`, `admissions`, `communication`, `operations`, `reports`,
`critical`, `warning`, `success`:

| token | is | used as |
|---|---|---|
| `--dom-x` | the **INK** | a mark, a glyph, a hue — a thing drawn *on* a card |
| `--dom-x-soft` | the **PANEL** | the card's own background |
| `--dom-x-text` | the **WORD ON THAT PANEL** | black or white, whichever wins against `-soft` |

`--dom-x-text` is only ever `#000000` or `#ffffff`, in every block of
`bento-theme.css`. It is not a third hue; it is the polarity decision for that
one panel.

The consuming code is `Cell` in `bento-kit.tsx`:

```
backgroundColor: `var(--dom-${domain}-soft, var(--dom-${domain}))`,
color:           `var(--dom-${domain}-text, var(--dom-${domain}))`,
['--bento-muted']: `var(--dom-${domain}-text, var(--dom-${domain}))`,
borderColor: 'transparent',
```

`--bento-muted` is repointed at the card's own ink because it was chosen
against a white card; dropped onto a saturated gold or a deep green it is
neither the ink nor the ground and reads as washed-out and slightly dirty. On a
domain card the hierarchy is carried by size and weight instead — a 10px caps
label against a large figure is in no danger of competing.

### They were used inside out, and this is the expensive part

For a long time `Cell` painted **`--dom-x` as the card**, then fell back to
`--bento-ink` for the text on top of it. That is:

- an ink measured to clear 5:1 *against* the card, used *as* the card; and
- near-black text on saturated blue, purple, crimson.

The measured symptom, recorded at the fix in `bento-kit.tsx`: **2.34:1 to
3.61:1 across the twelve domains, every one of them failing** — a board of
saturated cards that read as a rainbow with unreadable words on it. Fixed in
`dd96b80 The domain tokens were being used inside out`.

Two related faults in the same neighbourhood:

- `826cbc7 The domain inks were never defined in the default theme` — the
  `-text` tokens did not exist, so `var(--dom-x-text, var(--dom-x))` fell
  through to the accent **hue**: coloured figures on every tinted card. All
  twelve are now declared in every block.
- The original `--dom-*` values were paint-chip greys (Platinum, Silver Sand,
  Morning Blue) picked as swatches and then used as ink. On white, academics
  measured 1.17:1 and finance 1.37:1 — not low contrast, an invisible glyph.
  Ten of the twelve failed even the 3:1 large-text floor, and three pairs were
  *identical*: finance/reports, students/attendance, and — worst — critical and
  warning, so an urgent item and a cautionary one drew the same colour in a
  palette whose entire job is telling things apart. Every ink now clears 4.2:1
  against its own panel and 5:1 against the card, and all twelve are distinct.

### Where the tokens live

`bento-theme.css` defines the domain trio in four places: the base
`[data-layout='bento']` block, `html.dark[data-layout='bento']`, the Focus skin
in both polarities, and the default palette block at the end of the file.

**The default palette block is last and wins.** It re-opens plain
`[data-layout='bento']` at the bottom of the file with the supplied reference
palette: a near-black page (`--bento-bg: #10110f`), paper cards
(`--bento-card: #efede5`), and six grounds that carry the hue. In that block
`-soft` **equals** the base token, because these *are* the card colours, not
tints to be derived from an accent — anything reading `-soft` gets the same
surface it would have got from the base token. `--dom-staff` and
`--dom-reports` are `#003d32` with `-text: #ffffff`; every other domain takes
black. Measured worst pair 5.44:1, on the red. Shipped in `0772fb0`.

Because that block has the same specificity as the light "Ethereal" block at the
top of the file and comes later, the top block's `--bento-*` and `--dom-*`
values are effectively superseded on the default surface. The dark block still
wins under `html.dark` (higher specificity) and Focus still wins under
`html[data-skin='focus']`.

### The four shipped palettes

`BUILT_IN_PALETTES` in `web/src/lib/paint.ts` — four, two per mode
(`ee7695c`): **Porcelain Amber** and **Daylight Azure** (light), **Obsidian
Amber** and **Midnight Azure** (dark). `applyPalette(name)` *replaces* the
hand-painted regions rather than layering under them: picking a whole palette is
a decision about the whole surface, and leaving three regions from the last one
on top of it is the mismatch it was meant to end.

Two contrast faults the palettes inherited are fixed in CSS rather than with a
new token, at the end of `bento-theme.css`:

1. `--bento-muted` is one value measured against one ground. On the anchor's
   gradient it falls to 2.23:1, on the inverted cell 3.42:1, on the paler domain
   tints as low as 2.56:1 — and no palette could have fixed it, because one
   token cannot be correct against fourteen grounds at once. On those cells it
   is derived from the cell's own ink instead; worst case across all four
   palettes is 5.26:1. The plain card is deliberately left alone.
2. A badge sits on `--bento-<hue>-tint`, not on the card. Each accent clears
   4.5:1 against the card (4.66-4.81:1) but only 3.90-4.30:1 against its own
   tint, and as little as 2.80:1 on the dark palettes. Mixing the accent 60%
   toward the ink keeps the hue unmistakable and lifts the worst pairing to
   4.80:1. The tint itself is untouched, so a badge still looks like a badge.

---

## 3. The colour rules

**Rule 1 — text and figures are black or white, chosen by measuring against the
ground.** Nothing on this surface is coloured text. (`aafdd36 Text is black or
white, picked by what it sits on`.)

`inkFor({h, s, l})` in `widgets.ts` is the measurement for a user-chosen tint:
WCAG relative luminance, returning `#101114` above 0.179 and `#ffffff` below —
explicitly *not* an HSL-lightness threshold, because HSL lightness is not
perceptual and a fully saturated yellow at `l=50` is far brighter than a blue at
the same `l`, so a naive `l > 55` test puts white text on it. `ACCENT_INK` in
`bento-kit.tsx` is `text-[var(--bento-ink)]` for all four accents, kept keyed by
accent only so a future accent has somewhere to put a different answer.

**Rule 2 — marks in drawings are `currentColor`.** `currentColor` is the ink the
cell has *already* resolved for its own ground: `--bento-ink` on a plain card,
`--bento-anchor-ink` on the gradient anchor, `--bento-bg` on an inverted card,
`--dom-*-text` on a domain-tinted one. A mark built on it cannot lose its ground
the way a named colour can.

In `bento-cards.tsx` this is total — the file's only colour expression is:

```
const ink = (pct: number) => `color-mix(in srgb, currentColor ${pct}%, transparent)`
const MARK = ink(88); const TRACK = ink(10); const QUIET = ink(38)
```

In `bento-kit.tsx` and `bento-viz.tsx` an accent is never drawn on its own; it
is always mixed *into* `currentColor`, so a mark is a hue cast over an ink that
already read. **55% is where the mix stops**, and it is measured rather than
chosen: across the default light and dark themes, the Focus skin in both
polarities and all four `BUILT_IN_PALETTES`, the worst pairing at 55% is
**3.61:1** (mint on the default light card) and every other pairing lands
between 5:1 and 14:1. 3:1 is the floor for a graphical mark. This also fixed a
real failure — `bento-viz` used to draw in literal `var(--bento-ink)`, which on
an inverted cell is the ink *on* the ink, and two shipped dashboards have an
inverted cell.

The four hues keep the meanings `Accent` already gave them: **mint** money in /
arrived / present / done; **pink** money out / outstanding / at risk; **orange**
pending or in caution; **purple** the measurement itself — a quantity with no
valence. Nothing picks a hue for variety.

**Rule 3 — no drawing may name a colour at all, including `--bento-card`.**

This is the subtle one and it cost two bugs. `currentColor` covers the
*foreground*. A drawing that needs a **background** has no honest token: there
is no variable that names "the ground this particular cell is sitting on",
because that ground may be paper, a domain panel, an inverted cell or a
gradient. So the instinct is to reach for `--bento-card` — paper — which is
right on exactly one cell type and wrong on the rest.

- **The gauge.** `Gauge` was a conic gradient with a disc punched out of the
  middle, and that disc had to be painted *some* colour. It was painted
  `--bento-card`: a paper-coloured hole on a domain-tinted card, a pale disc on
  a dark ground on an inverted one. It is now an SVG **stroked arc** — a stroke
  has no hole to fill, so the ground shows through whatever the ground happens
  to be. `pathLength={100}` so the dash array is literally the percentage, with
  no circumference arithmetic to get wrong when the radius changes.
  (`84cc6b9 The gauge punched a paper-coloured hole in a coloured card`.)
- **The funnel label.** `Funnel` drew its label *inside* the bar, so it had to
  be painted in the cell's background colour to read against the fill — same
  `--bento-card`, same wrongness. The label now sits **outside** the bar, where
  it is ordinary ink and needs to know nothing about the ground.

The same reasoning appears in `bento-kit.tsx`, where a sparkline's endpoint dot
is haloed with `wash(accent, 26)` rather than a card colour, "because on a
domain-tinted cell there is no token that names the ground".

**Rule 4 — colour is never the only channel.** A heat cell carries its value in
`title` and in the label the screen reader is given; a segment prints its share
as a number; a quadrant point carries its position, which is the actual claim.
`srLabel` is required on every drawing in `bento-viz.tsx` and is *stated*, not
summarised away. Every drawing in `bento-cards.tsx` takes `srLabel` and carries
`role="img"` — `Facts` is a `<dl>` with `aria-label`, since it is real text.

**Rule 5 — no animation in the drawings, at any motion preference.** There is
nothing to reduce.

---

## 4. The card vocabulary

`docs/BENTO_CARD_PATTERNS.md` is the contract;
`web/src/features/bento/bento-cards.tsx` is the implementation. Read them
together.

### The shell

`CardShell` is `grid-rows-[auto_auto_minmax(0,1fr)]`:

| row | contents |
|---|---|
| header | title, 11px bold, one line, truncated; optional `sub` at 8.5px uppercase, tracked, 60% opacity; optional circled glyph, 22px, `aria-hidden` |
| value | the figure at `clamp(24px, 3.4vh, 38px)` (overridable via `--bento-fig`), `leading-[0.9]`, `tracking-[-0.05em]`, tabular; optional `change` line at 9.5px beneath |
| drawing | `minmax(0, 1fr)` and `overflow-hidden` |

**The drawing row is a fraction, not a fixed height.** That is the whole point:
the drawing grows with the cell instead of leaving dead space under the number,
so a large cell is not a small cell with a gap in it. `min-h-0` on the row is
load-bearing — without it a grid child refuses to shrink below its content and
the drawing pushes the card out of shape.

### The drawings

Twelve exports in `bento-cards.tsx`:

| name | shape | reads as |
|---|---|---|
| `Line` | open path, round caps, no fill, non-scaling stroke | trend |
| `Area` | the same with `ink(14)` beneath | magnitude + trend |
| `Bars` | flex row, bottom-aligned, rounded tops, optional `activeIndex` | period comparison |
| `Rows` | label · track · right-aligned figure, one shared scale | ranked composition |
| `Gauge` | stroked arc from twelve o'clock, `pathLength=100`, percentage printed | one proportion |
| `Stack` | bottom-aligned columns split into segments at `ink(88 - j*26)` | composition over periods |
| `Distribution` | bars whose heights describe a curve, not a ranking | spread, density |
| `Compare` | two labelled tracks against one scale, before over after | plan vs actual |
| `Facts` | a `<dl>` of label/value pairs, ruled, right-aligned tabular values | the figures around the headline |
| `Funnel` | bars narrowing downward, label outside the bar | pipeline conversion |
| `Scale` | a hairline with one dot placed along it | a single value in range |
| `Flow` | short dashes, each row indented 16px from the last | movement between states |

Every one returns `null` on empty input — `points.length < 2`, `!values.length`,
`total <= 0`, `max <= min`, `rows.length < 2`.

**`big` is excluded, deliberately.** It is the figure at a larger size, and the
figure already has a row of its own. Every drawing here has to add something the
number does not.

**`Density` was deleted after three attempts, and `Facts` replaced it.**
(`9e6b156 A drawing with no variation in it is not a drawing`, after `5fcefc5
Blocks, not dots` and `9e3c53a A segmented rail, not a field of marks`.) Dots,
then blocks, then a segmented rail — three restylings of the mark, each reported
as uninformative. The mark was never the problem: nearly every caller passed

```
Array.from({ length: n }, () => 1)
```

— every value identical. A picture built from that can only restate the number
already printed above it, so all three were faithful renderings of nothing.

A cell whose data is one number does not have a chart in it; it has *context*,
and the context was already fetched. `Facts` sets those real figures as a list:
the roll now says its sections, its per-section average and its staff; my-work
says its sections, section work and own work; the finance count cards carry
their own sentence. Three of the ten call sites did have real variation and got
a real drawing instead — fee defaulters against the rest of the roll, and
sections without a timetable against those with one, both as `Rows`; the setup
field as `Rows` of its five domains, which is the structure the steps actually
have.

### Where the source has moved past `BENTO_CARD_PATTERNS.md`

- That doc's twelve-drawing table still lists **`density` — "a dot grid, opacity
  per cell"**. There is no `Density` export. The twelfth drawing is `Facts`.
  **Source wins.**
- That doc describes `gauge` as **"conic ring with a punched centre"**. It is a
  stroked SVG arc, and the punched centre is precisely the bug in section 3.
  **Source wins.**

### The companion vocabulary

`bento-viz.tsx` holds six further drawings — `Ring`, `SegmentBar`, `AgeBands`,
`HeatStrip`, `Timeline`, `Quadrant` — deliberately in their own file: the kit is
the vocabulary four dashboards already import, and adding to it is how a shared
component acquires a second owner. Nothing there is imported by the kit and
nothing there edits it. They **hide rather than shrink**: `useRoom(minW, minH)`
returns false below the room a drawing needs and the drawing returns `null`, so
the cell is simply a cell.

---

## 5. The honesty rules

These outrank density. `BENTO_WIDGET_SPEC.md` states the principle; what
follows is the ledger.

### No fabricated denominators — the ones that shipped and were removed

Three have shipped and been removed, and a fourth was caught in review. Each is
worth naming, because each is the same mistake in different clothes.

**1. The principal board's `billed`.** Derived in the frontend as
`collected_paise + outstanding_paise`. `internal/api/role_principal.go:28-40`
documents why that is wrong and returns `billed_paise` so nobody has to:

- `collected_paise` is receipts **banked inside the requested range**, whatever
  year's invoice they settle — a **period flow**;
- `outstanding_paise` is **every unpaid invoice of every year**, arrears carried
  in from earlier years included — an **all-years level**.

One is a flow, the other a level, and their sum is neither. Every figure on the
two money cells was drawn against that base under captions that all said "this
year", so the percentages were wrong and so were two of the amounts — the
collected total and the outstanding total were the range and all-years measures
wearing a this-year label. Replaced by the year-consistent triple the handler
already returned: `billed_paise`, `collected_year_paise`,
`outstanding_year_paise`. (`e819057`; `billed_paise` had been sitting unused in
the response the whole time.)

**2. The finance board's `expected`.** The same shape:
`expected = month_paise + outstanding_paise` — a period's **receipts** added to
an all-years **balance** — headlined as a percentage captioned "of X billed"
when nobody had computed a billed total. `role_backoffice.go` carries **no
billed total and no target**, and neither does anywhere else in this product's
finance data, so there is no "target progress" and no "% collected" anywhere on
that board. The derivation is gone and the comment at
`FinanceDashboard.tsx:57` exists to stop it coming back.

**3. The year trio reading zero.** Not an invented base, but the same family of
lie, and the reason the fix to (1) was not the end of it. All three year fields
are scoped to `academic_year_id = (the current year)` and `COALESCE`d to 0, and
on this data **no invoice carries an academic year at all: 270 invoices, zero in
the current year.** So a school with real money on its books was shown ₹0
collected, and a zero from `COALESCE` is indistinguishable from a real one.
(`37a4c21 Do not print zero when the answer is "not recorded that way"`.)

The rule now, in `PrincipalDashboard.tsx`:

```
const yearly = k.billed_paise > 0
```

When there *is* a billed figure for the year, use the year trio and say "this
year" — the only framing with a real denominator. When there is not, fall back
to the measures that are always populated (receipts banked in the range, arrears
of every year), **drop the "this year" wording, and draw no rail and no
percentage**, because neither has a denominator and adding them together to
invent one is bug (1).

*Known and unfixed, recorded in that commit:* five academic years have
`is_current = true`, so the handler's `ORDER BY is_current DESC, starts_on DESC
LIMIT 1` picks one of five arbitrarily. Even once invoices carry a year, that
tie makes the trio answer for whichever year sorts first rather than the one in
progress.

**4. Caught in review — an attendance target.** Every comparison on the pulse
cell is the school against its own month. There is no stored attendance target,
and one invented to give the card something to say "would be the fourth
fabricated denominator this product has had to remove"
(`PrincipalDashboard.tsx:2625`).

### The corollary: draw the count, not a made-up share

Four principal cells have no denominator anywhere in `/principal/dashboard` —
the roll, open applications, unassigned subjects and pending approvals are
counts with no whole in the response to be a share of. They get a **unit grid**:
one mark per unit, the unit stated in the line under the figure and in the
screen-reader label. A bigger cell buys a **smaller unit, not an invented
total**. `sections` is not a denominator for students, `staff` is not one for
unassigned subjects, and a funnel drawn from a single undecided-application
count would be three made-up numbers.

Above `TALLY_MAX` the marks stop being countable and start being a smear, so
nothing is drawn rather than a field that misreports its own length by being
cut. Nothing at 1x1 either — the smallest card spends its height on the figure
and the facts.

### A breakdown must sum to its own headline

`2d3e679 Return the denominators the query was already scanning` added five
totals the SQL was already walking the rows for, rather than letting the
frontend derive them, and each was verified to **reconcile** with the scalar it
belongs to rather than merely looking plausible:

```
class_subjects_total         unassigned is a strict subset — "72 of 120"
open_applications_by_status  parts sum to open_applications  (18 = 18)
pending_leave_by_type        requests sum to pending_leave   (34 = 34)
students_by_class            parts sum to the roll           (307 = 307)
outstanding_ageing           six buckets add back to outstanding_paise
```

The reconciliations are the point: *a breakdown that does not sum to its own
headline is a second, quieter version of the same bug.* Four judgements from
that commit worth keeping:

- `admissions_funnel.go`'s existing enquiries/applied/offered/admitted shape was
  **not** reused: there `admitted` means `status='accepted'` over all
  applications ever, while this set excludes `accepted` by definition. Borrowing
  the words would have shipped `admitted: 0` permanently and given `offered` a
  narrower meaning than the same word on the admissions screen.
- `students_by_class` picks one enrollment per child through a `LATERAL`,
  because the unique key is `(student_id, academic_year_id)`: a stale active row
  from last year would count a child twice and break the sum.
- `outstanding_ageing` keeps not-due and undated as **buckets** rather than
  dropping them, so the six add back exactly. Ageing runs from `due_on`, so an
  invoice due today sits at the bottom of 0-30 while `defaulters` is strictly
  past due — two different questions, not a disagreement.
- `year_invoice_count` is always sent and never omitted, *because zero is the
  message*: it is the same rows and predicate as the year trio with a different
  aggregate, so a client can say "no year-scoped data" instead of "₹0 billed"
  without anyone loosening the year predicate to make the number move.

### Empty data draws nothing

An empty array renders `null`, never a confident zero. A ring at 0%, a bar of
one flat segment and an empty heat strip all *look like measurements*, and "we
have no rows for this" is not a measurement. A denominator of zero is the same
refusal. Every drawing in `bento-cards.tsx` and `bento-viz.tsx` guards this.

The same rule one level up, at the cell: a fetch that **failed** must not be
able to render as a nought, because a nought reads as "nothing to do". The
attention cells keep three states apart for exactly this.

### Truncated lists say so

The finance overdue list is capped at 300 rows server-side. When it comes back
full, the cell prints how much of the overdue money the bands actually cover —
`bento.finance.ageing_capped`, guarded on `rows.length >= CAP`. The same for a
ranked top-N (`bento.finance.dots_capped`, `{shown, total}`). A truncation that
changes the answer has to be visible in the answer.

### A summary must not change when you look at it differently

`44dfedf`: the leave tiles counted the rows the filter had left on screen while
reading as totals — with the filter on "pending", Approved showed zero at a
school that had approved several. A summary that changes when you filter the
list underneath it is not a summary.

### Do not clamp bad data into looking fine

`17d5e5f`: nothing tied a mark to its exam subject's `max_marks`, so 50 on a
paper out of 20 was stored happily, and every screen that divides by `max_marks`
reported it faithfully — 169% averages, subject averages of 148-190%, a range to
250%. None of those screens was wrong. Rounding or clamping in the UI would have
been the worst available fix: it would have hidden the only evidence that the
data was broken. The rule rejects at the API, names the paper and its ceiling,
and a migration adds the database-level guard.

---

## 6. The traps

Each of these has already cost real time.

**1. Cells are `overflow: hidden`. Content that does not fit is CUT, not
scrolled.** `.bento-board > * { overflow: hidden; }` in `bento-theme.css` is
described in the source as "the backstop": the shedding rules are the plan, and
this stops a card that still holds too much from pushing the grid out of shape.
There is no scrollbar to rescue you and no ellipsis you did not write yourself.
Design for the height you have.

**2. `detailFor` collapses on area, so 2x1 and 1x2 get the same answer.**
`web/src/lib/widget-size.ts`:

```
export function detailFor({ w, h }: WidgetSize): Detail {
  const area = w * h
  if (w <= 1 || area <= 2) return 'abstract'
  if (area >= 8) return 'rich'
  return 'normal'
}
```

2x1 and 1x2 are both area 2, so both come back `'abstract'`. They are not the
same cell: one has the width a trend line needs and no height, the other the
reverse. **A cell that should change DRAWING rather than shed parts has to read
`useWidgetSize()` and switch on the shape itself.**

`pulse` is the template (`353f5bd Dispatch on shape, not on area`): 1x1 the
figure plus whether today sits above or below its own 30-day median, because a
thirty-point line at 264px is a squiggle, not a chart; 2x1 the figure and the
line, since width is exactly what a sparkline wants; 1x2 the same stacked with
the supporting sentence back; 2x2 all of it over the month-of-days calendar,
which only earns its keep at full size. `bento-viz.tsx` reads `useWidgetSize`
directly for the same reason — "almost all of these need WIDTH". Note the
context fallback is `{w: 2, h: 1}`, so a cell rendered outside any `Widget` sees
2x1.

**3. `preserveAspectRatio="none"` turns circles into lozenges.** The cells are
not square, so a stretched viewBox stretches everything drawn in user units.
Three consequences already hit:

- A sparkline's endpoint dot is drawn as a **zero-length round-capped line**,
  not a `<circle>` — a circle in user units came out as a flat ellipse thirteen
  pixels wide at a 2x cell. A round cap is a screen-space circle whatever the
  transform does. Same reason every stroke in these files sets
  `vectorEffect="non-scaling-stroke"`.
- `Ring` in `bento-viz.tsx` is the one drawing that **keeps the default**
  `preserveAspectRatio`: a circle stretched to a 264x172 cell is an ellipse, and
  an ellipse's arc length no longer tracks its angle, so the drawing would
  misreport the number it exists to report.
- `Quadrant`'s frame is a CSS `border-radius` box, not a `<rect rx>`: an `rx`
  inside a `preserveAspectRatio="none"` viewBox is a squashed ellipse at one
  size and a circle at another. A border-radius does not stretch.

Use `preserveAspectRatio="none"` for pure geometry — an axis, a cross, a
line — and nothing else.

**4. A fraction of an indefinite height becomes max-content, so every board must
set `--board-h`.** `repeat(3, minmax(0, 1fr))` over a board with no definite
height silently resolves to max-content: you do not get three equal rows, you
get three rows all sized to the tallest one's content, *including the empty
ones*. That is a blank band the height of a card under any board that does not
fill all fifteen slots.

`useBoardHeight()` in `bento-kit.tsx` is the fix, and **every `.bento-board`
needs it** — the persona boards render their own `.bento-board` and for a while
only `BentoPage` was measuring. It measures rather than computes from constants,
because the board's top edge moves with the header, the text-size axis and the
density:

```
const room = Math.max(240, window.innerHeight - top - 16)
board.style.setProperty('--board-h', `${Math.round(room)}px`)
```

`window.resize` alone is not enough — the dock, the density and the text size
all move the top edge and none of them fire a resize — so a `ResizeObserver` on
`document.body` catches every cause without this file having to know what they
are. While arranging, `.bento-board:has(> .bento-arrange-bar)` gives the first
row its natural height so the toolbar does not eat a full 1fr.

**5. The substitution board returns bare `HH:MM`, which lands in 1970 if parsed
alone.** `starts_at` is `to_char(p.starts_at,'HH24:MI')` — `'09:15'`, a
wall-clock time with no date on it. `new Date('09:15')` is Invalid Date in every
browser, and the variants that do parse put **every period of the day on the
same instant in 1970**, collapsing the axis to a point.

So no `Date` is built from it anywhere. A period's position is its **minute of
the day**, an integer, and every axis is an interval of minutes:

```
const HHMM = /^(\d{1,2}):(\d{2})/
function minuteOfDay(clock)   // hh*60+mm, or null
const clockText = (mins) => ...
```

The board's own `on_date` says which day those minutes belong to, and is used
for exactly one thing: deciding whether the now-marker may be drawn at all.

Related, on the same cell: **the denominator is `summary.periods`** — the
periods today's absences left behind, counted by the handler. With nobody away
it is zero, and a zero denominator draws no proportion; it draws the sentence
that says so.

**6. A drawing row on a 1x1 is only about 70px tall.** The header and figure
take their natural heights and the drawing row gets whatever is left — roughly
**70px on a one-row cell, about 240px on two** (`PrincipalDashboard.tsx:2664`).

`Gauge` is `aspect-square`, sized off the drawing row's **width**, and draws up
to 104px across — so on a one-row cell the bottom third is cut off by the cell's
own `overflow: hidden`. **A ring is only ever drawn where there are two rows of
height.** On one row the same proportion is drawn as `Compare` or `Rows` — two
or three tracks against a shared scale, which read at any height a track fits
in.

*(The brief for this document quotes ~69px; the source comments say "about
70px". Both are the same measurement rounded — the number is not a constant
anywhere in the code, it is what is left after the header and figure rows.)*

---

## Appendix: source comments that contradict the code

Recorded so nobody trusts them. None of these is a behaviour bug; all are stale
prose from the four-column era.

- `web/src/lib/widgets.ts`, file header: *"The board is four columns"*, listing
  five named sizes including `full 4x1`. The board is **five** columns
  (`BOARD_COLS = 5`) and `DIMS.full` is `{w: 5, h: 1}`. `full` is unreachable on
  screen in any case: `clampSpan` folds it to 2 and `SPAN.full` is an alias of
  `wide`.
- `web/src/features/bento/bento-kit.tsx`, above `MAX_SPAN`: *"Four widths, and
  only four, because the board is four columns"*, and *"on a four-column
  board"*. Five columns; and the only widths that survive the clamp are 1 and 2.
- `bento-kit.tsx`, above `BentoPage`: *"the 4-column grid… four columns above
  `lg`"*.
- `widgets.ts`, `applyPreset`: the `spotlight` preset places the first card at
  `{w: 3, h: 2}`. That 3 is clamped to 2 before it is drawn or packed, so
  spotlight's hero is a 2x2 — the stored value is simply larger than the board
  can express.
