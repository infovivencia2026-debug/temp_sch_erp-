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
