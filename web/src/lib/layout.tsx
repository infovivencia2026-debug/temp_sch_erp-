import { useCallback, useSyncExternalStore } from 'react'
import { api } from './api'

/* The layout switch.

   One preference — 'classic' or 'bento' — living on the same
   user_display_preferences row as theme, density, locale and high_contrast,
   and riding the same GET/PUT /api/v1/portal/preferences/display endpoint.
   There is no layout endpoint and there must not be one: one Save writes one
   row, and a second endpoint would let a Save half-succeed.

   Mirrored to localStorage under `erp.layout`, exactly as Shell.tsx mirrors
   `erp.theme` and `erp.density`, and read synchronously on first paint so a
   reload does not flicker classic-then-bento. The device copy is the fast
   answer; the account row is the true one and wins as soon as it arrives.

   No React context, deliberately: a provider would mean editing App.tsx, and
   the whole point of this experiment is that nothing existing changes. A
   module-level store with useSyncExternalStore gives every consumer the same
   value and the same re-render without a wrapper. */

export type Layout = 'classic' | 'bento'

/** The layouts this build implements. Must stay in step with layoutChoices in
    internal/api/student_life.go and the CHECK in
    migrations/00136_bento_layout.sql. */
export const LAYOUTS: readonly Layout[] = ['classic', 'bento'] as const

export const DEFAULT_LAYOUT: Layout = 'bento'

const STORAGE_KEY = 'erp.layout'

export function isLayout(v: unknown): v is Layout {
  return typeof v === 'string' && (LAYOUTS as readonly string[]).includes(v)
}

function readStored(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (isLayout(raw)) return raw
  } catch {
    /* private browsing: the account's stored choice still applies once the
       preferences call answers */
  }
  return DEFAULT_LAYOUT
}

// --- the store ----------------------------------------------------------

let current: Layout = readStored()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function snapshot(): Layout {
  return current
}

/** Server-rendering and test environments have no window; the classic layout
    is the honest answer there, and it is also the safe one. */
function serverSnapshot(): Layout {
  return DEFAULT_LAYOUT
}

/** Set the device's copy and re-render. Exported for the reconciliation
    below and for anything that learns the account's layout from a payload it
    already had — writing what the server just told us must not PUT it back. */
export function applyLayout(next: Layout) {
  document.documentElement.setAttribute('data-layout', next)
  if (current === next) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* the account row still carries it to the next sign-in */
  }
  emit()
}

/** The value without subscribing. For non-React callers only. */
export function currentLayout(): Layout {
  return current
}

// --- the hook -----------------------------------------------------------

export interface LayoutValue {
  layout: Layout
  /** Write both halves: this device immediately, the account behind it. The
      local write is not awaited on the server round trip, so the switch is
      instant and a failed save leaves the device on the chosen layout rather
      than snapping back under the user's cursor. */
  setLayout: (next: Layout) => void
}

export function useLayout(): LayoutValue {
  const layout = useSyncExternalStore(subscribe, snapshot, serverSnapshot)

  const setLayout = useCallback((next: Layout) => {
    if (!isLayout(next)) return
    applyLayout(next)
    /* Read-modify-write against the one row. The GET is what stops a layout
       save from blanking the theme: the endpoint takes the whole preference
       object, so sending only a layout would store defaults over everything
       else on it. */
    void (async () => {
      try {
        const cur = await api.get<{ preference: Record<string, unknown> }>(
          '/api/v1/portal/preferences/display',
        )
        await api.put('/api/v1/portal/preferences/display', {
          ...cur.preference,
          layout: next,
        })
      } catch {
        /* Offline, or a signed-out tab. The device keeps the choice; the
           account picks it up the next time the switch is used. Nothing is
           shown to the user, because nothing they can act on has failed. */
      }
    })()
  }, [])

  return { layout, setLayout }
}

/** Reconcile the device copy against the account row. Call it once with what
    GET /preferences/display returned; it never writes back to the server. */
export function reconcileLayout(value: unknown) {
  if (isLayout(value)) applyLayout(value)
}

// stamp on load: currentLayout() reads localStorage synchronously, so the
// attribute is on the element before React's first paint and a reload into
// Bento never flashes the classic palette.
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-layout', currentLayout())
}
