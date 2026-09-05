import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useTabVisible, useVisibleInterval } from './visible'

/* The hook every poll leans on. If this lies, a dozen screens either keep
   polling a hidden tab (the bill the hook exists to stop) or never resume
   (a parent looking at a map that is quietly forty minutes old). No
   testing-library in this repo, so the hook is driven through a probe
   component under react-dom/client with jsdom faking `document.hidden`. */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let hidden = false
let root: Root | null = null
let host: HTMLDivElement | null = null

function setHidden(v: boolean) {
  hidden = v
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function mount<T>(hook: () => T): { read: () => T; unmount: () => void } {
  let last!: T
  function Probe() {
    last = hook()
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Probe)))
  return {
    read: () => last,
    unmount: () => act(() => root!.unmount()),
  }
}

beforeEach(() => {
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
})

describe('useTabVisible', () => {
  it('starts from document.hidden', () => {
    hidden = true
    const h = mount(useTabVisible)
    expect(h.read()).toBe(false)
    h.unmount()
    root = null
    hidden = false
    const v = mount(useTabVisible)
    expect(v.read()).toBe(true)
  })

  it('flips on visibilitychange, both ways', () => {
    const h = mount(useTabVisible)
    expect(h.read()).toBe(true)
    setHidden(true)
    expect(h.read()).toBe(false)
    setHidden(false)
    expect(h.read()).toBe(true)
  })

  it('removes its listener on unmount', () => {
    const before = countVisibilityListeners()
    const h = mount(useTabVisible)
    expect(countVisibilityListeners()).toBe(before + 1)
    h.unmount()
    root = null
    expect(countVisibilityListeners()).toBe(before)
  })
})

describe('useVisibleInterval', () => {
  it('is the interval while visible and false while hidden', () => {
    const h = mount(() => useVisibleInterval(30_000))
    expect(h.read()).toBe(30_000)
    setHidden(true)
    expect(h.read()).toBe(false)
    setHidden(false)
    expect(h.read()).toBe(30_000)
  })
})

/* jsdom has no API for listing listeners, so addEventListener and
   removeEventListener on document are wrapped once, for this file only, and
   the count of live `visibilitychange` handlers is kept by hand. */
const live = new Set<EventListenerOrEventListenerObject>()
const origAdd = document.addEventListener.bind(document)
const origRemove = document.removeEventListener.bind(document)
document.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
  if (type === 'visibilitychange') live.add(fn)
  origAdd(type, fn, opts as AddEventListenerOptions)
}) as typeof document.addEventListener
document.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
  if (type === 'visibilitychange') live.delete(fn)
  origRemove(type, fn, opts as EventListenerOptions)
}) as typeof document.removeEventListener
function countVisibilityListeners() {
  return live.size
}
