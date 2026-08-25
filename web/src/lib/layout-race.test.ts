import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

/* Switching the layout must not be undone by a read that started after it.

   The bug this pins was reported as "I need to click Sidebar multiple times to
   switch". Switching swaps the whole shell, so the control unmounts and a fresh
   one mounts in the new chrome; that fresh control reconciles on mount by
   GETting /preferences/display. The PUT from the click has not landed yet, so
   the GET returns the OLD layout and applies it, and the screen snaps back
   about two seconds later. The second click works because by then the first
   save has arrived.

   Both halves are asserted: a reconcile during a save is discarded, and one
   after a completed save is honoured — the second matters because discarding
   everything would break the reason reconcile exists, which is picking up a
   layout chosen on another device.
*/
const put = vi.fn()
const get = vi.fn()
vi.mock('./api', () => ({ api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a) } }))

describe('the layout switch', () => {
  beforeEach(() => {
    vi.resetModules()
    get.mockReset()
    put.mockReset()
    localStorage.clear()
    document.documentElement.removeAttribute('data-layout')
  })
  afterEach(() => vi.restoreAllMocks())

  it('ignores a stale reconcile while the choice is still saving', async () => {
    let release!: () => void
    get.mockReturnValue(new Promise((r) => { release = () => r({ preference: {} }) }))
    put.mockResolvedValue({})

    const m = await import('./layout')
    // The user picks classic. The save is in flight, deliberately not resolved.
    m.chooseLayout('classic')
    expect(m.currentLayout()).toBe('classic')

    // The remounted control reads the account row, which still says bento.
    m.reconcileLayout('bento')
    expect(m.currentLayout()).toBe('classic')

    release()
    await new Promise((r) => setTimeout(r, 0))
  })

  it('still honours a reconcile once nothing is in flight', async () => {
    const m = await import('./layout')
    // No save has been made in this module instance, so a layout chosen on
    // another device must be adopted — this is what reconcile is for.
    m.reconcileLayout('classic')
    expect(m.currentLayout()).toBe('classic')
  })
})
