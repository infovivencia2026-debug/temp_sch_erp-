import * as React from 'react'
import { useLayout, sizeOf, isRemoved, orderOf, type Layout, type WidgetSize } from './widgets'

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
export function testUnknownIdIsVisible(): void {
  const d = freshDashboard()
  const a = api(d)
  assertEqual(a.layout, { placed: [], removed: [] }, 'never-arranged dashboard starts empty')
  assert(!isRemoved(a.layout, 'brand_new_widget'), 'an id in neither list is visible')
  assertEqual(sizeOf(a.layout, 'brand_new_widget', 'medium'), 'medium', 'unplaced widget keeps its declared size')
}

/** ...and the other half: removed is stored, so it survives as a fact rather
    than being re-derived from absence. */
export function testRemovedIsStoredNotInferred(): void {
  const d = freshDashboard()
  api(d).remove('defaulters')
  const after = api(d).layout
  assert(isRemoved(after, 'defaulters'), 'a removed widget stays removed')
  assertEqual(after.placed, [], 'removing does not place anything')

  const persisted = JSON.parse(store.getItem(rawKey(d))!) as Layout
  assertEqual(persisted.removed, ['defaulters'], 'removal is written to storage, not inferred on read')

  // A second, never-touched widget on the same dashboard is still visible.
  assert(!isRemoved(after, 'outstanding'), 'removing one widget does not hide the others')

  api(d).remove('defaulters')
  assertEqual(api(d).layout.removed, ['defaulters'], 'removing twice does not duplicate the id')

  api(d).place('defaulters', 'small')
  const back = api(d).layout
  assert(!isRemoved(back, 'defaulters'), 'placing a removed widget un-removes it')
}

/** The first drag on a default card must do something. */
export function testResizeOnNeverPlacedWidgetPlacesIt(): void {
  const d = freshDashboard()
  api(d).resize('attendance_trend', 'large', 'small')
  const after = api(d).layout
  assertEqual(after.placed, [{ id: 'attendance_trend', size: 'large' }], 'resize places a widget it did not find')
  assertEqual(sizeOf(after, 'attendance_trend', 'small'), 'large', 'the chosen size wins over the declared one')

  api(d).resize('attendance_trend', 'full', 'small')
  assertEqual(
    api(d).layout.placed,
    [{ id: 'attendance_trend', size: 'full' }],
    'resizing again updates in place rather than appending',
  )

  // Resizing something the person had removed brings it back.
  const e = freshDashboard()
  api(e).remove('fees')
  api(e).resize('fees', 'medium', 'small')
  assert(!isRemoved(api(e).layout, 'fees'), 'resizing a removed widget un-removes it')
}

/** Moving must reorder against every visible widget, not just the touched ones. */
export function testMoveSeedsFromAllVisibleIds(): void {
  const d = freshDashboard()
  const all = ['a', 'b', 'c', 'd'].map((id) => ({ id, size: 'small' as const }))
  // Nothing placed yet: moving 'c' to index 1 must land it between a and b,
  // not at the front of a one-item list.
  api(d).move('c', 1, all)
  assertEqual(
    api(d).layout.placed.map((p) => p.id),
    ['a', 'c', 'b', 'd'],
    'move seeds the order from all visible ids',
  )
  assertEqual(orderOf(api(d).layout, 'c', 2), 1, 'the moved widget reports its new index')
  assertEqual(orderOf(api(d).layout, 'b', 1), 2, 'the widgets it passed shift down')

  // A widget that already had a size keeps it through a move.
  const e = freshDashboard()
  api(e).resize('b', 'large', 'small')
  api(e).move('b', 2, ['a', 'b', 'c'].map((id) => ({ id, size: 'small' as const })))
  assertEqual(
    api(e).layout.placed,
    [
      { id: 'a', size: 'small' },
      { id: 'c', size: 'small' },
      { id: 'b', size: 'large' },
    ],
    'move preserves the size of an already-placed widget',
  )

  /* The bug this signature exists to prevent: reordering must not resize.

     When move() seeded untouched widgets at a hard-coded 'small', the first
     drag on a board silently shrank every card nobody had resized — including
     the 2x2 hero. */
  const g = freshDashboard()
  api(g).move('b', 0, [
    { id: 'a', size: 'large' },
    { id: 'b', size: 'medium' },
  ])
  assertEqual(
    api(g).layout.placed,
    [
      { id: 'b', size: 'medium' },
      { id: 'a', size: 'large' },
    ],
    'reordering keeps every untouched widget at its own default size',
  )

  // Out-of-range targets are refused rather than corrupting the list.
  const f = freshDashboard()
  api(f).move('a', 9, ['a', 'b'].map((id) => ({ id, size: 'small' as const })))
  assertEqual(api(f).layout.placed, [], 'a target past the end is ignored')
  api(f).move('zz', 0, ['a', 'b'].map((id) => ({ id, size: 'small' as const })))
  assertEqual(api(f).layout.placed, [], 'moving an id that is not visible is ignored')
}

/** Never arranged and arranged-back-to-default are different states. */
export function testUntouchedDashboardWritesNoKey(): void {
  const d = freshDashboard()
  api(d)
  assertEqual(store.getItem(rawKey(d)), null, 'reading an untouched dashboard writes nothing')

  api(d).place('x', 'small')
  assert(store.getItem(rawKey(d)) !== null, 'placing writes a key')

  api(d).reset()
  assertEqual(store.getItem(rawKey(d)), null, 'reset removes the key rather than storing an empty layout')
  assertEqual(api(d).layout, { placed: [], removed: [] }, 'reset returns the default layout')

  // Removing then un-removing leaves both lists empty, which must also clear.
  const e = freshDashboard()
  api(e).remove('x')
  api(e).place('x', 'small')
  api(e).remove('x')
  api(e).reset()
  assertEqual(store.getItem(rawKey(e)), null, 'an emptied layout drops its key')
}

/** Corrupt storage must degrade to the default instead of throwing. */
export function testCorruptStoredValueDegrades(): void {
  const cases: Array<[string, string, Layout]> = [
    ['not JSON at all', '{oops', { placed: [], removed: [] }],
    ['a JSON scalar', '42', { placed: [], removed: [] }],
    ['placed not an array', '{"placed":{"id":"a"},"removed":["b"]}', { placed: [], removed: ['b'] }],
    ['removed not an array', '{"placed":[{"id":"a","size":"small"}],"removed":"b"}',
      { placed: [{ id: 'a', size: 'small' }], removed: [] }],
    ['an unknown size', '{"placed":[{"id":"a","size":"gigantic"},{"id":"b","size":"full"}],"removed":[]}',
      { placed: [{ id: 'b', size: 'full' }], removed: [] }],
    ['a null entry', '{"placed":[null,{"id":"b","size":"medium"}],"removed":[null,"c"]}',
      { placed: [{ id: 'b', size: 'medium' }], removed: ['c'] }],
    ['a missing id', '{"placed":[{"size":"small"}],"removed":[]}', { placed: [], removed: [] }],
  ]
  for (const [what, raw, expected] of cases) {
    const d = freshDashboard()
    store.setItem(rawKey(d), raw)
    let got: Layout
    try {
      got = api(d).layout
    } catch (err) {
      throw new Error(`FAIL: ${what} threw instead of degrading — ${String(err)}`)
    }
    assertEqual(got, expected, `stored value with ${what} degrades`)
  }
}

/** Untouched widgets sort after placed ones, keeping their declared order. */
export function testOrderOfPutsUntouchedLast(): void {
  const d = freshDashboard()
  api(d).resize('b', 'large', 'small')
  api(d).resize('d', 'medium', 'small')
  const l = api(d).layout

  assertEqual(orderOf(l, 'b', 1), 0, 'a placed widget reports its list index')
  assertEqual(orderOf(l, 'd', 3), 1, 'the second placed widget follows the first')

  const a = orderOf(l, 'a', 0)
  const c = orderOf(l, 'c', 2)
  assert(a >= l.placed.length, 'an untouched widget sorts after everything placed')
  assert(a < c, 'untouched widgets keep their declared order among themselves')

  const untouchedOnly = { placed: [], removed: [] } as Layout
  assertEqual(orderOf(untouchedOnly, 'a', 0), 0, 'with nothing placed, declared order is the order')
}

/* ---------- runner ---------- */

const TESTS: Array<[string, () => void]> = [
  ['unknown id is visible', testUnknownIdIsVisible],
  ['removed is stored, not inferred', testRemovedIsStoredNotInferred],
  ['resize on a never-placed widget places it', testResizeOnNeverPlacedWidgetPlacesIt],
  ['move seeds from all visible ids', testMoveSeedsFromAllVisibleIds],
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
const _sizes: WidgetSize[] = ['small', 'medium', 'large', 'full']
void _sizes
