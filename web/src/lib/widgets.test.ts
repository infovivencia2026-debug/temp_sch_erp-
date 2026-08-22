import * as React from 'react'
import { useLayout, dimsOf, isRemoved, orderOf, DIMS, type WidgetSize } from './widgets'

/* Tests for the layout store, written as plain functions because the web side
   has no test runner (see NOTES at the bottom of this file). Run them with
   `runAll()`; each throws on the first failed assertion. */

/* ---------- harness ---------- */

let dashCounter = 0
/* The module caches a layout per dashboard id for the life of the process and
   exposes no way to clear it, so every test takes a fresh id rather than
   inheriting the previous test's cached object. */
function freshDashboard(): string {
  dashCounter += 1
  return `test-dash-${dashCounter}`
}

class MemoryStorage {
  map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v)
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
  clear(): void {
    this.map.clear()
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null
  }
  get length(): number {
    return this.map.size
  }
}

const store = new MemoryStorage()

function installEnvironment(): void {
  const g = globalThis as unknown as Record<string, unknown>
  if (!g.localStorage) g.localStorage = store
  if (!g.window) g.window = g
}

/* useLayout is a hook, and the store's whole surface (place/remove/resize/move/
   reset) is only reachable through it. Rendering React just to reach five
   closures would mean adding a renderer dependency, which this task forbids, so
   we install a dispatcher that implements the two hooks useLayout actually
   uses. useCallback returning the raw function and useSyncExternalStore
   returning getSnapshot() is exactly what a mount does. */
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

type Api = ReturnType<typeof useLayout>

/** Reads the store as a mount would: fresh snapshot, fresh callbacks. */
function api(dashboard: string): Api {
  return callHook(() => useLayout(dashboard))
}

function rawKey(dashboard: string): string {
  return `erp.widgets.${dashboard}`
}

/* ---------- assertions ---------- */

let checks = 0

export function assert(cond: boolean, what: string): void {
  checks += 1
  if (!cond) throw new Error(`FAIL: ${what}`)
}

export function assertEqual<T>(actual: T, expected: T, what: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${what} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )
}

/* ---------- tests ---------- */

/** The property the whole design rests on: absent from placed AND absent from
    removed means visible, so a widget the product ships later shows up for
    somebody who has never arranged anything. */
/* ---------- tests ---------- */

/** A widget nobody has touched is VISIBLE. This is the property the whole
    design rests on: removal is stored, never inferred from absence, so a
    widget the product adds later shows up for existing users. */
export function testUnknownIdIsVisible(): void {
  const d = freshDashboard()
  const l = api(d).layout
  assert(!isRemoved(l, 'brand-new'), 'a widget absent from placed is not removed')
  assertEqual(dimsOf(l, 'brand-new', 'large'), { w: 2, h: 2 }, 'it renders at its declared default')
}

export function testRemovedIsStoredNotInferred(): void {
  const d = freshDashboard()
  api(d).remove('fees')
  assert(isRemoved(api(d).layout, 'fees'), 'an explicitly removed widget stays removed')
  assert(!isRemoved(api(d).layout, 'other'), 'removing one widget does not hide the rest')

  api(d).place('fees', 2, 1)
  assert(!isRemoved(api(d).layout, 'fees'), 'putting it back clears the removal')
  assertEqual(dimsOf(api(d).layout, 'fees', 'small'), { w: 2, h: 1 }, 'it comes back at the size asked for')
}

/** Resizing something that was never explicitly placed must place it, or the
    first choice on a default card would do nothing at all. */
export function testResizeOnNeverPlacedWidgetPlacesIt(): void {
  const d = freshDashboard()
  api(d).resize('fees', 3, 2)
  assertEqual(api(d).layout.placed, [{ id: 'fees', w: 3, h: 2 }], 'resizing places it')
  assertEqual(dimsOf(api(d).layout, 'fees', 'small'), { w: 3, h: 2 }, 'and the choice is what renders')

  api(d).resize('fees', 1, 1)
  assertEqual(api(d).layout.placed, [{ id: 'fees', w: 1, h: 1 }], 'resizing again replaces, never duplicates')

  const e = freshDashboard()
  api(e).remove('fees')
  api(e).resize('fees', 2, 2)
  assert(!isRemoved(api(e).layout, 'fees'), 'resizing a removed widget un-removes it')
}

/** The two axes are independent: setting a width must not disturb the height. */
export function testAxesAreIndependent(): void {
  const d = freshDashboard()
  api(d).resize('a', 1, 4)
  api(d).resize('a', 5, 4)
  assertEqual(dimsOf(api(d).layout, 'a', 'small'), { w: 5, h: 4 }, 'width changes, height survives')
  api(d).resize('a', 5, 1)
  assertEqual(dimsOf(api(d).layout, 'a', 'small'), { w: 5, h: 1 }, 'height changes, width survives')
}

/** Moving must reorder against every visible widget, not just the touched ones. */
export function testMoveSeedsFromAllVisibleIds(): void {
  const d = freshDashboard()
  const all = ['a', 'b', 'c', 'd'].map((id) => ({ id, w: 1, h: 1 }))
  api(d).move('c', 1, all)
  assertEqual(
    api(d).layout.placed.map((p) => p.id),
    ['a', 'c', 'b', 'd'],
    'move seeds the order from every visible widget',
  )
  assertEqual(orderOf(api(d).layout, 'c', 2), 1, 'the moved widget reports its new index')
  assertEqual(orderOf(api(d).layout, 'b', 1), 2, 'the widgets it passed shift down')

  /* The bug this signature exists to prevent: reordering must not resize.

     When move() seeded untouched widgets at a hard-coded smallest size, the
     first drag on a board silently shrank every card nobody had resized —
     the 2x2 hero included. */
  const g = freshDashboard()
  api(g).move('b', 0, [{ id: 'a', w: 2, h: 2 }, { id: 'b', w: 3, h: 1 }])
  assertEqual(
    api(g).layout.placed,
    [{ id: 'b', w: 3, h: 1 }, { id: 'a', w: 2, h: 2 }],
    'reordering keeps every untouched widget at its own size',
  )

  const f = freshDashboard()
  api(f).move('a', 9, [{ id: 'a', w: 1, h: 1 }, { id: 'b', w: 1, h: 1 }])
  assertEqual(api(f).layout.placed, [], 'a target past the end is ignored')
  api(f).move('zz', 0, [{ id: 'a', w: 1, h: 1 }])
  assertEqual(api(f).layout.placed, [], 'moving an id that is not visible is ignored')
}

/** An untouched dashboard must not write a key, so "never arranged" and
    "arranged back to the default" stay different states. */
export function testUntouchedDashboardWritesNoKey(): void {
  const d = freshDashboard()
  void api(d).layout
  assertEqual(store.getItem(rawKey(d)), null, 'reading a dashboard stores nothing')

  api(d).resize('a', 2, 2)
  assert(store.getItem(rawKey(d)) !== null, 'arranging stores a key')

  api(d).reset()
  assertEqual(store.getItem(rawKey(d)), null, 'reset removes the key rather than storing an empty one')
  assertEqual(api(d).layout.placed, [], 'and the layout is back to the default')
}

/** A layout saved before sizes became two axes must survive the change. */
export function testLegacyNamedSizesMigrate(): void {
  const d = freshDashboard()
  store.setItem(rawKey(d), JSON.stringify({
    placed: [{ id: 'hero', size: 'large' }, { id: 'strip', size: 'full' }],
    removed: ['gone'],
  }))
  const l = api(d).layout
  assertEqual(l.placed, [
    { id: 'hero', w: DIMS.large.w, h: DIMS.large.h },
    { id: 'strip', w: DIMS.full.w, h: DIMS.full.h },
  ], 'named sizes are translated, not discarded')
  assert(isRemoved(l, 'gone'), 'and removals survive the migration')
}

/** Anything unreadable degrades to the default rather than throwing. */
export function testCorruptStoredValueDegrades(): void {
  const a = freshDashboard()
  store.setItem(rawKey(a), '{not json')
  assertEqual(api(a).layout.placed, [], 'bad JSON reads as an empty layout')

  const b = freshDashboard()
  store.setItem(rawKey(b), JSON.stringify({ placed: 'nope', removed: 7 }))
  assertEqual(api(b).layout, { placed: [], removed: [] }, 'wrong types read as empty')

  const c = freshDashboard()
  store.setItem(rawKey(c), JSON.stringify({
    placed: [
      { id: 'ok', w: 2, h: 1 },
      { id: 'huge', w: 99, h: 1 },
      { id: 'zero', w: 0, h: 1 },
      { id: 'fractional', w: 1.5, h: 1 },
      { id: 'nameless', w: 1, h: 1, size: undefined },
      { w: 1, h: 1 },
      null,
    ],
    removed: ['fine', 3, null],
  }))
  const l = api(c).layout
  assertEqual(
    l.placed.map((p) => p.id),
    ['ok', 'nameless'],
    'out-of-range, fractional and id-less rows are dropped; valid ones survive',
  )
  assertEqual(l.removed, ['fine'], 'non-string removals are dropped')
}

export function testOrderOfPutsUntouchedLast(): void {
  const d = freshDashboard()
  api(d).resize('moved', 1, 1)
  const l = api(d).layout
  assertEqual(orderOf(l, 'moved', 5), 0, 'a placed widget takes its position in the list')
  assertEqual(orderOf(l, 'untouched', 0), 1, 'an untouched widget sorts after everything placed')
  assertEqual(orderOf(l, 'later', 3), 4, 'and untouched widgets keep their declared order among themselves')
}

const TESTS: Array<[string, () => void]> = [
  ['unknown id is visible', testUnknownIdIsVisible],
  ['removed is stored, not inferred', testRemovedIsStoredNotInferred],
  ['resize on a never-placed widget places it', testResizeOnNeverPlacedWidgetPlacesIt],
  ['move seeds from all visible ids', testMoveSeedsFromAllVisibleIds],
  ['the two axes are independent', testAxesAreIndependent],
  ['layouts saved under named sizes migrate', testLegacyNamedSizesMigrate],
  ['untouched dashboard writes no key', testUntouchedDashboardWritesNoKey],
  ['corrupt stored value degrades', testCorruptStoredValueDegrades],
  ['orderOf puts untouched last', testOrderOfPutsUntouchedLast],
]

export interface RunResult {
  passed: number
  failed: number
  assertions: number
  failures: Array<{ name: string; message: string }>
}

export function runAll(): RunResult {
  installEnvironment()
  checks = 0
  const failures: Array<{ name: string; message: string }> = []
  let passed = 0
  for (const [name, fn] of TESTS) {
    try {
      fn()
      passed += 1
    } catch (err) {
      failures.push({ name, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { passed, failed: failures.length, assertions: checks, failures }
}

export default runAll

// Type-level guard: SIZES and WidgetSize must not drift apart.
const _sizes: WidgetSize[] = ['small', 'tall', 'medium', 'large', 'full']
void _sizes
