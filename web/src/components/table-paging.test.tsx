import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Table, Td } from './ui'

/* THE TABLE'S FAR END.

   `<Table>` pages ten at a time through whatever array it is handed, which
   meant a list could only ever reach as far as one request went. The three
   new props hand that far end back to the caller: `hasMore` says the list
   continues, `onLoadMore` is how to continue it, `loadingMore` says a page is
   on the way.

   The half of this that matters most is the half that changes nothing. There
   are roughly four hundred tables in this product and none of them passes
   these props; every one of them must behave exactly as it did, which is what
   the first test here holds.
*/

// React 18's act() wants to be told it is in a test environment.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function rows(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => (
    <tr key={from + i}><Td>Child {from + i}</Td></tr>
  ))
}

function pagerText() {
  return host.querySelector('.tabular-nums')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
}

describe('a table given no paging props', () => {
  it('pages what it holds and stops there, exactly as before', () => {
    act(() => { root.render(<Table head={['Name']}>{rows(25)}</Table>) })

    expect(pagerText()).toBe('1–10 of 25')
    expect(button('Previous')?.disabled).toBe(true)
    expect(button('Next')?.disabled).toBe(false)

    act(() => { button('Next')!.click() })
    act(() => { button('Next')!.click() })

    // Page three is the end of 25 rows, and the end is where it stops.
    expect(pagerText()).toBe('21–25 of 25')
    expect(button('Next')?.disabled).toBe(true)
  })

  it('draws no pager at all below the page size', () => {
    act(() => { root.render(<Table head={['Name']}>{rows(4)}</Table>) })
    expect(button('Next')).toBeUndefined()
  })
})

describe('a table told the list continues', () => {
  it('asks for more instead of greying out at the loaded end', () => {
    const onLoadMore = vi.fn()
    act(() => {
      root.render(
        <Table head={['Name']} hasMore onLoadMore={onLoadMore} total={345}>{rows(20)}</Table>,
      )
    })

    // The denominator is the whole roll from the first page, not what loaded.
    expect(pagerText()).toBe('1–10 of 345')

    act(() => { button('Next')!.click() })
    expect(pagerText()).toBe('11–20 of 345')
    expect(onLoadMore).not.toHaveBeenCalled()

    /* The press that used to be impossible. Twenty rows are loaded and the
       reader is on the last of them; Next is live, and it asks. */
    expect(button('Next')?.disabled).toBe(false)
    act(() => { button('Next')!.click() })
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('keeps the reader in place when the next page arrives', () => {
    const onLoadMore = vi.fn()
    const render = (n: number) => act(() => {
      root.render(
        <Table head={['Name']} hasMore onLoadMore={onLoadMore} total={345}>{rows(n)}</Table>,
      )
    })
    render(20)
    act(() => { button('Next')!.click() })   // page 2
    act(() => { button('Next')!.click() })   // asks for page 3
    render(30)                                // ...which arrives

    /* Growing the rows must not snap back to page one. A filter shortens the
       list and should snap; a page arriving lengthens it and means "you are
       still where you were, there is more below". */
    expect(pagerText()).toBe('21–30 of 345')
  })

  it('still snaps back when a filter shortens the list', () => {
    const onLoadMore = vi.fn()
    const render = (n: number) => act(() => {
      root.render(
        <Table head={['Name']} hasMore onLoadMore={onLoadMore} total={345}>{rows(n)}</Table>,
      )
    })
    render(40)
    act(() => { button('Next')!.click() })
    act(() => { button('Next')!.click() })
    expect(pagerText()).toBe('21–30 of 345')
    render(12)
    // Back to the top of the shortened list. The denominator is still the
    // server's, because the server is still the one who counted.
    expect(pagerText()).toBe('1–10 of 345')
  })

  it('says the count grows rather than inventing an end, when nobody counted', () => {
    act(() => {
      root.render(<Table head={['Name']} hasMore onLoadMore={() => {}}>{rows(20)}</Table>)
    })
    expect(pagerText()).toBe('1–10 of 20+')
  })

  it('shows shimmering rows under the real ones while a page is in flight', () => {
    act(() => {
      root.render(
        <Table head={['Name']} hasMore loadingMore onLoadMore={() => {}} total={345}>
          {rows(20)}
        </Table>,
      )
    })
    // The loaded rows stay put; the skeleton is additional, never instead.
    expect(host.textContent).toContain('Child 0')
    expect(host.querySelectorAll('tbody tr').length).toBeGreaterThan(10)
  })

  it('does not ask again while it is already asking', () => {
    const onLoadMore = vi.fn()
    act(() => {
      root.render(
        <Table head={['Name']} hasMore loadingMore onLoadMore={onLoadMore} total={345}>
          {rows(10)}
        </Table>,
      )
    })
    act(() => { button('Next')!.click() })
    expect(onLoadMore).not.toHaveBeenCalled()
  })
})
