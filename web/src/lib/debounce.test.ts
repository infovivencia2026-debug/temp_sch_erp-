import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useDebouncedValue } from './debounce'

/* No testing-library in this repo (see visible.test.ts); the hook is driven
   through a probe component under react-dom/client with fake timers. */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null
let last = ''

function Probe({ v }: { v: string }) {
  last = useDebouncedValue(v, 250)
  return null
}

function render(v: string) {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => root!.render(createElement(Probe, { v })))
}

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = null
    host = null
    vi.useRealTimers()
  })

  it('returns the first value at once', () => {
    render('ra')
    expect(last).toBe('ra')
  })

  it('only settles after the input has been still', () => {
    render('')
    render('r')
    act(() => void vi.advanceTimersByTime(100))
    render('ra')
    act(() => void vi.advanceTimersByTime(100))
    render('ram')
    act(() => void vi.advanceTimersByTime(249))
    expect(last).toBe('')
    act(() => void vi.advanceTimersByTime(1))
    expect(last).toBe('ram')
  })
})
