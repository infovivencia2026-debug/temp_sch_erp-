import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAppearance, getAppearance } from './appearance'
import { buzz, silenceHaptics } from './haptics'

/* buzz() must stay quiet for the person who switched Haptics off and for
   the person who asked the OS for less motion, whatever the call site. */

function reducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes('prefers-reduced-motion') ? matches : false,
    media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

describe('buzz', () => {
  let vibrate: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vibrate = vi.fn(() => true)
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true, writable: true })
    delete (window as unknown as { ErpShell?: unknown }).ErpShell
    reducedMotion(false)
    applyAppearance({ ...getAppearance(), haptics: 'on' })
    silenceHaptics(false)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('plays the pattern when haptics are on and motion is welcome', () => {
    buzz('tap')
    expect(vibrate).toHaveBeenCalledWith(8)
    buzz('warn')
    expect(vibrate).toHaveBeenLastCalledWith([20, 40, 20])
  })

  it('is silent when the person switched Haptics off, and back when they switch it on', () => {
    applyAppearance({ ...getAppearance(), haptics: 'off' })
    buzz('select')
    expect(vibrate).not.toHaveBeenCalled()
    applyAppearance({ ...getAppearance(), haptics: 'on' })
    buzz('select')
    expect(vibrate).toHaveBeenCalledTimes(1)
  })

  it('is silent under prefers-reduced-motion', () => {
    reducedMotion(true)
    buzz('open')
    expect(vibrate).not.toHaveBeenCalled()
  })

  it('the Haptics switch also silences the shell bridge', () => {
    const haptic = vi.fn()
    ;(window as unknown as { ErpShell: { haptic: (k: string) => void } }).ErpShell = { haptic }
    buzz('snap')
    expect(haptic).toHaveBeenCalledWith('snap')
    expect(vibrate).not.toHaveBeenCalled()
    applyAppearance({ ...getAppearance(), haptics: 'off' })
    buzz('snap')
    expect(haptic).toHaveBeenCalledTimes(1)
  })

  it('defaults to on', () => {
    localStorage.removeItem('erp.haptics')
    expect(getAppearance().haptics).toBe('on')
  })
})
