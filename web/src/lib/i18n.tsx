import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import en, { type Messages } from '@/locales/en'

/* The interface-language runtime: a catalogue lookup, a context and a hook.

   No dependency was added. i18next and react-intl both solve problems this
   product does not have yet — runtime catalogue loading over the network,
   ICU MessageFormat with gender and ordinals, a plural engine for languages
   with six forms — and both cost more bundle than the whole feature. What is
   actually needed is: look a key up, fall back rather than blank, substitute a
   named value, and re-render when the language changes. That is this file, and
   it is small enough to read in one sitting, which matters more than
   generality for a framework three other features are about to build on.

   THE FALLBACK CHAIN, in order, and it never ends in an empty string:

       requested locale → en → the key itself

   The last step is the important one. A missing string that renders as blank
   produces a button with no label and a page nobody can report a bug about; a
   missing string that renders as `portal.documents.title` is obviously wrong,
   greppable, and still leaves the control usable. So `t` returns the key on a
   total miss and warns once per key.

   DIRECTION. Every locale carries a `dir`, and the provider stamps `lang` and
   `dir` on <html> on every change. Today every locale is 'ltr', so the
   attribute is a no-op — deliberately. When an RTL locale arrives, the
   plumbing that decides direction already exists and the work is stylesheet
   work, not a rewrite of the runtime. No RTL styling is attempted here.

   PERSISTENCE mirrors exactly what components/Shell.tsx already does for the
   theme: localStorage for a correct first paint before any request resolves,
   and the account row (user_display_preferences, via
   /api/v1/portal/preferences/display) as the truth across devices. The two
   are written together by the appearance screen, so they cannot disagree —
   the same reason the theme is done that way. */

// --- locales ------------------------------------------------------------

/** What the product knows about a language it can render. `dir` exists so
    that adding an RTL locale is a data change plus stylesheet work, not a
    change to this runtime. */
export interface LocaleInfo {
  tag: string
  /** The language's name in that language — a person looking for their own
      language is not helped by seeing it named in a language they do not
      read. */
  endonym: string
  dir: 'ltr' | 'rtl'
}

export const LOCALES: Record<string, LocaleInfo> = {
  en: { tag: 'en', endonym: 'English', dir: 'ltr' },
}

/* Registered catalogues.

   A locale is only listed here once its file exists; the server's
   localeChoices (internal/api/i18n.go) must carry the same list, or a stored
   preference resolves to nothing. Values are Partial so a translation in
   progress falls back key by key instead of shipping blanks.

   Statically imported rather than lazily fetched: the catalogue is a few
   kilobytes, and a language that arrives one frame after the page has
   rendered means every screen visibly flips language on load. */
export const CATALOGUES: Record<string, Partial<Messages>> = {
  en,
}

export const DEFAULT_LOCALE = 'en'
export const LOCALE_STORAGE_KEY = 'erp.locale'
export const CONTRAST_STORAGE_KEY = 'erp.contrast'

export type MessageKey = keyof Messages
/** Values substituted into a `{placeholder}`. Numbers are formatted by the
    locale, not by String(), so a language with its own digits or grouping is
    handled without every caller remembering to. */
export type Vars = Record<string, string | number>

/** Whether this build can actually render a locale. The server validates the
    same thing; this guard is for a stale localStorage value written by an
    older build, which the server never sees. */
export function isKnownLocale(tag: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOGUES, tag)
}

// --- lookup -------------------------------------------------------------

const warned = new Set<string>()

/** Substitute `{name}` placeholders. Unknown placeholders are left standing
    rather than blanked, for the same reason a missing key renders as the key:
    visible wrong beats invisible wrong. */
function fill(template: string, vars: Vars | undefined, locale: string): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name]
    if (v === undefined) return whole
    return typeof v === 'number' ? new Intl.NumberFormat(locale).format(v) : v
  })
}

/**
 * Resolve one key against one locale, applying the full fallback chain.
 * Exported for the rare non-React caller; components use `useT()`.
 */
export function translate(locale: string, key: MessageKey, vars?: Vars): string {
  const primary = CATALOGUES[locale]?.[key]
  if (primary !== undefined) return fill(primary, vars, locale)

  const fallback = CATALOGUES[DEFAULT_LOCALE]?.[key]
  if (fallback !== undefined) return fill(fallback, vars, DEFAULT_LOCALE)

  // Total miss: the key is not in the requested catalogue and not in English
  // either, which means it was mistyped or removed. Render it so it is
  // obvious and greppable, and warn once per key. Warned in every build, not
  // only development: this project's tsconfig does not pull in Vite's client
  // types, and a missing string is worth hearing about either way.
  if (!warned.has(key)) {
    warned.add(key)
    console.warn(`[i18n] no string for key "${key}" in "${locale}" or "${DEFAULT_LOCALE}"`)
  }
  return key
}

// --- applying to the document ------------------------------------------

/** Stamp the language and direction on <html>.

    `lang` is not decoration: it is what a screen reader uses to choose a
    voice, and what the browser uses to hyphenate. `dir` is 'ltr' for every
    locale that ships today and is set anyway, so the day an RTL catalogue
    lands nothing here has to change. */
export function applyLocale(tag: string) {
  const root = document.documentElement
  const info = LOCALES[tag] ?? LOCALES[DEFAULT_LOCALE]
  root.lang = info.tag
  root.dir = info.dir
}

/** Apply the high-contrast override the same way the shell applies density:
    an attribute on the document root that index.css keys token overrides off.
    Absent, not "normal", when it is off — so a user who never touches it has
    a root element identical to today's. */
export function applyContrast(on: boolean) {
  const root = document.documentElement
  if (on) root.setAttribute('data-contrast', 'high')
  else root.removeAttribute('data-contrast')
}

function readStoredLocale(): string {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (raw && isKnownLocale(raw)) return raw
  } catch {
    /* private browsing: fall through to the default */
  }
  return DEFAULT_LOCALE
}

function readStoredContrast(): boolean {
  try {
    return localStorage.getItem(CONTRAST_STORAGE_KEY) === 'high'
  } catch {
    return false
  }
}

/** Write the choice to this device and apply it. The account row is written
    by whichever screen made the choice, through the existing display
    preferences endpoint — this function is the local half only. */
export function storeLocale(tag: string) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, tag)
  } catch {
    /* the stored account preference still applies on the next sign-in */
  }
  applyLocale(tag)
}

export function storeContrast(on: boolean) {
  try {
    if (on) localStorage.setItem(CONTRAST_STORAGE_KEY, 'high')
    else localStorage.removeItem(CONTRAST_STORAGE_KEY)
  } catch {
    /* as above */
  }
  applyContrast(on)
}

// --- context ------------------------------------------------------------

interface I18nValue {
  locale: string
  dir: 'ltr' | 'rtl'
  t: (key: MessageKey, vars?: Vars) => string
  /** Switch the interface language on this device and re-render. Saving it to
      the account is the caller's job, through the display preferences
      endpoint, so that one Save writes one row. */
  setLocale: (tag: string) => void
}

const I18nContext = createContext<I18nValue | null>(null)

/** Wraps the application. Reads the device's stored choice for a correct
    first paint; the account's stored choice arrives with the session and is
    reconciled by whatever loads it, exactly as the theme is. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(readStoredLocale)

  // Once on mount, and on every change. Also applies the stored contrast
  // flag, which has no React state of its own because nothing renders
  // differently in the tree — it is purely a token override.
  useEffect(() => {
    applyLocale(locale)
  }, [locale])
  useEffect(() => {
    applyContrast(readStoredContrast())
  }, [])

  const setLocale = useCallback((tag: string) => {
    const next = isKnownLocale(tag) ? tag : DEFAULT_LOCALE
    storeLocale(next)
    setLocaleState(next)
  }, [])

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      dir: (LOCALES[locale] ?? LOCALES[DEFAULT_LOCALE]).dir,
      t: (key, vars) => translate(locale, key, vars),
      setLocale,
    }),
    [locale, setLocale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** The whole context: locale, direction and the setter. */
export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  // Rendering outside the provider is a wiring mistake, not a user-facing
  // failure, so it degrades to English rather than throwing and blanking the
  // screen. Tests that render one component in isolation rely on this.
  if (!ctx) {
    return {
      locale: DEFAULT_LOCALE,
      dir: 'ltr',
      t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
      setLocale: () => {},
    }
  }
  return ctx
}

/** The hook components use: `const t = useT()`, then `t('portal.x.title')`. */
export function useT() {
  return useI18n().t
}
