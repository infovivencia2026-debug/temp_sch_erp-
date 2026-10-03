import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { afterMotion, carryOn, crossfade, crossingNow, installMotionGuard, interruptedAt, isJump, transitioned, type Sample } from './motion'

const S = (o: Partial<Sample> = {}): Sample => ({ opacity: 1, x: 0, y: 0, sx: 1, sy: 1, w: 100, h: 100, ...o })

describe('interruptedAt', () => {
  it('is where a running animation had got to', () => {
    expect(interruptedAt(120, 0, 200)).toBe(120)
  })
  it('counts the delay out', () => {
    expect(interruptedAt(120, 40, 200)).toBe(80)
    expect(interruptedAt(20, 40, 200)).toBe(0)
  })
  it('is null once the animation had finished, so nothing is carried on', () => {
    expect(interruptedAt(200, 0, 200)).toBeNull()
    expect(interruptedAt(500, 0, 200)).toBeNull()
  })
  it('is null for an animation with no length', () => {
    expect(interruptedAt(10, 0, 0)).toBeNull()
  })
})

describe('carryOn', () => {
  const from = { opacity: '0.4', transform: 'matrix(0.98, 0, 0, 0.98, 0, 0)' }
  it('rewrites an explicit first frame with the values reached', () => {
    const out = carryOn([
      { offset: 0, computedOffset: 0, opacity: '1', transform: 'none', easing: 'linear', composite: 'auto' },
      { offset: 1, computedOffset: 1, opacity: '0', transform: 'scale(0.98)', easing: 'linear', composite: 'auto' },
    ] as ComputedKeyframe[], from)
    expect(out[0]).toMatchObject({ offset: 0, opacity: '0.4', transform: from.transform })
    expect(out[1]).toMatchObject({ opacity: '0', transform: 'scale(0.98)' })
    expect(out).toHaveLength(2)
    expect('computedOffset' in out[0]).toBe(false)
  })
  it('adds a first frame to a to-only keyframe', () => {
    const out = carryOn([{ offset: 1, computedOffset: 1, opacity: '0', easing: 'linear', composite: 'auto' }] as ComputedKeyframe[], from)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ offset: 0, opacity: '0.4' })
  })
})

describe('isJump', () => {
  it('lets a step the animation can cover pass', () => {
    expect(isJump(S({ opacity: 0.2 }), S({ opacity: 0.35 }), 17 / 200)).toBe('')
  })
  it('calls a restart a jump', () => {
    expect(isJump(S({ opacity: 0.6 }), S({ opacity: 0 }), 17 / 200)).toMatch(/opacity/)
  })
  it('calls an end snap a jump', () => {
    expect(isJump(S({ y: 3 }), S({ y: 60 }), 17 / 200)).toMatch(/^y/)
  })
  it('measures movement against the distance travelled when known', () => {
    const a = S({ x: 0, w: 48 }), b = S({ x: 40, w: 48 })
    expect(isJump(a, b, 17 / 220)).toMatch(/^x/)
    expect(isJump(a, b, 17 / 220, { x: 300, y: 0 })).toBe('')
  })
  it('never calls a change under the floor a jump', () => {
    expect(isJump(S({ opacity: 0.5 }), S({ opacity: 0.62 }), 0)).toBe('')
  })
})

describe('afterMotion', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('fires once, on the element’s own end event', () => {
    const el = document.createElement('div'), child = document.createElement('span')
    el.appendChild(child)
    document.body.appendChild(el)
    const done = vi.fn()
    afterMotion(el, done, 600)
    child.dispatchEvent(new Event('transitionend', { bubbles: true }))
    expect(done).not.toHaveBeenCalled()
    el.dispatchEvent(new Event('transitionend'))
    el.dispatchEvent(new Event('animationend'))
    vi.advanceTimersByTime(1000)
    expect(done).toHaveBeenCalledTimes(1)
    el.remove()
  })
  it('falls back to the timer when no end event comes', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const done = vi.fn()
    afterMotion(el, done, 300)
    vi.advanceTimersByTime(299)
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(done).toHaveBeenCalledTimes(1)
    el.remove()
  })
  it('can be cancelled', () => {
    const el = document.createElement('div')
    const done = vi.fn()
    afterMotion(el, done, 100)()
    vi.advanceTimersByTime(200)
    expect(done).not.toHaveBeenCalled()
  })
})

describe('one crossing at a time', () => {
  const doc = document as unknown as { startViewTransition?: unknown }
  let finish: () => void = () => {}
  let started = 0
  beforeEach(() => {
    started = 0
    ;doc.startViewTransition = (cb: () => void) => {
      started++
      cb()
      const finished = new Promise<void>((r) => { finish = r })
      return { finished, ready: Promise.resolve(), updateCallbackDone: Promise.resolve() }
    }
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia
  })
  afterEach(() => { delete doc.startViewTransition })

  it('commits a second change inside the first rather than skipping it', async () => {
    const a = vi.fn(), b = vi.fn()
    crossfade(a)
    expect(crossingNow()).toBe(true)
    transitioned(b)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(started).toBe(1)
    finish()
    await Promise.resolve(); await Promise.resolve()
    expect(crossingNow()).toBe(false)
    expect(document.documentElement.hasAttribute('data-vt')).toBe(false)
  })
  it('commits plainly under reduced motion', () => {
    document.documentElement.setAttribute('data-reduce-motion', '')
    const a = vi.fn()
    crossfade(a)
    expect(a).toHaveBeenCalledTimes(1)
    expect(started).toBe(0)
    document.documentElement.removeAttribute('data-reduce-motion')
  })
})

describe('the guard', () => {
  it('pauses loops while the tab is hidden', () => {
    ;(document as Document & { getAnimations?: () => Animation[] }).getAnimations ??= () => []
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia
    installMotionGuard()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.hasAttribute('data-tab-hidden')).toBe(true)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.hasAttribute('data-tab-hidden')).toBe(false)
  })
})
