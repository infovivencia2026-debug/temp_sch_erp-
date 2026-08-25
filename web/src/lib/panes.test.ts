import { beforeEach, describe, expect, it } from 'vitest'
import { splitTo, closePane, closeSplit, focusPane, setFocusedPath, isSplit, MAX_PANES } from './panes'

/* The store, not the grid. Three things a split view usually gets wrong: where
   the new pane lands relative to the one you asked from, which pane the
   address bar is describing afterwards, and what happens on the way back down
   to one. */

function state() {
  return JSON.parse(sessionStorage.getItem('erp.panes') ?? 'null') as
    { paths: string[]; focus: number; dir: string } | null
}

beforeEach(() => {
  closeSplit()
  sessionStorage.clear()
})

describe('splitting', () => {
  it('seeds both halves from what was already on screen', () => {
    splitTo('right', '/b', '/a')
    expect(state()?.paths).toEqual(['/a', '/b'])
  })

  it('puts a left or up split before the pane it was asked from', () => {
    splitTo('left', '/b', '/a')
    expect(state()?.paths).toEqual(['/b', '/a'])
  })

  it('takes its axis from the first split', () => {
    splitTo('down', '/b', '/a')
    expect(state()?.dir).toBe('col')
  })

  it('keeps the axis when a later split disagrees', () => {
    splitTo('down', '/b', '/a')
    splitTo('right', '/c', '/a')
    expect(state()?.dir).toBe('col')
  })

  it('focuses the pane it just made, so the address bar follows it', () => {
    splitTo('right', '/b', '/a')
    expect(state()?.focus).toBe(1)
  })

  it('refuses a fifth pane rather than silently doing nothing', () => {
    expect(splitTo('right', '/b', '/a')).toBe(true)
    expect(splitTo('right', '/c', '/a')).toBe(true)
    expect(splitTo('right', '/d', '/a')).toBe(true)
    expect(splitTo('right', '/e', '/a')).toBe(false)
    expect(state()?.paths).toHaveLength(MAX_PANES)
  })
})

describe('navigation', () => {
  it('points the focused pane at the new path and leaves the others alone', () => {
    splitTo('right', '/b', '/a')
    focusPane(0)
    setFocusedPath('/z')
    expect(state()?.paths).toEqual(['/z', '/b'])
  })

  it('does nothing at all when there is no split', () => {
    setFocusedPath('/z')
    expect(isSplit()).toBe(false)
    expect(state()).toBeNull()
  })
})

describe('closing', () => {
  it('collapses entirely on the way down to one pane', () => {
    splitTo('right', '/b', '/a')
    closePane(1)
    expect(isSplit()).toBe(false)
  })

  it('keeps the rest, and a focus that still points at one of them', () => {
    splitTo('right', '/b', '/a')
    splitTo('right', '/c', '/a')
    closePane(2)
    expect(state()?.paths).toEqual(['/a', '/b'])
    expect(state()?.focus).toBeLessThan(2)
  })
})
