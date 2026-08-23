import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import {
  Area, Bars, CardShell, Compare, Distribution, Facts, Flow, Funnel, Gauge, Line, Rows, Scale,
  Stack,
} from './bento-cards'
import { code, decl, draw, drewNothing, styleOf } from './bento-test-render'

/* THE CARD VOCABULARY'S INVARIANTS.

   These are not tests of what the drawings look like — a class list is a style
   decision and locking one in with a snapshot would make every legitimate
   restyle a test failure. They are tests of the four promises the file's own
   doc comment makes, each of which has been broken in production at least
   once:

     it refuses rather than invents      no data draws nothing; no denominator
                                         draws nothing
     it names no colour                  every mark is `currentColor`, so a
                                         drawing cannot assert which cell it is
                                         on
     it can be read aloud                role="img" and a stated label
     the shell gives the drawing the room that is left

   Tests named KNOWN BUG use `it.fails`: the body states the invariant, and the
   test passes only because the invariant is currently BROKEN. Each one names
   the triggering input. Fix the drawing and the test goes red — that is the
   signal to delete the `.fails`. */

/* Read off disk rather than imported: rules 3's whole point is what the
   SOURCE says, not what the module exports. `process.cwd()` is the vitest
   root, which is `web/`. */
const SRC = readFileSync(resolve(process.cwd(), 'src/features/bento/bento-cards.tsx'), 'utf8')

/* Every drawing, with data in it. Reused by the accessible-name and
   degenerate-input sweeps so a new drawing has to be added in one place. */
const populated = (values: number[]): [string, ReactElement][] => {
  const items = values.map((v, i) => ({ label: `row ${i}`, value: v }))
  return [
    ['Line', <Line points={values} srLabel="line" />],
    ['Area', <Area points={values} srLabel="area" />],
    ['Bars', <Bars values={values} srLabel="bars" />],
    ['Bars (active)', <Bars values={values} activeIndex={1} srLabel="bars" />],
    ['Rows', <Rows items={items} srLabel="rows" />],
    ['Gauge', <Gauge value={values[0]} total={values[values.length - 1]} srLabel="gauge" />],
    ['Stack', <Stack columns={values.map((v) => ({ total: v, parts: [v / 2, v / 2] }))} srLabel="stack" />],
    ['Distribution', <Distribution values={values} srLabel="dist" />],
    ['Compare', <Compare rows={items} srLabel="compare" />],
    ['Facts', <Facts items={values.map((v, i) => ({ label: `f${i}`, value: String(v) }))} srLabel="facts" />],
    ['Funnel', <Funnel stages={items} srLabel="funnel" />],
    ['Scale', <Scale value={values[0]} min={values[0]} max={values[values.length - 1]} srLabel="scale" />],
    ['Flow', <Flow rows={values} srLabel="flow" />],
  ]
}

/* ── 1. no data draws nothing ───────────────────────────────────────────── */

describe('empty data draws nothing', () => {
  const empties: [string, ReactElement][] = [
    ['Line []', <Line points={[]} srLabel="l" />],
    ['Area []', <Area points={[]} srLabel="l" />],
    ['Bars []', <Bars values={[]} srLabel="l" />],
    ['Rows []', <Rows items={[]} srLabel="l" />],
    ['Stack []', <Stack columns={[]} srLabel="l" />],
    ['Distribution []', <Distribution values={[]} srLabel="l" />],
    ['Compare []', <Compare rows={[]} srLabel="l" />],
    ['Facts []', <Facts items={[]} srLabel="l" />],
    ['Funnel []', <Funnel stages={[]} srLabel="l" />],
    ['Flow []', <Flow rows={[]} srLabel="l" />],
  ]
  for (const [name, node] of empties) {
    it(`${name} renders nothing`, () => expect(drewNothing(node)).toBe(true))
  }
})

describe('one point where two are needed draws nothing', () => {
  /* A trend needs two readings and a comparison needs two rows; drawn from one
     they would report a shape that was never measured. */
  const singles: [string, ReactElement][] = [
    ['Line', <Line points={[7]} srLabel="l" />],
    ['Area', <Area points={[7]} srLabel="l" />],
    ['Compare', <Compare rows={[{ label: 'a', value: 7 }]} srLabel="l" />],
  ]
  for (const [name, node] of singles) {
    it(`${name} with one point renders nothing`, () => expect(drewNothing(node)).toBe(true))
  }

  it('Line draws once it has two points', () => {
    expect(draw(<Line points={[1, 2]} srLabel="l" />).querySelector('path')).not.toBeNull()
  })
})

describe('a range of zero draws nothing', () => {
  it('Scale refuses max == min', () => {
    expect(drewNothing(<Scale value={5} min={5} max={5} srLabel="s" />)).toBe(true)
  })
  it('Scale refuses an inverted range', () => {
    expect(drewNothing(<Scale value={5} min={9} max={1} srLabel="s" />)).toBe(true)
  })
})

/* ── 2. no denominator, no drawing ──────────────────────────────────────── */

describe('no denominator, no drawing', () => {
  it('Gauge refuses total 0', () => {
    expect(drewNothing(<Gauge value={5} total={0} srLabel="g" />)).toBe(true)
  })
  it('Gauge refuses a negative total', () => {
    expect(drewNothing(<Gauge value={5} total={-3} srLabel="g" />)).toBe(true)
  })
  it('Gauge draws with a real total', () => {
    expect(draw(<Gauge value={5} total={10} srLabel="g" />).textContent).toBe('50%')
  })
})

/* ── 3. all-zero input ──────────────────────────────────────────────────── */

describe('all-zero input', () => {
  /* KNOWN BUG. `bento-viz` refuses an all-zero series outright — SegmentBar on
     `total <= 0`, AgeBands on `max <= 0` — on the stated grounds that a chart
     of nothing looks like a measurement. Nothing in `bento-cards` makes that
     refusal: `Math.max(...values) || 1` turns a whole series of zeros into a
     denominator of 1, and the per-mark floors (`Math.max(3, …)` in Bars and
     Distribution, `Math.max(4, …)` in Stack, `Math.max(6, …)` in Funnel) then
     draw a visible mark for every zero. A cell with no activity at all reports
     a short bar per period, which reads as a small amount rather than none. */
  const zeroes: [string, ReactElement][] = [
    ['Bars', <Bars values={[0, 0, 0]} srLabel="l" />],
    ['Distribution', <Distribution values={[0, 0, 0]} srLabel="l" />],
    ['Stack', <Stack columns={[{ total: 0, parts: [0] }, { total: 0, parts: [0] }]} srLabel="l" />],
    ['Funnel', <Funnel stages={[{ label: 'a', value: 0 }, { label: 'b', value: 0 }]} srLabel="l" />],
    ['Rows', <Rows items={[{ label: 'a', value: 0 }, { label: 'b', value: 0 }]} srLabel="l" />],
    ['Compare', <Compare rows={[{ label: 'a', value: 0 }, { label: 'b', value: 0 }]} srLabel="l" />],
    ['Line', <Line points={[0, 0, 0]} srLabel="l" />],
    ['Area', <Area points={[0, 0, 0]} srLabel="l" />],
  ]
  for (const [name, node] of zeroes) {
    it(`${name} refuses an all-zero series`, () => {
      expect(drewNothing(node)).toBe(true)
    })
  }

  it('Flow draws no dashes for all-zero rows', () => {
    // Flow is the one that gets this right by construction: it repeats a mark
    // `n` times, and zero times is no marks.
    const host = draw(<Flow rows={[0, 0]} srLabel="l" />)
    expect(host.querySelectorAll('[role="img"] > div > span')).toHaveLength(0)
  })
})

/* ── 4. no drawing names a colour ───────────────────────────────────────── */

describe('no drawing names a colour', () => {
  const source = code(SRC)

  it('contains no hex literal', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('contains no rgb() or hsl() literal', () => {
    expect(source).not.toMatch(/\b(rgba?|hsla?)\s*\(/)
  })

  it('never names --bento-card', () => {
    /* The one that caught two shipped bugs. A drawing that names the CARD's
       colour is asserting which cell it is on: the gauge punched a
       paper-coloured hole into a domain-tinted card, and the funnel wrote its
       label in paper on an inverted one. Neither is expressible if the token
       is never mentioned. */
    expect(source).not.toMatch(/--bento-card\b/)
  })

  it('the comments that discuss the token are not what is being scanned', () => {
    // Guards the stripper itself: the doc comments DO name the token, and a
    // scan that stopped stripping them would fail above for the wrong reason.
    expect(SRC).toMatch(/--bento-card\b/)
  })

  it('states every strength through the one ink helper', () => {
    // `color-mix(... currentColor ...)` is the only colour expression allowed.
    // Any other colour function in the emitted styles would be a second one.
    expect(source).toMatch(/color-mix\(in srgb, currentColor/)
  })
})

/* ── 5. an accessible name on every drawing ─────────────────────────────── */

describe('every drawing exposes an accessible name', () => {
  const withName = populated([4, 9, 2, 7]).filter(([name]) => name !== 'Facts')

  for (const [name, node] of withName) {
    it(`${name} is role="img" with a stated label`, () => {
      const img = draw(node).querySelector('[role="img"]')
      expect(img, `${name} rendered no role="img"`).not.toBeNull()
      expect(img!.getAttribute('aria-label')!.length).toBeGreaterThan(0)
    })
  }

  it('Facts is not exposed as an image', () => {
    /* Facts renders a <dl> carrying `aria-label` and no role. `aria-label` on
       a <dl> is not reliably announced — the element has no name-from-author
       role in the same way an img does — so the label the caller supplied can
       be dropped entirely. Every sibling drawing uses role="img". */
    const host = draw(<Facts items={[{ label: 'a', value: '1' }]} srLabel="facts" />)
    expect(host.querySelector('[role="img"]')).not.toBeNull()
  })

  it('Facts requires a label, like every other drawing', () => {
    /* `srLabel` was optional on Facts alone, so it could render with no
       accessible name whatsoever — and it carried the label on a bare <dl>,
       which is not reliably announced. It is required now and sits on a
       role="img", the same contract the other eleven drawings keep. */
    const host = draw(<Facts items={[{ label: 'a', value: '1' }]} srLabel="context" />)
    const el = host.firstElementChild!
    expect(el.getAttribute('role')).toBe('img')
    expect(el.getAttribute('aria-label')).toBe('context')
  })
})

/* ── 6. the positioning maths ───────────────────────────────────────────── */

describe('Scale positions its dot', () => {
  const dotAt = (value: number) =>
    decl(styleOf(draw(<Scale value={value} min={10} max={20} srLabel="s" />), 'span > span'), 'left')

  it('puts the dot at 0% at the bottom of the range', () => expect(dotAt(10)).toBe('0%'))
  it('puts the dot at 100% at the top of the range', () => expect(dotAt(20)).toBe('100%'))
  it('puts the dot at 50% in the middle', () => expect(dotAt(15)).toBe('50%'))

  it('CLAMPS below the range rather than escaping the track', () => {
    // Without the clamp the dot leaves the hairline entirely and reads as
    // belonging to the cell beside it.
    expect(dotAt(-500)).toBe('0%')
  })
  it('CLAMPS above the range', () => expect(dotAt(1e11)).toBe('100%'))
})

describe('Gauge maths', () => {
  const pctOf = (value: number, total: number) =>
    draw(<Gauge value={value} total={total} srLabel="g" />).textContent

  it('clamps above 100', () => expect(pctOf(999, 10)).toBe('100%'))
  it('clamps below 0', () => expect(pctOf(-40, 10)).toBe('0%'))
  it('rounds to the nearest whole percent', () => expect(pctOf(1, 3)).toBe('33%'))
  it('rounds a half up', () => expect(pctOf(125, 1000)).toBe('13%'))

  it('draws no arc at 0%', () => {
    // An arc of zero length still paints two round caps at twelve o'clock,
    // which is a visible mark reporting a value of none.
    expect(draw(<Gauge value={0} total={10} srLabel="g" />).querySelectorAll('circle')).toHaveLength(1)
  })

  it('sets pathLength=100 so the dash array IS the percentage', () => {
    /* This is what makes the arc independent of the radius: no circumference
       arithmetic to get wrong when the ring is resized. */
    const host = draw(<Gauge value={37} total={100} srLabel="g" />)
    const arc = host.querySelectorAll('circle')[1]
    expect(arc.getAttribute('pathLength')).toBe('100')
    expect(arc.getAttribute('stroke-dasharray')).toBe('37 63')
  })

  it('the dash array always sums to the path length', () => {
    for (const [v, t] of [[1, 3], [999, 10], [7, 9], [0.5, 100]]) {
      const arc = draw(<Gauge value={v} total={t} srLabel="g" />).querySelectorAll('circle')[1]
      if (!arc) continue
      const [on, off] = arc.getAttribute('stroke-dasharray')!.split(' ').map(Number)
      expect(on + off).toBe(100)
    }
  })

  it('draws the arc as a stroke, with no disc punched out of the middle', () => {
    // The punched version had to paint that disc SOME colour, and the only
    // token for it was the card's own. A stroke has no hole to fill.
    const host = draw(<Gauge value={50} total={100} srLabel="g" />)
    for (const c of host.querySelectorAll('circle')) expect(c.getAttribute('fill')).toBe('none')
  })
})

describe('Rows and Compare share one scale', () => {
  it('Rows measures every bar against the largest', () => {
    const host = draw(<Rows items={[{ label: 'a', value: 25 }, { label: 'b', value: 100 }]} srLabel="r" />)
    const widths = [...host.querySelectorAll('span > span.block')].map((el) =>
      decl(el.getAttribute('style') ?? '', 'width'),
    )
    expect(widths).toEqual(['25%', '100%'])
  })

  it('Rows never overflows its track', () => {
    const host = draw(<Rows items={[{ label: 'a', value: 5 }, { label: 'b', value: 5 }]} srLabel="r" />)
    for (const el of host.querySelectorAll('span > span.block')) {
      expect(Number.parseFloat(decl(el.getAttribute('style') ?? '', 'width'))).toBeLessThanOrEqual(100)
    }
  })
})

/* ── 7. the shell ───────────────────────────────────────────────────────── */

describe('CardShell', () => {
  const shell = () =>
    draw(<CardShell title="Fees" sub="today" value="12" change="+3">
      <Line points={[1, 2, 3]} srLabel="l" />
    </CardShell>).firstElementChild as HTMLElement

  const rows = () => {
    const m = /grid-rows-\[([^\]]+)\]/.exec(shell().className)
    expect(m, 'the shell declares no explicit grid rows').not.toBeNull()
    return m![1].split('_')
  }

  it('is a four-row grid', () => {
    // Header, figure, drawing, action. The action moved out of the header and
    // down to the foot of the card, on the left, and it has a row of its own
    // rather than sitting over the drawing — a button floating on a chart is
    // the overlap this layout exists to prevent. A FIFTH row would mean
    // something new is competing with the drawing for height.
    expect(rows()).toHaveLength(4)
  })

  it('gives the drawing row the FRACTION', () => {
    /* The entire point of the shell: the drawing takes whatever height is
       left, rather than a fixed height that leaves a large cell as a small
       card with dead space under it. */
    const [header, figure, drawing, action] = rows()
    expect(header).toBe('auto')
    expect(figure).toBe('auto')
    expect(drawing).toMatch(/1fr/)
    // and the action costs only what it needs, so it cannot eat the drawing
    expect(action).toBe('auto')
  })

  it('lets the drawing row shrink below its content', () => {
    // `min-h-0` on the grid and on the drawing row: without it a grid child
    // refuses to shrink and the drawing pushes the card out of shape.
    expect(shell().className).toMatch(/\bmin-h-0\b/)
    expect((shell().children[2] as HTMLElement).className).toMatch(/\bmin-h-0\b/)
  })

  it('puts the children in the third row', () => {
    expect(shell().children[2].querySelector('[role="img"]')).not.toBeNull()
  })

  it('renders without a drawing, a sub, a glyph or a change', () => {
    const host = draw(<CardShell title="Fees" value="12" />)
    expect(host.textContent).toContain('Fees')
    expect(host.textContent).toContain('12')
  })

  it('takes the full height of its cell', () => {
    expect(shell().className).toMatch(/\bh-full\b/)
  })
})

/* ── 8. degenerate input ────────────────────────────────────────────────── */

describe('degenerate input does not throw', () => {
  const cases: [string, number[]][] = [
    ['NaN', [Number.NaN, Number.NaN, Number.NaN]],
    ['negatives', [-4, -100, -1]],
    ['mixed signs', [-4, 0, 9]],
    ['one item', [7]],
    ['two items', [7, 7]],
    ['500 items', Array.from({ length: 500 }, (_, i) => (i * 37) % 101)],
    ['paise-scale integers', [1e11, 2.5e11, 9.99e11]],
    ['Infinity', [Number.POSITIVE_INFINITY, 1, 2]],
  ]

  /* KNOWN BUG, and the only one in this file that takes the page down rather
     than drawing something wrong. `Flow` renders ONE SPAN PER UNIT:
     `Array.from({ length: Math.max(0, n) })`. The row values it is given are
     counts of things that moved between two states, and there is no ceiling on
     them anywhere — so a row of 1e11 (a paise amount handed to it by mistake)
     or a non-finite row throws `RangeError: Invalid array length` out of
     render, which unmounts the whole dashboard rather than one card. Well
     short of that, a row of 100000 quietly builds 100000 DOM nodes.
     Triggering input: <Flow rows={[1e11]} /> or <Flow rows={[Infinity]} />. */
  const crashes = new Set(['Flow|paise-scale integers', 'Flow|Infinity'])

  for (const [name, values] of cases) {
    for (const [drawing, node] of populated(values)) {
      if (crashes.has(`${drawing}|${name}`)) {
        it(`${drawing} survives ${name}`, () => {
          expect(() => draw(node)).not.toThrow()
        })
        continue
      }
      it(`${drawing} survives ${name}`, () => {
        expect(() => draw(node)).not.toThrow()
      })
    }
  }

  it('a 500-item series draws 500 marks and no more', () => {
    const values = Array.from({ length: 500 }, (_, i) => i + 1)
    const host = draw(<Bars values={values} srLabel="b" />)
    expect(host.querySelectorAll('[role="img"] > span')).toHaveLength(500)
  })

  it('paise-scale integers keep their precision in Rows', () => {
    const host = draw(<Rows items={[{ label: 'a', value: 1e11 }, { label: 'b', value: 5e10 }]} srLabel="r" />)
    expect(host.textContent).toContain('100000000000')
    const widths = [...host.querySelectorAll('span > span.block')].map((el) =>
      decl(el.getAttribute('style') ?? '', 'width'),
    )
    expect(widths).toEqual(['100%', '50%'])
  })

  it('Gauge prints NaN% for a non-finite value', () => {
    /* `Math.max(0, Math.min(100, Math.round(NaN)))` is NaN — the clamp does
       not clamp a non-number. The card then prints the literal text "NaN%"
       where the reading should be, and the arc's dash array is "NaN NaN".
       Triggering input: <Gauge value={NaN} total={100} />, which is what an
       API field that came back null produces after arithmetic. */
    expect(draw(<Gauge value={Number.NaN} total={100} srLabel="g" />).textContent).not.toContain('NaN')
  })

  it('Scale refuses a non-finite value', () => {
    /* A clamp does not clamp a non-number: `Math.min/max` propagate NaN, so
       `left: NaN%` reached the DOM. That is an invalid declaration, the browser
       drops it, and the dot falls back to the left edge — an UNKNOWN value
       drawn as the minimum of the range, which is the most misleading place it
       could land. It now draws nothing at all. */
    expect(drewNothing(<Scale value={Number.NaN} min={0} max={10} srLabel="s" />)).toBe(true)
  })
})

/* NOT TESTED HERE, DELIBERATELY.

   Anything that needs a box model. jsdom has none: it lays nothing out and
   reports zero for every measured size, so an assertion that the drawing row
   actually receives the leftover height, that a 500-bar strip does not
   overflow its cell, or that the ring is square at a 2x1 would be an
   assertion about jsdom rather than about the card. The shell's contract is
   checked at the level it is WRITTEN at — the grid template — and the rest
   belongs in the Playwright pass, which has a real engine under it. */
