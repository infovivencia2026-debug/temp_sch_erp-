import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TIERS, PHONE_TIERS, TIER_DIMS, PHONE_TIER_DIMS, tierOf, dimsForTier, tierLabelKey, type SizeTier,
} from './size-tiers'
import { useLayout, dimsOf, tintOf } from './widgets'

/* The four named sizes over the stored width and height.

   Two things are under test. The classifier — every shape the old picker
   offered must read as the tier the table on `tierOf` promises, on both
   boards — and the store's `setTier`, which is the one place a tier is
   written back as a width and a height. The store part uses the same
   dispatcher trick as widgets.test.ts: useLayout is a hook, and a renderer
   is more than a store test needs. */

/* ---------- the legacy mapping table ---------- */

/** The eight shapes the old picker offered, and what each reads as now. */
const LEGACY: { w: number; h: number; desktop: SizeTier; phone: SizeTier }[] = [
  { w: 1, h: 1, desktop: 'small', phone: 'small' },
  { w: 1, h: 2, desktop: 'large', phone: 'large' },
  { w: 2, h: 1, desktop: 'medium', phone: 'small' },
  { w: 2, h: 2, desktop: 'large', phone: 'large' },
  { w: 3, h: 1, desktop: 'wide', phone: 'small' },
  { w: 3, h: 2, desktop: 'large', phone: 'large' },
  { w: 4, h: 2, desktop: 'large', phone: 'large' },
  { w: 5, h: 1, desktop: 'wide', phone: 'small' },
]

describe('tierOf classifies every legacy shape', () => {
  for (const { w, h, desktop, phone } of LEGACY) {
    it(`${w}x${h} is ${desktop} on the desktop board`, () => {
      expect(tierOf(w, h, false)).toBe(desktop)
    })
    it(`${w}x${h} is ${phone} on the phone board`, () => {
      expect(tierOf(w, h, true)).toBe(phone)
    })
  }

  it('height decides first: anything two rows tall is large, whatever its width', () => {
    for (const w of [1, 2, 3, 4, 5]) {
      for (const h of [2, 3, 4, 5]) {
        expect(tierOf(w, h, false)).toBe('large')
        expect(tierOf(w, h, true)).toBe('large')
      }
    }
  })

  it('a phone never reports medium or wide', () => {
    for (const w of [1, 2, 3, 4, 5]) {
      expect(PHONE_TIERS).toContain(tierOf(w, 1, true))
      expect(PHONE_TIERS).toContain(tierOf(w, 2, true))
    }
  })

  it('an unreadable dimension reads as the smallest, not as a throw', () => {
    expect(tierOf(Number.NaN, Number.NaN, false)).toBe('small')
    expect(tierOf(0, 0, false)).toBe('small')
  })
})

/* ---------- round trips ---------- */

describe('dimsForTier and tierOf agree', () => {
  it('every desktop tier survives the round trip', () => {
    for (const tier of TIERS) {
      const { w, h } = dimsForTier(tier, false)
      expect(tierOf(w, h, false)).toBe(tier)
    }
  })

  it('on a phone, small and large round-trip; medium and wide collapse to small by design', () => {
    for (const tier of PHONE_TIERS) {
      const { w, h } = dimsForTier(tier, true)
      expect(tierOf(w, h, true)).toBe(tier)
    }
    expect(tierOf(dimsForTier('medium', true).w, dimsForTier('medium', true).h, true)).toBe('small')
    expect(tierOf(dimsForTier('wide', true).w, dimsForTier('wide', true).h, true)).toBe('small')
  })

  it('returns a copy, so a caller cannot edit the table through it', () => {
    const d = dimsForTier('large', false)
    d.w = 99
    expect(TIER_DIMS.large).toEqual({ w: 2, h: 2 })
    expect(dimsForTier('large', false)).toEqual({ w: 2, h: 2 })
  })

  it('the desktop table is the one the header promises', () => {
    expect(TIER_DIMS).toEqual({
      small: { w: 1, h: 1 },
      medium: { w: 2, h: 1 },
      large: { w: 2, h: 2 },
      wide: { w: 3, h: 1 },
    })
  })

  it('the phone table draws every card the full page width', () => {
    for (const tier of TIERS) expect(PHONE_TIER_DIMS[tier].w).toBe(2)
    expect(PHONE_TIER_DIMS.large.h).toBe(2)
    expect(PHONE_TIER_DIMS.small.h).toBe(1)
  })

  it('names the locale key the same way for every tier', () => {
    for (const tier of TIERS) expect(tierLabelKey(tier)).toBe(`bento.size.${tier}`)
  })
})

/* ---------- setTier through the store ---------- */

let dashCounter = 0
/* The store caches a layout per dashboard id for the life of the process, so
   every test takes a fresh id rather than inheriting the last one's object. */
function freshDashboard(): string {
  dashCounter += 1
  return `tier-dash-${dashCounter}`
}

/* useCallback returning the raw function and useSyncExternalStore returning
   getSnapshot() is exactly what a mount does; nothing else useLayout calls. */
function callHook<T>(fn: () => T): T {
  const internals = (React as unknown as Record<string, any>)[
    '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED'
  ]
  if (!internals || !internals.ReactCurrentDispatcher) {
    throw new Error('React internals unavailable: this harness needs React 18')
  }
  const slot = internals.ReactCurrentDispatcher
  const previous = slot.current
  slot.current = {
    useCallback: (f: unknown) => f,
    useMemo: (f: () => unknown) => f(),
    useRef: (v: unknown) => ({ current: v }),
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useDebugValue: () => undefined,
    useSyncExternalStore: (_sub: unknown, get: () => unknown) => get(),
  }
  try {
    return fn()
  } finally {
    slot.current = previous
  }
}

function api(dashboard: string) {
  return callHook(() => useLayout(dashboard))
}

describe('setTier writes a tier as a width and a height', () => {
  it('stores the desktop dims for each tier', () => {
    const d = freshDashboard()
    for (const tier of TIERS) {
      api(d).setTier('fees', tier, false)
      expect(dimsOf(api(d).layout, 'fees', 'small')).toEqual(TIER_DIMS[tier])
      expect(api(d).layout.placed.filter((p) => p.id === 'fees')).toHaveLength(1)
    }
  })

  it('on the phone, writes the height and keeps the width it is given', () => {
    const d = freshDashboard()
    api(d).setTier('fees', 'large', true, 1)
    expect(dimsOf(api(d).layout, 'fees', 'small')).toEqual({ w: 1, h: 2 })
    // No width given: the stored one stays.
    api(d).setTier('fees', 'small', true)
    expect(dimsOf(api(d).layout, 'fees', 'small')).toEqual({ w: 1, h: 1 })
    // Never placed and nothing to keep: the phone table's own, a whole shape.
    const e = freshDashboard()
    api(e).setTier('fees', 'large', true)
    expect(dimsOf(api(e).layout, 'fees', 'small')).toEqual({ w: 2, h: 2 })
  })

  it('a desk Small touched on the phone still reads as Small on the desk', () => {
    const d = freshDashboard()
    api(d).setTier('fees', 'small', false)
    api(d).setTier('fees', 'large', true, 1)
    api(d).setTier('fees', 'small', true, 1)
    const { w, h } = dimsOf(api(d).layout, 'fees', 'small')
    expect({ w, h }).toEqual({ w: 1, h: 1 })
    expect(tierOf(w, h, false)).toBe('small')
  })

  it('places a card that was never placed, and un-removes one that was', () => {
    const d = freshDashboard()
    api(d).remove('fees')
    api(d).setTier('fees', 'medium', false)
    expect(api(d).layout.removed).not.toContain('fees')
    expect(api(d).layout.placed).toEqual([{ id: 'fees', w: 2, h: 1 }])
  })

  it('keeps the colour, because size and colour share one row', () => {
    const RED = { h: 0, s: 80, l: 50 }
    const d = freshDashboard()
    api(d).recolour('fees', RED, 1, 1)
    api(d).setTier('fees', 'wide', false)
    expect(api(d).layout.placed[0]).toEqual({ id: 'fees', w: 3, h: 1, tint: RED })
  })

  it('is one undo step, like any other resize', () => {
    const d = freshDashboard()
    api(d).setTier('fees', 'large', false)
    expect(api(d).canUndo).toBe(true)
    api(d).undo()
    expect(api(d).layout.placed).toEqual([])
  })
})

/* ---------- the presets still read sensibly ---------- */

describe('every preset produces shapes tierOf can name', () => {
  const board = ['a', 'b', 'c'].map((id, index) => ({
    id, label: id, index, size: 'small' as const, w: 1, h: 1,
  }))

  it('banner: the band is wide, the rest small', () => {
    const d = freshDashboard()
    api(d).applyPreset('banner', board)
    const [band, ...rest] = api(d).layout.placed
    expect(tierOf(band.w, band.h, false)).toBe('wide')
    for (const p of rest) expect(tierOf(p.w, p.h, false)).toBe('small')
  })

  it('spotlight: the 3x2 hero reads as large', () => {
    const d = freshDashboard()
    api(d).applyPreset('spotlight', board)
    const [hero] = api(d).layout.placed
    expect(hero).toEqual({ id: 'a', w: 3, h: 2 })
    expect(tierOf(hero.w, hero.h, false)).toBe('large')
  })

  it('compact, even, columns and panels are one tier each', () => {
    const expected: Record<string, SizeTier> = {
      compact: 'small', even: 'medium', columns: 'large', panels: 'large',
    }
    for (const [preset, tier] of Object.entries(expected)) {
      const d = freshDashboard()
      api(d).applyPreset(preset as 'compact' | 'even' | 'columns' | 'panels', board)
      for (const p of api(d).layout.placed) expect(tierOf(p.w, p.h, false)).toBe(tier)
    }
  })
})

/* ---------- add: the gallery's verb ---------- */

describe('add puts a card on the board at the end, at the size asked for', () => {
  const all = [
    { id: 'a', w: 2, h: 1 },
    { id: 'b', w: 2, h: 1 },
  ]

  it('a card never placed lands last', () => {
    const d = freshDashboard()
    api(d).add('x', 1, 1, all)
    expect(api(d).layout.placed.map((p) => p.id)).toEqual(['a', 'b', 'x'])
    expect(dimsOf(api(d).layout, 'x', 'large')).toEqual({ w: 1, h: 1 })
  })

  it('a card already placed — and off the board for its size — is resized and moved last, keeping its colour', () => {
    const RED = { h: 0, s: 80, l: 50 }
    const d = freshDashboard()
    api(d).recolour('x', RED, 2, 2)
    api(d).move('x', 0, [...all, { id: 'x', w: 2, h: 2 }])
    expect(api(d).layout.placed.map((p) => p.id)).toEqual(['x', 'a', 'b'])
    api(d).add('x', 1, 1, all)
    expect(api(d).layout.placed.map((p) => p.id)).toEqual(['a', 'b', 'x'])
    expect(api(d).layout.placed[2]).toEqual({ id: 'x', w: 1, h: 1, tint: RED })
  })

  it('un-removes, and is one undo step', () => {
    const d = freshDashboard()
    api(d).remove('x')
    api(d).add('x', 2, 1, all)
    expect(api(d).layout.removed).toEqual([])
    api(d).undo()
    expect(api(d).layout.removed).toEqual(['x'])
    expect(api(d).layout.placed).toEqual([])
  })
})

/* ---------- undo: one step per gesture ---------- */

describe('undo is one step per gesture', () => {
  const RED = { h: 0, s: 80, l: 50 }
  const BLUE = { h: 217, s: 91, l: 60 }
  const GREEN = { h: 120, s: 60, l: 40 }
  const all = ['a', 'b', 'c', 'd'].map((id) => ({ id, w: 1, h: 1 }))

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('every discrete act is one step: place, setTier, move, remove, recolour, add', () => {
    const d = freshDashboard()
    api(d).place('x', 1, 1)
    expect(api(d).canUndo).toBe(true)
    api(d).undo()
    expect(api(d).layout.placed).toEqual([])

    api(d).setTier('x', 'large', false)
    api(d).undo()
    expect(api(d).layout.placed).toEqual([])

    api(d).move('c', 0, all)
    expect(api(d).layout.placed.map((p) => p.id)).toEqual(['c', 'a', 'b', 'd'])
    api(d).undo()
    expect(api(d).layout.placed).toEqual([])

    api(d).remove('x')
    api(d).undo()
    expect(api(d).layout.removed).toEqual([])

    api(d).recolour('x', RED, 1, 1)
    api(d).undo()
    expect(api(d).layout.placed).toEqual([])

    api(d).add('x', 2, 1, all)
    api(d).undo()
    expect(api(d).layout.placed).toEqual([])
    expect(api(d).canUndo).toBe(false)
  })

  it('the samples of one colour drag are one step', () => {
    const d = freshDashboard()
    api(d).recolour('x', { h: 10, s: 50, l: 50 }, 1, 1, true)
    api(d).recolour('x', { h: 20, s: 50, l: 50 }, 1, 1, true)
    api(d).recolour('x', { h: 30, s: 50, l: 50 }, 1, 1, true)
    expect(tintOf(api(d).layout, 'x')?.h).toBe(30)
    api(d).undo()
    expect(api(d).layout.placed, 'back to before the drag, not to the previous sample').toEqual([])
  })

  it('the crossings of one reorder drag are one step', () => {
    const d = freshDashboard()
    api(d).move('d', 2, all, true)
    api(d).move('d', 1, all, true)
    api(d).move('d', 0, all, true)
    expect(api(d).layout.placed.map((p) => p.id)).toEqual(['d', 'a', 'b', 'c'])
    api(d).undo()
    expect(api(d).layout.placed).toEqual([])
  })

  it('a pause, another card, or a press in between starts a new gesture', () => {
    const d = freshDashboard()
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    api(d).recolour('x', RED, 1, 1, true)
    now += 900
    api(d).recolour('x', BLUE, 1, 1, true)
    api(d).undo()
    expect(tintOf(api(d).layout, 'x'), 'the pause split the drags').toEqual(RED)

    api(d).recolour('x', BLUE, 1, 1, true)
    api(d).recolour('y', GREEN, 1, 1, true)
    api(d).undo()
    expect(tintOf(api(d).layout, 'y'), 'a different card is a different gesture').toBeNull()
    expect(tintOf(api(d).layout, 'x')).toEqual(BLUE)

    api(d).place('z', 1, 1)
    api(d).recolour('x', RED, 1, 1, true)
    api(d).undo()
    expect(tintOf(api(d).layout, 'x'), 'a press ended the previous gesture').toEqual(BLUE)
    expect(api(d).layout.placed.some((p) => p.id === 'z'), 'and stays done').toBe(true)
  })
})
