# Customizing the board

Every dashboard in the web app — the principal's, finance, the teacher's
day, the parent's week, and the rest — is a **board** of cards, and every
board can be rearranged by the person looking at it. One mode does it on the
phone and on the desk, the way iCloud's *Customize Home Page* does: while the
mode is on, each card wears a remove button and a size pill, cards drag
directly, and one toolbar at the foot of the screen holds everything else.

This page is for two readers: someone using the board, and someone adding a
card to a screen or changing how the mode works. The user half comes first.

## For users

### Getting in

| Where | How |
|---|---|
| Phone | Hold any card for half a second; or tap the pencil beside the page dots. |
| Desk | The **Edit** pill at the foot of the board; or the Home tab's context menu. |
| Anywhere | Settings › Dashboard › **Customize board**. On a phone that opens the home screen with the mode already on. |

The first time a board that has never been arranged is on screen, a one-line
hint appears — *Hold a card to customize* beside the first card on a phone,
*Customize your board* over the Edit pill on a desk. It goes away when
tapped, after eight seconds, or the moment you enter the mode, and it does
not come back for that board.

### While you are in

- **Remove** a card with the button at its top-left. It is not lost: it waits
  in the Add gallery.
- **Resize** a card with the pill at its bottom-right. The sizes are named:

  | Size | Desk (5 × 3 board) | Phone (one page = one column, two rows) |
  |---|---|---|
  | Small | 1 × 1 | half a page |
  | Medium | 2 × 1 | — (reads as Small) |
  | Large | 2 × 2 | a whole page |
  | Wide | 3 × 1 | — (reads as Small) |

  A size that would push the board past its three rows is shown but disabled
  — the desk board is a fixed fifteen slots and never scrolls. A phone adds a
  page instead, so every size fits there.
- **Colour** a card from the last row of the same menu. The hue you pick is
  painted as a quiet panel, not a fill, so the card's text stays readable in
  both themes.
- **Move** a card by dragging it. On a phone, hold it for a moment first; it
  lifts, the pager stops snapping, and holding it at the edge of the screen
  turns the page. The phone's toolbar also has **Reorder**, a list you can
  drag rows in — the quickest way to bring page four's card to page one.

### The toolbar

**Done** · **Undo** · **Add** · **Layouts** · **Tidy** (desk) or **Reorder**
(phone) · **Reset**

- **Undo** takes back the last change, once. It is not kept across reloads.
- **Add** opens the gallery: every card that is off the board, as a preview
  tile with its name and a row of sizes. Pick a size and it lands on the
  board; the gallery stays open until nothing is left to add.
- **Layouts** applies a whole arrangement in one go — *As designed*,
  *Compact*, *Spotlight*, *Banner*, *Even*, *Columns*, *Panels*. Each is a
  rule over whatever the board declares, so they work on every dashboard and
  keep working when a card is added later. Colours and removals are kept.
- **Tidy** sorts the board largest-first so the packing has no holes. It
  changes nothing but order.
- **Reset** forgets everything for this board and returns it to the product's
  default. Undo does not reverse a Reset.

### From Settings

Settings › Dashboard lists every card the open board can show, with a switch
(on the board or not), its current size as a word, and a size select. The
select offers the same sizes as the pill on the board and disables the same
ones. **Reset layout** appears once anything has been changed.

### Keyboard

- **Escape** leaves the mode — or closes whatever menu or gallery is open on
  top of it first.
- Entering the mode puts focus on **Done**; leaving it returns focus to the
  pencil or pill you came in by.
- The size pill and the Layouts button are ordinary menus: arrows move,
  Enter picks, Escape closes.

### Where it is kept

The arrangement is stored in the browser, per dashboard, under the
localStorage key `erp.widgets.<dashboard>` — not on your account. A layout is
bound to the screen it was arranged on, so tidying a laptop board does not
rearrange the same person's desk monitor. An untouched board stores nothing;
Reset removes the key. The hint above remembers itself under
`erp.coach.customize.<dashboard>`.

## For developers

### The pieces

| File | What it holds |
|---|---|
| `web/src/lib/widgets.ts` | The store: `useLayout(dashboard)` (place, remove, resize, `setTier`, recolour, move, reset, undo, tidy, `applyPreset`), the published board (`publishBoard`, `useBoard`, `setArranging`, `requestArrange`), the packers (`rowsNeeded`, `paginate`) and the two boards' dimensions (`BOARD_COLS`/`BOARD_ROWS`, `PHONE_COLS`/`PHONE_ROWS`). |
| `web/src/lib/size-tiers.ts` | The four names over the stored width and height: `tierOf(w, h, phone)` classifies, `dimsForTier(tier, phone)` writes, `TIERS`/`PHONE_TIERS` list what each board offers, `tierLabelKey` names the locale key. |
| `web/src/features/bento/WidgetLayer.tsx` | The mode itself: `WidgetLayer` (the board's context, the toolbar, the pill, the page dots, drag) and `Widget` (one card). |
| `web/src/features/bento/AddGallery.tsx` | The Add gallery. |
| `web/src/features/bento/ArrangeSheet.tsx` | The phone's Reorder list. |
| `web/src/features/bento/CustomizeCoach.tsx`, `coach.css` | The one-time hint. Mounted from `components/FirstRunTour.tsx`, held while the tour is up. |
| `web/src/features/bento/AppearanceDialog.tsx` — `DashboardWidgets` | The Settings half: the roster, switches, size selects, Customize board, Reset layout. |
| `web/src/features/bento/bento-theme.css` | The mode's styling: `[data-arranging]`, `.bento-edit`, `.bento-sizebtn`, `.bento-customize-bar`, `.bento-edit-pill`, `.bento-dots`. |

### Entry points, in code

Everything reaches the mode through one switch in `lib/widgets.ts`:

- `setArranging(true)` — the pill, the pencil, a held card, and Settings when
  the board is mounted.
- `requestArrange()` — Settings on a phone and the tab menu, where the board
  is *about* to mount: the intent is parked and the next `publishBoard` picks
  it up, once.
- `useBoard()` — anything that needs to know which board is up, what is on
  it, and whether it is being arranged. This is how Settings and the coach
  mark see the board without being inside it.

### Declaring a card on a screen

A dashboard wraps its cards in `WidgetLayer` and declares each one with
`Widget`. The declared `size` is the card's default; a person's choice
overrides it, and "As designed" and Reset return to it.

```tsx
import { WidgetLayer, Widget } from '@/features/bento/WidgetLayer'

<div className="bento-board">
  <WidgetLayer dashboard="principal">
    <Widget id="pulse" label={t('bento.principal.anchor_label')} size="large" index={0}>
      {(span) => <PulseCard span={span} … />}
    </Widget>
    <Widget id="trend" label={t('bento.principal.collected_label')} size="medium" index={1}>
      {(span) => <CollectedCard span={span} … />}
    </Widget>
    <Widget id="clubs" label="Clubs" size="small" index={7} optional>
      {(span) => <ClubsCard span={span} />}
    </Widget>
  </WidgetLayer>
</div>
```

- `id` is stable and unique within the dashboard: it is what the stored
  layout refers to. Renaming one orphans everybody's placement of it.
- `label` is what the Settings roster, the gallery and the remove button's
  accessible name call it.
- `size` is one of `small` (1 × 1), `tall` (1 × 2), `medium` (2 × 1), `large`
  (2 × 2) or `full` (5 × 1) — see `DIMS` in `lib/widgets.ts`. It is a
  default, not a tier: a stored footprint is classified into a tier by
  `tierOf` when the pill shows it.
- `index` is the declared order, which is where an untouched card sorts and
  what Spotlight and Banner treat as "the first card".
- `optional` declares a card that waits in the gallery rather than shipping
  on the board. The desk board is fifteen slots; a dashboard with more cards
  than slots ships the core full and offers the rest.
- The child is a render function given the span the card is drawn at, so the
  card can change its drawing with its size (see `docs/BENTO_WIDGET_SPEC.md`
  for what each size is expected to show).

The `dashboard` string is the storage key's suffix and must be unique across
the product.

### The phone and the desk

`usePhone()` from `lib/viewport.ts` is the only sanctioned way to ask. The
phone board is one column of pages, two rows a page, every card the full
width — `paginate` reads the stored width and height and draws it that way
without changing what is stored. The desk board packs with `rowsNeeded`,
which mirrors `grid-auto-flow: dense`, and a size is offered only if the
board still packs into `BOARD_ROWS` with it. The Settings select and the
gallery use the same test.

### Storage format

```json
{ "placed": [{ "id": "pulse", "w": 2, "h": 2, "tint": { "h": 217, "s": 91, "l": 60 } }],
  "removed": ["clubs"] }
```

`placed` is ordered; `removed` is explicit rather than inferred, so a card
the product adds later appears for everybody who never touched it and stays
away from anybody who removed it. Rows saved under the old `size` name are
translated on read. An untouched board writes nothing, which is how the
coach mark tells "never arranged" from "arranged back to the default".

### What the tests guard

| Test | Holds |
|---|---|
| `lib/size-tiers.test.ts` | `tierOf`/`dimsForTier` round-trip on both boards; every old footprint reads as the documented tier. |
| `features/bento/customize.test.tsx` | Every card wears a remove button and a size pill without hover; the menu disables sizes that will not fit; Escape leaves the mode; focus lands on Done and returns to the door; removals and sizes reach localStorage. |
| `features/bento/AddGallery.test.tsx` | The gallery lists only absent cards, each with its fitting sizes; picking one places it and the gallery stays open. |
| `features/bento/CustomizeCoach.test.tsx` | The hint shows on an untouched board, not after it was dismissed, not on an arranged board; entering the mode, Escape and eight seconds all dismiss it; it waits while the tour is up. |
| `lib/widgets.test.ts` | The store's older hand-rolled checks (excluded from vitest; run by hand). |

Run them with `cd web && npx vitest run`.
