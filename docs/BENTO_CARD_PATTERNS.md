# Editorial card patterns

The chart vocabulary for bento cells, supplied by the product owner as a
working HTML reference. This file is the contract.

## Card structure

A cell is three rows and nothing else:

    grid-template-rows: <header> <value> minmax(0, 1fr)

    header   title (bold, small, one line, ellipsised) + sub (uppercase,
             tracked, quiet) on the left; a circled glyph on the right
    value    the figure, tight and large, then a change line beneath it
    chart    takes ALL remaining height — `minmax(0,1fr)` and `overflow:hidden`

The chart row is a fraction, not a fixed height, so the drawing grows with the
cell instead of leaving dead space under the number. That is the whole point.

## The twelve drawings

| name | shape | reads as |
|---|---|---|
| `line` | open path, round caps, no fill | trend |
| `area` | the same with a soft fill beneath | magnitude + trend |
| `bars` | flex row, bottom-aligned, rounded tops | period comparison |
| `rows` | label · track · value, right-aligned figure | ranked composition |
| `gauge` | conic ring with a punched centre | one proportion |
| `stack` | bottom-aligned columns split into segments | composition over periods |
| `distribution` | bars whose heights describe a curve | spread, density |
| `compare` | two labelled tracks, before over after | plan vs actual |
| `density` | a dot grid, opacity per cell | population, coverage |
| `funnel` | right-aligned bars narrowing downward | pipeline conversion |
| `scale` | a hairline with one dot positioned along it | a single value in range |
| `flow` | short offset dashes, indented per row | movement between states |

**`big` is deliberately excluded.** It is a number at a larger size, and a
number is already the `value` row — it adds no information, which is the one
thing every drawing here has to do.

## Colour

Marks are the cell's own ink — black or white, whichever the card's ground
takes. Tracks and grounds beneath a mark are that same ink at low alpha. The
card's tint carries the hue; the drawing does not.

## Rules carried over

- Text and figures are black or white only, chosen by the ground.
- No fabricated denominators. A gauge, a track or a percentage needs a real
  total; without one, draw a count or a distribution instead.
- Every drawing states its series to a screen reader; colour is never the only
  channel.
- Empty data draws nothing — never a confident zero.
- Cells are `overflow: hidden`. Content that does not fit is cut, not scrolled.
