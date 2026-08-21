import { useCallback, useSyncExternalStore } from 'react'
import { api } from './api'

/* The theme choice, in one place.

   It was in three, which is how this file came to exist. Shell's header
   toggle wrote localStorage and nothing else; the appearance screen wrote
   localStorage *and* the account row; and Bento, having hidden the header,
   could not reach either. Adding a fourth writer for the dock would have made
   the disagreement worse, so the store came first.

   The bug that mattered was quieter than an unreachable button. The account
   row holds three values — system, light and dark — but localStorage only
   ever held the *resolved* one, because index.html has to decide light or
   dark before first paint and cannot ask matchMedia through a JSON blob it
   half-understands. So a person who chose "system" and reloaded came back as
   whatever system happened to be at the moment they saved, permanently, and
   their laptop going dark at sunset no longer moved the product. The choice
   and its resolution are now two different stored things, which is what lets
   both be true.

   Modelled on lib/layout.tsx deliberately: same module store, same
   useSyncExternalStore, same read-modify-write against the one preferences
   row, same "device answers immediately, account wins when it arrives". Two
   preferences that behave differently are two things to learn. */

export type Theme = 'system' | 'light' | 'dark'

/** Must stay in step with themeChoices in internal/api/student_life.go and
    the CHECK on user_display_preferences.theme. */
export const THEMES: readonly Theme[] = ['system', 'light', 'dark'] as const

export const DEFAULT_THEME: Theme = 'system'

/** What the person chose. */
const CHOICE_KEY = 'erp.theme.choice'
/** What that resolves to right now. Read by the boot script in index.html
    before React exists, which is why it stays 'dark' | 'light' and never
    'system' — a flash of the wrong palette is the thing it prevents. */
const RESOLVED_KEY = 'erp.theme'

export function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v)
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(t: Theme): 'light' | 'dark' {
  if (t === 'system') return prefersDark() ? 'dark' : 'light'
  return t
}

function readStored(): Theme {
  try {
    const choice = localStorage.getItem(CHOICE_KEY)
    if (isTheme(choice)) return choice
    /* Upgrading from before this file: only the resolved value was kept, so
       an explicit light or dark is honoured and anything else falls to the
       default rather than pretending we know what was meant. */
    const legacy = localStorage.getItem(RESOLVED_KEY)
    if (legacy) {
      const v = JSON.parse(legacy)
      if (v === 'dark' || v === 'light') return v
    }
  } catch {
    /* private browsing, or a corrupt entry; the account row still carries the
       real answer once the preferences call answers */
  }
  return DEFAULT_THEME
}

// --- the store ----------------------------------------------------------

let current: Theme = readStored()
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

function snapshot(): Theme {
  return current
}

/** No window means no palette to get wrong. */
function serverSnapshot(): Theme {
  return DEFAULT_THEME
}

/** Set the device's copy and re-render. Exported for the reconciliation below
    and for anything that learns the theme from a payload it already had —
    writing back what the server just told us would PUT it straight again. */
export function applyTheme(next: Theme) {
  const resolved = resolveTheme(next)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  try {
    localStorage.setItem(CHOICE_KEY, next)
    localStorage.setItem(RESOLVED_KEY, JSON.stringify(resolved))
  } catch {
    /* the account row still carries it to the next sign-in */
  }
  if (current === next) return
  current = next
  emit()
}

/** The value without subscribing. For non-React callers only. */
export function currentTheme(): Theme {
  return current
}

// --- the hook -----------------------------------------------------------

export interface ThemeValue {
  theme: Theme
  /** What is actually on screen — 'system' is not a palette, and a control
      that wants to show a sun or a moon needs to know which one won. */
  resolved: 'light' | 'dark'
  setTheme: (next: Theme) => void
}

export function useTheme(): ThemeValue {
  const theme = useSyncExternalStore(subscribe, snapshot, serverSnapshot)

  const setTheme = useCallback((next: Theme) => {
    if (!isTheme(next)) return
    applyTheme(next)
    /* Read-modify-write against the one row, exactly as setLayout does. The
       GET is what stops a theme save from blanking the density: the endpoint
       takes the whole preference object, so sending only a theme would store
       defaults over everything else on it. */
    void (async () => {
      try {
        const cur = await api.get<{ preference: Record<string, unknown> }>(
          '/api/v1/portal/preferences/display',
        )
        await api.put('/api/v1/portal/preferences/display', {
          ...cur.preference,
          theme: next,
        })
      } catch {
        /* Offline, or a signed-out tab. The device keeps the choice and
           nothing is shown, because nothing the user can act on has failed. */
      }
    })()
  }, [])

  return { theme, resolved: resolveTheme(theme), setTheme }
}

/** Reconcile the device copy against the account row. Call it once with what
    GET /preferences/display returned; it never writes back to the server. */
export function reconcileTheme(value: unknown) {
  if (isTheme(value)) applyTheme(value)
}

// --- following the system -----------------------------------------------

/* On 'system', the OS switching at sunset has to move the product with it.
   Registered once at module load rather than in a component, so it keeps
   working across every route and cannot be unmounted by accident. */
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const follow = () => {
    if (current !== 'system') return
    applyTheme('system')
    emit()
  }
  if (mq.addEventListener) mq.addEventListener('change', follow)
  else mq.addListener?.(follow)
}

// Stamp on load. index.html has already set the class from the resolved copy;
// this re-runs it from the choice, which is what makes 'system' correct on a
// machine whose palette changed while the tab was closed.
if (typeof document !== 'undefined') {
  applyTheme(current)
}
