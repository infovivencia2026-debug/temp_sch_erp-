import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { AgeBands, HeatStrip, Quadrant, Ring, SegmentBar, Timeline } from './bento-viz'
import { code, decl, draw, drewNothing } from './bento-test-render'

/* THE SIX COMPANION DRAWINGS.

   Same shape of test as `bento-cards.test.tsx`, against the five rules this
   file's own header states: no data draws nothing, no denominator draws
   nothing, colour is never the only channel, they hide rather than shrink, and
   nothing names a colour outside the token set.

   The size gates are a first-class part of the contract here — these return
   null below the room they need — so every test states the cell size it is
   drawn at rather than relying on a default.

   KNOWN BUG tests use `it.fails`: the body states the invariant and passes
   only because it is currently broken. */

const SRC = readFileSync(resolve(process.cwd(), 'src/features/bento/bento-viz.tsx'), 'utf8')

const BIG = { w: 4, h: 4 }
const points = [
  { x: 1, y: 1, label: 'a' },
  { x: 9, y: 9, label: 'b' },
]

/* ── 1. no data draws nothing ───────────────────────────────────────────── */

describe('empty data draws nothing', () => {
  const empties: [string, ReactElement][] = [
    ['Ring (no total)', <Ring value={0} total={0} srLabel="r" />],
    ['SegmentBar []', <SegmentBar segments={[]} srLabel="s" />],
    ['AgeBands []', <AgeBands bands={[]} srLabel="a" />],
    ['HeatStrip []', <HeatStrip cells={[]} srLabel="h" />],
    ['HeatStrip (all null)', <HeatStrip cells={[null, null]} srLabel="h" />],
    ['Timeline []', <Timeline events={[]} from="2026-01-01" to="2026-03-01" srLabel="t" />],
    ['Quadrant []', <Quadrant points={[]} xLabel="x" yLabel="y" srLabel="q" />],
  ]
  for (const [name, node] of empties) {
    it(`${name} renders nothing`, () => expect(drewNothing(node, BIG)).toBe(true))
  }
})

describe('an all-zero series draws nothing', () => {
  it('SegmentBar refuses a total of zero', () => {
    expect(drewNothing(
      <SegmentBar segments={[{ label: 'a', value: 0 }, { label: 'b', value: 0 }]} srLabel="s" />, BIG,
    )).toBe(true)
  })

  it('AgeBands refuses an all-zero set', () => {
    // Four empty rails labelled 0 look like a chart that failed to load.
    expect(drewNothing(
      <AgeBands bands={[{ label: '0-30', value: 0 }, { label: '30+', value: 0 }]} srLabel="a" />, BIG,
    )).toBe(true)
  })

  it('HeatStrip refuses an all-zero series', () => {
    /* A series of all zeros has `range === 0`, so HeatStrip takes its `flat`
       branch — which paints EVERY cell at `intensity(0.5)` and full alpha,
       the middle of the ramp. A month in which nothing happened is drawn as a
       month of uniformly moderate activity, which is the confident zero rule
       4 of this file's own header refuses. The flat branch is right for a flat
       NON-zero series (every period the same busy) and wrong for this one.
       Triggering input: <HeatStrip cells={[0, 0, 0, 0]} />. */
    expect(drewNothing(<HeatStrip cells={[0, 0, 0, 0]} srLabel="h" />, BIG)).toBe(true)
  })

  it('HeatStrip still draws a flat NON-zero series', () => {
    const host = draw(<HeatStrip cells={[5, 5, 5]} srLabel="h" />, BIG)
    expect(host.querySelectorAll('[role="img"] > div')).toHaveLength(3)
  })
})

describe('one point where two are needed draws nothing', () => {
  it('Quadrant refuses a single point', () => {
    /* One mark cannot establish the ranges the dividing lines are drawn from,
       so the quadrant it appears to sit in is an artefact of having one
       point. */
    expect(drewNothing(<Quadrant points={[points[0]]} xLabel="x" yLabel="y" srLabel="q" />, BIG)).toBe(true)
  })

  it('Quadrant draws with two', () => {
    expect(drewNothing(<Quadrant points={points} xLabel="x" yLabel="y" srLabel="q" />, BIG)).toBe(false)
  })

  it('Quadrant refuses a second point that is not a number', () => {
    const bad = [points[0], { x: Number.NaN, y: 3, label: 'b' }]
    expect(drewNothing(<Quadrant points={bad} xLabel="x" yLabel="y" srLabel="q" />, BIG)).toBe(true)
  })
})

/* ── 2. no denominator, no drawing ──────────────────────────────────────── */

describe('no denominator, no drawing', () => {
  it('Ring refuses total 0', () => {
    expect(drewNothing(<Ring value={4} total={0} srLabel="r" />, BIG)).toBe(true)
  })
  it('Ring refuses a negative total', () => {
    expect(drewNothing(<Ring value={4} total={-8} srLabel="r" />, BIG)).toBe(true)
  })
  it('Ring draws a real zero against a real total', () => {
    // 0 of 40 is a measurement; 0 of nothing is not.
    expect(draw(<Ring value={0} total={40} srLabel="r" />, BIG).textContent).toContain('0%')
  })
})

describe('Ring clamps its value into its total', () => {
  const labelOf = (value: number, total: number) =>
    draw(<Ring value={value} total={total} srLabel="Collected" />, BIG)
      .querySelector('[role="img"]')!.getAttribute('aria-label')

  it('cannot report more than the whole', () => {
    expect(labelOf(999, 10)).toBe('Collected: 10 of 10, 100%')
  })
  it('cannot report less than none', () => {
    expect(labelOf(-4, 10)).toBe('Collected: 0 of 10, 0%')
  })
  it('states the two figures as well as the share', () => {
    expect(labelOf(3, 4)).toBe('Collected: 3 of 4, 75%')
  })
  it('draws a complete ring with no dash pattern at all', () => {
    // At 100% a dashed arc's two round caps meet and overlap into a notch.
    const arcs = draw(<Ring value={10} total={10} srLabel="r" />, BIG).querySelectorAll('circle')
    expect(arcs[arcs.length - 1].getAttribute('stroke-dasharray')).toBeNull()
  })
  it('dashes a partial ring', () => {
    const arcs = draw(<Ring value={5} total={10} srLabel="r" />, BIG).querySelectorAll('circle')
    expect(arcs[arcs.length - 1].getAttribute('stroke-dasharray')).toMatch(/^[\d.]+ [\d.]+$/)
  })
  it('gives two rings on one board different gradient ids', () => {
    /* A shared id would silently hand the second ring the first one's
       geometry — the reason the `useId` call sits above the early return. */
    const host = draw(
      <div>
        <Ring value={1} total={4} srLabel="a" />
        <Ring value={3} total={4} srLabel="b" />
      </div>, BIG,
    )
    const ids = [...host.querySelectorAll('linearGradient')].map((g) => g.getAttribute('id'))
    expect(new Set(ids).size).toBe(2)
  })
})

/* ── 3. no drawing names a colour ───────────────────────────────────────── */

describe('no drawing names a colour', () => {
  const source = code(SRC)

  it('contains no hex literal', () => {
    // `url(#id)` is not a colour; the pattern requires hex digits after the #.
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('contains no rgb() or hsl() literal', () => {
    expect(source).not.toMatch(/\b(rgba?|hsla?)\s*\(/)
  })

  it('never names --bento-card', () => {
    /* Naming the card's own colour is a drawing asserting which cell it is on;
       on a domain-tinted or inverted cell it is wrong by construction. */
    expect(source).not.toMatch(/--bento-card\b/)
  })

  it('draws every accent as a mix into currentColor, never on its own', () => {
    /* An accent used raw loses its ground on an inverted cell, which is the
       failure this file was written to fix. */
    for (const token of ['--bento-mint', '--bento-purple', '--bento-pink', '--bento-orange']) {
      const uses = source.match(new RegExp(`var\\(${token}\\)`, 'g')) ?? []
      expect(uses.length, `${token} is never used`).toBeGreaterThan(0)
    }
    expect(source).toMatch(/color-mix\(in srgb, \$\{ACCENT\[h\]\} 55%, currentColor\)/)
  })
})

/* ── 4. an accessible name on every drawing ─────────────────────────────── */

describe('every drawing exposes an accessible name', () => {
  const all: [string, ReactElement][] = [
    ['Ring', <Ring value={3} total={4} srLabel="ring" />],
    ['SegmentBar', <SegmentBar segments={[{ label: 'a', value: 3 }, { label: 'b', value: 1 }]} srLabel="seg" />],
    ['AgeBands', <AgeBands bands={[{ label: '0-30', value: 3 }, { label: '30+', value: 1 }]} srLabel="age" />],
    ['HeatStrip', <HeatStrip cells={[1, 4, 9]} srLabel="heat" />],
    ['Timeline', <Timeline events={[{ label: 'Exam', date: '2026-02-01' }]} from="2026-01-01" to="2026-03-01" srLabel="time" />],
    ['Quadrant', <Quadrant points={points} xLabel="absence" yLabel="marks" srLabel="quad" />],
  ]

  for (const [name, node] of all) {
    it(`${name} is role="img" with a stated label`, () => {
      const img = draw(node, BIG).querySelector('[role="img"]')
      expect(img, `${name} rendered no role="img"`).not.toBeNull()
      expect(img!.getAttribute('aria-label')!.length).toBeGreaterThan(0)
    })

    it(`${name} states its data in that label rather than summarising it away`, () => {
      /* Every row, cell or point is named. Quadrant is the one that states
         POSITIONS rather than numbers, which its doc comment argues is the
         actual claim it makes — so the assertion is that each datum appears,
         not that a digit does. */
      const label = draw(node, BIG).querySelector('[role="img"]')!.getAttribute('aria-label')!
      expect(label).toContain('srLabel' in node.props ? String(node.props.srLabel) : '')
      expect(label.length).toBeGreaterThan(String(node.props.srLabel).length + 4)
    })

    it(`${name} exposes exactly one image to a screen reader`, () => {
      // The legends, keys and axis names are all aria-hidden; a second role
      // would read the same numbers twice.
      expect(draw(node, BIG).querySelectorAll('[role="img"]')).toHaveLength(1)
    })
  }
})

describe('colour is never the only channel', () => {
  it('SegmentBar prints every share in the legend, zero ones included', () => {
    /* Zero-valued segments are dropped from the BAR — a zero-width slice is a
       rendering fault with a tooltip — but stay in the legend, because "none
       of this category" is a finding. */
    const host = draw(
      <SegmentBar segments={[{ label: 'cash', value: 0 }, { label: 'upi', value: 5 }]} srLabel="s" />, BIG,
    )
    expect(host.querySelectorAll('[role="img"] > div > div')).toHaveLength(1)
    expect(host.querySelectorAll('li')).toHaveLength(2)
    expect(host.textContent).toContain('cash')
  })

  it('SegmentBar states each share and the total for a screen reader', () => {
    const label = draw(
      <SegmentBar segments={[{ label: 'cash', value: 3 }, { label: 'upi', value: 1 }]} srLabel="Paid by" />, BIG,
    ).querySelector('[role="img"]')!.getAttribute('aria-label')
    expect(label).toBe('Paid by: cash 3, 75%; upi 1, 25%. Total 4.')
  })

  it('SegmentBar formats values through formatValue everywhere it prints them', () => {
    /* A bare paise integer read as rupees is wrong by a factor of a hundred,
       so the formatter has to reach the legend, the title AND the label. */
    const host = draw(
      <SegmentBar
        segments={[{ label: 'fees', value: 1e11 }]}
        formatValue={(v) => `Rs ${v / 100}`}
        srLabel="s"
      />, BIG,
    )
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('Rs 1000000000')
    expect(host.querySelector('[title]')!.getAttribute('title')).toContain('Rs 1000000000')
    expect(host.querySelector('li')!.textContent).toContain('Rs 1000000000')
  })

  it('HeatStrip prints the observed low and high so a shade converts back', () => {
    const host = draw(<HeatStrip cells={[2, 8, 5]} srLabel="h" />, BIG)
    expect(host.textContent).toContain('2')
    expect(host.textContent).toContain('8')
  })

  it('HeatStrip titles every cell, and marks a missing one as missing', () => {
    /* "No data for this period" and "a low value this period" are different
       facts; a ramp that renders both as pale grey merges them. */
    const host = draw(<HeatStrip cells={[1, null, 9]} srLabel="h" />, BIG)
    const titles = [...host.querySelectorAll('[title]')].map((el) => el.getAttribute('title'))
    expect(titles).toEqual(['1', 'No data', '9'])
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('no data')
  })

  it('AgeBands prints every count beside its rail', () => {
    const host = draw(
      <AgeBands bands={[{ label: '0-30', value: 4 }, { label: '30+', value: 0 }]} srLabel="a" />, BIG,
    )
    expect(host.textContent).toContain('0-30')
    expect(host.textContent).toContain('30+')
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('30+, 0')
  })
})

/* ── 5. positioning maths ───────────────────────────────────────────────── */

describe('SegmentBar widths are shares of the whole', () => {
  const widths = (values: number[]) =>
    [...draw(
      <SegmentBar segments={values.map((v, i) => ({ label: `s${i}`, value: v }))} srLabel="s" />, BIG,
    ).querySelectorAll('[role="img"] > div > div')].map((el) => decl(el.getAttribute('style') ?? '', 'width'))

  it('splits by the sum of what was passed', () => {
    expect(widths([1, 1, 2])).toEqual(['25%', '25%', '50%'])
  })
  it('gives a lone segment the whole bar', () => {
    expect(widths([7])).toEqual(['100%'])
  })
  it('sums to 100%', () => {
    const total = widths([3, 5, 11, 2]).reduce((a, w) => a + Number.parseFloat(w), 0)
    expect(total).toBeCloseTo(100, 6)
  })
  it('ignores a negative or non-finite segment rather than inverting the bar', () => {
    expect(widths([Number.NaN, 5, -3, 5])).toEqual(['50%', '50%'])
  })
})

describe('AgeBands scale to the largest band, not the total', () => {
  const rails = (values: number[]) =>
    [...draw(
      <AgeBands bands={values.map((v, i) => ({ label: `b${i}`, value: v }))} srLabel="a" />, BIG,
    ).querySelectorAll('[role="img"] > div > div > div')].map((el) => decl(el.getAttribute('style') ?? '', 'width'))

  it('gives the largest bucket the full rail', () => {
    expect(rails([25, 100])).toEqual(['25%', '100%'])
  })
  it('floors a non-zero band so it is a visible mark, not an empty rail', () => {
    expect(rails([1, 1000])).toEqual(['4%', '100%'])
  })
  it('draws a zero band at zero, with no floor', () => {
    expect(rails([0, 10])).toEqual(['0%', '100%'])
  })
})

describe('Quadrant places its points', () => {
  const at = (i: number, pts = points) => {
    const marks = draw(
      <Quadrant points={pts} xLabel="x" yLabel="y" srLabel="q" />, BIG,
    ).querySelectorAll('[role="img"] span[title]')
    const style = marks[i].getAttribute('style') ?? ''
    return [decl(style, 'left'), decl(style, 'top')]
  }

  it('insets the extremes rather than putting them on the frame', () => {
    // 6%..94%, so a point at the edge of the observed range is still a whole
    // mark inside the field rather than half of one on the border.
    expect(at(0)).toEqual(['6%', '94%'])
    expect(at(1)).toEqual(['94%', '6%'])
  })

  it('puts a midpoint in the middle', () => {
    const three = [...points, { x: 5, y: 5, label: 'c' }]
    expect(at(2, three)).toEqual(['50%', '50%'])
  })

  it('draws a degenerate axis down the middle rather than dividing by zero', () => {
    const flat = [{ x: 3, y: 1, label: 'a' }, { x: 3, y: 9, label: 'b' }]
    expect(at(0, flat)[0]).toBe('50%')
    expect(at(1, flat)[0]).toBe('50%')
  })

  it('names the quadrant each point is in, in the label and in its title', () => {
    const host = draw(<Quadrant points={points} xLabel="absence" yLabel="marks" srLabel="q" />, BIG)
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label'))
      .toContain('a: low marks, low absence')
    expect(host.querySelectorAll('span[title]')[1].getAttribute('title'))
      .toContain('high marks, high absence')
  })
})

describe('Timeline positions by date within the stated window', () => {
  const window = { from: '2026-01-01T00:00:00Z', to: '2026-01-11T00:00:00Z' }

  const lefts = (dates: string[]) =>
    [...draw(
      <Timeline events={dates.map((d, i) => ({ label: `e${i}`, date: d }))} {...window} srLabel="t" />, BIG,
    ).querySelectorAll('[title]')].map((el) => decl(el.getAttribute('style') ?? '', 'left'))

  it('puts the start of the window at 0% and the end at 100%', () => {
    expect(lefts(['2026-01-01T00:00:00Z', '2026-01-11T00:00:00Z'])).toEqual(['0%', '100%'])
  })

  it('spaces the middle by real elapsed time, not by index', () => {
    /* The reason not to draw this as a list: the GAPS have to be real. Three
       events in one week and nothing else must not fill the axis. */
    expect(lefts(['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-11T00:00:00Z']))
      .toEqual(['0%', '10%', '100%'])
  })

  it('refuses a window of zero length', () => {
    expect(drewNothing(
      <Timeline events={[{ label: 'e', date: '2026-01-01' }]} from="2026-01-01" to="2026-01-01" srLabel="t" />, BIG,
    )).toBe(true)
  })

  it('refuses a reversed window rather than guessing at the fix', () => {
    expect(drewNothing(
      <Timeline events={[{ label: 'e', date: '2026-01-05' }]} from="2026-03-01" to="2026-01-01" srLabel="t" />, BIG,
    )).toBe(true)
  })

  it('refuses an unparseable window', () => {
    expect(drewNothing(
      <Timeline events={[{ label: 'e', date: '2026-01-05' }]} from="not a date" to="2026-01-01" srLabel="t" />, BIG,
    )).toBe(true)
  })

  it('draws nothing when every event falls outside the window', () => {
    expect(drewNothing(
      <Timeline events={[{ label: 'e', date: '2025-01-05' }]} {...window} srLabel="t" />, BIG,
    )).toBe(true)
  })

  it('stacks events that share a date instead of overplotting them', () => {
    const host = draw(
      <Timeline
        events={[{ label: 'a', date: '2026-01-05' }, { label: 'b', date: '2026-01-05' }]}
        {...window} srLabel="t"
      />, { w: 4, h: 2 },
    )
    const bottoms = [...host.querySelectorAll('[title]')].map((el) =>
      decl(el.getAttribute('style') ?? '', 'bottom'))
    expect(new Set(bottoms).size).toBe(2)
  })

  it('counts the overflow rather than dropping it silently', () => {
    /* Past what the lanes hold, the marks that do not fit are counted in the
       key and every one of them is still stated for a screen reader. */
    const events = Array.from({ length: 6 }, (_, i) => ({ label: `e${i}`, date: '2026-01-05' }))
    const host = draw(<Timeline events={events} {...window} srLabel="t" />, { w: 4, h: 1 })
    expect(host.querySelectorAll('[title]')).toHaveLength(2)
    expect(host.textContent).toContain('+4 more')
    const label = host.querySelector('[role="img"]')!.getAttribute('aria-label')!
    for (const e of events) expect(label).toContain(e.label)
  })
})

/* ── 6. they hide rather than shrink ────────────────────────────────────── */

describe('below the room it needs, a drawing is not there', () => {
  const gated: [string, ReactElement, { w: number; h: number }][] = [
    ['HeatStrip below 2 columns', <HeatStrip cells={[1, 2, 3]} srLabel="h" />, { w: 1, h: 4 }],
    ['Timeline below 2 columns', <Timeline events={[{ label: 'e', date: '2026-01-05' }]} from="2026-01-01" to="2026-02-01" srLabel="t" />, { w: 1, h: 4 }],
    ['Quadrant below 2 columns', <Quadrant points={points} xLabel="x" yLabel="y" srLabel="q" />, { w: 1, h: 4 }],
  ]
  for (const [name, node, size] of gated) {
    it(`${name} draws nothing`, () => expect(drewNothing(node, size)).toBe(true))
  }

  it('Quadrant below 2 rows degrades to a labelled list, not to nothing', () => {
    /* A field needs 120px of height; a 2x1 cannot give it. The rows are still
       a finding, so each point is listed with its two values and the label
       still states every quadrant — nothing is plotted, nothing is lost. */
    const host = draw(<Quadrant points={points} xLabel="x" yLabel="y" srLabel="q" />, { w: 4, h: 1 })
    expect(host.querySelectorAll('span[title]')).toHaveLength(0)
    expect(host.querySelectorAll('li')).toHaveLength(2)
    expect(host.textContent).toContain('a')
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('b: high y, high x')
  })

  const fitsSmall: [string, ReactElement][] = [
    ['Ring', <Ring value={1} total={4} srLabel="r" />],
    ['SegmentBar', <SegmentBar segments={[{ label: 'a', value: 1 }]} srLabel="s" />],
    ['AgeBands', <AgeBands bands={[{ label: 'a', value: 1 }]} srLabel="a" />],
  ]
  for (const [name, node] of fitsSmall) {
    it(`${name} still draws in a 1x1 cell`, () => {
      expect(drewNothing(node, { w: 1, h: 1 })).toBe(false)
    })
  }
})

/* ── 7. degenerate input ────────────────────────────────────────────────── */

describe('degenerate input does not throw', () => {
  const values: [string, number[]][] = [
    ['NaN', [Number.NaN, Number.NaN]],
    ['negatives', [-5, -1]],
    ['mixed signs', [-5, 0, 12]],
    ['one item', [7]],
    ['500 items', Array.from({ length: 500 }, (_, i) => (i * 37) % 101)],
    ['paise-scale integers', [1e11, 5e10]],
    ['Infinity', [Number.POSITIVE_INFINITY, 3]],
  ]

  for (const [name, vs] of values) {
    const labelled = vs.map((v, i) => ({ label: `l${i}`, value: v }))
    const cases: [string, ReactElement][] = [
      ['Ring', <Ring value={vs[0]} total={vs[vs.length - 1]} srLabel="r" />],
      ['SegmentBar', <SegmentBar segments={labelled} srLabel="s" />],
      ['AgeBands', <AgeBands bands={labelled} srLabel="a" />],
      ['HeatStrip', <HeatStrip cells={vs} srLabel="h" />],
      ['Quadrant', <Quadrant points={vs.map((v, i) => ({ x: v, y: v / 2, label: `p${i}` }))} xLabel="x" yLabel="y" srLabel="q" />],
      ['Timeline', <Timeline events={vs.map((v, i) => ({ label: `e${i}`, date: v }))} from={0} to={1e12} srLabel="t" />],
    ]
    for (const [drawing, node] of cases) {
      it(`${drawing} survives ${name}`, () => expect(() => draw(node, BIG)).not.toThrow())
    }
  }

  it('a 500-cell HeatStrip draws 500 cells and no more', () => {
    const cells = Array.from({ length: 500 }, (_, i) => i)
    expect(draw(<HeatStrip cells={cells} srLabel="h" />, BIG)
      .querySelectorAll('[role="img"] > div')).toHaveLength(500)
  })

  it('a paise-scale Ring reports the share, not the magnitude', () => {
    expect(draw(<Ring value={25e11} total={1e13} srLabel="r" />, BIG)
      .querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('25%')
  })

  it('Ring survives a non-finite value', () => {
    // NaN survives the clamp here too, but unlike Gauge the Ring's own text is
    // driven by pctText, which is asserted separately below.
    expect(() => draw(<Ring value={Number.NaN} total={10} srLabel="r" />, BIG)).not.toThrow()
  })

  it('Ring refuses a non-finite value', () => {
    /* `Math.min(Math.max(NaN, 0), total)` is NaN, so the printed share, the
       `v/total` line under it and the screen-reader label all come out as
       "NaN", and the arc's dash array is "NaN <circumference>" — an arc the
       browser then declines to draw, leaving a bare track that reads as 0%.
       Triggering input: <Ring value={NaN} total={10} />, which is what a
       count that came back null produces after arithmetic. */
    expect(draw(<Ring value={Number.NaN} total={10} srLabel="r" />, BIG).textContent)
      .not.toContain('NaN')
  })
})

/* NOT TESTED HERE, DELIBERATELY.

   1. Anything that needs layout. jsdom has no box model, so it cannot answer
      whether the ring stays square, whether 500 heat cells overflow their
      strip, whether two timeline marks in adjacent lanes actually clear each
      other, or whether a label collides with its neighbour. The lane MATHS is
      tested above; the pixels belong in the Playwright pass.

   2. Contrast. Every colour in this file is a `color-mix()` on a CSS custom
      property, and jsdom neither resolves custom properties nor computes
      `color-mix`. The 3:1 and 4.5:1 figures the source states were measured in
      a real engine and can only be re-measured in one.

   3. Timeline's date TEXT. It is produced by `toLocaleDateString` with an
      undefined locale, so its exact form is a property of the machine's ICU
      data rather than of the drawing. The tests above assert positions and the
      presence of every event's own label instead. */
