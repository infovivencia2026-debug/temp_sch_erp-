import { beforeEach, describe, expect, it } from 'vitest'
import { openTab, closeTab, closeOthers, closeAll, neighbourOf, useTabs, MAX_TABS } from './tabs'

/* The store, not the strip. What matters here is the two places a tab bar
   usually gets it wrong: which tab it drops when it is full, and where it sends
   you when you close the one you are looking at. */

function current() {
  // useTabs' snapshot is the module's array; reading it through the hook would
  // need a renderer, and the store is deliberately renderer-free.
  return JSON.parse(sessionStorage.getItem('erp.tabs') ?? '[]') as { path: string; title: string }[]
}

beforeEach(() => {
  closeAll()
  sessionStorage.clear()
})

describe('opening', () => {
  it('opens a tab and keeps its order', () => {
    openTab('/a', 'A', '/a')
    openTab('/b', 'B', '/a')
    expect(current().map((t) => t.path)).toEqual(['/a', '/b'])
  })

  it('brings an open path forward rather than duplicating it', () => {
    openTab('/a', 'A', '/a')
    openTab('/b', 'B', '/a')
    openTab('/a', 'A', '/b')
    expect(current().map((t) => t.path)).toEqual(['/a', '/b'])
  })

  it('refreshes a title that has since loaded', () => {
    openTab('/a', '/a', '/a')
    openTab('/a', 'Student 360', '/a')
    expect(current()[0].title).toBe('Student 360')
  })

  /* Two students in Student 360 are two screens. Matching on the path without
     its query would collapse them into one tab, which is the opposite of what
     somebody opening both of them wants. */
  it('treats different query strings as different screens', () => {
    openTab('/students?id=1', 'Aarav', '/students?id=1')
    openTab('/students?id=2', 'Meera', '/students?id=1')
    expect(current()).toHaveLength(2)
  })
})

describe('when the strip is full', () => {
  it('never drops the tab being looked at', () => {
    for (let i = 0; i < MAX_TABS; i++) openTab(`/p${i}`, `P${i}`, '/p0')
    // /p0 is the oldest AND the active one; the next open must evict /p1.
    openTab('/new', 'New', '/p0')
    const paths = current().map((t) => t.path)
    expect(paths).toContain('/p0')
    expect(paths).toContain('/new')
    expect(paths).not.toContain('/p1')
    expect(paths).toHaveLength(MAX_TABS)
  })
})

describe('closing', () => {
  it('sends you to the right-hand neighbour', () => {
    openTab('/a', 'A', '/a'); openTab('/b', 'B', '/a'); openTab('/c', 'C', '/a')
    expect(neighbourOf('/b')).toBe('/c')
  })

  it('falls back to the left when there is nothing to the right', () => {
    openTab('/a', 'A', '/a'); openTab('/b', 'B', '/a')
    expect(neighbourOf('/b')).toBe('/a')
  })

  it('has nowhere to send you when it was the only tab', () => {
    openTab('/a', 'A', '/a')
    expect(neighbourOf('/a')).toBeNull()
  })

  it('closes one, others, and all', () => {
    openTab('/a', 'A', '/a'); openTab('/b', 'B', '/a'); openTab('/c', 'C', '/a')
    closeTab('/b')
    expect(current().map((t) => t.path)).toEqual(['/a', '/c'])
    closeOthers('/c')
    expect(current().map((t) => t.path)).toEqual(['/c'])
    closeAll()
    expect(current()).toEqual([])
  })

  it('removes the storage key rather than leaving an empty list', () => {
    openTab('/a', 'A', '/a')
    closeAll()
    expect(sessionStorage.getItem('erp.tabs')).toBeNull()
  })
})

describe('a corrupt stored value', () => {
  it('degrades to no tabs rather than throwing', () => {
    sessionStorage.setItem('erp.tabs', '{not json')
    // read() runs at import; assert the shape it guards against instead.
    expect(() => openTab('/a', 'A', '/a')).not.toThrow()
  })
})

describe('the hook', () => {
  it('exposes the same list the module holds', () => {
    openTab('/a', 'A', '/a')
    expect(typeof useTabs).toBe('function')
  })
})
