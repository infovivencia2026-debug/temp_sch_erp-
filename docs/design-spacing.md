# Spacing

One scale for the page frame, set as CSS custom properties in
`web/src/index.css` (next to the density dial) and read by the shared
components in `web/src/components/ui.tsx`. Values are in **pixels**, not
Tailwind steps: the root font is pinned to 14px, so `px-5` is 17.5px and
`space-y-7` is 24.5px. The frame drifted because it was written in those
steps. New frame code uses the tokens.

## The tokens

| Token | Phone (<640) | 640 and up | Where it applies |
|---|---|---|---|
| `--page-gutter` | 22px from the edge | 24px from the edge | `PageHead`, `PageBody`, `SkeletonPage`, `RecordShell`, seller and portal page wrappers |
| `--page-top` | 20px (Work), 0 (Focus) | same | above the page header |
| `--page-head-gap` | 20px | 20px | page header to the first block |
| `--section-gap` | 24px | 24px | between blocks in `PageBody` and record tabs |
| `--card-pad` | 16px | 20px | `CardHeader`, table header and body cells, the table pager, card bodies padded by `.card > form` and similar rules, `.cell` |

`--page-gutter` is the page's own inset, added on top of whatever the layout
pads. Work (classic) adds nothing, so the token is the whole gutter. Focus
(bento) pads its work area in `BentoOutlet` (14 / 20 / 24px at the sides and
21px at the top), so under `html[data-layout='bento']` the token is only the
difference: 8px on a phone, 4px from 640, 0 from 1024. Either way the content
edge lands at 22px on a phone and 24px from 640 up. The 22px phone width was
settled in commit 8621aa0a ("Sixteen pixels was too far the other way"), so it
stays.

## The fixed steps (unchanged, recorded here)

| What | Value |
|---|---|
| Form fields (`FormGrid`) | 16px row and column gap |
| Field label to control | 5px (`mb-1.5`) |
| Hint under a field | 5px (`mt-1.5`) |
| Button group | 7px (`gap-2`) |
| Card header, vertical | `py-4` (14px) |
| Table row | `--row-py`, which follows Density: 0.5 / 0.875 / 1.125rem, i.e. 7 / 12 / 16px (compact / comfortable / relaxed) |
| Table cell, below 900px | 12px sides |
| Empty state | `p-10` inside its card |
| Focus board gutters | `--bento-gap`, follows Density (hairline to spacious) |

## Density

Density already moves table rows (`--row-py`) and the Focus board's gutters
(`--bento-density`). It does not move the page frame or card padding: a
tighter row is the thing that fits more on a screen, and a moving page edge
would only make headers jump when the setting changes.

## Rules for screens

- Start a screen with `PageHead` + `PageBody`. Do not add `px-*` or `sm:px-7`
  around them, and do not add your own page wrapper with hard-coded gutters.
  If a screen needs a custom wrapper, use `px-[var(--page-gutter)]`.
- Space blocks inside `PageBody` with the body's own gap. Do not add `mt-*`
  between cards.
- Inside a card, pad with `var(--card-pad)` (or leave it to the `.card > …`
  rules in index.css, which pad a bare form, grid, paragraph or button).
- Tables pad themselves. Do not override `Td` side padding except for a real
  reason, such as the money column's right padding.

## Before and after (measured 2026-09-27, 1440x900 and 390x844)

| | Before | After |
|---|---|---|
| Phone, Focus: title edge vs first card | 32 vs 21px | 22 vs 22px |
| Phone, Work: title edge vs first card | 18 vs 7px | 22 vs 22px |
| Desktop, Focus: page with a header vs a board screen | 48.5 vs 24px from the work area | 24 vs 24px |
| Desktop, Work | 24.5px | 24px |
| Header to content | 21px | 20px |
| Section gap | 24.5px | 24px |
| Card inset (header / cells / body) | 17.5px | 20px desktop, 16px phone |
| Form grid gap | 17.5px | 16px |
