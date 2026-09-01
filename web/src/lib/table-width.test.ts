import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import { Table, Td } from '@/components/ui'

/* The squeeze that broke "Demo School" into "Demo Scho ol".

   `w-full` divides a card's width between however many columns there are.
   Past eight that is not a narrow column, it is a column narrower than the
   words in it, and the browser breaks mid-word to fit. The table has always
   been able to take its natural width and scroll instead — it was opt-in, and
   two hundred of the tables in this product never opted in.

   These pin the rule so it cannot quietly become opt-in again. */

const row = (n: number) =>
  h('tr', null, ...Array.from({ length: n }, (_, i) => h(Td, { key: i }, 'x')))

const markup = (cols: number, wide?: boolean) =>
  renderToStaticMarkup(
    h(Table, {
      head: Array.from({ length: cols }, (_, i) => `c${i}`),
      wide,
      children: row(cols),
    }),
  )

describe('a table decides its own width from its column count', () => {
  it('shares the card between a handful of columns', () => {
    const out = markup(5)
    expect(out).toContain('w-full')
    expect(out).not.toContain('is-wide')
  })

  it('takes the room it needs once there are eight', () => {
    const out = markup(8)
    expect(out).toContain('is-wide')
    // Still fills the card when the content happens to be narrow, which is
    // what makes this safe to turn on by default rather than a trade.
    expect(out).toContain('min-w-full')
  })

  it('lets a caller force either answer', () => {
    expect(markup(4, true)).toContain('is-wide')
    expect(markup(12, false)).not.toContain('is-wide')
  })

  it('always leaves the container able to scroll', () => {
    expect(markup(12)).toContain('scroll-x')
    expect(markup(3)).toContain('scroll-x')
  })
})
